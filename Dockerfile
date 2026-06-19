# ============================================================
# Eka Automation — Core Monolith Dockerfile
# Serves: Dashboard, Devices, Logs, Terminal, Sessions
# Port: 8000
# Uses: Python 3.11 (stable telnetlib support via package)
# ============================================================

FROM python:3.11-slim

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first (layer-cached)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create runtime directories
RUN mkdir -p data/logs data/images data/scripts

# Expose application port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

# Run migrations then start server
CMD ["sh", "-c", "python run_migrations.py && uvicorn main:app --host 0.0.0.0 --port 8000 --workers 2"]
