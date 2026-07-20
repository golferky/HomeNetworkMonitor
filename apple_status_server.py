#!/usr/bin/env python3
"""
Apple device status receiver for Shortcuts.

Run on the Mac:
  cd /Users/garyscudder/epg
  python3 apple_status_server.py

Shortcuts POST URL:
  http://192.168.1.190:5055/apple_device
"""

import json
import logging
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request


SERVER_VERSION = "2026.06.09.1"
SERVER_PORT = 5055
APPLE_DEVICES_JSON_PATH = "/Users/garyscudder/epg/apple_devices.json"
LOG_PATH = "/Users/garyscudder/epg/logs/apple_status_server.log"

app = Flask(__name__)

Path(LOG_PATH).parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)


def load_apple_devices():
    path = Path(APPLE_DEVICES_JSON_PATH)
    if not path.exists():
        return {"devices": []}

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"devices": []}

    if isinstance(data, list):
        return {"devices": data}
    if isinstance(data, dict) and isinstance(data.get("devices"), list):
        return data
    return {"devices": []}


def normalize_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def normalize_apple_device_payload(data):
    name = str(data.get("name") or data.get("deviceName") or "").strip()
    if not name:
        raise ValueError("Missing name")

    battery = data.get("battery")
    if battery is not None and battery != "":
        battery = max(0, min(100, round(float(battery))))
    else:
        battery = None

    return {
        "name": name,
        "model": str(data.get("model") or data.get("deviceType") or "").strip(),
        "battery": battery,
        "charging": normalize_bool(data.get("charging")),
        "lowPowerMode": normalize_bool(data.get("lowPowerMode")),
        "lastSeenAt": datetime.now().isoformat(timespec="seconds"),
    }


@app.route("/ping")
def ping():
    return jsonify({
        "status": "ok",
        "version": SERVER_VERSION,
        "time": datetime.now().isoformat(timespec="seconds"),
        "apple_devices_path": APPLE_DEVICES_JSON_PATH,
        "apple_devices_exists": Path(APPLE_DEVICES_JSON_PATH).exists(),
    })


@app.route("/apple_device", methods=["POST"])
def apple_device_status():
    try:
        data = request.get_json(silent=True) or request.form.to_dict() or {}
        incoming = normalize_apple_device_payload(data)

        status = load_apple_devices()
        devices = status["devices"]
        replaced = False

        for index, device in enumerate(devices):
            if str(device.get("name", "")).lower() == incoming["name"].lower():
                devices[index] = {**device, **incoming}
                replaced = True
                break

        if not replaced:
            devices.append(incoming)

        status["devices"] = sorted(devices, key=lambda d: str(d.get("name", "")).lower())
        status["updatedAt"] = datetime.now().isoformat(timespec="seconds")

        path = Path(APPLE_DEVICES_JSON_PATH)
        tmp_path = path.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(status, f, indent=2)
        tmp_path.replace(path)

        log.info(
            "APPLE DEVICE STATUS -> %s | battery=%s | charging=%s",
            incoming["name"],
            incoming["battery"],
            incoming["charging"],
        )
        return jsonify({"status": "ok", "device": incoming})
    except Exception as e:
        log.error("POST /apple_device error -> %s", e)
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    log.info("Apple status server v%s listening on port %s", SERVER_VERSION, SERVER_PORT)
    app.run(host="0.0.0.0", port=SERVER_PORT, threaded=True)
