"""
SSH Connection Pool Manager

Provides centralized SSH connection management with:
- Single persistent connection per device (shared across all operations)
- Automatic connection health monitoring
- SSH keepalive (every 10 seconds)
- Connection reuse for all tabs (Devices, VS Manager, Execution, Terminal)
- Thread-safe connection pool
- Automatic cleanup of idle/dead connections
- Proactive network monitoring with auto-reconnection
"""

import threading
import time
import logging
import socket
import os
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class SSHPoolConfig:
    """
    Environment variable configuration for SSH Connection Pool (Phase 4).

    Supports configuration via environment variables with sensible defaults.
    """

    # Network monitoring settings
    NETWORK_MONITOR_ENABLED = os.getenv("SSH_NETWORK_MONITOR_ENABLED", "true").lower() == "true"
    NETWORK_MONITOR_INTERVAL = int(os.getenv("SSH_NETWORK_MONITOR_INTERVAL", "5"))
    NETWORK_PROBE_TIMEOUT = float(os.getenv("SSH_NETWORK_PROBE_TIMEOUT", "2.0"))

    # Reconnection behavior
    AUTO_RECONNECT_ENABLED = os.getenv("SSH_AUTO_RECONNECT", "true").lower() == "true"
    RECONNECT_MAX_ATTEMPTS = int(os.getenv("SSH_RECONNECT_MAX_ATTEMPTS", "6"))
    RECONNECT_MAX_DELAY = int(os.getenv("SSH_RECONNECT_MAX_DELAY", "60"))

    # Connection pool settings
    IDLE_TIMEOUT = int(os.getenv("SSH_IDLE_TIMEOUT", "300"))  # 5 minutes
    KEEPALIVE_INTERVAL = int(os.getenv("SSH_KEEPALIVE_INTERVAL", "10"))
    TCP_KEEPALIVE_IDLE = int(os.getenv("SSH_TCP_KEEPALIVE_IDLE", "60"))
    TCP_KEEPALIVE_INTERVAL = int(os.getenv("SSH_TCP_KEEPALIVE_INTERVAL", "10"))
    TCP_KEEPALIVE_COUNT = int(os.getenv("SSH_TCP_KEEPALIVE_COUNT", "6"))

    # State preservation
    OFFLINE_TIMEOUT = int(os.getenv("SSH_OFFLINE_TIMEOUT", "300"))  # Keep offline connections for 5 minutes
    PRESERVE_ON_NETWORK_LOSS = os.getenv("SSH_PRESERVE_ON_NETWORK_LOSS", "true").lower() == "true"

    @classmethod
    def get_config_summary(cls) -> dict:
        """
        Get current configuration as dictionary.

        Returns:
            Dictionary of all configuration values
        """
        return {
            "network_monitoring": {
                "enabled": cls.NETWORK_MONITOR_ENABLED,
                "check_interval": cls.NETWORK_MONITOR_INTERVAL,
                "probe_timeout": cls.NETWORK_PROBE_TIMEOUT,
            },
            "reconnection": {
                "auto_reconnect_enabled": cls.AUTO_RECONNECT_ENABLED,
                "max_attempts": cls.RECONNECT_MAX_ATTEMPTS,
                "max_delay": cls.RECONNECT_MAX_DELAY,
            },
            "connection_pool": {
                "idle_timeout": cls.IDLE_TIMEOUT,
                "keepalive_interval": cls.KEEPALIVE_INTERVAL,
                "tcp_keepalive_idle": cls.TCP_KEEPALIVE_IDLE,
                "tcp_keepalive_interval": cls.TCP_KEEPALIVE_INTERVAL,
                "tcp_keepalive_count": cls.TCP_KEEPALIVE_COUNT,
            },
            "state_preservation": {
                "offline_timeout": cls.OFFLINE_TIMEOUT,
                "preserve_on_network_loss": cls.PRESERVE_ON_NETWORK_LOSS,
            },
        }


class ConnectionState:
    """
    Formal connection state definitions with transition validation (Phase 3).

    States:
        ONLINE: Connection is healthy and operational
        OFFLINE: Network issue detected, connection preserved for recovery
        DISCONNECTED: Explicitly closed by user or system
        RECONNECTING: Active reconnection attempt in progress
        FAILED: Reconnection exhausted all retry attempts

    State Transition Rules:
        ONLINE → OFFLINE: Network outage detected
        ONLINE → DISCONNECTED: Explicit close requested
        OFFLINE → RECONNECTING: Auto-reconnect triggered
        OFFLINE → DISCONNECTED: Explicit close requested
        RECONNECTING → ONLINE: Reconnection successful
        RECONNECTING → FAILED: All retry attempts exhausted
        RECONNECTING → OFFLINE: Network went offline during reconnect
        FAILED → RECONNECTING: Manual retry triggered
        FAILED → DISCONNECTED: Explicit close requested
    """

    # State constants
    ONLINE = "online"
    OFFLINE = "offline"
    DISCONNECTED = "disconnected"
    RECONNECTING = "reconnecting"
    FAILED = "failed"

    # Valid state transitions (from_state -> allowed_to_states)
    VALID_TRANSITIONS = {
        ONLINE: {OFFLINE, DISCONNECTED},
        OFFLINE: {RECONNECTING, DISCONNECTED, ONLINE},  # ONLINE for quick recovery
        RECONNECTING: {ONLINE, FAILED, OFFLINE},
        FAILED: {RECONNECTING, DISCONNECTED},
        DISCONNECTED: set(),  # Terminal state - no transitions allowed
    }

    @classmethod
    def is_valid_transition(cls, from_state: str, to_state: str) -> bool:
        """
        Validate if state transition is allowed.

        Args:
            from_state: Current state
            to_state: Target state

        Returns:
            True if transition is valid, False otherwise
        """
        if from_state not in cls.VALID_TRANSITIONS:
            logger.warning(f"Unknown state: {from_state}")
            return False

        return to_state in cls.VALID_TRANSITIONS[from_state]

    @classmethod
    def get_valid_next_states(cls, current_state: str) -> set:
        """
        Get all valid next states from current state.

        Args:
            current_state: Current connection state

        Returns:
            Set of valid next states
        """
        return cls.VALID_TRANSITIONS.get(current_state, set())


