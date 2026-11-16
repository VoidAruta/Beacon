"""
Управление резервным копированием и восстановлением Beacon (P2-13):
- Консистентный онлайн-снимок SQLite через sqlite3.Connection.backup()
- Ограничение максимального размера архива и исключение эфемерных директорий и ключей сессии/внутреннего токена
- Безопасная проверка и распаковка ZIP-архива с проверкой PRAGMA integrity_check и схемы таблиц
- Автобэкапы по расписанию в data/backups/ с ротацией
"""

import asyncio
import os
import secrets
import shutil
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Optional

from hub.config import (
    BACKUPS_DIR,
    BASE_DIR,
    DB_PATH,
    PROJECTS_DIR,
    SECRETS_DIR,
    ensure_directories,
)
from hub.db import close_thread_connection, get_all_settings, init_db, query_all
from hub.log import get_logger
from hub.process_mgr import stop_project

logger = get_logger("backup_mgr")

_SKIP_PROJECT_DIRS = frozenset(
    {".venv", "venv", "node_modules", "__pycache__", ".git", ".tmp", ".home", "browser_profile"}
)
_EXCLUDED_SECRET_FILES = frozenset({"session.secret", "internal.token"})
_REQUIRED_TABLES = ("settings", "projects", "runs", "secrets", "users")
_MAX_PROJECT_FILE_BYTES = 5 * 1024 * 1024


