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
BEACON_PORT="${BEACON_PORT:-${ARUTA_PORT:-${HUB_PORT:-8050}}}"
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

# 2. Резервная копия перед обновлением (если БД уже инициализирована)
if [ -f "${BEACON_DIR}/data/hub.db" ]; then
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
    git checkout "$PREV_SHA" || git reset --hard "$PREV_SHA" || true
    if [ -x "${BEACON_DIR}/.venv/bin/pip" ]; then
        "${BEACON_DIR}/.venv/bin/pip" install -r requirements.txt --quiet || true
    fi
    "$PY_BIN" -m beacon migrate || true
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
    sudo systemctl daemon-reload || true
    if systemctl list-unit-files | grep -q "^beacon\.service"; then
        sudo systemctl restart beacon.service
    elif systemctl list-unit-files | grep -q "^aruta\.service"; then
        sudo systemctl restart aruta.service
    elif systemctl list-unit-files | grep -q "^hub\.service"; then
        sudo systemctl restart hub.service
    else
        echo "[*] Systemd-юнит не установлен, пробуем локальный перезапуск..."
        USE_SYSTEMD=0
    fi
fi

if [ "$USE_SYSTEMD" -eq 0 ]; then
    echo "[*] Остановка текущего процесса панели..."
    PID_FILE="${BEACON_DIR}/data/beacon.pid"
    if [ -f "$PID_FILE" ]; then
        OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
            kill -TERM "$OLD_PID" 2>/dev/null || true
            for _ in 1 2 3 4 5; do
                kill -0 "$OLD_PID" 2>/dev/null || break
                sleep 1
            done
            kill -0 "$OLD_PID" 2>/dev/null && kill -KILL "$OLD_PID" 2>/dev/null || true
        fi
    else
        pkill -TERM -f "python.*-m (beacon|aruta|hub)" 2>/dev/null || true
        sleep 2
    fi

    mkdir -p "${BEACON_DIR}/data/logs"
    LOG_OUT="${BEACON_DIR}/data/logs/beacon-daemon.log"
    START_CMD_FILE="${BEACON_DIR}/data/start.cmd"
    if [ -f "$START_CMD_FILE" ] && [ -s "$START_CMD_FILE" ]; then
        START_CMD="$(cat "$START_CMD_FILE")"
        echo "[*] Запуск панели командой из data/start.cmd..."
        nohup bash -c "$START_CMD" >> "$LOG_OUT" 2>&1 < /dev/null &
    else
        echo "[*] Запуск панели: ${PY_BIN} -m beacon --port ${BEACON_PORT}..."
        nohup "$PY_BIN" -m beacon --port "$BEACON_PORT" >> "$LOG_OUT" 2>&1 < /dev/null &
    fi
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
