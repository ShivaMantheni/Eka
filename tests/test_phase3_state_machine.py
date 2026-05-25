"""
Phase 3 Unit Tests: Session State Preservation & Formal State Machine

Tests for:
- ConnectionState class with formal state definitions
- State transition validation
- State-aware get_connection() behavior
- State history tracking
- Transition logging and metrics

Run with:
    cd /home/hp_test/Eka/framework/dut-automation
    python tests/test_phase3_state_machine.py
"""

import sys
import os
import time
import unittest
from unittest.mock import Mock, MagicMock, patch

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ssh_pool import SSHConnectionPool, ConnectionState


class TestConnectionState(unittest.TestCase):
    """Test ConnectionState class and transition validation."""

    def test_state_constants(self):
        """Verify all state constants are defined."""
        self.assertEqual(ConnectionState.ONLINE, "online")
        self.assertEqual(ConnectionState.OFFLINE, "offline")
        self.assertEqual(ConnectionState.DISCONNECTED, "disconnected")
        self.assertEqual(ConnectionState.RECONNECTING, "reconnecting")
        self.assertEqual(ConnectionState.FAILED, "failed")

    def test_valid_transitions(self):
        """Test valid state transitions."""
        # ONLINE → OFFLINE
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.ONLINE, ConnectionState.OFFLINE
            )
        )

        # ONLINE → DISCONNECTED
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.ONLINE, ConnectionState.DISCONNECTED
            )
        )

        # OFFLINE → RECONNECTING
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.OFFLINE, ConnectionState.RECONNECTING
            )
        )

        # OFFLINE → ONLINE (quick recovery)
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.OFFLINE, ConnectionState.ONLINE
            )
        )

        # RECONNECTING → ONLINE
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.RECONNECTING, ConnectionState.ONLINE
            )
        )

        # RECONNECTING → FAILED
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.RECONNECTING, ConnectionState.FAILED
            )
        )

        # RECONNECTING → OFFLINE
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.RECONNECTING, ConnectionState.OFFLINE
            )
        )

        # FAILED → RECONNECTING
        self.assertTrue(
            ConnectionState.is_valid_transition(
                ConnectionState.FAILED, ConnectionState.RECONNECTING
            )
        )

    def test_invalid_transitions(self):
        """Test invalid state transitions."""
        # ONLINE → RECONNECTING (must go through OFFLINE)
        self.assertFalse(
            ConnectionState.is_valid_transition(
                ConnectionState.ONLINE, ConnectionState.RECONNECTING
            )
        )

        # ONLINE → FAILED
        self.assertFalse(
            ConnectionState.is_valid_transition(
                ConnectionState.ONLINE, ConnectionState.FAILED
            )
        )

        # DISCONNECTED → anything (terminal state)
        self.assertFalse(
            ConnectionState.is_valid_transition(
                ConnectionState.DISCONNECTED, ConnectionState.ONLINE
            )
        )

        self.assertFalse(
            ConnectionState.is_valid_transition(
                ConnectionState.DISCONNECTED, ConnectionState.OFFLINE
            )
        )

    def test_get_valid_next_states(self):
        """Test getting valid next states from current state."""
        # ONLINE can go to OFFLINE or DISCONNECTED
        online_next = ConnectionState.get_valid_next_states(ConnectionState.ONLINE)
        self.assertIn(ConnectionState.OFFLINE, online_next)
        self.assertIn(ConnectionState.DISCONNECTED, online_next)
        self.assertEqual(len(online_next), 2)

        # DISCONNECTED is terminal (no next states)
        disconnected_next = ConnectionState.get_valid_next_states(
            ConnectionState.DISCONNECTED
        )
        self.assertEqual(len(disconnected_next), 0)

        # OFFLINE can go to RECONNECTING, DISCONNECTED, or ONLINE
        offline_next = ConnectionState.get_valid_next_states(ConnectionState.OFFLINE)
        self.assertIn(ConnectionState.RECONNECTING, offline_next)
        self.assertIn(ConnectionState.DISCONNECTED, offline_next)
        self.assertIn(ConnectionState.ONLINE, offline_next)


