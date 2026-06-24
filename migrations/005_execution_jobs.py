"""
Migration 005 — Create execution_jobs table and add job_id to executions + lock_type to dut_locks.
"""

import os
from sqlalchemy import create_engine, text

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://eka_user:eka_secret_change_me@postgres:5432/eka_automation"
)
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)


def upgrade():
    with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect == "sqlite":
            id_col = "id INTEGER PRIMARY KEY AUTOINCREMENT"
        else:
            id_col = "id SERIAL PRIMARY KEY"

        # 1. execution_jobs table
        conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS execution_jobs (
                {id_col},
                name       VARCHAR(100) NOT NULL DEFAULT 'Job',
                status     VARCHAR(20)  NOT NULL DEFAULT 'idle',
                session_id VARCHAR(255),
                dut_ids    TEXT,
                base_path  TEXT,
                host_id    INTEGER,
                topology   TEXT,
                scripts    TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_execution_jobs_session_id
                ON execution_jobs (session_id);
        """))

        # 2. Add job_id to executions
        if dialect == "sqlite":
            try:
                conn.execute(text(
                    "ALTER TABLE executions ADD COLUMN job_id INTEGER;"
                ))
            except Exception:
                pass  # column already exists
        else:
            conn.execute(text("""
                ALTER TABLE executions
                    ADD COLUMN IF NOT EXISTS job_id INTEGER
                    REFERENCES execution_jobs(id) ON DELETE SET NULL;
            """))
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_executions_job_id
                    ON executions (job_id);
            """))

        # 3. Add lock_type to dut_locks
        if dialect == "sqlite":
            try:
                conn.execute(text(
                    "ALTER TABLE dut_locks ADD COLUMN lock_type VARCHAR(10) DEFAULT 'exec';"
                ))
            except Exception:
                pass
        else:
            conn.execute(text("""
                ALTER TABLE dut_locks
                    ADD COLUMN IF NOT EXISTS lock_type VARCHAR(10) DEFAULT 'exec';
            """))

        conn.commit()
    print("✓ migration 005 applied: execution_jobs, executions.job_id, dut_locks.lock_type")


def downgrade():
    with engine.connect() as conn:
        conn.execute(text("DROP TABLE IF EXISTS execution_jobs;"))
        conn.commit()
    print("✓ migration 005 reverted")


if __name__ == "__main__":
    upgrade()
