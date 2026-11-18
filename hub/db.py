"""
Инициализация SQLite в режиме WAL, DDL-схема таблиц, автоматические миграции и хелперы запросов.
Никакие пароли никогда не записываются на диск открытым текстом.
"""

import hashlib
import os
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from hub.config import (
    DB_PATH,
    DEFAULT_SETTINGS,
    EXAMPLES_DIR,
    SESSION_SECRET_PATH,
    ensure_directories,
    get_env_var,
)
from hub.log import get_logger

logger = get_logger("db")

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

-- 2. Проекты (Services, Web/API Backends и Scheduled Jobs)
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('job', 'service', 'web')),
    runtime TEXT NOT NULL CHECK(runtime IN ('python', 'node', 'bash', 'custom')),
    cmd TEXT NOT NULL,
    workdir TEXT NOT NULL,
    env_json TEXT NOT NULL DEFAULT '{}',
    secrets_json TEXT NOT NULL DEFAULT '[]',
    use_proxy INTEGER NOT NULL DEFAULT 0,
    ram_limit_mb INTEGER NOT NULL DEFAULT 0,

    -- Сетевой порт и Healthcheck (для Web/API и сервисов)
    port INTEGER NOT NULL DEFAULT 0,
    healthcheck_url TEXT NOT NULL DEFAULT '',
    healthcheck_interval_sec INTEGER NOT NULL DEFAULT 30,
    health_status TEXT NOT NULL DEFAULT 'unknown',

    -- Поля для type = 'job'
    schedule_type TEXT NOT NULL DEFAULT 'manual' CHECK(schedule_type IN ('manual', 'cron', 'interval', 'daily')),
    schedule_expr TEXT NOT NULL DEFAULT '',
    next_run_at INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER NOT NULL DEFAULT 0,
    timeout_sec INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 0,
    retry_delay_sec INTEGER NOT NULL DEFAULT 30,
    webhook_token TEXT UNIQUE,
    webhook_hmac_secret TEXT NOT NULL DEFAULT '',
    ping_token TEXT NOT NULL DEFAULT '',

    -- Поля для type = 'service' / 'web' и защита от crash-loop (Фаза D)
    autostart INTEGER NOT NULL DEFAULT 0,
    restart_policy TEXT NOT NULL DEFAULT 'on-failure' CHECK(restart_policy IN ('no', 'on-failure', 'always')),
    backoff_min_sec INTEGER NOT NULL DEFAULT 2,
    backoff_max_sec INTEGER NOT NULL DEFAULT 300,
    min_uptime_sec INTEGER NOT NULL DEFAULT 10,
    max_restarts INTEGER NOT NULL DEFAULT 10,
    restart_delay_sec INTEGER NOT NULL DEFAULT 2,
    cron_restart TEXT NOT NULL DEFAULT '',
    crash_loop_count INTEGER NOT NULL DEFAULT 0,
    desired_state TEXT NOT NULL DEFAULT 'stopped' CHECK(desired_state IN ('running', 'stopped')),

    -- Dead Man's Switch / Heartbeat (Фаза D)
    heartbeat_interval_sec INTEGER NOT NULL DEFAULT 0,
    heartbeat_grace_sec INTEGER NOT NULL DEFAULT 60,
    last_ping_at INTEGER NOT NULL DEFAULT 0,

    -- Цепочки проектов и авто-форма параметров запуска (Фаза D)
    on_success_project_id INTEGER DEFAULT NULL,
    params_schema_json TEXT NOT NULL DEFAULT '[]',

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
    status TEXT NOT NULL CHECK(status IN ('running', 'waiting_input', 'success', 'failed', 'timeout', 'stopped', 'killed_oom', 'crash_loop')),
    trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'schedule', 'webhook', 'autostart', 'restart', 'retry', 'healthcheck', 'chain', 'cron_restart', 'ai')),
    pid INTEGER,
    pgid INTEGER,
    proc_create_time REAL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    exit_code INTEGER,
    run_token TEXT UNIQUE NOT NULL,
    log_path TEXT NOT NULL,
    error_summary TEXT DEFAULT '',
    is_auxiliary INTEGER NOT NULL DEFAULT 0
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

-- 5. Интерактивные запросы beacon.ask()
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
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    details TEXT NOT NULL
);

