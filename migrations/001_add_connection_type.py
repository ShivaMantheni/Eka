"""
Migration: Add connection_type column to duts table

This migration adds support for telnet connections alongside SSH.

Usage:
    python migrations/001_add_connection_type.py
"""

from sqlalchemy import create_engine, text
from pathlib import Path
import sys

# Add parent directory to path to import main
sys.path.insert(0, str(Path(__file__).parent.parent))

from main import DATABASE_URL, engine

def upgrade():
    """Add connection_type column to duts table"""
    print("=" * 60)
    print("MIGRATION 001: Add connection_type column")
    print("=" * 60)

    with engine.connect() as conn:
        try:
            # Add connection_type column
            conn.execute(text("""
                ALTER TABLE duts
                ADD COLUMN connection_type VARCHAR(10) DEFAULT 'ssh'
            """))
            conn.commit()
            print("✓ Added connection_type column to duts table")
            print("  - Type: VARCHAR(10)")
            print("  - Default: 'ssh'")
            print("  - Values: 'ssh' or 'telnet'")

        except Exception as e:
            error_msg = str(e).lower()
            if "duplicate column" in error_msg or "already exists" in error_msg:
                print("✓ connection_type column already exists (skipping)")
            else:
                print(f"✗ Migration failed: {str(e)}")
                raise

    print("\n✓✓✓ Migration 001 completed successfully ✓✓✓\n")


def downgrade():
    """
    Remove connection_type column from duts table

    Note: SQLite doesn't support DROP COLUMN directly, so this requires
    recreating the table. This is destructive - backup data first!
    """
    print("=" * 60)
    print("MIGRATION 001 ROLLBACK: Remove connection_type column")
    print("=" * 60)
    print("⚠️  WARNING: This is a destructive operation!")
    print("⚠️  Backup your database before proceeding!\n")

    response = input("Continue with rollback? (yes/no): ")
    if response.lower() != 'yes':
        print("Rollback cancelled")
        return

    # SQLite doesn't support ALTER TABLE DROP COLUMN
    # Would need to recreate table without connection_type
    # Not implemented for safety - use database backup/restore instead
    print("✗ Rollback not implemented for SQLite")
    print("  Use database backup to restore previous state")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
