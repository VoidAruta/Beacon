"""
Конфигурация путей и системных настроек по умолчанию Beacon.
"""

import os
import pwd
import re
from pathlib import Path

from hub.names import get_env_var

_PROJECT_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def validate_project_name(name: str) -> bool:
    """Единая строгая проверка ASCII-имени проекта (1–64 символа: a-zA-Z0-9_-)."""
    return bool(_PROJECT_NAME_RE.match((name or "").strip()))


def _detect_default_base_dir() -> str:
    env_dir = get_env_var("BEACON_DIR", "", extra_keys=("BEACON_BASE_DIR",))
    if env_dir:
        return env_dir
    if os.path.exists("/opt/beacon"):
        return "/opt/beacon"
    return str(Path(__file__).resolve().parent.parent)


BASE_DIR = Path(_detect_default_base_dir()).resolve()

DATA_DIR = BASE_DIR / "data"
SECRETS_DIR = DATA_DIR / "secrets"
LOGS_DIR = DATA_DIR / "logs"
BACKUPS_DIR = DATA_DIR / "backups"
GENERATED_DIR = DATA_DIR / "generated"
PROJECTS_DIR = BASE_DIR / "projects"
EXAMPLES_DIR = PROJECTS_DIR / "examples"
DB_PATH = DATA_DIR / "hub.db"
INTERNAL_TOKEN_PATH = DATA_DIR / "internal.token"
SESSION_SECRET_PATH = DATA_DIR / "session.secret"

SDK_PYTHON_DIR = BASE_DIR / "sdk" / "python"
SDK_NODE_DIR = BASE_DIR / "sdk" / "node"
STATIC_DIR = BASE_DIR / "hub" / "static"

# Для обратной совместимости импортов (сам список теперь настраивается через настройку reserved_ports)
FORBIDDEN_PORTS: set[int] = set()

DEFAULT_PORT = int(get_env_var("BEACON_PORT", "8050") or "8050")
RUNTIME_PORT: int = DEFAULT_PORT
_RUNTIME_SAFE_MODE: bool = get_env_var("BEACON_SAFE_MODE", "0") in ("1", "true", "yes")


def set_runtime_port(port: int) -> None:
    global RUNTIME_PORT
    if 1 <= int(port) <= 65535:
        RUNTIME_PORT = int(port)


def get_runtime_port() -> int:
    return int(RUNTIME_PORT or DEFAULT_PORT)


def set_runtime_safe_mode(enabled: bool) -> None:
    global _RUNTIME_SAFE_MODE
    _RUNTIME_SAFE_MODE = bool(enabled)


def is_runtime_safe_mode() -> bool:
    return bool(_RUNTIME_SAFE_MODE)


def detect_default_runner_user() -> str:
    """
    Если в системе создан непривилегированный пользователь beacon-runner
    и процесс запущен от root — использует его по умолчанию для новых установок.
    """
    try:
        pwd.getpwnam("beacon-runner")
        return "beacon-runner"
    except KeyError:
        return "root"


_DEFAULT_ALLOWED_SUBNETS = "127.0.0.0/8,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,169.254.0.0/16,::1/128"

DEFAULT_SETTINGS: dict[str, str] = {
    "port": str(DEFAULT_PORT),
    "password_hash": "",  # Заполняется при инициализации БД scrypt-хешем пароля 'admin'
    "session_epoch": "1",
    "must_change_password": "0",
    "allowed_subnets": get_env_var("BEACON_ALLOWED_SUBNETS", _DEFAULT_ALLOWED_SUBNETS),
    "allow_tailscale": "0",
    "trusted_proxies": get_env_var("BEACON_TRUSTED_PROXIES", ""),
    "reserved_ports": "",
    "cookie_secure": "0",
    "proxy_url": get_env_var("BEACON_PROXY_URL", ""),
    "run_as_user": detect_default_runner_user(),
    "safe_mode": "0",
    "healthcheck_allow_external": "0",
    "outbound_heartbeat_url": "",
    "ai_access_enabled": "0",
    "ai_access_paused": "0",
    "ai_approval_ttl_min": "60",
    "mcp_allowed_origins": "",
    "git_clone_timeout_sec": "120",
    "run_missed": "none",
    "autostart_stagger_sec": "2",
    "autostart_min_free_ram_mb": "64",
    "disk_warn_mb": "500",
    "disk_crit_mb": "150",
    "log_max_size_mb": "10",
    "log_keep_runs": "20",
    "log_keep_days": "14",
    "auto_backup_interval_hours": "24",
    "auto_backup_keep": "5",
    "tg_bot_token": "",
    "tg_chat_id": "",
    "tg_offset": "0",
    "tg_allowed_user_ids": "",
    "tg_use_proxy": "0",
    "ntfy_url": "",
    "ntfy_topic": "",
    "ntfy_use_proxy": "0",
    "webhook_url": "",
    "webhook_use_proxy": "0",
    "battery_warn_temp_c": "43",
    "battery_crit_temp_c": "47",
    "battery_low_pct": "20",
    "thermal_auto_stop": "1",
}


def parse_reserved_ports(raw_csv: str = "") -> set[int]:
    """Разбирает строку зарезервированных портов из настроек (например '22,8080')."""
    out: set[int] = set()
    for part in (raw_csv or "").split(","):
        part = part.strip()
        if part.isdigit():
            p = int(part)
            if 1 <= p <= 65535:
                out.add(p)
    return out


def ensure_directories() -> None:
    """Создаёт рабочие директории, удаляет устаревший текстовый initial_password и выставляет права 0700."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "vendor").mkdir(parents=True, exist_ok=True)
    # Удаляем legacy-файл data/initial_password, если он остался от прошлых версий
    legacy_pw_file = DATA_DIR / "initial_password"
    if legacy_pw_file.exists():
        try:
            legacy_pw_file.unlink()
        except OSError:
            pass
    try:
        os.chmod(DATA_DIR, 0o700)
        os.chmod(SECRETS_DIR, 0o700)
        os.chmod(BACKUPS_DIR, 0o700)
    except OSError:
        pass
