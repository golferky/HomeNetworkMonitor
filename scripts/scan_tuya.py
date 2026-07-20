import tinytuya

print("Scanning for Tuya / Atomi devices on your network...")

devices = tinytuya.deviceScan()

print("\nDevices found:")
for ip, info in devices.items():
    print("------------------------")
    print("IP:", ip)
    print("Device ID:", info.get("gwId"))
    print("Product Key:", info.get("productKey"))
    print("Version:", info.get("version"))