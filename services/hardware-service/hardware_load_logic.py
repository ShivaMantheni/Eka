"""
Hardware Load Execution Logic

This module contains the core 16-step automation logic for hardware loading
via ONIE (Open Network Install Environment).

Features:
- 16-step automated hardware load process
- GRUB menu navigation with intelligent ONIE detection
- Real-time progress tracking and logging
- Error handling with detailed diagnostics
- WebSocket progress streaming support

Usage:
    from hardware_load_logic import execute_hardware_load, navigate_to_onie_option

    # Execute full hardware load
    await execute_hardware_load(job_id, dut, request, db)
"""

import os
import time
import re
import asyncio
from datetime import datetime
from typing import Optional, Tuple
from sqlalchemy.orm import Session
import logging

from telnet_manager import TelnetConnectionManager
from telnet_pool import telnet_pool
from crypto_utils import sanitize_log

logger = logging.getLogger(__name__)


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def update_job_progress(
    db: Session,
    job,
    status: str,
    step: str,
    percentage: int
):
    """
    Update job progress in database

    Args:
        db: Database session
        job: HardwareLoadJob instance
        status: Job status (e.g., 'connecting', 'downloading')
        step: Human-readable step description
        percentage: Progress percentage (0-100)
    """
    job.status = status
    job.current_step = step
    job.progress_percentage = percentage
    db.commit()
    logger.info(f"Job {job.id}: {percentage}% - {step}")


def append_job_log(
    db: Session,
    job,
    message: str,
    passwords_to_redact: list = None
):
    """
    Append message to job execution log with sanitization

    Args:
        db: Database session
        job: HardwareLoadJob instance
        message: Log message to append
        passwords_to_redact: List of passwords to remove from logs
    """
    timestamp = datetime.now().strftime("%H:%M:%S")

    # Sanitize message
    if passwords_to_redact:
        message = sanitize_log(message, passwords_to_redact)

    log_entry = f"[{timestamp}] {message}\n"
    job.execution_log = (job.execution_log or "") + log_entry

    # Limit log size (prevent DB bloat) - keep last 1MB
    max_log_size = 1024 * 1024  # 1MB
    if len(job.execution_log) > max_log_size:
        job.execution_log = "... [earlier logs truncated] ...\n" + job.execution_log[-500000:]

    db.commit()
    logger.debug(f"Job {job.id}: {message[:100]}...")


def log_audit(
    db: Session,
    session_id: str,
    user_ip: str,
    action: str,
    resource_type: str,
    resource_id: int,
    details: dict = None
):
    """
    Log audit event for security tracking

    Args:
        db: Database session
        session_id: User session ID
        user_ip: User IP address
        action: Action performed (e.g., 'hardware_load_start')
        resource_type: Type of resource (e.g., 'HardwareLoadJob')
        resource_id: Resource ID
        details: Additional details as dictionary
    """
    import json
    from main import AuditLog

    audit = AuditLog(
        session_id=session_id,
        user_ip=user_ip,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=json.dumps(details) if details else None
    )

    db.add(audit)
    db.commit()
    logger.info(f"Audit: {action} on {resource_type}:{resource_id} by {session_id}")


# ============================================================================
# GRUB MENU NAVIGATION
# ============================================================================

