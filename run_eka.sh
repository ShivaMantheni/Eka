#!/bin/bash
# Eka Automation — Reliable Start/Stop/Status/Restart Script
# Usage: bash run_eka.sh [start|stop|restart|status]
# Works with .venv, venv, or system-installed uvicorn

cd "$(dirname "$0")"

APP_DIR="$(pwd)"
PID_FILE="$APP_DIR/eka.pid"
LOG_FILE="$APP_DIR/uvicorn.log"
PORT=8000

# ── Find uvicorn ──────────────────────────────────────────────────────────────
if [ -f ".venv/bin/uvicorn" ]; then
    UVICORN=".venv/bin/uvicorn"
elif [ -f "venv/bin/uvicorn" ]; then
    UVICORN="venv/bin/uvicorn"
elif command -v uvicorn &>/dev/null; then
    UVICORN="$(command -v uvicorn)"
else
    echo "❌ uvicorn not found. Install it: pip install uvicorn"
    exit 1
fi

is_running() {
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

do_start() {
    if is_running; then
        echo "⚠️  Already running (PID $(cat "$PID_FILE"))"
        return 0
    fi

    echo "🚀 Starting Eka on port $PORT..."
    setsid nohup "$UVICORN" main:app \
        --host 0.0.0.0 \
        --port "$PORT" \
        --log-level info \
        >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    disown "$(cat "$PID_FILE")" 2>/dev/null || true

    # Wait up to 10s for health check
    for i in $(seq 1 10); do
        sleep 1
        if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
            echo "✅ Eka is UP (PID $(cat "$PID_FILE")) — http://localhost:$PORT"
            return 0
        fi
    done

    echo "❌ Startup failed — last 10 log lines:"
    tail -10 "$LOG_FILE"
    return 1
}

do_stop() {
    # Kill the tracked PID
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "🛑 Stopping Eka (PID $PID)..."
            kill "$PID" 2>/dev/null
            sleep 2
            kill -9 "$PID" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi

    # Also kill any stale uvicorn on port 8000 (prevents old code serving after restart)
    STALE=$(lsof -ti tcp:$PORT 2>/dev/null || ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+')
    if [ -n "$STALE" ]; then
        echo "🧹 Killing stale process(es) on port $PORT: $STALE"
        echo "$STALE" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
    echo "✅ Stopped"
}

do_status() {
    if is_running; then
        echo "✅ Running (PID $(cat "$PID_FILE")) — http://localhost:$PORT"
        curl -s "http://localhost:$PORT/health" && echo ""
    else
        echo "❌ Not running"
        rm -f "$PID_FILE" 2>/dev/null
    fi
}

case "${1:-start}" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; sleep 1; do_start ;;
    status)  do_status ;;
    *)       echo "Usage: $0 [start|stop|restart|status]" ;;
esac
