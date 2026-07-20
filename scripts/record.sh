#!/bin/bash

TITLE="$1"
STREAM="$2"
DURATION="$3"
BASE="/Users/garyscudder/recordings"
FINAL="/Volumes/Plex/Movies/$TITLE"

mkdir -p "$BASE/temp" "$BASE/complete" "$FINAL"

/opt/homebrew/bin/ffmpeg -loglevel error -i "$STREAM" -t "$DURATION" -c copy "$BASE/temp/$TITLE.ts"

if [ $? -ne 0 ]; then
  echo "FAIL: capture"
  exit 1
fi

/opt/homebrew/bin/ffmpeg -loglevel error -i "$BASE/temp/$TITLE.ts" -c copy -movflags +faststart "$BASE/complete/$TITLE.mp4"

if [ $? -ne 0 ]; then
  echo "FAIL: convert"
  exit 2
fi

mv "$BASE/complete/$TITLE.mp4" "$FINAL/$TITLE.mp4"