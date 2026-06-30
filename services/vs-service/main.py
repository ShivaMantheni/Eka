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

# ── SSH Manager ────────────────────────────────────────────────────────────────
class SSHManager:
    """SSH manager for VS-service with retry-on-connect and reconnect-on-drop."""

    MAX_CONNECT_RETRIES = 4
    CONNECT_BACKOFF     = [0, 3, 8, 20]
    MAX_CMD_RETRIES     = 3
    CMD_BACKOFF         = [0, 2, 5]

    def __init__(self, host, port=22, username="admin", password=""):
        self.host, self.port, self.username, self.password = host, port, username, password
        self.client = None

    def _is_alive(self) -> bool:
        try:
            if not self.client:
                return False
            t = self.client.get_transport()
            if not t or not t.is_active():
                return False
            t.send_ignore()
            return True
        except Exception:
            return False

    def _open_client(self) -> bool:
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(AutoAddPolicy())
            c.connect(hostname=self.host, port=self.port, username=self.username,
                      password=self.password, timeout=15, allow_agent=False,
                      look_for_keys=False, banner_timeout=15, auth_timeout=15)
            t = c.get_transport()
            if t:
                t.set_keepalive(15)
            self.client = c
            return True
        except paramiko.AuthenticationException as e:
            logger.error(f"SSH auth failed {self.username}@{self.host} — {e}")
            return False
        except Exception as e:
            logger.warning(f"SSH connect attempt failed {self.host}:{self.port} — {e}")
            return False

    def connect(self, retries: int = MAX_CONNECT_RETRIES) -> bool:
        import time as _time
        for attempt in range(retries):
            delay = self.CONNECT_BACKOFF[min(attempt, len(self.CONNECT_BACKOFF) - 1)]
            if delay:
                _time.sleep(delay)
            if self._open_client():
                logger.info(f"SSH connected to {self.host}:{self.port} (attempt {attempt + 1})")
                return True
        logger.error(f"SSH connection failed after {retries} attempts: {self.host}:{self.port}")
        return False

    def reconnect(self) -> bool:
        try:
            if self.client:
                self.client.close()
        except Exception:
            pass
        self.client = None
        return self.connect()

    def execute_command(self, command, timeout=300, cmd_retries=MAX_CMD_RETRIES):
        import time as _time
        last_exc = None
        for attempt in range(cmd_retries):
            delay = self.CMD_BACKOFF[min(attempt, len(self.CMD_BACKOFF) - 1)]
            if delay:
                _time.sleep(delay)
            if not self._is_alive():
                logger.warning(f"[SSH-VS] {self.host} connection dead (attempt {attempt + 1}) — reconnecting")
                if not self.reconnect():
                    last_exc = Exception(f"Reconnect failed (attempt {attempt + 1})")
                    continue
            try:
                stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
                out  = stdout.read().decode("utf-8", errors="ignore")
                err  = stderr.read().decode("utf-8", errors="ignore")
                code = stdout.channel.recv_exit_status()
                return out, err, code
            except Exception as e:
                logger.warning(f"[SSH-VS] Command failed on {self.host} (attempt {attempt + 1}): {e}")
                last_exc = e
                self.client = None
        raise last_exc or Exception(f"Command failed after {cmd_retries} attempts on {self.host}")

    def disconnect(self):
        if self.client:
            try:
                self.client.close()
            except Exception:
                pass
            finally:
                self.client = None

def log_exec(db, execution_id, dut_name, level, message):
    entry = ExecutionLog(execution_id=execution_id, dut_name=dut_name,
                         log_level=level, message=message, timestamp=datetime.utcnow())
    db.add(entry)
    db.commit()

def _sudocmd(password: str, cmd: str) -> str:
    safe = password.replace("'", "'\\''")
    return f"echo '{safe}' | sudo -S {cmd}"