-- 7. Отозванные сессии (серверная инвалидация при logout)
CREATE TABLE IF NOT EXISTS revoked_sessions (
    sid TEXT PRIMARY KEY,
    exp INTEGER NOT NULL
);

-- 8. Персистентное Key-Value хранилище состояния проектов (beacon.state)
CREATE TABLE IF NOT EXISTS project_kv (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, key)
);

-- 9. Токены ИИ-доступа (MCP и REST /api/v1/) — хранится ТОЛЬКО SHA-256 хеш
CREATE TABLE IF NOT EXISTS ai_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    token_prefix TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '["read"]',
    allowed_ips TEXT NOT NULL DEFAULT '',
    allowed_projects TEXT NOT NULL DEFAULT '*',
    auto_approve_projects TEXT NOT NULL DEFAULT '',
    rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
    expires_at INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- 10. Очередь подтверждения опасных действий ИИ (Approval Queue)
CREATE TABLE IF NOT EXISTS ai_approvals (
    id TEXT PRIMARY KEY,
    token_id INTEGER NOT NULL,
    token_name TEXT NOT NULL,
    action TEXT NOT NULL,
    project_id INTEGER,
    project_name TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    diff_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0,
    decided_at INTEGER,
    decided_by TEXT DEFAULT ''
);

-- 11. Журнал действий ИИ-агентов (AI Audit Log)
CREATE TABLE IF NOT EXISTS ai_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    token_id INTEGER,
    token_name TEXT NOT NULL,
    ip TEXT NOT NULL,
    tool_or_endpoint TEXT NOT NULL,
    args_summary TEXT NOT NULL,
    status TEXT NOT NULL,
    result_summary TEXT NOT NULL
);

