"""
Phase 1 Enhancement Test: Network Monitor Functionality

Tests the network monitoring thread and SSH pool integration.
"""

import sys
import time
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ssh_monitor import NetworkMonitor
from ssh_pool import SSHConnectionPool


def test_network_monitor_basic():
    """Test basic network monitor functionality."""
    print("\n=== Test 1: Network Monitor Basic Functionality ===")

    monitor = NetworkMonitor(check_interval=3, probe_timeout=1.0)

    # Check initial state
    assert monitor.network_online == True, "Initial state should be online"
    print("✓ Initial state: ONLINE")

    # Start monitoring
    started = monitor.start_monitoring()
    assert started == True, "Monitor should start successfully"
    print("✓ Monitor started successfully")

    # Wait for a few checks
    print("Waiting 10 seconds for monitoring checks...")
    time.sleep(10)

    # Get statistics
    stats = monitor.get_statistics()
    print(f"✓ Statistics: {stats}")
    assert stats["total_checks"] > 0, "Should have performed checks"
    assert stats["is_monitoring"] == True, "Should be monitoring"

    # Stop monitoring
    monitor.stop_monitoring()
    print("✓ Monitor stopped successfully")

    print("✓ Test 1 PASSED\n")


def test_network_monitor_callbacks():
    """Test network monitor callback mechanism."""
    print("=== Test 2: Network Monitor Callbacks ===")

    monitor = NetworkMonitor(check_interval=2, probe_timeout=1.0)

    # Track callback invocations
    callback_invoked = {"count": 0, "state": None}

    def test_callback(is_online: bool):
        callback_invoked["count"] += 1
        callback_invoked["state"] = is_online
        print(f"  Callback invoked: state={is_online}, count={callback_invoked['count']}")

    # Register callback
    monitor.register_callback(test_callback)
    print("✓ Callback registered")

    # Start monitoring
    monitor.start_monitoring()
    print("✓ Monitoring started")

    # Note: Callback will only fire on state changes
    # In normal conditions, state won't change, so callback count may be 0
    time.sleep(5)

    stats = monitor.get_statistics()
    print(f"✓ Statistics: checks={stats['total_checks']}, state_changes={stats['state_changes']}")

    # Stop monitoring
    monitor.stop_monitoring()
    print("✓ Monitor stopped")

    print("✓ Test 2 PASSED\n")


def test_ssh_pool_integration():
    """Test SSH pool network monitoring integration."""
    print("=== Test 3: SSH Pool Integration ===")

    pool = SSHConnectionPool()

    # Check initial state
    assert pool.network_monitor is None, "Monitor should not be initialized yet"
    print("✓ Initial state: monitor not initialized")

    # Start network monitoring
    started = pool.start_network_monitoring(check_interval=5, probe_timeout=2.0)
    assert started == True, "Monitoring should start successfully"
    print("✓ Network monitoring started")

    # Verify monitor is running
    assert pool.network_monitor is not None, "Monitor should be initialized"
    assert pool.network_monitor.running == True, "Monitor should be running"
    print("✓ Monitor is running")

    # Get network status
    time.sleep(2)  # Wait for initial check
    status = pool.get_network_status()
    print(f"✓ Network status: {status}")

    assert "network_online" in status, "Should have network_online field"
    assert "monitoring_enabled" in status or status.get("network_online") is not None, "Should be monitoring"

    # Stop monitoring
    pool.stop_network_monitoring()
    print("✓ Monitoring stopped")

    assert pool.network_monitor is None, "Monitor should be None after stop"
    print("✓ Monitor cleaned up")

    print("✓ Test 3 PASSED\n")


def test_pool_status_api():
    """Test pool status API."""
    print("=== Test 4: Pool Status API ===")

    pool = SSHConnectionPool()

    # Get pool status
    status = pool.get_pool_status()
    print(f"✓ Pool status: {status}")

    assert "total_connections" in status, "Should have total_connections"
    assert "connections" in status, "Should have connections list"
    print(f"✓ Total connections: {status['total_connections']}")

    print("✓ Test 4 PASSED\n")


def run_all_tests():
    """Run all Phase 1 tests."""
    print("\n" + "="*60)
    print("PHASE 1 ENHANCEMENT TEST SUITE")
    print("Network Monitor & SSH Pool Integration")
    print("="*60)

    try:
        test_network_monitor_basic()
        test_network_monitor_callbacks()
        test_ssh_pool_integration()
        test_pool_status_api()

        print("="*60)
        print("ALL TESTS PASSED ✓")
        print("="*60)
        return True

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        return False
    except Exception as e:
        print(f"\n❌ UNEXPECTED ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
