"""
Migration: Create hardware_load_jobs table

This migration creates the table to track hardware load operations.

Usage:
    python migrations/002_create_hw_load_jobs.py
"""

from sqlalchemy import create_engine, text
from pathlib import Path
import sys

# Add parent directory to path to import main
sys.path.insert(0, str(Path(__file__).parent.parent))

from main import DATABASE_URL, engine

def upgrade():
    """Create hardware_load_jobs table"""
    print("=" * 60)
    print("MIGRATION 002: Create hardware_load_jobs table")
    print("=" * 60)

    with engine.connect() as conn:
        try:
            # Create hardware_load_jobs table
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS hardware_load_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    dut_id INTEGER NOT NULL,
                    source_server_id INTEGER,
                    image_path VARCHAR(500) NOT NULL,
                    image_name VARCHAR(255) NOT NULL,
                    source_server_password VARCHAR(500),
                    gateway_ip VARCHAR(50),
                    subnet_mask VARCHAR(50),
                    status VARCHAR(50) DEFAULT 'pending',
                    current_step VARCHAR(255),
                    progress_percentage INTEGER DEFAULT 0,
                    execution_log TEXT DEFAULT '',
                    error_message TEXT,
                    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    completed_at DATETIME,
                    session_id VARCHAR(255) NOT NULL,
                    FOREIGN KEY (dut_id) REFERENCES duts(id) ON DELETE CASCADE,
                    FOREIGN KEY (source_server_id) REFERENCES duts(id) ON DELETE SET NULL
                )
            """))

            # Create indexes for performance
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_hw_load_session_status
                ON hardware_load_jobs(session_id, status)
            """))

            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_hw_load_dut_status
                ON hardware_load_jobs(dut_id, status)
            """))

            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_hw_load_started_at
                ON hardware_load_jobs(started_at)
            """))

            conn.commit()

            print("✓ Created hardware_load_jobs table")
            print("  Columns:")
            print("    - id (PRIMARY KEY)")
            print("    - dut_id (FOREIGN KEY → duts)")
            print("    - source_server_id (FOREIGN KEY → duts)")
            print("    - image_path, image_name")
            print("    - source_server_password (encrypted)")
            print("    - gateway_ip, subnet_mask")
            print("    - status, current_step, progress_percentage")
            print("    - execution_log, error_message")
            print("    - started_at, completed_at, session_id")
            print("\n✓ Created indexes:")
            print("    - idx_hw_load_session_status")
            print("    - idx_hw_load_dut_status")
            print("    - idx_hw_load_started_at")

        except Exception as e:
            print(f"✗ Migration failed: {str(e)}")
            raise

    print("\n✓✓✓ Migration 002 completed successfully ✓✓✓\n")


def downgrade():
    """Drop hardware_load_jobs table"""
    print("=" * 60)
    print("MIGRATION 002 ROLLBACK: Drop hardware_load_jobs table")
    print("=" * 60)
    print("⚠️  WARNING: This will delete all hardware load history!")
    print("⚠️  Backup your database before proceeding!\n")

    response = input("Continue with rollback? (yes/no): ")
    if response.lower() != 'yes':
        print("Rollback cancelled")
        return

    with engine.connect() as conn:
        try:
            conn.execute(text("DROP TABLE IF EXISTS hardware_load_jobs"))
            conn.commit()
            print("✓ Dropped hardware_load_jobs table")
        except Exception as e:
            print(f"✗ Rollback failed: {str(e)}")
            raise

    print("\n✓✓✓ Migration 002 rollback completed ✓✓✓\n")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
