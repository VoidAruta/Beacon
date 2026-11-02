"""
Инициализация SQLite в режиме WAL, DDL-схема таблиц и хелперы запросов.
"""

import hashlib
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from hub.config import DB_PATH, DEFAULT_SETTINGS, LOGS_DIR, PROJECTS_DIR, SECRETS_DIR, ensure_directories

DDL_SCRIPT = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 1. Системные настройки (ключ-значение)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 2. Проекты (Jobs и Services)
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('job', 'service')),
    runtime TEXT NOT NULL CHECK(runtime IN ('python', 'node', 'bash', 'custom')),
    cmd TEXT NOT NULL,
    workdir TEXT NOT NULL,
    env_json TEXT NOT NULL DEFAULT '{}',
    secrets_json TEXT NOT NULL DEFAULT '[]',
    use_proxy INTEGER NOT NULL DEFAULT 0,
    ram_limit_mb INTEGER NOT NULL DEFAULT 0,

    -- Поля для type = 'job'
    schedule_type TEXT NOT NULL DEFAULT 'manual' CHECK(schedule_type IN ('manual', 'cron', 'interval')),
    schedule_expr TEXT NOT NULL DEFAULT '',
    timeout_sec INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 0,
    retry_delay_sec INTEGER NOT NULL DEFAULT 30,
    webhook_token TEXT UNIQUE,

    -- Поля для type = 'service'
    autostart INTEGER NOT NULL DEFAULT 0,
    restart_policy TEXT NOT NULL DEFAULT 'on-failure' CHECK(restart_policy IN ('no', 'on-failure', 'always')),
    backoff_min_sec INTEGER NOT NULL DEFAULT 2,
    backoff_max_sec INTEGER NOT NULL DEFAULT 300,
    desired_state TEXT NOT NULL DEFAULT 'stopped' CHECK(desired_state IN ('running', 'stopped')),

    -- Уведомления проекта
    notify_on_error INTEGER NOT NULL DEFAULT 1,
    notify_on_success INTEGER NOT NULL DEFAULT 0,
    notify_on_crash INTEGER NOT NULL DEFAULT 1,

    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 3. Запуски (Runs) — история и текущие процессы
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('running', 'waiting_input', 'success', 'failed', 'timeout', 'stopped', 'killed_oom')),
    trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'schedule', 'webhook', 'autostart', 'restart', 'retry')),
    pid INTEGER,
    pgid INTEGER,
    proc_create_time REAL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    exit_code INTEGER,
    run_token TEXT UNIQUE NOT NULL,
    log_path TEXT NOT NULL,
    error_summary TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_project_started ON runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- 4. Секреты
CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('text', 'file', 'cookie_json')),
    file_path TEXT NOT NULL,
    is_expired INTEGER NOT NULL DEFAULT 0,
    expired_note TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
);

-- 5. Интерактивные запросы hub.ask()
CREATE TABLE IF NOT EXISTS pending_asks (
    id TEXT PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'answered', 'timeout', 'cancelled')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    tg_message_id INTEGER
);

