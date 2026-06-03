#!/bin/bash
# Eka Automation - Restart Script
# Convenience script to stop and start the application

cd "$(dirname "$0")"

echo "=========================================="
echo "  Restarting Eka Automation..."
echo "=========================================="
echo ""

# Stop the application
./stop_eka.sh

# Check if stop was successful
if [ $? -ne 0 ]; then
    echo ""
    echo "⚠️  Stop failed, but continuing with start anyway..."
    echo ""
fi

# Wait a moment
sleep 1

# Start the application
./start_eka.sh

exit $?
