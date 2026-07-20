#!/bin/bash
echo "Stopping server on port 5001..."
kill $(lsof -ti:5001) 2>/dev/null
sleep 1
echo "Starting server..."
cd ~/epg
python3.11 server.py
