"""
Phase 4 Unit Tests: Enhanced Monitoring & Metrics

Tests for:
- ConnectionMetrics class and tracking
- Metrics integration with lifecycle events
- Environment variable configuration
- Aggregated metrics in pool status
- Configuration API

Run with:
    cd /home/hp_test/Eka/framework/dut-automation
    python tests/test_phase4_metrics.py
"""

import sys
import os
import time
import unittest
from unittest.mock import Mock, MagicMock, patch

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ssh_pool import SSHConnectionPool, ConnectionState, ConnectionMetrics, SSHPoolConfig


class TestConnectionMetrics(unittest.TestCase):
    """Test ConnectionMetrics class functionality."""

    def test_metrics_initialization(self):
        """Test metrics are initialized with correct default values."""
        metrics = ConnectionMetrics()

        self.assertIsNotNone(metrics.created_at)
        self.assertIsNotNone(metrics.last_used)
        self.assertEqual(metrics.total_reconnects, 0)
        self.assertEqual(metrics.successful_reconnects, 0)
        self.assertEqual(metrics.failed_reconnects, 0)
        self.assertEqual(metrics.offline_events, 0)
        self.assertEqual(metrics.offline_duration_total, 0.0)
        self.assertIsNone(metrics.current_offline_start)
        self.assertIsNone(metrics.first_offline_at)

    def test_record_offline_start(self):
        """Test recording offline period start."""
        metrics = ConnectionMetrics()

        metrics.record_offline_start()

        self.assertEqual(metrics.offline_events, 1)
        self.assertIsNotNone(metrics.current_offline_start)
        self.assertIsNotNone(metrics.first_offline_at)
        self.assertIsNotNone(metrics.last_offline_at)

    def test_record_offline_end(self):
        """Test recording offline period end and duration calculation."""
        metrics = ConnectionMetrics()

        metrics.record_offline_start()
        time.sleep(0.1)  # Simulate offline period
        metrics.record_offline_end()

        self.assertGreater(metrics.offline_duration_total, 0)
        self.assertIsNone(metrics.current_offline_start)
        self.assertGreater(metrics.longest_offline_duration, 0)
        self.assertIsNotNone(metrics.shortest_offline_duration)

    def test_multiple_offline_periods(self):
        """Test tracking multiple offline periods."""
        metrics = ConnectionMetrics()

        # First offline period
        metrics.record_offline_start()
        time.sleep(0.05)
        metrics.record_offline_end()

        # Second offline period
        metrics.record_offline_start()
        time.sleep(0.05)
        metrics.record_offline_end()

        self.assertEqual(metrics.offline_events, 2)
        self.assertGreater(metrics.offline_duration_total, 0.1)
        self.assertIsNone(metrics.current_offline_start)

    def test_reconnect_tracking(self):
        """Test reconnection attempt and success tracking."""
        metrics = ConnectionMetrics()

        # Record reconnection attempt
        metrics.record_reconnect_attempt()
        self.assertEqual(metrics.total_reconnects, 1)
        self.assertIsNotNone(metrics.last_reconnect_attempt)

        # Record successful reconnection
        metrics.record_reconnect_success()
        self.assertEqual(metrics.successful_reconnects, 1)
        self.assertIsNotNone(metrics.last_successful_reconnect)

    def test_reconnect_failure_tracking(self):
        """Test reconnection failure tracking."""
        metrics = ConnectionMetrics()

        metrics.record_reconnect_attempt()
        metrics.record_reconnect_failure()

        self.assertEqual(metrics.total_reconnects, 1)
        self.assertEqual(metrics.failed_reconnects, 1)
        self.assertEqual(metrics.successful_reconnects, 0)

    def test_get_current_offline_duration(self):
        """Test getting current offline duration."""
        metrics = ConnectionMetrics()

        # Not offline initially
        self.assertEqual(metrics.get_current_offline_duration(), 0.0)

        # Start offline period
        metrics.record_offline_start()
        time.sleep(0.1)

        # Should return non-zero duration
        duration = metrics.get_current_offline_duration()
        self.assertGreater(duration, 0.05)

    def test_get_average_offline_duration(self):
        """Test average offline duration calculation."""
        metrics = ConnectionMetrics()

        # No offline events
        self.assertEqual(metrics.get_average_offline_duration(), 0.0)

        # Add offline events
        metrics.record_offline_start()
        time.sleep(0.05)
        metrics.record_offline_end()

        metrics.record_offline_start()
        time.sleep(0.05)
        metrics.record_offline_end()

        avg_duration = metrics.get_average_offline_duration()
        self.assertGreater(avg_duration, 0)

    def test_get_reconnect_success_rate(self):
        """Test reconnection success rate calculation."""
        metrics = ConnectionMetrics()

        # No reconnects
        self.assertEqual(metrics.get_reconnect_success_rate(), 0.0)

        # 2 successful out of 3 attempts
        metrics.total_reconnects = 3
        metrics.successful_reconnects = 2

        success_rate = metrics.get_reconnect_success_rate()
        self.assertAlmostEqual(success_rate, 66.666, places=2)

    def test_metrics_to_dict(self):
        """Test metrics export to dictionary."""
        metrics = ConnectionMetrics()
        metrics.record_offline_start()
        time.sleep(0.05)
        metrics.record_offline_end()

        metrics_dict = metrics.to_dict()

        # Check all expected fields are present
        self.assertIn("created_at", metrics_dict)
        self.assertIn("last_used", metrics_dict)
        self.assertIn("uptime_seconds", metrics_dict)
        self.assertIn("total_reconnects", metrics_dict)
        self.assertIn("offline_events", metrics_dict)
        self.assertIn("offline_duration_total", metrics_dict)
        self.assertIn("average_offline_duration", metrics_dict)
        self.assertIn("reconnect_success_rate", metrics_dict)