async def navigate_to_onie_option(
    telnet_mgr: TelnetConnectionManager,
    job,
    db: Session
) -> bool:
    """
    Navigate GRUB menu to find and select ONIE option

    Strategy:
    1. Press Up arrow multiple times to go to top of menu
    2. Read menu content
    3. Count items and find ONIE position
    4. Navigate down to ONIE
    5. Press Enter

    Args:
        telnet_mgr: TelnetConnectionManager instance
        job: HardwareLoadJob instance
        db: Database session

    Returns:
        True if ONIE found and selected, False otherwise
    """
    try:
        append_job_log(db, job, "Scanning GRUB menu for ONIE option...")

        # Move to top of menu (press Up 20 times to ensure we're at top)
        for _ in range(20):
            telnet_mgr.send_keys("\x1b[A")  # Up arrow
            await asyncio.sleep(0.2)

        # Read current screen
        output = telnet_mgr.read_output(timeout=1)
        append_job_log(db, job, f"GRUB menu captured ({len(output)} chars)")

        # Look for ONIE in current view
        if "ONIE" in output:
            # Parse menu to find ONIE position
            lines = output.split('\n')
            onie_line_index = -1
            already_selected = False

            for i, line in enumerate(lines):
                if "ONIE" in line:
                    if line.strip().startswith("*") or "*ONIE" in line:
                        # Already selected!
                        append_job_log(db, job, "✓ ONIE option already selected")
                        already_selected = True
                        break
                    else:
                        # Found ONIE, but not selected
                        onie_line_index = i

            if already_selected:
                telnet_mgr.send_keys("\r")  # Press Enter
                return True

            if onie_line_index > 0:
                # Count how many menu items are above ONIE
                menu_items_above = 0
                for i in range(onie_line_index):
                    line = lines[i]
                    # Menu items typically start with spaces or asterisk
                    if re.match(r'^\s*[\*\s]\s*\w+', line):
                        menu_items_above += 1

                append_job_log(db, job, f"Found ONIE at menu position {menu_items_above + 1}")

                # Press Down arrow to reach ONIE
                for i in range(menu_items_above):
                    telnet_mgr.send_keys("\x1b[B")  # Down arrow
                    await asyncio.sleep(0.2)
                    append_job_log(db, job, f"  Navigating down ({i + 1}/{menu_items_above})...")

                # Verify ONIE is now selected
                await asyncio.sleep(0.5)
                output = telnet_mgr.read_output(timeout=1)
                if "*ONIE" in output or "* ONIE" in output:
                    append_job_log(db, job, "✓ ONIE option selected")
                    telnet_mgr.send_keys("\r")  # Press Enter
                    return True
                else:
                    append_job_log(db, job, "⚠ ONIE selection verification failed, pressing Enter anyway")
                    telnet_mgr.send_keys("\r")  # Press Enter anyway
                    return True

        # If ONIE not found in first screen, try scrolling down
        append_job_log(db, job, "ONIE not in first screen, searching...")
        for attempt in range(10):  # Try up to 10 items
            telnet_mgr.send_keys("\x1b[B")  # Down arrow
            await asyncio.sleep(0.3)
            output = telnet_mgr.read_output(timeout=0.5)

            if "*ONIE" in output or "* ONIE" in output:
                append_job_log(db, job, f"✓ ONIE option selected (attempt {attempt + 1})")
                telnet_mgr.send_keys("\r")  # Press Enter
                return True

        append_job_log(db, job, "✗ ONIE option not found in GRUB menu")
        return False

    except Exception as e:
        append_job_log(db, job, f"✗ Error navigating to ONIE: {str(e)}")
        logger.error(f"ONIE navigation error: {str(e)}", exc_info=True)
        return False


# ============================================================================
# MAIN HARDWARE LOAD EXECUTION
# ============================================================================