-- 6. Журнал аудита безопасности
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    ip TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL
);
"""


def _default_scrypt_hash(password: str = "admin") -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    return f"scrypt${salt.hex()}${derived.hex()}"


def get_connection() -> sqlite3.Connection:
    ensure_directories()
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def query_all(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with db_session() as conn:
        cur = conn.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]


def query_one(sql: str, params: tuple[Any, ...] = ()) -> Optional[dict[str, Any]]:
    with db_session() as conn:
        cur = conn.execute(sql, params)
        row = cur.fetchone()
        return dict(row) if row else None


def execute_sql(sql: str, params: tuple[Any, ...] = ()) -> int:
    with db_session() as conn:
        cur = conn.execute(sql, params)
        return int(cur.lastrowid or 0)


def get_all_settings() -> dict[str, str]:
    rows = query_all("SELECT key, value FROM settings")
    res = dict(DEFAULT_SETTINGS)
    for r in rows:
        res[r["key"]] = r["value"]
    return res


def get_setting(key: str, default: str = "") -> str:
    row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    if row is not None:
        return str(row["value"])
    return DEFAULT_SETTINGS.get(key, default)


def set_setting(key: str, value: str) -> None:
    with db_session() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )


def log_audit(ip: str, action: str, details: str) -> None:
    now = int(time.time())
    execute_sql(
        "INSERT INTO audit_log (timestamp, ip, action, details) VALUES (?, ?, ?, ?)",
        (now, ip or "127.0.0.1", action, details),
    )


def _ensure_secret_row_and_file(
    conn: sqlite3.Connection,
    name: str,
    sec_type: str,
    default_content: str,
    now: int,
) -> None:
    file_path = SECRETS_DIR / name
    if not file_path.exists():
        file_path.write_text(default_content, encoding="utf-8")
        try:
            os.chmod(file_path, 0o600)
        except OSError:
            pass
    row = conn.execute("SELECT name FROM secrets WHERE name = ?", (name,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO secrets (name, type, file_path, is_expired, expired_note, updated_at) VALUES (?, ?, ?, 0, '', ?)",
            (name, sec_type, str(file_path), now),
        )


def _seed_initial_data(conn: sqlite3.Connection) -> None:
    """Создаёт стартовые секреты, индивидуальные куки проектов и 5 тестовых проектов."""
    now = int(time.time())

    sample_cookies_json = json.dumps(
        [
            {
                "domain": ".example.com",
                "name": "session_id",
                "value": "hub_cookie_session_98f12a",
                "path": "/",
                "httpOnly": True,
                "secure": True,
            },
            {
                "domain": ".example.com",
                "name": "csrf_token",
                "value": "tk_882190_valid",
                "path": "/",
                "httpOnly": False,
                "secure": True,
            },
        ],
        indent=2,
        ensure_ascii=False,
    )

    # 1. Стартовые секреты и индивидуальные куки для тестовых проектов (0600 в /opt/hub/data/secrets/)
    _ensure_secret_row_and_file(conn, "my_cookies", "cookie_json", sample_cookies_json, now)
    _ensure_secret_row_and_file(conn, "sms-auth-bot_cookies", "cookie_json", sample_cookies_json, now)
    _ensure_secret_row_and_file(conn, "cookie-checker-job_cookies", "cookie_json", sample_cookies_json, now)
    _ensure_secret_row_and_file(conn, "api_token", "text", "sk_live_hub_secret_994812", now)

    recreated_any = False

    # Проект 1: Постоянная программа / Фоновый демон (Service)
    p1_dir = PROJECTS_DIR / "heartbeat-daemon"
    p1_dir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / "heartbeat-daemon").mkdir(parents=True, exist_ok=True)
    if not (p1_dir / "main.py").exists():
        recreated_any = True
        (p1_dir / "main.py").write_text(
            """import os
import time
import hub

print(f"[heartbeat-daemon] Постоянная программа запущена. PID={os.getpid()}, PGID={os.getpgid(0)}", flush=True)
tick = 0
while True:
    tick += 1
    print(f"[heartbeat] tick={tick} timestamp={time.time():.2f} status=nominal", flush=True)
    time.sleep(1.5)
