#!/usr/bin/env bash
# ==============================================================================
# Универсальный установщик Beacon Control Panel (Ubuntu/Debian aarch64 & x86_64)
# Автоматически определяет профиль окружения:
#   1) Android Chroot / Termux (без systemd, с группами aid_inet 3003 / aid_net_raw 3004)
#   2) Полноценный Linux VPS / Mini-PC / Raspberry Pi (systemd unit + непривилегированный beacon-runner)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BEACON_DIR="${BEACON_DIR:-${ARUTA_DIR:-${HUB_DIR:-$SCRIPT_DIR}}}"
BEACON_PORT="${BEACON_PORT:-${ARUTA_PORT:-${HUB_PORT:-8050}}}"

echo "================================================================"
echo "  Установка Beacon Control Panel в ${BEACON_DIR}"
echo "================================================================"

if [ "$(id -u)" -ne 0 ]; then
    echo "[!] Запустите установщик от root: sudo bash scripts/install.sh"
    exit 1
fi

# 1. Определение среды (Android Chroot vs Стандартный Linux с systemd)
IS_ANDROID_CHROOT=0
if [ -f "/system/build.prop" ] || [ -d "/system/bin" ] || [ -e "/dev/socket" ]; then
    IS_ANDROID_CHROOT=1
fi

HAS_SYSTEMD=0
if [ -d "/run/systemd/system" ] && command -v systemctl >/dev/null 2>&1 && [ "$IS_ANDROID_CHROOT" -eq 0 ]; then
    HAS_SYSTEMD=1
fi

echo "[*] Профиль среды: IS_ANDROID_CHROOT=${IS_ANDROID_CHROOT}, HAS_SYSTEMD=${HAS_SYSTEMD} ($(uname -m))"

# 2. Установка системных пакетов
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip sqlite3 git curl ca-certificates >/dev/null

# 3. Создание непривилегированного пользователя beacon-runner для дочерних проектов
if ! id -u beacon-runner >/dev/null 2>&1; then
    echo "[*] Создание системного пользователя beacon-runner..."
    useradd --system --create-home --home-dir /home/beacon-runner --shell /usr/sbin/nologin beacon-runner || true
fi

# В Android Chroot добавляем пользователя в группы aid_inet (3003) и aid_net_raw (3004) для доступа к сокетам
if [ "$IS_ANDROID_CHROOT" -eq 1 ]; then
    echo "[*] Обнаружено ядро Android: настройка групп aid_inet (3003) и aid_net_raw (3004)..."
    groupadd -g 3003 -f aid_inet || true
    groupadd -g 3004 -f aid_net_raw || true
    usermod -aG 3003,3004 beacon-runner || true
    usermod -aG 3003,3004 root || true
fi

# 4. Создание структуры каталогов и прав
mkdir -p \
    "${BEACON_DIR}/data/secrets" \
    "${BEACON_DIR}/data/logs" \
    "${BEACON_DIR}/data/backups" \
    "${BEACON_DIR}/data/generated" \
    "${BEACON_DIR}/projects/examples" \
    "${BEACON_DIR}/scripts"

chmod 0700 "${BEACON_DIR}/data" "${BEACON_DIR}/data/secrets" "${BEACON_DIR}/data/backups"
chown -R beacon-runner:beacon-runner "${BEACON_DIR}/projects" "${BEACON_DIR}/data/logs" || true

# 5. Виртуальное окружение Python (.venv) и лёгкие зависимости (только pre-built wheels в приоритете)
if [ ! -d "${BEACON_DIR}/.venv" ]; then
    echo "[*] Создание виртуального окружения ${BEACON_DIR}/.venv..."
    python3 -m venv "${BEACON_DIR}/.venv"
fi

echo "[*] Установка зависимостей в ${BEACON_DIR}/.venv..."
"${BEACON_DIR}/.venv/bin/pip" install --upgrade pip --quiet
"${BEACON_DIR}/.venv/bin/pip" install --only-binary=:all: -r "${BEACON_DIR}/requirements.txt" --quiet || \
    "${BEACON_DIR}/.venv/bin/pip" install -r "${BEACON_DIR}/requirements.txt" --quiet

# 6. Миграция БД и запуск самодиагностики Doctor
echo "[*] Инициализация базы данных SQLite (WAL) и проверка окружения..."
cd "${BEACON_DIR}"
export BEACON_DIR BEACON_PORT
"${BEACON_DIR}/.venv/bin/python" -m beacon migrate
"${BEACON_DIR}/.venv/bin/python" -m beacon doctor || true

# 7. Настройка автозапуска (systemd или zstart_line.sh для Android Chroot)
if [ "$HAS_SYSTEMD" -eq 1 ]; then
    echo "[*] Генерация и регистрация службы systemd (beacon.service)..."
    "${BEACON_DIR}/.venv/bin/python" -m beacon systemd >/dev/null
    cp "${BEACON_DIR}/data/generated/beacon.service" /etc/systemd/system/beacon.service
    systemctl daemon-reload
    systemctl enable --now beacon.service
    echo "[+] Служба beacon.service запущена через systemd!"
else
    echo "[*] Среда без systemd (Android Chroot / контейнер)."
    echo "    Для автозапуска добавьте строку из ${BEACON_DIR}/scripts/zstart_line.sh в ваш стартовый скрипт:"
    cat "${BEACON_DIR}/scripts/zstart_line.sh" || true
fi

echo "================================================================"
echo "  Установка завершена! Веб-панель: http://127.0.0.1:${BEACON_PORT}"
echo "  Пароль по умолчанию: admin (смените его сразу в Настройках!)"
echo "================================================================"
