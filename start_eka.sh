#!/bin/bash
# Eka Automation - Startup Script
# Run this to start the application independently

cd "$(dirname "$0")"

echo "=========================================="
echo "  Starting Eka Automation..."
echo "=========================================="

# Find all matching processes
PIDS=$(pgrep -f "uvicorn main:app" 2>/dev/null)

# Check if already running
if [ -n "$PIDS" ]; then
    PROCESS_COUNT=$(echo "$PIDS" | wc -l)
    echo "⚠️  Eka is already running ($PROCESS_COUNT process(es))!"
    echo ""
    ps -p $PIDS -o pid,etime,cmd --no-headers | sed 's/^/   /'
    echo ""
    echo "   To stop:    ./stop_eka.sh"
    echo "   To restart: ./stop_eka.sh && ./start_eka.sh"
    exit 1
fi

# Check if virtual environment exists
if [ ! -d "./venv" ]; then
    echo "❌ Virtual environment not found!"
    echo "   Please create venv first: python3 -m venv venv"
    echo "   Then install dependencies: ./venv/bin/pip install -r requirements.txt"
    exit 1
fi

# Check if main.py exists
if [ ! -f "./main.py" ]; then
    echo "❌ main.py not found!"
    echo "   Please run this script from the application directory"
    exit 1
fi

# Check if port 8000 is already in use
if lsof -i :8000 >/dev/null 2>&1; then
    echo "⚠️  Port 8000 is already in use!"
    echo ""
    lsof -i :8000 | sed 's/^/   /'
    echo ""
    echo "   Kill the process or use a different port"
    exit 1
fi

# Start the application
echo "🚀 Starting uvicorn server..."
nohup ./venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
NEW_PID=$!

echo "   Process ID: $NEW_PID"
echo "   Waiting for server to start..."

sleep 3

# Check if process is still running
if ! ps -p $NEW_PID > /dev/null 2>&1; then
    echo "❌ Process died immediately after start!"
    echo ""
    echo "   Last 20 lines of uvicorn.log:"
    echo "   ─────────────────────────────────────"
    tail -20 uvicorn.log | sed 's/^/   /'
    echo "   ─────────────────────────────────────"
    exit 1
fi

# Check if health endpoint responds
MAX_RETRIES=10
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://localhost:8000/health > /dev/null 2>&1; then
        echo ""
        echo "✅ Eka Automation started successfully!"
        echo ""
        echo "   PID:        $NEW_PID"
        echo "   Dashboard:  http://localhost:8000"
        echo "   API Docs:   http://localhost:8000/docs"
        echo "   Health:     http://localhost:8000/health"
        echo ""
        echo "   Logs:       tail -f uvicorn.log"
        echo "   App Logs:   tail -f data/logs/app.log"
        echo "   Stop:       ./stop_eka.sh"
        echo ""
        echo "=========================================="
        exit 0
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    sleep 1
done

# Health check failed
echo "❌ Failed to start Eka Automation"
echo "   Server started but health check failed after ${MAX_RETRIES}s"
echo ""
echo "   Last 30 lines of uvicorn.log:"
echo "   ─────────────────────────────────────"
tail -30 uvicorn.log | sed 's/^/   /'
echo "   ─────────────────────────────────────"
echo ""
echo "   Process is still running (PID: $NEW_PID)"
echo "   To stop: kill $NEW_PID"
exit 1
