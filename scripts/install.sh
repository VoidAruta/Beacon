#!/usr/bin/env bash
# ==============================================================================
# Universal Beacon Control Panel Installer (Ubuntu/Debian aarch64 & x86_64)
# Supports both:
#   - 1-line remote install: curl -fsSL https://raw.githubusercontent.com/VoidAruta/Beacon/main/scripts/install.sh | sudo bash
#   - Local repo install:    sudo bash scripts/install.sh
# Automatically detects environment profile:
#   1) Standard Linux VPS / Mini-PC / Raspberry Pi (systemd unit + unprivileged beacon-runner)
#   2) Android Chroot / Termux / Container without systemd (aid_inet 3003 / aid_net_raw 3004 + background daemon)
# ==============================================================================
set -euo pipefail

BEACON_REPO_URL="${BEACON_REPO_URL:-https://github.com/VoidAruta/Beacon.git}"
BEACON_PORT="${BEACON_PORT:-8050}"

if ! [[ "$BEACON_PORT" =~ ^[0-9]+$ ]] || [ "$BEACON_PORT" -lt 1 ] || [ "$BEACON_PORT" -gt 65535 ]; then
    echo "[!] Invalid BEACON_PORT='${BEACON_PORT}' (expected 1..65535)" >&2
    exit 1
fi

# Detect if running from an existing checkout or piped via `curl ... | bash`
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
    CANDIDATE_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")/.." && pwd)"
    if [ -f "${CANDIDATE_DIR}/requirements.txt" ] && [ -d "${CANDIDATE_DIR}/beacon" ]; then
        BEACON_DIR="${BEACON_DIR:-$CANDIDATE_DIR}"
    fi
fi
BEACON_DIR="${BEACON_DIR:-/opt/beacon}"

echo "================================================================"
echo "  Beacon Control Panel Installer -> ${BEACON_DIR} (port ${BEACON_PORT})"
echo "================================================================"

if [ "$(id -u)" -ne 0 ]; then
    echo "[!] Please run the installer as root: sudo bash scripts/install.sh"
    exit 1
fi

# 1. Detect environment profile (Android Chroot vs Standard Linux with systemd)
IS_ANDROID_CHROOT=0
if [ -f "/system/build.prop" ] || [ -d "/system/bin" ] || [ -e "/dev/socket" ]; then
    IS_ANDROID_CHROOT=1
fi

HAS_SYSTEMD=0
if [ -d "/run/systemd/system" ] && command -v systemctl >/dev/null 2>&1 && [ "$IS_ANDROID_CHROOT" -eq 0 ]; then
    HAS_SYSTEMD=1
fi

echo "[*] Environment profile: IS_ANDROID_CHROOT=${IS_ANDROID_CHROOT}, HAS_SYSTEMD=${HAS_SYSTEMD} ($(uname -m))"

# 2. Install system packages
if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv python3-pip sqlite3 git curl ca-certificates >/dev/null
fi

# 2b. Clone or update repository if running via `curl ... | bash`
if [ ! -f "${BEACON_DIR}/requirements.txt" ] || [ ! -d "${BEACON_DIR}/beacon" ]; then
    echo "[*] Cloning Beacon repository into ${BEACON_DIR}..."
    mkdir -p "$(dirname "${BEACON_DIR}")"
    git clone --depth 1 -- "${BEACON_REPO_URL}" "${BEACON_DIR}"
fi

# 3. Create unprivileged system user beacon-runner for child projects
if ! id -u beacon-runner >/dev/null 2>&1; then
    echo "[*] Creating unprivileged user beacon-runner..."
    useradd --system --create-home --home-dir /home/beacon-runner --shell /usr/sbin/nologin beacon-runner || true
fi

# In Android Chroot add user to aid_inet (3003) and aid_net_raw (3004) for socket access
if [ "$IS_ANDROID_CHROOT" -eq 1 ]; then
    echo "[*] Android kernel detected: configuring groups aid_inet (3003) and aid_net_raw (3004)..."
    groupadd -g 3003 -f aid_inet || true
    groupadd -g 3004 -f aid_net_raw || true
    usermod -aG 3003,3004 beacon-runner || true
    usermod -aG 3003,3004 root || true
fi

# 4. Create directory structure and permissions
mkdir -p \
    "${BEACON_DIR}/data/secrets" \
    "${BEACON_DIR}/data/logs" \
    "${BEACON_DIR}/data/backups" \
    "${BEACON_DIR}/data/generated" \
    "${BEACON_DIR}/projects/examples" \
    "${BEACON_DIR}/scripts"

chmod 0700 "${BEACON_DIR}/data" "${BEACON_DIR}/data/secrets" "${BEACON_DIR}/data/backups"
chown -R beacon-runner:beacon-runner "${BEACON_DIR}/projects" "${BEACON_DIR}/data/logs" || true

# 5. Python virtual environment (.venv) & lightweight dependencies (prefer pre-built wheels)
if [ ! -d "${BEACON_DIR}/.venv" ]; then
    echo "[*] Creating virtual environment ${BEACON_DIR}/.venv..."
    python3 -m venv "${BEACON_DIR}/.venv"
fi

echo "[*] Installing Python dependencies in ${BEACON_DIR}/.venv..."
"${BEACON_DIR}/.venv/bin/pip" install --upgrade pip --quiet
"${BEACON_DIR}/.venv/bin/pip" install --only-binary=:all: -r "${BEACON_DIR}/requirements.txt" --quiet || \
    "${BEACON_DIR}/.venv/bin/pip" install -r "${BEACON_DIR}/requirements.txt" --quiet

# 6. Database migration (including automatic migration of any legacy installation) & Doctor check
echo "[*] Initializing SQLite (WAL) database and running environment checks..."
cd "${BEACON_DIR}"
export BEACON_DIR BEACON_PORT
"${BEACON_DIR}/.venv/bin/python" -m beacon migrate
"${BEACON_DIR}/.venv/bin/python" -m beacon doctor || true

# 7. Configure auto-start (systemd or zstart_line.sh for Android Chroot / container)
if [ "$HAS_SYSTEMD" -eq 1 ]; then
    echo "[*] Generating and enabling systemd service (beacon.service)..."
    "${BEACON_DIR}/.venv/bin/python" -m beacon systemd >/dev/null
    cp "${BEACON_DIR}/data/generated/beacon.service" /etc/systemd/system/beacon.service
    chmod 0644 /etc/systemd/system/beacon.service
    systemctl daemon-reload
    systemctl enable --now beacon.service
    echo "[+] Service beacon.service started via systemd!"
else
    echo "[*] Non-systemd environment detected (Android Chroot / container)."
    echo "[*] Starting Beacon daemon in background via scripts/zstart_line.sh..."
    BEACON_DIR="${BEACON_DIR}" BEACON_PORT="${BEACON_PORT}" bash "${BEACON_DIR}/scripts/zstart_line.sh" || true
    echo "    To auto-start on chroot boot, add ${BEACON_DIR}/scripts/zstart_line.sh to your init script."
fi

echo "================================================================"
echo "  Installation complete! Web UI: http://127.0.0.1:${BEACON_PORT}"
echo "  Default password: admin (change it immediately in Settings!)"
echo "================================================================"
