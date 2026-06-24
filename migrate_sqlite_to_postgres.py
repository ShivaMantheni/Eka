#!/usr/bin/env python3
"""
Eka Automation — SQLite → PostgreSQL Data Migration Script

Migrates all data from the existing SQLite database to PostgreSQL.
Run this AFTER setup_postgres.sh has created the PostgreSQL database and tables.

Usage:
    .venv/bin/python3 migrate_sqlite_to_postgres.py

Environment:
    Reads POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB from .env
    SQLite source: data/eka.db
"""
import os
import sys
import json
from pathlib import Path

# Load .env
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

SQLITE_URL = f"sqlite:///{Path(__file__).parent / 'data' / 'eka.db'}"
PG_USER = os.getenv("POSTGRES_USER", "eka_user")
PG_PASS = os.getenv("POSTGRES_PASSWORD", "eka_secret_change_me")
PG_DB   = os.getenv("POSTGRES_DB", "eka_automation")
PG_HOST = os.getenv("POSTGRES_HOST", "localhost")
PG_PORT = os.getenv("POSTGRES_PORT", "5432")
PG_URL  = f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{PG_DB}"

print(f"Source : {SQLITE_URL}")
print(f"Target : {PG_URL}")
print()

try:
    from sqlalchemy import create_engine, text, inspect
    from sqlalchemy.orm import sessionmaker
except ImportError:
    print("ERROR: SQLAlchemy not installed. Run: pip install sqlalchemy psycopg2-binary")
    sys.exit(1)

sqlite_engine = create_engine(SQLITE_URL, connect_args={"check_same_thread": False})
pg_engine     = create_engine(PG_URL, pool_pre_ping=True)

sqlite_insp = inspect(sqlite_engine)
pg_insp     = inspect(pg_engine)

tables = sqlite_insp.get_table_names()
print(f"Tables to migrate: {tables}\n")

with sqlite_engine.connect() as src, pg_engine.connect() as dst:
    for table in tables:
        try:
            rows = src.execute(text(f'SELECT * FROM "{table}"')).fetchall()
            cols = src.execute(text(f'SELECT * FROM "{table}" LIMIT 0')).keys()
            col_list = list(cols)

            if not rows:
                print(f"  {table}: 0 rows (skipped)")
                continue

            # Disable PG constraints temporarily
            dst.execute(text(f'TRUNCATE TABLE "{table}" RESTART IDENTITY CASCADE'))

            placeholders = ", ".join([f":{c}" for c in col_list])
            col_names    = ", ".join([f'"{c}"' for c in col_list])
            insert_sql   = text(f'INSERT INTO "{table}" ({col_names}) VALUES ({placeholders})')

            count = 0
            for row in rows:
                row_dict = dict(zip(col_list, row))
                dst.execute(insert_sql, row_dict)
                count += 1

            dst.commit()
            print(f"  ✓ {table}: {count} rows migrated")

        except Exception as e:
            print(f"  ✗ {table}: FAILED — {e}")
            dst.rollback()

print("\nMigration complete. Restart Eka to use PostgreSQL.")
