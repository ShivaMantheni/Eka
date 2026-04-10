"""
Eka Automation — Network Test Execution Platform
=================================================
FastAPI + SQLite + Paramiko SSH + WebSocket Log Streaming
No Docker, Redis, or Celery required.
"""

from fastapi import (
    FastAPI, HTTPException, WebSocket, WebSocketDisconnect,
    Depends, File, UploadFile, Form, Request
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from contextlib import asynccontextmanager
import os
import re
import sys
import json
import hashlib
import shutil
import logging
import asyncio
import subprocess
import yaml
from datetime import datetime
from typing import List, Optional
from pathlib import Path
from threading import Thread, Lock
import urllib.request
import urllib.error
import zipfile
import io
import base64

import paramiko
from paramiko import AutoAddPolicy

# ============================================================================
# CONFIGURATION
# ============================================================================

BASE_DIR = Path(__file__).parent.resolve()
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = DATA_DIR / "logs"
IMAGES_DIR = DATA_DIR / "images"
SCRIPTS_DIR = DATA_DIR / "scripts"
DB_PATH = DATA_DIR / "dut_automation.db"

# VS (Virtual System) Management Paths (on the remote host)
VS_IMAGES_PATH = "/var/lib/libvirt/images/"
VS_XML_PATH = "/home/hp/prajwal/VMs"
VS_SOURCE_IMAGE = "/home/hp/anuradha_builds/target/sonic.img"

# SPyTest Integration Paths (on the remote host)
SPYTEST_BASE = "/home/hp_test/Eka/sonic-mgmt/spytest"
SPYTEST_TESTS_DIR = f"{SPYTEST_BASE}/tests"
SPYTEST_TESTBED_DIR = f"{SPYTEST_BASE}/testbeds"
SPYTEST_BIN = f"{SPYTEST_BASE}/bin/spytest"
# Virtual-environment paths — activate env so all spytest deps are available
SPYTEST_VENV = f"{SPYTEST_BASE}/spytest_venv"
SPYTEST_PYTHON = f"{SPYTEST_VENV}/bin/python"  # bypasses broken shebang

# Create necessary directories
LOGS_DIR.mkdir(parents=True, exist_ok=True)
IMAGES_DIR.mkdir(parents=True, exist_ok=True)
SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{DB_PATH}"

# ============================================================================
# DATABASE SETUP (SQLite)
# ============================================================================

engine = create_engine(DATABASE_URL, echo=False, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class DUT(Base):
    __tablename__ = "duts"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), unique=True, nullable=False)
    ip_address = Column(String(50), nullable=False)
    port = Column(Integer, default=22)
    device_type = Column(String(50), default="Linux")
    username = Column(String(100), default="admin")
    password = Column(String(255), default="")
    status = Column(String(20), default="offline")
    last_heartbeat = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DUTConfiguration(Base):
    __tablename__ = "dut_configurations"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_id = Column(Integer, nullable=False)
    static_ip = Column(String(50), nullable=True)
    image_path = Column(String(500), nullable=True)
    ssh_port = Column(Integer, default=22)
    extra_config = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Image(Base):
    __tablename__ = "images"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    version = Column(String(100), default="1.0")
    file_path = Column(String(500))
    checksum = Column(String(64))
    file_size = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class Script(Base):
    __tablename__ = "scripts"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    file_path = Column(String(500))
    yaml_content = Column(Text, nullable=True)
    parameters = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Execution(Base):
    __tablename__ = "executions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    script_id = Column(Integer, nullable=True)
    dut_ids = Column(String(500))
    image_id = Column(Integer, nullable=True)
    execution_type = Column(String(20), default="script")  # 'script' or 'image'
    status = Column(String(20), default="pending")
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ExecutionLog(Base):
    __tablename__ = "execution_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    execution_id = Column(Integer, nullable=False)
    dut_name = Column(String(100), default="SYSTEM")
    log_level = Column(String(20), default="INFO")
    message = Column(Text)
    timestamp = Column(DateTime, default=datetime.utcnow)


class DUTLock(Base):
    """Tracks DUT allocation state: AVAILABLE / ALLOCATED / IN_USE."""
    __tablename__ = "dut_locks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_id = Column(Integer, nullable=False, unique=True)
    status = Column(String(20), default="AVAILABLE")   # AVAILABLE | ALLOCATED | IN_USE
    job_id = Column(Integer, nullable=True)
    locked_since = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class TopologyConnection(Base):
    """Persists canvas DUT wiring (interface-to-interface connections)."""
    __tablename__ = "topology_connections"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_a_id = Column(Integer, nullable=False)
    intf_a = Column(String(50), default="Ethernet0")
    dut_b_id = Column(Integer, nullable=False)
    intf_b = Column(String(50), default="Ethernet0")
    created_at = Column(DateTime, default=datetime.utcnow)


# Create tables
Base.metadata.create_all(bind=engine)

# ============================================================================
# LOGGING
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOGS_DIR / "app.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("DUT-Automation")

# ============================================================================
# VS (VIRTUAL SYSTEM) MANAGER — PATH CONSTANTS
# ============================================================================

VS_SOURCE_IMAGE = "/home/hp/anuradha_build_imgs/target/sonic-vs.img"
VS_IMAGES_PATH = "/var/lib/libvirt/images/"
VS_XML_PATH = "/home/hp/prajwal/VMs"

# ============================================================================
# SSH CONNECTION MANAGER
# ============================================================================


class SSHConnectionManager:
    """Manages SSH connections to DUT devices."""

    def __init__(self, host: str, port: int = 22, username: str = "admin", password: str = ""):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.client = None

    def connect(self) -> bool:
        try:
            self.client = paramiko.SSHClient()
            self.client.set_missing_host_key_policy(AutoAddPolicy())
            self.client.connect(
                hostname=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                timeout=15,
                allow_agent=False,
                look_for_keys=False,
                banner_timeout=15,
                auth_timeout=15,
            )
            logger.info(f"SSH connected to {self.host}:{self.port} as {self.username}")
            return True
        except paramiko.AuthenticationException as e:
            logger.error(f"SSH authentication failed for {self.username}@{self.host}:{self.port} — {e}")
            return False
        except paramiko.SSHException as e:
            logger.error(f"SSH error connecting to {self.host}:{self.port} — {e}")
            return False
        except Exception as e:
            logger.error(f"SSH connection failed to {self.host}:{self.port} — {type(e).__name__}: {e}")
            return False

    def execute_command(self, command: str, timeout: int = 30) -> tuple:
        """Execute a command on the remote device. Returns (stdout, stderr, exit_code)."""
        if not self.client:
            raise Exception("Not connected to device")
        try:
            stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
            output = stdout.read().decode("utf-8", errors="ignore")
            error = stderr.read().decode("utf-8", errors="ignore")
            exit_code = stdout.channel.recv_exit_status()
            return output, error, exit_code
        except Exception as e:
            logger.error(f"Command execution failed on {self.host}: {e}")
            raise

    def transfer_file(self, local_path: str, remote_path: str) -> bool:
        """Transfer a file to the remote device via SFTP."""
        try:
            sftp = self.client.open_sftp()
            sftp.put(local_path, remote_path)
            sftp.close()
            logger.info(f"File transferred: {local_path} -> {remote_path}")
            return True
        except Exception as e:
            logger.error(f"File transfer failed: {e}")
            return False

    def disconnect(self):
        if self.client:
            self.client.close()
            logger.info(f"Disconnected from {self.host}")


# ============================================================================
# EXECUTION ENGINE (Background Tasks — replaces Celery)
# ============================================================================


def log_execution(db: Session, execution_id: int, dut_name: str, level: str, message: str):
    """Write an execution log entry to the database."""
    entry = ExecutionLog(
        execution_id=execution_id,
        dut_name=dut_name,
        log_level=level,
        message=message,
        timestamp=datetime.utcnow(),
    )
    db.add(entry)
    db.commit()
    logger.log(getattr(logging, level, logging.INFO), f"[Exec {execution_id}][{dut_name}] {message}")


def run_image_deployment(execution_id: int, dut_ids: List[int], image_id: int):
    """Deploy an image to one or more DUTs (runs in background thread)."""
    db = SessionLocal()
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        image = db.query(Image).filter(Image.id == image_id).first()
        duts = db.query(DUT).filter(DUT.id.in_(dut_ids)).all()

        if not execution or not image or not duts:
            logger.error(f"Invalid execution/image/duts for exec {execution_id}")
            return

        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"Starting image deployment to {len(duts)} device(s)")

        for dut in duts:
            try:
                log_execution(db, execution_id, dut.name, "INFO",
                              f"Connecting to {dut.ip_address}:{dut.port}...")

                ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
                if not ssh.connect():
                    log_execution(db, execution_id, dut.name, "ERROR",
                                  f"Failed to connect to {dut.name}")
                    dut.status = "offline"
                    db.commit()
                    continue

                try:
                    dut.status = "online"
                    db.commit()

                    # 1. Create staging directory
                    ssh.execute_command("mkdir -p /tmp/firmware")
                    log_execution(db, execution_id, dut.name, "INFO",
                                  "Created staging directory /tmp/firmware")

                    # 2. Transfer image file
                    remote_path = f"/tmp/firmware/{os.path.basename(image.file_path)}"
                    log_execution(db, execution_id, dut.name, "INFO",
                                  f"Transferring image to {remote_path}...")

                    if not ssh.transfer_file(image.file_path, remote_path):
                        log_execution(db, execution_id, dut.name, "ERROR",
                                      "Image transfer failed")
                        continue

                    log_execution(db, execution_id, dut.name, "INFO",
                                  "Image file transferred successfully")

                    # 3. Verify checksum
                    if image.checksum:
                        output, _, code = ssh.execute_command(f"sha256sum {remote_path}")
                        if code == 0:
                            remote_checksum = output.split()[0]
                            if remote_checksum == image.checksum:
                                log_execution(db, execution_id, dut.name, "INFO",
                                              "Checksum verified ✓")
                            else:
                                log_execution(db, execution_id, dut.name, "WARNING",
                                              f"Checksum mismatch: {remote_checksum[:16]}... != {image.checksum[:16]}...")

                    # 4. Assign static IP if configured
                    config = db.query(DUTConfiguration).filter(
                        DUTConfiguration.dut_id == dut.id
                    ).first()
                    if config and config.static_ip:
                        ip_cmd = f"ip addr add {config.static_ip} dev eth0 2>/dev/null || true"
                        ssh.execute_command(ip_cmd)
                        log_execution(db, execution_id, dut.name, "INFO",
                                      f"Static IP assigned: {config.static_ip}")

                    log_execution(db, execution_id, dut.name, "INFO",
                                  "✓ Image deployment completed successfully")

                finally:
                    ssh.disconnect()

            except Exception as e:
                log_execution(db, execution_id, dut.name, "ERROR", f"Deployment error: {str(e)}")

        execution.status = "completed"
        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds()
            )
        db.commit()
        log_execution(db, execution_id, "SYSTEM", "INFO", "Image deployment completed")

    except Exception as e:
        logger.error(f"Image deployment failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
        log_execution(db, execution_id, "SYSTEM", "ERROR", f"Deployment failed: {str(e)}")
    finally:
        db.close()


def run_script_execution(execution_id: int, script_id: int, dut_ids: List[int]):
    """Execute a script on one or more DUTs (runs in background thread)."""
    db = SessionLocal()
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        script = db.query(Script).filter(Script.id == script_id).first()
        duts = db.query(DUT).filter(DUT.id.in_(dut_ids)).all()

        if not execution or not script or not duts:
            logger.error(f"Invalid execution/script/duts for exec {execution_id}")
            return

        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"Starting script '{script.name}' on {len(duts)} device(s)")

        # Parse YAML script
        script_config = {}
        if script.yaml_content:
            try:
                script_config = yaml.safe_load(script.yaml_content) or {}
            except Exception as e:
                log_execution(db, execution_id, "SYSTEM", "ERROR",
                              f"Failed to parse YAML: {str(e)}")
                execution.status = "failed"
                execution.end_time = datetime.utcnow()
                db.commit()
                return

        test_cases = script_config.get("test_cases", [])
        results = {}

        for dut in duts:
            try:
                log_execution(db, execution_id, dut.name, "INFO",
                              f"Connecting to {dut.ip_address}:{dut.port}...")

                ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
                if not ssh.connect():
                    log_execution(db, execution_id, dut.name, "ERROR",
                                  f"Failed to connect to {dut.name}")
                    results[dut.name] = "CONNECTION_FAILED"
                    dut.status = "offline"
                    db.commit()
                    continue

                try:
                    dut.status = "online"
                    dut.last_heartbeat = datetime.utcnow()
                    db.commit()

                    all_passed = True

                    if test_cases:
                        for tc in test_cases:
                            tc_name = tc.get("name", "unnamed_test")
                            tc_timeout = tc.get("timeout", 30)
                            commands = tc.get("commands", [])

                            log_execution(db, execution_id, dut.name, "INFO",
                                          f"▶ Running test case: {tc_name}")

                            for cmd in commands:
                                log_execution(db, execution_id, dut.name, "INFO",
                                              f"  $ {cmd}")
                                try:
                                    output, error, exit_code = ssh.execute_command(
                                        cmd, timeout=tc_timeout
                                    )
                                    if output.strip():
                                        # Log each line (limit to 50 lines)
                                        lines = output.strip().split("\n")
                                        for line in lines[:50]:
                                            log_execution(db, execution_id, dut.name, "INFO",
                                                          f"    {line}")
                                        if len(lines) > 50:
                                            log_execution(db, execution_id, dut.name, "INFO",
                                                          f"    ... ({len(lines) - 50} more lines)")

                                    if error.strip():
                                        log_execution(db, execution_id, dut.name, "WARNING",
                                                      f"    stderr: {error.strip()[:200]}")

                                    if exit_code != 0:
                                        log_execution(db, execution_id, dut.name, "ERROR",
                                                      f"  ✗ Command failed with exit code {exit_code}")
                                        all_passed = False
                                    else:
                                        log_execution(db, execution_id, dut.name, "INFO",
                                                      f"  ✓ Command succeeded")

                                except Exception as cmd_err:
                                    log_execution(db, execution_id, dut.name, "ERROR",
                                                  f"  ✗ Command error: {str(cmd_err)}")
                                    all_passed = False

                            log_execution(db, execution_id, dut.name, "INFO",
                                          f"  Test case '{tc_name}' — {'PASSED' if all_passed else 'FAILED'}")
                    else:
                        # No test cases — just report device info
                        output, _, _ = ssh.execute_command("uname -a")
                        log_execution(db, execution_id, dut.name, "INFO",
                                      f"Device info: {output.strip()}")
                        output, _, _ = ssh.execute_command("ip addr show 2>/dev/null || ifconfig 2>/dev/null")
                        if output.strip():
                            for line in output.strip().split("\n")[:20]:
                                log_execution(db, execution_id, dut.name, "INFO",
                                              f"  {line}")

                    results[dut.name] = "PASSED" if all_passed else "FAILED"
                    status_msg = "✓ All tests passed" if all_passed else "✗ Some tests failed"
                    log_execution(db, execution_id, dut.name, "INFO", status_msg)

                finally:
                    ssh.disconnect()

            except Exception as e:
                results[dut.name] = "ERROR"
                log_execution(db, execution_id, dut.name, "ERROR", f"Execution error: {str(e)}")

        execution.status = "completed"
        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds()
            )
        db.commit()

        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"Execution completed. Results: {json.dumps(results)}")

    except Exception as e:
        logger.error(f"Script execution failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
        log_execution(db, execution_id, "SYSTEM", "ERROR", f"Execution failed: {str(e)}")
    finally:
        db.close()


# ============================================================================
# FASTAPI APPLICATION
# ============================================================================

app = FastAPI(title="Eka Automation", version="2.0.0",
              description="Eka Automation — Network Test Execution Platform for SpyTest / SONiC DUT Infrastructure")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files (the frontend)
static_dir = BASE_DIR / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ============================================================================
# FRONTEND — Serve the HTML dashboard
# ============================================================================

@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    """Serve the main HTML dashboard."""
    html_path = static_dir / "index.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>DUT Automation System</h1><p>Frontend not found. Place index.html in /static/</p>")


