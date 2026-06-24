"""
Migration 004 — Create users table for user management.
Adds: id, username, email, full_name, password_hash, role, is_active,
      created_at, updated_at, last_login
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
            
        conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS users (
                {id_col},
                username      VARCHAR(100) NOT NULL UNIQUE,
                email         VARCHAR(255) UNIQUE,
                full_name     VARCHAR(200),
                password_hash VARCHAR(255) NOT NULL,
                role          VARCHAR(20)  NOT NULL DEFAULT 'operator',
                is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
                created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_login    TIMESTAMP
            );
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS ix_users_username ON users (username);
        """))
        conn.commit()
    print("✓ users table created (or already exists)")


def downgrade():
    with engine.connect() as conn:
        conn.execute(text("DROP TABLE IF EXISTS users;"))
        conn.commit()
    print("✓ users table dropped")
