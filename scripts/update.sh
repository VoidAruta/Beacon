#!/usr/bin/env bash
# ==============================================================================
# Скрипт безопасного обновления Beacon Control Panel
# Выполняет проверку чистоты дерева, автобэкап, git pull, миграцию БД,
# перезапуск панели и откат при неудачной проверке здоровья /api/auth/me.
# ==============================================================================
set -euo pipefail

FORCE_UPDATE=0
for arg in "$@"; do
    case "$arg" in
        --force|-f)
            FORCE_UPDATE=1
            ;;
    esac
done

BEACON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BEACON_PORT="${BEACON_PORT:-8050}"
if ! [[ "$BEACON_PORT" =~ ^[0-9]+$ ]] || [ "$BEACON_PORT" -lt 1 ] || [ "$BEACON_PORT" -gt 65535 ]; then
    echo "[!] Некорректный BEACON_PORT='${BEACON_PORT}' (ожидается 1..65535)." >&2
    exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
fi

cd "$BEACON_DIR"

echo "================================================================"
echo "  Обновление Beacon Control Panel в ${BEACON_DIR}"
echo "================================================================"

if ! command -v git >/dev/null 2>&1 || [ ! -d ".git" ]; then
    echo "[!] Каталог ${BEACON_DIR} не является git-репозиторием." >&2
    exit 1
fi

# 1. Проверка чистоты git working tree
DIRTY="$(git status --porcelain || true)"
if [ -n "$DIRTY" ] && [ "$FORCE_UPDATE" -ne 1 ]; then
    echo "[!] Обнаружены локальные незакоммиченные изменения:" >&2
    echo "$DIRTY" >&2
    echo "[!] Закоммитьте их или запустите обновление с флагом: bash scripts/update.sh --force" >&2
    exit 1
fi

PREV_SHA="$(git rev-parse HEAD)"

# Определяем интерпретатор Python
PY_BIN="python3"
if [ -x "${BEACON_DIR}/.venv/bin/python" ]; then
    PY_BIN="${BEACON_DIR}/.venv/bin/python"
fi

