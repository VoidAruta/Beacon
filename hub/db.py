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

from hub.config import (
    DB_PATH,
    DEFAULT_SETTINGS,
    EXAMPLES_DIR,
    INITIAL_PASSWORD_PATH,
    LOGS_DIR,
    PROJECTS_DIR,
    SECRETS_DIR,
    ensure_directories,
)

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

-- 7. Отозванные сессии (серверная инвалидация при logout)
CREATE TABLE IF NOT EXISTS revoked_sessions (
    sid TEXT PRIMARY KEY,
    exp INTEGER NOT NULL
);
"""


def _scrypt_hash(password: str) -> str:
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


def _is_default_admin_hash(stored_hash: str) -> bool:
    if not stored_hash or not stored_hash.startswith("scrypt$"):
        return False
    try:
        parts = stored_hash.split("$")
        if len(parts) != 3:
            return False
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
        derived = hashlib.scrypt(b"admin", salt=salt, n=16384, r=8, p=1)
        return derived == expected
    except Exception:
        return False


def _get_or_create_initial_password() -> tuple[str, bool]:
    """
    Возвращает (initial_password, newly_generated).
    Если файл data/initial_password уже существует и содержит непустой пароль (не 'admin'),
    переиспользует его; иначе генерирует криптостойкий пароль, сохраняет с chmod 0600 и возвращает.
    """
    ensure_directories()
    if INITIAL_PASSWORD_PATH.exists():
        try:
            existing = INITIAL_PASSWORD_PATH.read_text(encoding="utf-8").strip()
            if len(existing) >= 8 and existing.lower() != "admin":
                os.chmod(INITIAL_PASSWORD_PATH, 0o600)
                return existing, False
        except OSError:
            pass

    generated = secrets.token_urlsafe(12)
    try:
        INITIAL_PASSWORD_PATH.write_text(generated + "\n", encoding="utf-8")
        os.chmod(INITIAL_PASSWORD_PATH, 0o600)
    except OSError:
        pass
    return generated, True


def init_db() -> None:
    """
    Инициализирует таблицы SQLite в режиме WAL и настройки по умолчанию.
    При первом старте (если не задан HUB_ADMIN_PASSWORD) генерирует случайный пароль,
    сохраняет его в data/initial_password (0600), выводит один раз в консоль и требует смену при первом входе.
    Демо-проекты в рабочую БД автоматически НЕ засеваются (они лежат в projects/examples/).
    """
    ensure_directories()
    EXAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    custom_init_pw = (os.environ.get("HUB_ADMIN_PASSWORD") or os.environ.get("HUB_INIT_PASSWORD") or "").strip()

    with db_session() as conn:
        conn.executescript(DDL_SCRIPT)

        for key, default_val in DEFAULT_SETTINGS.items():
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            if row is None:
                conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (key, default_val))

        pw_row = conn.execute("SELECT value FROM settings WHERE key = 'password_hash'").fetchone()
        curr_hash = str(pw_row["value"]).strip() if pw_row else ""

        # Если пароль ещё не задан или остался небезопасный дефолт 'admin' из прошлых версий —
        # устанавливаем пароль из HUB_ADMIN_PASSWORD либо генерируем случайный в data/initial_password (0600)
        if not curr_hash or _is_default_admin_hash(curr_hash):
            if custom_init_pw and custom_init_pw.lower() != "admin":
                new_hash = _scrypt_hash(custom_init_pw)
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (new_hash,),
                )
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('must_change_password', '0') ON CONFLICT(key) DO UPDATE SET value = '0'"
                )
                if INITIAL_PASSWORD_PATH.exists():
                    try:
                        INITIAL_PASSWORD_PATH.unlink()
                    except OSError:
                        pass
            else:
                init_pw, is_new = _get_or_create_initial_password()
                new_hash = _scrypt_hash(init_pw)
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (new_hash,),
                )
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('must_change_password', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
                )
                if is_new:
                    print(
                        f"\n[Hub Security] Сгенерирован начальный пароль администратора: {init_pw}\n"
                        f"[Hub Security] Пароль сохранён в {INITIAL_PASSWORD_PATH} (права 0600). Смените его при первом входе!\n",
                        flush=True,
                    )


def checkpoint_wal(truncate_threshold_mb: float = 4.0) -> dict[str, Any]:
    """
    Контролирует размер файла data/hub.db-wal и выполняет PRAGMA wal_checkpoint(TRUNCATE)
    при превышении порога (по умолчанию 4 МБ), чтобы постоянный 2-секундный опрос UI
    не мешал авто-чекпоинту SQLite и не раздувал UFS-память смартфона.
    """
    wal_path = DB_PATH.with_name(f"{DB_PATH.name}-wal")
    size_before = wal_path.stat().st_size if wal_path.exists() else 0
    mode = "TRUNCATE" if size_before >= int(truncate_threshold_mb * 1024 * 1024) else "PASSIVE"
    busy = 0
    log_frames = 0
    checkpointed_frames = 0
    try:
        with db_session() as conn:
            row = conn.execute(f"PRAGMA wal_checkpoint({mode});").fetchone()
            if row:
                busy, log_frames, checkpointed_frames = int(row[0]), int(row[1]), int(row[2])
    except Exception:
        pass
    size_after = wal_path.stat().st_size if wal_path.exists() else 0
    return {
        "mode": mode,
        "wal_size_before_kb": round(size_before / 1024.0, 1),
        "wal_size_after_kb": round(size_after / 1024.0, 1),
        "busy": busy,
        "log_frames": log_frames,
        "checkpointed_frames": checkpointed_frames,
    }

