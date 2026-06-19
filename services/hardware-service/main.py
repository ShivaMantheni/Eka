# ============================================================
# Hardware Load Service — Eka Automation
# Handles: Hardware OS image installation via Telnet/ONIE,
#           job creation, progress tracking, WebSocket streaming
# Port: 8005
# ============================================================

import os, json, asyncio, logging, ipaddress as ip_validation
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, validator
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, UniqueConstraint
from sqlalchemy.orm import declarative_base, sessionmaker, Session

# Import local copies of telnet/hardware logic
from telnet_pool import telnet_pool
from crypto_utils import encrypt_password, decrypt_password, sanitize_log
from hardware_load_logic import execute_hardware_load, log_audit

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

class HardwareLoadJob(Base):
    __tablename__ = "hardware_load_jobs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_id = Column(Integer, nullable=False)
    source_server_id = Column(Integer, nullable=True)
    image_path = Column(String(500), nullable=False)
    image_name = Column(String(255), nullable=False)
    source_server_password = Column(String(500), nullable=True)
    gateway_ip = Column(String(50), nullable=True)
    subnet_mask = Column(String(50), nullable=True)
    status = Column(String(50), default="pending")
    current_step = Column(String(255), nullable=True)
    progress_percentage = Column(Integer, default=0)
    execution_log = Column(Text, default="")
    error_message = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    session_id = Column(String(255), nullable=False, index=True)

class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), index=True)
    user_ip = Column(String(50))
    action = Column(String(100))
    resource_type = Column(String(50))
    resource_id = Column(Integer)
    details = Column(Text)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - hardware-service - %(levelname)s - %(message)s")
logger = logging.getLogger("hardware-service")

# ── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="Eka Hardware Load Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

# ── Request Models ─────────────────────────────────────────────────────────────
class HardwareLoadRequest(BaseModel):
    dut_id: int
    source_server_id: int
    image_path: str
    source_server_ip: str
    source_server_username: str
    source_server_password: str
    gateway_ip: str
    subnet_mask: str

    @validator('image_path')
    def validate_image_path(cls, v):
        if '..' in v:
            raise ValueError('Path traversal not allowed')
        if not v.startswith('/'):
            raise ValueError('Image path must be absolute')
        if not v.endswith('.bin'):
            raise ValueError('Image must be a .bin file')
        return v

    @validator('source_server_ip', 'gateway_ip')
    def validate_ip(cls, v):
        try:
            ip_validation.IPv4Address(v)
        except ValueError:
            raise ValueError(f'Invalid IPv4 address: {v}')
        return v

    @validator('subnet_mask')
    def validate_subnet(cls, v):
        valid_masks = [
            '255.0.0.0', '255.255.0.0', '255.255.255.0',
            '255.255.255.128', '255.255.255.192', '255.255.255.224',
            '255.255.255.240', '255.255.255.248', '255.255.255.252',
            '255.255.255.255'
        ]
        if v not in valid_masks:
            raise ValueError(f'Invalid subnet mask: {v}')
        return v

# ── Health ─────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "service": "hardware-service"}

