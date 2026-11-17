"""
Единый реестр имён переменных окружения, cookie и HTTP-заголовков Beacon,
а также утилита автоматического переезда (миграции) со старых версий.
"""

import os
from pathlib import Path
from typing import Any, Iterable

from hub.log import get_logger

logger = get_logger("names")

ENV_PREFIX = "BEACON_"
SESSION_COOKIE_NAME = "beacon_session"
ALL_SESSION_COOKIE_NAMES = (SESSION_COOKIE_NAME,)

SESSION_HEADER_NAME = "X-Beacon-Session"
SDK_TOKEN_HEADER = "X-Beacon-Token"
SIGNATURE_HEADER = "X-Beacon-Signature"


def get_env_var(
    primary: str,
    default: str = "",
    extra_keys: Iterable[str] = (),
) -> str:
    """
    Читает каноническую переменную окружения BEACON_* (и дополнительные ключи из extra_keys).
    """
    canonical_key = primary if primary.startswith(ENV_PREFIX) else f"{ENV_PREFIX}{primary}"
    candidates: list[str] = [canonical_key]
    if primary != canonical_key:
        candidates.append(primary)
    for k in extra_keys:
        if k and k not in candidates:
            candidates.append(k)

    for key in candidates:
        val = os.environ.get(key)
        if val is not None and str(val).strip() != "":
            return str(val).strip()
    return default


def migrate_legacy_installation(base_dir: Path) -> dict[str, Any]:
    """
    Выполняет однократный автоматический переезд со старых версий в каноническую структуру Beacon:
    - Переносит старые PID-файлы в data/beacon.pid
    - Обновляет устаревшие вызовы SDK в пользовательских скриптах projects/* при миграции
    """
    migrated_files = 0
    data_dir = base_dir / "data"
    projects_dir = base_dir / "projects"

    if data_dir.exists():
        target_pid = data_dir / "beacon.pid"
        for old_pid_name in ("hub.pid",):
            old_pid = data_dir / old_pid_name
            if old_pid.exists():
                try:
                    if not target_pid.exists():
                        old_pid.replace(target_pid)
                    else:
                        old_pid.unlink(missing_ok=True)
                    migrated_files += 1
                except OSError:
                    pass

    if projects_dir.exists():
        for root, dirs, files in os.walk(projects_dir):
            dirs[:] = [d for d in dirs if d not in {".venv", "venv", "node_modules", "__pycache__", ".git", ".tmp", ".home"}]
            root_path = Path(root)
            for fn in files:
                if not fn.endswith((".py", ".js", ".mjs", ".cjs")):
                    continue
                fp = root_path / fn
                try:
                    if not fp.is_file() or fp.is_symlink() or fp.stat().st_size > 512 * 1024:
                        continue
                    text = fp.read_text(encoding="utf-8")
                    updated = text
                    if fn.endswith(".py"):
                        updated = updated.replace("import hub as beacon", "import beacon")
                    if updated != text:
                        fp.write_text(updated, encoding="utf-8")
                        migrated_files += 1
                except Exception:
                    continue

    return {"ok": True, "migrated_files": migrated_files}

