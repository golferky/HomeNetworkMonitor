import subprocess
import os
from datetime import datetime

# --- Source Configuration ---
# Clear nicknames for your Primestreams credentials
SOURCE_BASE = "http://primestreams.tv:826/live"
SOURCE_USER = "jFYSJ6UprmRRO"
SOURCE_PASS = "Hq0Nl2sZqRGSR9yo"
SOURCE_CHID = "109150"

# FIXED: Added 'f' before the quotes so Python populates the variables
# This builds the URL: http://primestreams.tv:826/xmltv.php/user/pass/id.ts
SOURCE_URL = f"{SOURCE_BASE}/{SOURCE_USER}/{SOURCE_PASS}/{SOURCE_CHID}.ts"

# --- Recording Settings ---
USER_AGENT = "TiViMate/4.7.0 (Amazon AFTS; Android 9; Build/PS7229)"
DURATION = "00:30:00"
OUTPUT_FILE = "Temp_Recording.mp4"

# --- FFmpeg Command List ---
# List format prevents "piecemeal" breakage and handles quotes for your Mac mini
ffmpeg_cmd = [
    "ffmpeg",
    "-nostdin",
    "-loglevel", "error",
    "-user_agent", USER_AGENT,
    "-thread_queue_size", "1024",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-fflags", "+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", SOURCE_URL,
    "-t", DURATION,
    "-map", "0",
    "-c:v", "copy",
    "-c:a", "copy",
    "-movflags", "+faststart",
    OUTPUT_FILE
]

def run_recording():
    now = datetime.now()
    timestamp = now.strftime('%Y-%m-%d %H:%M:%S')
    
    print(f"[{timestamp}] Starting recording...")
    print(f"Source ID: {SOURCE_CHID}")
    print(f"Full URL: {SOURCE_URL}")
    
    try:
        # Executes the command on your Mac mini
        subprocess.run(ffmpeg_cmd, check=True)
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Recording finished successfully.")
        
        # Notification sound (7 AM - 9 PM only for non-golf scripts)
        if 7 <= now.hour < 21:
            os.system('afplay /System/Library/Sounds/Glass.aiff')

    except subprocess.CalledProcessError as e:
        print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Error: FFmpeg failed.")
        print(f"Details: {e}")
    except Exception as ex:
        print(f"An unexpected error occurred: {ex}")

if __name__ == "__main__":
    run_recording()