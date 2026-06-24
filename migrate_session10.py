"""
migrate_session10.py — DB migration for Session 10 changes.

Adds:
  1. executions.test_results TEXT column (was added to ORM but never migrated)
  2. testcase_results table + index (new table, never created)

Run on the server where the app runs:
    python3 migrate_session10.py

Reads DATABASE_URL from .env in the same directory (or the environment).
"""

import os
import sys

# ── load .env ──────────────────────────────────────────────────────────────────
_env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL or not DATABASE_URL.startswith("postgresql"):
    sys.exit("ERROR: DATABASE_URL not set or not a PostgreSQL URL. Check .env.")

# ── connect ────────────────────────────────────────────────────────────────────
try:
    import psycopg2
except ImportError:
    sys.exit("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")

print(f"Connecting to: {DATABASE_URL.split('@')[-1]}")  # hide credentials
conn = psycopg2.connect(DATABASE_URL)
conn.autocommit = False
cur = conn.cursor()

MIGRATIONS = [
    # ── 1. executions.test_results ─────────────────────────────────────────────
    (
        "Add executions.test_results column",
        """
        ALTER TABLE executions
            ADD COLUMN IF NOT EXISTS test_results TEXT;
        """,
    ),
    # ── 2. testcase_results table ──────────────────────────────────────────────
    (
        "Create testcase_results table",
        """
        CREATE TABLE IF NOT EXISTS testcase_results (
            id           SERIAL PRIMARY KEY,
            execution_id INTEGER      NOT NULL,
            script_path  TEXT,
            module       TEXT,
            test_function TEXT,
            testcase_id  TEXT,
            result       VARCHAR(20),
            time_taken   VARCHAR(50),
            time_seconds INTEGER,
            description  TEXT,
            created_at   TIMESTAMP DEFAULT NOW()
        );
        """,
    ),
    (
        "Create index on testcase_results.execution_id",
        """
        CREATE INDEX IF NOT EXISTS idx_tcr_exec_id
            ON testcase_results(execution_id);
        """,
    ),
]

errors = []
for label, sql in MIGRATIONS:
    try:
        cur.execute(sql)
        print(f"  ✓  {label}")
    except Exception as e:
        print(f"  ✗  {label}: {e}")
        errors.append(label)

if errors:
    conn.rollback()
    print(f"\nRolled back — {len(errors)} step(s) failed.")
    sys.exit(1)

conn.commit()
print("\nMigration complete. Restart the app (uvicorn) to pick up the changes.")
cur.close()
conn.close()
