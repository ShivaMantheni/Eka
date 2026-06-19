# ============================================================
# VS Manager Service — Eka Automation
# Handles: Virtual System lifecycle (virsh), VM list, XML files,
#           VS image update (single + batch), progress streaming WebSocket
# Port: 8003
# ============================================================

import os, json, logging, asyncio
from datetime import datetime
from pathlib import Path
from threading import Thread

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean, UniqueConstraint
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

# ── Models ─────────────────────────────────────────────────────────────────────
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

# ── Config ─────────────────────────────────────────────────────────────────────
VS_SOURCE_IMAGE = os.getenv("VS_SOURCE_IMAGE", "/home/hp/anuradha_build_imgs/target/sonic-vs.img")
VS_IMAGES_PATH = "/var/lib/libvirt/images/"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - vs-service - %(levelname)s - %(message)s")
logger = logging.getLogger("vs-service")

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Eka VS Manager Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

# ── SSH Manager (own isolated copy) ───────────────────────────────────────────
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
            logger.error(f"SSH connect failed: {e}")
            return False

    def execute_command(self, command, timeout=300):
        stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="ignore")
        err = stderr.read().decode("utf-8", errors="ignore")
        code = stdout.channel.recv_exit_status()
        return out, err, code

    def disconnect(self):
        if self.client:
            try: self.client.close()
            except: pass

def log_exec(db, execution_id, dut_name, level, message):
    entry = ExecutionLog(execution_id=execution_id, dut_name=dut_name,
                         log_level=level, message=message, timestamp=datetime.utcnow())
    db.add(entry)
    db.commit()

# ── Health ─────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "service": "vs-service"}