def create_backup_archive(output_path: Path, max_bytes: int = 250 * 1024 * 1024) -> Path:
    """
    Собирает консистентный ZIP-бэкап (SQLite snapshot + data/secrets/* + projects/*) на диск.
    Никогда не включает data/session.secret и data/internal.token.
    Если суммарный размер превышает max_bytes, выбрасывает ValueError.
    """
    ensure_directories()
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    tmp_zip_fd, tmp_zip_name = tempfile.mkstemp(prefix=".beacon_bak_", suffix=".zip", dir=str(out.parent))
    os.close(tmp_zip_fd)
    tmp_zip_path = Path(tmp_zip_name)

    tmp_db_fd, tmp_db_name = tempfile.mkstemp(prefix=".beacon_db_snap_", suffix=".db", dir=str(out.parent))
    os.close(tmp_db_fd)
    tmp_db_path = Path(tmp_db_name)

    try:
        if DB_PATH.exists():
            src_conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
            dst_conn = sqlite3.connect(str(tmp_db_path))
            try:
                src_conn.backup(dst_conn)
            finally:
                dst_conn.close()
                src_conn.close()

        total_added = 0

        def _add_file(zf: zipfile.ZipFile, src: Path, arcname: str) -> None:
            nonlocal total_added
            fsize = src.stat().st_size
            if total_added + fsize > max_bytes:
                raise ValueError(
                    f"Размер резервной копии превышает лимит {max_bytes // (1024 * 1024)} МБ"
                )
            zf.write(src, arcname)
            total_added += fsize

        with zipfile.ZipFile(tmp_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            if tmp_db_path.exists() and tmp_db_path.stat().st_size > 0:
                _add_file(zf, tmp_db_path, "data/hub.db")

            if SECRETS_DIR.exists():
                for sec_file in sorted(SECRETS_DIR.iterdir(), key=lambda p: p.name):
                    if (
                        sec_file.is_file()
                        and not sec_file.is_symlink()
                        and sec_file.name not in _EXCLUDED_SECRET_FILES
                    ):
                        _add_file(zf, sec_file, f"data/secrets/{sec_file.name}")

            if PROJECTS_DIR.exists():
                base_res = BASE_DIR.resolve()
                for root, dirs, files in os.walk(PROJECTS_DIR):
                    dirs[:] = sorted(d for d in dirs if d not in _SKIP_PROJECT_DIRS)
                    root_p = Path(root)
                    for fn in sorted(files):
                        if fn in _EXCLUDED_SECRET_FILES:
                            continue
                        fp = root_p / fn
                        try:
                            if fp.is_file() and not fp.is_symlink():
                                fsize = fp.stat().st_size
                                if fsize <= _MAX_PROJECT_FILE_BYTES:
                                    rel = fp.resolve().relative_to(base_res)
                                    _add_file(zf, fp, rel.as_posix())
                        except OSError:
                            continue

        os.chmod(tmp_zip_path, 0o600)
        os.replace(tmp_zip_path, out)
        return out
    except Exception:
        tmp_zip_path.unlink(missing_ok=True)
        raise
    finally:
        tmp_db_path.unlink(missing_ok=True)


def _validate_zip_member(info: zipfile.ZipInfo) -> str:
    """Проверяет имя и тип записи в ZIP-архиве (защита от traversal, симлинков и лишних путей)."""
    if ((info.external_attr >> 16) & 0o170000) == 0o120000:
        raise ValueError(f"Запрещённая символическая ссылка в архиве: {info.filename}")

    name = (info.filename or "").replace("\\", "/")
    if not name or name.startswith("/"):
        raise ValueError(f"Недопустимый путь в архиве: {info.filename}")
    parts = [p for p in name.split("/") if p != ""]
    if any(p in (".", "..") for p in parts):
        raise ValueError(f"Обнаружен path traversal в архиве: {info.filename}")

    norm = "/".join(parts)
    if info.is_dir():
        if norm != "projects" and not norm.startswith("projects/") and norm not in ("data", "data/secrets"):
            raise ValueError(f"Неразрешённый каталог в архиве: {info.filename}")
        return norm

    if norm == "data/hub.db":
        return norm
    if norm.startswith("data/secrets/") and len(parts) == 3:
        if parts[2] in _EXCLUDED_SECRET_FILES:
            raise ValueError(f"Запрещённый файл в архиве: {norm}")
        return norm
    if norm.startswith("projects/") and len(parts) >= 2:
        if parts[-1] in _EXCLUDED_SECRET_FILES:
            raise ValueError(f"Запрещённый файл в архиве: {norm}")
        return norm

    raise ValueError(f"Неразрешённый файл в архиве бэкапа: {info.filename}")


def _verify_sqlite_snapshot(db_file: Path) -> None:
    conn = sqlite3.connect(str(db_file), timeout=5.0)
    try:
        ic_row = conn.execute("PRAGMA integrity_check;").fetchone()
        if not ic_row or str(ic_row[0]).lower() != "ok":
            raise ValueError(f"Повреждённая БД SQLite в бэкапе: integrity_check={ic_row}")
        tables = {
            str(r[0])
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        missing = [t for t in _REQUIRED_TABLES if t not in tables]
        if missing:
            raise ValueError(f"В БД из бэкапа отсутствуют обязательные таблицы: {missing}")
    finally:
        conn.close()


def _stop_running_projects_sync() -> int:
    try:
        rows = query_all("SELECT id FROM projects")
    except Exception:
        return 0
    if not rows:
        return 0

    async def _stop_all() -> int:
        count = 0
        for row in rows:
            try:
                await stop_project(int(row["id"]))
                count += 1
            except Exception:
                logger.exception("Не удалось остановить проект id=%s перед восстановлением", row.get("id"))
        return count

    try:
        asyncio.get_running_loop()
        # Fallback if somehow called from a running loop: caller should stop projects first
        return 0
    except RuntimeError:
        return asyncio.run(_stop_all())


def restore_backup_archive(archive_path: Path, stop_running: bool = True) -> dict[str, Any]:
    """
    Восстанавливает Beacon из ZIP-архива бэкапа:
    - Валидирует все записи ZIP (без path traversal / симлинков)
    - Проверяет data/hub.db через PRAGMA integrity_check и наличие таблиц
    - Останавливает запущенные проекты
    - Атомарно заменяет data/hub.db, data/secrets/* (0600) и projects/*
    - Удаляет -wal/-shm и повторно запускает init_db() (миграции)
    """
    src_zip = Path(archive_path)
    if not src_zip.exists() or not src_zip.is_file():
        raise FileNotFoundError(f"Файл бэкапа не найден: {src_zip}")

    ensure_directories()

    with zipfile.ZipFile(src_zip, "r") as zf:
        infos = zf.infolist()
        if not infos:
            raise ValueError("Архив бэкапа пуст")

        db_info: Optional[zipfile.ZipInfo] = None
        secret_entries: list[tuple[zipfile.ZipInfo, str]] = []
        project_entries: list[tuple[zipfile.ZipInfo, str]] = []

        for info in infos:
            norm = _validate_zip_member(info)
            if info.is_dir():
                continue
            if norm == "data/hub.db":
                db_info = info
            elif norm.startswith("data/secrets/"):
                secret_entries.append((info, norm.split("/", 2)[2]))
            elif norm.startswith("projects/"):
                project_entries.append((info, norm[len("projects/") :]))

        if db_info is None:
            raise ValueError("В архиве бэкапа отсутствует обязательный файл data/hub.db")

        with tempfile.TemporaryDirectory(prefix="beacon_restore_") as tmp_dir_str:
            tmp_dir = Path(tmp_dir_str)
            tmp_db = tmp_dir / "hub.db"
            with zf.open(db_info, "r") as src_f, open(tmp_db, "wb") as dst_f:
                shutil.copyfileobj(src_f, dst_f)

            _verify_sqlite_snapshot(tmp_db)

            if stop_running and DB_PATH.exists():
                _stop_running_projects_sync()

            close_thread_connection()

            for suffix in ("-wal", "-shm"):
                side = DB_PATH.with_name(f"{DB_PATH.name}{suffix}")
                try:
                    side.unlink(missing_ok=True)
                except OSError:
                    pass

            stage_db = DB_PATH.with_name(f".hub.db.restore.{secrets.token_hex(4)}")
            shutil.copy2(tmp_db, stage_db)
            os.chmod(stage_db, 0o600)
            os.replace(stage_db, DB_PATH)

            restored_secrets = 0
            for info, sec_name in secret_entries:
                target_sec = (SECRETS_DIR / sec_name).resolve()
                if os.path.commonpath([str(SECRETS_DIR.resolve()), str(target_sec)]) != str(SECRETS_DIR.resolve()):
                    raise ValueError(f"Недопустимый путь секрета: {sec_name}")
                tmp_sec = SECRETS_DIR / f".{sec_name}.{secrets.token_hex(4)}.tmp"
                fd = os.open(str(tmp_sec), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                try:
                    with zf.open(info, "r") as src_f:
                        while True:
                            chunk = src_f.read(65536)
                            if not chunk:
                                break
                            os.write(fd, chunk)
                finally:
                    os.close(fd)
                os.chmod(tmp_sec, 0o600)
                os.replace(tmp_sec, target_sec)
                restored_secrets += 1

            restored_files = 0
            proj_root = PROJECTS_DIR.resolve()
            for info, rel_proj in project_entries:
                target_file = (proj_root / rel_proj).resolve()
                if os.path.commonpath([str(proj_root), str(target_file)]) != str(proj_root):
                    raise ValueError(f"Недопустимый путь файла проекта: {rel_proj}")
                target_file.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as src_f, open(target_file, "wb") as dst_f:
                    shutil.copyfileobj(src_f, dst_f)
                restored_files += 1

    init_db()
    return {
        "ok": True,
        "db_restored": True,
        "restored_secrets": restored_secrets,
        "restored_project_files": restored_files,
    }


def run_auto_backup_if_due() -> Optional[Path]:
    """
    Выполняет плановый локальный бэкап в data/backups/ при включённом интервале auto_backup_interval_hours > 0
    и выполняет ротацию старых архивов сверх auto_backup_keep.
    """
    cfg = get_all_settings()
    try:
        interval_hours = int(cfg.get("auto_backup_interval_hours", "24") or 0)
    except ValueError:
        interval_hours = 0
    if interval_hours <= 0:
        return None

    try:
        keep_count = max(1, int(cfg.get("auto_backup_keep", "5") or 5))
    except ValueError:
        keep_count = 5

    ensure_directories()
    existing = sorted(
        (p for p in BACKUPS_DIR.glob("beacon_auto_*.zip") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    now = time.time()
    if existing and (now - existing[0].stat().st_mtime) < (interval_hours * 3600):
        return None

    ts = time.strftime("%Y%m%d_%H%M%S")
    dest = BACKUPS_DIR / f"beacon_auto_{ts}.zip"
    create_backup_archive(dest)

    updated = sorted(
        (p for p in BACKUPS_DIR.glob("beacon_auto_*.zip") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for stale in updated[keep_count:]:
        try:
            stale.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Не удалось удалить старый автобэкап %s: %s", stale, exc)
    return dest
