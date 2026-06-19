# ============================================================
# Execute Service — Eka Automation
# Handles: SpyTest execution, script execution, execution history,
#           log streaming WebSocket, queue management
# Port: 8002
# ============================================================

import os, json, re, yaml, time, asyncio, logging, subprocess, tempfile
from datetime import datetime, timedelta
from typing import List, Optional
from pathlib import Path
from threading import Thread, Lock

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean, or_, UniqueConstraint
from sqlalchemy.orm import declarative_base, sessionmaker, Session
import paramiko
from paramiko import AutoAddPolicy

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/dut_automation.db")

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False},
                           pool_size=10, max_overflow=20, pool_pre_ping=True)
else:
    engine = create_engine(DATABASE_URL, pool_size=10, max_overflow=20,
                           pool_timeout=30, pool_recycle=3600, pool_pre_ping=True)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ── Models (mirrors main.py) ───────────────────────────────────────────────────
class DUT(Base):
    __tablename__ = "duts"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    ip_address = Column(String(50), nullable=False)
    port = Column(Integer, default=22)
    device_type = Column(String(50), default="Linux")
    username = Column(String(100), default="admin")
    password = Column(String(255), default="")
    connection_type = Column(String(10), default="ssh")
    status = Column(String(20), default="offline")
    xml_path = Column(String(500), default="/home/hp/prajwal/VMs")
    session_id = Column(String(255), nullable=True, index=True)
    last_heartbeat = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)
    reserved_by = Column(String(100), nullable=True)
    reserved_at = Column(DateTime, nullable=True)
    reserved_until = Column(DateTime, nullable=True)
    __table_args__ = (UniqueConstraint('session_id', 'name', name='uq_session_dut_name'),)

class DUTLock(Base):
    __tablename__ = "dut_locks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_id = Column(Integer, nullable=False, unique=True)
    status = Column(String(20), default="AVAILABLE")
    job_id = Column(Integer, nullable=True)
    locked_since = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow)

class TopologyConnection(Base):
    __tablename__ = "topology_connections"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_a_id = Column(Integer, nullable=False)
    intf_a = Column(String(50), default="Ethernet0")
    dut_b_id = Column(Integer, nullable=False)
    intf_b = Column(String(50), default="Ethernet0")
    created_at = Column(DateTime, default=datetime.utcnow)

class Execution(Base):
    __tablename__ = "executions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    script_id = Column(Integer, nullable=True)
    dut_ids = Column(String(500))
    image_id = Column(Integer, nullable=True)
    execution_type = Column(String(20), default="script")
    status = Column(String(20), default="pending")
    session_id = Column(String(255), nullable=True, index=True)
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

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - execute-service - %(levelname)s - %(message)s")
logger = logging.getLogger("execute-service")

# SpyTest paths on remote host
SPYTEST_BASE = os.getenv("SPYTEST_BASE", "/home/hp_test/Eka/sonic-mgmt/spytest")
SPYTEST_VENV = f"{SPYTEST_BASE}/spytest_venv"
SPYTEST_PYTHON = f"{SPYTEST_VENV}/bin/python"
SPYTEST_BIN = f"{SPYTEST_BASE}/bin/spytest"

# ── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="Eka Execute Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_session_id(request: Request) -> str:
    return request.headers.get("X-Session-ID", "")

def verify_access(resource_session_id, current_session_id):
    if not current_session_id:
        return False
    if not resource_session_id:
        return True
    return resource_session_id == current_session_id

# ── SSH Connection Manager (own copy, isolated) ────────────────────────────────
class SSHManager:
    def __init__(self, host, port=22, username="admin", password=""):
        self.host, self.port, self.username, self.password = host, port, username, password
        self.client = None

    def connect(self) -> bool:
        try:
            self.client = paramiko.SSHClient()
            self.client.set_missing_host_key_policy(AutoAddPolicy())
            self.client.connect(hostname=self.host, port=self.port, username=self.username,
                                password=self.password, timeout=15, allow_agent=False,
                                look_for_keys=False)
            return True
        except Exception as e:
            logger.error(f"SSH connect failed to {self.host}: {e}")
            return False

    def execute_command(self, command, timeout=30):
        stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="ignore")
        err = stderr.read().decode("utf-8", errors="ignore")
        code = stdout.channel.recv_exit_status()
        return out, err, code

    def disconnect(self):
        if self.client:
            try: self.client.close()
            except: pass

