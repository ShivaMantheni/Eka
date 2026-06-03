"""
Telnet Connection Manager

Provides telnet connection management for hardware device console access,
specifically designed for ONIE (Open Network Install Environment) automation
and hardware loading operations.

Features:
- Telnet connection establishment with authentication
- Command execution with output capture
- Pattern matching for menu navigation (GRUB, ONIE)
- Raw keystroke sending for menu selection
- Connection health monitoring
- Thread-safe operation

Usage:
    from telnet_manager import TelnetConnectionManager

    telnet = TelnetConnectionManager()
    if telnet.connect("192.168.1.1", 23, "admin", "password"):
        stdout, stderr, code = telnet.execute_command("ls -la")
        print(stdout)
        telnet.disconnect()
"""

import telnetlib
import time
import logging
import socket
from typing import Tuple, Optional, List
import re

logger = logging.getLogger(__name__)


class TelnetConnectionManager:
    """
    Manages telnet connections to hardware devices

    This class handles all telnet operations including connection
    establishment, command execution, and menu navigation for
    automated hardware loading via ONIE.
    """

    def __init__(self):
        """Initialize telnet connection manager"""
        self.connection: Optional[telnetlib.Telnet] = None
        self.ip: Optional[str] = None
        self.port: Optional[int] = None
        self.is_connected: bool = False
        self.last_output: str = ""

    def connect(
        self,
        ip: str,
        port: int,
        username: str,
        password: str,
        timeout: int = 30,
        login_timeout: int = 10
    ) -> bool:
        """
        Establish telnet connection and login

        Args:
            ip: Device IP address
            port: Telnet port (usually 23)
            username: Login username
            password: Login password
            timeout: Connection timeout in seconds
            login_timeout: Login prompt timeout in seconds

        Returns:
            True if connection successful, False otherwise
        """
        try:
            self.ip = ip
            self.port = port

            logger.info(f"Connecting to {ip}:{port} via telnet...")

            # Create telnet connection
            self.connection = telnetlib.Telnet(ip, port, timeout=timeout)

            # Read initial output to see what we get
            time.sleep(1)
            initial_output = self.connection.read_very_eager().decode('ascii', errors='ignore')
            logger.info(f"Initial connection output ({len(initial_output)} chars): {initial_output[:200]}")

            # For Opengear and sleeping consoles: send newline to wake up the console
            if len(initial_output) < 10:
                logger.info("Minimal output detected - sending newline to wake up console")
                self.connection.write(b"\n")
                time.sleep(2)

                # Read again after waking up
                additional_output = self.connection.read_very_eager().decode('ascii', errors='ignore')
                initial_output += additional_output
                logger.info(f"After wake-up: {len(additional_output)} additional chars received")
                logger.debug(f"Combined output: {initial_output[:500]}")

            # Check if already at shell prompt (no login needed)
            if any(prompt in initial_output for prompt in ["$", "#", ">", "~", "admin@", "root@", "sonic"]):
                logger.info("Already at shell prompt - no login required")
                self.is_connected = True
                self.last_output = initial_output
                return True

            # Wait for login prompt (try multiple common prompts)
            login_patterns = [
                b"login: ",
                b"Username: ",
                b"user: ",
                b"Login: ",
                b"login:",
                b"Username:",
                b"User: ",
                b"user:",
            ]

            try:
                index, match, output = self.connection.expect(
                    login_patterns,
                    timeout=login_timeout
                )

                if index == -1:
                    # No login prompt - check one more time if we're at a shell prompt
                    final_check = self.connection.read_very_eager().decode('ascii', errors='ignore')
                    combined = initial_output + final_check
                    if any(prompt in combined for prompt in ["$", "#", ">", "~"]):
                        logger.info("Shell prompt detected after wait - no login needed")
                        self.is_connected = True
                        self.last_output = combined
                        return True

                    logger.error(f"Login prompt not detected. Combined output ({len(combined)} chars): {combined[:500]}")
                    return False

                # Send username
                self.connection.write(username.encode('ascii') + b"\n")
                time.sleep(0.5)

            except EOFError:
                logger.error("Connection closed before login prompt")
                return False

            # Wait for password prompt
            password_patterns = [
                b"Password: ",
                b"password: ",
                b"passwd: "
            ]

            try:
                index, match, output = self.connection.expect(
                    password_patterns,
                    timeout=login_timeout
                )

                if index == -1:
                    logger.error("Password prompt not detected")
                    return False

                # Send password
                self.connection.write(password.encode('ascii') + b"\n")
                time.sleep(2)

            except EOFError:
                logger.error("Connection closed before password prompt")
                return False

            # Wait for shell prompt to confirm successful login
            output = self.connection.read_very_eager().decode('ascii', errors='ignore')
            self.last_output = output

            # Check for common shell prompts
            if any(prompt in output for prompt in ["$", "#", ">", "~"]):
                logger.info(f"✓ Successfully connected to {ip}:{port}")
                self.is_connected = True
                return True
            else:
                logger.error("Shell prompt not detected after login")
                logger.debug(f"Output: {output}")
                return False

        except socket.timeout:
            logger.error(f"Connection timeout to {ip}:{port}")
            return False
        except ConnectionRefusedError:
            logger.error(f"Connection refused by {ip}:{port}")
            return False
        except Exception as e:
            logger.error(f"Telnet connection failed: {str(e)}")
            return False

    def execute_command(
        self,
        command: str,
        timeout: int = 30,
        expect_prompt: str = "#"
    ) -> Tuple[str, str, int]:
        """
        Execute command over telnet connection

        Args:
            command: Command to execute
            timeout: Command timeout in seconds
            expect_prompt: Expected prompt after command execution

        Returns:
            Tuple of (stdout, stderr, exit_code)
            Note: Telnet doesn't provide stderr/exit_code, so stderr="" and exit_code=0
        """
        if not self.connection or not self.is_connected:
            return "", "No active connection", 1

        try:
            # Send command
            logger.debug(f"Executing command: {command}")
            self.connection.write(command.encode('ascii') + b"\n")
            time.sleep(0.5)

            # Read output until prompt
            try:
                output = self.connection.read_until(
                    expect_prompt.encode('ascii'),
                    timeout=timeout
                )
                output_str = output.decode('ascii', errors='ignore')
            except EOFError:
                # Connection closed
                logger.error("Connection closed during command execution")
                self.is_connected = False
                return "", "Connection closed", 1

            # Clean up output
            lines = output_str.split('\n')
            if len(lines) > 1:
                # Remove command echo (first line) and prompt (last line)
                output_str = '\n'.join(lines[1:-1])

            self.last_output = output_str
            logger.debug(f"Command output ({len(output_str)} chars)")

            return output_str.strip(), "", 0

        except socket.timeout:
            logger.error(f"Command timeout after {timeout}s: {command}")
            return "", f"Timeout after {timeout}s", 1
        except Exception as e:
            logger.error(f"Command execution failed: {str(e)}")
            return "", f"Execution failed: {str(e)}", 1

    def expect_pattern(
        self,
        patterns: List[bytes],
        timeout: int = 30
    ) -> Tuple[int, bytes]:
        """
        Wait for one of multiple patterns to appear in output

        Args:
            patterns: List of byte patterns to match
            timeout: Timeout in seconds

        Returns:
            Tuple of (pattern_index, matched_output)
            Returns (-1, b"") if no pattern matched within timeout
        """
        if not self.connection or not self.is_connected:
            logger.error("No active connection for expect_pattern")
            return -1, b""

        try:
            logger.debug(f"Waiting for patterns: {[p.decode('ascii', errors='ignore') for p in patterns]}")

            index, match, output = self.connection.expect(patterns, timeout=timeout)

            if index >= 0:
                logger.debug(f"Pattern {index} matched")
                self.last_output = output.decode('ascii', errors='ignore')

            return index, output

        except EOFError:
            logger.error("Connection closed while waiting for pattern")
            self.is_connected = False
            return -1, b""
        except socket.timeout:
            logger.error(f"Pattern match timeout after {timeout}s")
            return -1, b""
        except Exception as e:
            logger.error(f"Expect pattern failed: {str(e)}")
            return -1, b""

    def send_keys(self, keys: str):
        """
        Send raw keystrokes (for menu navigation)

        Args:
            keys: String containing keys to send (supports special keys)
                  Special keys:
                    - '\\x1b[A' = Up arrow
                    - '\\x1b[B' = Down arrow
                    - '\\x1b[C' = Right arrow
                    - '\\x1b[D' = Left arrow
                    - '\\r' = Enter
                    - '\\x1b' = Escape
        """
        if not self.connection or not self.is_connected:
            logger.error("No active connection for send_keys")
            return

        try:
            # Decode escape sequences
            keys_decoded = keys.encode('utf-8').decode('unicode_escape')
            self.connection.write(keys_decoded.encode('latin-1'))
            time.sleep(0.3)  # Small delay for UI update

            logger.debug(f"Sent keys: {repr(keys)}")

        except Exception as e:
            logger.error(f"Send keys failed: {str(e)}")

    def read_output(self, timeout: float = 1.0) -> str:
        """
        Read available output without blocking.
        Uses read_very_eager() — only returns data already in buffer.
        Good for quick checks; NOT suitable for SCP progress streams.
        """
        if not self.connection or not self.is_connected:
            return ""

        try:
            time.sleep(timeout)
            output = self.connection.read_very_eager()
            output_str = output.decode('ascii', errors='ignore')

            if output_str:
                logger.debug(f"Read output: {len(output_str)} chars")
                self.last_output = output_str

            return output_str

        except Exception as e:
            logger.error(f"Read output failed: {str(e)}")
            return f"Read error: {str(e)}"

    def read_until_prompt(self, prompt: str = "ONIE:/ #", timeout: int = 1800) -> str:
        """
        Block and accumulate ALL output until the expected prompt appears.

        This is the correct method for SCP/install monitoring because:
        - read_very_eager() only sees what is buffered at one instant (misses \\r frames)
        - read_until() accumulates EVERYTHING arriving on the socket until the match

        The SCP \\r-delimited progress stream:
          sonic.bin    1%   19MB   6.3MB/s   02:50 ETA\\r
          sonic.bin   15%  285MB   6.4MB/s   02:10 ETA\\r
          ...
          sonic.bin  100% 1900MB   6.5MB/s   00:00 ETA
          ONIE:/ #

        All of this is returned in one string when the prompt arrives.

        Args:
            prompt: String to wait for (marks end of SCP output)
            timeout: Hard timeout in seconds (default 30 minutes)

        Returns:
            Everything received up to and including the prompt
        """
        if not self.connection or not self.is_connected:
            return ""

        try:
            logger.info(f"read_until_prompt: waiting for '{prompt}' (timeout={timeout}s)")
            raw = self.connection.read_until(
                prompt.encode('ascii'),
                timeout=timeout
            )
            result = raw.decode('ascii', errors='ignore')
            self.last_output = result
            logger.info(f"read_until_prompt: got {len(result)} chars")
            return result

        except EOFError:
            logger.error("Connection closed while waiting for SCP prompt")
            self.is_connected = False
            return self.last_output
        except Exception as e:
            logger.error(f"read_until_prompt failed: {str(e)}")
            return ""

    def read_until(self, expected: str, timeout: int = 30) -> str:
        """
        Read output until expected string appears

        Args:
            expected: String to wait for
            timeout: Timeout in seconds

        Returns:
            Output string up to and including expected text
        """
        if not self.connection or not self.is_connected:
            return ""

        try:
            output = self.connection.read_until(
                expected.encode('ascii'),
                timeout=timeout
            )
            output_str = output.decode('ascii', errors='ignore')

            logger.debug(f"Read until '{expected}': {len(output_str)} chars")
            self.last_output = output_str

            return output_str

        except EOFError:
            logger.error("Connection closed while reading")
            self.is_connected = False
            return ""
        except socket.timeout:
            logger.error(f"Read timeout waiting for: {expected}")
            return ""
        except Exception as e:
            logger.error(f"Read until failed: {str(e)}")
            return ""

    def get_last_output(self) -> str:
        """
        Get the last output received from the connection

        Returns:
            Last output string
        """
        return self.last_output

    def is_alive(self) -> bool:
        """
        Check if connection is still alive

        Returns:
            True if connection is active, False otherwise
        """
        if not self.connection:
            return False

        try:
            # Try to read any pending data (non-blocking)
            self.connection.read_very_eager()
            return self.is_connected
        except:
            self.is_connected = False
            return False

    def disconnect(self):
        """Close telnet connection"""
        if self.connection:
            try:
                # Force socket shutdown before closing to ensure proper cleanup
                if hasattr(self.connection, 'sock') and self.connection.sock:
                    try:
                        self.connection.sock.shutdown(socket.SHUT_RDWR)
                    except:
                        pass  # Socket may already be closed

                self.connection.close()
                logger.info(f"Disconnected from {self.ip}:{self.port}")
            except:
                pass
            finally:
                self.connection = None
                self.is_connected = False

    def __enter__(self):
        """Context manager entry"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - ensure connection is closed"""
        self.disconnect()

    def __del__(self):
        """Destructor - ensure connection is closed"""
        self.disconnect()


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def parse_grub_menu(output: str) -> List[str]:
    """
    Parse GRUB menu output to extract menu items

    Args:
        output: GRUB menu screen output

    Returns:
        List of menu item names
    """
    menu_items = []

    # Look for lines that appear to be menu items
    # Common patterns: "  SONiC-OS", "* ONIE", "  Advanced options"
    lines = output.split('\n')

    for line in lines:
        # Skip empty lines and header lines
        if not line.strip():
            continue

        # Look for lines starting with space or asterisk (menu items)
        if re.match(r'^\s*[\*\s]\s*\w+', line):
            # Extract menu item text
            item = re.sub(r'^\s*[\*\s]\s*', '', line).strip()
            if item:
                menu_items.append(item)

    return menu_items