class TestStateTransitions(unittest.TestCase):
    """Test state transition methods in SSHConnectionPool."""

    def setUp(self):
        """Set up test fixtures."""
        self.pool = SSHConnectionPool()
        # Clear pool for clean tests
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def tearDown(self):
        """Clean up after tests."""
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def test_transition_connection_state_success(self):
        """Test successful state transition."""
        # Create mock connection
        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.ONLINE,
                "ip": "192.168.1.10",
                "state_history": [],
            }

        # Transition ONLINE → OFFLINE
        success = self.pool._transition_connection_state(
            1,
            ConnectionState.ONLINE,
            ConnectionState.OFFLINE,
            "Network outage detected"
        )

        self.assertTrue(success)

        with self.pool.pool_lock:
            conn_data = self.pool.pool[1]
            self.assertEqual(conn_data["status"], ConnectionState.OFFLINE)
            self.assertEqual(conn_data["state_change_reason"], "Network outage detected")
            self.assertIsNotNone(conn_data.get("last_state_change"))
            self.assertEqual(len(conn_data["state_history"]), 1)

            # Check state history
            history = conn_data["state_history"][0]
            self.assertEqual(history["from"], ConnectionState.ONLINE)
            self.assertEqual(history["to"], ConnectionState.OFFLINE)
            self.assertEqual(history["reason"], "Network outage detected")

    def test_transition_connection_state_invalid(self):
        """Test invalid state transition is rejected."""
        # Create mock connection
        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.ONLINE,
                "ip": "192.168.1.10",
                "state_history": [],
            }

        # Try invalid transition ONLINE → RECONNECTING
        success = self.pool._transition_connection_state(
            1,
            ConnectionState.ONLINE,
            ConnectionState.RECONNECTING,
            "Invalid transition"
        )

        self.assertFalse(success)

        # State should not change
        with self.pool.pool_lock:
            self.assertEqual(self.pool.pool[1]["status"], ConnectionState.ONLINE)

    def test_transition_connection_state_mismatch(self):
        """Test state mismatch prevents transition."""
        # Create mock connection
        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.OFFLINE,
                "ip": "192.168.1.10",
                "state_history": [],
            }

        # Try transition expecting ONLINE, but connection is OFFLINE
        success = self.pool._transition_connection_state(
            1,
            ConnectionState.ONLINE,  # Expected state (wrong)
            ConnectionState.DISCONNECTED,
            "Mismatched state"
        )

        self.assertFalse(success)

        # State should not change
        with self.pool.pool_lock:
            self.assertEqual(self.pool.pool[1]["status"], ConnectionState.OFFLINE)

    def test_set_connection_state(self):
        """Test _set_connection_state without strict validation."""
        # Create mock connection
        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.OFFLINE,
                "ip": "192.168.1.10",
                "state_history": [],
            }

        # Transition OFFLINE → RECONNECTING (without knowing current state)
        success = self.pool._set_connection_state(
            1,
            ConnectionState.RECONNECTING,
            "Auto-reconnect triggered"
        )

        self.assertTrue(success)

        with self.pool.pool_lock:
            self.assertEqual(self.pool.pool[1]["status"], ConnectionState.RECONNECTING)


class TestGetConnectionStateAware(unittest.TestCase):
    """Test get_connection() handles all states correctly."""

    def setUp(self):
        """Set up test fixtures."""
        self.pool = SSHConnectionPool()
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def tearDown(self):
        """Clean up after tests."""
        with self.pool.pool_lock:
            self.pool.pool.clear()

    @patch('ssh_pool._get_ssh_manager_class')
    def test_get_connection_online_state(self, mock_ssh_class):
        """Test get_connection returns ONLINE connection."""
        # Create ONLINE connection
        mock_conn = Mock()
        mock_conn.client = Mock()
        transport = Mock()
        transport.is_active.return_value = True
        transport.send_ignore.return_value = None
        transport.sock = Mock()
        transport.sock.recv.side_effect = BlockingIOError()
        mock_conn.client.get_transport.return_value = transport

        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": mock_conn,
                "status": ConnectionState.ONLINE,
                "last_used": time.time(),
                "ip": "192.168.1.10",
                "port": 22,
                "username": "test",
            }

        # Get connection
        result = self.pool.get_connection(1, "192.168.1.10", 22, "test", "pass")

        self.assertIsNotNone(result)
        self.assertEqual(result, mock_conn)

    def test_get_connection_offline_state(self):
        """Test get_connection triggers reconnection for OFFLINE state."""
        # Create OFFLINE connection
        mock_conn = Mock()

        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": mock_conn,
                "status": ConnectionState.OFFLINE,
                "last_used": time.time(),
                "ip": "192.168.1.10",
                "port": 22,
                "username": "test",
                "password": "pass",
                "reconnect_in_progress": False,
            }

        # Get connection (should trigger reconnection and return None)
        result = self.pool.get_connection(1, "192.168.1.10", 22, "test", "pass")

        self.assertIsNone(result)

        # Check reconnection thread was spawned
        time.sleep(0.1)  # Let thread start
        with self.pool.pool_lock:
            self.assertIsNotNone(self.pool.pool[1].get("reconnect_thread"))

    def test_get_connection_reconnecting_state(self):
        """Test get_connection returns None for RECONNECTING state."""
        mock_conn = Mock()

        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": mock_conn,
                "status": ConnectionState.RECONNECTING,
                "last_used": time.time(),
                "ip": "192.168.1.10",
                "reconnect_in_progress": True,
            }

        # Get connection (should return None)
        result = self.pool.get_connection(1, "192.168.1.10", 22, "test", "pass")

        self.assertIsNone(result)

    def test_get_connection_failed_state(self):
        """Test get_connection returns None for FAILED state."""
        mock_conn = Mock()

        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": mock_conn,
                "status": ConnectionState.FAILED,
                "last_used": time.time(),
                "ip": "192.168.1.10",
            }

        # Get connection (should return None)
        result = self.pool.get_connection(1, "192.168.1.10", 22, "test", "pass")

        self.assertIsNone(result)