# ── POST /api/hardware-load/start ─────────────────────────────────────────────
@app.post("/api/hardware-load/start")
async def start_hardware_load(
    request: Request,
    hw_request: HardwareLoadRequest,
    db: Session = Depends(get_db)
):
    """Start hardware load operation — 16-step automated OS image install."""
    session_id = request.headers.get("X-Session-ID", "default")
    user_ip = request.client.host if request.client else "unknown"

    dut = db.query(DUT).filter(
        DUT.id == hw_request.dut_id,
        DUT.session_id == session_id
    ).first()
    if not dut:
        raise HTTPException(status_code=404, detail="Device not found or access denied")

    if hasattr(dut, 'connection_type') and dut.connection_type != 'telnet':
        raise HTTPException(
            status_code=400,
            detail="Device must use telnet connection for hardware load."
        )

    source_server = db.query(DUT).filter(DUT.id == hw_request.source_server_id).first()
    if not source_server:
        raise HTTPException(status_code=404, detail="Source server not found")

    job = HardwareLoadJob(
        dut_id=hw_request.dut_id,
        source_server_id=hw_request.source_server_id,
        image_path=hw_request.image_path,
        image_name=os.path.basename(hw_request.image_path),
        source_server_password=encrypt_password(hw_request.source_server_password),
        gateway_ip=hw_request.gateway_ip,
        subnet_mask=hw_request.subnet_mask,
        status="pending",
        session_id=session_id
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    log_audit(
        db=db, session_id=session_id, user_ip=user_ip,
        action="hardware_load_start", resource_type="HardwareLoadJob",
        resource_id=job.id,
        details={"dut_id": hw_request.dut_id, "dut_name": dut.name,
                 "image_name": job.image_name}
    )

    asyncio.create_task(
        execute_hardware_load(
            job_id=job.id, dut=dut,
            request=hw_request, db=SessionLocal()
        )
    )

    logger.info(f"Hardware load job {job.id} started for DUT {dut.name}")
    return {"job_id": job.id, "status": "started",
            "message": f"Hardware load job started. Track with job_id {job.id}."}

# ── GET /api/hardware-load/job/{job_id} ──────────────────────────────────────
@app.get("/api/hardware-load/job/{job_id}")
def get_hardware_load_job(job_id: int, request: Request, db: Session = Depends(get_db)):
    session_id = request.headers.get("X-Session-ID", "default")
    job = db.query(HardwareLoadJob).filter(
        HardwareLoadJob.id == job_id,
        HardwareLoadJob.session_id == session_id
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or access denied")

    dut = db.query(DUT).filter(DUT.id == job.dut_id).first()
    device_name = dut.name if dut else f"DUT {job.dut_id}"

    return {
        "id": job.id, "job_id": job.id,
        "device_name": device_name, "dut_id": job.dut_id,
        "image_path": job.image_path, "image_name": job.image_name,
        "status": job.status, "current_step": job.current_step,
        "progress_percentage": job.progress_percentage,
        "execution_log": job.execution_log, "error_message": job.error_message,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None
    }

# ── POST /api/hardware-load/cancel/{job_id} ───────────────────────────────────
@app.post("/api/hardware-load/cancel/{job_id}")
def cancel_hardware_load_job(job_id: int, request: Request, db: Session = Depends(get_db)):
    session_id = request.headers.get("X-Session-ID", "default")
    job = db.query(HardwareLoadJob).filter(
        HardwareLoadJob.id == job_id,
        HardwareLoadJob.session_id == session_id
    ).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or access denied")
    if job.status in ("completed", "failed"):
        raise HTTPException(status_code=400, detail=f"Job is already {job.status}")

    job.status = "failed"
    job.error_message = "Cancelled by user"
    job.current_step = "Cancelled"
    job.completed_at = datetime.utcnow()
    db.commit()

    try:
        telnet_pool.close_connection(job.dut_id)
        telnet_pool.unmark_connection_as_hardware_load(job.dut_id)
    except Exception as ex:
        logger.warning(f"Could not close telnet for job {job_id}: {ex}")

    return {"status": "cancelled", "job_id": job_id,
            "message": "Hardware load job has been cancelled"}

# ── GET /api/hardware-load/jobs ───────────────────────────────────────────────
@app.get("/api/hardware-load/jobs")
def get_hardware_load_jobs(request: Request, db: Session = Depends(get_db)):
    session_id = request.headers.get("X-Session-ID", "default")
    jobs = db.query(HardwareLoadJob).filter(
        HardwareLoadJob.session_id == session_id
    ).order_by(HardwareLoadJob.started_at.desc()).all()

    result = []
    for job in jobs:
        dut = db.query(DUT).filter(DUT.id == job.dut_id).first()
        device_name = dut.name if dut else f"DUT {job.dut_id}"
        result.append({
            "id": job.id, "device_name": device_name, "dut_id": job.dut_id,
            "image_path": job.image_path, "image_name": job.image_name,
            "status": job.status, "progress_percentage": job.progress_percentage,
            "started_at": job.started_at.isoformat() if job.started_at else None,
            "completed_at": job.completed_at.isoformat() if job.completed_at else None
        })
    return result

# ── WebSocket /api/hardware-load/ws/{job_id} ──────────────────────────────────
@app.websocket("/api/hardware-load/ws/{job_id}")
async def hardware_load_websocket(websocket: WebSocket, job_id: int):
    """Stream real-time hardware load progress."""
    await websocket.accept()
    db = SessionLocal()
    last_log_length = 0
    try:
        while True:
            job = db.query(HardwareLoadJob).filter(HardwareLoadJob.id == job_id).first()
            if not job:
                await websocket.send_json({"type": "error", "message": "Job not found"})
                break

            db.refresh(job)
            current_log = job.execution_log or ""
            if len(current_log) > last_log_length:
                new_lines = current_log[last_log_length:]
                await websocket.send_json({
                    "type": "progress", "status": job.status,
                    "current_step": job.current_step,
                    "progress_percentage": job.progress_percentage,
                    "new_log_lines": new_lines
                })
                last_log_length = len(current_log)

            if job.status in ["completed", "failed"]:
                db.refresh(job)
                current_log = job.execution_log or ""
                if len(current_log) > last_log_length:
                    await websocket.send_json({
                        "type": "progress", "status": job.status,
                        "current_step": job.current_step,
                        "progress_percentage": job.progress_percentage,
                        "new_log_lines": current_log[last_log_length:]
                    })
                await websocket.send_json({
                    "type": "complete", "status": job.status,
                    "error_message": job.error_message,
                    "progress_percentage": job.progress_percentage
                })
                break

            await asyncio.sleep(1)
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for hardware load job {job_id}")
    except Exception as e:
        logger.error(f"WebSocket error for job {job_id}: {e}")
    finally:
        db.close()