# ── Execution Logging ──────────────────────────────────────────────────────────
def log_exec(db, execution_id, dut_name, level, message):
    entry = ExecutionLog(execution_id=execution_id, dut_name=dut_name,
                         log_level=level, message=message, timestamp=datetime.utcnow())
    db.add(entry)
    db.commit()

# ── Queue State (in-memory, per service) ──────────────────────────────────────
_queue_lock = Lock()
_active_executions = {}   # execution_id -> thread

# ── Health Check ──────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "service": "execute-service"}

# ── GET /api/executions ───────────────────────────────────────────────────────
@app.get("/api/executions")
def list_executions(request: Request, db: Session = Depends(get_db)):
    session_id = get_session_id(request)
    if not session_id:
        raise HTTPException(status_code=401, detail="Session ID required")
    executions = db.query(Execution).filter(Execution.session_id == session_id)\
                   .order_by(Execution.created_at.desc()).limit(100).all()
    return [{"id": ex.id, "name": ex.name, "type": ex.execution_type,
             "status": ex.status, "dut_count": len(json.loads(ex.dut_ids)) if ex.dut_ids else 0,
             "duration": ex.duration_seconds,
             "created_at": ex.created_at.isoformat() if ex.created_at else None}
            for ex in executions]

# ── GET /api/executions/{id} ──────────────────────────────────────────────────
@app.get("/api/executions/{execution_id}")
def get_execution(execution_id: int, request: Request, db: Session = Depends(get_db)):
    session_id = get_session_id(request)
    execution = db.query(Execution).filter(Execution.id == execution_id).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    if not verify_access(execution.session_id, session_id):
        raise HTTPException(status_code=403, detail="Access denied")
    return {"id": execution.id, "name": execution.name, "type": execution.execution_type,
            "status": execution.status,
            "dut_ids": json.loads(execution.dut_ids) if execution.dut_ids else [],
            "duration": execution.duration_seconds,
            "start_time": execution.start_time.isoformat() if execution.start_time else None,
            "end_time": execution.end_time.isoformat() if execution.end_time else None}

# ── GET /api/executions/{id}/logs ─────────────────────────────────────────────
@app.get("/api/executions/{execution_id}/logs")
def get_execution_logs(execution_id: int, request: Request,
                       limit: int = 200, offset: int = 0,
                       db: Session = Depends(get_db)):
    session_id = get_session_id(request)
    execution = db.query(Execution).filter(Execution.id == execution_id).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    if not verify_access(execution.session_id, session_id):
        raise HTTPException(status_code=403, detail="Access denied")
    logs = db.query(ExecutionLog).filter(ExecutionLog.execution_id == execution_id)\
             .order_by(ExecutionLog.timestamp.asc()).offset(offset).limit(limit).all()
    return [{"id": l.id, "dut_name": l.dut_name, "level": l.log_level,
             "message": l.message,
             "timestamp": l.timestamp.isoformat() if l.timestamp else None} for l in logs]

# ── DELETE /api/executions/{id}/logs ──────────────────────────────────────────
@app.delete("/api/executions/{execution_id}/logs")
def delete_execution_logs(execution_id: int, body: dict, request: Request,
                          db: Session = Depends(get_db)):
    session_id = get_session_id(request)
    execution = db.query(Execution).filter(Execution.id == execution_id).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    if not verify_access(execution.session_id, session_id):
        raise HTTPException(status_code=403, detail="Access denied")
    scope = body.get("scope", "all")
    try:
        deleted_count = db.query(ExecutionLog).filter(
            ExecutionLog.execution_id == execution_id).delete(synchronize_session=False)
        db.delete(execution)
        db.commit()
        return {"status": "success", "deleted_count": deleted_count,
                "scope": scope, "execution_id": execution_id}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

