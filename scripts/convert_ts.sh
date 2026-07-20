#!/bin/bash

NAS="192.168.1.176"
USER="garyscudder"

FIRETV="/Volumes/FireTV"
PLEX="/Volumes/Plex"

INPUT="$FIRETV"
PROCESSED="$FIRETV/processed"
OUTPUT="$PLEX/Movies"

LOG="$HOME/epg/convert.log"

echo "===== START $(date) =====" >> "$LOG"

########################################
# SMB reconnect function
########################################

connect_nas() {

echo "Checking NAS mounts..."

if [ ! -d "$FIRETV" ]; then
    echo "Mounting FireTV..."
    open "smb://$USER@$NAS/FireTV"
    sleep 5
fi

if [ ! -d "$PLEX" ]; then
    echo "Mounting Plex..."
    open "smb://$USER@$NAS/Plex"
    sleep 5
fi

}

########################################
# Ensure NAS connected
########################################

connect_nas

########################################
# Ensure processed folder exists
########################################

mkdir -p "$PROCESSED"

cd "$INPUT" || exit

########################################
# Find TS files (smallest first) limit 10
########################################

find . -maxdepth 1 -name "*.ts" -type f -print0 | while IFS= read -r -d '' file
do
    size=$(stat -f%z "$file")
    echo "$size|$file"
done | sort -n | head -10 | while IFS="|" read -r size f
do

    # If NAS drops, reconnect
    connect_nas

    name=$(basename "$f")
    base=$(basename "$f" .ts | sed -E 's/_[0-9]{8}_[0-9]{6}$//' | tr '_' ' ')
    out="$OUTPUT/$base.mp4"
    tmp="$OUTPUT/$base.tmp.mp4"

    echo "Processing: $name ($size bytes)" | tee -a "$LOG"

    if [ ! -f "$f" ]; then
        echo "SKIP missing file → $name" | tee -a "$LOG"
        continue
    fi

    if [ -f "$out" ]; then
        echo "SKIP already converted → $out" | tee -a "$LOG"
        mv "$f" "$PROCESSED/"
        continue
    fi

    ffmpeg -nostdin -err_detect ignore_err -y -loglevel error \
        -i "$f" \
        -c:v libx264 -preset medium -crf 23 \
        -c:a aac -b:a 160k \
        -movflags +faststart \
        "$tmp"

    if [ -f "$tmp" ]; then

        outsize=$(stat -f%z "$tmp")

        if [ "$outsize" -gt 500000000 ]; then
            mv "$tmp" "$out"
            echo "SUCCESS → $out" | tee -a "$LOG"
            mv "$f" "$PROCESSED/"
        else
            echo "FAILED encode → keeping TS $name" | tee -a "$LOG"
            rm "$tmp"
        fi
    fi

done

echo "===== END $(date) =====" >> "$LOG"

