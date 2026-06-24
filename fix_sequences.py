"""
Fix PostgreSQL primary key sequences after SQLite → PostgreSQL migration.
Sequences get desynced when rows are bulk-inserted with explicit IDs — the
auto-increment counter stays at 1 while the table already has rows with higher IDs.
"""
import os
import sys

# Tables with integer auto-increment primary keys
TABLES = [
    "duts",
    "dut_configurations",
    "images",
    "scripts",
    "executions",
    "execution_logs",
    "dut_locks",
    "topology_connections",
    "user_sessions",
    "hardware_load_jobs",
    "audit_logs",
]

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

db_url = os.environ.get("DATABASE_URL", "")
if not db_url:
    print("ERROR: DATABASE_URL not set")
    sys.exit(1)

import sqlalchemy as sa

engine = sa.create_engine(db_url)

with engine.connect() as conn:
    for table in TABLES:
        try:
            result = conn.execute(sa.text(f"SELECT MAX(id) FROM {table}"))
            max_id = result.scalar()
            if max_id is None:
                print(f"  {table}: empty — skipping")
                continue

            # Get current sequence value
            seq_result = conn.execute(sa.text(
                f"SELECT last_value FROM {table}_id_seq"
            ))
            seq_val = seq_result.scalar()

            if seq_val < max_id:
                conn.execute(sa.text(
                    f"SELECT setval('{table}_id_seq', {max_id})"
                ))
                conn.commit()
                print(f"  {table}: FIXED sequence {seq_val} → {max_id}")
            else:
                print(f"  {table}: OK (seq={seq_val}, max_id={max_id})")
        except Exception as e:
            print(f"  {table}: ERROR — {e}")

print("\nDone.")
