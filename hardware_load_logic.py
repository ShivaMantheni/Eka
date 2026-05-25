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
        stdout, stderr, code = telnet_mgr.execute_command("onie-stop", timeout=30, expect_prompt="#")
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

        # Send SCP command
        telnet_mgr.connection.write(scp_cmd.encode('ascii') + b"\n")
        await asyncio.sleep(2)

        # Wait for host key verification prompt OR password prompt (whichever comes first)
        # Actual ONIE dropbear SCP prompt: "Do you want to continue connecting? (y/n)"
        index, output = telnet_mgr.expect_pattern([
            b"y/n",              # index 0 - dropbear host key prompt: "Do you want to continue connecting? (y/n)"
            b"continue connecting",  # index 1 - alternate phrasing fallback
            b"password:",        # index 2 - password prompt (host already trusted)
        ], timeout=15)

        if index in (0, 1):
            # Host key verification prompt appeared - answer y
            append_job_log(db, job, "Host key not trusted - answering 'y' to continue...", passwords_to_redact)
            telnet_mgr.connection.write(b"y\n")
            await asyncio.sleep(1)
            # Now wait for the password prompt
            index2, output2 = telnet_mgr.expect_pattern([b"password:"], timeout=15)
            if index2 >= 0:
                telnet_mgr.connection.write(request.source_server_password.encode('ascii') + b"\n")
                append_job_log(db, job, "✓ Password sent for SCP", passwords_to_redact)
            else:
                append_job_log(db, job, "⚠ Password prompt not seen after host key acceptance", passwords_to_redact)
        elif index == 2:
            # No host key prompt - directly got password prompt (host already trusted)
            telnet_mgr.connection.write(request.source_server_password.encode('ascii') + b"\n")
            append_job_log(db, job, "✓ Password sent for SCP", passwords_to_redact)
        else:
            append_job_log(db, job, "⚠ Neither host key prompt nor password prompt seen within timeout", passwords_to_redact)

        # Monitor SCP progress
        append_job_log(db, job, f"Downloading {image_name} (this may take 5-20 minutes)...", passwords_to_redact)

        start_time = time.time()
        last_progress = 55
        last_log_time = time.time()

        while True:
            output = telnet_mgr.read_output(timeout=5)

            if output:
                # Only log every 10 seconds to avoid log spam
                if time.time() - last_log_time > 10:
                    append_job_log(db, job, output, passwords_to_redact)
                    last_log_time = time.time()

                # Parse progress from SCP output
                if "%" in output:
                    try:
                        # Look for percentage pattern like "45%"
                        match = re.search(r'(\d+)%', output)
                        if match:
                            percent = int(match.group(1))
                            # Map 0-100% SCP progress to 55-85% job progress
                            job_progress = 55 + int(percent * 0.3)
                            if job_progress > last_progress:
                                update_job_progress(db, job, "downloading", f"Downloading: {percent}%", job_progress)
                                last_progress = job_progress
                    except:
                        pass

            # Check if completed (look for prompt)
            if "ONIE:/ #" in output or "100%" in output:
                await asyncio.sleep(2)
                last_output = telnet_mgr.read_output(timeout=2)
                if "#" in last_output:
                    break

            # Timeout after 30 minutes
            if time.time() - start_time > 1800:
                raise Exception("SCP download timeout (30 minutes)")

            await asyncio.sleep(5)

        append_job_log(db, job, f"✓ Image downloaded successfully: {image_name}", passwords_to_redact)

        # Step 12: Install image with onie-nos-install (85%)
        update_job_progress(db, job, "installing", "Installing NOS image...", 85)
        install_cmd = f"onie-nos-install {image_name}"

        telnet_mgr.connection.write(install_cmd.encode('ascii') + b"\n")
        await asyncio.sleep(2)

        append_job_log(db, job, f"✓ Installation started: {install_cmd}", passwords_to_redact)

        # Monitor installation progress
        start_time = time.time()
        last_log_time = time.time()

        while True:
            output = telnet_mgr.read_output(timeout=5)

            if output:
                # Log every 10 seconds
                if time.time() - last_log_time > 10:
                    append_job_log(db, job, output, passwords_to_redact)
                    last_log_time = time.time()

                # Look for completion indicators
                if "Installed SONiC" in output or "Installation complete" in output or "Success" in output:
                    append_job_log(db, job, "✓ Installation completed successfully", passwords_to_redact)
                    break

                # Look for errors (but allow some expected messages)
                if ("failed" in output.lower() or "error" in output.lower()) and \
                   "Verifying image checksum" not in output:
                    # Log warning but don't fail immediately
                    append_job_log(db, job, f"⚠ Warning: {output}", passwords_to_redact)

            # Timeout after 20 minutes
            if time.time() - start_time > 1200:
                append_job_log(db, job, "⚠ Installation timeout - marking as completed", passwords_to_redact)
                break

            await asyncio.sleep(5)

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