# ── POST /api/spytest/start ───────────────────────────────────────────────────
@app.post("/api/spytest/start")
def start_spytest(body: dict, request: Request, db: Session = Depends(get_db)):
    """Start a SpyTest execution on a remote VM."""
    session_id = get_session_id(request)
    if not session_id:
        raise HTTPException(status_code=401, detail="Session ID required")

    vm_id = body.get("vm_id")
    script_paths = body.get("script_paths", [])
    dut_ids = body.get("dut_ids", [])
    testbed_yaml = body.get("testbed_yaml", "")
    log_level = body.get("log_level", "info")

    if not vm_id or not script_paths:
        raise HTTPException(status_code=400, detail="vm_id and script_paths required")

    vm = db.query(DUT).filter(DUT.id == vm_id, DUT.session_id == session_id).first()
    if not vm:
        raise HTTPException(status_code=404, detail="VM not found or access denied")

    execution = Execution(
        name=f"spytest_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}",
        execution_type="spytest",
        dut_ids=json.dumps(dut_ids),
        status="pending",
        session_id=session_id,
    )
    db.add(execution)
    db.commit()
    db.refresh(execution)

    thread = Thread(target=_run_spytest_background,
                    args=(execution.id, vm, script_paths, dut_ids, testbed_yaml, log_level, db),
                    daemon=True)
    thread.start()
    with _queue_lock:
        _active_executions[execution.id] = thread

    return {"execution_id": execution.id, "status": "started",
            "message": f"SpyTest execution started with {len(script_paths)} script(s)"}

def _run_spytest_background(execution_id, vm, script_paths, dut_ids, testbed_yaml, log_level, _):
    """Run SpyTest scripts on remote VM via SSH."""
    db = SessionLocal()
    execution = None
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        log_exec(db, execution_id, "SYSTEM", "INFO",
                 f"Starting SpyTest execution — {len(script_paths)} script(s)")

        ssh = SSHManager(vm.ip_address, vm.port, vm.username, vm.password)
        if not ssh.connect():
            log_exec(db, execution_id, "SYSTEM", "ERROR",
                     f"Cannot connect to VM {vm.name} ({vm.ip_address}:{vm.port})")
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
            return

        try:
            for script_path in script_paths:
                # Check if execution was cancelled
                db.refresh(execution)
                if execution.status == "failed":
                    log_exec(db, execution_id, "SYSTEM", "WARNING", "Execution cancelled by user")
                    break

                log_exec(db, execution_id, "SYSTEM", "INFO",
                         f"═══ Running: {os.path.basename(script_path)} ═══")

                cmd = (f"cd {SPYTEST_BASE} && "
                       f"source {SPYTEST_VENV}/bin/activate && "
                       f"{SPYTEST_PYTHON} {SPYTEST_BIN} "
                       f"--log-level {log_level} "
                       f"--testbed-file /tmp/eka_testbed.yaml "
                       f"{script_path} 2>&1")

                log_exec(db, execution_id, "SYSTEM", "INFO", f"$ {cmd[:200]}")

                try:
                    out, err, code = ssh.execute_command(cmd, timeout=3600)
                    for line in (out + err).splitlines()[:500]:
                        level = "ERROR" if any(k in line.lower() for k in ["error", "fail", "exception"]) else "INFO"
                        log_exec(db, execution_id, vm.name, level, line)
                    status_msg = "✓ PASSED" if code == 0 else f"✗ FAILED (exit {code})"
                    log_exec(db, execution_id, "SYSTEM", "INFO",
                             f"Script {os.path.basename(script_path)}: {status_msg}")
                except Exception as e:
                    log_exec(db, execution_id, "SYSTEM", "ERROR", f"Script error: {e}")

            execution.status = "completed"
        finally:
            ssh.disconnect()

    except Exception as e:
        logger.error(f"SpyTest execution failed: {e}")
        if execution:
            execution.status = "failed"
    finally:
        if execution:
            execution.end_time = datetime.utcnow()
            if execution.start_time:
                execution.duration_seconds = int(
                    (execution.end_time - execution.start_time).total_seconds())
            db.commit()
        db.close()
        with _queue_lock:
            _active_executions.pop(execution_id, None)

# ── POST /api/spytest/stop ────────────────────────────────────────────────────
@app.post("/api/spytest/stop/{execution_id}")
def stop_spytest(execution_id: int, request: Request, db: Session = Depends(get_db)):
    session_id = get_session_id(request)
    execution = db.query(Execution).filter(Execution.id == execution_id).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    if not verify_access(execution.session_id, session_id):
        raise HTTPException(status_code=403, detail="Access denied")
    execution.status = "failed"
    db.commit()
    return {"status": "stopped", "execution_id": execution_id}

# ── GET /api/spytest/queue ────────────────────────────────────────────────────
@app.get("/api/spytest/queue")
def get_queue_status(request: Request, db: Session = Depends(get_db)):
    session_id = get_session_id(request)
    running = db.query(Execution).filter(
        Execution.session_id == session_id,
        Execution.status == "running"
    ).all()
    return {"running_count": len(running),
            "running": [{"id": e.id, "name": e.name} for e in running]}

