#!/bin/bash

INPUT="/Volumes/FireTV"
OUTPUT="/Volumes/Plex/Movies"
LOG="$HOME/epg/convert.log"
PROCESSED="$INPUT/processed"
MAX_JOBS=8

mkdir -p "$PROCESSED"

echo "===== START $(date) =====" >> "$LOG"

# verify mounts exist
if [ ! -d "$INPUT" ]; then
    echo "ERROR: $INPUT not mounted" | tee -a "$LOG"
    exit 1
fi

if [ ! -d "$OUTPUT" ]; then
    echo "ERROR: $OUTPUT not mounted" | tee -a "$LOG"
    exit 1
fi

cd "$INPUT" || exit

process_file () {

    f="$1"
    size=$(stat -f%z "$f")

    echo "Processing: $f ($size bytes)"

    # skip tiny/broken recordings
    if [ "$size" -lt 1000000000 ]; then
        echo "SKIP small/bad TS → $f" | tee -a "$LOG"
        mv "$f" "$PROCESSED/"
        return
    fi

    base=$(basename "$f" .ts | sed -E 's/_[0-9]{8}_[0-9]{6}$//' | tr '_' ' ')
    tmp="$OUTPUT/$base.tmp.mp4"
    out="$OUTPUT/$base.mp4"

    if [ -f "$out" ]; then
        echo "SKIP exists → $out" | tee -a "$LOG"
        mv "$f" "$PROCESSED/"
        return
    fi

    ffmpeg -nostdin -loglevel error \
        -fflags +discardcorrupt \
        -err_detect ignore_err \
        -i "$f" \
        -map 0:v:0 -map 0:a:0? \
        -c:v libx264 -preset medium -crf 23 \
        -c:a aac -b:a 160k \
        -movflags +faststart \
        "$tmp"

    if [ $? -eq 0 ]; then

        mv "$tmp" "$out"

        # remove macOS quarantine flag
        xattr -d com.apple.quarantine "$out" 2>/dev/null

        echo "SUCCESS → $out" | tee -a "$LOG"

        mv "$f" "$PROCESSED/"

    else

        echo "FAILED encode → keeping TS $f" | tee -a "$LOG"
        rm -f "$tmp"

    fi

}

export -f process_file
export OUTPUT LOG PROCESSED

ls -S *.ts 2>/dev/null | \
xargs -P$MAX_JOBS -I{} bash -c 'process_file "$@"' _ "{}"

echo "===== END $(date) =====" >> "$LOG"