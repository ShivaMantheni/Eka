#!/usr/bin/env python3
"""
Database Migration Runner
Executes all migration files in the migrations/ directory
"""

import os
import sys
import glob
import importlib.util

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import database configuration from main.py
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

# Database configuration
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./dut_automation.db")
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False} if SQLALCHEMY_DATABASE_URL.startswith("sqlite") else {}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def run_migrations():
    """Run all migration files in migrations/ directory"""
    migrations_dir = os.path.join(os.path.dirname(__file__), 'migrations')
    migration_files = sorted(glob.glob(os.path.join(migrations_dir, '*.py')))

    if not migration_files:
        print("No migration files found")
        return

    print(f"Found {len(migration_files)} migration file(s)")

    for migration_file in migration_files:
        migration_name = os.path.basename(migration_file)

        # Skip __init__.py and other non-migration files
        if migration_name.startswith('__'):
            continue

        print(f"\n{'='*60}")
        print(f"Running migration: {migration_name}")
        print(f"{'='*60}")

        # Load the migration module
        spec = importlib.util.spec_from_file_location(migration_name, migration_file)
        migration_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration_module)

        # Execute the upgrade function if it exists
        if hasattr(migration_module, 'upgrade'):
            try:
                migration_module.upgrade()
                print(f"✓ {migration_name} completed successfully")
            except Exception as e:
                print(f"✗ {migration_name} failed: {e}")
                # Continue with other migrations even if one fails
        else:
            print(f"⚠ {migration_name} has no upgrade() function")

    print(f"\n{'='*60}")
    print("All migrations completed")
    print(f"{'='*60}\n")

if __name__ == "__main__":
    print("\n" + "="*60)
    print("DATABASE MIGRATION RUNNER")
    print("="*60 + "\n")

    try:
        run_migrations()
        print("✓ Migration process completed successfully\n")
    except Exception as e:
        print(f"✗ Migration process failed: {e}\n")
        sys.exit(1)
