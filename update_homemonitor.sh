#!/bin/bash
# HomeNetworkMonitor Mac Update Script
# Usage: ./update_homemonitor.sh

EPG="$HOME/epg"

echo "======================================="
echo "  HomeNetworkMonitor Update"
echo "======================================="

cd "$EPG"

# Check Downloads for updated files
for FILE in home_event_watcher.mjs ring_battery_report.mjs; do
  if [ -f "$HOME/Downloads/$FILE" ]; then
    cp "$HOME/Downloads/$FILE" "$EPG/$FILE"
    echo "Copied $FILE from Downloads"
    rm "$HOME/Downloads/$FILE"
  fi
done

# Git push
echo ""
echo "Pushing to GitHub..."
git add home_event_watcher.mjs ring_battery_report.mjs .gitignore
git diff --cached --quiet && echo "No changes to commit." && exit 0

DATE=$(date "+%Y.%m.%d %H:%M")
git commit -m "Update $DATE" && git push
echo ""
echo "Done."