def _extract_image_path_from_xml(ssh: SSHManager, xml_full_path: str) -> str:
    """Read the VS XML on the remote host and return the disk image path."""
    extract_cmd = _sudocmd_static(
        f"python3 -c \""
        f"import xml.etree.ElementTree as ET; "
        f"root = ET.parse('{xml_full_path}').getroot(); "
        f"matches = [d.find('source').get('file') for d in root.iter('disk') "
        f"if d.get('device')=='disk' and d.find('source') is not None]; "
        f"print(matches[0] if matches else '')\""
    )
    out, err, rc = ssh.execute_command(extract_cmd, timeout=15)
    return out.strip()

def _sudocmd_static(cmd: str) -> str:
    return f"sudo {cmd}"

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

# ── POST /api/vs/{dut_id}/action ──────────────────────────────────────────────
@app.post("/api/vs/{dut_id}/action")
def vs_action(dut_id: int, body: dict, db: Session = Depends(get_db)):
    """Quick VM action: start, destroy, reboot, shutdown, suspend, resume."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    vs_name = body.get("vs_name", "").strip()
    action = body.get("action", "").strip().lower()

    if not vs_name or not action:
        raise HTTPException(status_code=400, detail="vs_name and action are required")

    allowed = ["start", "destroy", "reboot", "shutdown", "suspend", "resume"]
    if action not in allowed:
        raise HTTPException(status_code=400, detail=f"Invalid action. Allowed: {', '.join(allowed)}")

    ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail=f"Cannot connect to {dut.name}")

    try:
        if dut.password:
            safe_pass = dut.password.replace("'", "'\\''")
            command = f"echo '{safe_pass}' | sudo -S virsh {action} {vs_name}"
        else:
            command = f"sudo virsh {action} {vs_name}"

        output, error, exit_code = ssh.execute_command(command, timeout=30)
        if exit_code != 0:
            return {"status": "error", "vs_name": vs_name, "action": action,
                    "message": error.strip() or f"Command failed (exit {exit_code})"}
        return {"status": "success", "vs_name": vs_name, "action": action,
                "message": output.strip() or f"'{action}' executed on '{vs_name}'"}
    finally:
        ssh.disconnect()

# ── POST /api/vs/update-image ─────────────────────────────────────────────────
@app.post("/api/vs/update-image")
def update_vs_image(body: dict, db: Session = Depends(get_db)):
    """Start VS image update for a single VM. Image path resolved from XML."""
    dut_id = body.get("dut_id")
    vs_name = body.get("vs_name", "").strip()
    source_image = body.get("source_image_path", VS_SOURCE_IMAGE).strip()
    source_server_id = body.get("source_server_id")

    if not dut_id or not vs_name:
        raise HTTPException(status_code=400, detail="dut_id and vs_name are required")

    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    xml_path = dut.xml_path or "/home/hp/prajwal/VMs"
    xml_full_path = f"{xml_path}/{vs_name}.xml"

    execution = Execution(
        name=f"vs_update_{vs_name}_{int(datetime.utcnow().timestamp())}",
        execution_type="image", dut_ids=json.dumps([dut_id]), status="pending")
    db.add(execution)
    db.commit()
    db.refresh(execution)

    thread = Thread(target=_run_vs_update,
                    args=(execution.id, dut_id, vs_name, xml_full_path, source_image),
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
        vs_entries = [{"vs_name": n} for n in vs_names]

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

# ── Background: single VM update (6-step, matches frontend stepMap) ───────────
def _run_vs_update(execution_id, dut_id, vs_name, xml_full_path, source_image,
                   source_server_id=None):
    db = SessionLocal()
    execution = None
    dut = None
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        dut = db.query(DUT).filter(DUT.id == dut_id).first()
        if not dut:
            log_exec(db, execution_id, "SYSTEM", "ERROR", "DUT not found")
            execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

        source_server = None
        if source_server_id:
            source_server = db.query(DUT).filter(DUT.id == source_server_id).first()

        log_exec(db, execution_id, dut.name, "INFO", f"Starting VS image update for '{vs_name}'")
        log_exec(db, execution_id, dut.name, "INFO",
                 f"  Copy method: {'SCP from ' + source_server.name if source_server else 'Local copy on Host Device'}")
        log_exec(db, execution_id, dut.name, "INFO", f"  Source image: {source_image}")
        log_exec(db, execution_id, dut.name, "INFO", f"  XML file: {xml_full_path}")

        ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
        if not ssh.connect():
            log_exec(db, execution_id, dut.name, "ERROR",
                     f"SSH connection FAILED to {dut.ip_address}:{dut.port}")
            execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

        def sudocmd(cmd):
            safe = dut.password.replace("'", "'\\''")
            return f"echo '{safe}' | sudo -S {cmd}"

        def run_step(step_name, command, allow_fail=False, timeout=120):
            log_exec(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
            log_exec(db, execution_id, dut.name, "INFO", f"  $ {command}")
            output, error, exit_code = ssh.execute_command(command, timeout=timeout)
            if output.strip():
                for line in output.strip().split("\n")[:20]:
                    log_exec(db, execution_id, dut.name, "INFO", f"    {line}")
            if exit_code != 0:
                msg = error.strip() or f"Exit code {exit_code}"
                if allow_fail:
                    log_exec(db, execution_id, dut.name, "WARNING",
                             f"  ⚠ {step_name} (allowed): {msg}")
                    return True
                log_exec(db, execution_id, dut.name, "ERROR", f"  ✗ {step_name} FAILED: {msg}")
                return False
            log_exec(db, execution_id, dut.name, "INFO", f"  ✓ {step_name} completed successfully")
            return True

        try:
            # Resolve target image path from XML
            log_exec(db, execution_id, dut.name, "INFO",
                     f"▶ Resolving image path from XML: {xml_full_path}")
            extract_cmd = sudocmd(
                f"python3 -c \""
                f"import xml.etree.ElementTree as ET; "
                f"root = ET.parse('{xml_full_path}').getroot(); "
                f"matches = [d.find('source').get('file') for d in root.iter('disk') "
                f"if d.get('device')=='disk' and d.find('source') is not None]; "
                f"print(matches[0] if matches else '')\""
            )
            xml_out, xml_err, xml_rc = ssh.execute_command(extract_cmd, timeout=15)
            target_image_path = xml_out.strip()
            if xml_rc != 0 or not target_image_path:
                log_exec(db, execution_id, dut.name, "ERROR",
                         f"  ✗ Could not resolve image path from XML: "
                         f"{xml_err.strip() or 'No <disk device=disk> source found'}")
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return
            log_exec(db, execution_id, dut.name, "INFO", f"  ✓ Target path (from XML): {target_image_path}")
            log_exec(db, execution_id, dut.name, "INFO",
                     f"  Will copy: {source_image} → {target_image_path}")

            # Step 1/6 — Destroy VM
            if not run_step("Step 1/6: Destroying VM", sudocmd(f"virsh destroy {vs_name}"), allow_fail=True):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Step 2/6 — Remove old image (path comes from XML)
            if not run_step("Step 2/6: Removing old image", sudocmd(f"rm -f {target_image_path}")):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Step 3/6 — Copy source image to XML-defined target path (cp src → target renames to XML name)
            all_ok = True
            if source_server:
                log_exec(db, execution_id, dut.name, "INFO",
                         "▶ Step 3/6: Copying image from remote server (SCP)")
                dest_temp = f"/tmp/{os.path.basename(target_image_path)}"
                safe_pass = source_server.password.replace("'", "'\\''")
                port_flag = f"-P {source_server.port}" if source_server.port != 22 else ""
                scp_cmd = (f"sshpass -p '{safe_pass}' scp {port_flag} -o StrictHostKeyChecking=no "
                           f"{source_server.username}@{source_server.ip_address}:{source_image} {dest_temp}")
                output, error, exit_code = ssh.execute_command(scp_cmd, timeout=300)
                if exit_code != 0:
                    msg = error.strip() or f"Exit code {exit_code}"
                    log_exec(db, execution_id, dut.name, "ERROR", f"  ✗ Step 3/6 FAILED: {msg}")
                    all_ok = False
                else:
                    log_exec(db, execution_id, dut.name, "INFO", f"  ✓ Downloaded to {dest_temp}")
                    if not run_step("Step 3/6: Moving image to destination",
                                    sudocmd(f"mv {dest_temp} {target_image_path}")):
                        all_ok = False
            else:
                all_ok = run_step("Step 3/6: Copying image (local)",
                                  sudocmd(f"cp {source_image} {target_image_path}"), timeout=300)

            if not all_ok:
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Step 4/6 — Undefine VM
            run_step("Step 4/6: Undefining VM", sudocmd(f"virsh undefine {vs_name}"), allow_fail=True)

            # Step 5/6 — Define VM from XML
            if not run_step("Step 5/6: Defining VM from XML", sudocmd(f"virsh define {xml_full_path}")):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Step 6/6 — Start VM
            if not run_step("Step 6/6: Starting VM", sudocmd(f"virsh start {vs_name}")):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Verify
            out, _, _ = ssh.execute_command(sudocmd(f"virsh domstate {vs_name}"), timeout=10)
            state = out.strip()
            log_exec(db, execution_id, dut.name, "INFO", f"  VM '{vs_name}' state: {state}")
            if "running" in state.lower():
                log_exec(db, execution_id, dut.name, "INFO",
                         f"✓ VS image update completed — '{vs_name}' is running with new image")
            else:
                log_exec(db, execution_id, dut.name, "WARNING",
                         f"⚠ Update done but VM state is '{state}'")
            execution.status = "completed"

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

# ── Background: batch VM update (6-step per VM) ───────────────────────────────
def _run_vs_batch_update(execution_id, dut, vs_entries, source_image, source_server_id=None):
    db = SessionLocal()
    execution = None
    try:
        execution = db.query(Execution).filter(Execution.id == execution_id).first()
        execution.status = "running"
        execution.start_time = datetime.utcnow()
        db.commit()

        source_server = None
        if source_server_id:
            source_server = db.query(DUT).filter(DUT.id == source_server_id).first()

        total = len(vs_entries)
        log_exec(db, execution_id, "SYSTEM", "INFO", f"═══ Batch VS update: {total} VM(s) ═══")

        ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
        if not ssh.connect():
            log_exec(db, execution_id, dut.name, "ERROR", "SSH connection FAILED")
            execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

        def sudocmd(cmd):
            safe = dut.password.replace("'", "'\\''")
            return f"echo '{safe}' | sudo -S {cmd}"

        def run_step(step_name, command, allow_fail=False, timeout=120):
            log_exec(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
            output, error, exit_code = ssh.execute_command(command, timeout=timeout)
            if output.strip():
                for line in output.strip().split("\n")[:20]:
                    log_exec(db, execution_id, dut.name, "INFO", f"    {line}")
            if exit_code != 0:
                msg = error.strip() or f"Exit code {exit_code}"
                if allow_fail:
                    log_exec(db, execution_id, dut.name, "WARNING", f"  ⚠ {step_name} (allowed): {msg}")
                    return True
                log_exec(db, execution_id, dut.name, "ERROR", f"  ✗ {step_name} FAILED: {msg}")
                return False
            log_exec(db, execution_id, dut.name, "INFO", f"  ✓ {step_name} completed successfully")
            return True

        try:
            all_success = True
            for idx, entry in enumerate(vs_entries, 1):
                vs_name = entry.get("vs_name", "").strip()
                if not vs_name:
                    continue

                log_exec(db, execution_id, dut.name, "INFO", "")
                log_exec(db, execution_id, dut.name, "INFO", f"══ VM {idx}/{total}: {vs_name} ══")
                log_exec(db, execution_id, dut.name, "INFO", f"  Source image: {source_image}")

                xml_path = dut.xml_path or "/home/hp/prajwal/VMs"
                xml_full_path = f"{xml_path}/{vs_name}.xml"
                log_exec(db, execution_id, dut.name, "INFO",
                         f"  Resolving image path from XML: {xml_full_path}")
                extract_cmd = sudocmd(
                    f"python3 -c \""
                    f"import xml.etree.ElementTree as ET; "
                    f"root = ET.parse('{xml_full_path}').getroot(); "
                    f"matches = [d.find('source').get('file') for d in root.iter('disk') "
                    f"if d.get('device')=='disk' and d.find('source') is not None]; "
                    f"print(matches[0] if matches else '')\""
                )
                xml_out, xml_err, xml_rc = ssh.execute_command(extract_cmd, timeout=15)
                dest_image_path = xml_out.strip()
                if xml_rc != 0 or not dest_image_path:
                    log_exec(db, execution_id, dut.name, "ERROR",
                             f"  ✗ Could not resolve image path: "
                             f"{xml_err.strip() or 'No <disk device=disk> source found'}")
                    all_success = False; continue
                log_exec(db, execution_id, dut.name, "INFO", f"  Target path (from XML): {dest_image_path}")
                log_exec(db, execution_id, dut.name, "INFO",
                         f"  Will copy: {source_image} → {dest_image_path}")

                vm_ok = True
                vm_ok = vm_ok and run_step("Step 1/6: Destroying VM",
                                           sudocmd(f"virsh destroy {vs_name}"), allow_fail=True)
                vm_ok = vm_ok and run_step("Step 2/6: Removing old image",
                                           sudocmd(f"rm -f {dest_image_path}"))

                if vm_ok:
                    if source_server:
                        log_exec(db, execution_id, dut.name, "INFO",
                                 "▶ Step 3/6: Copying image from remote server (SCP)")
                        dest_temp = f"/tmp/{os.path.basename(dest_image_path)}"
                        safe_pass = source_server.password.replace("'", "'\\''")
                        port_flag = f"-P {source_server.port}" if source_server.port != 22 else ""
                        scp_cmd = (f"sshpass -p '{safe_pass}' scp {port_flag} -o StrictHostKeyChecking=no "
                                   f"{source_server.username}@{source_server.ip_address}:{source_image} {dest_temp}")
                        _, err, rc = ssh.execute_command(scp_cmd, timeout=300)
                        if rc != 0:
                            log_exec(db, execution_id, dut.name, "ERROR",
                                     f"  ✗ Step 3/6 FAILED: {err.strip() or 'Exit ' + str(rc)}")
                            vm_ok = False
                        else:
                            vm_ok = run_step("Step 3/6: Moving to destination",
                                             sudocmd(f"mv {dest_temp} {dest_image_path}"))
                    else:
                        vm_ok = run_step("Step 3/6: Copying image (local)",
                                         sudocmd(f"cp {source_image} {dest_image_path}"), timeout=300)

                if vm_ok:
                    run_step("Step 4/6: Undefining VM",
                             sudocmd(f"virsh undefine {vs_name}"), allow_fail=True)
                    vm_ok = run_step("Step 5/6: Defining VM from XML",
                                     sudocmd(f"virsh define {xml_full_path}"))
                if vm_ok:
                    vm_ok = run_step("Step 6/6: Starting VM",
                                     sudocmd(f"virsh start {vs_name}"))

                if vm_ok:
                    out, _, _ = ssh.execute_command(sudocmd(f"virsh domstate {vs_name}"), timeout=10)
                    log_exec(db, execution_id, dut.name, "INFO",
                             f"✓ '{vs_name}' updated — state: {out.strip()}")
                else:
                    log_exec(db, execution_id, dut.name, "ERROR", f"✗ Failed for '{vs_name}'")
                    all_success = False

            log_exec(db, execution_id, "SYSTEM", "INFO", "")
            log_exec(db, execution_id, "SYSTEM", "INFO" if all_success else "WARNING",
                     f"═══ Batch complete: {'All VMs updated successfully' if all_success else 'Some VMs failed'} ═══")
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

# ── GET /api/vs/{dut_id}/vs-names ────────────────────────────────────────────
@app.get("/api/vs/{dut_id}/vs-names")
def list_vs_names(dut_id: int, db: Session = Depends(get_db)):
    """List available VS XML files on the host device."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")
    xml_path = dut.xml_path or "/home/hp/prajwal/VMs"
    ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail="SSH connection failed")
    try:
        out, _, _ = ssh.execute_command(f"ls {xml_path}/*.xml 2>/dev/null")
        names = []
        for line in out.splitlines():
            line = line.strip()
            if line.endswith(".xml"):
                names.append(line.split("/")[-1][:-4])  # strip path + .xml
        return {"vs_names": sorted(names)}
    finally:
        ssh.disconnect()


