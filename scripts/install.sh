#!/usr/bin/env bash
set -euo pipefail

HUB_DIR="${HUB_DIR:-/opt/hub}"
echo "=== Установка Hub в ${HUB_DIR} ==="

if [ "$(id -u)" -ne 0 ]; then
    echo "ОШИБКА: Скрипт должен запускаться от root (внутри chroot)." >&2
    exit 1
fi

# 1. Создание структуры каталогов и прав доступа
mkdir -p "${HUB_DIR}/data/secrets" "${HUB_DIR}/data/logs" "${HUB_DIR}/projects" "${HUB_DIR}/hub/static/vendor"
chmod 0700 "${HUB_DIR}/data" "${HUB_DIR}/data/secrets"

# 2. Создание групп Android (CONFIG_ANDROID_PARANOID_NETWORK) и пользователя hub-runner
if ! getent group aid_inet >/dev/null 2>&1; then
    groupadd -g 3003 aid_inet 2>/dev/null || true
fi
if ! getent group aid_net_raw >/dev/null 2>&1; then
    groupadd -g 3004 aid_net_raw 2>/dev/null || true
fi

if ! id -u hub-runner >/dev/null 2>&1; then
    useradd -r -m -d /home/hub-runner -s /bin/bash -G 3003,3004 hub-runner 2>/dev/null || \
    useradd -r -m -d /home/hub-runner -s /bin/bash hub-runner
    usermod -aG 3003,3004 hub-runner 2>/dev/null || true
    echo "[+] Создан пользователь hub-runner (добавлен в группы aid_inet=3003, aid_net_raw=3004)"
else
    usermod -aG 3003,3004 hub-runner 2>/dev/null || true
    echo "[+] Пользователь hub-runner обновлён (группы 3003, 3004)"
fi

# 3. Создание виртуального окружения Python и установка зависимостей
if [ ! -d "${HUB_DIR}/.venv" ]; then
    echo "[+] Создание Python venv в ${HUB_DIR}/.venv..."
    python3 -m venv "${HUB_DIR}/.venv" || true
fi

if [ -x "${HUB_DIR}/.venv/bin/pip" ]; then
    echo "[+] Установка зависимостей из requirements.txt..."
    "${HUB_DIR}/.venv/bin/pip" install --upgrade pip
    "${HUB_DIR}/.venv/bin/pip" install -r "${HUB_DIR}/requirements.txt"
else
    echo "[!] pip в .venv недоступен, будет использован системный python3 и встроенный совместимый слой."
fi

# 4. Первичная настройка пароля администратора и инициализация SQLite (WAL)
ADMIN_PASS="${HUB_ADMIN_PASSWORD:-}"
if [ -z "${ADMIN_PASS}" ] && [ -t 0 ]; then
    read -r -s -p "Введите пароль администратора Hub (по умолчанию 'admin'): " ADMIN_PASS
    echo ""
fi
ADMIN_PASS="${ADMIN_PASS:-admin}"

PY_BIN="${HUB_DIR}/.venv/bin/python"
if [ ! -x "${PY_BIN}" ]; then
    PY_BIN="python3"
fi

HUB_DIR="${HUB_DIR}" HUB_INIT_PASSWORD="${ADMIN_PASS}" "${PY_BIN}" -c "
import os, sys
sys.path.insert(0, os.environ['HUB_DIR'])
from hub.db import init_db, set_setting
from hub.auth import hash_password
init_db()
pw = os.environ.get('HUB_INIT_PASSWORD', 'admin')
set_setting('password_hash', hash_password(pw))
print('[+] База данных SQLite (WAL) инициализирована, пароль администратора сохранён.')
"

chmod +x "${HUB_DIR}/scripts/zstart_line.sh" 2>/dev/null || true
echo "=== Установка успешно завершена! ==="
echo "Для запуска выполните: ${HUB_DIR}/scripts/zstart_line.sh"
