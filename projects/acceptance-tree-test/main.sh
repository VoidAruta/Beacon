#!/usr/bin/env bash
set -euo pipefail

echo "[bash-runner] Проект запущен. PID=$$, Workdir=$(pwd)"
for i in 1 2 3; do
    echo "[bash-runner] Шаг выполнения #${i}..."
    sleep 1
done
echo "[bash-runner] Успешное завершение."
