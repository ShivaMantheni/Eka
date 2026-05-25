#!/usr/bin/env python3
"""
Telnet Device Diagnostic Tool

Tests telnet connectivity to diagnose hardware load connection issues.
"""

import sys
import telnetlib
import time
import socket

def test_telnet_connection(ip, port, username, password, timeout=30):
    """
    Test telnet connection with detailed diagnostics

    Args:
        ip: Device IP address
        port: Telnet port
        username: Username for login
        password: Password for login
        timeout: Connection timeout
    """
    print("=" * 70)
    print("TELNET CONNECTION DIAGNOSTIC TEST")
    print("=" * 70)
    print(f"Target Device: {ip}:{port}")
    print(f"Username: {username}")
    print(f"Password: {'*' * len(password)}")
    print(f"Timeout: {timeout}s")
    print("=" * 70)
    print()

    # Step 1: TCP port check
    print("[1/5] Testing TCP port accessibility...")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        result = sock.connect_ex((ip, port))
        sock.close()

        if result == 0:
            print(f"    ✓ Port {port} is OPEN and accessible")
        else:
            print(f"    ✗ Port {port} is CLOSED or unreachable")
            print(f"    Error code: {result}")
            return False
    except Exception as e:
        print(f"    ✗ TCP connection failed: {e}")
        return False

    print()

    # Step 2: Telnet connection
    print("[2/5] Establishing telnet connection...")
    try:
        tn = telnetlib.Telnet(ip, port, timeout=timeout)
        print(f"    ✓ Telnet connection established")
    except Exception as e:
        print(f"    ✗ Telnet connection failed: {e}")
        return False

    print()

    # Step 3: Read initial output
    print("[3/5] Reading initial output (waiting 2 seconds)...")
    time.sleep(2)
    try:
        initial_output = tn.read_very_eager().decode('ascii', errors='ignore')
        print(f"    Received {len(initial_output)} characters")
        print()
        print("    --- Initial Output ---")
        print(initial_output if initial_output else "    (no output received)")
        print("    --- End Output ---")
        print()

        # Check if already at prompt
        if any(p in initial_output for p in ["$", "#", ">", "~", "admin@", "sonic"]):
            print("    ✓ Device appears to be at shell prompt already (no login needed)")
            print()

            # Try a simple command
            print("[4/5] Testing command execution...")
            tn.write(b"echo test\n")
            time.sleep(1)
            output = tn.read_very_eager().decode('ascii', errors='ignore')
            if "test" in output:
                print("    ✓ Command executed successfully")
            else:
                print("    ? Command output unclear")
            print()

            tn.close()
            print("[5/5] ✓ Connection test PASSED - device is accessible")
            print()
            print("=" * 70)
            print("DIAGNOSIS: Device is accessible and already at shell prompt.")
            print("Hardware load should work if credentials are correct.")
            print("=" * 70)
            return True

    except Exception as e:
        print(f"    Error reading output: {e}")
        initial_output = ""

    # Step 4: Wait for login prompt
    print("[4/5] Waiting for login prompt (15 seconds timeout)...")
    try:
        login_patterns = [
            b"login: ",
            b"Username: ",
            b"user: ",
            b"Login: ",
            b"login:",
            b"Username:",
        ]

        index, match, output = tn.expect(login_patterns, timeout=15)

        if index == -1:
            print("    ✗ No login prompt detected within 15 seconds")
            print()
            print("    Additional output received:")
            additional = tn.read_very_eager().decode('ascii', errors='ignore')
            print(additional if additional else "    (no additional output)")
            print()
            tn.close()

            print("=" * 70)
            print("DIAGNOSIS: Device is reachable but not sending login prompt.")
            print("Possible causes:")
            print("  - Device is stuck in boot/GRUB menu")
            print("  - Device console is frozen")
            print("  - Device is waiting for user input")
            print("  - Login prompt format is different")
            print("=" * 70)
            return False

        print(f"    ✓ Login prompt detected: {match.decode('ascii', errors='ignore')}")

        # Send username
        tn.write(username.encode('ascii') + b"\n")
        time.sleep(1)

    except Exception as e:
        print(f"    ✗ Login prompt wait failed: {e}")
        tn.close()
        return False

    print()

    # Step 5: Wait for password prompt and login
    print("[5/5] Completing login...")
    try:
        password_patterns = [
            b"Password: ",
            b"password: ",
            b"passwd: "
        ]

        index, match, output = tn.expect(password_patterns, timeout=10)

        if index == -1:
            print("    ✗ No password prompt detected")
            tn.close()
            return False

        print(f"    ✓ Password prompt detected")

        # Send password
        tn.write(password.encode('ascii') + b"\n")
        time.sleep(2)

        # Read final output
        final_output = tn.read_very_eager().decode('ascii', errors='ignore')
        print()
        print("    --- Login Output ---")
        print(final_output if final_output else "    (no output)")
        print("    --- End Output ---")

        # Check for shell prompt
        if any(p in final_output for p in ["$", "#", ">", "~"]):
            print()
            print("    ✓ Login successful - shell prompt detected")
            tn.close()

            print()
            print("=" * 70)
            print("✓✓✓ CONNECTION TEST PASSED ✓✓✓")
            print("Device is fully accessible and hardware load should work.")
            print("=" * 70)
            return True
        else:
            print()
            print("    ? Login status unclear - no clear shell prompt")
            tn.close()

            print()
            print("=" * 70)
            print("DIAGNOSIS: Login completed but shell prompt not clear.")
            print("Check credentials and device configuration.")
            print("=" * 70)
            return False

    except Exception as e:
        print(f"    ✗ Login failed: {e}")
        tn.close()
        return False


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python3 test_telnet_device.py <ip> <port> <username> <password>")
        print()
        print("Example:")
        print("  python3 test_telnet_device.py 192.168.100.100 8019 admin YourPassword@123")
        print()
        sys.exit(1)

    ip = sys.argv[1]
    port = int(sys.argv[2])
    username = sys.argv[3]
    password = sys.argv[4]

    success = test_telnet_connection(ip, port, username, password)

    sys.exit(0 if success else 1)