# ============================================================================
# API — DUT Management
# ============================================================================

@app.get("/api/duts")
def get_duts(db: Session = Depends(get_db)):
    """List all DUT devices."""
    duts = db.query(DUT).all()
    return [
        {
            "id": d.id,
            "name": d.name,
            "ip_address": d.ip_address,
            "port": d.port,
            "device_type": d.device_type,
            "username": d.username,
            "status": d.status,
            "last_heartbeat": d.last_heartbeat.isoformat() if d.last_heartbeat else None,
            "created_at": d.created_at.isoformat() if d.created_at else None,
        }
        for d in duts
    ]


@app.get("/api/duts/{dut_id}")
def get_dut(dut_id: int, db: Session = Depends(get_db)):
    """Get details for a specific DUT."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")
    config = db.query(DUTConfiguration).filter(DUTConfiguration.dut_id == dut_id).first()
    return {
        "id": dut.id,
        "name": dut.name,
        "ip_address": dut.ip_address,
        "port": dut.port,
        "device_type": dut.device_type,
        "username": dut.username,
        "status": dut.status,
        "static_ip": config.static_ip if config else None,
        "image_path": config.image_path if config else None,
    }


@app.post("/api/duts")
def create_dut(dut_data: dict, db: Session = Depends(get_db)):
    """Create a new DUT device."""
    try:
        dut = DUT(
            name=dut_data["name"],
            ip_address=dut_data["ip_address"],
            port=dut_data.get("port", 22),
            device_type=dut_data.get("device_type", "Linux"),
            username=dut_data.get("username", "admin"),
            password=dut_data.get("password", ""),
        )
        db.add(dut)
        db.commit()
        db.refresh(dut)

        config = DUTConfiguration(
            dut_id=dut.id,
            static_ip=dut_data.get("static_ip"),
            image_path=dut_data.get("image_path"),
        )
        db.add(config)
        db.commit()

        return {"id": dut.id, "name": dut.name, "status": "created"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/duts/{dut_id}")
def update_dut(dut_id: int, dut_data: dict, db: Session = Depends(get_db)):
    """Update a DUT device."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")
    try:
        for key in ["name", "ip_address", "port", "device_type", "username", "password"]:
            if key in dut_data:
                setattr(dut, key, dut_data[key])
        dut.updated_at = datetime.utcnow()
        db.commit()
        return {"id": dut.id, "name": dut.name, "status": "updated"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/duts/{dut_id}")
def delete_dut(dut_id: int, db: Session = Depends(get_db)):
    """Delete a DUT device and all related records."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")
    try:
        # Delete related configuration
        db.query(DUTConfiguration).filter(DUTConfiguration.dut_id == dut_id).delete()
        # Delete the DUT
        db.delete(dut)
        db.commit()
        logger.info(f"Deleted DUT: {dut.name} (id={dut_id})")
        return {"status": "deleted", "name": dut.name}
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to delete DUT {dut_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete: {str(e)}")


@app.post("/api/duts/{dut_id}/ping")
def ping_dut(dut_id: int, db: Session = Depends(get_db)):
    """Test SSH connectivity to a DUT."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    # First try a simple TCP/ping check
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        result = sock.connect_ex((dut.ip_address, dut.port))
        sock.close()
        port_open = (result == 0)
    except Exception:
        port_open = False

    if not port_open:
        dut.status = "offline"
        db.commit()
        raise HTTPException(status_code=503, detail=f"{dut.name} — port {dut.port} not reachable at {dut.ip_address}")

    # Port is open, try SSH
    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if ssh.connect():
        try:
            output, _, _ = ssh.execute_command("uname -a")
            dut.status = "online"
            dut.last_heartbeat = datetime.utcnow()
            db.commit()
            return {
                "status": "online",
                "message": f"{dut.name} is reachable",
                "device_info": output.strip(),
            }
        finally:
            ssh.disconnect()
    else:
        # Port is open but SSH auth failed
        dut.status = "offline"
        db.commit()
        raise HTTPException(
            status_code=503,
            detail=f"{dut.name} — SSH login failed for user '{dut.username}' at {dut.ip_address}:{dut.port}. Check username/password."
        )


def _parse_sonic_interfaces(output: str) -> list:
    """Parse the output of 'show interfaces status' from a SONiC device.
    Returns a list of dicts: {name, speed, mtu, fec, alias, oper, admin}.
    Falls back to extracting just names if the table format is unexpected.
    """
    interfaces = []
    lines = output.strip().splitlines()
    # Skip header/separator lines (start with '-' or 'Interface')
    for line in lines:
        line = line.strip()
        if not line or line.startswith('-') or line.lower().startswith('interface'):
            continue
        parts = line.split()
        if not parts:
            continue
        name = parts[0]
        # Must look like an Ethernet/Management interface
        if not re.match(r'^(Ethernet|Management|eth|PortChannel|Loopback)', name, re.IGNORECASE):
            continue
        intf = {"name": name}
        # Parse columns: Interface Lanes Speed MTU FEC Alias Vlan Oper Admin Type Asym_PFC
        if len(parts) >= 9:
            intf["speed"]  = parts[2]
            intf["mtu"]    = parts[3]
            intf["fec"]    = parts[4]
            intf["alias"]  = parts[5]
            intf["oper"]   = parts[7]
            intf["admin"]  = parts[8]
        elif len(parts) >= 3:
            intf["speed"] = parts[2]
            intf["oper"]  = parts[-2] if len(parts) >= 4 else "N/A"
            intf["admin"] = parts[-1]
        interfaces.append(intf)
    return interfaces


def _parse_linux_interfaces(output: str) -> list:
    """Fallback: parse 'ip link show' output to extract interface names."""
    interfaces = []
    for line in output.splitlines():
        m = re.match(r'^\d+:\s+(\S+?)(?:@\S+)?:\s+', line)
        if m:
            name = m.group(1)
            if name not in ('lo',):
                state = 'up' if 'state UP' in line else 'down'
                interfaces.append({"name": name, "oper": state, "admin": state})
    return interfaces


@app.get("/api/duts/{dut_id}/interfaces")
def get_dut_interfaces(dut_id: int, db: Session = Depends(get_db)):
    """SSH into a DUT and discover its interfaces via 'show interfaces status'.
    Only applies to network devices (DUT, Switch, Router) — not VMs or other types."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    # Only fetch interfaces for actual network devices, not VMs
    if dut.device_type not in ["DUT", "Switch", "Router"]:
        raise HTTPException(
            status_code=400,
            detail=f"Interface fetching not supported for device type '{dut.device_type}'. Only available for DUT, Switch, and Router types."
        )

    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot SSH into {dut.name}")

    try:
        # Try SONiC command first
        output, err, code = ssh.execute_command("show interfaces status", timeout=20)
        interfaces = _parse_sonic_interfaces(output) if output.strip() else []

        # If that gave nothing, fall back to 'ip link show'
        if not interfaces:
            output2, _, _ = ssh.execute_command("ip link show", timeout=15)
            interfaces = _parse_linux_interfaces(output2)

        logger.info(f"Fetched {len(interfaces)} interfaces from {dut.name} (type: {dut.device_type})")
        return {
            "dut_id": dut_id,
            "dut_name": dut.name,
            "device_type": dut.device_type,
            "interfaces": interfaces,
            "count": len(interfaces),
        }
    finally:
        ssh.disconnect()


@app.post("/api/duts/{dut_id}/execute")
def execute_command_on_dut(dut_id: int, body: dict, db: Session = Depends(get_db)):
    """Execute an ad-hoc command on a DUT and return the output."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    command = body.get("command", "")
    if not command:
        raise HTTPException(status_code=400, detail="No command provided")

    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")

    try:
        output, error, exit_code = ssh.execute_command(command, timeout=body.get("timeout", 30))
        return {
            "stdout": output,
            "stderr": error,
            "exit_code": exit_code,
            "dut_name": dut.name,
        }
    finally:
        ssh.disconnect()


# ============================================================================
# API — Image Management
# ============================================================================

@app.get("/api/images")
def get_images(db: Session = Depends(get_db)):
    """List all uploaded images."""
    images = db.query(Image).all()
    return [
        {
            "id": img.id,
            "name": img.name,
            "version": img.version,
            "checksum": img.checksum,
            "file_size": img.file_size,
            "created_at": img.created_at.isoformat() if img.created_at else None,
        }
        for img in images
    ]


@app.post("/api/images")
async def upload_image(
    file: UploadFile = File(...),
    name: str = Form(""),
    version: str = Form("1.0"),
    db: Session = Depends(get_db),
):
    """Upload a new firmware image."""
    try:
        if not name:
            name = file.filename or f"image_{datetime.utcnow().timestamp()}"

        filename = f"{name}_{version}_{int(datetime.utcnow().timestamp())}{Path(file.filename).suffix}"
        file_path = str(IMAGES_DIR / filename)

        content = await file.read()
        with open(file_path, "wb") as f:
            f.write(content)

        sha256_hash = hashlib.sha256(content).hexdigest()

        image = Image(
            name=name,
            version=version,
            file_path=file_path,
            checksum=sha256_hash,
            file_size=len(content),
        )
        db.add(image)
        db.commit()
        db.refresh(image)

        return {
            "id": image.id,
            "name": image.name,
            "version": image.version,
            "checksum": sha256_hash,
            "file_size": len(content),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/images/{image_id}")
def delete_image(image_id: int, db: Session = Depends(get_db)):
    """Delete an image."""
    image = db.query(Image).filter(Image.id == image_id).first()
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")
    if image.file_path and os.path.exists(image.file_path):
        os.remove(image.file_path)
    db.delete(image)
    db.commit()
    return {"status": "deleted", "name": image.name}


# ============================================================================
# API — Script Management
# ============================================================================

@app.get("/api/scripts")
def get_scripts(db: Session = Depends(get_db)):
    """List all scripts."""
    scripts = db.query(Script).all()
    return [
        {
            "id": s.id,
            "name": s.name,
            "file_path": s.file_path,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in scripts
    ]


@app.post("/api/scripts")
async def upload_script(
    file: UploadFile = File(...),
    name: str = Form(""),
    db: Session = Depends(get_db),
):
    """Upload a YAML test script."""
    try:
        if not name:
            name = Path(file.filename).stem if file.filename else f"script_{int(datetime.utcnow().timestamp())}"

        filename = f"{name}.yaml"
        file_path = str(SCRIPTS_DIR / filename)

        content = await file.read()
        content_str = content.decode("utf-8", errors="ignore")

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content_str)

        # Validate YAML
        try:
            yaml.safe_load(content_str)
        except yaml.YAMLError as ye:
            raise HTTPException(status_code=400, detail=f"Invalid YAML: {str(ye)}")

        script = Script(
            name=name,
            file_path=file_path,
            yaml_content=content_str,
        )
        db.add(script)
        db.commit()
        db.refresh(script)

        return {"id": script.id, "name": script.name, "status": "uploaded"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/scripts/local")
def get_local_scripts(db: Session = Depends(get_db)):
    """Auto-load YAML scripts from data/scripts/ and return the list."""
    # Auto-sync: load any new YAML files from disk into the database
    for yaml_file in SCRIPTS_DIR.glob("*.yaml"):
        script_name = yaml_file.stem
        content = yaml_file.read_text(encoding="utf-8")
        existing = db.query(Script).filter(Script.name == script_name).first()
        if existing:
            existing.yaml_content = content
            existing.updated_at = datetime.utcnow()
        else:
            script = Script(name=script_name, file_path=str(yaml_file), yaml_content=content)
            db.add(script)
    db.commit()

    # Return all scripts
    scripts = db.query(Script).all()
    result = []
    for s in scripts:
        # Parse YAML to get metadata
        meta = {}
        if s.yaml_content:
            try:
                parsed = yaml.safe_load(s.yaml_content) or {}
                meta = {
                    "description": parsed.get("description", ""),
                    "test_case_count": len(parsed.get("test_cases", [])),
                }
            except Exception:
                pass
        result.append({
            "id": s.id,
            "name": s.name,
            "file_path": s.file_path,
            "description": meta.get("description", ""),
            "test_case_count": meta.get("test_case_count", 0),
            "created_at": s.created_at.isoformat() if s.created_at else None,
        })
    return result


@app.get("/api/scripts/{script_id}")
def get_script_detail(script_id: int, db: Session = Depends(get_db)):
    """Get script details including YAML content."""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script:
        raise HTTPException(status_code=404, detail="Script not found")
    return {
        "id": script.id,
        "name": script.name,
        "yaml_content": script.yaml_content,
        "file_path": script.file_path,
    }


@app.delete("/api/scripts/{script_id}")
def delete_script(script_id: int, db: Session = Depends(get_db)):
    """Delete a script."""
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script:
        raise HTTPException(status_code=404, detail="Script not found")
    if script.file_path and os.path.exists(script.file_path):
        os.remove(script.file_path)
    db.delete(script)
    db.commit()
    return {"status": "deleted", "name": script.name}


@app.post("/api/scripts/load-local")
def load_local_scripts(db: Session = Depends(get_db)):
    """Load all YAML scripts from the data/scripts directory."""
    count = 0
    for yaml_file in SCRIPTS_DIR.glob("*.yaml"):
        script_name = yaml_file.stem
        content = yaml_file.read_text(encoding="utf-8")
        existing = db.query(Script).filter(Script.name == script_name).first()
        if existing:
            existing.yaml_content = content
            existing.updated_at = datetime.utcnow()
        else:
            script = Script(name=script_name, file_path=str(yaml_file), yaml_content=content)
            db.add(script)
        count += 1
    db.commit()
    return {"loaded": count, "message": f"{count} scripts loaded from {SCRIPTS_DIR}"}


# ============================================================================
# API — Execution Management
# ============================================================================

@app.post("/api/executions")
def create_execution(execution_data: dict, db: Session = Depends(get_db)):
    """Create and start a new execution (image deployment or script execution)."""
    try:
        dut_ids = execution_data.get("dut_ids", [])
        script_id = execution_data.get("script_id")
        image_id = execution_data.get("image_id")

        if not dut_ids:
            raise HTTPException(status_code=400, detail="No DUT IDs provided")

        # Validate DUTs exist
        duts = db.query(DUT).filter(DUT.id.in_(dut_ids)).all()
        if len(duts) != len(dut_ids):
            raise HTTPException(status_code=400, detail="One or more DUTs not found")

        exec_type = "image" if image_id else "script"
        execution = Execution(
            name=f"exec_{exec_type}_{int(datetime.utcnow().timestamp())}",
            script_id=script_id,
            image_id=image_id,
            dut_ids=json.dumps(dut_ids),
            execution_type=exec_type,
            status="pending",
        )
        db.add(execution)
        db.commit()
        db.refresh(execution)

        # Run in background thread
        if image_id:
            thread = Thread(
                target=run_image_deployment,
                args=(execution.id, dut_ids, image_id),
                daemon=True,
            )
        elif script_id:
            thread = Thread(
                target=run_script_execution,
                args=(execution.id, script_id, dut_ids),
                daemon=True,
            )
        else:
            raise HTTPException(status_code=400, detail="Either script_id or image_id required")

        thread.start()

        return {
            "execution_id": execution.id,
            "status": "started",
            "type": exec_type,
            "dut_count": len(dut_ids),
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/executions")
def get_executions(db: Session = Depends(get_db)):
    """List all executions."""
    executions = db.query(Execution).order_by(Execution.created_at.desc()).all()
    return [
        {
            "id": ex.id,
            "name": ex.name,
            "type": ex.execution_type,
            "status": ex.status,
            "dut_count": len(json.loads(ex.dut_ids)) if ex.dut_ids else 0,
            "duration": ex.duration_seconds,
            "created_at": ex.created_at.isoformat() if ex.created_at else None,
        }
        for ex in executions
    ]


@app.get("/api/executions/{execution_id}")
def get_execution(execution_id: int, db: Session = Depends(get_db)):
    """Get execution details."""
    execution = db.query(Execution).filter(Execution.id == execution_id).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    return {
        "id": execution.id,
        "name": execution.name,
        "type": execution.execution_type,
        "status": execution.status,
        "dut_ids": json.loads(execution.dut_ids) if execution.dut_ids else [],
        "script_id": execution.script_id,
        "image_id": execution.image_id,
        "duration": execution.duration_seconds,
        "start_time": execution.start_time.isoformat() if execution.start_time else None,
        "end_time": execution.end_time.isoformat() if execution.end_time else None,
    }


@app.get("/api/executions/{execution_id}/logs")
def get_execution_logs(
    execution_id: int,
    limit: int = 200,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    """Get execution logs (paginated)."""
    logs = (
        db.query(ExecutionLog)
        .filter(ExecutionLog.execution_id == execution_id)
        .order_by(ExecutionLog.timestamp.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [
        {
            "id": log.id,
            "dut_name": log.dut_name,
            "level": log.log_level,
            "message": log.message,
            "timestamp": log.timestamp.isoformat() if log.timestamp else None,
        }
        for log in logs
    ]


# ============================================================================
# WEBSOCKET — Real-time Log Streaming
# ============================================================================

@app.websocket("/ws/execution/{execution_id}")
async def websocket_logs(websocket: WebSocket, execution_id: int):
    """WebSocket endpoint for real-time log streaming."""
    await websocket.accept()
    db = SessionLocal()

    try:
        last_log_id = 0

        while True:
            new_logs = (
                db.query(ExecutionLog)
                .filter(
                    ExecutionLog.execution_id == execution_id,
                    ExecutionLog.id > last_log_id,
                )
                .order_by(ExecutionLog.timestamp.asc())
                .all()
            )

            for log in new_logs:
                await websocket.send_json(
                    {
                        "id": log.id,
                        "dut_name": log.dut_name,
                        "level": log.log_level,
                        "message": log.message,
                        "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                    }
                )
                last_log_id = log.id

            # Check if execution has finished
            execution = db.query(Execution).filter(Execution.id == execution_id).first()
            if execution and execution.status in ["completed", "failed"]:
                # Send any remaining logs
                db.expire_all()
                remaining = (
                    db.query(ExecutionLog)
                    .filter(
                        ExecutionLog.execution_id == execution_id,
                        ExecutionLog.id > last_log_id,
                    )
                    .order_by(ExecutionLog.timestamp.asc())
                    .all()
                )
                for log in remaining:
                    await websocket.send_json(
                        {
                            "id": log.id,
                            "dut_name": log.dut_name,
                            "level": log.log_level,
                            "message": log.message,
                            "timestamp": log.timestamp.isoformat() if log.timestamp else None,
                        }
                    )

                await websocket.send_json(
                    {
                        "type": "execution_complete",
                        "status": execution.status,
                        "duration": execution.duration_seconds,
                    }
                )
                break

            db.expire_all()
            await asyncio.sleep(0.5)

    except WebSocketDisconnect:
        logger.info(f"WebSocket client disconnected from execution {execution_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        db.close()


# ============================================================================
# API — VS (Virtual System) Lifecycle Management
# ============================================================================


@app.get("/api/vs/list/{dut_id}")
def list_vms(dut_id: int, db: Session = Depends(get_db)):
    """List all VMs on a DUT host via 'virsh list --all'."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")

    try:
        # Use password with sudo if available (for devices that require it)
        # The -S flag makes sudo read password from stdin
        if dut.password:
            # Escape single quotes in password
            safe_pass = dut.password.replace("'", "'\\''")
            cmd = f"echo '{safe_pass}' | sudo -S virsh list --all"
        else:
            cmd = "sudo virsh list --all"

        output, error, exit_code = ssh.execute_command(cmd, timeout=30)
        if exit_code != 0:
            raise HTTPException(status_code=500, detail=f"virsh list failed: {error.strip()}")

        vms = []
        lines = output.strip().split("\n")
        for line in lines[2:]:  # Skip header lines
            parts = line.strip().split()
            if len(parts) >= 2:
                vm_id = parts[0] if parts[0] != "-" else None
                vm_name = parts[1]
                vm_state = " ".join(parts[2:]) if len(parts) > 2 else "unknown"
                vms.append({
                    "id": vm_id,
                    "name": vm_name,
                    "state": vm_state,
                })
        return {"dut_id": dut_id, "dut_name": dut.name, "vms": vms}
    except paramiko.SSHException as e:
        logger.error(f"SSH error listing VMs on {dut.name}: {e}")
        raise HTTPException(status_code=503, detail=f"SSH timeout or connection error: {str(e)}")
    except Exception as e:
        logger.error(f"Error listing VMs on {dut.name}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list VMs: {str(e)}")
    finally:
        ssh.disconnect()


@app.get("/api/vs/xml-files/{dut_id}")
def list_xml_files(dut_id: int, db: Session = Depends(get_db)):
    """List available VM XML definition files on the remote host."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")

    try:
        output, error, exit_code = ssh.execute_command(
            f"ls -1 {VS_XML_PATH}/*.xml 2>/dev/null", timeout=10
        )
        if exit_code != 0 and not output.strip():
            return {"dut_id": dut_id, "xml_files": [], "xml_path": VS_XML_PATH}

        xml_files = []
        for line in output.strip().split("\n"):
            line = line.strip()
            if line.endswith(".xml"):
                xml_files.append({
                    "full_path": line,
                    "filename": os.path.basename(line),
                })
        return {"dut_id": dut_id, "xml_files": xml_files, "xml_path": VS_XML_PATH}
    finally:
        ssh.disconnect()


@app.post("/api/vs/update-image")
def update_vs_image(body: dict, db: Session = Depends(get_db)):
    """
    Full VS image update lifecycle:
    virsh destroy → rm old image → cp new image → virsh undefine → virsh define → virsh start
    """
    dut_id = body.get("dut_id")
    vs_name = body.get("vs_name", "").strip()
    source_image = body.get("source_image_path", VS_SOURCE_IMAGE).strip()
    target_image_name = body.get("target_image_name", "").strip()

    if not dut_id or not vs_name:
        raise HTTPException(status_code=400, detail="dut_id and vs_name are required")

    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    # If no target image name given, use the VS name as the image file name
    if not target_image_name:
        target_image_name = f"{vs_name}.img"

    # Auto-derive XML path from VS name
    xml_full_path = f"{VS_XML_PATH}/{vs_name}.xml"
    target_image_path = f"{VS_IMAGES_PATH}{target_image_name}"

    # Create an execution record for logging
    execution = Execution(
        name=f"vs_update_{vs_name}_{int(datetime.utcnow().timestamp())}",
        execution_type="image",
        dut_ids=json.dumps([dut_id]),
        status="pending",
    )
    db.add(execution)
    db.commit()
    db.refresh(execution)

    # Run in background thread
    thread = Thread(
        target=_run_vs_update,
        args=(execution.id, dut, vs_name, xml_full_path, source_image, target_image_path),
        daemon=True,
    )
    thread.start()

    return {
        "execution_id": execution.id,
        "status": "started",
        "vs_name": vs_name,
        "message": f"VS image update started for '{vs_name}' on {dut.name}",
    }


@app.post("/api/vs/update-image-batch")
def update_vs_image_batch(body: dict, db: Session = Depends(get_db)):
    """
    Batch VS image update: update multiple VMs sequentially.
    Accepts per-VM target image names via vs_entries list.
    Body: dut_id, vs_entries=[{vs_name, target_image_name}, ...], source_image_path
    Also supports legacy vs_names list for backward compatibility.
    """
    dut_id = body.get("dut_id")
    source_image = body.get("source_image_path", VS_SOURCE_IMAGE).strip()

    # Support both new vs_entries and legacy vs_names
    vs_entries = body.get("vs_entries")
    if not vs_entries:
        vs_names = body.get("vs_names", [])
        target_image_name_global = body.get("target_image_name", "").strip()
        vs_entries = [
            {"vs_name": n, "target_image_name": target_image_name_global}
            for n in vs_names
        ]

    if not dut_id or not vs_entries:
        raise HTTPException(status_code=400, detail="dut_id and vs_entries (or vs_names) are required")

    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    # Create a single execution record for the entire batch
    execution = Execution(
        name=f"vs_batch_{len(vs_entries)}vms_{int(datetime.utcnow().timestamp())}",
        execution_type="image",
        dut_ids=json.dumps([dut_id]),
        status="pending",
    )
    db.add(execution)
    db.commit()
    db.refresh(execution)

    # Run in background thread
    thread = Thread(
        target=_run_vs_batch_update,
        args=(execution.id, dut, vs_entries, source_image),
        daemon=True,
    )
    thread.start()

    vm_names = [e.get("vs_name", "") for e in vs_entries]
    return {
        "execution_id": execution.id,
        "status": "started",
        "vs_count": len(vs_entries),
        "vs_names": vm_names,
        "message": f"VS batch update started for {len(vs_entries)} VM(s) on {dut.name}",
    }


def _run_vs_batch_update(
    execution_id: int,
    dut,
    vs_entries: list,   # [{vs_name, target_image_name}, ...]
    source_image: str,
):
    """Background thread: Process multiple VMs sequentially with per-VM target images."""
    db = SessionLocal()
    execution = None
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        total = len(vs_entries)
        vm_names = [e.get("vs_name", "") for e in vs_entries]
        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"═══ Batch VS update: {total} VM(s) ═══")
        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"  VMs: {', '.join(vm_names)}")
        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"  Source image: {source_image}")

        # Connect via SSH once for the entire batch
        ssh_user = dut.username   # e.g. hp
        ssh_host = dut.ip_address
        ssh_port = dut.port
        ssh_pass = dut.password

        log_execution(db, execution_id, dut.name, "INFO",
                      f"  Connecting: ssh {ssh_user}@{ssh_host}:{ssh_port}")

        ssh = SSHConnectionManager(ssh_host, ssh_port, ssh_user, ssh_pass)
        if not ssh.connect():
            log_execution(db, execution_id, dut.name, "ERROR",
                          f"SSH connection FAILED: {ssh_user}@{ssh_host}:{ssh_port}")
            log_execution(db, execution_id, dut.name, "ERROR",
                          "  Check: username, password, and SSH access on host device")
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
            return

        log_execution(db, execution_id, dut.name, "INFO",
                      f"  SSH connected: {ssh_user}@{ssh_host}:{ssh_port}")

        # Helper: prepend sudo -S with password for commands needing root
        def sudocmd(cmd: str) -> str:
            # Use echo password | sudo -S so sudo doesn't wait for interactive input
            safe_pass = ssh_pass.replace("'", "'\\''")   # escape single quotes
            return f"echo '{safe_pass}' | sudo -S {cmd}"

        try:
            all_success = True
            for idx, entry in enumerate(vs_entries, 1):
                vs_name = entry.get("vs_name", "").strip()
                per_vm_target = entry.get("target_image_name", "").strip()
                if not vs_name:
                    continue

                # Determine target image name for this VM
                this_target_name = per_vm_target if per_vm_target else f"{vs_name}.img"

                # Images directory on the remote host
                IMAGES_DIR = "/var/lib/libvirt/images"

                log_execution(db, execution_id, dut.name, "INFO", "")
                log_execution(db, execution_id, dut.name, "INFO",
                              f"══ VM {idx}/{total}: {vs_name} ══")
                log_execution(db, execution_id, dut.name, "INFO",
                              f"  Target image: {this_target_name}")
                log_execution(db, execution_id, dut.name, "INFO",
                              f"  Source image: {source_image}")

                # Exact 4-step sequence using correct commands:
                # 1. virsh destroy <vs_name>           (user has libvirt group — no sudo needed)
                # 2. sudo rm -f <IMAGES_DIR>/<image>
                # 3. sudo cp <source> <IMAGES_DIR>/<target>
                # 4. virsh start <vs_name>
                steps = [
                    ("Step 1/4: Destroying VM",
                     f"virsh destroy {vs_name}",
                     True),   # allow_fail: VM may already be stopped
                    ("Step 2/4: Removing old image",
                     sudocmd(f"rm -f {IMAGES_DIR}/{this_target_name}"),
                     False),
                    ("Step 3/4: Copying new image",
                     sudocmd(f"cp {source_image} {IMAGES_DIR}/{this_target_name}"),
                     False),
                    ("Step 4/4: Starting VM",
                     f"virsh start {vs_name}",
                     False),
                ]

                vm_ok = True
                for step_name, command, allow_fail in steps:
                    log_execution(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
                    log_execution(db, execution_id, dut.name, "INFO", f"  $ {command}")

                    try:
                        output, error, exit_code = ssh.execute_command(command, timeout=300)

                        if output.strip():
                            for line in output.strip().split("\n")[:20]:
                                log_execution(db, execution_id, dut.name, "INFO", f"    {line}")

                        if exit_code != 0:
                            msg = error.strip() if error.strip() else f"Exit code {exit_code}"
                            if allow_fail:
                                log_execution(db, execution_id, dut.name, "WARNING",
                                              f"  ⚠ {step_name} returned non-zero (allowed): {msg}")
                            else:
                                log_execution(db, execution_id, dut.name, "ERROR",
                                              f"  ✗ {step_name} FAILED: {msg}")
                                vm_ok = False
                                break
                        else:
                            log_execution(db, execution_id, dut.name, "INFO",
                                          f"  ✓ {step_name} completed successfully")

                    except Exception as cmd_err:
                        log_execution(db, execution_id, dut.name, "ERROR",
                                      f"  ✗ {step_name} error: {str(cmd_err)}")
                        vm_ok = False
                        break

                if vm_ok:
                    # Verify VM is running
                    log_execution(db, execution_id, dut.name, "INFO",
                                  "Verifying VM status...")
                    output, _, _ = ssh.execute_command(f"virsh domstate {vs_name}", timeout=10)
                    state = output.strip()
                    log_execution(db, execution_id, dut.name, "INFO",
                                  f"  VM '{vs_name}' status: {state}")

                    if "running" in state.lower():
                        log_execution(db, execution_id, dut.name, "INFO",
                                      f"✓ VS image update completed — '{vs_name}' is running with new image")
                    else:
                        log_execution(db, execution_id, dut.name, "WARNING",
                                      f"⚠ VS image update completed but VM state is '{state}'")
                else:
                    log_execution(db, execution_id, dut.name, "ERROR",
                                  f"✗ VS image update FAILED for '{vs_name}'")
                    all_success = False

            # Final summary
            log_execution(db, execution_id, "SYSTEM", "INFO", "")
            if all_success:
                log_execution(db, execution_id, "SYSTEM", "INFO",
                              f"═══ Batch complete: All {total} VM(s) updated successfully ═══")
                execution.status = "completed"
            else:
                log_execution(db, execution_id, "SYSTEM", "WARNING",
                              f"═══ Batch complete: Some VMs failed. Check logs above. ═══")
                execution.status = "completed"  # partial success is still "completed"

        finally:
            ssh.disconnect()

        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds()
            )
        db.commit()

    except Exception as e:
        logger.error(f"VS batch update failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
        log_execution(db, execution_id, dut.name if dut else "SYSTEM", "ERROR",
                      f"VS batch update failed: {str(e)}")
    finally:
        db.close()


def _run_vs_update(
    execution_id: int,
    dut,
    vs_name: str,
    xml_full_path: str,
    source_image: str,
    target_image_path: str,
):
    """Background thread: Full VS image update lifecycle."""
    db = SessionLocal()
    execution = None
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        log_execution(db, execution_id, dut.name, "INFO",
                      f"Starting VS image update for '{vs_name}'")
        log_execution(db, execution_id, dut.name, "INFO",
                      f"  Source image: {source_image}")
        log_execution(db, execution_id, dut.name, "INFO",
                      f"  Target image: {target_image_path}")
        log_execution(db, execution_id, dut.name, "INFO",
                      f"  XML file: {xml_full_path}")

        # Connect via SSH
        ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
        if not ssh.connect():
            log_execution(db, execution_id, dut.name, "ERROR",
                          f"Failed to connect to {dut.name} ({dut.ip_address}:{dut.port})")
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
            return

        try:
            steps = [
                ("Step 1/6: Destroying VM",
                 f"sudo virsh destroy {vs_name}",
                 True),   # allow_fail=True (VM might already be off)
                ("Step 2/6: Removing old image",
                 f"sudo rm -f {target_image_path}",
                 False),
                ("Step 3/6: Copying new image",
                 f"sudo cp {source_image} {target_image_path}",
                 False),
                ("Step 4/6: Undefining VM",
                 f"sudo virsh undefine {vs_name}",
                 True),   # allow_fail=True (might already be undefined)
                ("Step 5/6: Defining VM from XML",
                 f"sudo virsh define {xml_full_path}",
                 False),
                ("Step 6/6: Starting VM",
                 f"sudo virsh start {vs_name}",
                 False),
            ]

            all_ok = True
            for step_name, command, allow_fail in steps:
                log_execution(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
                log_execution(db, execution_id, dut.name, "INFO", f"  $ {command}")

                try:
                    output, error, exit_code = ssh.execute_command(command, timeout=120)

                    if output.strip():
                        for line in output.strip().split("\n")[:20]:
                            log_execution(db, execution_id, dut.name, "INFO", f"    {line}")

                    if exit_code != 0:
                        msg = error.strip() if error.strip() else f"Exit code {exit_code}"
                        if allow_fail:
                            log_execution(db, execution_id, dut.name, "WARNING",
                                          f"  ⚠ {step_name} returned non-zero (allowed): {msg}")
                        else:
                            log_execution(db, execution_id, dut.name, "ERROR",
                                          f"  ✗ {step_name} FAILED: {msg}")
                            all_ok = False
                            break
                    else:
                        log_execution(db, execution_id, dut.name, "INFO",
                                      f"  ✓ {step_name} completed successfully")

                except Exception as cmd_err:
                    log_execution(db, execution_id, dut.name, "ERROR",
                                  f"  ✗ {step_name} error: {str(cmd_err)}")
                    all_ok = False
                    break

            if all_ok:
                # Verify VM is running
                log_execution(db, execution_id, dut.name, "INFO",
                              "Verifying VM status...")
                output, _, _ = ssh.execute_command(f"sudo virsh domstate {vs_name}", timeout=10)
                state = output.strip()
                log_execution(db, execution_id, dut.name, "INFO",
                              f"  VM '{vs_name}' status: {state}")

                if "running" in state.lower():
                    log_execution(db, execution_id, dut.name, "INFO",
                                  f"✓ VS image update completed — '{vs_name}' is running with new image")
                else:
                    log_execution(db, execution_id, dut.name, "WARNING",
                                  f"⚠ VS image update completed but VM state is '{state}'")

                execution.status = "completed"
            else:
                log_execution(db, execution_id, dut.name, "ERROR",
                              f"✗ VS image update FAILED for '{vs_name}'")
                execution.status = "failed"

        finally:
            ssh.disconnect()

        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds()
            )
        db.commit()

    except Exception as e:
        logger.error(f"VS update failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
        log_execution(db, execution_id, dut.name if dut else "SYSTEM", "ERROR",
                      f"VS update failed: {str(e)}")
    finally:
        db.close()


@app.post("/api/vs/{dut_id}/action")
def vs_action(dut_id: int, body: dict, db: Session = Depends(get_db)):
    """Quick VM action: start, destroy, reboot, shutdown."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    vs_name = body.get("vs_name", "").strip()
    action = body.get("action", "").strip().lower()

    if not vs_name or not action:
        raise HTTPException(status_code=400, detail="vs_name and action are required")

    allowed_actions = ["start", "destroy", "reboot", "shutdown"]
    if action not in allowed_actions:
        raise HTTPException(status_code=400,
                            detail=f"Invalid action. Allowed: {', '.join(allowed_actions)}")

    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")

    try:
        # Use password with sudo if available (for devices that require it)
        if dut.password:
            safe_pass = dut.password.replace("'", "'\\''")
            command = f"echo '{safe_pass}' | sudo -S virsh {action} {vs_name}"
        else:
            command = f"sudo virsh {action} {vs_name}"

        output, error, exit_code = ssh.execute_command(command, timeout=30)

        if exit_code != 0:
            return {
                "status": "error",
                "vs_name": vs_name,
                "action": action,
                "message": error.strip() or f"Command failed with exit code {exit_code}",
            }

        return {
            "status": "success",
            "vs_name": vs_name,
            "action": action,
            "message": output.strip() or f"'{action}' executed on '{vs_name}'",
        }
    finally:
        ssh.disconnect()


# ============================================================================
# API — SPyTest Integration (Remote Browsing & Smart Execution)
# ============================================================================


def _ssh_to_host(dut_id: int, db: Session):
    """Create SSH connection to a host device for SPyTest operations."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="Host device not found")
    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")
    return ssh, dut


@app.get("/api/spytest/categories")
def get_spytest_categories(host_id: int, db: Session = Depends(get_db)):
    """List test category folders from the remote SPyTest tests directory."""
    ssh, dut = _ssh_to_host(host_id, db)
    try:
        cmd = f'find {SPYTEST_TESTS_DIR} -mindepth 1 -maxdepth 1 -type d -printf "%f\\n" | sort'
        output, error, code = ssh.execute_command(cmd, timeout=15)
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to list categories: {error}")
        categories = [d.strip() for d in output.strip().split("\n") if d.strip() and not d.strip().startswith("__")]
        return {"categories": categories, "base_path": SPYTEST_TESTS_DIR}
    finally:
        ssh.disconnect()


@app.get("/api/spytest/scripts/{category}")
def get_spytest_scripts(category: str, host_id: int, db: Session = Depends(get_db)):
    """List Python test scripts in a category folder (recursive)."""
    ssh, dut = _ssh_to_host(host_id, db)
    try:
        category_path = f"{SPYTEST_TESTS_DIR}/{category}"
        cmd = f'find {category_path} -name "test_*.py" -type f | sort'
        output, error, code = ssh.execute_command(cmd, timeout=15)
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to list scripts: {error}")
        scripts = []
        for line in output.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            # Get path relative to tests dir
            rel_path = line.replace(SPYTEST_TESTS_DIR + "/", "")
            name = os.path.basename(line)
            scripts.append({"name": name, "path": rel_path, "full_path": line})
        return {"category": category, "scripts": scripts}
    finally:
        ssh.disconnect()


@app.get("/api/spytest/browse/{path:path}")
def browse_spytest_folder(path: str, host_id: int, db: Session = Depends(get_db)):
    """
    Browse a specific folder in the SPyTest tests directory.
    Returns both subfolders and scripts at the current level only (non-recursive).

    Args:
        path: Relative path from SPYTEST_TESTS_DIR (e.g., "routing" or "routing/bgp" or "")
        host_id: ID of the host device where SPyTest is installed

    Returns:
        {
            "current_path": "routing/bgp",
            "parent_path": "routing",
            "subfolders": ["ipv4", "ipv6", "evpn"],
            "scripts": [{"name": "test_bgp_basic.py", "path": "routing/bgp/test_bgp_basic.py", "full_path": "/full/path"}]
        }
    """
    ssh, dut = _ssh_to_host(host_id, db)
    try:
        # Sanitize path - remove leading/trailing slashes
        path = path.strip().strip('/')

        # Build full path
        if path:
            full_path = f"{SPYTEST_TESTS_DIR}/{path}"
        else:
            full_path = SPYTEST_TESTS_DIR

        # Check if path exists and is a directory
        check_cmd = f'[ -d "{full_path}" ] && echo "EXISTS" || echo "NOT_FOUND"'
        check_out, _, _ = ssh.execute_command(check_cmd, timeout=5)
        if "NOT_FOUND" in check_out:
            raise HTTPException(status_code=404, detail=f"Path not found: {path}")

        # Get subfolders (directories only, non-recursive, exclude __pycache__)
        subfolder_cmd = f'find "{full_path}" -mindepth 1 -maxdepth 1 -type d ! -name "__pycache__" ! -name ".*" -printf "%f\\n" | sort'
        subfolder_out, subfolder_err, subfolder_code = ssh.execute_command(subfolder_cmd, timeout=15)

        if subfolder_code != 0:
            logger.warning(f"Failed to list subfolders in {path}: {subfolder_err}")
            subfolders = []
        else:
            subfolders = [f.strip() for f in subfolder_out.strip().split("\n") if f.strip()]

        # Get scripts (test_*.py files in current folder only, non-recursive)
        script_cmd = f'find "{full_path}" -maxdepth 1 -name "test_*.py" -type f | sort'
        script_out, script_err, script_code = ssh.execute_command(script_cmd, timeout=15)

        if script_code != 0:
            logger.warning(f"Failed to list scripts in {path}: {script_err}")
            scripts = []
        else:
            scripts = []
            for line in script_out.strip().split("\n"):
                line = line.strip()
                if not line:
                    continue
                # Get path relative to tests dir
                rel_path = line.replace(SPYTEST_TESTS_DIR + "/", "")
                name = os.path.basename(line)
                scripts.append({"name": name, "path": rel_path, "full_path": line})

        # Calculate parent path
        parent_path = ""
        if path and "/" in path:
            parent_path = "/".join(path.split("/")[:-1])

        return {
            "current_path": path,
            "parent_path": parent_path,
            "subfolders": subfolders,
            "scripts": scripts,
            "subfolder_count": len(subfolders),
            "script_count": len(scripts)
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error browsing folder {path}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to browse folder: {str(e)}")
    finally:
        ssh.disconnect()


@app.get("/api/spytest/testbeds")
def get_spytest_testbeds(host_id: int, db: Session = Depends(get_db)):
    """List testbed YAML files from the remote SPyTest testbed directory."""
    ssh, dut = _ssh_to_host(host_id, db)
    try:
        cmd = f'find {SPYTEST_TESTBED_DIR} -maxdepth 1 -name "*.yaml" -type f -printf "%f\\n" | sort'
        output, error, code = ssh.execute_command(cmd, timeout=15)
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to list testbeds: {error}")
        testbeds = [f.strip() for f in output.strip().split("\n") if f.strip()]
        return {"testbeds": testbeds, "base_path": SPYTEST_TESTBED_DIR}
    finally:
        ssh.disconnect()


@app.post("/api/spytest/script-info")
def get_spytest_script_info(body: dict, db: Session = Depends(get_db)):
    """Parse a SPyTest script to extract topology requirements.
    
    Looks for:
    - @pytest.mark.topology("...") decorators
    - st.ensure_min_topology("D1", "D1D2:1", ...) calls
    - Docstring topology description
    """
    host_id = body.get("host_id")
    script_path = body.get("script_path")  # relative to tests dir
    if not host_id or not script_path:
        raise HTTPException(status_code=400, detail="host_id and script_path required")

    ssh, dut = _ssh_to_host(host_id, db)
    try:
        full_path = f"{SPYTEST_TESTS_DIR}/{script_path}"
        cmd = f'cat {full_path}'
        output, error, code = ssh.execute_command(cmd, timeout=15)
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to read script: {error}")

        script_content = output
        info = _parse_spytest_script(script_content)
        info["script_path"] = script_path
        info["script_name"] = os.path.basename(script_path)
        return info
    finally:
        ssh.disconnect()


def _parse_spytest_script(content: str) -> dict:
    """Parse SPyTest script content to extract topology and metadata."""
    result = {
        "topology_marker": None,
        "min_topology": [],
        "dut_count": 1,
        "description": "",
        "topology_type": "standalone",
    }

    # 1. Parse @pytest.mark.topology("...")
    topo_match = re.search(r'@pytest\.mark\.topology\(["\']([^"\']+)["\']\)', content)
    if topo_match:
        result["topology_marker"] = topo_match.group(1)

    # 2. Parse st.ensure_min_topology(...)
    min_topo_match = re.search(r'st\.ensure_min_topology\(([^)]+)\)', content)
    if min_topo_match:
        args_str = min_topo_match.group(1)
        # Extract quoted strings like "D1", "D1D2:1"
        topo_args = re.findall(r'["\']([^"\']+)["\']', args_str)
        result["min_topology"] = topo_args
        # Count DUTs from topology args
        max_duts = 1
        for arg in topo_args:
            # Count D references: D1, D2, D3, etc.
            dut_refs = re.findall(r'D(\d+)', arg)
            if dut_refs:
                max_duts = max(max_duts, max(int(d) for d in dut_refs))
        result["dut_count"] = max_duts

    # 3. Determine topology type
    if result["dut_count"] == 1:
        result["topology_type"] = "standalone"
    elif result["dut_count"] == 2:
        result["topology_type"] = "dual-dut"
    else:
        result["topology_type"] = f"{result['dut_count']}-node"

    # 4. Extract description from docstring
    docstring_match = re.search(r'"""(.+?)"""', content, re.DOTALL)
    if docstring_match:
        desc = docstring_match.group(1).strip()
        # Take first 3 lines or 300 chars
        lines = desc.split("\n")
        result["description"] = "\n".join(lines[:3]).strip()[:300]

    return result


@app.post("/api/spytest/execute")
def start_spytest_execution(body: dict, db: Session = Depends(get_db)):
    """Smart SPyTest execution with DUT allocation and parallel scheduling.
    
    Body:
        host_id: int - device where SPyTest runs
        scripts: list[{path, dut_count}] - scripts to execute with topology info
        testbed: str - testbed YAML filename
        options: dict - optional extra CLI args
    """
    host_id = body.get("host_id")
    scripts = body.get("scripts", [])
    testbed_file = body.get("testbed")
    options = body.get("options", {})
    available_dut_count = int(body.get("available_dut_count", 1))  # from canvas selection

    if not host_id or not scripts or not testbed_file:
        raise HTTPException(status_code=400, detail="host_id, scripts, and testbed required")

    # Validate host
    dut = db.query(DUT).filter(DUT.id == host_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="Host device not found")

    # Create master execution record
    exec_name = f"spytest_{int(datetime.utcnow().timestamp())}"
    execution = Execution(
        name=exec_name,
        dut_ids=json.dumps([host_id]),
        execution_type="spytest",
        status="pending",
    )
    db.add(execution)
    db.commit()
    db.refresh(execution)

    # Pre-initialise queue state NOW (synchronously) so the frontend can poll
    # immediately without waiting for the background thread to call _q_init.
    script_names = [os.path.basename(s.get("path", "")) for s in scripts]
    _q_init(execution.id, script_names, [])   # DUTs updated once testbed is read

    # Start background execution thread
    thread = Thread(
        target=_run_spytest_execution,
        args=(execution.id, host_id, scripts, testbed_file, options, available_dut_count),
        daemon=True,
    )
    thread.start()

    return {
        "execution_id": execution.id,
        "status": "started",
        "type": "spytest",
        "script_count": len(scripts),
    }


# ============================================================================
# IN-MEMORY EXECUTION QUEUE STATE  (for /api/execution-queue)
# ============================================================================

_exec_queue_lock = Lock()
_exec_queue_state: dict = {}   # execution_id -> {scripts:[{name,status,duts}], free_duts:[]}


def _q_init(execution_id: int, script_names: list, all_duts: list):
    with _exec_queue_lock:
        _exec_queue_state[execution_id] = {
            "scripts": [{"name": n, "status": "queued", "duts": [], "pid": None} for n in script_names],
            "free_duts": list(all_duts),
            "all_duts": list(all_duts),
        }


def _q_update_script(execution_id: int, script_name: str, status: str, duts: list = None, pid: str = None):
    with _exec_queue_lock:
        state = _exec_queue_state.get(execution_id)
        if not state:
            return
        for s in state["scripts"]:
            if s["name"] == script_name:
                s["status"] = status
                if duts is not None:
                    s["duts"] = duts
                if pid is not None:
                    s["pid"] = pid
                break


def _q_set_free(execution_id: int, free_duts: list):
    with _exec_queue_lock:
        state = _exec_queue_state.get(execution_id)
        if state:
            state["free_duts"] = list(free_duts)


def _q_cleanup(execution_id: int):
    with _exec_queue_lock:
        _exec_queue_state.pop(execution_id, None)


@app.get("/api/execution-queue")
def get_execution_queue():
    """Return current live execution queue state for all active executions."""
    with _exec_queue_lock:
        return dict(_exec_queue_state)


# ============================================================================
# SPYTEST BACKGROUND EXECUTION — per-script threads with smart DUT allocation
# ============================================================================

def _run_spytest_execution(
    execution_id: int,
    host_id: int,
    scripts: list,
    testbed_file: str,
    options: dict,
    available_dut_count: int = 1,
):
    """Background thread: Smart SPyTest execution with true parallel DUT allocation.

    Each script runs in its own SSH sub-thread. A shared lock + pool ensures that
    a script that needs 1 DUT starts immediately if 1 is free, while a script
    needing 2 DUTs waits only until 2 are simultaneously available.
    """
    import time as _time

    db = SessionLocal()
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        host_dut = db.query(DUT).filter(DUT.id == host_id).first()
        if not execution or not host_dut:
            return

        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"SPyTest execution started on {host_dut.name} ({host_dut.ip_address})")
        log_execution(db, execution_id, "SYSTEM", "INFO",
                      f"Testbed: {testbed_file} | Scripts: {len(scripts)}")

        # ── Open a single persistent SSH connection for coordination ──────────
        coord_ssh = SSHConnectionManager(
            host_dut.ip_address, host_dut.port, host_dut.username, host_dut.password
        )
        if not coord_ssh.connect():
            log_execution(db, execution_id, "SYSTEM", "ERROR",
                          f"Failed to SSH to {host_dut.name}")
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
            return

        try:
            # ── Read testbed YAML ─────────────────────────────────────────────
            testbed_path = f"{SPYTEST_TESTBED_DIR}/{testbed_file}"
            out, err, code = coord_ssh.execute_command(f"cat {testbed_path}", timeout=15)
            if code != 0:
                log_execution(db, execution_id, "SYSTEM", "ERROR",
                              f"Cannot read testbed: {err}")
                execution.status = "failed"
                execution.end_time = datetime.utcnow()
                db.commit()
                return

            testbed_config = yaml.safe_load(out) or {}
            testbed_devices = list(testbed_config.get("devices", {}).keys())
            total_testbed_duts = len(testbed_devices)

            # Build the DUT pool. We use the LARGER of:
            #   a) devices defined in the testbed YAML
            #   b) the number of DUTs selected on the topology canvas
            # When the canvas has more DUTs than the testbed YAML (common in simple
            # setups where only one logical device is defined), we replicate the last
            # testbed device name to create extra slots so scripts can run in parallel.
            if available_dut_count > total_testbed_duts and total_testbed_duts > 0:
                # Pad with the last known device repeated as extra slots
                extra = available_dut_count - total_testbed_duts
                all_duts = testbed_devices + [testbed_devices[-1]] * extra
                log_execution(db, execution_id, "SYSTEM", "INFO",
                              f"Canvas has {available_dut_count} DUTs, testbed has {total_testbed_duts}. "
                              f"Padding pool to {available_dut_count} parallel slot(s).")
            elif total_testbed_duts == 0:
                # Testbed has no devices — create synthetic slots named Slot-1, Slot-2…
                all_duts = [f"Slot-{i+1}" for i in range(available_dut_count)]
                log_execution(db, execution_id, "SYSTEM", "WARNING",
                              f"No devices found in testbed YAML! Using {available_dut_count} synthetic slot(s). "
                              f"Check the testbed YAML 'devices:' key.")
            else:
                all_duts = testbed_devices

            log_execution(db, execution_id, "SYSTEM", "INFO",
                          f"Parallel pool: {len(all_duts)} slot(s) — {', '.join(all_duts)}")

            # ── Init in-memory queue state ────────────────────────────────────
            script_names = [os.path.basename(s.get("path", "")) for s in scripts]
            _q_init(execution_id, script_names, all_duts)

            # ── Shared DUT pool (protected by a lock) ─────────────────────────
            pool_lock = Lock()
            available_pool: list = list(all_duts)   # mutable shared state

            def acquire_duts(needed: int) -> list:
                """Block until `needed` DUTs are available, then atomically grab them."""
                while True:
                    with pool_lock:
                        if len(available_pool) >= needed:
                            allocated = available_pool[:needed]
                            del available_pool[:needed]
                            _q_set_free(execution_id, list(available_pool))
                            return allocated
                    _time.sleep(5)

            def release_duts(duts_to_free: list):
                with pool_lock:
                    available_pool.extend(duts_to_free)
                    _q_set_free(execution_id, list(available_pool))

            # ── Per-script worker ─────────────────────────────────────────────
            def run_one_script(script_info: dict, slot_idx: int):
                sdb = SessionLocal()
                s_ssh = None
                script_path = script_info.get("path", "")
                dut_count   = script_info.get("dut_count", 1)
                sname       = os.path.basename(script_path)

                try:
                    # --- Wait for enough free DUTs --------------------------
                    _q_update_script(execution_id, sname, "waiting")
                    log_execution(sdb, execution_id, sname, "INFO",
                                  f"[QUEUE] Waiting for {dut_count} DUT(s)… "
                                  f"(pool has {len(available_pool)})")

                    assigned = acquire_duts(dut_count)
                    _q_update_script(execution_id, sname, "running", duts=assigned)
                    log_execution(sdb, execution_id, sname, "INFO",
                                  f"[ALLOC] Assigned DUT(s): {', '.join(assigned)}")

                    # --- Create temp testbed YAML ---------------------------
                    temp_tb_path = f"/tmp/temp_exec{execution_id}_s{slot_idx}.yaml"
                    temp_cfg = _create_subset_testbed(testbed_config, assigned)
                    temp_yaml_str = yaml.dump(temp_cfg, default_flow_style=False)
                    import base64 as _b64
                    yaml_b64 = _b64.b64encode(temp_yaml_str.encode()).decode()
                    # Use a fresh SSH connection per script so they don't share channels
                    s_ssh = SSHConnectionManager(
                        host_dut.ip_address, host_dut.port,
                        host_dut.username, host_dut.password
                    )
                    if not s_ssh.connect():
                        log_execution(sdb, execution_id, sname, "ERROR",
                                      "SSH connection failed for script worker")
                        _q_update_script(execution_id, sname, "failed")
                        release_duts(assigned)
                        return

                    s_ssh.execute_command(
                        f"echo '{yaml_b64}' | base64 -d > {temp_tb_path}", timeout=10
                    )

                    # --- Build and launch SPyTest ---------------------------
                    extra_opts = ""
                    if options.get("log_level"):
                        extra_opts += f" --log-level {options['log_level']}"
                    if options.get("skip_init_config"):
                        extra_opts += " --skip-init-config"
                    extra_opts += " --ifname-type native"

                    log_dir = (
                        f"{SPYTEST_BASE}/logs/"
                        f"exec{execution_id}_{sname}_{int(datetime.utcnow().timestamp())}"
                    )
                    s_ssh.execute_command(f"mkdir -p {log_dir}", timeout=10)

                    spy_cmd = (
                        f"cd {SPYTEST_BASE} && "
                        f"source {SPYTEST_VENV}/bin/activate && "
                        f"{SPYTEST_PYTHON} {SPYTEST_BIN} --tryssh 1 "
                        f"--testbed {temp_tb_path} "
                        f"{SPYTEST_TESTS_DIR}/{script_path} "
                        f"--logs-path {log_dir}"
                        f"{extra_opts}"
                    )
                    logfile = f"/tmp/spytest_exec{execution_id}_s{slot_idx}.log"
                    bg_cmd = f"nohup bash -c '{spy_cmd}' > {logfile} 2>&1 & echo $!"

                    pid_out, _, _ = s_ssh.execute_command(bg_cmd, timeout=15)
                    pid = pid_out.strip()

                    if not (pid and pid.isdigit()):
                        log_execution(sdb, execution_id, sname, "ERROR",
                                      f"Failed to launch (pid output: {pid_out!r})")
                        _q_update_script(execution_id, sname, "failed")
                        release_duts(assigned)
                        return

                    _q_update_script(execution_id, sname, "running", pid=pid)
                    log_execution(sdb, execution_id, sname, "INFO",
                                  f"[RUN] PID={pid} DUTs={', '.join(assigned)}")

                    # --- Poll until the process exits -----------------------
                    last_lines_seen = 0
                    while True:
                        _time.sleep(10)
                        chk_out, _, _ = s_ssh.execute_command(
                            f"kill -0 {pid} 2>/dev/null && echo RUNNING || echo DONE",
                            timeout=5,
                        )
                        # Stream fresh log tail to the DB
                        log_tail, _, _ = s_ssh.execute_command(
                            f"wc -l < {logfile} 2>/dev/null || echo 0", timeout=5
                        )
                        total_lines = int(log_tail.strip() or "0")
                        if total_lines > last_lines_seen:
                            tail_n = total_lines - last_lines_seen
                            new_log, _, _ = s_ssh.execute_command(
                                f"tail -n {min(tail_n, 50)} {logfile} 2>/dev/null",
                                timeout=5,
                            )
                            if new_log.strip():
                                for ln in new_log.strip().split("\n"):
                                    log_execution(sdb, execution_id, sname, "INFO", ln)
                            last_lines_seen = total_lines

                        if "DONE" in chk_out:
                            break

                    log_execution(sdb, execution_id, sname, "INFO", "✓ Script completed")
                    _q_update_script(execution_id, sname, "done")
                    s_ssh.execute_command(f"rm -f {temp_tb_path}", timeout=5)

                except Exception as ex:
                    log_execution(sdb, execution_id, sname, "ERROR",
                                  f"Script error: {ex}")
                    _q_update_script(execution_id, sname, "failed")
                finally:
                    release_duts(assigned if 'assigned' in dir() else [])
                    if s_ssh:
                        s_ssh.disconnect()
                    sdb.close()

            # ── Launch all script threads ─────────────────────────────────────
            threads = []
            for idx, script_info in enumerate(scripts):
                t = Thread(target=run_one_script, args=(script_info, idx), daemon=True)
                threads.append(t)
                t.start()
                _time.sleep(0.3)   # stagger slightly so acquire order is predictable

            for t in threads:
                t.join()

            # ── Mark master execution done ────────────────────────────────────
            execution.status = "completed"
            execution.end_time = datetime.utcnow()
            if execution.start_time:
                execution.duration_seconds = int(
                    (execution.end_time - execution.start_time).total_seconds()
                )
            db.commit()
            log_execution(db, execution_id, "SYSTEM", "INFO",
                          f"✓ All scripts finished ({execution.duration_seconds}s)")
            _q_cleanup(execution_id)

        finally:
            coord_ssh.disconnect()

    except Exception as e:
        logger.error(f"SPyTest execution failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
        log_execution(db, execution_id, "SYSTEM", "ERROR", f"Execution failed: {e}")
        _q_cleanup(execution_id)
    finally:
        db.close()


def _create_subset_testbed(full_config: dict, device_names: list) -> dict:
    """Create a subset testbed YAML with only the specified devices."""
    subset = {
        "version": full_config.get("version", "2.0"),
        "devices": {},
        "topology": {},
        "services": full_config.get("services", {"default": {}}),
        "builds": full_config.get("builds", {"default": {}}),
        "configs": full_config.get("configs", {"default": {}}),
        "errors": full_config.get("errors", {"default": {}}),
        "params": full_config.get("params", {}),
    }

    # Copy only the selected devices
    all_devices = full_config.get("devices", {})
    all_topology = full_config.get("topology", {})

    for dev_name in device_names:
        if dev_name in all_devices:
            subset["devices"][dev_name] = all_devices[dev_name]

        if dev_name in all_topology:
            # Filter interfaces to only include links to other selected devices
            dev_topo = all_topology[dev_name]
            filtered_interfaces = {}
            for iface, link in dev_topo.get("interfaces", {}).items():
                end_device = link.get("EndDevice", "")
                if end_device in device_names:
                    filtered_interfaces[iface] = link
            if filtered_interfaces:
                subset["topology"][dev_name] = {"interfaces": filtered_interfaces}
            else:
                subset["topology"][dev_name] = {"interfaces": {}}

    return subset


# ============================================================================
# API — DUT Lock Management (AVAILABLE / ALLOCATED / IN_USE)
# ============================================================================

def _ensure_dut_lock(db: Session, dut_id: int) -> DUTLock:
    """Seed a DUTLock row for a DUT if one doesn't exist yet."""
    lock = db.query(DUTLock).filter(DUTLock.dut_id == dut_id).first()
    if not lock:
        lock = DUTLock(dut_id=dut_id, status="AVAILABLE")
        db.add(lock)
        db.commit()
        db.refresh(lock)
    return lock


@app.get("/api/dut-locks")
def get_dut_locks(db: Session = Depends(get_db)):
    """Return current lock status for all DUTs (creates AVAILABLE rows on first call)."""
    duts = db.query(DUT).filter(DUT.device_type != "VM").all()
    result = []
    for dut in duts:
        lock = _ensure_dut_lock(db, dut.id)
        result.append({
            "dut_id": dut.id,
            "dut_name": dut.name,
            "ip_address": dut.ip_address,
            "status": lock.status,
            "job_id": lock.job_id,
            "locked_since": lock.locked_since.isoformat() if lock.locked_since else None,
        })
    return result


@app.post("/api/dut-locks/{dut_id}/release")
def release_dut_lock(dut_id: int, db: Session = Depends(get_db)):
    """Manually release a DUT lock back to AVAILABLE."""
    lock = db.query(DUTLock).filter(DUTLock.dut_id == dut_id).first()
    if not lock:
        raise HTTPException(status_code=404, detail="DUT lock not found")
    lock.status = "AVAILABLE"
    lock.job_id = None
    lock.locked_since = None
    db.commit()
    return {"status": "released", "dut_id": dut_id}


# ============================================================================
# API — Topology Connections Persistence
# ============================================================================

@app.get("/api/topology/connections")
def get_topology_connections(db: Session = Depends(get_db)):
    """Return all persisted canvas DUT connections."""
    conns = db.query(TopologyConnection).all()
    result = []
    for c in conns:
        dut_a = db.query(DUT).filter(DUT.id == c.dut_a_id).first()
        dut_b = db.query(DUT).filter(DUT.id == c.dut_b_id).first()
        result.append({
            "id": c.id,
            "dut_a": str(c.dut_a_id),
            "dut_b": str(c.dut_b_id),
            "intf_a": c.intf_a,
            "intf_b": c.intf_b,
            "dut_a_name": dut_a.name if dut_a else str(c.dut_a_id),
            "dut_b_name": dut_b.name if dut_b else str(c.dut_b_id),
        })
    return result


@app.post("/api/topology/connections")
def save_topology_connections(body: dict, db: Session = Depends(get_db)):
    """Replace all canvas connections with the provided list.
    
    Body: { connections: [{dut_a, intf_a, dut_b, intf_b}, ...] }
    """
    connections = body.get("connections", [])
    # Clear existing
    db.query(TopologyConnection).delete()
    # Insert new
    for c in connections:
        dut_a = c.get("dut_a") or c.get("dut_a_id")
        dut_b = c.get("dut_b") or c.get("dut_b_id")
        if not dut_a or not dut_b:
            continue
        conn = TopologyConnection(
            dut_a_id=int(dut_a),
            intf_a=c.get("intf_a", "Ethernet0"),
            dut_b_id=int(dut_b),
            intf_b=c.get("intf_b", "Ethernet0"),
        )
        db.add(conn)
    db.commit()
    return {"saved": len(connections)}


# ============================================================================
# API — Temp YAML Generator
# ============================================================================

@app.post("/api/spytest/generate-temp-yaml")
def generate_temp_yaml(body: dict, db: Session = Depends(get_db)):
    """Generate a temp testbed YAML on the remote VM substituting live DUT data.

    Body:
        host_id: int  — the VM where spytest runs
        testbed_filename: str  — reference testbed YAML name (from /testbeds/)
        connections: list  — [{dut_a, intf_a, dut_b, intf_b}] from canvas
        dut_ids: list[int]  — DUT device IDs to include
        script_name: str  — used in the /tmp filename
    """
    host_id = body.get("host_id")
    testbed_filename = body.get("testbed_filename", "")
    connections = body.get("connections", [])
    dut_ids = body.get("dut_ids", [])
    script_name = body.get("script_name", "script")

    if not host_id or not testbed_filename:
        raise HTTPException(status_code=400, detail="host_id and testbed_filename required")

    vm = db.query(DUT).filter(DUT.id == host_id).first()
    if not vm:
        raise HTTPException(status_code=404, detail="VM device not found")

    # Fetch all DUT device records
    dut_records = db.query(DUT).filter(DUT.id.in_(dut_ids)).all() if dut_ids else []
    dut_map = {d.id: d for d in dut_records}

    ssh = SSHConnectionManager(vm.ip_address, vm.port, vm.username, vm.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {vm.name}")

    try:
        # Read reference YAML
        ref_path = f"{SPYTEST_TESTBED_DIR}/{testbed_filename}"
        output, error, code = ssh.execute_command(f"cat {ref_path}", timeout=15)
        if code != 0:
            raise HTTPException(status_code=404, detail=f"Testbed file not found: {testbed_filename}")

        ref_config = yaml.safe_load(output) or {}
        ref_devices = ref_config.get("devices", {})
        ref_topology = ref_config.get("topology", {})
        ref_device_names = list(ref_devices.keys())

        # Build device name → DUT record mapping (match by position)
        # If we have dut_ids, map them positionally to the reference YAML device names
        device_name_to_dut = {}
        for i, dev_name in enumerate(ref_device_names):
            if i < len(dut_ids):
                device_name_to_dut[dev_name] = dut_map.get(dut_ids[i])

        # Build interface override map from canvas connections
        # connections: [{dut_a, intf_a, dut_b, intf_b}] where dut_a/dut_b are DUT IDs
        id_to_dev_name = {}
        for dev_name, dut in device_name_to_dut.items():
            if dut:
                id_to_dev_name[dut.id] = dev_name

        # Build topology from canvas connections
        canvas_topology = {}
        for conn in connections:
            a_id = int(conn.get("dut_a", 0) or 0)
            b_id = int(conn.get("dut_b", 0) or 0)
            intf_a = conn.get("intf_a", "Ethernet0")
            intf_b = conn.get("intf_b", "Ethernet0")
            name_a = id_to_dev_name.get(a_id)
            name_b = id_to_dev_name.get(b_id)
            if name_a and name_b:
                canvas_topology.setdefault(name_a, {"interfaces": {}})
                canvas_topology.setdefault(name_b, {"interfaces": {}})
                canvas_topology[name_a]["interfaces"][intf_a] = {
                    "EndDevice": name_b, "EndPort": intf_b}
                canvas_topology[name_b]["interfaces"][intf_b] = {
                    "EndDevice": name_a, "EndPort": intf_a}

        # Build the final temp YAML config
        temp_config = {
            "version": ref_config.get("version", "2.0"),
            "devices": {},
            "topology": canvas_topology if canvas_topology else ref_topology,
            "services": ref_config.get("services", {"default": {}}),
            "builds": ref_config.get("builds", {"default": {}}),
            "configs": ref_config.get("configs", {"default": {}}),
            "errors": ref_config.get("errors", {"default": {}}),
            "params": ref_config.get("params", {}),
        }

        # Substitute DUT IPs/credentials from device records
        for dev_name, ref_dev in ref_devices.items():
            dut = device_name_to_dut.get(dev_name)
            dev_entry = dict(ref_dev)  # copy reference entry
            if dut:
                dev_entry["ip"] = dut.ip_address
                dev_entry["username"] = dut.username
                dev_entry["password"] = dut.password
            temp_config["devices"][dev_name] = dev_entry

        # Write to /tmp on the VM
        import uuid as _uuid
        unique_id = str(_uuid.uuid4())[:8]
        safe_script = re.sub(r'[^a-zA-Z0-9_]', '_', script_name)[:30]
        temp_filename = f"testbed_{unique_id}_{safe_script}.yaml"
        temp_path = f"/tmp/{temp_filename}"

        yaml_str = (
            f"# AUTO-GENERATED — DO NOT EDIT MANUALLY\n"
            f"# Generated by Eka Automation | Script: {script_name}\n"
            + yaml.dump(temp_config, default_flow_style=False)
        )

        yaml_b64 = base64.b64encode(yaml_str.encode()).decode()
        write_cmd = f"echo '{yaml_b64}' | base64 -d > {temp_path}"
        _, write_err, write_code = ssh.execute_command(write_cmd, timeout=15)
        if write_code != 0:
            raise HTTPException(status_code=500,
                                detail=f"Failed to write temp YAML: {write_err}")

        logger.info(f"Temp YAML written: {temp_path}")
        return {
            "temp_yaml_path": temp_path,
            "temp_filename": temp_filename,
            "device_count": len(temp_config["devices"]),
            "devices": list(temp_config["devices"].keys()),
        }

    finally:
        ssh.disconnect()


# ============================================================================
# Background — Orphan Temp YAML Cleanup (every 5 minutes)
# ============================================================================

def _cleanup_orphan_temp_yamls():
    """Background thread: delete orphaned /tmp/testbed_*.yaml files on all VMs."""
    import time
    while True:
        time.sleep(300)  # 5 minutes
        db = SessionLocal()
        try:
            vms = db.query(DUT).filter(DUT.device_type == "VM").all()
            for vm in vms:
                try:
                    ssh = SSHConnectionManager(vm.ip_address, vm.port,
                                               vm.username, vm.password)
                    if ssh.connect():
                        try:
                            # Delete temp files older than 2 hours
                            ssh.execute_command(
                                "find /tmp -name 'testbed_*.yaml' -mmin +120 -delete 2>/dev/null",
                                timeout=15
                            )
                        finally:
                            ssh.disconnect()
                except Exception:
                    pass
        except Exception as e:
            logger.warning(f"Orphan cleanup error: {e}")
        finally:
            db.close()


_cleanup_thread = Thread(target=_cleanup_orphan_temp_yamls, daemon=True)
_cleanup_thread.start()
logger.info("Orphan temp YAML cleanup scheduler started (every 5 min)")




# ============================================================================
# API — Git Repository Integration (SSH clone/pull on VM with credentials)
# ============================================================================

# Base directory on the VM where repos are cloned
GIT_CLONE_BASE = "/home/hp_test/Eka"

# Git state file — persists across server restarts
_GIT_STATE_FILE = DATA_DIR / "git_state.json"

# In-memory Git configuration state
_git_state = {
    "configured": False,
    "host_id": None,
    "host_name": "",
    "repo_url": "",
    "branch": "master",
    "repo_name": "",
    "tests_path": "",
    "categories_count": 0,
}

# Auto-restore git state from disk if it exists
if _GIT_STATE_FILE.exists():
    try:
        _saved = json.loads(_GIT_STATE_FILE.read_text(encoding="utf-8"))
        if _saved.get("configured"):
            _git_state.update(_saved)
            logger.info(f"[Git] Restored state from disk: host_id={_saved.get('host_id')}")
    except Exception as e:
        logger.warning(f"[Git] Could not restore git state: {e}")


def _save_git_state():
    """Persist current git state to disk so it survives server restarts."""
    try:
        _GIT_STATE_FILE.write_text(
            json.dumps(_git_state, indent=2), encoding="utf-8"
        )
    except Exception as e:
        logger.warning(f"[Git] Could not save git state: {e}")


def _build_auth_url(repo_url: str, username: str, token: str) -> str:
    """Build an authenticated HTTPS git URL with embedded credentials."""
    # https://github.com/user/repo.git → https://username:token@github.com/user/repo.git
    if repo_url.startswith("https://"):
        return repo_url.replace("https://", f"https://{username}:{token}@", 1)
    elif repo_url.startswith("http://"):
        return repo_url.replace("http://", f"http://{username}:{token}@", 1)
    return repo_url


@app.post("/api/git/configure")
def configure_git(body: dict, db: Session = Depends(get_db)):
    """
    Connect to a VM via SSH, clone or pull a git repo with user credentials,
    then list test categories from the tests folder.
    """
    host_id = body.get("host_id")
    repo_url = body.get("repo_url", "").strip()
    username = body.get("username", "").strip()
    token = body.get("token", "").strip()
    branch = body.get("branch", "master").strip() or "master"

    if not host_id:
        raise HTTPException(status_code=400, detail="Please select a VM host")
    if not repo_url:
        raise HTTPException(status_code=400, detail="Repo URL is required")
    if not token:
        raise HTTPException(status_code=400, detail="Password / Token is required")

    dut = db.query(DUT).filter(DUT.id == host_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="VM device not found")

    # Extract repo name from URL (e.g., "sonic-mgmt" from "https://github.com/user/sonic-mgmt.git")
    repo_name = repo_url.rstrip("/").split("/")[-1]
    if repo_name.endswith(".git"):
        repo_name = repo_name[:-4]

    repo_dir = f"{GIT_CLONE_BASE}/{repo_name}"
    tests_dir = f"{repo_dir}/spytest/tests"
    auth_url = _build_auth_url(repo_url, username, token)

    logger.info(f"[Git] Connecting to {dut.name} ({dut.ip_address}:{dut.port}) for git clone/pull...")

    ssh = SSHConnectionManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name} ({dut.ip_address})")

    try:
        # Step 1: Check if repo already exists on the VM
        check_cmd = f"test -d {repo_dir}/.git && echo EXISTS || echo MISSING"
        check_out, _, _ = ssh.execute_command(check_cmd, timeout=10)
        repo_exists = "EXISTS" in check_out

        if repo_exists:
            # Pull latest changes
            pull_cmd = f"cd {repo_dir} && git checkout {branch} 2>&1 && git pull {auth_url} {branch} 2>&1"
            logger.info(f"[Git] Repo exists, running git pull on branch '{branch}'...")
            output, error, exit_code = ssh.execute_command(pull_cmd, timeout=120)
            action = "pull"
        else:
            # Clone the repo
            clone_cmd = f"cd {GIT_CLONE_BASE} && git clone --branch {branch} {auth_url} 2>&1"
            logger.info(f"[Git] Cloning repo into {repo_dir} on branch '{branch}'...")
            output, error, exit_code = ssh.execute_command(clone_cmd, timeout=300)
            action = "clone"

        result_msg = output.strip() if output.strip() else error.strip()
        # Sanitize — remove credentials from log messages
        result_msg = result_msg.replace(token, "***").replace(username, "***")

        if exit_code != 0:
            logger.warning(f"[Git] git {action} returned exit code {exit_code}: {result_msg}")

        logger.info(f"[Git] git {action} result: {result_msg}")

        # Step 2: List test categories from the tests directory
        cat_cmd = f'find {tests_dir} -mindepth 1 -maxdepth 1 -type d -printf "%f\\n" | sort'
        cat_output, cat_error, cat_code = ssh.execute_command(cat_cmd, timeout=15)

        categories = []
        if cat_code == 0 and cat_output.strip():
            categories = [d.strip() for d in cat_output.strip().split("\n")
                         if d.strip() and not d.strip().startswith("__")]

        # Update state
        _git_state["configured"] = True
        _git_state["host_id"] = host_id
        _git_state["host_name"] = dut.name
        _git_state["repo_url"] = repo_url
        _git_state["branch"] = branch
        _git_state["repo_name"] = repo_name
        _git_state["tests_path"] = tests_dir
        _git_state["categories_count"] = len(categories)
        _save_git_state()

        logger.info(f"[Git] Done. {len(categories)} categories found on {dut.name}")

        return {
            "status": "connected",
            "host_name": dut.name,
            "host_id": host_id,
            "repo_name": repo_name,
            "branch": branch,
            "action": action,
            "tests_path": tests_dir,
            "pull_message": result_msg,
            "categories_count": len(categories),
            "categories": categories,
        }

    finally:
        ssh.disconnect()

# Git state file — persists across server restarts
_GIT_STATE_FILE = DATA_DIR / "git_state.json"

@app.get("/api/git/status")
def get_git_status():
    """Get current Git configuration status."""
    if not _git_state["configured"]:
        return {"status": "disconnected"}

    return {
        "status": "connected",
        "host_id": _git_state.get("host_id"),
        "host_name": _git_state.get("host_name", ""),
        "repo_url": _git_state.get("repo_url", ""),
        "branch": _git_state.get("branch", "master"),
        "repo_name": _git_state.get("repo_name", ""),
        "tests_path": _git_state.get("tests_path", ""),
        "categories_count": _git_state.get("categories_count", 0),
    }


@app.get("/api/git/categories")
def get_git_categories(db: Session = Depends(get_db)):
    """List test category folders from the VM's Git repo tests directory via SSH."""
    if not _git_state["configured"]:
        raise HTTPException(status_code=400, detail="Git repo not connected. Select a VM and click Connect first.")

    host_id = _git_state.get("host_id")
    if not host_id:
        raise HTTPException(status_code=400, detail="No VM host configured")

    ssh, dut = _ssh_to_host(host_id, db)
    try:
        tests_dir = _git_state.get("tests_path", "")
        cmd = f'find {tests_dir} -mindepth 1 -maxdepth 1 -type d -printf "%f\\n" | sort'
        output, error, code = ssh.execute_command(cmd, timeout=15)
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to list categories: {error}")
        categories = [d.strip() for d in output.strip().split("\n")
                     if d.strip() and not d.strip().startswith("__")]
        return {"categories": categories, "base_path": tests_dir}
    finally:
        ssh.disconnect()


@app.get("/api/git/scripts/{category}")
def get_git_scripts(category: str, db: Session = Depends(get_db)):
    """List Python test scripts in a category folder on the VM (recursive)."""
    if not _git_state["configured"]:
        raise HTTPException(status_code=400, detail="Git repo not connected. Select a VM and click Connect first.")

    host_id = _git_state.get("host_id")
    if not host_id:
        raise HTTPException(status_code=400, detail="No VM host configured")

    ssh, dut = _ssh_to_host(host_id, db)
    try:
        tests_dir = _git_state.get("tests_path", "")
        category_path = f"{tests_dir}/{category}"
        cmd = f'find {category_path} -name "test_*.py" -type f | sort'
        output, error, code = ssh.execute_command(cmd, timeout=15)
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to list scripts: {error}")

        scripts = []
        for line in output.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            rel_path = line.replace(tests_dir + "/", "")
            name = os.path.basename(line)
            scripts.append({"name": name, "path": rel_path, "full_path": line})

        return {"scripts": scripts, "count": len(scripts), "category": category}
    finally:
        ssh.disconnect()


@app.post("/api/git/disconnect")
def disconnect_git():
    """Disconnect from Git repo (clear connection state)."""
    _git_state["configured"] = False
    _git_state["host_id"] = None
    _git_state["host_name"] = ""
    _git_state["repo_url"] = ""
    _git_state["branch"] = "master"
    _git_state["repo_name"] = ""
    _git_state["tests_path"] = ""
    _git_state["categories_count"] = 0
    _save_git_state()

    return {"status": "disconnected", "message": "Git repo disconnected"}


@app.get("/api/spytest/testbed-info")
def get_testbed_info(host_id: int, testbed: str, db: Session = Depends(get_db)):
    """Read and parse a testbed YAML file from the remote VM.

    Returns device count, device names, topology type, and link list.
    """
    ssh, dut = _ssh_to_host(host_id, db)
    try:
        testbed_path = f"{SPYTEST_TESTBED_DIR}/{testbed}"
        output, error, code = ssh.execute_command(f"cat {testbed_path}", timeout=15)
        if code != 0:
            raise HTTPException(status_code=500, detail=f"Failed to read testbed: {error.strip()}")
        config = yaml.safe_load(output) or {}
        devices = list(config.get("devices", {}).keys())
        topology = config.get("topology", {})

        # Deduplicated link list
        links = []
        seen: set = set()
        for dev_name, dev_topo in topology.items():
            if not isinstance(dev_topo, dict):
                continue
            for iface, link in dev_topo.get("interfaces", {}).items():
                if not isinstance(link, dict):
                    continue
                end_dev = link.get("EndDevice", "")
                end_port = link.get("EndPort", "")
                if end_dev:
                    key = tuple(sorted([f"{dev_name}:{iface}", f"{end_dev}:{end_port}"]))
                    if key not in seen:
                        seen.add(key)
                        links.append({
                            "from": f"{dev_name}:{iface}",
                            "to": f"{end_dev}:{end_port}",
                        })

        n = len(devices)
        if n == 0:
            topology_type = "empty"
        elif n == 1:
            topology_type = "standalone"
        elif n == 2:
            topology_type = "dual-dut"
        else:
            topology_type = f"{n}-node"

        return {
            "testbed": testbed,
            "device_count": n,
            "device_names": devices,
            "topology_type": topology_type,
            "link_count": len(links),
            "links": links,
        }
    finally:
        ssh.disconnect()


# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.get("/health")
def health_check():
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
    """Dashboard statistics."""
    return {
        "total_duts": db.query(DUT).count(),
        "online_duts": db.query(DUT).filter(DUT.status == "online").count(),
        "total_images": db.query(Image).count(),
        "total_scripts": db.query(Script).count(),
        "total_executions": db.query(Execution).count(),
        "running_executions": db.query(Execution).filter(
            Execution.status == "running",
            Execution.execution_type != "image"
        ).count(),
    }


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    import uvicorn

    print("=" * 60)
    print("  DUT Automation System — Lightweight Standalone")
    print("=" * 60)
    print(f"  Database: {DB_PATH}")
    print(f"  Images:   {IMAGES_DIR}")
    print(f"  Scripts:  {SCRIPTS_DIR}")
    print(f"  Logs:     {LOGS_DIR}")
    print("=" * 60)
    print("  Dashboard:  http://localhost:8000")
    print("  API Docs:   http://localhost:8000/docs")
    print("  Health:     http://localhost:8000/health")
    print("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info", reload=True)
