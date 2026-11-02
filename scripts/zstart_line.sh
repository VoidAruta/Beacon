#!/usr/bin/env bash
# Идемпотентный запуск Hub для добавления в zstart (Ubuntu chroot на Android)
HUB_DIR="${HUB_DIR:-/opt/hub}"
LOG_FILE="${HUB_DIR}/data/logs/hub-daemon.log"

mkdir -p "${HUB_DIR}/data/logs"

if pgrep -f "python.*-m hub" >/dev/null 2>&1; then
    exit 0
fi

cd "${HUB_DIR}" || exit 1
if [ -x "${HUB_DIR}/.venv/bin/python" ]; then
    nohup "${HUB_DIR}/.venv/bin/python" -m hub >> "${LOG_FILE}" 2>&1 < /dev/null &
else
    nohup python3 -m hub >> "${LOG_FILE}" 2>&1 < /dev/null &
fi