class TestStateHistory(unittest.TestCase):
    """Test state history tracking."""

    def setUp(self):
        """Set up test fixtures."""
        self.pool = SSHConnectionPool()
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def tearDown(self):
        """Clean up after tests."""
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def test_state_history_tracking(self):
        """Test state transitions are recorded in history."""
        # Create connection
        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.ONLINE,
                "ip": "192.168.1.10",
                "state_history": [],
            }

        # Perform multiple transitions
        self.pool._transition_connection_state(
            1, ConnectionState.ONLINE, ConnectionState.OFFLINE, "Network outage"
        )

        self.pool._transition_connection_state(
            1, ConnectionState.OFFLINE, ConnectionState.RECONNECTING, "Auto-reconnect"
        )

        self.pool._transition_connection_state(
            1, ConnectionState.RECONNECTING, ConnectionState.ONLINE, "Reconnected"
        )

        # Check history
        with self.pool.pool_lock:
            history = self.pool.pool[1]["state_history"]
            self.assertEqual(len(history), 3)

            # Check first transition
            self.assertEqual(history[0]["from"], ConnectionState.ONLINE)
            self.assertEqual(history[0]["to"], ConnectionState.OFFLINE)
            self.assertEqual(history[0]["reason"], "Network outage")

            # Check second transition
            self.assertEqual(history[1]["from"], ConnectionState.OFFLINE)
            self.assertEqual(history[1]["to"], ConnectionState.RECONNECTING)

            # Check third transition
            self.assertEqual(history[2]["from"], ConnectionState.RECONNECTING)
            self.assertEqual(history[2]["to"], ConnectionState.ONLINE)


class TestPoolStatusEnhancements(unittest.TestCase):
    """Test get_pool_status includes Phase 3 fields."""

    def setUp(self):
        """Set up test fixtures."""
        self.pool = SSHConnectionPool()
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def tearDown(self):
        """Clean up after tests."""
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def test_pool_status_phase3_fields(self):
        """Test pool status includes Phase 3 state tracking fields."""
        # Create connection with state tracking
        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.ONLINE,
                "ip": "192.168.1.10",
                "port": 22,
                "username": "test",
                "created_at": time.time(),
                "last_used": time.time(),
                "total_reconnects": 2,
                "last_reconnect_time": time.time() - 100,
                "reconnect_in_progress": False,
                "is_terminal": False,
                "last_state_change": time.time() - 50,
                "state_change_reason": "Reconnection successful",
                "state_history": [
                    {"from": ConnectionState.OFFLINE, "to": ConnectionState.ONLINE, "timestamp": time.time()},
                ],
            }

        # Get pool status
        status = self.pool.get_pool_status()

        self.assertEqual(status["total_connections"], 1)
        self.assertEqual(len(status["connections"]), 1)

        conn = status["connections"][0]

        # Check Phase 3 fields
        self.assertIn("last_state_change", conn)
        self.assertIn("state_change_reason", conn)
        self.assertIn("state_history_count", conn)
        self.assertIn("seconds_since_state_change", conn)

        self.assertEqual(conn["state_change_reason"], "Reconnection successful")
        self.assertEqual(conn["state_history_count"], 1)
        self.assertIsNotNone(conn["seconds_since_state_change"])


def run_tests():
    """Run all Phase 3 tests."""
    # Create test suite
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # Add test classes
    suite.addTests(loader.loadTestsFromTestCase(TestConnectionState))
    suite.addTests(loader.loadTestsFromTestCase(TestStateTransitions))
    suite.addTests(loader.loadTestsFromTestCase(TestGetConnectionStateAware))
    suite.addTests(loader.loadTestsFromTestCase(TestStateHistory))
    suite.addTests(loader.loadTestsFromTestCase(TestPoolStatusEnhancements))

    # Run tests with detailed output
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # Print summary
    print("\n" + "=" * 70)
    print("PHASE 3 TEST SUMMARY")
    print("=" * 70)
    print(f"Tests Run: {result.testsRun}")
    print(f"Successes: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"Failures: {len(result.failures)}")
    print(f"Errors: {len(result.errors)}")
    print("=" * 70)

    return result.wasSuccessful()


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