class ConnectionMetrics:
    """
    Per-connection metrics and statistics tracking (Phase 4).

    Tracks detailed connection health, reconnection patterns, and offline duration.
    """

    def __init__(self):
        """Initialize connection metrics with default values."""
        # Lifecycle timestamps
        self.created_at = time.time()
        self.last_used = time.time()
        self.first_offline_at = None  # First time connection went offline
        self.last_offline_at = None   # Most recent offline event

        # Reconnection metrics
        self.total_reconnects = 0
        self.successful_reconnects = 0
        self.failed_reconnects = 0
        self.last_reconnect_attempt = None
        self.last_successful_reconnect = None

        # Offline duration tracking
        self.offline_events = 0
        self.offline_duration_total = 0.0  # Cumulative offline time in seconds
        self.current_offline_start = None  # Track ongoing offline period
        self.longest_offline_duration = 0.0
        self.shortest_offline_duration = None

        # State transition metrics
        self.state_transitions_count = 0
        self.time_in_online = 0.0
        self.time_in_offline = 0.0
        self.time_in_reconnecting = 0.0
        self.time_in_failed = 0.0

    def record_offline_start(self) -> None:
        """Record the start of an offline period."""
        self.offline_events += 1
        self.current_offline_start = time.time()
        self.last_offline_at = self.current_offline_start

        if self.first_offline_at is None:
            self.first_offline_at = self.current_offline_start

    def record_offline_end(self) -> None:
        """Record the end of an offline period and calculate duration."""
        if self.current_offline_start is not None:
            duration = time.time() - self.current_offline_start
            self.offline_duration_total += duration

            # Track longest/shortest offline durations
            if duration > self.longest_offline_duration:
                self.longest_offline_duration = duration

            if self.shortest_offline_duration is None or duration < self.shortest_offline_duration:
                self.shortest_offline_duration = duration

            self.current_offline_start = None

    def record_reconnect_attempt(self) -> None:
        """Record a reconnection attempt."""
        self.total_reconnects += 1
        self.last_reconnect_attempt = time.time()

    def record_reconnect_success(self) -> None:
        """Record a successful reconnection."""
        self.successful_reconnects += 1
        self.last_successful_reconnect = time.time()
        self.record_offline_end()  # End offline period on successful reconnect

    def record_reconnect_failure(self) -> None:
        """Record a failed reconnection."""
        self.failed_reconnects += 1

    def record_state_transition(self) -> None:
        """Record a state transition event."""
        self.state_transitions_count += 1

    def get_current_offline_duration(self) -> float:
        """
        Get duration of current offline period if connection is offline.

        Returns:
            Duration in seconds, or 0 if not currently offline
        """
        if self.current_offline_start is not None:
            return time.time() - self.current_offline_start
        return 0.0

    def get_average_offline_duration(self) -> float:
        """
        Get average offline duration across all offline events.

        Returns:
            Average duration in seconds, or 0 if never offline
        """
        if self.offline_events > 0:
            return self.offline_duration_total / self.offline_events
        return 0.0

    def get_reconnect_success_rate(self) -> float:
        """
        Get reconnection success rate as percentage.

        Returns:
            Success rate 0-100, or 0 if no reconnects attempted
        """
        if self.total_reconnects > 0:
            return (self.successful_reconnects / self.total_reconnects) * 100
        return 0.0

    def to_dict(self) -> dict:
        """
        Export metrics as dictionary for API responses.

        Returns:
            Dictionary of all metrics
        """
        current_time = time.time()

        return {
            # Lifecycle
            "created_at": self.created_at,
            "last_used": self.last_used,
            "uptime_seconds": current_time - self.created_at,

            # Reconnection metrics
            "total_reconnects": self.total_reconnects,
            "successful_reconnects": self.successful_reconnects,
            "failed_reconnects": self.failed_reconnects,
            "reconnect_success_rate": self.get_reconnect_success_rate(),
            "last_reconnect_attempt": self.last_reconnect_attempt,
            "last_successful_reconnect": self.last_successful_reconnect,

            # Offline metrics
            "offline_events": self.offline_events,
            "offline_duration_total": self.offline_duration_total,
            "current_offline_duration": self.get_current_offline_duration(),
            "average_offline_duration": self.get_average_offline_duration(),
            "longest_offline_duration": self.longest_offline_duration,
            "shortest_offline_duration": self.shortest_offline_duration,
            "first_offline_at": self.first_offline_at,
            "last_offline_at": self.last_offline_at,

            # State transitions
            "state_transitions_count": self.state_transitions_count,
        }


# Lazy import to avoid circular dependencies
_NetworkMonitor = None


def _get_network_monitor_class():
    """Lazy import of NetworkMonitor to avoid circular imports."""
    global _NetworkMonitor
    if _NetworkMonitor is None:
        from ssh_monitor import NetworkMonitor
        _NetworkMonitor = NetworkMonitor
    return _NetworkMonitor


def _get_ssh_manager_class():
    """Lazy import of SSHConnectionManager to avoid circular imports."""
    from main import SSHConnectionManager
    return SSHConnectionManager