# ── GET /api/spytest/scripts ──────────────────────────────────────────────────
@app.get("/api/spytest/scripts")
def list_scripts(vm_id: int, path: str = "", request: Request = None,
                 db: Session = Depends(get_db)):
    """List test scripts on remote VM."""
    session_id = request.headers.get("X-Session-ID", "") if request else ""
    vm = db.query(DUT).filter(DUT.id == vm_id).first()
    if not vm:
        raise HTTPException(status_code=404, detail="VM not found")

    ssh = SSHManager(vm.ip_address, vm.port, vm.username, vm.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail="Cannot connect to VM")

    try:
        base = f"{SPYTEST_BASE}/tests"
        target = f"{base}/{path}" if path else base
        out, err, code = ssh.execute_command(
            f"find {target} -maxdepth 1 \\( -type f -name '*.py' -o -type d \\) | sort", timeout=15)
        files, folders = [], []
        for line in out.strip().splitlines():
            line = line.strip()
            if not line or line == target:
                continue
            rel = line[len(base):].lstrip("/")
            if line.endswith(".py"):
                files.append({"name": os.path.basename(line), "path": rel, "type": "file"})
            else:
                folders.append({"name": os.path.basename(line), "path": rel, "type": "folder"})
        return {"base_path": base, "current_path": path,
                "folders": folders, "files": files,
                "total": len(files), "total_folders": len(folders)}
    finally:
        ssh.disconnect()

# ── POST /api/topology/connections ────────────────────────────────────────────
@app.get("/api/topology/connections")
def get_topology(request: Request, db: Session = Depends(get_db)):
    session_id = get_session_id(request)
    conns = db.query(TopologyConnection).all()
    return [{"id": c.id, "dut_a_id": c.dut_a_id, "intf_a": c.intf_a,
             "dut_b_id": c.dut_b_id, "intf_b": c.intf_b} for c in conns]

@app.post("/api/topology/connections")
def create_topology_connection(body: dict, db: Session = Depends(get_db)):
    conn = TopologyConnection(
        dut_a_id=body["dut_a_id"], intf_a=body.get("intf_a", "Ethernet0"),
        dut_b_id=body["dut_b_id"], intf_b=body.get("intf_b", "Ethernet0"))
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return {"id": conn.id, "status": "created"}

@app.delete("/api/topology/connections/{conn_id}")
def delete_topology_connection(conn_id: int, db: Session = Depends(get_db)):
    conn = db.query(TopologyConnection).filter(TopologyConnection.id == conn_id).first()
    if conn:
        db.delete(conn)
        db.commit()
    return {"status": "deleted"}

@app.delete("/api/topology/connections")
def clear_topology_connections(db: Session = Depends(get_db)):
    db.query(TopologyConnection).delete()
    db.commit()
    return {"status": "cleared"}

# ── WebSocket: Real-time Log Streaming ────────────────────────────────────────
@app.websocket("/ws/execution/{execution_id}")
async def ws_execution_logs(websocket: WebSocket, execution_id: int):
    await websocket.accept()
    db = SessionLocal()
    try:
        last_log_id = 0
        while True:
            new_logs = db.query(ExecutionLog).filter(
                ExecutionLog.execution_id == execution_id,
                ExecutionLog.id > last_log_id
            ).order_by(ExecutionLog.timestamp.asc()).all()
            for log in new_logs:
                await websocket.send_json({
                    "id": log.id, "dut_name": log.dut_name, "level": log.log_level,
                    "message": log.message,
                    "timestamp": log.timestamp.isoformat() if log.timestamp else None
                })
                last_log_id = log.id
            execution = db.query(Execution).filter(Execution.id == execution_id).first()
            if execution and execution.status in ["completed", "failed"]:
                db.expire_all()
                remaining = db.query(ExecutionLog).filter(
                    ExecutionLog.execution_id == execution_id,
                    ExecutionLog.id > last_log_id).all()
                for log in remaining:
                    await websocket.send_json({
                        "id": log.id, "dut_name": log.dut_name, "level": log.log_level,
                        "message": log.message,
                        "timestamp": log.timestamp.isoformat() if log.timestamp else None})
                await websocket.send_json({"type": "execution_complete",
                                           "status": execution.status,
                                           "duration": execution.duration_seconds})
                break
            db.expire_all()
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        db.close()
