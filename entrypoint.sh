#!/bin/bash
set -e

echo "[openagent] Starting entrypoint..."

# Ensure data directories exist
mkdir -p /data/db /data/config /data/memory/daily /data/skills /data/npm-global /workspace

# Fix ownership on first run or after migration from root user
if [ "$(stat -c '%u' /workspace)" = "0" ]; then
    echo "[openagent] Migrating workspace ownership to agent user..."
    chown -R agent:agent /workspace
fi

if [ "$(stat -c '%u' /data)" = "0" ]; then
    echo "[openagent] Migrating data ownership to agent user..."
    chown -R agent:agent /data
fi

# Set up home defaults if missing (volume overlays image content on first run)
if [ ! -f /workspace/.bashrc ]; then
    cp /etc/skel/.bashrc /workspace/.bashrc
    chown agent:agent /workspace/.bashrc
fi

if [ ! -d /workspace/.ssh ]; then
    gosu agent mkdir -p -m 700 /workspace/.ssh
fi

# ---------------------------------------------------------------------------
# Restore agent-installed packages from previous container runs
# These are auto-tracked by the DPkg::Post-Invoke hook in track-packages.sh
# ---------------------------------------------------------------------------
AGENT_PACKAGES="/data/agent-packages.txt"
if [ -f "$AGENT_PACKAGES" ] && [ -s "$AGENT_PACKAGES" ]; then
    echo "[openagent] Found tracked agent packages, checking for restoration..."
    apt-get update -qq 2>/dev/null

    available=()
    unavailable=()
    already_installed=()

    while IFS= read -r pkg || [ -n "$pkg" ]; do
        pkg=$(echo "$pkg" | xargs)
        [ -z "$pkg" ] && continue

        # Check if already installed in this image (might have been added to base)
        if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
            already_installed+=("$pkg")
            continue
        fi

        # Check if available in current repos
        if apt-cache show "$pkg" > /dev/null 2>&1; then
            available+=("$pkg")
        else
            unavailable+=("$pkg")
        fi
    done < "$AGENT_PACKAGES"

    if [ ${#already_installed[@]} -gt 0 ]; then
        echo "[openagent] ${#already_installed[@]} package(s) already in base image, skipping."
    fi

    if [ ${#unavailable[@]} -gt 0 ]; then
        echo "[openagent] ⚠ ${#unavailable[@]} package(s) no longer available (skipped):"
        printf "[openagent]   - %s\n" "${unavailable[@]}"
        # Append to log for historical reference
        {
            echo "--- $(date '+%Y-%m-%d %H:%M:%S') --- Image: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"') ---"
            printf "  %s\n" "${unavailable[@]}"
        } >> /data/packages-unavailable.log
    fi

    if [ ${#available[@]} -gt 0 ]; then
        echo "[openagent] Restoring ${#available[@]} agent-installed package(s)..."
        # Try batch install first (fast)
        if apt-get install -y "${available[@]}" > /tmp/apt-restore.log 2>&1; then
            echo "[openagent] ✓ All ${#available[@]} packages restored successfully."
        else
            # Fallback: install one by one to identify problematic packages
            echo "[openagent] ⚠ Batch install failed, trying packages individually..."
            failed=()
            for pkg in "${available[@]}"; do
                if ! apt-get install -y "$pkg" > /dev/null 2>&1; then
                    failed+=("$pkg")
                    echo "[openagent]   ✗ Failed: $pkg"
                fi
            done
            succeeded=$(( ${#available[@]} - ${#failed[@]} ))
            echo "[openagent] ✓ Restored $succeeded/${#available[@]} packages (${#failed[@]} failed)."
        fi
    else
        echo "[openagent] No packages need restoration."
    fi

    rm -f /tmp/apt-restore.log
fi

# ---------------------------------------------------------------------------
# Install user-defined packages from packages.txt (manual/static list)
# ---------------------------------------------------------------------------
PACKAGES_FILE="/data/packages.txt"
if [ -f "$PACKAGES_FILE" ] && [ -s "$PACKAGES_FILE" ]; then
    echo "[openagent] Found $PACKAGES_FILE, checking for packages to install..."
    apt-get update -qq 2>/dev/null

    while IFS= read -r package || [ -n "$package" ]; do
        # Skip empty lines and comments
        package=$(echo "$package" | xargs)
        if [ -z "$package" ] || [[ "$package" == \#* ]]; then
            continue
        fi

        # Skip if already installed
        if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
            continue
        fi

        # Check availability
        if ! apt-cache show "$package" > /dev/null 2>&1; then
            echo "[openagent] ⚠ Package '$package' not available, skipping."
            continue
        fi

        echo "[openagent] Installing package: $package"
        apt-get install -y "$package" 2>/dev/null || {
            echo "[openagent] ⚠ Failed to install package '$package'"
        }
    done < "$PACKAGES_FILE"
    echo "[openagent] User-defined package installation complete."
else
    echo "[openagent] No $PACKAGES_FILE found, skipping."
fi

# Clean up apt cache to save space
apt-get clean 2>/dev/null || true
rm -rf /var/lib/apt/lists/*

# Start the application as agent user
echo "[openagent] Starting server as agent user..."
cd /app
exec gosu agent npm run start --workspace=packages/web-backend
