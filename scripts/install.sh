#!/usr/bin/env bash
# ==============================================================================
# Универсальный установщик Aruta (совместимо с Hub) (Ubuntu/Debian aarch64 & x86_64)
# Автоматически определяет профиль окружения:
#   1) Android Chroot / Termux (без systemd, с группами aid_inet 3003 / aid_net_raw 3004)
#   2) Полноценный Linux VPS / Mini-PC / Raspberry Pi (systemd unit + непривилегированный hub-runner)
# ==============================================================================
set -euo pipefail

ARUTA_DIR="${ARUTA_DIR:-${HUB_DIR:-/opt/hub}}"
ARUTA_PORT="${ARUTA_PORT:-${HUB_PORT:-8050}}"

echo "================================================================"
echo "  Установка Aruta Control Panel в ${ARUTA_DIR}"
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

# 3. Создание непривилегированного пользователя hub-runner для дочерних проектов
if ! id -u hub-runner >/dev/null 2>&1; then
    echo "[*] Создание системного пользователя hub-runner..."
    useradd --system --create-home --home-dir /home/hub-runner --shell /bin/bash hub-runner || true
fi

# В Android Chroot добавляем пользователя в группы aid_inet (3003) и aid_net_raw (3004) для доступа к сокетам
if [ "$IS_ANDROID_CHROOT" -eq 1 ]; then
    echo "[*] Обнаружено ядро Android: настройка групп aid_inet (3003) и aid_net_raw (3004)..."
    groupadd -g 3003 -f aid_inet || true
    groupadd -g 3004 -f aid_net_raw || true
    usermod -aG 3003,3004 hub-runner || true
    usermod -aG 3003,3004 root || true
fi

# 4. Создание структуры каталогов и прав
mkdir -p "${ARUTA_DIR}/data/secrets" "${ARUTA_DIR}/logs" "${ARUTA_DIR}/projects/examples" "${ARUTA_DIR}/scripts"
chmod 0700 "${ARUTA_DIR}/data/secrets"
chown -R hub-runner:hub-runner "${ARUTA_DIR}/projects" "${ARUTA_DIR}/logs" || true

# 5. Виртуальное окружение Python (.venv) и лёгкие зависимости (только pre-built wheels)
if [ ! -d "${ARUTA_DIR}/.venv" ]; then
    echo "[*] Создание виртуального окружения ${ARUTA_DIR}/.venv..."
    python3 -m venv "${ARUTA_DIR}/.venv"
fi

echo "[*] Установка зависимостей в ${ARUTA_DIR}/.venv..."
"${ARUTA_DIR}/.venv/bin/pip" install --upgrade pip --quiet
"${ARUTA_DIR}/.venv/bin/pip" install --only-binary=:all: -r "${ARUTA_DIR}/requirements.txt" --quiet || \
    "${ARUTA_DIR}/.venv/bin/pip" install -r "${ARUTA_DIR}/requirements.txt" --quiet

# 6. Инициализация БД и запуск самодиагностики Doctor
echo "[*] Инициализация базы данных SQLite (WAL) и проверка окружения..."
cd "${ARUTA_DIR}"
"${ARUTA_DIR}/.venv/bin/python" -m aruta doctor || true

# 7. Настройка автозапуска (systemd или zstart.sh для Android Chroot)
if [ "$HAS_SYSTEMD" -eq 1 ]; then
    echo "[*] Генерация и регистрация службы systemd (aruta.service)..."
    "${ARUTA_DIR}/.venv/bin/python" -m aruta systemd >/dev/null
    cp "${ARUTA_DIR}/scripts/aruta.service" /etc/systemd/system/aruta.service
    cp "${ARUTA_DIR}/scripts/hub.service" /etc/systemd/system/hub.service
    systemctl daemon-reload
    systemctl enable --now aruta.service
    echo "[+] Служба aruta.service запущена через systemd!"
else
    echo "[*] Среда без systemd (Android Chroot / контейнер)."
    echo "    Для автозапуска добавьте строку из ${ARUTA_DIR}/scripts/zstart_line.sh в ваш стартовый скрипт:"
    cat "${ARUTA_DIR}/scripts/zstart_line.sh" || true
fi

echo "================================================================"
echo "  Установка завершена! Веб-панель: http://127.0.0.1:${ARUTA_PORT}"
echo "  Пароль по умолчанию: admin (смените его сразу в Настройках!)"
echo "================================================================"
