"""
Network State Monitor for SSH Connection Pool

Proactively monitors network connectivity and notifies SSH pool of state changes.
Uses lightweight DNS probes to detect network outages before SSH operations fail.
"""

import socket
import threading
import time
import logging
from typing import Callable, List, Tuple, Optional

logger = logging.getLogger(__name__)


class NetworkMonitor:
    """
    Background network state monitoring thread.

    Continuously checks network connectivity by probing DNS servers.
    Invokes callbacks when network state changes (online ↔ offline).

    Features:
    - Non-blocking background thread
    - Multiple probe targets with fallback
    - Configurable check interval
    - Thread-safe state management
    - Graceful shutdown support
    """

    # DNS probe targets (fallback list)
    PROBE_HOSTS: List[Tuple[str, int]] = [
        ("8.8.8.8", 53),          # Google DNS
        ("1.1.1.1", 53),          # Cloudflare DNS
        ("208.67.222.222", 53),   # OpenDNS
    ]

    def __init__(self, check_interval: int = 5, probe_timeout: float = 2.0):
        """
        Initialize network monitor.

        Args:
            check_interval: Seconds between connectivity checks (default: 5)
            probe_timeout: Timeout for each probe attempt in seconds (default: 2.0)
        """
        self.check_interval = check_interval
        self.probe_timeout = probe_timeout

        # State tracking
        self.network_online = True
        self.last_state = True
        self.state_change_count = 0
        self.last_state_change_time: Optional[float] = None

        # Thread management
        self.monitor_thread: Optional[threading.Thread] = None
        self.running = False
        self.shutdown_event = threading.Event()

        # Callback management
        self.callbacks: List[Callable[[bool], None]] = []
        self.callback_lock = threading.Lock()

        # Statistics
        self.total_checks = 0
        self.failed_checks = 0
        self.successful_checks = 0

        logger.info(
            f"NetworkMonitor initialized: check_interval={check_interval}s, "
            f"probe_timeout={probe_timeout}s"
        )

    def register_callback(self, callback: Callable[[bool], None]) -> None:
        """
        Register callback to be invoked on network state changes.

        Args:
            callback: Function that accepts bool (True=online, False=offline)
        """
        with self.callback_lock:
            if callback not in self.callbacks:
                self.callbacks.append(callback)
                logger.debug(f"Registered callback: {callback.__name__}")

    def unregister_callback(self, callback: Callable[[bool], None]) -> None:
        """
        Remove callback from notification list.

        Args:
            callback: Previously registered callback function
        """
        with self.callback_lock:
            if callback in self.callbacks:
                self.callbacks.remove(callback)
                logger.debug(f"Unregistered callback: {callback.__name__}")

    def _invoke_callbacks(self, is_online: bool) -> None:
        """
        Invoke all registered callbacks with current network state.

        Args:
            is_online: Current network state
        """
        with self.callback_lock:
            callbacks_copy = self.callbacks.copy()

        for callback in callbacks_copy:
            try:
                callback(is_online)
            except Exception as e:
                logger.error(
                    f"Callback {callback.__name__} raised exception: {e}",
                    exc_info=True
                )

    def _check_connectivity(self) -> bool:
        """
        Check network connectivity by probing DNS servers.

        Tries all probe hosts in sequence. If ANY succeeds, network is online.

        Returns:
            True if any probe succeeds, False if all fail
        """
        for host, port in self.PROBE_HOSTS:
            try:
                # Create socket with timeout
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(self.probe_timeout)

                # Attempt connection
                result = sock.connect_ex((host, port))
                sock.close()

                if result == 0:
                    # Connection successful
                    logger.debug(f"Probe successful: {host}:{port}")
                    return True
                else:
                    logger.debug(f"Probe failed: {host}:{port} (error code: {result})")

            except socket.timeout:
                logger.debug(f"Probe timeout: {host}:{port}")
            except socket.error as e:
                logger.debug(f"Probe error: {host}:{port} - {e}")
            except Exception as e:
                logger.warning(f"Unexpected probe error: {host}:{port} - {e}")

        # All probes failed
        return False

    def _monitor_loop(self) -> None:
        """
        Main monitoring loop - runs in background thread.

        Continuously checks network state and invokes callbacks on changes.
        """
        logger.info("Network monitoring loop started")

        while self.running and not self.shutdown_event.is_set():
            try:
                # Check network connectivity
                is_online = self._check_connectivity()
                self.total_checks += 1

                if is_online:
                    self.successful_checks += 1
                else:
                    self.failed_checks += 1

                # Update state
                self.network_online = is_online

                # Detect state change
                if is_online != self.last_state:
                    self.state_change_count += 1
                    self.last_state_change_time = time.time()

                    state_str = "ONLINE" if is_online else "OFFLINE"
                    prev_state_str = "OFFLINE" if is_online else "ONLINE"

                    logger.warning(
                        f"Network state changed: {prev_state_str} → {state_str} "
                        f"(change #{self.state_change_count})"
                    )

                    # Invoke callbacks
                    self._invoke_callbacks(is_online)

                    # Update last state
                    self.last_state = is_online

            except Exception as e:
                logger.error(f"Error in network monitor loop: {e}", exc_info=True)

            # Wait for next check (or shutdown signal)
            self.shutdown_event.wait(timeout=self.check_interval)

        logger.info("Network monitoring loop stopped")

    def start_monitoring(self) -> bool:
        """
        Start network monitoring in background thread.

        Returns:
            True if started successfully, False if already running
        """
        if self.running:
            logger.warning("Network monitor already running")
            return False

        self.running = True
        self.shutdown_event.clear()

        self.monitor_thread = threading.Thread(
            target=self._monitor_loop,
            name="NetworkMonitor",
            daemon=True
        )
        self.monitor_thread.start()

        logger.info("Network monitor thread started")
        return True

    def stop_monitoring(self) -> None:
        """
        Stop network monitoring thread gracefully.

        Waits for thread to finish (up to 10 seconds).
        """
        if not self.running:
            logger.debug("Network monitor not running")
            return

        logger.info("Stopping network monitor...")
        self.running = False
        self.shutdown_event.set()

        # Wait for thread to finish
        if self.monitor_thread and self.monitor_thread.is_alive():
            self.monitor_thread.join(timeout=10)

            if self.monitor_thread.is_alive():
                logger.warning("Network monitor thread did not stop gracefully")
            else:
                logger.info("Network monitor stopped successfully")

    def is_network_online(self) -> bool:
        """
        Get current network state (non-blocking).

        Returns:
            True if network is online, False otherwise
        """
        return self.network_online

    def get_statistics(self) -> dict:
        """
        Get monitoring statistics.

        Returns:
            Dictionary with monitoring metrics
        """
        return {
            "network_online": self.network_online,
            "total_checks": self.total_checks,
            "successful_checks": self.successful_checks,
            "failed_checks": self.failed_checks,
            "state_changes": self.state_change_count,
            "last_state_change": self.last_state_change_time,
            "callbacks_registered": len(self.callbacks),
            "is_monitoring": self.running
        }

    def __del__(self):
        """Cleanup on object destruction."""
        self.stop_monitoring()