is_beacon_pid() {
    local pid="$1"
    if ! [[ "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
        return 1
    fi
    if [ -r "/proc/${pid}/cmdline" ]; then
        tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | grep -Eq '(beacon|hub)' || return 1
    fi
    return 0
}

stop_beacon_daemon() {
    local pid_file="${BEACON_DIR}/data/beacon.pid"
    if [ -f "$pid_file" ] && [ ! -L "$pid_file" ]; then
        local old_pid
        old_pid="$(tr -cd '0-9' < "$pid_file" 2>/dev/null || true)"
        if [ -n "$old_pid" ] && is_beacon_pid "$old_pid"; then
            kill -TERM "$old_pid" 2>/dev/null || true
            for _ in 1 2 3 4 5; do
                kill -0 "$old_pid" 2>/dev/null || break
                sleep 1
            done
            if is_beacon_pid "$old_pid"; then
                kill -KILL "$old_pid" 2>/dev/null || true
            fi
        fi
    else
        pkill -TERM -f "python.*-m (beacon|hub)" 2>/dev/null || true
        sleep 2
    fi
}

start_beacon_daemon() {
    mkdir -p "${BEACON_DIR}/data/logs"
    local log_out="${BEACON_DIR}/data/logs/beacon-daemon.log"
    local start_cmd_file="${BEACON_DIR}/data/start.cmd"
    if [ -f "$start_cmd_file" ] && [ ! -L "$start_cmd_file" ] && [ -s "$start_cmd_file" ]; then
        local perms
        perms="$(stat -c '%a' "$start_cmd_file" 2>/dev/null || echo '777')"
        if [ "$perms" = "600" ] || [ "$perms" = "400" ]; then
            local start_cmd
            start_cmd="$(cat "$start_cmd_file")"
            echo "[*] Запуск панели командой из data/start.cmd..."
            nohup bash -c "$start_cmd" >> "$log_out" 2>&1 < /dev/null &
            return 0
        else
            echo "[!] Пропущен data/start.cmd с небезопасными правами (${perms} != 600), используется стандартный запуск." >&2
        fi
    fi
    echo "[*] Запуск панели: ${PY_BIN} -m beacon --port ${BEACON_PORT}..."
    nohup "$PY_BIN" -m beacon --port "$BEACON_PORT" >> "$log_out" 2>&1 < /dev/null &
}

# 2. Резервная копия перед обновлением (если БД уже инициализирована)
if [ -f "${BEACON_DIR}/data/beacon.db" ] || [ -f "${BEACON_DIR}/data/hub.db" ]; then
    echo "[*] Создание резервной копии перед обновлением..."
    "$PY_BIN" -m beacon backup || true
fi

# 3. Получение последних изменений
echo "[*] Получение обновлений из origin/main..."
git fetch origin main
if [ "$FORCE_UPDATE" -eq 1 ]; then
    git reset --hard origin/main
else
    git pull --ff-only origin main
fi

rollback_and_exit() {
    echo "[!] Проверка работоспособности не пройдена — выполняется откат на ${PREV_SHA}..." >&2
    git reset --hard "$PREV_SHA" || git checkout "$PREV_SHA" || true
    if [ -x "${BEACON_DIR}/.venv/bin/pip" ]; then
        "${BEACON_DIR}/.venv/bin/pip" install -r requirements.txt --quiet || true
    fi
    "$PY_BIN" -m beacon migrate || true
    if [ -d "/run/systemd/system" ] && command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^beacon\.service"; then
        ${SUDO} systemctl restart beacon.service || true
    else
        stop_beacon_daemon
        start_beacon_daemon
    fi
    exit 1
}

# 4. Обновление зависимостей Python
echo "[*] Проверка и обновление зависимостей Python..."
if [ ! -d "${BEACON_DIR}/.venv" ]; then
    python3 -m venv "${BEACON_DIR}/.venv"
    PY_BIN="${BEACON_DIR}/.venv/bin/python"
fi
"${BEACON_DIR}/.venv/bin/pip" install --upgrade pip --quiet
"${BEACON_DIR}/.venv/bin/pip" install -r requirements.txt --quiet || rollback_and_exit

# 5. Миграция БД SQLite
"$PY_BIN" -m beacon migrate || rollback_and_exit

# 6. Перезапуск панели (systemd или non-systemd через data/beacon.pid + data/start.cmd)
USE_SYSTEMD=0
if [ -d "/run/systemd/system" ] && command -v systemctl >/dev/null 2>&1; then
    USE_SYSTEMD=1
fi

if [ "$USE_SYSTEMD" -eq 1 ]; then
    echo "[*] Перезапуск службы через systemd..."
    ${SUDO} systemctl daemon-reload || true
    if systemctl list-unit-files | grep -q "^beacon\.service"; then
        ${SUDO} systemctl restart beacon.service
    else
        echo "[*] Systemd-юнит не установлен, пробуем локальный перезапуск..."
        USE_SYSTEMD=0
    fi
fi

if [ "$USE_SYSTEMD" -eq 0 ]; then
    echo "[*] Остановка текущего процесса панели..."
    stop_beacon_daemon
    start_beacon_daemon
fi

# 7. Проверка здоровья HTTP (/api/auth/me) в течение 20 секунд
HEALTH_URL="http://127.0.0.1:${BEACON_PORT}/api/auth/me"
echo "[*] Ожидание готовности ${HEALTH_URL}..."
READY=0
for _ in $(seq 1 20); do
    HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$HEALTH_URL" || true)"
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ]; then
        READY=1
        break
    fi
    sleep 1
done

if [ "$READY" -ne 1 ]; then
    echo "[!] Панель не ответила на ${HEALTH_URL} за 20 секунд." >&2
    rollback_and_exit
fi

echo "[+] Обновление Beacon успешно завершено и подтверждено проверкой здоровья!"