async def execute_hardware_load(
    job_id: int,
    dut,
    request,
    db: Session,
    passwords_to_redact: list = None
):
    """
    Execute hardware load operation with ONIE automation

    This is the main orchestration function that handles all 16 steps:
    1. Connect via telnet
    2. Login with credentials
    3. Save configuration
    4. Reboot device
    5. Wait for GRUB menu
    6. Navigate to ONIE option
    7. Press Enter to select ONIE
    8. Wait for ONIE submenu
    9. Select "ONIE: Install OS"
    10. Wait for ONIE prompt
    11. Stop ONIE discovery
    12. Add IP route to image server
    13. Download image via SCP
    14. Install image with onie-nos-install
    15. Monitor installation progress
    16. Mark job as completed

    Args:
        job_id: HardwareLoadJob ID
        dut: DUT object (target device)
        request: HardwareLoadRequest object
        db: Database session
        passwords_to_redact: List of passwords to sanitize from logs
    """
    from main import HardwareLoadJob

    job = db.query(HardwareLoadJob).filter(HardwareLoadJob.id == job_id).first()
    if not job:
        logger.error(f"Job {job_id} not found")
        return

    telnet_mgr = None

    # Collect passwords for sanitization
    if passwords_to_redact is None:
        passwords_to_redact = [
            dut.password,
            getattr(request, 'source_server_password', '')
        ]

    try:
        append_job_log(db, job, "=" * 60, passwords_to_redact)
        append_job_log(db, job, "HARDWARE LOAD STARTED", passwords_to_redact)
        append_job_log(db, job, f"Device: {dut.name} ({dut.ip_address}:{dut.port})", passwords_to_redact)
        append_job_log(db, job, f"Image: {job.image_name}", passwords_to_redact)
        append_job_log(db, job, "=" * 60, passwords_to_redact)

        # Step 1: Connect via telnet using connection pool (5%)
        update_job_progress(db, job, "connecting", "Connecting to device via telnet...", 5)

        # Mark this connection as hardware load session (prevents heartbeat interference)
        telnet_pool.mark_connection_as_hardware_load(dut.id)

        # Get or reuse connection from pool (increased timeout for slow devices)
        telnet_mgr = telnet_pool.get_connection(
            dut.id, dut.ip_address, dut.port, dut.username, dut.password, timeout=60
        )

        if not telnet_mgr or not telnet_mgr.is_alive():
            # Try one more time before failing
            telnet_pool.close_connection(dut.id)
            telnet_mgr = telnet_pool.get_connection(
                dut.id, dut.ip_address, dut.port, dut.username, dut.password, timeout=30
            )
            if not telnet_mgr or not telnet_mgr.is_alive():
                raise Exception(f"Failed to establish telnet connection to {dut.ip_address}:{dut.port}")

        append_job_log(db, job, f"✓ Connected to {dut.ip_address}:{dut.port} (using connection pool)", passwords_to_redact)

        # Step 2: Detect current device mode (10%)
        update_job_progress(db, job, "detecting_mode", "Detecting device mode...", 10)
        append_job_log(db, job, "Detecting current device mode...", passwords_to_redact)

        # Send a newline and use read_until("#") to capture the full prompt line.
        # This always returns the actual prompt string e.g. "ONIE:/ #" or "admin@sonic:~#"
        # so we can reliably detect the mode regardless of stale buffer state.
        mode_output = ""
        for attempt in range(3):
            telnet_mgr.connection.write(b"\n")
            try:
                raw = telnet_mgr.connection.read_until(b"#", timeout=8)
                mode_output = raw.decode("ascii", errors="ignore")
            except Exception:
                mode_output = telnet_mgr.read_output(timeout=5)
            append_job_log(db, job, f"Mode detect attempt {attempt+1}: {repr(mode_output[:120])}", passwords_to_redact)
            if mode_output.strip():
                break
            await asyncio.sleep(1)

        append_job_log(db, job, f"Current prompt output: {mode_output[:200]}", passwords_to_redact)

        # ONIE prompt looks like:  ONIE:/ #
        # SONiC prompt looks like: admin@sonic:~#  or  root@localhost:~#
        already_in_onie = "ONIE:" in mode_output

        if already_in_onie:
            append_job_log(db, job, f"Mode detected: ONIE — skipping reboot and GRUB navigation", passwords_to_redact)
            update_job_progress(db, job, "onie_loading", "Device already in ONIE Install Mode", 40)
        else:
            append_job_log(db, job, f"Mode detected: SONiC/OS — performing full reboot sequence", passwords_to_redact)
            # Device is in normal OS mode - perform full reboot sequence

            # Step 3: Save configuration (15%) - try with and without sudo
            update_job_progress(db, job, "saving_config", "Saving device configuration...", 15)
            stdout, stderr, code = telnet_mgr.execute_command("sudo config save -y 2>/dev/null || config save -y 2>/dev/null || true", timeout=60)
            append_job_log(db, job, f"✓ Configuration save attempted", passwords_to_redact)
            if stdout:
                append_job_log(db, job, stdout, passwords_to_redact)

            # Step 4: Reboot device (20%) - try with and without sudo
            update_job_progress(db, job, "rebooting", "Rebooting device...", 20)
            telnet_mgr.execute_command("sudo reboot 2>/dev/null || reboot", timeout=5)
            append_job_log(db, job, "✓ Reboot command sent", passwords_to_redact)

            # Wait for device to start rebooting
            await asyncio.sleep(10)

            # Step 5: Wait for GRUB menu (25%)
            update_job_progress(db, job, "grub_menu", "Waiting for GRUB menu...", 25)
            append_job_log(db, job, "Waiting for GRUB menu (timeout: 120s)...", passwords_to_redact)

            index, output = telnet_mgr.expect_pattern([
                b"GNU GRUB",
                b"SONiC-OS",
                b"GRUB"
            ], timeout=120)

            if index == -1:
                raise Exception("GRUB menu not detected within 120 seconds")

            append_job_log(db, job, "✓ GRUB menu detected", passwords_to_redact)

            # Send Escape key to stop auto-boot countdown
            telnet_mgr.send_keys("\x1b")
            await asyncio.sleep(0.5)

            # Step 6: Navigate to ONIE option (30%)
            update_job_progress(db, job, "grub_navigation", "Navigating to ONIE option...", 30)

            onie_found = await navigate_to_onie_option(telnet_mgr, job, db)
            if not onie_found:
                raise Exception("Failed to locate ONIE option in GRUB menu")

            # Step 7: Wait for ONIE submenu (35%)
            update_job_progress(db, job, "onie_menu", "Waiting for ONIE submenu...", 35)
            append_job_log(db, job, "Waiting for ONIE submenu...", passwords_to_redact)

            index, output = telnet_mgr.expect_pattern([
                b"ONIE: Install OS",
                b"ONIE: Rescue",
                b"ONIE"
            ], timeout=60)

            if index == -1:
                raise Exception("ONIE submenu not detected")

            append_job_log(db, job, "✓ ONIE submenu detected", passwords_to_redact)

            # Step 8: Select "ONIE: Install OS" (38%)
            update_job_progress(db, job, "onie_install_select", "Selecting ONIE: Install OS...", 38)
            telnet_mgr.send_keys("\r")  # Press Enter
            append_job_log(db, job, "✓ Selected ONIE: Install OS", passwords_to_redact)

            # Step 9: Wait for ONIE Install Mode prompt (40%)
            update_job_progress(db, job, "onie_loading", "Loading ONIE Install Mode...", 40)
            append_job_log(db, job, "Loading ONIE Install Mode (timeout: 300s)...", passwords_to_redact)

            index, output = telnet_mgr.expect_pattern([
                b"ONIE:/ #",
                b"ONIE: OS Install Mode"
            ], timeout=300)  # 5 minutes for ONIE to load

            if index == -1:
                raise Exception("ONIE Install Mode did not load within 300 seconds")

            append_job_log(db, job, "✓ ONIE Install Mode loaded", passwords_to_redact)

        # Step 9: Stop ONIE discovery (45%)
        update_job_progress(db, job, "onie_stop", "Stopping ONIE discovery...", 45)
        stdout, stderr, code = telnet_mgr.execute_command("onie-discovery-stop", timeout=30, expect_prompt="#")
        append_job_log(db, job, "✓ ONIE discovery stopped", passwords_to_redact)
        if stdout:
            append_job_log(db, job, stdout, passwords_to_redact)

        # Step 10: Add IP route to image server (50%)
        update_job_progress(db, job, "network_config", "Configuring network route...", 50)

        # Get current routes (before adding)
        append_job_log(db, job, "Getting current routing table...", passwords_to_redact)
        route_out, _, _ = telnet_mgr.execute_command("ip route", timeout=5, expect_prompt="#")
        append_job_log(db, job, f"Routes before:\n{route_out}", passwords_to_redact)

        # Add host route using -host flag (avoids subnet mismatch)
        # For host route (255.255.255.255), use: route add -host <ip> gw <gateway>
        # This works even when server is on same subnet but requires gateway routing
        if request.subnet_mask == '255.255.255.255':
            route_cmd = f"route add -host {request.source_server_ip} gw {request.gateway_ip}"
        else:
            route_cmd = f"route add -net {request.source_server_ip} netmask {request.subnet_mask} gw {request.gateway_ip}"

        append_job_log(db, job, f"Executing: {route_cmd}", passwords_to_redact)

        stdout, stderr, code = telnet_mgr.execute_command(route_cmd, timeout=10, expect_prompt="#")

        if stdout and stdout.strip():
            append_job_log(db, job, f"Route command output: {stdout}", passwords_to_redact)

        # Verify route was added
        route_out_after, _, _ = telnet_mgr.execute_command("ip route", timeout=5, expect_prompt="#")
        append_job_log(db, job, f"Routes after:\n{route_out_after}", passwords_to_redact)

        # Check if route was added successfully
        if request.source_server_ip in route_out_after:
            append_job_log(db, job, f"✓ Route added successfully for {request.source_server_ip}", passwords_to_redact)
        else:
            append_job_log(db, job, f"⚠ Route may not have been added (check output above)", passwords_to_redact)

        # Test connectivity to server with ping
        append_job_log(db, job, f"Testing connectivity to {request.source_server_ip}...", passwords_to_redact)
        ping_out, _, _ = telnet_mgr.execute_command(f"ping -c 3 {request.source_server_ip}", timeout=15, expect_prompt="#")

        if "0 packets received" in ping_out or "100% packet loss" in ping_out:
            append_job_log(db, job, f"✗ Ping FAILED - server {request.source_server_ip} unreachable!", passwords_to_redact)
            append_job_log(db, job, f"Ping output:\n{ping_out[:500]}", passwords_to_redact)
            raise Exception(f"Cannot reach image server {request.source_server_ip}. Check network, firewall, and server accessibility.")
        else:
            append_job_log(db, job, f"✓ Ping successful - server {request.source_server_ip} is reachable", passwords_to_redact)

        # Step 11: SCP image from server (55-85%)
        update_job_progress(db, job, "downloading", "Downloading image via SCP...", 55)
        image_name = os.path.basename(request.image_path)
        scp_cmd = f"scp {request.source_server_username}@{request.source_server_ip}:{request.image_path} ."

        append_job_log(db, job, f"Starting SCP download: {image_name}", passwords_to_redact)
        append_job_log(db, job, f"  Command: {scp_cmd}", passwords_to_redact)

        # Send SCP command
        telnet_mgr.connection.write(scp_cmd.encode('ascii') + b"\n")
        await asyncio.sleep(2)

        # ── SCP Authentication (ONIE dropbear — 3 scenarios) ─────────────────
        #
        # Confirmed format from device:
        #   Host '192.168.100.175' is not in the trusted hosts file.
        #   (ecdsa-sha2-nistp256 fingerprint md5 26:f7:bf:d3:e0:1d:...)
        #   Do you want to continue connecting? (y/n)
        #
        # THREE scenarios handled:
        #
        # Scenario A — (y/n) THEN password  [first time / not trusted]:
        #   ... fingerprint ... (y/n)   <- send "y"
        #   password:                   <- send password
        #   [SCP starts]
        #
        # Scenario B — password ONLY  [host already trusted]:
        #   password:                   <- send password
        #   [SCP starts]
        #
        # Scenario C — password THEN (y/n)  [some dropbear builds]:
        #   password:                   <- send password
        #   ... fingerprint ... (y/n)   <- send "y"
        #   [SCP starts]
        #
        # NOTE: expect_pattern() is BROKEN in telnetlib-313-and-up — returns
        # instantly with empty output. read_until_prompt() uses read_until()
        # which correctly blocks and accumulates all socket data.
        #
        # KEY: any data consumed during auth phase-2 (y/n check) is saved in
        # `scp_prefix` and prepended to the main SCP output for full progress.
        # ─────────────────────────────────────────────────────────────────────

        pwd_bytes  = request.source_server_password.encode('ascii') + b"\n"
        scp_prefix = ""   # data consumed during auth that may contain early SCP frames

        append_job_log(db, job, "Waiting for SCP authentication prompt...", passwords_to_redact)

        # ── Phase 1: Read up to 15s waiting for (y/n) ────────────────────────
        # ONIE host key format:
        #   Host '...' is not in the trusted hosts file.
        #   (ecdsa-sha2-nistp256 fingerprint md5 26:f7:...)
        #   Do you want to continue connecting? (y/n)      ← we look for this
        # If Scenario B/C (password first), read_until times out after 15s
        # and returns the password: prompt in the accumulated text.
        text1 = await asyncio.to_thread(
            telnet_mgr.read_until_prompt, "(y/n)", 15
        )
        # Normalize terminal line-wrap artefacts before logging:
        # ONIE echoes the SCP command with \r\r\n (double-CR + LF) at column ~80
        # because its telnet terminal wraps long lines. Strip those so the log
        # shows a single clean line instead of the garbled wrap sequence.
        text1_display = (
            text1
            .replace('\r\r\n', ' ')   # ONIE terminal line-wrap → single space
            .replace('\r\n',   ' ')   # normal CRLF
            .replace('\r',     ' ')   # bare CR
            .strip()
        )
        append_job_log(db, job,
            f"  Auth received: {text1_display[:250]}",
            passwords_to_redact)


        if "(y/n)" in text1:
            # ── Scenario A: fingerprint + (y/n) appeared first ────────────────
            append_job_log(db, job,
                "Scenario A: Host key prompt detected — sending 'y'",
                passwords_to_redact)
            telnet_mgr.connection.write(b"y\n")
            await asyncio.sleep(1)

            # Now wait for the password prompt
            text2 = await asyncio.to_thread(
                telnet_mgr.read_until_prompt, "password:", 15
            )
            append_job_log(db, job,
                f"  After 'y': {repr(text2[:80])}",
                passwords_to_redact)
            telnet_mgr.connection.write(pwd_bytes)
            append_job_log(db, job,
                "✓ Password sent (Scenario A: host key + password)",
                passwords_to_redact)

        elif "password:" in text1:
            # ── Scenario B or C: password prompt came first ───────────────────
            append_job_log(db, job,
                "Password prompt received first — sending password...",
                passwords_to_redact)
            telnet_mgr.connection.write(pwd_bytes)
            await asyncio.sleep(1)

            # Check if (y/n) appears within 3s (Scenario C).
            # Keep timeout SHORT (3s not 8s) to minimise consumed SCP data.
            text2 = await asyncio.to_thread(
                telnet_mgr.read_until_prompt, "(y/n)", 8
            )
            # Save whatever we consumed — may contain early SCP progress frames
            scp_prefix = text2

            if "(y/n)" in text2:
                # Scenario C: password → (y/n)
                append_job_log(db, job,
                    "Scenario C: (y/n) prompt after password — sending 'y'",
                    passwords_to_redact)
                telnet_mgr.connection.write(b"y\n")
                # Consume the 'y' echo + any response
                extra = await asyncio.to_thread(
                    telnet_mgr.read_until_prompt, "password:", 5
                )
                if "password:" in extra:
                    telnet_mgr.connection.write(pwd_bytes)
                    append_job_log(db, job,
                        "✓ Auth complete (Scenario C: password → y/n → password)",
                        passwords_to_redact)
                else:
                    append_job_log(db, job,
                        "✓ Auth complete (Scenario C: password + y/n answered)",
                        passwords_to_redact)
                scp_prefix += extra
            else:
                # Scenario B: password only, SCP already started
                append_job_log(db, job,
                    "✓ Password sent (Scenario B: host already trusted)",
                    passwords_to_redact)

        else:
            # ── Fallback: no prompt in 15s ────────────────────────────────────
            append_job_log(db, job,
                f"  No auth prompt in 15s (got: {repr(text1[:80])})",
                passwords_to_redact)
            append_job_log(db, job,
                "  Trying password prompt (20s)...",
                passwords_to_redact)
            text3 = await asyncio.to_thread(
                telnet_mgr.read_until_prompt, "password:", 20
            )
            telnet_mgr.connection.write(pwd_bytes)
            await asyncio.sleep(1)
            # Quick (y/n) check
            text4 = await asyncio.to_thread(
                telnet_mgr.read_until_prompt, "(y/n)", 8
            )
            scp_prefix = text3 + text4
            if "(y/n)" in text4:
                telnet_mgr.connection.write(b"y\n")
                append_job_log(db, job, "  Fallback: y/n answered", passwords_to_redact)
            append_job_log(db, job, "✓ Password sent (fallback)", passwords_to_redact)

        SCP_PROGRESS_RE = re.compile(
            r'(\d{1,3})%\s+([\d.]+\s*\w+)\s+([\d.]+\s*\w+/s)\s+([\d:]+)\s+ETA',
            re.IGNORECASE
        )

        append_job_log(db, job,
            f"Starting SCP transfer of {image_name} — this takes 3-10 minutes...",
            passwords_to_redact)

        scp_start    = time.time()
        MAX_SCP_WAIT = 1800          # 30-minute hard cap
        CHUNK_SECS   = 30            # read window per iteration
        last_logged_pct  = -1
        scp_output_all   = scp_prefix   # include any early SCP data from auth

        # ── Chunked download loop ─────────────────────────────────────────────
        # read_until_prompt blocks for up to CHUNK_SECS seconds OR until the
        # ONIE:/ # prompt appears — whichever comes first.
        # We parse whatever SCP progress frames arrived in that window, log them
        # immediately, then continue.  This gives real-time progress visibility
        # without a separate heartbeat task.
        # ─────────────────────────────────────────────────────────────────────
        while True:
            elapsed_total = time.time() - scp_start
            if elapsed_total > MAX_SCP_WAIT:
                raise Exception(
                    f"SCP timed out after {int(elapsed_total) // 60}m "
                    f"{int(elapsed_total) % 60}s — ONIE prompt never returned.\n"
                    f"Last output: {repr(scp_output_all[-300:])}"
                )

            # Block for up to CHUNK_SECS or until ONIE:/ # arrives
            chunk = await asyncio.to_thread(
                telnet_mgr.read_until_prompt, "ONIE:/ #", CHUNK_SECS
            )
            scp_output_all += chunk

            # ── Parse progress frames from this chunk ─────────────────────────
            frames = [
                f.strip()
                for f in chunk.replace('\r\n', '\n').split('\r')
                if f.strip()
            ]
            for frame in frames:
                # SCP error detection
                lower = frame.lower()
                if any(e in lower for e in [
                    "lost connection", "no such file", "no route to host",
                    "connection refused", "permission denied", "not a regular file",
                ]):
                    raise Exception(f"SCP failed: {frame[:250]}")

                # Progress line  e.g.  " 45% 120MB 5.9MB/s 02:30 ETA"
                m = SCP_PROGRESS_RE.search(frame)
                if m:
                    pct         = int(m.group(1))
                    transferred = m.group(2).strip()
                    speed       = m.group(3).strip()
                    eta         = m.group(4).strip()

                    # Log every 10% boundary (or 100% completion)
                    if pct >= last_logged_pct + 10 or pct == 100:
                        bar_filled = int(pct / 5)
                        bar        = '█' * bar_filled + '░' * (20 - bar_filled)
                        append_job_log(db, job,
                            f"  [{bar}] {pct:3d}%  |  {transferred}  |  {speed}  |  ETA {eta}",
                            passwords_to_redact)
                        last_logged_pct = pct

                        job_bar = min(55 + int(pct * 0.30), 85)
                        update_job_progress(db, job, "downloading",
                            f"Downloading {pct}% — {transferred} at {speed} — ETA {eta}",
                            job_bar)

            # ── Finished when the ONIE prompt is in this chunk ────────────────
            if "ONIE:/ #" in chunk:
                break

            # ── Periodic status line (replaces the old heartbeat task) ────────
            elapsed = int(time.time() - scp_start)
            m_e, s_e = elapsed // 60, elapsed % 60
            pct_str = f"{last_logged_pct}% done" if last_logged_pct >= 0 else "waiting for first frame"
            append_job_log(db, job,
                f"  ⏳ SCP in progress ({m_e}m {s_e}s elapsed) — {pct_str}",
                passwords_to_redact)
            update_job_progress(db, job, "downloading",
                f"Downloading — {m_e}m {s_e}s elapsed",
                min(56 + m_e * 3, 84))

        scp_elapsed = int(time.time() - scp_start)

        if "ONIE:/ #" not in scp_output_all:
            raise Exception(
                f"SCP loop exited without ONIE prompt after "
                f"{scp_elapsed // 60}m {scp_elapsed % 60}s.\n"
                f"Last output: {repr(scp_output_all[-300:])}"
            )

        append_job_log(db, job,
            f"✓ Image downloaded: {image_name} "
            f"(completed in {scp_elapsed // 60}m {scp_elapsed % 60}s)",
            passwords_to_redact)

        # Step 12: Install image with onie-nos-install (85%)
        update_job_progress(db, job, "installing", "Installing NOS image...", 85)
        install_cmd = f"onie-nos-install {image_name}"

        telnet_mgr.connection.write(install_cmd.encode('ascii') + b"\n")
        await asyncio.sleep(2)

        append_job_log(db, job, f"✓ Installation started: {install_cmd}", passwords_to_redact)
        append_job_log(db, job,
            "Monitoring installation — device will reboot when done (up to 20 min)...",
            passwords_to_redact)

        # onie-nos-install also produces no output for long stretches.
        # Use read_until_prompt with a reboot/completion marker.
        # After install, device reboots so connection drops (EOFError) —
        # read_until_prompt returns whatever was received before the drop.
        install_start = time.time()

        install_output = await asyncio.to_thread(
            telnet_mgr.read_until_prompt,
            "ONIE:/ #",   # may not appear if device reboots mid-install
            1200          # 20-minute timeout
        )

        install_elapsed = int(time.time() - install_start)

        # Log whatever install output we received
        if install_output:
            for line in install_output.replace('\r', '\n').splitlines():
                line = line.strip()
                if line and len(line) > 3:
                    append_job_log(db, job, f"  {line}", passwords_to_redact)

        completion_keywords = [
            "Installed SONiC", "Installation complete", "install complete",
            "Success", "Rebooting", "reboot", "ONIE: OS Install Mode"
        ]
        if any(kw.lower() in install_output.lower() for kw in completion_keywords):
            append_job_log(db, job,
                f"✓ Installation completed ({install_elapsed // 60}m {install_elapsed % 60}s) — device is rebooting",
                passwords_to_redact)
        else:
            append_job_log(db, job,
                f"⚠ Install monitor ended after {install_elapsed // 60}m {install_elapsed % 60}s — "
                "device may still be installing or rebooting",
                passwords_to_redact)


        # Step 13: Mark as completed (100%)
        update_job_progress(db, job, "completed", "Hardware load completed successfully", 100)
        job.completed_at = datetime.utcnow()
        db.commit()

        append_job_log(db, job, "=" * 60, passwords_to_redact)
        append_job_log(db, job, "✓✓✓ HARDWARE LOAD COMPLETED SUCCESSFULLY ✓✓✓", passwords_to_redact)
        append_job_log(db, job, "=" * 60, passwords_to_redact)

        logger.info(f"Hardware load job {job_id} completed successfully")

    except Exception as e:
        # Mark job as failed
        error_msg = str(e)
        logger.error(f"Hardware load job {job_id} failed: {error_msg}", exc_info=True)

        update_job_progress(db, job, "failed", f"Hardware load failed", job.progress_percentage)
        job.error_message = error_msg
        job.completed_at = datetime.utcnow()
        db.commit()

        append_job_log(db, job, f"\n✗ ERROR: {error_msg}", passwords_to_redact)
        append_job_log(db, job, "=" * 60, passwords_to_redact)
        append_job_log(db, job, "✗✗✗ HARDWARE LOAD FAILED ✗✗✗", passwords_to_redact)
        append_job_log(db, job, "=" * 60, passwords_to_redact)

    finally:
        # Always unmark hardware load flag (even if connection failed early)
        telnet_pool.unmark_connection_as_hardware_load(dut.id)

        # Close connection completely (not just release) to free resources
        if telnet_mgr:
            telnet_pool.close_connection(dut.id)
            append_job_log(db, job, "Telnet connection closed and removed from pool", passwords_to_redact)