class TestMetricsIntegration(unittest.TestCase):
    """Test metrics integration with SSH pool."""

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
    def test_metrics_created_with_connection(self, mock_ssh_class):
        """Test metrics are created when connection is added to pool."""
        # Mock SSH connection
        mock_ssh = Mock()
        mock_ssh.connect.return_value = True
        mock_ssh.client = Mock()
        transport = Mock()
        transport.is_active.return_value = True
        transport.send_ignore.return_value = None
        transport.sock = Mock()
        transport.sock.recv.side_effect = BlockingIOError()
        mock_ssh.client.get_transport.return_value = transport

        mock_ssh_class.return_value = mock_ssh

        # Create connection
        conn = self.pool.get_connection(1, "192.168.1.10", 22, "test", "pass")

        self.assertIsNotNone(conn)

        # Check metrics were created
        with self.pool.pool_lock:
            metrics = self.pool.pool[1].get("metrics")
            self.assertIsNotNone(metrics)
            self.assertIsInstance(metrics, ConnectionMetrics)

    def test_metrics_updated_on_state_transition(self):
        """Test metrics are updated when state transitions occur."""
        # Create connection with metrics
        metrics = ConnectionMetrics()
        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.ONLINE,
                "ip": "192.168.1.10",
                "state_history": [],
                "metrics": metrics,
            }

        # Transition to OFFLINE
        success = self.pool._transition_connection_state(
            1,
            ConnectionState.ONLINE,
            ConnectionState.OFFLINE,
            "Network outage"
        )

        self.assertTrue(success)
        self.assertEqual(metrics.offline_events, 1)
        self.assertIsNotNone(metrics.current_offline_start)
        self.assertEqual(metrics.state_transitions_count, 1)

    def test_metrics_offline_end_on_reconnect(self):
        """Test offline period ends when transitioning from OFFLINE."""
        metrics = ConnectionMetrics()
        metrics.record_offline_start()

        with self.pool.pool_lock:
            self.pool.pool[1] = {
                "connection": Mock(),
                "status": ConnectionState.OFFLINE,
                "ip": "192.168.1.10",
                "state_history": [],
                "metrics": metrics,
            }

        time.sleep(0.05)

        # Transition to RECONNECTING
        self.pool._transition_connection_state(
            1,
            ConnectionState.OFFLINE,
            ConnectionState.RECONNECTING,
            "Auto-reconnect"
        )

        # Offline period should be ended
        self.assertGreater(metrics.offline_duration_total, 0)


