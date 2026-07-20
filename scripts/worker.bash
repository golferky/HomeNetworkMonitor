#!/bin/bash

BASE="/Volumes/Public/EPG/jobs"
PENDING="$BASE/pending"
PROCESSING="$BASE/processing"
COMPLETED="$BASE/completed"
FAILED="$BASE/failed"

MAX_JOBS=2   # 👈 change this for parallel recordings

mkdir -p "$PROCESSING" "$COMPLETED" "$FAILED"

running=$(pgrep -fc record_worker_instance)

if [ "$running" -ge "$MAX_JOBS" ]; then
  echo "Max jobs running ($running)"
  exit 0
fi

for job in "$PENDING"/*.json; do
  [ -e "$job" ] || exit 0

  fname=$(basename "$job")
  procJob="$PROCESSING/$fname"

  # Atomic move (prevents duplicate pickup)
  if mv "$job" "$procJob" 2>/dev/null; then
    echo "Picked up $fname"

    /Users/garyscudder/epg/scripts/record_single.sh "$procJob" &
    exit 0
  fi
done