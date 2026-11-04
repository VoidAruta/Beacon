"""
Конфигурация путей, системных настроек по умолчанию и совместимости имён Aruta / Hub.
"""

import os
import pwd
from pathlib import Path


def get_env_var(primary: str, legacy: str, default: str = "") -> str:
    """Читает переменную окружения BEACON_* / ARUTA_* с прозрачным откатом на старый префикс HUB_*."""
    candidates = [primary]
    if primary.startswith("ARUTA_"):
        candidates.insert(0, "BEACON_" + primary[len("ARUTA_") :])
    elif primary.startswith("BEACON_"):
        candidates.append("ARUTA_" + primary[len("BEACON_") :])
    candidates.append(legacy)

    for key in candidates:
        val = os.environ.get(key)
        if val is not None and str(val).strip() != "":
            return str(val).strip()
    return default


def _detect_default_base_dir() -> str:
    env_dir = get_env_var("BEACON_DIR", "HUB_DIR", "")
    if env_dir:
        return env_dir
    for d in ("/opt/beacon", "/opt/aruta", "/opt/hub"):
        if os.path.exists(d):
            return d
    return str(Path(__file__).resolve().parent.parent)


BASE_DIR = Path(_detect_default_base_dir()).resolve()

DATA_DIR = BASE_DIR / "data"
SECRETS_DIR = DATA_DIR / "secrets"
LOGS_DIR = DATA_DIR / "logs"
PROJECTS_DIR = BASE_DIR / "projects"
EXAMPLES_DIR = PROJECTS_DIR / "examples"
DB_PATH = DATA_DIR / "hub.db"
INTERNAL_TOKEN_PATH = DATA_DIR / "internal.token"

SDK_PYTHON_DIR = BASE_DIR / "sdk" / "python"
SDK_NODE_DIR = BASE_DIR / "sdk" / "node"
STATIC_DIR = BASE_DIR / "hub" / "static"

# Для обратной совместимости импортов (сам список теперь настраивается через настройку reserved_ports)
FORBIDDEN_PORTS: set[int] = set()

DEFAULT_PORT = int(get_env_var("BEACON_PORT", "HUB_PORT", "8050") or "8050")


def detect_default_runner_user() -> str:
    """
    Если в системе создан непривилегированный пользователь hub-runner (или beacon-runner)
    и процесс запущен от root — использует его по умолчанию для новых установок.
    """
    for candidate in ("beacon-runner", "aruta-runner", "hub-runner"):
        try:
            pwd.getpwnam(candidate)
            return candidate
        except KeyError:
            continue
    return "root"


DEFAULT_SETTINGS: dict[str, str] = {
    "port": str(DEFAULT_PORT),
    "password_hash": "",  # Заполняется при инициализации БД scrypt-хешем пароля 'admin'
    "must_change_password": "0",
    "allowed_subnets": "127.0.0.0/8,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,::1/128",
    "allow_tailscale": "0",
    "trusted_proxies": "",
    "reserved_ports": "",
    "cookie_secure": "0",
    "proxy_url": get_env_var("ARUTA_PROXY_URL", "HUB_PROXY_URL", ""),
    "run_as_user": detect_default_runner_user(),
    "safe_mode": "1" if get_env_var("ARUTA_SAFE_MODE", "HUB_SAFE_MODE", "0") in ("1", "true", "yes") else "0",
    "outbound_heartbeat_url": "",
    "ai_access_enabled": "0",
    "ai_access_paused": "0",
    "disk_warn_mb": "500",
    "disk_crit_mb": "150",
    "log_max_size_mb": "10",
    "log_keep_runs": "20",
    "log_keep_days": "14",
    "tg_bot_token": "",
    "tg_chat_id": "",
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
                out.append(p) if hasattr(out, "append") else out.add(p)
    return out


def ensure_directories() -> None:
    """Создаёт рабочие директории, удаляет устаревший текстовый initial_password и выставляет права 0700."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
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
    except OSError:
        pass