""",
            encoding="utf-8",
        )
    if not (p1_dir / "requirements.txt").exists():
        (p1_dir / "requirements.txt").write_text("# Зависимости проекта heartbeat-daemon\n", encoding="utf-8")

    p1_env = json.dumps(
        {
            "PROJECT_DESCRIPTION": "Постоянная программа 24/7 (Service): работает непрерывно в фоне, автоматически перезапускается при сбое и выживает при перезапуске самой панели Hub.",
            "IS_TEST_PROJECT": "1",
            "WORKER_ENV": "chroot-arm64",
        },
        ensure_ascii=False,
    )
    if not conn.execute("SELECT id FROM projects WHERE name = 'heartbeat-daemon'").fetchone():
        conn.execute(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES (?, 'service', 'python', 'python3 main.py', ?, ?, '["api_token"]',
                0, 128, 'manual', '', 0, 0, 30, ?, 1, 'always', 2, 60, 'running', 1, 0, 1, ?, ?)""",
            ("heartbeat-daemon", str(p1_dir), p1_env, secrets.token_hex(16), now, now),
        )
    else:
        conn.execute(
            "UPDATE projects SET env_json = ? WHERE name = 'heartbeat-daemon' AND (env_json = '{}' OR env_json NOT LIKE '%PROJECT_DESCRIPTION%')",
            (p1_env,),
        )

    # Проект 2: Тест интерактивного запроса СМС / 2FA через hub.ask() + индивидуальные куки
    p2_dir = PROJECTS_DIR / "sms-auth-bot"
    p2_dir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / "sms-auth-bot").mkdir(parents=True, exist_ok=True)
    if not (p2_dir / "main.py").exists():
        recreated_any = True
        (p2_dir / "main.py").write_text(
            """import time
import hub

print("[sms-auth-bot] Чтение индивидуальных куки этого скрипта ('sms-auth-bot_cookies')...", flush=True)
cookies = hub.secret("sms-auth-bot_cookies")
print(f"[sms-auth-bot] Получено куки ({type(cookies).__name__}): {len(cookies)} шт.", flush=True)

token = hub.secret("api_token")
print(f"[sms-auth-bot] Проверка маскировки секрета в логе: {token}", flush=True)

print("[sms-auth-bot] Запрашиваем интерактивный код подтверждения через hub.ask()...", flush=True)
code = hub.ask("Код из СМС?", timeout=300)
print(f"[sms-auth-bot] УСПЕХ! Получен код подтверждения: {code}", flush=True)
hub.notify(f"Авторизация sms-auth-bot завершена с кодом {code}", level="info")
""",
            encoding="utf-8",
        )
    if not (p2_dir / "requirements.txt").exists():
        (p2_dir / "requirements.txt").write_text("# Зависимости sms-auth-bot\n", encoding="utf-8")

    p2_env = json.dumps(
        {
            "PROJECT_DESCRIPTION": "Тестовый скрипт с индивидуальными куки и интерактивным вводом (Job): запрашивает у вас СМС-код через жёлтый баннер вверху экрана (hub.ask).",
            "IS_TEST_PROJECT": "1",
        },
        ensure_ascii=False,
    )
    if not conn.execute("SELECT id FROM projects WHERE name = 'sms-auth-bot'").fetchone():
        conn.execute(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES (?, 'job', 'python', 'python3 main.py', ?, ?, '["sms-auth-bot_cookies","my_cookies","api_token"]',
                1, 128, 'manual', '', 300, 1, 15, ?, 0, 'no', 2, 60, 'stopped', 1, 1, 1, ?, ?)""",
            ("sms-auth-bot", str(p2_dir), p2_env, secrets.token_hex(16), now, now),
        )
    else:
        conn.execute(
            "UPDATE projects SET env_json = ?, secrets_json = ? WHERE name = 'sms-auth-bot'",
            (p2_env, '["sms-auth-bot_cookies","my_cookies","api_token"]'),
        )

    # Проект 3: Периодический Bash-скрипт резервного копирования по расписанию
    p3_dir = PROJECTS_DIR / "backup-sync-job"
    p3_dir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / "backup-sync-job").mkdir(parents=True, exist_ok=True)
    if not (p3_dir / "main.sh").exists():
        recreated_any = True
        (p3_dir / "main.sh").write_text(
            """#!/usr/bin/env bash
set -e
echo "[backup-sync-job] Старт проверки архивов по расписанию (PID=$$)..."
sleep 1
echo "[backup-sync-job] Проверка контрольных сумм завершена успешно."
""",
            encoding="utf-8",
        )

    p3_env = json.dumps(
        {
            "PROJECT_DESCRIPTION": "Скрипт по расписанию (Job): запускается автоматически каждые 15 минут (*/15 * * * *), проверяет файлы и завершает работу.",
            "IS_TEST_PROJECT": "1",
            "BACKUP_MODE": "incremental",
        },
        ensure_ascii=False,
    )
    if not conn.execute("SELECT id FROM projects WHERE name = 'backup-sync-job'").fetchone():
        conn.execute(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES (?, 'job', 'bash', 'bash main.sh', ?, ?, '[]',
                0, 64, 'cron', '*/15 * * * *', 60, 2, 30, ?, 0, 'no', 2, 60, 'stopped', 1, 0, 1, ?, ?)""",
            ("backup-sync-job", str(p3_dir), p3_env, secrets.token_hex(16), now, now),
        )
    else:
        conn.execute(
            "UPDATE projects SET env_json = ? WHERE name = 'backup-sync-job'",
            (p3_env,),
        )

    # Проект 4: Тест индивидуальных куки и сигнала протухания сессии (cookie-checker-job)
    p4_dir = PROJECTS_DIR / "cookie-checker-job"
    p4_dir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / "cookie-checker-job").mkdir(parents=True, exist_ok=True)
    if not (p4_dir / "main.py").exists():
        recreated_any = True
        (p4_dir / "main.py").write_text(
            """import time
import hub

SECRET_NAME = "cookie-checker-job_cookies"
print(f"[cookie-checker-job] Проверка индивидуальных куки '{SECRET_NAME}'...", flush=True)
cookies = hub.secret(SECRET_NAME)
print(f"[cookie-checker-job] Прочитано {len(cookies)} куки для домена {cookies[0].get('domain') if cookies else '?'}.", flush=True)
time.sleep(0.5)
print("[cookie-checker-job] Имитация ответа 401 Unauthorized от сайта -> вызываем hub.cookies_expired()!", flush=True)
hub.cookies_expired(SECRET_NAME, note="Сайт вернул 401: обновите куки для cookie-checker-job")
print("[cookie-checker-job] Сигнал протухания куки отправлен в панель и Telegram.", flush=True)
""",
            encoding="utf-8",
        )
    if not (p4_dir / "requirements.txt").exists():
        (p4_dir / "requirements.txt").write_text("# Зависимости cookie-checker-job\n", encoding="utf-8")

    p4_env = json.dumps(
        {
            "PROJECT_DESCRIPTION": "Тест индивидуальных куки скрипта (Job): проверяет куки 'cookie-checker-job_cookies' каждые 30 минут и при устаревании зажигает красный баннер замены куки.",
            "IS_TEST_PROJECT": "1",
        },
        ensure_ascii=False,
    )
    if not conn.execute("SELECT id FROM projects WHERE name = 'cookie-checker-job'").fetchone():
        conn.execute(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES (?, 'job', 'python', 'python3 main.py', ?, ?, '["cookie-checker-job_cookies"]',
                1, 128, 'interval', '1800', 120, 0, 30, ?, 0, 'no', 2, 60, 'stopped', 1, 0, 1, ?, ?)""",
            ("cookie-checker-job", str(p4_dir), p4_env, secrets.token_hex(16), now, now),
        )

    # Проект 5: Тест проекта со своими собственными данными Telegram (tg-user-notifier)
    p5_dir = PROJECTS_DIR / "tg-user-notifier"
    p5_dir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / "tg-user-notifier").mkdir(parents=True, exist_ok=True)
    if not (p5_dir / "bot.py").exists():
        recreated_any = True
        (p5_dir / "bot.py").write_text(
            """import os
import time
import hub

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")
TG_API_ID = os.environ.get("TG_API_ID", "")
PROXY = os.environ.get("HTTP_PROXY", "прямое подключение")

print(f"[tg-user-notifier] Запуск собственного Telegram-бота проекта через прокси: {PROXY}", flush=True)
print(f"[tg-user-notifier] Индивидуальный BOT_TOKEN проекта: {BOT_TOKEN[:10]}... | TG_CHAT_ID={TG_CHAT_ID} | API_ID={TG_API_ID}", flush=True)
time.sleep(1.0)
print("[tg-user-notifier] Проверка конфигурации Telegram проекта завершена успешно.", flush=True)
""",
            encoding="utf-8",
        )
    if not (p5_dir / "requirements.txt").exists():
        (p5_dir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    p5_env = json.dumps(
        {
            "PROJECT_DESCRIPTION": "Тест индивидуального Telegram-бота проекта: использует собственные BOT_TOKEN, TG_CHAT_ID и TG_API_ID, заданные внутри этого проекта (отдельно от системного бота панели).",
            "IS_TEST_PROJECT": "1",
            "BOT_TOKEN": "7100223344:AAH_demo_project_bot_token",
            "TG_CHAT_ID": "192837465",
            "TG_API_ID": "2040",
            "TG_API_HASH": "b18441a1ff607e10a989891a5462e627",
        },
        ensure_ascii=False,
    )
    if not conn.execute("SELECT id FROM projects WHERE name = 'tg-user-notifier'").fetchone():
        conn.execute(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES (?, 'job', 'python', 'python3 bot.py', ?, ?, '[]',
                1, 128, 'manual', '', 60, 0, 30, ?, 0, 'no', 2, 60, 'stopped', 1, 1, 1, ?, ?)""",
            ("tg-user-notifier", str(p5_dir), p5_env, secrets.token_hex(16), now, now),
        )

    if recreated_any:
        conn.execute("DELETE FROM runs WHERE error_summary LIKE '%No such file or directory%'")


def init_db() -> None:
    """Инициализирует таблицы SQLite в режиме WAL и заполняет настройки по умолчанию."""
    ensure_directories()
    with db_session() as conn:
        conn.executescript(DDL_SCRIPT)
        for key, default_val in DEFAULT_SETTINGS.items():
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            if row is None:
                val = default_val
                if key == "password_hash" and not val:
                    admin_pw = os.environ.get("HUB_ADMIN_PASSWORD", "admin")
                    val = _default_scrypt_hash(admin_pw)
                conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (key, val))
        _seed_initial_data(conn)