class SSHConnectionPool:
    """
    Singleton SSH Connection Pool.

    Maintains one persistent SSH connection per device, shared across:
    - Device ping operations
    - VS Manager (virsh commands)
    - Test Execution
    - PTY Terminal

    Features:
    - Thread-safe with locks
    - SSH keepalive every 10 seconds (detects network failures)
    - Automatic reconnection on failure
    - Idle connection cleanup (after 5 minutes)
    - Connection health monitoring
    """

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        """Singleton pattern - only one pool instance exists."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance.pool = {}
                    cls._instance.pool_lock = threading.Lock()

                    # Network monitoring (Phase 1 enhancement)
                    cls._instance.network_monitor = None
                    cls._instance.network_online = True
                    cls._instance.auto_reconnect_enabled = SSHPoolConfig.AUTO_RECONNECT_ENABLED

                    logger.info("SSH Connection Pool initialized")
                    logger.info(f"Configuration: {SSHPoolConfig.get_config_summary()}")
        return cls._instance

    def _transition_connection_state(
        self, dut_id: int, from_state: str, to_state: str, reason: str = ""
    ) -> bool:
        """
        Safely transition connection state with validation and logging (Phase 3).

        Args:
            dut_id: Device ID
            from_state: Expected current state
            to_state: Target state
            reason: Optional reason for transition

        Returns:
            True if transition successful, False if invalid or connection not found
        """
        with self.pool_lock:
            if dut_id not in self.pool:
                logger.warning(f"DUT {dut_id}: Cannot transition state - not in pool")
                return False

            conn_data = self.pool[dut_id]
            current_state = conn_data.get("status", ConnectionState.ONLINE)

            # Verify current state matches expected state
            if from_state and current_state != from_state:
                logger.warning(
                    f"DUT {dut_id}: State mismatch - expected {from_state}, "
                    f"found {current_state}, cannot transition to {to_state}"
                )
                return False

            # Validate transition
            if not ConnectionState.is_valid_transition(current_state, to_state):
                logger.error(
                    f"DUT {dut_id}: Invalid state transition {current_state} → {to_state}"
                )
                return False

            # Perform transition
            conn_data["status"] = to_state
            conn_data["last_state_change"] = time.time()
            conn_data["state_change_reason"] = reason

            # Track state transition history
            if "state_history" not in conn_data:
                conn_data["state_history"] = []

            conn_data["state_history"].append({
                "from": current_state,
                "to": to_state,
                "timestamp": time.time(),
                "reason": reason
            })

            # Phase 4: Update metrics on state transitions
            metrics = conn_data.get("metrics")
            if metrics:
                metrics.record_state_transition()

                # Record offline start when transitioning to OFFLINE
                if to_state == ConnectionState.OFFLINE:
                    metrics.record_offline_start()

                # Record offline end when leaving OFFLINE state
                if current_state == ConnectionState.OFFLINE and to_state != ConnectionState.OFFLINE:
                    metrics.record_offline_end()

            # Log transition
            reason_str = f" ({reason})" if reason else ""
            logger.info(
                f"DUT {dut_id} ({conn_data.get('ip')}): "
                f"{current_state} → {to_state}{reason_str}"
            )

            return True

    def _set_connection_state(
        self, dut_id: int, to_state: str, reason: str = ""
    ) -> bool:
        """
        Set connection state without strict validation (Phase 3).

        Use this when you don't know the current state or need to force a state.
        Still validates the transition is allowed from actual current state.

        Args:
            dut_id: Device ID
            to_state: Target state
            reason: Optional reason for transition

        Returns:
            True if successful, False otherwise
        """
        return self._transition_connection_state(dut_id, None, to_state, reason)

    def get_connection(self, dut_id: int, ip: str, port: int, username: str, password: str):
        """
        Get or create SSH connection for a device (Phase 3 Enhanced - State-Aware).

        Handles all connection states:
        - ONLINE: Verify alive and return
        - OFFLINE: Trigger reconnection, return None
        - RECONNECTING: Return None (reconnection in progress)
        - FAILED: Return None (reconnection failed)
        - DISCONNECTED: Create new connection
        - Not in pool: Create new connection

        Returns:
            SSHConnectionManager instance or None if connection unavailable
        """
        with self.pool_lock:
            # Check if connection exists in pool
            if dut_id in self.pool:
                conn_data = self.pool[dut_id]
                status = conn_data.get("status", ConnectionState.ONLINE)

                # Handle ONLINE state
                if status == ConnectionState.ONLINE:
                    # Verify connection is actually alive
                    if self._is_alive(conn_data["connection"]):
                        conn_data["last_used"] = time.time()
                        logger.debug(f"DUT {dut_id}: Reusing ONLINE connection")
                        return conn_data["connection"]
                    else:
                        # Connection is dead, transition to OFFLINE
                        logger.warning(f"DUT {dut_id}: ONLINE connection is dead, marking OFFLINE")

                # Handle OFFLINE state
                if status == ConnectionState.OFFLINE:
                    logger.info(f"DUT {dut_id}: Connection OFFLINE, triggering auto-reconnect")
                    # Spawn background reconnect if not already in progress
                    if not conn_data.get("reconnect_in_progress", False):
                        thread = threading.Thread(
                            target=self._reconnect_with_backoff,
                            args=(dut_id,),
                            kwargs={
                                "max_attempts": SSHPoolConfig.RECONNECT_MAX_ATTEMPTS,
                                "max_delay": SSHPoolConfig.RECONNECT_MAX_DELAY
                            },
                            daemon=True,
                            name=f"ssh-reconnect-dut-{dut_id}"
                        )
                        conn_data["reconnect_thread"] = thread
                        thread.start()
                        logger.debug(f"DUT {dut_id}: Spawned auto-reconnect thread")
                    return None

                # Handle RECONNECTING state
                if status == ConnectionState.RECONNECTING:
                    logger.debug(f"DUT {dut_id}: Reconnection in progress, returning None")
                    return None

                # Handle FAILED state
                if status == ConnectionState.FAILED:
                    logger.warning(f"DUT {dut_id}: Connection FAILED, returning None")
                    return None

                # Handle DISCONNECTED state - remove and create new
                if status == ConnectionState.DISCONNECTED:
                    logger.info(f"DUT {dut_id}: Connection DISCONNECTED, removing from pool")
                    self._close_connection(dut_id)
                    # Fall through to create new connection below

            # Create new connection
            logger.info(f"Creating new SSH connection for DUT {dut_id} ({username}@{ip}:{port})")
            SSHConnectionManager = _get_ssh_manager_class()
            ssh = SSHConnectionManager(ip, port, username, password)

            if ssh.connect():
                # Enable comprehensive keepalive at multiple levels
                # This prevents idle connection timeouts from network devices/firewalls
                try:
                    transport = ssh.client.get_transport()
                    if transport:
                        # Level 1: SSH protocol keepalive (Paramiko transport layer)
                        transport.set_keepalive(SSHPoolConfig.KEEPALIVE_INTERVAL)

                        # Level 2: TCP socket keepalive (OS level)
                        sock = transport.sock
                        if sock:
                            # Enable TCP keepalive
                            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)

                            # Linux/Unix specific TCP keepalive tuning
                            # These settings ensure connection health even through NAT/firewalls
                            if hasattr(socket, 'TCP_KEEPIDLE'):
                                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, SSHPoolConfig.TCP_KEEPALIVE_IDLE)
                                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, SSHPoolConfig.TCP_KEEPALIVE_INTERVAL)
                                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, SSHPoolConfig.TCP_KEEPALIVE_COUNT)
                                logger.info(
                                    f"Enhanced SSH+TCP keepalive enabled for DUT {dut_id} "
                                    f"(SSH: {SSHPoolConfig.KEEPALIVE_INTERVAL}s, TCP: {SSHPoolConfig.TCP_KEEPALIVE_IDLE}s idle, "
                                    f"{SSHPoolConfig.TCP_KEEPALIVE_INTERVAL}s interval, {SSHPoolConfig.TCP_KEEPALIVE_COUNT} probes)"
                                )
                            else:
                                # Fallback for non-Linux systems
                                logger.info(
                                    f"SSH keepalive enabled ({SSHPoolConfig.KEEPALIVE_INTERVAL}s) for DUT {dut_id} - "
                                    f"TCP tuning not available on this platform"
                                )
                        else:
                            logger.warning(f"Cannot access socket for DUT {dut_id} - TCP keepalive not set")
                except Exception as e:
                    logger.warning(f"Failed to set keepalive for DUT {dut_id}: {e}")

                # Add to pool
                metrics = ConnectionMetrics()  # Phase 4: Initialize metrics
                self.pool[dut_id] = {
                    "connection": ssh,
                    "status": ConnectionState.ONLINE,
                    "last_used": time.time(),
                    "created_at": time.time(),
                    "ip": ip,
                    "port": port,
                    "username": username,
                    "password": password,  # Store for reconnection
                    "is_terminal": False,  # Terminal session flag (excludes from cleanup)
                    # Phase 2: Reconnection metadata
                    "total_reconnects": 0,
                    "last_reconnect_time": None,
                    "reconnect_in_progress": False,
                    "reconnect_thread": None,
                    # Phase 3: State tracking
                    "last_state_change": time.time(),
                    "state_change_reason": "Initial connection",
                    "state_history": [{
                        "from": None,
                        "to": ConnectionState.ONLINE,
                        "timestamp": time.time(),
                        "reason": "Initial connection"
                    }],
                    # Phase 4: Metrics tracking
                    "metrics": metrics,
                }
                logger.info(f"DUT {dut_id}: Added to pool with ONLINE state")
                return ssh
            else:
                logger.error(f"Failed to create SSH connection for DUT {dut_id}")
                return None

    def _is_alive(self, ssh_conn) -> bool:
        """
        Check if SSH connection is still alive with comprehensive testing.

        Tests performed (in order):
        1. SSH client object exists
        2. Transport layer exists and claims to be active
        3. Socket is actually connected (not just reported as active)
        4. Can send SSH protocol packet (send_ignore test)

        Returns:
            True if connection is alive and usable, False otherwise

        Note: This prevents returning "dead" connections that appear alive.
        """
        try:
            # Test 1: Basic object validation
            if not ssh_conn or not ssh_conn.client:
                logger.debug("Connection check failed: No SSH client object")
                return False

            # Test 2: Transport layer validation
            transport = ssh_conn.client.get_transport()
            if not transport:
                logger.debug("Connection check failed: No transport")
                return False

            if not transport.is_active():
                logger.debug("Connection check failed: Transport not active")
                return False

            # Test 3: Socket-level validation
            sock = transport.sock
            if not sock:
                logger.debug("Connection check failed: No socket")
                return False

            # Check if socket is actually connected (not just claimed)
            try:
                # Peek at socket to see if it's readable (non-blocking check)
                sock.setblocking(False)
                try:
                    data = sock.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
                    # If we get data or would block, socket is alive
                    # If we get empty bytes, socket is closed
                    if len(data) == 0 and transport.is_active():
                        # Socket closed but transport thinks it's active
                        logger.debug("Connection check failed: Socket closed")
                        return False
                except BlockingIOError:
                    # Would block = socket is alive but no data
                    pass
                except OSError:
                    # Socket error = connection dead
                    logger.debug("Connection check failed: Socket error")
                    return False
                finally:
                    sock.setblocking(True)
            except Exception as sock_err:
                logger.debug(f"Connection check failed: Socket test error: {sock_err}")
                return False

            # Test 4: SSH protocol-level test
            # Send SSH ignore packet (lightweight, doesn't open channel)
            try:
                transport.send_ignore()
                logger.debug("Connection health check: ALIVE (all tests passed)")
                return True
            except Exception as send_err:
                logger.debug(f"Connection check failed: Cannot send SSH packet: {send_err}")
                return False

        except Exception as e:
            logger.debug(f"Connection health check exception: {e}")
            return False

    def release_connection(self, dut_id: int):
        """
        Release connection back to pool (mark as available).

        Connection is NOT closed - it stays in pool for reuse.
        Just updates the last_used timestamp.
        """
        with self.pool_lock:
            if dut_id in self.pool:
                self.pool[dut_id]["last_used"] = time.time()
                logger.debug(f"Released SSH connection for DUT {dut_id} back to pool")

    def close_connection(self, dut_id: int):
        """
        Close and remove connection from pool (Phase 3 Enhanced).

        Transitions to DISCONNECTED state before cleanup.

        Use this when:
        - Device is deleted
        - Connection is permanently broken
        - Device credentials changed
        """
        # Transition to DISCONNECTED state first
        self._set_connection_state(dut_id, ConnectionState.DISCONNECTED, "Explicit close requested")

        with self.pool_lock:
            self._close_connection(dut_id)

    def _close_connection(self, dut_id: int):
        """Internal method to close connection (assumes lock is held) - Phase 3 Enhanced."""
        if dut_id in self.pool:
            try:
                self.pool[dut_id]["connection"].disconnect()
                logger.info(f"DUT {dut_id}: Closed SSH connection and removed from pool")
            except Exception as e:
                logger.warning(f"DUT {dut_id}: Error closing SSH connection: {e}")
            del self.pool[dut_id]

    def refresh_connection(self, dut_id: int, ip: str, port: int, username: str, password: str):
        """
        Force reconnect for a DUT (close existing and create new connection).

        Use this when:
        - Connection is suspected dead but health check didn't detect it
        - After network interruption
        - When operations consistently fail on a connection
        - Manual recovery needed

        Args:
            dut_id: Device ID
            ip, port, username, password: Connection parameters

        Returns:
            SSHConnectionManager instance or None if reconnection failed
        """
        logger.info(f"Forcing connection refresh for DUT {dut_id}")

        # Close existing connection
        with self.pool_lock:
            if dut_id in self.pool:
                self._close_connection(dut_id)
                logger.info(f"Closed stale connection for DUT {dut_id}")

        # Create new connection (uses existing get_connection logic)
        new_conn = self.get_connection(dut_id, ip, port, username, password)
        if new_conn:
            logger.info(f"Successfully refreshed connection for DUT {dut_id}")
        else:
            logger.error(f"Failed to refresh connection for DUT {dut_id}")

        return new_conn

    def mark_connection_as_terminal(self, dut_id: int):
        """
        Mark connection as active terminal session (excludes from idle cleanup).
        Called when Terminal tab opens WebSocket connection.
        """
        with self.pool_lock:
            if dut_id in self.pool:
                self.pool[dut_id]["is_terminal"] = True
                logger.info(f"Marked SSH connection for DUT {dut_id} as terminal session")

    def unmark_connection_as_terminal(self, dut_id: int):
        """
        Unmark connection as terminal session (allows normal idle cleanup).
        Called when Terminal tab closes WebSocket connection.
        """
        with self.pool_lock:
            if dut_id in self.pool:
                self.pool[dut_id]["is_terminal"] = False
                logger.info(f"Unmarked SSH connection for DUT {dut_id} from terminal session")

    def is_terminal_active(self, dut_id: int) -> bool:
        """
        Check if device has an active terminal session.
        Used by heartbeat to skip channel commands when terminal is using connection.

        Returns:
            True if terminal session is active, False otherwise
        """
        with self.pool_lock:
            if dut_id in self.pool:
                return self.pool[dut_id].get("is_terminal", False)
            return False

    def cleanup_idle(self, max_idle_seconds: int = 300):
        """
        Close connections that have been idle for more than max_idle_seconds.

        Default: 300 seconds (5 minutes)

        Skips connections marked as terminal sessions (kept alive indefinitely).

        This prevents:
        - Stale connections consuming resources
        - Firewall timeout issues
        - SSH server connection limits
        """
        with self.pool_lock:
            current_time = time.time()
            to_remove = []

            for dut_id, conn_data in self.pool.items():
                # Skip cleanup if this is an active terminal session
                if conn_data.get("is_terminal", False):
                    logger.debug(f"Skipping cleanup for terminal session DUT {dut_id}")
                    continue

                idle_time = current_time - conn_data["last_used"]
                if idle_time > max_idle_seconds:
                    logger.info(f"Closing idle SSH connection for DUT {dut_id} (idle for {idle_time:.0f}s)")
                    to_remove.append(dut_id)

            for dut_id in to_remove:
                self._close_connection(dut_id)

            if to_remove:
                logger.info(f"Cleaned up {len(to_remove)} idle SSH connections")

    def get_pool_status(self) -> Dict:
        """
        Get current pool status for monitoring/debugging (Phase 2, 3 & 4 Enhanced).

        Returns:
            Dict with pool statistics including reconnection metadata, state history, and metrics
        """
        with self.pool_lock:
            current_time = time.time()
            connections = []

            # Phase 4: Aggregated metrics
            total_offline_events = 0
            total_reconnects = 0
            total_successful_reconnects = 0
            total_failed_reconnects = 0
            total_offline_duration = 0.0
            state_counts = {
                ConnectionState.ONLINE: 0,
                ConnectionState.OFFLINE: 0,
                ConnectionState.RECONNECTING: 0,
                ConnectionState.FAILED: 0,
                ConnectionState.DISCONNECTED: 0,
            }

            for dut_id, conn_data in self.pool.items():
                # Count states
                status = conn_data.get("status", ConnectionState.ONLINE)
                if status in state_counts:
                    state_counts[status] += 1

                conn_info = {
                    "dut_id": dut_id,
                    "ip": conn_data.get("ip"),
                    "port": conn_data.get("port"),
                    "username": conn_data.get("username"),
                    "status": status,
                    "created_at": conn_data.get("created_at"),
                    "last_used": conn_data.get("last_used"),
                    "idle_seconds": current_time - conn_data.get("last_used", current_time),
                    "age_seconds": current_time - conn_data.get("created_at", current_time),
                    # Phase 2: Reconnection metadata
                    "total_reconnects": conn_data.get("total_reconnects", 0),
                    "last_reconnect_time": conn_data.get("last_reconnect_time"),
                    "reconnect_in_progress": conn_data.get("reconnect_in_progress", False),
                    "is_terminal": conn_data.get("is_terminal", False),
                    # Phase 3: State tracking
                    "last_state_change": conn_data.get("last_state_change"),
                    "state_change_reason": conn_data.get("state_change_reason"),
                    "state_history_count": len(conn_data.get("state_history", [])),
                }

                # Calculate time since last reconnect if applicable
                if conn_info["last_reconnect_time"]:
                    conn_info["seconds_since_last_reconnect"] = (
                        current_time - conn_info["last_reconnect_time"]
                    )
                else:
                    conn_info["seconds_since_last_reconnect"] = None

                # Calculate time since last state change
                if conn_info["last_state_change"]:
                    conn_info["seconds_since_state_change"] = (
                        current_time - conn_info["last_state_change"]
                    )
                else:
                    conn_info["seconds_since_state_change"] = None

                # Phase 4: Add metrics if available
                metrics = conn_data.get("metrics")
                if metrics:
                    conn_info["metrics"] = metrics.to_dict()

                    # Aggregate metrics
                    total_offline_events += metrics.offline_events
                    total_reconnects += metrics.total_reconnects
                    total_successful_reconnects += metrics.successful_reconnects
                    total_failed_reconnects += metrics.failed_reconnects
                    total_offline_duration += metrics.offline_duration_total

                connections.append(conn_info)

            # Phase 4: Calculate aggregated metrics
            avg_offline_duration = (
                total_offline_duration / total_offline_events if total_offline_events > 0 else 0.0
            )
            overall_reconnect_success_rate = (
                (total_successful_reconnects / total_reconnects * 100) if total_reconnects > 0 else 0.0
            )

            return {
                "total_connections": len(self.pool),
                "state_summary": state_counts,
                "aggregated_metrics": {
                    "total_offline_events": total_offline_events,
                    "total_reconnects": total_reconnects,
                    "successful_reconnects": total_successful_reconnects,
                    "failed_reconnects": total_failed_reconnects,
                    "total_offline_duration": total_offline_duration,
                    "average_offline_duration": avg_offline_duration,
                    "overall_reconnect_success_rate": overall_reconnect_success_rate,
                },
                "connections": connections
            }

    def start_network_monitoring(
        self,
        check_interval: Optional[int] = None,
        probe_timeout: Optional[float] = None
    ) -> bool:
        """
        Start proactive network state monitoring (Phase 1 Enhancement, Phase 4 Config).

        Monitors network connectivity in background thread and automatically
        handles connection state changes when network goes offline/online.

        Args:
            check_interval: Seconds between connectivity checks (default: from config)
            probe_timeout: Timeout for each probe attempt in seconds (default: from config)

        Returns:
            True if monitoring started, False if already running
        """
        if not SSHPoolConfig.NETWORK_MONITOR_ENABLED:
            logger.info("Network monitoring is disabled via configuration")
            return False

        if self.network_monitor is not None:
            logger.warning("Network monitoring already running")
            return False

        # Use config defaults if not specified
        if check_interval is None:
            check_interval = SSHPoolConfig.NETWORK_MONITOR_INTERVAL
        if probe_timeout is None:
            probe_timeout = SSHPoolConfig.NETWORK_PROBE_TIMEOUT

        try:
            NetworkMonitor = _get_network_monitor_class()
            self.network_monitor = NetworkMonitor(
                check_interval=check_interval,
                probe_timeout=probe_timeout
            )

            # Register callback for state changes
            self.network_monitor.register_callback(self._on_network_state_change)

            # Start monitoring thread
            self.network_monitor.start_monitoring()

            logger.info(
                f"Network monitoring started: check_interval={check_interval}s, "
                f"probe_timeout={probe_timeout}s"
            )
            return True

        except Exception as e:
            logger.error(f"Failed to start network monitoring: {e}", exc_info=True)
            self.network_monitor = None
            return False

    def stop_network_monitoring(self) -> None:
        """
        Stop network monitoring thread.

        Called during application shutdown or when monitoring needs to be disabled.
        """
        if self.network_monitor is None:
            logger.debug("Network monitoring not running")
            return

        try:
            logger.info("Stopping network monitoring...")
            self.network_monitor.stop_monitoring()
            self.network_monitor = None
            logger.info("Network monitoring stopped")
        except Exception as e:
            logger.error(f"Error stopping network monitoring: {e}", exc_info=True)

    def _on_network_state_change(self, is_online: bool) -> None:
        """
        Callback invoked when network state changes.

        Args:
            is_online: True if network is now online, False if offline
        """
        self.network_online = is_online

        if not is_online:
            logger.warning("Network OFFLINE detected - marking all connections as OFFLINE")
            self._mark_all_connections_offline()
        else:
            logger.info("Network ONLINE detected - triggering auto-reconnect for offline connections")
            if self.auto_reconnect_enabled:
                self._reconnect_all_offline_connections()

    def _mark_all_connections_offline(self) -> None:
        """
        Mark all active connections as OFFLINE (network issue) - Phase 3 Enhanced.

        Connections are NOT closed - they're preserved for potential recovery.
        This prevents unnecessary reconnection overhead if network recovers quickly.

        Uses formal state machine transitions for validation.
        """
        offline_count = 0
        reconnecting_count = 0

        # Get list of DUTs to transition (need to release lock before calling _transition_connection_state)
        duts_to_transition = []

        with self.pool_lock:
            for dut_id, conn_data in self.pool.items():
                current_status = conn_data.get("status", ConnectionState.ONLINE)

                # Mark ONLINE and RECONNECTING connections as OFFLINE
                if current_status in [ConnectionState.ONLINE, ConnectionState.RECONNECTING]:
                    duts_to_transition.append((dut_id, current_status))

        # Perform transitions outside the lock (to avoid deadlock)
        for dut_id, current_status in duts_to_transition:
            success = self._set_connection_state(
                dut_id,
                ConnectionState.OFFLINE,
                "Network outage detected"
            )

            if success:
                # Record offline timestamp
                with self.pool_lock:
                    if dut_id in self.pool:
                        self.pool[dut_id]["offline_since"] = time.time()

                if current_status == ConnectionState.ONLINE:
                    offline_count += 1
                elif current_status == ConnectionState.RECONNECTING:
                    reconnecting_count += 1

        if offline_count > 0 or reconnecting_count > 0:
            logger.warning(
                f"Marked {offline_count} ONLINE and {reconnecting_count} RECONNECTING "
                f"connections as OFFLINE due to network outage"
            )

    def _reconnect_with_backoff(self, dut_id: int, max_attempts: int = 6, max_delay: int = 60) -> bool:
        """
        Reconnect with exponential backoff (Phase 2 Enhancement, Phase 3 State Machine).

        Implements intelligent retry logic with exponentially increasing delays
        to prevent server overload and give network time to stabilize.

        Retry Schedule:
          Attempt 0: Immediate (0 seconds)
          Attempt 1: 2 seconds
          Attempt 2: 4 seconds
          Attempt 3: 8 seconds
          Attempt 4: 16 seconds
          Attempt 5: 32 seconds
          Attempt 6+: 60 seconds (capped)

        Args:
            dut_id: Device ID to reconnect
            max_attempts: Maximum reconnection attempts (default: 6)
            max_delay: Maximum delay between attempts in seconds (default: 60)

        Returns:
            True if reconnection successful, False otherwise
        """
        # Get connection parameters from pool
        with self.pool_lock:
            if dut_id not in self.pool:
                logger.error(f"DUT {dut_id}: Not in pool, cannot reconnect")
                return False

            conn_data = self.pool[dut_id]

            # Check if reconnection already in progress
            if conn_data.get("reconnect_in_progress", False):
                logger.debug(f"DUT {dut_id}: Reconnection already in progress, skipping")
                return False

            # Mark reconnection in progress
            conn_data["reconnect_in_progress"] = True

            ip = conn_data.get("ip")
            port = conn_data.get("port")
            username = conn_data.get("username")
            password = conn_data.get("password")

        # Transition to RECONNECTING state (outside lock to avoid deadlock)
        self._set_connection_state(dut_id, ConnectionState.RECONNECTING, "Auto-reconnect triggered")

        # Validate connection parameters
        if not all([ip, port, username, password]):
            logger.error(f"DUT {dut_id}: Missing connection parameters for reconnect")
            with self.pool_lock:
                if dut_id in self.pool:
                    self.pool[dut_id]["reconnect_in_progress"] = False
            self._set_connection_state(dut_id, ConnectionState.FAILED, "Missing connection parameters")
            return False

        logger.info(
            f"DUT {dut_id}: Starting exponential backoff reconnection "
            f"(max_attempts={max_attempts}, target={ip}:{port})"
        )

        # Exponential backoff retry loop
        for attempt in range(max_attempts):
            # Calculate backoff delay
            if attempt == 0:
                delay = 0
            else:
                delay = min(2 ** attempt, max_delay)

            # Wait with backoff
            if delay > 0:
                logger.info(
                    f"DUT {dut_id}: Retry {attempt + 1}/{max_attempts} "
                    f"after {delay}s backoff"
                )
                time.sleep(delay)

            # Check if network is still offline (skip attempt if so)
            if not self.network_online:
                logger.debug(
                    f"DUT {dut_id}: Network still offline, skipping attempt {attempt + 1}"
                )
                continue

            # Check if connection was closed or removed during backoff
            with self.pool_lock:
                if dut_id not in self.pool:
                    logger.warning(
                        f"DUT {dut_id}: Removed from pool during reconnection"
                    )
                    return False

            # Attempt reconnection
            logger.info(f"DUT {dut_id}: Reconnection attempt {attempt + 1}/{max_attempts}")

            try:
                # Close existing dead connection if present
                with self.pool_lock:
                    if dut_id in self.pool:
                        old_conn = self.pool[dut_id].get("connection")
                        if old_conn:
                            try:
                                old_conn.disconnect()
                            except Exception:
                                pass

                # Create new connection using existing method
                SSHConnectionManager = _get_ssh_manager_class()
                ssh = SSHConnectionManager(ip, port, username, password)

                if ssh.connect():
                    # Connection successful - enable keepalive
                    try:
                        transport = ssh.client.get_transport()
                        if transport:
                            transport.set_keepalive(10)
                            sock = transport.sock
                            if sock:
                                sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                                if hasattr(socket, 'TCP_KEEPIDLE'):
                                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
                                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
                                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 6)
                    except Exception as e:
                        logger.warning(f"DUT {dut_id}: Failed to set keepalive after reconnect: {e}")

                    # Update pool with new connection
                    with self.pool_lock:
                        if dut_id in self.pool:
                            self.pool[dut_id]["connection"] = ssh
                            self.pool[dut_id]["last_used"] = time.time()
                            self.pool[dut_id]["reconnect_in_progress"] = False
                            self.pool[dut_id]["total_reconnects"] += 1
                            self.pool[dut_id]["last_reconnect_time"] = time.time()
                            self.pool[dut_id]["reconnect_thread"] = None
                            total_reconnects = self.pool[dut_id]["total_reconnects"]

                            # Phase 4: Record reconnection success in metrics
                            metrics = self.pool[dut_id].get("metrics")
                            if metrics:
                                metrics.record_reconnect_success()

                    # Transition to ONLINE state
                    self._set_connection_state(
                        dut_id,
                        ConnectionState.ONLINE,
                        f"Reconnection successful on attempt {attempt + 1}"
                    )

                    logger.info(
                        f"DUT {dut_id}: Reconnection successful on attempt {attempt + 1} "
                        f"(total reconnects: {total_reconnects})"
                    )
                    return True

                else:
                    logger.warning(f"DUT {dut_id}: Connection attempt {attempt + 1} failed")

            except Exception as e:
                logger.warning(
                    f"DUT {dut_id}: Reconnection attempt {attempt + 1} error: {e}"
                )

        # All attempts exhausted
        logger.error(
            f"DUT {dut_id}: Reconnection failed after {max_attempts} attempts "
            f"with exponential backoff"
        )

        with self.pool_lock:
            if dut_id in self.pool:
                self.pool[dut_id]["reconnect_in_progress"] = False
                self.pool[dut_id]["reconnect_thread"] = None

                # Phase 4: Record reconnection failure in metrics
                metrics = self.pool[dut_id].get("metrics")
                if metrics:
                    metrics.record_reconnect_failure()

        # Transition to FAILED state
        self._set_connection_state(
            dut_id,
            ConnectionState.FAILED,
            f"All {max_attempts} reconnection attempts exhausted"
        )

        return False

    def _reconnect_all_offline_connections(self) -> None:
        """
        Trigger reconnection for all OFFLINE connections (Phase 2 Enhancement, Phase 3 State Machine).

        Spawns background threads for each offline device with exponential
        backoff retry logic. Non-blocking - returns immediately.
        """
        offline_duts = []

        with self.pool_lock:
            for dut_id, conn_data in self.pool.items():
                status = conn_data.get("status")

                # Only reconnect truly offline connections (not already reconnecting)
                if status == ConnectionState.OFFLINE and not conn_data.get("reconnect_in_progress", False):
                    offline_duts.append(dut_id)

        if not offline_duts:
            logger.info("No offline connections to reconnect")
            return

        logger.info(
            f"Auto-reconnect triggered for {len(offline_duts)} offline devices: {offline_duts}"
        )

        # Spawn background reconnect threads (non-blocking)
        for dut_id in offline_duts:
            thread = threading.Thread(
                target=self._reconnect_with_backoff,
                args=(dut_id,),
                kwargs={
                    "max_attempts": SSHPoolConfig.RECONNECT_MAX_ATTEMPTS,
                    "max_delay": SSHPoolConfig.RECONNECT_MAX_DELAY
                },
                daemon=True,
                name=f"ssh-reconnect-dut-{dut_id}"
            )

            # Store thread reference in pool
            with self.pool_lock:
                if dut_id in self.pool:
                    self.pool[dut_id]["reconnect_thread"] = thread

            thread.start()
            logger.debug(f"DUT {dut_id}: Spawned background reconnect thread")

    def get_network_status(self) -> Dict:
        """
        Get current network monitoring status.

        Returns:
            Dictionary with network monitoring state and statistics
        """
        if self.network_monitor is None:
            return {
                "monitoring_enabled": False,
                "network_online": self.network_online,
                "auto_reconnect_enabled": self.auto_reconnect_enabled
            }

        stats = self.network_monitor.get_statistics()
        stats["auto_reconnect_enabled"] = self.auto_reconnect_enabled

        return stats

    def get_configuration(self) -> Dict:
        """
        Get current SSH pool configuration (Phase 4).

        Returns:
            Dictionary of all configuration values
        """
        return SSHPoolConfig.get_config_summary()

    def close_all(self):
        """Close all connections in pool. Use on application shutdown."""
        # Stop network monitoring first
        self.stop_network_monitoring()

        with self.pool_lock:
            logger.info(f"Closing all {len(self.pool)} SSH connections in pool")
            for dut_id in list(self.pool.keys()):
                self._close_connection(dut_id)
            logger.info("All SSH connections closed")


# Global singleton instance
ssh_pool = SSHConnectionPool()
