"""
Migration: Create audit_logs table

This migration creates the table for security auditing.

Usage:
    python migrations/003_create_audit_logs.py
"""

from sqlalchemy import create_engine, text
from pathlib import Path
import sys

# Add parent directory to path to import main
sys.path.insert(0, str(Path(__file__).parent.parent))

from main import DATABASE_URL, engine

def upgrade():
    """Create audit_logs table"""
    print("=" * 60)
    print("MIGRATION 003: Create audit_logs table")
    print("=" * 60)

    dialect = engine.dialect.name  # 'sqlite' or 'postgresql'
    if dialect == 'postgresql':
        id_col = "id SERIAL PRIMARY KEY"
        dt_type = "TIMESTAMP"
    else:
        id_col = "id INTEGER PRIMARY KEY AUTOINCREMENT"
        dt_type = "DATETIME"

    with engine.connect() as conn:
        try:
            # Create audit_logs table
            conn.execute(text(f"""
                CREATE TABLE IF NOT EXISTS audit_logs (
                    {id_col},
                    session_id VARCHAR(255),
                    user_ip VARCHAR(50),
                    action VARCHAR(100),
                    resource_type VARCHAR(50),
                    resource_id INTEGER,
                    details TEXT,
                    timestamp {dt_type} DEFAULT CURRENT_TIMESTAMP
                )
            """))

            # Create indexes for performance
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_audit_session_action
                ON audit_logs(session_id, action)
            """))

            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_audit_timestamp
                ON audit_logs(timestamp)
            """))

            conn.commit()

            print("✓ Created audit_logs table")
            print("  Columns:")
            print("    - id (PRIMARY KEY)")
            print("    - session_id, user_ip")
            print("    - action, resource_type, resource_id")
            print("    - details (JSON)")
            print("    - timestamp")
            print("\n✓ Created indexes:")
            print("    - idx_audit_session_action")
            print("    - idx_audit_timestamp")

        except Exception as e:
            print(f"✗ Migration failed: {str(e)}")
            raise

    print("\n✓✓✓ Migration 003 completed successfully ✓✓✓\n")


def downgrade():
    """Drop audit_logs table"""
    print("=" * 60)
    print("MIGRATION 003 ROLLBACK: Drop audit_logs table")
    print("=" * 60)
    print("⚠️  WARNING: This will delete all audit logs!")
    print("⚠️  Backup your database before proceeding!\n")

    response = input("Continue with rollback? (yes/no): ")
    if response.lower() != 'yes':
        print("Rollback cancelled")
        return

    with engine.connect() as conn:
        try:
            conn.execute(text("DROP TABLE IF EXISTS audit_logs"))
            conn.commit()
            print("✓ Dropped audit_logs table")
        except Exception as e:
            print(f"✗ Rollback failed: {str(e)}")
            raise

    print("\n✓✓✓ Migration 003 rollback completed ✓✓✓\n")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
