#!/bin/bash
# Eka Automation - Startup Script

cd "$(dirname "$0")"

echo "=========================================="
echo "  Starting Eka Automation..."
echo "=========================================="

APP_DIR="$(pwd)"
PID_FILE="$APP_DIR/eka.pid"
LOG_FILE="$APP_DIR/uvicorn.log"
PORT=8000

# ── Locate uvicorn (venv → ~/.local → system) ────────────────────────────────
# Resolve the home dir of the user actually running this script
_HOME="$(eval echo ~$(whoami))"
if [ -f ".venv/bin/uvicorn" ]; then
    UVICORN=".venv/bin/uvicorn"
elif [ -f "venv/bin/uvicorn" ]; then
    UVICORN="venv/bin/uvicorn"
elif [ -f "$_HOME/.local/bin/uvicorn" ]; then
    UVICORN="$_HOME/.local/bin/uvicorn"
elif command -v uvicorn &>/dev/null; then
    UVICORN="$(command -v uvicorn)"
else
    echo "❌ uvicorn not found. Install it: pip install uvicorn"
    echo "   Searched: .venv/bin, venv/bin, $_HOME/.local/bin, PATH"
    exit 1
fi

# ── Check if already running ──────────────────────────────────────────────────
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "⚠️  Eka is already running (PID $(cat "$PID_FILE"))"
    exit 1
fi

# Kill any stale process on port 8000
STALE=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$STALE" ]; then
    echo "🧹 Clearing stale process on port $PORT: $STALE"
    echo "$STALE" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# ── Check main.py exists ──────────────────────────────────────────────────────
if [ ! -f "./main.py" ]; then
    echo "❌ main.py not found!"
    exit 1
fi

# ── Launch ────────────────────────────────────────────────────────────────────
echo "🚀 Starting uvicorn server..."
setsid nohup "$UVICORN" main:app \
    --host 0.0.0.0 \
    --port "$PORT" \
    --log-level info \
    >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
disown "$(cat "$PID_FILE")" 2>/dev/null || true

echo "   Process ID: $(cat "$PID_FILE")"
echo "   Waiting for server to start..."

# ── Wait for /health (up to 15 s) ────────────────────────────────────────────
for i in $(seq 1 15); do
    sleep 1
    if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
        echo ""
        echo "✅ Eka Automation started successfully!"
        echo ""
        echo "   PID:        $(cat "$PID_FILE")"
        echo "   Dashboard:  http://localhost:$PORT"
        echo "   API Docs:   http://localhost:$PORT/docs"
        echo "   Health:     http://localhost:$PORT/health"
        echo ""
        echo "   Logs:       tail -f uvicorn.log"
        echo "   Stop:       ./stop_eka.sh"
        echo ""
        echo "=========================================="
        exit 0
    fi
done

echo "❌ Server did not respond within 15 s"
echo ""
echo "   Last 20 lines of uvicorn.log:"
echo "   ─────────────────────────────────────"
tail -20 "$LOG_FILE" | sed 's/^/   /'
echo "   ─────────────────────────────────────"
exit 1
