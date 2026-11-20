"""
Контроль места на диске, ротация лог-файлов по размеру, удаление старых запусков
и очистка системного кэша pip / npm.
"""

import asyncio
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from hub.compat import psutil
from hub.config import BASE_DIR, DB_PATH, LOGS_DIR
from hub.db import checkpoint_wal, execute_sql, get_all_settings, query_all
from hub.notifier import send_notification

_LAST_DISK_WARN_TS: float = 0.0


def get_disk_status() -> dict[str, Any]:
    """Возвращает информацию о свободном месте на диске и порогах warn/crit."""
    cfg = get_all_settings()
    warn_mb = int(cfg.get("disk_warn_mb", "500") or 500)
    crit_mb = int(cfg.get("disk_crit_mb", "150") or 150)

    usage = psutil.disk_usage(str(BASE_DIR))
    free_mb = round(usage.free / (1024 * 1024), 1)
    total_mb = round(usage.total / (1024 * 1024), 1)
    used_mb = round(usage.used / (1024 * 1024), 1)

    wal_path = DB_PATH.with_name(f"{DB_PATH.name}-wal")
    wal_size_kb = round((wal_path.stat().st_size if wal_path.exists() else 0) / 1024.0, 1)

    state = "ok"
    if free_mb < crit_mb:
        state = "critical"
    elif free_mb < warn_mb:
        state = "warning"

    return {
        "free_mb": free_mb,
        "total_mb": total_mb,
        "used_mb": used_mb,
        "percent": usage.percent,
        "warn_mb": warn_mb,
        "crit_mb": crit_mb,
        "state": state,
        "can_start_runs": free_mb >= crit_mb,
        "wal_size_kb": wal_size_kb,
    }


def can_start_new_run() -> tuple[bool, str]:
    """Блокирует новые запуски при падении свободного места ниже disk_crit_mb."""
    st = get_disk_status()
    if not st["can_start_runs"]:
        return (
            False,
            f"Критически мало места на диске ({st['free_mb']} МБ свободно, порог блокировки {st['crit_mb']} МБ).",
        )
    return True, ""


def rotate_and_prune_logs() -> dict[str, int]:
    """
    1. Усекает лог-файлы, превысившие log_max_size_mb (сохраняя последние 50% строк).
    2. Удаляет завершённые запуски сверх лимита log_keep_runs на проект и старше log_keep_days дней.
    """
    cfg = get_all_settings()
    max_size_mb = max(1, int(cfg.get("log_max_size_mb", "10") or 10))
    keep_runs = max(1, int(cfg.get("log_keep_runs", "20") or 20))
    keep_days = max(1, int(cfg.get("log_keep_days", "14") or 14))

    max_bytes = max_size_mb * 1024 * 1024
    rotated_files = 0
    deleted_runs = 0

    # 1. Безопасная ротация по размеру файла (copytruncate: ftruncate(0) + запись хвоста без смены inode)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    if LOGS_DIR.exists():
        for log_file in LOGS_DIR.rglob("*.log"):
            try:
                if log_file.is_symlink() or not log_file.is_file():
                    continue
                sz = log_file.stat().st_size
                if sz > max_bytes:
                    keep_bytes = max_bytes // 2
                    fd = os.open(str(log_file), os.O_RDWR | no_follow)
                    try:
                        os.lseek(fd, max(0, sz - keep_bytes), os.SEEK_SET)
                        tail = os.read(fd, keep_bytes)
                        header = (
                            f"\n--- [BEACON LOG ROTATED AT {int(time.time())}: EXCEEDED {max_size_mb} MB (copytruncate)] ---\n"
                        ).encode("utf-8")
                        os.ftruncate(fd, 0)
                        os.lseek(fd, 0, os.SEEK_SET)
                        view = memoryview(header + tail)
                        while view:
                            written = os.write(fd, view)
                            if written <= 0:
                                break
                            view = view[written:]
                    finally:
                        os.close(fd)
                    rotated_files += 1
            except OSError:
                continue

    logs_root = LOGS_DIR.resolve()

    def _safe_unlink_log(raw_log_path: Any) -> None:
        if not raw_log_path:
            return
        try:
            raw_p = Path(str(raw_log_path))
            if raw_p.is_symlink():
                return
            lp = raw_p.resolve()
            if lp.is_relative_to(logs_root) and lp.is_file():
                lp.unlink(missing_ok=True)
        except OSError:
            pass

    # 2. Удаление старых завершённых запусков по времени (log_keep_days)
    cutoff_ts = int(time.time()) - (keep_days * 86400)
    old_runs = query_all(
        "SELECT id, log_path FROM runs WHERE status NOT IN ('running', 'waiting_input') AND started_at < ?",
        (cutoff_ts,),
    )
    for r in old_runs:
        _safe_unlink_log(r.get("log_path"))
        execute_sql("DELETE FROM runs WHERE id = ?", (r["id"],))
        deleted_runs += 1

    # 3. Оставляем не более log_keep_runs завершённых запусков на каждый проект
    projects = query_all("SELECT id FROM projects")
    for p in projects:
        completed = query_all(
            """SELECT id, log_path FROM runs
               WHERE project_id = ? AND status NOT IN ('running', 'waiting_input')
               ORDER BY started_at DESC""",
            (p["id"],),
        )
        if len(completed) > keep_runs:
            for extra in completed[keep_runs:]:
                _safe_unlink_log(extra.get("log_path"))
                execute_sql("DELETE FROM runs WHERE id = ?", (extra["id"],))
                deleted_runs += 1

    # 4. Ретенция таблиц аудита, одобрений, опросов и отозванных сессий (P2-08)
    now_ts = int(time.time())
    from hub.db import execute_rowcount

    pruned_audit = execute_rowcount("DELETE FROM audit_log WHERE timestamp < ?", (now_ts - 90 * 86400,))
    pruned_ai_audit = execute_rowcount("DELETE FROM ai_audit_log WHERE timestamp < ?", (now_ts - 30 * 86400,))
    pruned_approvals = execute_rowcount(
        "DELETE FROM ai_approvals WHERE status != 'pending' AND created_at < ?",
        (now_ts - 30 * 86400,),
    )
    pruned_asks = execute_rowcount(
        "DELETE FROM pending_asks WHERE status != 'pending' AND created_at < ?",
        (now_ts - 7 * 86400,),
    )
    pruned_sessions = execute_rowcount("DELETE FROM revoked_sessions WHERE exp < ?", (now_ts,))

    return {
        "rotated_files": rotated_files,
        "deleted_runs": deleted_runs,
        "pruned_audit": pruned_audit,
        "pruned_ai_audit": pruned_ai_audit,
        "pruned_approvals": pruned_approvals,
        "pruned_asks": pruned_asks,
        "pruned_sessions": pruned_sessions,
    }


