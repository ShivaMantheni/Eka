#!/usr/bin/env python3
"""Quick test for Opengear telnet connections"""
import sys
sys.path.insert(0, '/home/hp_test/Eka/framework/dut-automation')

from telnet_manager import TelnetConnectionManager
import logging

logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

def test_connection(ip, port, username, password):
    print(f"\n{'='*70}")
    print(f"Testing Opengear Telnet Connection")
    print(f"{'='*70}")
    print(f"Target: {ip}:{port}")
    print(f"Username: {username}")
    print(f"{'='*70}\n")
    
    mgr = TelnetConnectionManager()
    
    if mgr.connect(ip, port, username, password, timeout=30, login_timeout=20):
        print("\n✅ SUCCESS! Connection established")
        print(f"Connection is alive: {mgr.is_alive()}")
        print(f"Last output ({len(mgr.last_output)} chars):")
        print(f"{mgr.last_output[:500]}")
        
        # Try a test command
        print("\n--- Testing command execution ---")
        stdout, stderr, code = mgr.execute_command("echo 'TELNET_TEST_OK'", timeout=10)
        print(f"Exit code: {code}")
        print(f"Output: {stdout}")
        
        mgr.disconnect()
        return True
    else:
        print("\n❌ FAILED to establish connection")
        return False

if __name__ == "__main__":
    if len(sys.argv) >= 5:
        success = test_connection(sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4])
        sys.exit(0 if success else 1)
    else:
        print("Usage: python3 test_opengear_connection.py <opengear_ip> <port> <username> <password>")
        print("\nExample:")
        print("  python3 test_opengear_connection.py 192.168.100.100 8019 admin YourPassword@123")
        sys.exit(1)
