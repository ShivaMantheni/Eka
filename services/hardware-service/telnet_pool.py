"""
Telnet Connection Pool Manager

Provides centralized telnet connection management with:
- Single persistent connection per device (shared across heartbeat and hardware load)
- Automatic connection health monitoring
- Connection reuse for all tabs (Devices, Hardware Load)
- Thread-safe connection pool
- Automatic cleanup of idle/dead connections
"""

import threading
import time
import logging
from typing import Dict, Optional
from telnet_manager import TelnetConnectionManager

logger = logging.getLogger(__name__)


class TelnetPoolConfig:
    """Configuration for Telnet Connection Pool."""
    IDLE_TIMEOUT = 600  # 10 minutes (telnet sessions can be longer-lived)
    CLEANUP_INTERVAL = 180  # 3 minutes


class TelnetConnectionPool:
    """
    Singleton Telnet Connection Pool.

    Maintains one persistent telnet connection per device, shared across:
    - Device heartbeat operations
    - Hardware Load operations
    - Future telnet-based features

    Features:
    - Thread-safe with locks
    - Connection reuse
    - Automatic health checking
    - Idle connection cleanup (after 10 minutes)
    - Connection preservation during hardware load
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
                    logger.info("Telnet Connection Pool initialized")
        return cls._instance

    def get_connection(
        self,
        dut_id: int,
        ip: str,
        port: int,
        username: str,
        password: str,
        timeout: int = 30
    ) -> Optional[TelnetConnectionManager]:
        """
        Get or create telnet connection for a device.

        Returns:
            TelnetConnectionManager instance or None if connection unavailable
        """
        with self.pool_lock:
            # Check if connection exists in pool
            if dut_id in self.pool:
                conn_data = self.pool[dut_id]

                # Verify connection is still alive
                if conn_data["connection"].is_alive():
                    conn_data["last_used"] = time.time()
                    logger.debug(f"DUT {dut_id}: Reusing telnet connection")
                    return conn_data["connection"]
                else:
                    # Connection is dead, remove it
                    logger.warning(f"DUT {dut_id}: Connection dead, removing from pool")
                    self._close_connection(dut_id)

            # Create new connection
            logger.info(f"Creating new telnet connection for DUT {dut_id} ({username}@{ip}:{port})")
            telnet_mgr = TelnetConnectionManager()

            # Use longer login_timeout (15s) for slow devices
            if telnet_mgr.connect(ip, port, username, password, timeout=timeout, login_timeout=15):
                # Add to pool
                self.pool[dut_id] = {
                    "connection": telnet_mgr,
                    "last_used": time.time(),
                    "created_at": time.time(),
                    "ip": ip,
                    "port": port,
                    "username": username,
                    "password": password,  # Store for reconnection
                    "is_hardware_load": False,  # Hardware load session flag (excludes from cleanup)
                }
                logger.info(f"DUT {dut_id}: Added to telnet pool")
                return telnet_mgr
            else:
                logger.error(f"Failed to create telnet connection for DUT {dut_id}")
                return None

    def release_connection(self, dut_id: int):
        """
        Release connection back to pool (mark as available).

        Connection is NOT closed - it stays in pool for reuse.
        Just updates the last_used timestamp.
        """
        with self.pool_lock:
            if dut_id in self.pool:
                self.pool[dut_id]["last_used"] = time.time()
                logger.debug(f"Released telnet connection for DUT {dut_id} back to pool")

    def close_connection(self, dut_id: int):
        """
        Close and remove connection from pool.

        Use this when:
        - Device is deleted
        - Connection is permanently broken
        - Device credentials changed
        """
        with self.pool_lock:
            self._close_connection(dut_id)

    def _close_connection(self, dut_id: int):
        """Internal method to close connection (assumes lock is held)."""
        if dut_id in self.pool:
            try:
                self.pool[dut_id]["connection"].disconnect()
                logger.info(f"DUT {dut_id}: Closed telnet connection and removed from pool")
            except Exception as e:
                logger.warning(f"DUT {dut_id}: Error closing telnet connection: {e}")
            del self.pool[dut_id]

    def mark_connection_as_hardware_load(self, dut_id: int):
        """
        Mark connection as active hardware load session (excludes from idle cleanup).
        Called when Hardware Load job starts.
        """
        with self.pool_lock:
            if dut_id in self.pool:
                self.pool[dut_id]["is_hardware_load"] = True
                logger.info(f"Marked telnet connection for DUT {dut_id} as hardware load session")

    def unmark_connection_as_hardware_load(self, dut_id: int):
        """
        Unmark connection as hardware load session (allows normal idle cleanup).
        Called when Hardware Load job completes.
        """
        with self.pool_lock:
            if dut_id in self.pool:
                self.pool[dut_id]["is_hardware_load"] = False
                logger.info(f"Unmarked telnet connection for DUT {dut_id} from hardware load session")

    def is_hardware_load_active(self, dut_id: int) -> bool:
        """
        Check if device has an active hardware load session.
        Used by heartbeat to avoid interfering with hardware load operations.

        Returns:
            True if hardware load session is active, False otherwise
        """
        with self.pool_lock:
            if dut_id in self.pool:
                return self.pool[dut_id].get("is_hardware_load", False)
            return False

    def cleanup_idle(self, max_idle_seconds: int = None):
        """
        Close connections that have been idle for more than max_idle_seconds.

        Default: 600 seconds (10 minutes)

        Skips connections marked as hardware load sessions (kept alive until job completes).
        """
        if max_idle_seconds is None:
            max_idle_seconds = TelnetPoolConfig.IDLE_TIMEOUT

        with self.pool_lock:
            current_time = time.time()
            to_remove = []

            for dut_id, conn_data in self.pool.items():
                # Skip cleanup if this is an active hardware load session
                if conn_data.get("is_hardware_load", False):
                    logger.debug(f"Skipping cleanup for hardware load session DUT {dut_id}")
                    continue

                idle_time = current_time - conn_data["last_used"]
                if idle_time > max_idle_seconds:
                    logger.info(f"Closing idle telnet connection for DUT {dut_id} (idle for {idle_time:.0f}s)")
                    to_remove.append(dut_id)

            for dut_id in to_remove:
                self._close_connection(dut_id)

            if to_remove:
                logger.info(f"Cleaned up {len(to_remove)} idle telnet connections")

    def get_pool_status(self) -> Dict:
        """
        Get current pool status for monitoring/debugging.

        Returns:
            Dict with pool statistics
        """
        with self.pool_lock:
            current_time = time.time()
            connections = []

            for dut_id, conn_data in self.pool.items():
                conn_info = {
                    "dut_id": dut_id,
                    "ip": conn_data.get("ip"),
                    "port": conn_data.get("port"),
                    "username": conn_data.get("username"),
                    "created_at": conn_data.get("created_at"),
                    "last_used": conn_data.get("last_used"),
                    "idle_seconds": current_time - conn_data.get("last_used", current_time),
                    "age_seconds": current_time - conn_data.get("created_at", current_time),
                    "is_hardware_load": conn_data.get("is_hardware_load", False),
                    "is_alive": conn_data.get("connection").is_alive() if conn_data.get("connection") else False,
                }

                connections.append(conn_info)

            return {
                "total_connections": len(self.pool),
                "connections": connections
            }

    def close_all(self):
        """Close all connections in pool. Use on application shutdown."""
        with self.pool_lock:
            logger.info(f"Closing all {len(self.pool)} telnet connections in pool")
            for dut_id in list(self.pool.keys()):
                self._close_connection(dut_id)
            logger.info("All telnet connections closed")


# Global singleton instance
telnet_pool = TelnetConnectionPool()
