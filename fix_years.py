import os
import re
import time
import requests
from pathlib import Path

# ─── CONFIG ───────────────────────────────────────────────
PLEX_MOVIES  = "/Volumes/Plex/Movies"
OMDB_API_KEY = "96b19d"
YEAR_OVERRIDES = {
    "death wish": "1974",
}
DRY_RUN      = False   # ← set to False when ready to actually rename
# ──────────────────────────────────────────────────────────

def get_omdb_year(title: str) -> str:
    """Look up release year from OMDB"""
    override = YEAR_OVERRIDES.get(clean_title(title).lower())
    if override:
        return override

    try:
        url = f"http://www.omdbapi.com/?t={requests.utils.quote(title)}&apikey={OMDB_API_KEY}"
        r = requests.get(url, timeout=5)
        data = r.json()
        if data.get("Response") == "True":
            return data.get("Year", "")[:4]  # just the 4 digit year
    except:
        pass
    return None

def clean_title(folder_name: str) -> str:
    """Strip year from folder name to get clean title"""
    return re.sub(r'\s*\(\d{4}\)\s*$', '', folder_name).strip()

def fix_movie_folders():
    movies_path = Path(PLEX_MOVIES)
    folders = [f for f in movies_path.iterdir() if f.is_dir()]
    
    print(f"Found {len(folders)} movie folders")
    print(f"DRY RUN: {DRY_RUN}\n")
    print(f"{'OLD NAME':<50} {'NEW NAME':<50}")
    print("-" * 100)

    fixed   = 0
    skipped = 0
    failed  = 0

    for folder in sorted(folders):
        name = folder.name

        # Only process folders ending in (2026)
        if not name.endswith("(2026)"):
            skipped += 1
            continue

        title = clean_title(name)

        # Look up real year from OMDB
        year = get_omdb_year(title)

        if not year:
            print(f"{'✗ NOT FOUND':<50} {name}")
            failed += 1
            continue

        if year == "2026":
            print(f"{'✓ YEAR CONFIRMED 2026':<50} {name}")
            skipped += 1
            continue

        new_name   = f"{title} ({year})"
        old_path   = folder
        new_path   = movies_path / new_name

        print(f"{name:<50} → {new_name}")

        if not DRY_RUN:
            try:
                # Rename folder
                old_path.rename(new_path)

                # Rename file inside folder if it matches
                old_file = new_path / f"{name}.mp4"
                new_file = new_path / f"{new_name}.mp4"

                if old_file.exists():
                    old_file.rename(new_file)

                fixed += 1
            except Exception as ex:
                print(f"  ✗ ERROR: {ex}")
                failed += 1
        else:
            fixed += 1

        # Rate limit OMDB calls
        time.sleep(0.3)

    print()
    print("─" * 50)
    print(f"Would fix : {fixed}" if DRY_RUN else f"Fixed   : {fixed}")
    print(f"Skipped   : {skipped}")
    print(f"Failed    : {failed}")
    print()
    if DRY_RUN:
        print("Set DRY_RUN = False to apply changes")

if __name__ == "__main__":
    fix_movie_folders()
