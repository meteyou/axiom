#!/bin/bash
# Auto-track packages installed beyond the base image.
# Called automatically by DPkg::Post-Invoke apt hook after every dpkg operation.
# Compares currently installed packages against the base image snapshot
# and persists the diff to the /data volume.

BASE_FILE="/etc/dpkg-base-packages.txt"
TRACKED_FILE="/data/agent-packages.txt"

# Only track if prerequisites exist
[ -f "$BASE_FILE" ] || exit 0
[ -d "/data" ] || exit 0

# Get currently installed package names, diff against base image snapshot
dpkg-query -W -f='${Package}\n' 2>/dev/null | sort -u > /tmp/.dpkg-current-pkgs
comm -23 /tmp/.dpkg-current-pkgs "$BASE_FILE" > "$TRACKED_FILE" 2>/dev/null
rm -f /tmp/.dpkg-current-pkgs