# ── GET /api/vs/list/{dut_id} ─────────────────────────────────────────────────
@app.get("/api/vs/list/{dut_id}")
def list_vms(dut_id: int, db: Session = Depends(get_db)):
    """List all VMs on a host device via 'virsh list --all'."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")
    if dut.status != "online":
        raise HTTPException(status_code=425,
                            detail=f"Device {dut.name} is {dut.status}. Wait for it to come online.")

    ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")

    try:
        safe_pass = dut.password.replace("'", "'\\''") if dut.password else ""
        cmd = f"echo '{safe_pass}' | sudo -S virsh list --all" if dut.password else "sudo virsh list --all"
        output, error, exit_code = ssh.execute_command(cmd, timeout=30)
        if exit_code != 0:
            raise HTTPException(status_code=500, detail=f"virsh list failed: {error.strip()}")

        vms = []
        for line in output.strip().split("\n")[2:]:
            parts = line.strip().split()
            if len(parts) >= 2:
                vms.append({"id": parts[0] if parts[0] != "-" else None,
                             "name": parts[1],
                             "state": " ".join(parts[2:]) if len(parts) > 2 else "unknown"})
        return {"dut_id": dut_id, "dut_name": dut.name, "vms": vms}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        ssh.disconnect()

# ── GET /api/vs/xml-files/{dut_id} ────────────────────────────────────────────
@app.get("/api/vs/xml-files/{dut_id}")
def list_xml_files(dut_id: int, db: Session = Depends(get_db)):
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    xml_path = dut.xml_path or "/home/hp/prajwal/VMs"
    ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")

    try:
        output, _, _ = ssh.execute_command(f"ls -1 {xml_path}/*.xml 2>/dev/null", timeout=10)
        xml_files = [{"full_path": line.strip(),
                      "filename": os.path.basename(line.strip())}
                     for line in output.strip().split("\n") if line.strip().endswith(".xml")]
        return {"dut_id": dut_id, "xml_files": xml_files, "xml_path": xml_path}
    finally:
        ssh.disconnect()

# ── POST /api/vs/update-image ─────────────────────────────────────────────────
@app.post("/api/vs/update-image")
def update_vs_image(body: dict, db: Session = Depends(get_db)):
    """Start VS image update for a single VM."""
    dut_id = body.get("dut_id")
    vs_name = body.get("vs_name", "").strip()
    source_image = body.get("source_image_path", VS_SOURCE_IMAGE).strip()
    target_image_name = body.get("target_image_name", "").strip()
    source_server_id = body.get("source_server_id")

    if not dut_id or not vs_name:
        raise HTTPException(status_code=400, detail="dut_id and vs_name are required")

    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    if not target_image_name:
        target_image_name = f"{vs_name}.img"

    xml_path = dut.xml_path or "/home/hp/prajwal/VMs"
    target_image_path = f"{VS_IMAGES_PATH}{target_image_name}"

    execution = Execution(
        name=f"vs_update_{vs_name}_{int(datetime.utcnow().timestamp())}",
        execution_type="image", dut_ids=json.dumps([dut_id]), status="pending")
    db.add(execution)
    db.commit()
    db.refresh(execution)

    thread = Thread(target=_run_vs_update,
                    args=(execution.id, dut_id, vs_name, f"{xml_path}/{vs_name}.xml",
                          source_image, target_image_path, source_server_id),
                    daemon=True)
    thread.start()

    return {"execution_id": execution.id, "status": "started",
            "vs_name": vs_name,
            "message": f"VS image update started for '{vs_name}' on {dut.name}"}

# ── POST /api/vs/update-image-batch ───────────────────────────────────────────
@app.post("/api/vs/update-image-batch")
def update_vs_image_batch(body: dict, db: Session = Depends(get_db)):
    """Batch VS image update for multiple VMs."""
    dut_id = body.get("dut_id")
    source_image = body.get("source_image_path", VS_SOURCE_IMAGE).strip()
    vs_entries = body.get("vs_entries")
    if not vs_entries:
        vs_names = body.get("vs_names", [])
        target_name = body.get("target_image_name", "").strip()
        vs_entries = [{"vs_name": n, "target_image_name": target_name} for n in vs_names]

    if not dut_id or not vs_entries:
        raise HTTPException(status_code=400, detail="dut_id and vs_entries required")

    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    execution = Execution(
        name=f"vs_batch_{len(vs_entries)}vms_{int(datetime.utcnow().timestamp())}",
        execution_type="image", dut_ids=json.dumps([dut_id]), status="pending")
    db.add(execution)
    db.commit()
    db.refresh(execution)

    thread = Thread(target=_run_vs_batch_update,
                    args=(execution.id, dut, vs_entries, source_image),
                    daemon=True)
    thread.start()

    return {"execution_id": execution.id, "status": "started",
            "vs_count": len(vs_entries),
            "message": f"VS batch update started for {len(vs_entries)} VM(s) on {dut.name}"}

def _sudocmd(password: str, cmd: str) -> str:
    safe = password.replace("'", "'\\''")
    return f"echo '{safe}' | sudo -S {cmd}"

def _run_vs_update(execution_id, dut_id, vs_name, xml_full_path,
                   source_image, target_image_path, source_server_id=None):
    db = SessionLocal()
    execution = None
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        dut = db.query(DUT).filter(DUT.id == dut_id).first()
        if not dut:
            log_exec(db, execution_id, "SYSTEM", "ERROR", "DUT not found")
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
            return

        log_exec(db, execution_id, dut.name, "INFO",
                 f"Starting VS image update for '{vs_name}'")

        ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
        if not ssh.connect():
            log_exec(db, execution_id, dut.name, "ERROR",
                     f"SSH connection FAILED to {dut.ip_address}:{dut.port}")
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
            return

        try:
            IMAGES_DIR = "/var/lib/libvirt/images"
            steps = [
                ("Step 1/4: Destroying VM",
                 f"virsh destroy {vs_name}", True),
                ("Step 2/4: Removing old image",
                 _sudocmd(dut.password, f"rm -f {target_image_path}"), False),
                ("Step 3/4: Copying new image",
                 _sudocmd(dut.password, f"cp {source_image} {target_image_path}"), False),
                ("Step 4/4: Starting VM",
                 f"virsh start {vs_name}", False),
            ]

            all_ok = True
            for step_name, command, allow_fail in steps:
                log_exec(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
                try:
                    output, error, exit_code = ssh.execute_command(command, timeout=600)
                    if output.strip():
                        for line in output.strip().split("\n")[:20]:
                            log_exec(db, execution_id, dut.name, "INFO", f"    {line}")
                    if exit_code != 0:
                        msg = error.strip() or f"Exit code {exit_code}"
                        if allow_fail:
                            log_exec(db, execution_id, dut.name, "WARNING",
                                     f"  ⚠ {step_name} (allowed): {msg}")
                        else:
                            log_exec(db, execution_id, dut.name, "ERROR",
                                     f"  ✗ {step_name} FAILED: {msg}")
                            all_ok = False
                            break
                    else:
                        log_exec(db, execution_id, dut.name, "INFO",
                                 f"  ✓ {step_name} completed")
                except Exception as e:
                    log_exec(db, execution_id, dut.name, "ERROR", f"  ✗ {step_name} error: {e}")
                    all_ok = False
                    break

            execution.status = "completed" if all_ok else "failed"
            msg = "✓ VS image update completed successfully" if all_ok else "✗ VS image update FAILED"
            log_exec(db, execution_id, dut.name, "INFO" if all_ok else "ERROR", msg)

        finally:
            ssh.disconnect()

        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds())
        db.commit()

    except Exception as e:
        logger.error(f"VS update failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
    finally:
        db.close()

def _run_vs_batch_update(execution_id, dut, vs_entries, source_image):
    db = SessionLocal()
    execution = None
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        total = len(vs_entries)
        log_exec(db, execution_id, "SYSTEM", "INFO",
                 f"═══ Batch VS update: {total} VM(s) ═══")

        ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
        if not ssh.connect():
            log_exec(db, execution_id, dut.name, "ERROR", "SSH connection FAILED")
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
            return

        IMAGES_DIR = "/var/lib/libvirt/images"
        try:
            all_success = True
            for idx, entry in enumerate(vs_entries, 1):
                vs_name = entry.get("vs_name", "").strip()
                per_vm_target = entry.get("target_image_name", "").strip()
                if not vs_name:
                    continue
                target_name = per_vm_target if per_vm_target else f"{vs_name}.img"
                log_exec(db, execution_id, dut.name, "INFO",
                         f"══ VM {idx}/{total}: {vs_name} (target: {target_name}) ══")

                steps = [
                    ("Step 1/4: Destroying VM", f"virsh destroy {vs_name}", True),
                    ("Step 2/4: Removing old image",
                     _sudocmd(dut.password, f"rm -f {IMAGES_DIR}/{target_name}"), False),
                    ("Step 3/4: Copying new image",
                     _sudocmd(dut.password, f"cp {source_image} {IMAGES_DIR}/{target_name}"), False),
                    ("Step 4/4: Starting VM", f"virsh start {vs_name}", False),
                ]
                vm_ok = True
                for step_name, command, allow_fail in steps:
                    log_exec(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
                    try:
                        output, error, exit_code = ssh.execute_command(command, timeout=600)
                        if output.strip():
                            for line in output.strip().split("\n")[:20]:
                                log_exec(db, execution_id, dut.name, "INFO", f"    {line}")
                        if exit_code != 0:
                            msg = error.strip() or f"Exit code {exit_code}"
                            if allow_fail:
                                log_exec(db, execution_id, dut.name, "WARNING",
                                         f"  ⚠ {step_name}: {msg}")
                            else:
                                log_exec(db, execution_id, dut.name, "ERROR",
                                         f"  ✗ {step_name} FAILED: {msg}")
                                vm_ok = False
                                break
                        else:
                            log_exec(db, execution_id, dut.name, "INFO",
                                     f"  ✓ {step_name} completed")
                    except Exception as e:
                        log_exec(db, execution_id, dut.name, "ERROR", f"  ✗ error: {e}")
                        vm_ok = False
                        break

                if not vm_ok:
                    all_success = False
                    log_exec(db, execution_id, dut.name, "ERROR", f"✗ Failed for '{vs_name}'")
                else:
                    log_exec(db, execution_id, dut.name, "INFO", f"✓ '{vs_name}' updated")

            summary = "All VMs updated successfully" if all_success else "Some VMs failed"
            log_exec(db, execution_id, "SYSTEM", "INFO" if all_success else "WARNING",
                     f"═══ Batch complete: {summary} ═══")
            execution.status = "completed"
        finally:
            ssh.disconnect()

        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds())
        db.commit()

    except Exception as e:
        logger.error(f"VS batch update failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
    finally:
        db.close()

# ── WebSocket: VS Update Log Streaming ────────────────────────────────────────
@app.websocket("/ws/execution/{execution_id}")
async def ws_vs_logs(websocket: WebSocket, execution_id: int):
    await websocket.accept()
    db = SessionLocal()
    last_log_id = 0
    try:
        while True:
            new_logs = db.query(ExecutionLog).filter(
                ExecutionLog.execution_id == execution_id,
                ExecutionLog.id > last_log_id
            ).order_by(ExecutionLog.timestamp.asc()).all()
            for log in new_logs:
                await websocket.send_json({
                    "id": log.id, "dut_name": log.dut_name, "level": log.log_level,
                    "message": log.message,
                    "timestamp": log.timestamp.isoformat() if log.timestamp else None})
                last_log_id = log.id

            execution = db.query(Execution).filter(Execution.id == execution_id).first()
            if execution and execution.status in ["completed", "failed"]:
                await websocket.send_json({"type": "execution_complete",
                                           "status": execution.status,
                                           "duration": execution.duration_seconds})
                break
            db.expire_all()
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"VS WS error: {e}")
    finally:
        db.close()
