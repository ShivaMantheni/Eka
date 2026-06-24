#!/usr/bin/env bash
# ============================================================
# Eka Automation — PostgreSQL Setup Script
# Run this once after installing PostgreSQL to:
#   1. Create the eka_user and eka_automation database
#   2. Update .env DATABASE_URL to use PostgreSQL
#   3. Run SQLAlchemy table creation (create_all)
# ============================================================
set -e

DB_NAME="${POSTGRES_DB:-eka_automation}"
DB_USER="${POSTGRES_USER:-eka_user}"
DB_PASS="${POSTGRES_PASSWORD:-eka_secret_change_me}"
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"

echo "=============================================="
echo " Eka Automation — PostgreSQL Setup"
echo "=============================================="
echo " DB Host : $DB_HOST:$DB_PORT"
echo " DB Name : $DB_NAME"
echo " DB User : $DB_USER"
echo ""

# ── Step 1: Create PostgreSQL user and database ───────────
echo ">>> Step 1: Creating PostgreSQL user and database..."
sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';
    RAISE NOTICE 'Created role: $DB_USER';
  ELSE
    ALTER ROLE $DB_USER WITH PASSWORD '$DB_PASS';
    RAISE NOTICE 'Updated password for role: $DB_USER';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME') \gexec

GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL
echo "  ✓ Database and user ready"

# ── Step 2: Update .env DATABASE_URL ─────────────────────
ENV_FILE="$(dirname "$0")/.env"
PG_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

if grep -q "^DATABASE_URL=sqlite" "$ENV_FILE"; then
  sed -i "s|^DATABASE_URL=sqlite.*|# DATABASE_URL=sqlite:///data/eka.db  # Disabled — using PostgreSQL|" "$ENV_FILE"
  if grep -q "^# DATABASE_URL=postgresql" "$ENV_FILE"; then
    sed -i "s|^# DATABASE_URL=postgresql.*|DATABASE_URL=${PG_URL}|" "$ENV_FILE"
  else
    echo "DATABASE_URL=${PG_URL}" >> "$ENV_FILE"
  fi
  echo "  ✓ .env updated: DATABASE_URL=$PG_URL"
else
  echo "  ℹ  .env already uses PostgreSQL (no change needed)"
fi

# ── Step 3: Create tables via SQLAlchemy ──────────────────
echo ""
echo ">>> Step 3: Creating database tables..."
cd "$(dirname "$0")"
.venv/bin/python3 -c "
import os, sys
os.environ['DATABASE_URL'] = '$PG_URL'
sys.path.insert(0, '.')
from main import Base, engine
Base.metadata.create_all(bind=engine)
print('  ✓ Tables created successfully')
"

echo ""
echo "=============================================="
echo " PostgreSQL setup complete!"
echo " Restart the app:  ./restart_eka.sh"
echo "=============================================="
