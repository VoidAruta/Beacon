#!/usr/bin/env bash
# Idempotent Beacon startup helper for non-systemd environments (Ubuntu chroot on Android / containers)
BEACON_DIR="${BEACON_DIR:-/opt/beacon}"
BEACON_PORT="${BEACON_PORT:-8050}"
LOG_FILE="${BEACON_DIR}/data/logs/beacon-daemon.log"
PID_FILE="${BEACON_DIR}/data/beacon.pid"

mkdir -p "${BEACON_DIR}/data/logs"

if [ -f "${PID_FILE}" ]; then
    EXISTING_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [ -n "${EXISTING_PID}" ] && kill -0 "${EXISTING_PID}" 2>/dev/null; then
        exit 0
    fi
fi

if pgrep -f "python.*-m beacon" >/dev/null 2>&1; then
    exit 0
fi

cd "${BEACON_DIR}" || exit 1
export BEACON_DIR BEACON_PORT
if [ -x "${BEACON_DIR}/.venv/bin/python" ]; then
    nohup "${BEACON_DIR}/.venv/bin/python" -m beacon --port "${BEACON_PORT}" >> "${LOG_FILE}" 2>&1 < /dev/null &
else
    nohup python3 -m beacon --port "${BEACON_PORT}" >> "${LOG_FILE}" 2>&1 < /dev/null &
fi
