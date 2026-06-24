#!/usr/bin/env python3
"""
Eka Automation — Smart Migration: SQLite → PostgreSQL
Uses schema reflection to auto-detect all columns from SQLite and recreate
them in PostgreSQL, then copies all data.

Run: python3 migrate_smart.py
"""
import os
from pathlib import Path

# Load .env
env_path = Path(__file__).parent / ".env"
for line in env_path.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SQLITE_URL = f"sqlite:///{Path(__file__).parent / 'data' / 'eka.db'}"
PG_URL = os.environ.get("DATABASE_URL", "")

if not PG_URL.startswith("postgresql"):
    print(f"ERROR: DATABASE_URL is not PostgreSQL: {PG_URL}")
    raise SystemExit(1)

print(f"Source : {SQLITE_URL}")
print(f"Target : {PG_URL}\n")

from sqlalchemy import (
    create_engine, text, MetaData, Table, Column,
    Integer, String, Text, DateTime, Boolean, Float,
    inspect as sa_inspect
)
from sqlalchemy.engine import reflection

# ── Connect to both DBs ───────────────────────────────────
sqlite_eng = create_engine(SQLITE_URL, connect_args={"check_same_thread": False})
pg_eng     = create_engine(PG_URL, pool_pre_ping=True)

sqlite_insp = sa_inspect(sqlite_eng)
pg_insp     = sa_inspect(pg_eng)

sqlite_tables = sqlite_insp.get_table_names()
pg_tables_existing = set(pg_insp.get_table_names())

print(f"SQLite tables found: {sqlite_tables}\n")

# ── Type mapping: SQLite → PostgreSQL ────────────────────
def map_type(col_type_str: str) -> str:
    t = col_type_str.upper()
    if "INTEGER" in t or "INT" in t:
        return "INTEGER"
    if "FLOAT" in t or "REAL" in t or "NUMERIC" in t or "DOUBLE" in t:
        return "DOUBLE PRECISION"
    if "BOOL" in t:
        return "BOOLEAN"
    if "DATETIME" in t or "TIMESTAMP" in t:
        return "TIMESTAMP"
    if "TEXT" in t or "CLOB" in t:
        return "TEXT"
    if "BLOB" in t:
        return "BYTEA"
    # VARCHAR / CHAR — try to extract length
    if "VARCHAR" in t or "CHAR" in t:
        import re
        m = re.search(r"\((\d+)\)", t)
        n = m.group(1) if m else "500"
        return f"VARCHAR({n})"
    return "TEXT"  # safe fallback

# ── For each SQLite table, ensure PG table exists with matching schema ────
with pg_eng.connect() as pg_conn:
    for table_name in sqlite_tables:
        cols = sqlite_insp.get_columns(table_name)
        pk_constraint = sqlite_insp.get_pk_constraint(table_name)
        pks = pk_constraint.get("constrained_columns", [])

        if table_name not in pg_tables_existing:
            # Build CREATE TABLE
            col_defs = []
            for col in cols:
                cname = col["name"]
                ctype = map_type(str(col["type"]))
                nullable = "" if col.get("nullable", True) else " NOT NULL"
                default = ""
                if cname in pks and ctype == "INTEGER":
                    col_defs.append(f'    "{cname}" SERIAL PRIMARY KEY')
                    continue
                col_defs.append(f'    "{cname}" {ctype}{nullable}{default}')

            ddl = f'CREATE TABLE IF NOT EXISTS "{table_name}" (\n'
            ddl += ",\n".join(col_defs)
            ddl += "\n);"

            try:
                pg_conn.execute(text(ddl))
                pg_conn.commit()
                print(f"  ✓ Created table: {table_name}")
            except Exception as e:
                pg_conn.rollback()
                print(f"  ✗ Failed to create {table_name}: {e}")
                continue
        else:
            # Table exists — add any missing columns
            existing_cols = {c["name"] for c in pg_insp.get_columns(table_name)}
            for col in cols:
                cname = col["name"]
                if cname not in existing_cols:
                    ctype = map_type(str(col["type"]))
                    try:
                        pg_conn.execute(text(f'ALTER TABLE "{table_name}" ADD COLUMN "{cname}" {ctype}'))
                        pg_conn.commit()
                        print(f"  ✓ Added column {table_name}.{cname} ({ctype})")
                    except Exception as e:
                        pg_conn.rollback()
                        print(f"  ✗ Failed to add column {table_name}.{cname}: {e}")

print()

# ── Copy data from SQLite → PostgreSQL ───────────────────
with sqlite_eng.connect() as src, pg_eng.connect() as dst:
    for table_name in sqlite_tables:
        try:
            rows = src.execute(text(f'SELECT * FROM "{table_name}"')).fetchall()
            if not rows:
                print(f"  {table_name}: 0 rows (skipped)")
                continue

            keys = list(src.execute(text(f'SELECT * FROM "{table_name}" LIMIT 0')).keys())

            # Truncate existing data
            dst.execute(text(f'TRUNCATE TABLE "{table_name}" RESTART IDENTITY CASCADE'))
            dst.commit()

            # Insert rows
            placeholders = ", ".join([f":{k}" for k in keys])
            col_names    = ", ".join([f'"{k}"' for k in keys])
            insert_sql   = text(f'INSERT INTO "{table_name}" ({col_names}) VALUES ({placeholders})')

            count = 0
            for row in rows:
                row_dict = dict(zip(keys, row))
                # Convert SQLite integers to Python booleans for BOOLEAN columns
                dst.execute(insert_sql, row_dict)
                count += 1

            dst.commit()
            print(f"  ✓ {table_name}: {count} rows migrated")

        except Exception as e:
            print(f"  ✗ {table_name}: FAILED — {e}")
            try:
                dst.rollback()
            except Exception:
                pass

print("\n✅ Migration complete!")
print("   Restart Eka with: kill $(cat eka.pid) && nohup uvicorn main:app --host 0.0.0.0 --port 8000 >> uvicorn.log 2>&1 &")
