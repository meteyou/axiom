#!/bin/bash
set -e

echo "[openagent] Starting entrypoint..."

# Ensure data directories exist
mkdir -p /data/db /data/config /data/memory/daily /data/skills /workspace

# Install user-defined packages from packages.txt
PACKAGES_FILE="/data/packages.txt"
if [ -f "$PACKAGES_FILE" ]; then
    echo "[openagent] Found $PACKAGES_FILE, checking for packages to install..."
    while IFS= read -r package || [ -n "$package" ]; do
        # Skip empty lines and comments
        package=$(echo "$package" | xargs)
        if [ -z "$package" ] || [[ "$package" == \#* ]]; then
            continue
        fi

        echo "[openagent] Installing package: $package"
        apt-get update -qq && apt-get install -y -qq "$package" 2>/dev/null || {
            echo "[openagent] Warning: Failed to install package '$package'"
        }
    done < "$PACKAGES_FILE"
    echo "[openagent] Package installation complete."
else
    echo "[openagent] No $PACKAGES_FILE found, skipping package installation."
fi

# Start the application
echo "[openagent] Starting server..."
cd /app
exec npm run start --workspace=packages/web-backend
