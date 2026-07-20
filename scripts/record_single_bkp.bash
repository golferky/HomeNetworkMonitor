#!/bin/bash
set -e
set -x

# -----------------------------------
# PATHS
# -----------------------------------
BASE="/Volumes/Public/EPG/jobs"

PENDING="$BASE/pending"
COMPLETED="$BASE/completed"
FAILED="$BASE/failed"

LOCAL_BASE="$HOME/epg"
LOCAL_JOBS="$LOCAL_BASE/jobs"
LOCAL_LOGS="$LOCAL_BASE/logs"

mkdir -p "$LOCAL_JOBS" "$LOCAL_LOGS"

# -----------------------------------
# INPUT
# -----------------------------------
JOB_ID="$1"

if [ -z "$JOB_ID" ]; then
  echo "❌ ERROR: No job ID"
  exit 1
fi

NAS_JOB="$PENDING/${JOB_ID}.json"
LOCAL_JOB="$LOCAL_JOBS/${JOB_ID}.json"
LOG="$LOCAL_LOGS/${JOB_ID}.log"

echo "JOB ID: $JOB_ID"
echo "NAS FILE: $NAS_JOB"
echo "LOCAL FILE: $LOCAL_JOB"

# -----------------------------------
# VALIDATE + COPY LOCAL
# -----------------------------------
if [ ! -f "$NAS_JOB" ]; then
  echo "❌ Job not found on NAS"
  exit 1
fi

cp "$NAS_JOB" "$LOCAL_JOB"

echo "=============================" >> "$LOG"
echo "Start: $(date)" >> "$LOG"

# -----------------------------------
# READ JSON
# -----------------------------------
title=$(jq -r '.title' "$LOCAL_JOB")
stream=$(jq -r '.streamUrl' "$LOCAL_JOB")
duration=$(jq -r '.duration' "$LOCAL_JOB")

echo "Title: $title" >> "$LOG"
echo "Stream: $stream" >> "$LOG"
echo "Duration: $duration" >> "$LOG"

# -----------------------------------
# VALIDATION
# -----------------------------------
if [ -z "$stream" ] || [ "$stream" == "null" ]; then
  echo "❌ Invalid stream" >> "$LOG"
  cp "$LOCAL_JOB" "$FAILED/${JOB_ID}.json"
  exit 1
fi

if [ -z "$duration" ] || [ "$duration" == "null" ]; then
  echo "❌ Invalid duration" >> "$LOG"
  cp "$LOCAL_JOB" "$FAILED/${JOB_ID}.json"
  exit 1
fi

# -----------------------------------
# SAFE NAME
# -----------------------------------
safe=$(echo "$title" | sed 's/[\/:*?"<>|]/_/g')

tempDir="$HOME/recordings/temp"
completeDir="$HOME/recordings/complete"
finalDir="/Volumes/Plex/Movies/$safe"

mkdir -p "$tempDir" "$completeDir" "$finalDir"

tsFile="$tempDir/$safe.ts"
mp4File="$completeDir/$safe.mp4"

# -----------------------------------
# RECORD
# -----------------------------------
echo "Recording..." >> "$LOG"

ffmpeg -loglevel error -i "$stream" -t "$duration" -c copy "$tsFile" >> "$LOG" 2>&1

if [ $? -ne 0 ]; then
  echo "❌ TS failed" >> "$LOG"
  cp "$LOCAL_JOB" "$FAILED/${JOB_ID}.json"
  exit 1
fi

# -----------------------------------
# CONVERT
# -----------------------------------
echo "Converting..." >> "$LOG"

ffmpeg -loglevel error -i "$tsFile" -c copy -movflags +faststart "$mp4File" >> "$LOG" 2>&1

if [ $? -ne 0 ]; then
  echo "❌ MP4 failed" >> "$LOG"
  cp "$LOCAL_JOB" "$FAILED/${JOB_ID}.json"
  exit 1
fi

# -----------------------------------
# MOVE FINAL VIDEO
# -----------------------------------
mv "$mp4File" "$finalDir/$safe.mp4"

# -----------------------------------
# MARK COMPLETE (WRITE BACK TO NAS)
# -----------------------------------
cp "$LOCAL_JOB" "$COMPLETED/${JOB_ID}.json"

echo "✅ DONE" >> "$LOG"
echo "End: $(date)" >> "$LOG"

exit 0