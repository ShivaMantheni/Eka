#!/usr/bin/env python3
"""
Standalone script: Creates all Eka tables in PostgreSQL.
Does NOT import main.py (avoids fastapi dependency on system Python).
Reads DATABASE_URL directly from .env.
"""
import os
from pathlib import Path

# Read .env manually
env_file = Path(__file__).parent / ".env"
for line in env_file.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

DATABASE_URL = os.environ.get("DATABASE_URL", "")
print(f"Target DB: {DATABASE_URL}")

if not DATABASE_URL.startswith("postgresql"):
    print("ERROR: DATABASE_URL is not PostgreSQL. Check .env.")
    raise SystemExit(1)

from sqlalchemy import (
    create_engine, Column, Integer, String, DateTime, Text,
    Boolean, Float, ForeignKey, Index, MetaData
)
from sqlalchemy.orm import declarative_base
from datetime import datetime

engine = create_engine(DATABASE_URL, echo=False, pool_pre_ping=True)
Base = declarative_base()

# ── All table definitions (copied from main.py, stripped of app logic) ──

class DUT(Base):
    __tablename__ = "duts"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    ip_address = Column(String(50), nullable=False)
    port = Column(Integer, default=22)
    username = Column(String(100), default="admin")
    password = Column(String(255), default="")
    device_type = Column(String(50), default="linux")
    status = Column(String(20), default="offline")
    session_id = Column(String(255), nullable=True, index=True)
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    last_seen = Column(DateTime, nullable=True)

class DUTConfiguration(Base):
    __tablename__ = "dut_configurations"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_id = Column(Integer, nullable=False)
    config_key = Column(String(100), nullable=False)
    config_value = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)

class DUTLock(Base):
    __tablename__ = "dut_locks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_id = Column(Integer, nullable=False, unique=True)
    session_id = Column(String(255), nullable=False)
    locked_at = Column(DateTime, default=datetime.utcnow)
    lock_reason = Column(String(255), default="")

class TopologyConnection(Base):
    __tablename__ = "topology_connections"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dut_a_id = Column(Integer, nullable=False)
    dut_b_id = Column(Integer, nullable=False)
    port_a = Column(String(50), default="")
    port_b = Column(String(50), default="")
    connection_type = Column(String(50), default="ethernet")
    created_at = Column(DateTime, default=datetime.utcnow)

class Execution(Base):
    __tablename__ = "executions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), nullable=True, index=True)
    execution_name = Column(String(255), nullable=False)
    script_type = Column(String(50), default="spytest")
    status = Column(String(20), default="pending")
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    exit_code = Column(Integer, nullable=True)
    error_message = Column(Text, default="")
    command = Column(Text, default="")
    working_dir = Column(String(500), default="")
    pid = Column(Integer, nullable=True)

class ExecutionLog(Base):
    __tablename__ = "execution_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    execution_id = Column(Integer, nullable=False, index=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    level = Column(String(20), default="INFO")
    message = Column(Text, nullable=False)
    source = Column(String(50), default="stdout")

class Script(Base):
    __tablename__ = "scripts"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, default="")
    script_type = Column(String(50), default="spytest")
    file_path = Column(String(500), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

class Image(Base):
    __tablename__ = "images"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    version = Column(String(100), default="")
    file_path = Column(String(500), nullable=False)
    image_type = Column(String(50), default="sonic")
    file_size = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

class UserSession(Base):
    """User-based persistent session (no TTL)."""
    __tablename__ = "user_sessions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), unique=True, nullable=False, index=True)
    user_name = Column(String(100), nullable=False)
    user_email = Column(String(255), nullable=True)
    user_role = Column(String(255), nullable=True)
    status = Column(String(20), default="active")  # active, terminated, revoked
    allocated_dut_ids = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    last_activity = Column(DateTime, default=datetime.utcnow)
    last_keepalive = Column(DateTime, nullable=True)
    keepalive_fail_count = Column(Integer, default=0)
    expires_at = Column(DateTime, nullable=True)  # NULL for SSO sessions

class HardwareLoadJob(Base):
    __tablename__ = "hardware_load_jobs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), nullable=True, index=True)
    dut_id = Column(Integer, nullable=True)
    dut_name = Column(String(100), default="")
    dut_ip = Column(String(50), default="")
    image_path = Column(String(500), default="")
    status = Column(String(20), default="pending")
    progress = Column(Float, default=0.0)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    error_message = Column(Text, default="")
    log_output = Column(Text, default="")

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    email = Column(String(255), nullable=True)
    role = Column(String(50), default="user")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime, nullable=True)

class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(255), nullable=True, index=True)
    user_name = Column(String(100), nullable=True)
    action = Column(String(100), nullable=False)
    resource_type = Column(String(50), nullable=True)
    resource_id = Column(Integer, nullable=True)
    details = Column(Text, default="")
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)
    ip_address = Column(String(50), nullable=True)

# ── Create all tables ────────────────────────────────────
print("\nCreating tables in PostgreSQL...")
Base.metadata.create_all(bind=engine)
print("✓ All tables created successfully!")

# Verify
from sqlalchemy import inspect
insp = inspect(engine)
tables = sorted(insp.get_table_names())
print(f"\n✓ Tables in PostgreSQL ({len(tables)} total):")
for t in tables:
    print(f"  - {t}")
