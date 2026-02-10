#!/bin/bash
# Start speaker identification service in background
python3 /app/speaker_service.py &
SPEAKER_PID=$!

# Wait for model to load
sleep 3

# Start main Node.js server
node /app/index.js &
NODE_PID=$!

# Trap and forward signals
trap "kill $SPEAKER_PID $NODE_PID 2>/dev/null; exit" SIGTERM SIGINT

# Wait for either to exit
wait -n $SPEAKER_PID $NODE_PID
echo "Process exited, shutting down..."
kill $SPEAKER_PID $NODE_PID 2>/dev/null
wait