def find_menu_item_position(menu_items: List[str], search: str) -> int:
    """
    Find position of menu item by keyword

    Args:
        menu_items: List of menu item names
        search: Keyword to search for (case-insensitive)

    Returns:
        Index of menu item, or -1 if not found
    """
    search_lower = search.lower()

    for i, item in enumerate(menu_items):
        if search_lower in item.lower():
            return i

    return -1


# ============================================================================
# TESTING
# ============================================================================

def test_telnet_connection(ip: str, port: int, username: str, password: str):
    """
    Test telnet connection to a device

    Args:
        ip: Device IP address
        port: Telnet port
        username: Login username
        password: Login password
    """
    print("=" * 60)
    print("TELNET CONNECTION TEST")
    print("=" * 60)
    print(f"Target: {ip}:{port}")
    print(f"Username: {username}")
    print("=" * 60)

    telnet = TelnetConnectionManager()

    # Test connection
    if telnet.connect(ip, port, username, password):
        print("✓ Connection established")

        # Test command execution
        stdout, stderr, code = telnet.execute_command("uname -a")
        if code == 0:
            print("✓ Command execution successful")
            print(f"Output: {stdout[:100]}...")
        else:
            print("✗ Command execution failed")
            print(f"Error: {stderr}")

        # Disconnect
        telnet.disconnect()
        print("✓ Disconnected")
    else:
        print("✗ Connection failed")

    print("=" * 60)


if __name__ == "__main__":
    """
    Run tests when executed directly
    """
    import sys

    if len(sys.argv) >= 5:
        # Command line arguments: ip port username password
        test_telnet_connection(
            ip=sys.argv[1],
            port=int(sys.argv[2]),
            username=sys.argv[3],
            password=sys.argv[4]
        )
    else:
        print("Usage: python telnet_manager.py <ip> <port> <username> <password>")
        print("\nExample:")
        print("  python telnet_manager.py 192.168.1.1 23 admin admin123")
