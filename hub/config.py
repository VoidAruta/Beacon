"""
Конфигурация путей, запрещённых портов и системных настроек по умолчанию.
"""

import os
from pathlib import Path

# Определение базовой директории (/opt/hub по умолчанию)
_default_base = "/opt/hub" if os.path.exists("/opt/hub") else str(Path(__file__).resolve().parent.parent)
BASE_DIR = Path(os.environ.get("HUB_DIR", _default_base)).resolve()

DATA_DIR = BASE_DIR / "data"
SECRETS_DIR = DATA_DIR / "secrets"
LOGS_DIR = DATA_DIR / "logs"
PROJECTS_DIR = BASE_DIR / "projects"
DB_PATH = DATA_DIR / "hub.db"

SDK_PYTHON_DIR = BASE_DIR / "sdk" / "python"
SDK_NODE_DIR = BASE_DIR / "sdk" / "node"
STATIC_DIR = BASE_DIR / "hub" / "static"

# Занятые порты из ТЗ (НЕ ИСПОЛЬЗОВАТЬ для самой панели Hub)
FORBIDDEN_PORTS = {22, 3000, 2053, 3199, 8040, 10808, 25325}

DEFAULT_PORT = int(os.environ.get("HUB_PORT", "8050"))
if DEFAULT_PORT in FORBIDDEN_PORTS:
    DEFAULT_PORT = 8050

DEFAULT_SETTINGS: dict[str, str] = {
    "port": str(DEFAULT_PORT),
    "password_hash": "",  # Заполняется при инициализации БД scrypt-хешем
    "allowed_subnets": "127.0.0.0/8,192.168.100.0/24,192.168.1.0/24,10.0.0.0/8,172.16.0.0/12,::1/128",
    "proxy_url": os.environ.get("HUB_PROXY_URL", "http://127.0.0.1:10808"),
    "run_as_user": "root",
    "disk_warn_mb": "500",
    "disk_crit_mb": "150",
    "log_max_size_mb": "10",
    "log_keep_runs": "20",
    "log_keep_days": "14",
    "tg_bot_token": "",
    "tg_chat_id": "",
    "tg_use_proxy": "1",
    "ntfy_url": "",
    "ntfy_topic": "",
    "ntfy_use_proxy": "0",
    "webhook_url": "",
    "webhook_use_proxy": "0",
}


def ensure_directories() -> None:
    """Создаёт рабочие директории и устанавливает права 0700 на data и data/secrets."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "vendor").mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(DATA_DIR, 0o700)
        os.chmod(SECRETS_DIR, 0o700)
    except OSError:
        pass
