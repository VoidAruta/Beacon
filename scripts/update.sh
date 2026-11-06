#!/usr/bin/env bash
# ==============================================================================
# Скрипт автоматического обновления Beacon Control Panel
# Выполняет git pull, обновляет зависимости и перезапускает панель.
# ==============================================================================
set -euo pipefail

BEACON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BEACON_DIR"

echo "================================================================"
echo "  Обновление Beacon Control Panel в ${BEACON_DIR}"
echo "================================================================"

# 1. Получение последних изменений из GitHub
echo "[*] Получение последних изменений из ветки main..."
git fetch origin main
git reset --hard origin/main

# 2. Обновление зависимостей Python
echo "[*] Проверка и обновление зависимостей Python..."
if [ -d ".venv" ]; then
    .venv/bin/pip install --upgrade pip --quiet
    .venv/bin/pip install -r requirements.txt --quiet
else
    echo "[!] Виртуальное окружение не найдено. Создаем..."
    python3 -m venv .venv
    .venv/bin/pip install --upgrade pip --quiet
    .venv/bin/pip install -r requirements.txt --quiet
fi

# 3. Перезапуск панели
# Проверяем, есть ли systemd (для классических серверов)
if [ -d "/run/systemd/system" ] && command -v systemctl >/dev/null 2>&1; then
    echo "[*] Перезапуск службы через systemd..."
    sudo systemctl daemon-reload || true
    # Пытаемся перезапустить службу по всем историческим именам
    sudo systemctl restart beacon || sudo systemctl restart aruta || sudo systemctl restart hub || true
    echo "[+] Обновление завершено! Служба перезапущена."
else
    # Среда Android chroot / Termux
    echo "[*] Среда Android chroot. Пытаемся мягко остановить старый процесс панели..."
    pkill -f "python3 -m beacon" || pkill -f "python3 -m hub" || true
    sleep 2
    
    echo "================================================================"
    echo "[+] Исходный код обновлен!"
    echo "    Для запуска новой версии панели выполните вашу команду запуска,"
    echo "    например: .venv/bin/python main.py (или скрипт, который вы используете)."
    echo "================================================================"
fi
