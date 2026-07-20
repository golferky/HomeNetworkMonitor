#!/bin/bash
set -x
set -e

echo "===== SCRIPT START ====="
date
# Ensure NAS is mounted (headless-safe)
MOUNT_POINT="/Volumes/Public"

if ! mount | grep -q "$MOUNT_POINT"; then
    mkdir -p "$MOUNT_POINT"
    mount_smbfs "//GaryAdmin:5790$nas@192.168.1.176/Public" "$MOUNT_POINT"
fi

echo "===== TESTING ACCESS ====="
ls /Volumes/Public || echo "CANNOT ACCESS PUBLIC"
ls /Volumes/Public/EPG || echo "CANNOT ACCESS EPG"
ls /Volumes/Public/EPG/jobs/pending || echo "CANNOT ACCESS PENDING"

# ===== CONFIG =====
BASE="/Volumes/Public/EPG"
PENDING="$BASE/jobs/pending"
WORKING="$BASE/jobs/working"
COMPLETE="$BASE/jobs/complete"
FAILED="$BASE/jobs/failed"
RECORDINGS="$BASE/recordings"

echo "=== DEBUG START ==="
echo "BASE: $BASE"
echo "PENDING: $PENDING"

echo "Listing pending folder:"
ls -l "$PENDING"

echo "Looking for job..."
JOB=$(ls "$PENDING"/*.json 2>/dev/null | head -n 1)

echo "JOB FOUND: $JOB"

mkdir -p "$WORKING" "$COMPLETE" "$FAILED" "$RECORDINGS"

# ===== PICK FIRST JOB =====
JOB=$(ls "$PENDING"/*.json 2>/dev/null | head -n 1)

if [ -z "$JOB" ]; then
    echo "No jobs found"
    exit 0
fi

echo "Processing job: $JOB"

# Move to working
BASENAME=$(basename "$JOB")
mv "$JOB" "$WORKING/$BASENAME"
JOB="$WORKING/$BASENAME"

# ===== READ JSON =====
URL=$(jq -r '.url' "$JOB")
OUTFILE=$(jq -r '.output' "$JOB")

# fallback filename
if [ "$OUTFILE" == "null" ] || [ -z "$OUTFILE" ]; then
    OUTFILE="$RECORDINGS/${BASENAME%.json}.ts"
fi

echo "Stream: $URL"
echo "Output: $OUTFILE"

# ===== RECORD =====
ffmpeg -y -loglevel error -i "$URL" -t 60 -c copy "$OUTFILE"

# ===== CHECK RESULT =====
if [ -f "$OUTFILE" ]; then
    SIZE=$(stat -f%z "$OUTFILE")

    if [ "$SIZE" -gt 1000000 ]; then
        echo "SUCCESS"
        mv "$JOB" "$COMPLETE/"
    else
        echo "FAILED (too small)"
        mv "$JOB" "$FAILED/"
    fi
else
    echo "FAILED (no file)"
    mv "$JOB" "$FAILED/"
fi