class TestAggregatedMetrics(unittest.TestCase):
    """Test aggregated metrics in pool status."""

    def setUp(self):
        """Set up test fixtures."""
        self.pool = SSHConnectionPool()
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def tearDown(self):
        """Clean up after tests."""
        with self.pool.pool_lock:
            self.pool.pool.clear()

    def test_aggregated_metrics_in_pool_status(self):
        """Test pool status includes aggregated metrics."""
        # Create connections with metrics
        for dut_id in [1, 2, 3]:
            metrics = ConnectionMetrics()
            metrics.offline_events = dut_id  # Different values for testing
            metrics.total_reconnects = dut_id * 2
            metrics.successful_reconnects = dut_id
            metrics.offline_duration_total = float(dut_id * 10)

            with self.pool.pool_lock:
                self.pool.pool[dut_id] = {
                    "connection": Mock(),
                    "status": ConnectionState.ONLINE,
                    "ip": f"192.168.1.{10 + dut_id}",
                    "port": 22,
                    "username": "test",
                    "created_at": time.time(),
                    "last_used": time.time(),
                    "total_reconnects": 0,
                    "reconnect_in_progress": False,
                    "is_terminal": False,
                    "state_history": [],
                    "metrics": metrics,
                }

        # Get pool status
        status = self.pool.get_pool_status()

        # Check aggregated metrics are present
        self.assertIn("aggregated_metrics", status)
        agg_metrics = status["aggregated_metrics"]

        self.assertEqual(agg_metrics["total_offline_events"], 6)  # 1+2+3
        self.assertEqual(agg_metrics["total_reconnects"], 12)  # 2+4+6
        self.assertEqual(agg_metrics["successful_reconnects"], 6)  # 1+2+3
        self.assertEqual(agg_metrics["total_offline_duration"], 60.0)  # 10+20+30

    def test_state_summary_in_pool_status(self):
        """Test pool status includes state summary counts."""
        # Create connections with different states
        states = [ConnectionState.ONLINE, ConnectionState.OFFLINE, ConnectionState.ONLINE,
                  ConnectionState.RECONNECTING, ConnectionState.FAILED]

        for idx, state in enumerate(states):
            with self.pool.pool_lock:
                self.pool.pool[idx] = {
                    "connection": Mock(),
                    "status": state,
                    "ip": f"192.168.1.{10 + idx}",
                    "port": 22,
                    "username": "test",
                    "created_at": time.time(),
                    "last_used": time.time(),
                    "total_reconnects": 0,
                    "reconnect_in_progress": False,
                    "is_terminal": False,
                    "state_history": [],
                    "metrics": ConnectionMetrics(),
                }

        status = self.pool.get_pool_status()

        # Check state summary
        self.assertIn("state_summary", status)
        state_summary = status["state_summary"]

        self.assertEqual(state_summary[ConnectionState.ONLINE], 2)
        self.assertEqual(state_summary[ConnectionState.OFFLINE], 1)
        self.assertEqual(state_summary[ConnectionState.RECONNECTING], 1)
        self.assertEqual(state_summary[ConnectionState.FAILED], 1)


class TestSSHPoolConfig(unittest.TestCase):
    """Test SSH pool configuration."""

    def test_config_defaults(self):
        """Test default configuration values."""
        # These should have default values when env vars not set
        self.assertIsInstance(SSHPoolConfig.NETWORK_MONITOR_INTERVAL, int)
        self.assertIsInstance(SSHPoolConfig.RECONNECT_MAX_ATTEMPTS, int)
        self.assertIsInstance(SSHPoolConfig.KEEPALIVE_INTERVAL, int)

        # Check reasonable default values
        self.assertEqual(SSHPoolConfig.NETWORK_MONITOR_INTERVAL, 5)
        self.assertEqual(SSHPoolConfig.RECONNECT_MAX_ATTEMPTS, 6)
        self.assertEqual(SSHPoolConfig.RECONNECT_MAX_DELAY, 60)

    def test_config_summary(self):
        """Test configuration summary export."""
        config_summary = SSHPoolConfig.get_config_summary()

        # Check structure
        self.assertIn("network_monitoring", config_summary)
        self.assertIn("reconnection", config_summary)
        self.assertIn("connection_pool", config_summary)
        self.assertIn("state_preservation", config_summary)

        # Check specific values
        self.assertIn("enabled", config_summary["network_monitoring"])
        self.assertIn("max_attempts", config_summary["reconnection"])
        self.assertIn("keepalive_interval", config_summary["connection_pool"])

    def test_pool_get_configuration(self):
        """Test SSHConnectionPool.get_configuration() method."""
        pool = SSHConnectionPool()
        config = pool.get_configuration()

        # Should return same structure as SSHPoolConfig.get_config_summary()
        self.assertIn("network_monitoring", config)
        self.assertIn("reconnection", config)
        self.assertIn("connection_pool", config)


def run_tests():
    """Run all Phase 4 tests."""
    # Create test suite
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # Add test classes
    suite.addTests(loader.loadTestsFromTestCase(TestConnectionMetrics))
    suite.addTests(loader.loadTestsFromTestCase(TestMetricsIntegration))
    suite.addTests(loader.loadTestsFromTestCase(TestAggregatedMetrics))
    suite.addTests(loader.loadTestsFromTestCase(TestSSHPoolConfig))

    # Run tests with detailed output
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # Print summary
    print("\n" + "=" * 70)
    print("PHASE 4 TEST SUMMARY")
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
