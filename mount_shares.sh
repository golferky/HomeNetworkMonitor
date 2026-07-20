#!/bin/bash
sleep 15
osascript -e 'mount volume "smb://GarysNas/EPG"'
osascript -e 'mount volume "smb://GarysNas/Fire TV"'
osascript -e 'mount volume "smb://GarysNas/Public"'
osascript -e 'mount volume "smb://GarysNas/Plex"'
