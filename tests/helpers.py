"""
Общие тестовые хелперы и фикстуры для тестов Beacon (`python3 -m unittest discover -s tests -v`).
Предоставляет изолированное временное окружение create_temp_hub() / temp_hub_env(),
DummyRequest и фабрику тестовых проектов make_project().
"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import time
from typing import Any, Iterator, Optional

import hub.config as hub_config
import hub.db as hub_db


class DummyRequest:
    """Лёгкая имитация Request, совместимая с read_json(), request.json(), request.body() и middleware."""

    def __init__(
        self,
        headers: Optional[dict[str, str]] = None,
        cookies: Optional[dict[str, str]] = None,
        query_params: Optional[dict[str, str]] = None,
        body: Any = None,
        raw_body: Optional[bytes] = None,
        client_host: str = "127.0.0.1",
        method: str = "GET",
        path: str = "/",
        scheme: str = "http",
    ) -> None:
        self.method = method.upper()
        self.path = path
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self.cookies = dict(cookies or {})
        self.query_params = dict(query_params or {})
        self.path_params: dict[str, str] = {}
        self._body = body
        if raw_body is not None:
            self._raw_bytes = raw_body
        elif body is None:
            self._raw_bytes = b""
        elif isinstance(body, (bytes, bytearray)):
            self._raw_bytes = bytes(body)
        elif isinstance(body, str):
            self._raw_bytes = body.encode("utf-8")
        else:
            self._raw_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.client = type("Client", (), {"host": client_host, "port": 0})() if client_host else None
        self.url = type("URL", (), {"path": path, "query": "", "scheme": scheme})()
        self.state = type("State", (), {})()

    async def body(self) -> bytes:
        return self._raw_bytes

    async def json(self) -> Any:
        if not self._raw_bytes:
            return {}
        return json.loads(self._raw_bytes.decode("utf-8"))


_PATH_ATTR_NAMES = (
    "BASE_DIR",
    "DATA_DIR",
    "SECRETS_DIR",
    "LOGS_DIR",
    "PROJECTS_DIR",
    "EXAMPLES_DIR",
    "DB_PATH",
    "INTERNAL_TOKEN_PATH",
    "SESSION_SECRET_PATH",
)


def _sync_module_paths(base_dir: Path) -> list[tuple[Any, str, Any]]:
    import importlib

    data_dir = base_dir / "data"
    new_vals = {
        "BASE_DIR": base_dir,
        "DATA_DIR": data_dir,
        "SECRETS_DIR": data_dir / "secrets",
        "LOGS_DIR": data_dir / "logs",
        "PROJECTS_DIR": base_dir / "projects",
        "EXAMPLES_DIR": base_dir / "projects" / "examples",
        "DB_PATH": data_dir / "hub.db",
        "INTERNAL_TOKEN_PATH": data_dir / "internal.token",
        "SESSION_SECRET_PATH": data_dir / "session.secret",
    }
    mod_names = (
        "hub.config",
        "hub.db",
        "hub.auth",
        "hub.process_mgr",
        "hub.scheduler",
        "hub.secrets_mgr",
        "hub.disk_guard",
        "hub.templates_mgr",
        "hub.doctor",
        "hub.api.routes_ui",
        "hub.api.routes_ai",
        "hub.api.routes_internal",
        "hub.__main__",
    )
    saved: list[tuple[Any, str, Any]] = []
    for mname in mod_names:
        try:
            mod = importlib.import_module(mname)
        except Exception:
            continue
        for attr in _PATH_ATTR_NAMES:
            if hasattr(mod, attr):
                saved.append((mod, attr, getattr(mod, attr)))
                setattr(mod, attr, new_vals[attr])
    return saved


def _reset_caches() -> None:
    close_fn = getattr(hub_db, "close_thread_connection", None)
    if callable(close_fn):
        close_fn()
    inv_settings = getattr(hub_db, "invalidate_settings_cache", None)
    if callable(inv_settings):
        inv_settings()

    import hub.auth as hub_auth
    import hub.secrets_mgr as hub_sec

    hub_auth._SESSION_SECRET = None
    hub_auth._INTERNAL_TOKEN = None
    hub_auth._UNTRUSTED_PROXY_HEADERS_SEEN = False
    for attr in ("_FAILED_LOGINS", "_BLOCKED_IPS", "_WEBHOOK_FAILS", "_WEBHOOK_BLOCKED_IPS", "_REVOKED_SESSIONS"):
        d = getattr(hub_auth, attr, None)
        if isinstance(d, dict):
            d.clear()
    for attr in (
        "_DEFAULT_PW_CACHE",
        "_USER_EXISTS_CACHE",
        "_PARSED_NETS_CACHE",
        "_AI_AUTH_FAILS",
        "_AI_AUTH_BLOCKED_IPS",
    ):
        d = getattr(hub_auth, attr, None)
        if isinstance(d, dict):
            d.clear()
    hub_sec._REDACTION_CACHE = []
    hub_sec._CACHE_LOADED = False


@contextmanager
def temp_hub_env() -> Iterator[Path]:
    """Изолированный временный BEACON_DIR + init_db() с полным восстановлением глобальных путей."""
    tmpdir = Path(tempfile.mkdtemp(prefix="beacon_test_")).resolve()
    old_beacon_env = os.environ.get("BEACON_DIR")
    old_hub_env = os.environ.get("HUB_DIR")
    old_preview_env = os.environ.get("BEACON_PREVIEW_MODE")
    os.environ["BEACON_DIR"] = str(tmpdir)
    os.environ["HUB_DIR"] = str(tmpdir)
    os.environ.pop("BEACON_PREVIEW_MODE", None)

    _reset_caches()
    saved = _sync_module_paths(tmpdir)
    try:
        hub_config.ensure_directories()
        hub_db.init_db()
        yield tmpdir
    finally:
        _reset_caches()
        for mod, attr, prev in saved:
            setattr(mod, attr, prev)
        if old_beacon_env is None:
            os.environ.pop("BEACON_DIR", None)
        else:
            os.environ["BEACON_DIR"] = old_beacon_env
        if old_hub_env is None:
            os.environ.pop("HUB_DIR", None)
        else:
            os.environ["HUB_DIR"] = old_hub_env
        if old_preview_env is None:
            os.environ.pop("BEACON_PREVIEW_MODE", None)
        else:
            os.environ["BEACON_PREVIEW_MODE"] = old_preview_env
        shutil.rmtree(tmpdir, ignore_errors=True)


def create_temp_hub() -> Any:
    """Алиас контекст-менеджера temp_hub_env() (совместимость с P3-05)."""
    return temp_hub_env()


def make_project(
    name: str,
    proj_type: str = "service",
    runtime: str = "bash",
    cmd: str = "sleep 30",
    **overrides: Any,
) -> dict[str, Any]:
    """Создаёт проект в текущей БД и возвращает его словарь."""
    now = int(time.time())
    workdir = Path(overrides.pop("workdir", hub_config.PROJECTS_DIR / name))
    workdir.mkdir(parents=True, exist_ok=True)
    (hub_config.LOGS_DIR / name).mkdir(parents=True, exist_ok=True)

    fields = {
        "name": name,
        "type": proj_type,
        "runtime": runtime,
        "cmd": cmd,
        "workdir": str(workdir),
        "env_json": "{}",
        "secrets_json": "[]",
        "use_proxy": 0,
        "ram_limit_mb": 0,
        "port": 0,
        "healthcheck_url": "",
        "healthcheck_interval_sec": 30,
        "health_status": "unknown",
        "schedule_type": "manual",
        "schedule_expr": "",
        "timeout_sec": 0,
        "max_retries": 0,
        "retry_delay_sec": 30,
        "webhook_token": secrets.token_hex(16),
        "ping_token": secrets.token_hex(16),
        "autostart": 0,
        "restart_policy": "no",
        "backoff_min_sec": 2,
        "backoff_max_sec": 60,
        "min_uptime_sec": 10,
        "max_restarts": 10,
        "restart_delay_sec": 2,
        "cron_restart": "",
        "crash_loop_count": 0,
        "desired_state": "stopped",
        "heartbeat_interval_sec": 0,
        "heartbeat_grace_sec": 60,
        "last_ping_at": 0,
        "on_success_project_id": None,
        "params_schema_json": "[]",
        "notify_on_error": 0,
        "notify_on_success": 0,
        "notify_on_crash": 0,
        "created_at": now,
        "updated_at": now,
    }
    fields.update(overrides)
    cols = ", ".join(fields.keys())
    placeholders = ", ".join("?" for _ in fields)
    proj_id = hub_db.execute_sql(
        f"INSERT INTO projects ({cols}) VALUES ({placeholders})",
        tuple(fields.values()),
    )
    row = hub_db.query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    assert row is not None
    return row