-- 12. Пользователи и RBAC-роли (viewer, operator, admin)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('viewer', 'operator', 'admin')),
    created_at INTEGER NOT NULL
);
"""


def _scrypt_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    return f"scrypt${salt.hex()}${derived.hex()}"


_THREAD_LOCAL = threading.local()
_DB_GENERATION: int = 0
_SETTINGS_CACHE: Optional[tuple[str, float, dict[str, str]]] = None
_SETTINGS_CACHE_TTL_SEC = 2.0
_SETTINGS_CACHE_LOCK = threading.Lock()


def bump_db_generation() -> None:
    """Инкрементирует поколение БД, заставляя все рабочие потоки переоткрыть thread-local соединения."""
    global _DB_GENERATION
    _DB_GENERATION += 1


def invalidate_settings_cache() -> None:
    global _SETTINGS_CACHE
    with _SETTINGS_CACHE_LOCK:
        _SETTINGS_CACHE = None


def close_thread_connection() -> None:
    conn = getattr(_THREAD_LOCAL, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    _THREAD_LOCAL.conn = None
    _THREAD_LOCAL.conn_db_path = None
    _THREAD_LOCAL.conn_generation = -1
    _THREAD_LOCAL.tx_depth = 0


def get_connection() -> sqlite3.Connection:
    conn = getattr(_THREAD_LOCAL, "conn", None)
    conn_path = getattr(_THREAD_LOCAL, "conn_db_path", None)
    conn_gen = getattr(_THREAD_LOCAL, "conn_generation", -1)
    target_path = str(DB_PATH)
    if conn is not None and conn_path == target_path and conn_gen == _DB_GENERATION:
        return conn
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    Path(target_path).parent.mkdir(parents=True, exist_ok=True)
    new_conn = sqlite3.connect(target_path, timeout=10.0, check_same_thread=False)
    new_conn.row_factory = sqlite3.Row
    new_conn.execute("PRAGMA synchronous = NORMAL;")
    new_conn.execute("PRAGMA foreign_keys = ON;")
    new_conn.execute("PRAGMA busy_timeout = 5000;")
    _THREAD_LOCAL.conn = new_conn
    _THREAD_LOCAL.conn_db_path = target_path
    _THREAD_LOCAL.conn_generation = _DB_GENERATION
    _THREAD_LOCAL.tx_depth = 0
    return new_conn


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    depth = int(getattr(_THREAD_LOCAL, "tx_depth", 0) or 0)
    _THREAD_LOCAL.tx_depth = depth + 1
    try:
        yield conn
        if _THREAD_LOCAL.tx_depth == 1:
            conn.commit()
    except Exception:
        if _THREAD_LOCAL.tx_depth == 1:
            try:
                conn.rollback()
            except Exception:
                pass
        raise
    finally:
        _THREAD_LOCAL.tx_depth = max(0, int(getattr(_THREAD_LOCAL, "tx_depth", 1)) - 1)


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


def execute_rowcount(sql: str, params: tuple[Any, ...] = ()) -> int:
    with db_session() as conn:
        cur = conn.execute(sql, params)
        return int(cur.rowcount or 0)


def get_all_settings() -> dict[str, str]:
    global _SETTINGS_CACHE
    target_path = str(DB_PATH)
    now_m = time.monotonic()
    with _SETTINGS_CACHE_LOCK:
        if _SETTINGS_CACHE is not None:
            cached_path, ts, cached_dict = _SETTINGS_CACHE
            if cached_path == target_path and (now_m - ts) < _SETTINGS_CACHE_TTL_SEC:
                return dict(cached_dict)

    rows = query_all("SELECT key, value FROM settings")
    res = dict(DEFAULT_SETTINGS)
    for r in rows:
        res[r["key"]] = r["value"]
    with _SETTINGS_CACHE_LOCK:
        _SETTINGS_CACHE = (target_path, time.monotonic(), dict(res))
    return res


def get_setting(key: str, default: str = "") -> str:
    settings = get_all_settings()
    if key in settings:
        return str(settings[key])
    return DEFAULT_SETTINGS.get(key, default)


def set_setting(key: str, value: str) -> None:
    with db_session() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
    invalidate_settings_cache()


def log_audit(ip: str, action: str, details: str, actor: str = "") -> None:
    now = int(time.time())
    execute_sql(
        "INSERT INTO audit_log (timestamp, ip, actor, action, details) VALUES (?, ?, ?, ?, ?)",
        (now, ip or "127.0.0.1", (actor or "").strip(), action, details),
    )


def _run_schema_migrations(conn: sqlite3.Connection) -> None:
    """
    Идемпотентная миграция существующей БД до актуальной схемы:
    - Добавляет недостающие колонки в projects
    - Расширяет CHECK для таблиц projects и runs при обновлении со старых версий
    """
    cur = conn.execute("PRAGMA table_info(projects)")
    existing_cols = {row["name"] for row in cur.fetchall()}

    alter_statements = [
        ("port", "ALTER TABLE projects ADD COLUMN port INTEGER NOT NULL DEFAULT 0"),
        ("healthcheck_url", "ALTER TABLE projects ADD COLUMN healthcheck_url TEXT NOT NULL DEFAULT ''"),
        ("healthcheck_interval_sec", "ALTER TABLE projects ADD COLUMN healthcheck_interval_sec INTEGER NOT NULL DEFAULT 30"),
        ("health_status", "ALTER TABLE projects ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'"),
        ("min_uptime_sec", "ALTER TABLE projects ADD COLUMN min_uptime_sec INTEGER NOT NULL DEFAULT 10"),
        ("max_restarts", "ALTER TABLE projects ADD COLUMN max_restarts INTEGER NOT NULL DEFAULT 10"),
        ("restart_delay_sec", "ALTER TABLE projects ADD COLUMN restart_delay_sec INTEGER NOT NULL DEFAULT 2"),
        ("cron_restart", "ALTER TABLE projects ADD COLUMN cron_restart TEXT NOT NULL DEFAULT ''"),
        ("crash_loop_count", "ALTER TABLE projects ADD COLUMN crash_loop_count INTEGER NOT NULL DEFAULT 0"),
        ("heartbeat_interval_sec", "ALTER TABLE projects ADD COLUMN heartbeat_interval_sec INTEGER NOT NULL DEFAULT 0"),
        ("heartbeat_grace_sec", "ALTER TABLE projects ADD COLUMN heartbeat_grace_sec INTEGER NOT NULL DEFAULT 60"),
        ("last_ping_at", "ALTER TABLE projects ADD COLUMN last_ping_at INTEGER NOT NULL DEFAULT 0"),
        ("on_success_project_id", "ALTER TABLE projects ADD COLUMN on_success_project_id INTEGER DEFAULT NULL"),
        ("params_schema_json", "ALTER TABLE projects ADD COLUMN params_schema_json TEXT NOT NULL DEFAULT '[]'"),
        ("ping_token", "ALTER TABLE projects ADD COLUMN ping_token TEXT NOT NULL DEFAULT ''"),
        ("next_run_at", "ALTER TABLE projects ADD COLUMN next_run_at INTEGER NOT NULL DEFAULT 0"),
        ("last_run_at", "ALTER TABLE projects ADD COLUMN last_run_at INTEGER NOT NULL DEFAULT 0"),
        ("webhook_hmac_secret", "ALTER TABLE projects ADD COLUMN webhook_hmac_secret TEXT NOT NULL DEFAULT ''"),
    ]
    for col_name, stmt in alter_statements:
        if col_name not in existing_cols:
            conn.execute(stmt)

    # Расширяем CHECK для projects.schedule_type (добавляем 'daily'), если таблица создана старой версией (P2-06)
    proj_ddl_row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").fetchone()
    if proj_ddl_row and "'daily'" not in str(proj_ddl_row["sql"]):
        conn.execute("PRAGMA foreign_keys = OFF;")
        conn.execute(
            """CREATE TABLE projects_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('job', 'service', 'web')),
                runtime TEXT NOT NULL CHECK(runtime IN ('python', 'node', 'bash', 'custom')),
                cmd TEXT NOT NULL,
                workdir TEXT NOT NULL,
                env_json TEXT NOT NULL DEFAULT '{}',
                secrets_json TEXT NOT NULL DEFAULT '[]',
                use_proxy INTEGER NOT NULL DEFAULT 0,
                ram_limit_mb INTEGER NOT NULL DEFAULT 0,
                port INTEGER NOT NULL DEFAULT 0,
                healthcheck_url TEXT NOT NULL DEFAULT '',
                healthcheck_interval_sec INTEGER NOT NULL DEFAULT 30,
                health_status TEXT NOT NULL DEFAULT 'unknown',
                schedule_type TEXT NOT NULL DEFAULT 'manual' CHECK(schedule_type IN ('manual', 'cron', 'interval', 'daily')),
                schedule_expr TEXT NOT NULL DEFAULT '',
                next_run_at INTEGER NOT NULL DEFAULT 0,
                last_run_at INTEGER NOT NULL DEFAULT 0,
                timeout_sec INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 0,
                retry_delay_sec INTEGER NOT NULL DEFAULT 30,
                webhook_token TEXT UNIQUE,
                webhook_hmac_secret TEXT NOT NULL DEFAULT '',
                ping_token TEXT NOT NULL DEFAULT '',
                autostart INTEGER NOT NULL DEFAULT 0,
                restart_policy TEXT NOT NULL DEFAULT 'on-failure' CHECK(restart_policy IN ('no', 'on-failure', 'always')),
                backoff_min_sec INTEGER NOT NULL DEFAULT 2,
                backoff_max_sec INTEGER NOT NULL DEFAULT 300,
                min_uptime_sec INTEGER NOT NULL DEFAULT 10,
                max_restarts INTEGER NOT NULL DEFAULT 10,
                restart_delay_sec INTEGER NOT NULL DEFAULT 2,
                cron_restart TEXT NOT NULL DEFAULT '',
                crash_loop_count INTEGER NOT NULL DEFAULT 0,
                desired_state TEXT NOT NULL DEFAULT 'stopped' CHECK(desired_state IN ('running', 'stopped')),
                heartbeat_interval_sec INTEGER NOT NULL DEFAULT 0,
                heartbeat_grace_sec INTEGER NOT NULL DEFAULT 60,
                last_ping_at INTEGER NOT NULL DEFAULT 0,
                on_success_project_id INTEGER DEFAULT NULL,
                params_schema_json TEXT NOT NULL DEFAULT '[]',
                notify_on_error INTEGER NOT NULL DEFAULT 1,
                notify_on_success INTEGER NOT NULL DEFAULT 0,
                notify_on_crash INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )"""
        )
        copy_cols = (
            "id, name, type, runtime, cmd, workdir, env_json, secrets_json, use_proxy, ram_limit_mb, "
            "port, healthcheck_url, healthcheck_interval_sec, health_status, "
            "schedule_type, schedule_expr, next_run_at, last_run_at, "
            "timeout_sec, max_retries, retry_delay_sec, webhook_token, webhook_hmac_secret, ping_token, "
            "autostart, restart_policy, backoff_min_sec, backoff_max_sec, "
            "min_uptime_sec, max_restarts, restart_delay_sec, cron_restart, crash_loop_count, desired_state, "
            "heartbeat_interval_sec, heartbeat_grace_sec, last_ping_at, on_success_project_id, params_schema_json, "
            "notify_on_error, notify_on_success, notify_on_crash, created_at, updated_at"
        )
        conn.execute(f"INSERT INTO projects_new ({copy_cols}) SELECT {copy_cols} FROM projects")
        conn.execute("DROP TABLE projects;")
        conn.execute("ALTER TABLE projects_new RENAME TO projects;")
        conn.execute("PRAGMA foreign_keys = ON;")

    # Бэкфилл ping_token для существующих проектов и уникальный индекс (P0-2)
    rows_without_ping = conn.execute("SELECT id FROM projects WHERE ping_token IS NULL OR ping_token = ''").fetchall()
    for pr in rows_without_ping:
        conn.execute("UPDATE projects SET ping_token = ? WHERE id = ?", (secrets.token_hex(16), int(pr["id"])))
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_ping_token ON projects(ping_token) WHERE ping_token != ''")

    # Проверяем, поддерживает ли CHECK таблицы runs статус 'crash_loop' и триггеры 'chain', 'ai'
    runs_ddl_row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").fetchone()
    if runs_ddl_row and ("'crash_loop'" not in str(runs_ddl_row["sql"]) or "'ai'" not in str(runs_ddl_row["sql"])):
        conn.execute("PRAGMA foreign_keys = OFF;")
        conn.execute(
            """CREATE TABLE runs_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                status TEXT NOT NULL CHECK(status IN ('running', 'waiting_input', 'success', 'failed', 'timeout', 'stopped', 'killed_oom', 'crash_loop')),
                trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'schedule', 'webhook', 'autostart', 'restart', 'retry', 'healthcheck', 'chain', 'cron_restart', 'ai')),
                pid INTEGER,
                pgid INTEGER,
                proc_create_time REAL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                exit_code INTEGER,
                run_token TEXT UNIQUE NOT NULL,
                log_path TEXT NOT NULL,
                error_summary TEXT DEFAULT ''
            )"""
        )
        conn.execute(
            """INSERT INTO runs_new (
                id, project_id, status, trigger, pid, pgid, proc_create_time,
                started_at, finished_at, exit_code, run_token, log_path, error_summary
            ) SELECT
                id, project_id, status, trigger, pid, pgid, proc_create_time,
                started_at, finished_at, exit_code, run_token, log_path, error_summary
            FROM runs"""
        )
        conn.execute("DROP TABLE runs;")
        conn.execute("ALTER TABLE runs_new RENAME TO runs;")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_project_started ON runs(project_id, started_at DESC);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);")
        conn.execute("PRAGMA foreign_keys = ON;")

    runs_cols = {row["name"] for row in conn.execute("PRAGMA table_info(runs)").fetchall()}
    if "is_auxiliary" not in runs_cols:
        conn.execute("ALTER TABLE runs ADD COLUMN is_auxiliary INTEGER NOT NULL DEFAULT 0")

    # P0-1: Перенос session_secret из SQLite в файл data/session.secret (права 0600)
    sec_row = conn.execute("SELECT value FROM settings WHERE key = 'session_secret'").fetchone()
    if sec_row is not None:
        legacy_secret = str(sec_row["value"] or "").strip()
        if legacy_secret and (not SESSION_SECRET_PATH.exists() or SESSION_SECRET_PATH.stat().st_size == 0):
            SESSION_SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(SESSION_SECRET_PATH), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, legacy_secret.encode("utf-8"))
            finally:
                os.close(fd)
        conn.execute("DELETE FROM settings WHERE key = 'session_secret'")
    if SESSION_SECRET_PATH.exists():
        try:
            os.chmod(SESSION_SECRET_PATH, 0o600)
        except OSError:
            pass

    # P1-4: Расширение ai_approvals (статус 'expired' и колонка expires_at)
    apr_ddl_row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_approvals'").fetchone()
    apr_cols = {row["name"] for row in conn.execute("PRAGMA table_info(ai_approvals)").fetchall()}
    if apr_ddl_row and ("'expired'" not in str(apr_ddl_row["sql"]) or "expires_at" not in apr_cols):
        conn.execute("PRAGMA foreign_keys = OFF;")
        conn.execute(
            """CREATE TABLE ai_approvals_new (
                id TEXT PRIMARY KEY,
                token_id INTEGER NOT NULL,
                token_name TEXT NOT NULL,
                action TEXT NOT NULL,
                project_id INTEGER,
                project_name TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}',
                diff_text TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
                result_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL DEFAULT 0,
                decided_at INTEGER,
                decided_by TEXT DEFAULT ''
            )"""
        )
        has_exp_col = "expires_at" in apr_cols
        exp_select = "expires_at" if has_exp_col else "0"
        conn.execute(
            f"""INSERT INTO ai_approvals_new (
                id, token_id, token_name, action, project_id, project_name,
                payload_json, diff_text, status, result_json, created_at, expires_at, decided_at, decided_by
            ) SELECT
                id, token_id, token_name, action, project_id, project_name,
                payload_json, diff_text, status, result_json, created_at, {exp_select}, decided_at, decided_by
            FROM ai_approvals"""
        )
        conn.execute("DROP TABLE ai_approvals;")
        conn.execute("ALTER TABLE ai_approvals_new RENAME TO ai_approvals;")
        conn.execute("PRAGMA foreign_keys = ON;")

    # P2-16: Колонка actor в audit_log для фиксации автора каждого действия
    audit_cols = {row["name"] for row in conn.execute("PRAGMA table_info(audit_log)").fetchall()}
    if "actor" not in audit_cols:
        conn.execute("ALTER TABLE audit_log ADD COLUMN actor TEXT NOT NULL DEFAULT ''")

    # Колонка triggered_by в runs для атрибуции пользователя/токена запуска (Этап 2)
    run_cols = {row["name"] for row in conn.execute("PRAGMA table_info(runs)").fetchall()}
    if "triggered_by" not in run_cols:
        conn.execute("ALTER TABLE runs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT ''")


def init_db() -> None:
    """
    Инициализирует таблицы SQLite в режиме WAL, выполняет миграции и задаёт настройки по умолчанию.
    По умолчанию пароль администратора — 'admin' (без принудительной смены при входе и без записи на диск).
    """
    bump_db_generation()
    close_thread_connection()
    invalidate_settings_cache()
    ensure_directories()
    EXAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    default_pw = (
        get_env_var("BEACON_ADMIN_PASSWORD", "")
        or get_env_var("BEACON_INIT_PASSWORD", "")
        or "admin"
    )
    for _pw_env_key in (
        "BEACON_ADMIN_PASSWORD",
        "BEACON_INIT_PASSWORD",
    ):
        os.environ.pop(_pw_env_key, None)

    with db_session() as conn:
        conn.executescript(DDL_SCRIPT)
        _run_schema_migrations(conn)

        for key, default_val in DEFAULT_SETTINGS.items():
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            if row is None:
                conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (key, default_val))

        pw_row = conn.execute("SELECT value FROM settings WHERE key = 'password_hash'").fetchone()
        curr_hash = str(pw_row["value"]).strip() if pw_row else ""

        if not curr_hash:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (_scrypt_hash(default_pw),),
            )
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('must_change_password', '0') ON CONFLICT(key) DO UPDATE SET value = '0'"
            )
    invalidate_settings_cache()


def checkpoint_wal(truncate_threshold_mb: float = 4.0) -> dict[str, Any]:
    """
    Контролирует размер файла data/hub.db-wal и выполняет PRAGMA wal_checkpoint(TRUNCATE)
    при превышении порога (по умолчанию 4 МБ).
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
        logger.exception("Ошибка выполнения PRAGMA wal_checkpoint(%s)", mode)
    size_after = wal_path.stat().st_size if wal_path.exists() else 0
    return {
        "mode": mode,
        "wal_size_before_kb": round(size_before / 1024.0, 1),
        "wal_size_after_kb": round(size_after / 1024.0, 1),
        "busy": busy,
        "log_frames": log_frames,
        "checkpointed_frames": checkpointed_frames,
    }