async def check_disk_and_maintain() -> None:
    """Периодическая проверка диска, ротация логов, чекпоинт SQLite WAL и автобэкап (в worker-потоке)."""
    global _LAST_DISK_WARN_TS
    await asyncio.to_thread(rotate_and_prune_logs)
    await asyncio.to_thread(checkpoint_wal, 4.0)
    try:
        from hub.backup_mgr import run_auto_backup_if_due

        await asyncio.to_thread(run_auto_backup_if_due)
    except Exception:
        from hub.log import get_logger

        get_logger("disk_guard").exception("Ошибка выполнения планового автобэкапа")
    st = await asyncio.to_thread(get_disk_status)
    now = time.time()
    if st["state"] in ("warning", "critical") and (now - _LAST_DISK_WARN_TS > 3600):
        _LAST_DISK_WARN_TS = now
        await send_notification(
            f"Мало свободного места на диске: {st['free_mb']} МБ (порог предупреждения: {st['warn_mb']} МБ).",
            level="warn" if st["state"] == "warning" else "error",
        )


def cleanup_system_caches() -> dict[str, Any]:
    """Очищает кэш pip, uv, npm, временные папки проектов (<workdir>/.tmp), старые логи и выполняет чекпоинт SQLite WAL."""
    import shutil

    prune_stats = rotate_and_prune_logs()
    wal_stats = checkpoint_wal(truncate_threshold_mb=0.0)
    outputs: list[str] = [
        f"SQLite WAL checkpoint ({wal_stats['mode']}): {wal_stats['wal_size_before_kb']} КБ -> {wal_stats['wal_size_after_kb']} КБ"
    ]

    # Очищаем <workdir>/.tmp ТОЛЬКО для остановленных проектов (без активных running/waiting_input)
    cleaned_tmp_dirs = 0
    active_proj_rows = query_all(
        "SELECT DISTINCT project_id FROM runs WHERE status IN ('running', 'waiting_input')"
    )
    active_proj_ids = {int(r["project_id"]) for r in active_proj_rows if r.get("project_id") is not None}
    for proj in query_all("SELECT id, workdir FROM projects"):
        if int(proj["id"]) in active_proj_ids:
            continue
        tmp_dir = Path(proj["workdir"]) / ".tmp"
        if tmp_dir.exists() and not tmp_dir.is_symlink():
            try:
                for item in tmp_dir.iterdir():
                    if item.is_dir() and not item.is_symlink():
                        shutil.rmtree(item, ignore_errors=True)
                    else:
                        item.unlink(missing_ok=True)
                cleaned_tmp_dirs += 1
            except OSError:
                pass
    if cleaned_tmp_dirs > 0:
        outputs.append(f"Очищены временные каталоги .tmp у {cleaned_tmp_dirs} проектов")

    for cmd in (
        ["uv", "cache", "clean"],
        ["pip", "cache", "purge"],
        ["python3", "-m", "pip", "cache", "purge"],
        ["npm", "cache", "clean", "--force"],
    ):
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if res.returncode == 0:
                outputs.append(f"{' '.join(cmd)}: OK")
        except Exception:
            continue

    return {
        "ok": True,
        "rotated_files": prune_stats["rotated_files"],
        "deleted_runs": prune_stats["deleted_runs"],
        "wal_checkpoint": wal_stats,
        "cache_commands": outputs or ["Локальные кэши очищены"],
        "disk": get_disk_status(),
    }

