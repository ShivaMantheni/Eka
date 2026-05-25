#!/bin/bash
# Eka Automation - Stop Script
# Run this to stop the application gracefully

cd "$(dirname "$0")"

echo "=========================================="
echo "  Stopping Eka Automation..."
echo "=========================================="

# Find all matching processes
PIDS=$(pgrep -f "uvicorn main:app" 2>/dev/null)

# Check if running
if [ -z "$PIDS" ]; then
    echo "⚠️  Eka is not running!"
    exit 1
fi

# Show processes being stopped
PROCESS_COUNT=$(echo "$PIDS" | wc -l)
echo "📍 Found $PROCESS_COUNT process(es) to stop:"
ps -p $PIDS -o pid,cmd --no-headers | sed 's/^/   /'

# Stop the application gracefully (SIGTERM)
echo ""
echo "🔄 Sending graceful shutdown signal (SIGTERM)..."
pkill -TERM -f "uvicorn main:app"

sleep 3

# Check if still running
REMAINING=$(pgrep -f "uvicorn main:app" 2>/dev/null)

if [ -n "$REMAINING" ]; then
    echo "⚠️  Some processes still running, forcing shutdown (SIGKILL)..."
    pkill -9 -f "uvicorn main:app"
    sleep 1

    # Final check
    STILL_RUNNING=$(pgrep -f "uvicorn main:app" 2>/dev/null)
    if [ -n "$STILL_RUNNING" ]; then
        echo "❌ Failed to stop Eka Automation"
        echo "   Remaining processes:"
        ps -p $STILL_RUNNING -o pid,cmd --no-headers | sed 's/^/   /'
        echo ""
        echo "   Manual cleanup: kill -9 $STILL_RUNNING"
        exit 1
    fi
fi

echo "✅ Eka Automation stopped successfully!"
echo ""
echo "   To start again: ./start_eka.sh"
echo "   View logs:      cat uvicorn.log"
echo ""
echo "=========================================="