# ── GET /api/vs/{dut_id}/xml-info ────────────────────────────────────────────
@app.get("/api/vs/{dut_id}/xml-info")
def get_xml_info(dut_id: int, vs_name: str, db: Session = Depends(get_db)):
    """Read the image path from a VS XML file on the host."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")
    xml_path = dut.xml_path or "/home/hp/prajwal/VMs"
    xml_full_path = f"{xml_path}/{vs_name}.xml"
    ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
    if not ssh.connect():
        raise HTTPException(status_code=503, detail="SSH connection failed")
    try:
        cmd = (f"python3 -c \""
               f"import xml.etree.ElementTree as ET; "
               f"t=ET.parse('{xml_full_path}'); "
               f"src=t.find('.//disk[@device=\\'disk\\']/source'); "
               f"print(src.get('file','') if src is not None else '')\"")
        out, _, _ = ssh.execute_command(cmd)
        return {"xml_path": xml_full_path, "image_path": out.strip()}
    finally:
        ssh.disconnect()


# ── POST /api/vs/{dut_id}/spin ────────────────────────────────────────────────
@app.post("/api/vs/{dut_id}/spin")
def spin_vs(dut_id: int, body: dict, db: Session = Depends(get_db)):
    """Spin a new VS: clone a source VS XML with a new name, define and start."""
    vs_name      = body.get("vs_name", "").strip()       # new VS name (PROJ_USER_NUM)
    source_vs    = body.get("source_vs", "").strip()     # existing VS XML to clone from

    if not vs_name:
        raise HTTPException(status_code=400, detail="vs_name is required")
    if not source_vs:
        raise HTTPException(status_code=400, detail="source_vs is required")

    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    xml_path     = dut.xml_path or "/home/hp/prajwal/VMs"
    src_xml      = f"{xml_path}/{source_vs}.xml"
    new_xml      = f"{xml_path}/{vs_name}.xml"

    execution = Execution(
        name=f"vs_spin_{vs_name}_{int(datetime.utcnow().timestamp())}",
        execution_type="image", dut_ids=json.dumps([dut_id]), status="pending")
    db.add(execution)
    db.commit()
    db.refresh(execution)

    thread = Thread(target=_run_vs_spin,
                    args=(execution.id, dut_id, vs_name, src_xml, new_xml),
                    daemon=True)
    thread.start()

    return {"execution_id": execution.id, "status": "started", "vs_name": vs_name,
            "message": f"VS spin started for '{vs_name}' on {dut.name}"}


# ── DELETE /api/vs/{dut_id}/remove/{vs_name} ─────────────────────────────────
@app.delete("/api/vs/{dut_id}/remove/{vs_name}")
def remove_vs(dut_id: int, vs_name: str, db: Session = Depends(get_db)):
    """Remove a VS: destroy, undefine, delete XML and image."""
    dut = db.query(DUT).filter(DUT.id == dut_id).first()
    if not dut:
        raise HTTPException(status_code=404, detail="DUT not found")

    xml_path = dut.xml_path or "/home/hp/prajwal/VMs"
    xml_full_path = f"{xml_path}/{vs_name}.xml"

    execution = Execution(
        name=f"vs_remove_{vs_name}_{int(datetime.utcnow().timestamp())}",
        execution_type="image", dut_ids=json.dumps([dut_id]), status="pending")
    db.add(execution)
    db.commit()
    db.refresh(execution)

    thread = Thread(target=_run_vs_remove,
                    args=(execution.id, dut_id, vs_name, xml_full_path),
                    daemon=True)
    thread.start()

    return {"execution_id": execution.id, "status": "started", "vs_name": vs_name,
            "message": f"VS removal started for '{vs_name}' on {dut.name}"}


# ── Background: spin new VS (4-step) ─────────────────────────────────────────
def _run_vs_spin(execution_id, dut_id, vs_name, src_xml, new_xml):
    """Clone an existing VS XML under a new name, define and start it."""
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
            execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

        log_exec(db, execution_id, dut.name, "INFO", f"Starting VS spin: '{vs_name}'")
        log_exec(db, execution_id, dut.name, "INFO", f"  Source XML : {src_xml}")
        log_exec(db, execution_id, dut.name, "INFO", f"  New XML    : {new_xml}")

        ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
        if not ssh.connect():
            log_exec(db, execution_id, dut.name, "ERROR",
                     f"SSH connection FAILED to {dut.ip_address}:{dut.port}")
            execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

        def sudocmd(cmd):
            safe = dut.password.replace("'", "'\\''")
            return f"echo '{safe}' | sudo -S {cmd}"

        def run_step(step_name, command, allow_fail=False, timeout=300):
            log_exec(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
            output, error, exit_code = ssh.execute_command(command, timeout=timeout)
            if output.strip():
                for line in output.strip().split("\n")[:20]:
                    log_exec(db, execution_id, dut.name, "INFO", f"    {line}")
            if exit_code != 0:
                msg = error.strip() or f"Exit code {exit_code}"
                if allow_fail:
                    log_exec(db, execution_id, dut.name, "WARNING", f"  ⚠ {step_name}: {msg}")
                    return True
                log_exec(db, execution_id, dut.name, "ERROR", f"  ✗ {step_name} FAILED: {msg}")
                return False
            log_exec(db, execution_id, dut.name, "INFO", f"  ✓ {step_name} completed successfully")
            return True

        try:
            # Step 1/3 — Validate source XML exists
            if not run_step("Step 1/3: Validate source XML",
                            sudocmd(f"test -f {src_xml}"), timeout=15):
                log_exec(db, execution_id, dut.name, "ERROR", f"  XML not found: {src_xml}")
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Step 2/3 — Copy XML and rename <name> element to new VS name
            clone_cmd = (
                f"python3 -c \""
                f"import xml.etree.ElementTree as ET; "
                f"ET.register_namespace('', ''); "
                f"t=ET.parse('{src_xml}'); r=t.getroot(); "
                f"n=r.find('name'); n.text='{vs_name}' if n is not None else None; "
                f"t.write('{new_xml}', xml_declaration=True, encoding='utf-8')\""
            )
            if not run_step("Step 2/3: Clone XML with new name", sudocmd(clone_cmd)):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Step 3/3 — Define and start
            if not run_step("Step 3/3: Define VS from XML", sudocmd(f"virsh define {new_xml}")):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return
            if not run_step("Step 3/3: Start VS", sudocmd(f"virsh start {vs_name}")):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            out, _, _ = ssh.execute_command(sudocmd(f"virsh domstate {vs_name}"), timeout=10)
            log_exec(db, execution_id, dut.name, "INFO",
                     f"✓ VS '{vs_name}' is running — state: {out.strip()}")
            execution.status = "completed"

        finally:
            ssh.disconnect()

        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds())
        db.commit()

    except Exception as e:
        logger.error(f"VS spin failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
    finally:
        db.close()


# ── Background: remove VS (3-step) ───────────────────────────────────────────
def _run_vs_remove(execution_id, dut_id, vs_name, xml_full_path):
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
            execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

        log_exec(db, execution_id, dut.name, "INFO", f"Starting VS removal for '{vs_name}'")
        log_exec(db, execution_id, dut.name, "INFO", f"  XML: {xml_full_path}")

        ssh = SSHManager(dut.ip_address, dut.port, dut.username, dut.password)
        if not ssh.connect():
            log_exec(db, execution_id, dut.name, "ERROR",
                     f"SSH connection FAILED to {dut.ip_address}:{dut.port}")
            execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

        def sudocmd(cmd):
            safe = dut.password.replace("'", "'\\''")
            return f"echo '{safe}' | sudo -S {cmd}"

        def run_step(step_name, command, allow_fail=False, timeout=60):
            log_exec(db, execution_id, dut.name, "INFO", f"▶ {step_name}")
            log_exec(db, execution_id, dut.name, "INFO", f"  $ {command}")
            output, error, exit_code = ssh.execute_command(command, timeout=timeout)
            if output.strip():
                for line in output.strip().split("\n")[:20]:
                    log_exec(db, execution_id, dut.name, "INFO", f"    {line}")
            if exit_code != 0:
                msg = error.strip() or f"Exit code {exit_code}"
                if allow_fail:
                    log_exec(db, execution_id, dut.name, "WARNING",
                             f"  ⚠ {step_name} (allowed): {msg}")
                    return True
                log_exec(db, execution_id, dut.name, "ERROR", f"  ✗ {step_name} FAILED: {msg}")
                return False
            log_exec(db, execution_id, dut.name, "INFO", f"  ✓ {step_name} completed successfully")
            return True

        try:
            # Read image path from XML before destroying
            log_exec(db, execution_id, dut.name, "INFO",
                     f"▶ Resolving image path from XML before removal")
            extract_cmd = sudocmd(
                f"python3 -c \""
                f"import xml.etree.ElementTree as ET; "
                f"root = ET.parse('{xml_full_path}').getroot(); "
                f"matches = [d.find('source').get('file') for d in root.iter('disk') "
                f"if d.get('device')=='disk' and d.find('source') is not None]; "
                f"print(matches[0] if matches else '')\""
            )
            xml_out, _, xml_rc = ssh.execute_command(extract_cmd, timeout=15)
            image_path = xml_out.strip()
            if image_path:
                log_exec(db, execution_id, dut.name, "INFO",
                         f"  Image path resolved: {image_path}")
            else:
                log_exec(db, execution_id, dut.name, "WARNING",
                         f"  Could not resolve image path — image file will not be deleted")

            # Step 1/3 — Destroy VS (allow_fail: OK if already stopped)
            run_step("Step 1/3: Destroy VS (stop if running)",
                     sudocmd(f"virsh destroy {vs_name}"), allow_fail=True)
            # Still part of step 1 — undefine removes it from libvirt registry
            log_exec(db, execution_id, dut.name, "INFO",
                     f"  $ {sudocmd(f'virsh undefine {vs_name}')}")
            out_ud, err_ud, rc_ud = ssh.execute_command(
                sudocmd(f"virsh undefine {vs_name}"), timeout=30)
            if rc_ud != 0:
                log_exec(db, execution_id, dut.name, "ERROR",
                         f"  ✗ Step 1/3: Undefine VS FAILED: {err_ud.strip() or 'Exit ' + str(rc_ud)}")
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return
            log_exec(db, execution_id, dut.name, "INFO",
                     f"  ✓ Step 1/3: Destroy + Undefine VS completed successfully")

            # Step 2/3 — Remove XML file
            if not run_step("Step 2/3: Remove XML file", sudocmd(f"rm -f {xml_full_path}")):
                execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return

            # Step 3/3 — Remove image file (only if resolved)
            if image_path:
                if not run_step("Step 3/3: Remove image file",
                                sudocmd(f"rm -f {image_path}")):
                    execution.status = "failed"; execution.end_time = datetime.utcnow(); db.commit(); return
            else:
                log_exec(db, execution_id, dut.name, "WARNING",
                         "Step 3/3: Skipped — image path not resolved from XML")

            log_exec(db, execution_id, dut.name, "INFO",
                     f"✓ VS '{vs_name}' removed successfully")
            execution.status = "completed"

        finally:
            ssh.disconnect()

        execution.end_time = datetime.utcnow()
        if execution.start_time:
            execution.duration_seconds = int(
                (execution.end_time - execution.start_time).total_seconds())
        db.commit()

    except Exception as e:
        logger.error(f"VS remove failed: {e}")
        if execution:
            execution.status = "failed"
            execution.end_time = datetime.utcnow()
            db.commit()
    finally:
        db.close()


# ── WebSocket: VS Update Log Streaming ────────────────────────────────────────
@app.websocket("/ws/vs/execution/{execution_id}")
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
