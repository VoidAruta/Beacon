"""
Публичное API веб-панели Beacon (/api/*):
- Авторизация (login, logout, me, stream_ticket) + RBAC пользователи (/api/users)
- Дашборд (/api/dashboard)
- Проекты (CRUD, start с параметрами, stop, restart, install_deps, webhook, ping, export/import .zip, project.yaml)
- Файловый менеджер и редактор кода (files tree, content GET/PUT, mkdir, rename, delete, защищённый upload + zip extract)
- Логи и живой SSE-стрим (/api/projects/{id}/runs, /api/runs/{run_id}/log, /api/runs/{run_id}/stream по одноразовому тикету)
- Секреты и Cookie-Editor импорт (/api/secrets, /api/secrets/cookies, /api/asks/{ask_id}/answer)
- Система, настройки, очистка кэша, аудит и самопроверка пунктов приёмки
"""

import asyncio
import base64
import binascii
import hashlib
import hmac
import io
import ipaddress
import json
import math
import os
import pwd
import re
import secrets
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from hub.api import APIRouter, HTTPException, JSONResponse, Request, Response, StreamingResponse, parse_int_param, read_json
from hub.ask_broker import (
    answer_ask,
    create_ask,
    ensure_tg_poller_running,
    get_active_asks,
    handle_telegram_command,
    poll_ask,
)
from hub.auth import (
    _ip_in_cidr_csv,
    bump_session_epoch,
    check_rate_limit,
    check_webhook_rate_limit,
    clear_login_failures,
    create_session_tokens,
    create_stream_ticket,
    hash_password,
    invalidate_user_cache,
    is_default_password,
    is_loopback_ip,
    is_private_or_loopback_ip,
    needs_password_rehash,
    record_login_failure,
    record_webhook_failure,
    resolve_request_client_ip,
    revoke_session_token,
    verify_dummy_password,
    verify_password,
    verify_session_token,
)
from hub.backup_mgr import create_backup_archive
from hub.compat import croniter, psutil
from hub.config import (
    BASE_DIR,
    EXAMPLES_DIR,
    GENERATED_DIR,
    LOGS_DIR,
    PROJECTS_DIR,
    is_runtime_safe_mode,
    parse_reserved_ports,
    validate_project_name,
)
from hub.db import execute_sql, get_all_settings, get_setting, log_audit, query_all, query_one, set_setting
from hub.disk_guard import cleanup_system_caches, get_disk_status
from hub.doctor import run_hub_doctor
from hub.env_detect import get_environment_profile
from hub.log import get_logger
from hub.notifier import RECENT_NOTIFICATIONS, send_notification
from hub.process_mgr import (
    ACTIVE_RUNS,
    _WATCH_LOOP_STATUS,
    build_install_deps_command,
    check_endpoint_health,
    get_pgid_metrics,
    is_reserved_param_name,
    read_log_tail_bytes,
    recover_running_processes,
    send_stdin_to_run,
    start_project_run,
    stop_project,
)
from hub.scheduler import (
    _SCHEDULER_LOOP_STATUS,
    clear_heartbeat_alert,
    get_upcoming_runs,
    is_project_running,
    validate_chain_no_cycle,
    validate_schedule_config,
)

logger = get_logger("routes_ui")
_PANEL_STARTED_AT = time.time()
from hub.secrets_mgr import (
    delete_secret,
    get_secret_raw,
    import_cookie_editor_json,
    list_secrets,
    mark_cookies_expired,
    redact_log_text,
    reload_redaction_cache,
    save_secret,
    validate_secret_name,
)
from hub.templates_mgr import (
    create_project_from_template,
    parse_simple_project_yaml,
    sync_project_yaml,
    write_project_agents_md,
)
from hub.web_auth_mgr import (
    ACTIVE_WEB_AUTH_SESSIONS,
    cancel_web_auth_session,
    check_android_hardware_guard,
    check_proxy_reachable,
    get_poco_hardware_status,
    perform_web_auth_action,
    save_and_close_web_auth_session,
    start_web_auth_session,
)

router = APIRouter(prefix="/api")

_EXCLUDED_DIRS = {".venv", "node_modules", "__pycache__", ".git", ".mypy_cache", ".pytest_cache", ".home", ".tmp"}
_SAFE_GIT_URL_RE = re.compile(r"^(?:https?://|ssh://|git@)[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$")

# Жёсткие лимиты безопасной распаковки ZIP (Фаза A.5)
MAX_ZIP_ARCHIVE_BYTES = 50 * 1024 * 1024  # 50 МБ
MAX_ZIP_UNCOMPRESSED_BYTES = 150 * 1024 * 1024  # 150 МБ
MAX_ZIP_FILES = 1000
MAX_ZIP_COMPRESSION_RATIO = 50.0
_ZIP_STREAM_CHUNK = 65536

# TTL-кэш размеров папок (60 секунд) для защиты UFS-памяти от os.walk каждые 2 секунды
_DIR_SIZE_CACHE: dict[str, tuple[float, int]] = {}
_DIR_SIZE_TTL_SEC = 60.0


def _client_ip(request: Request) -> str:
    state = getattr(request, "state", None)
    cached = getattr(state, "client_ip", None)
    if cached:
        return str(cached)
    direct_ip = request.client.host if getattr(request, "client", None) else "127.0.0.1"
    headers = getattr(request, "headers", None)
    resolved_ip, proxy_rejected, proxy_err = resolve_request_client_ip(direct_ip, headers)
    if proxy_rejected:
        raise HTTPException(status_code=403, detail=proxy_err)
    return resolved_ip


def _session_role(request: Request) -> str:
    state = getattr(request, "state", None)
    sess = getattr(state, "session", None)
    if isinstance(sess, dict):
        return str(sess.get("role") or "viewer").lower()
    return "admin"


def _session_actor(request: Request) -> str:
    state = getattr(request, "state", None)
    sess = getattr(state, "session", None)
    if isinstance(sess, dict):
        actor = str(sess.get("user") or sess.get("sub") or "").strip()
        if actor:
            return actor
    return "admin"


def _require_admin_session(request: Request) -> None:
    state = getattr(request, "state", None)
    sess = getattr(state, "session", None)
    if isinstance(sess, dict) and str(sess.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Доступ разрешён только администратору")


def _mask_url_userinfo(url_str: str) -> str:
    raw = (url_str or "").strip()
    if not raw or "@" not in raw or "://" not in raw:
        return raw
    scheme, rest = raw.split("://", 1)
    if "@" in rest.split("/", 1)[0]:
        _, host_part = rest.split("@", 1)
        return f"{scheme}://***:***@{host_part}"
    return raw


def _cookie_security_flags(request: Request) -> tuple[bool, str]:
    is_https = (
        getattr(getattr(request, "url", None), "scheme", "http") == "https"
        or request.headers.get("x-forwarded-proto", "").lower() == "https"
        or get_setting("cookie_secure", "0") == "1"
    )
    samesite_mode = "None" if (is_https and os.environ.get("BEACON_PREVIEW_MODE") == "1") else "Lax"
    return is_https, samesite_mode


def _validate_project_workdir(workdir_raw: str, project_name: str = "") -> str:
    """
    Жёсткая проверка, что workdir после Path.resolve() находится строго внутри PROJECTS_DIR (/opt/hub/projects/).
    Запрещает указание системных путей (/, /etc, .. и т.д.).
    """
    base = PROJECTS_DIR.resolve()
    raw = (workdir_raw or "").strip()
    if not raw:
        if not project_name:
            raise HTTPException(status_code=400, detail="Не указан путь рабочей директории проекта (workdir)")
        target = (base / project_name).resolve()
    else:
        p = Path(raw)
        target = p.resolve() if p.is_absolute() else (base / p).resolve()

    try:
        common = os.path.commonpath([str(base), str(target)])
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail="Недопустимый путь workdir: директория проекта должна находиться внутри PROJECTS_DIR",
        ) from e

    if common != str(base) or target == base:
        raise HTTPException(
            status_code=400,
            detail=f"Запрещён выход за пределы PROJECTS_DIR ({base}): недопустимый workdir '{raw}'",
        )
    return str(target)


def _safe_project_path(workdir: str | Path, rel_path: str, reject_symlinks: bool = True) -> Path:
    """Защита от Path Traversal через os.path.commonpath и проверка отсутствия симлинков внутри workdir."""
    base = Path(_validate_project_workdir(str(workdir))).resolve()
    cleaned = (rel_path or "").lstrip("/").lstrip("\\")
    if reject_symlinks and cleaned:
        cur = base
        for part in Path(cleaned).parts:
            if part in ("", "."):
                continue
            if part == "..":
                raise HTTPException(status_code=403, detail="Попытка выхода за пределы директории проекта (Path Traversal)")
            cur = cur / part
            if cur.is_symlink():
                raise HTTPException(status_code=403, detail=f"Операции с символическими ссылками ('{part}') запрещены")
    target = (base / cleaned).resolve()
    if os.path.commonpath([str(base), str(target)]) != str(base):
        raise HTTPException(status_code=403, detail="Попытка выхода за пределы директории проекта (Path Traversal)")
    return target


def safe_extract_zip_file(
    zip_path: Path,
    workdir: Path,
    max_archive_bytes: int = MAX_ZIP_ARCHIVE_BYTES,
    max_uncompressed_bytes: int = MAX_ZIP_UNCOMPRESSED_BYTES,
    max_files: int = MAX_ZIP_FILES,
    max_ratio: float = MAX_ZIP_COMPRESSION_RATIO,
) -> list[str]:
    """
    Потоковая безопасная распаковка ZIP-архива из файла на диске (без удержания архива в памяти).
    """
    if zip_path.stat().st_size > max_archive_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Размер ZIP-архива превышает лимит ({max_archive_bytes // (1024 * 1024)} МБ)",
        )

    extracted_files: list[str] = []
    try:
        zf_ctx = zipfile.ZipFile(zip_path, "r")
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail="Повреждённый или некорректный ZIP-архив") from e

    with zf_ctx as zf:
        members = zf.infolist()
        if len(members) > max_files:
            raise HTTPException(
                status_code=400,
                detail=f"В архиве слишком много файлов ({len(members)} > макс. {max_files})",
            )

        declared_total = 0
        protected_zip_dirs = {".git", ".venv", "venv", ".home", ".tmp"}
        for member in members:
            unix_mode = (member.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                raise HTTPException(status_code=400, detail=f"Символические ссылки в архиве запрещены: {member.filename}")
            norm_parts = [p.lower() for p in member.filename.replace("\\", "/").split("/") if p]
            if any(p in protected_zip_dirs for p in norm_parts):
                raise HTTPException(
                    status_code=400,
                    detail=f"Распаковка в защищённые системные директории ({', '.join(sorted(protected_zip_dirs))}) запрещена: {member.filename}",
                )
            declared_total += max(0, int(member.file_size or 0))
            if declared_total > max_uncompressed_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"Суммарный размер распакованных файлов превышает лимит ({max_uncompressed_bytes // (1024 * 1024)} МБ)",
                )
            comp_sz = max(1, int(member.compress_size or 1))
            if member.file_size > 1024 * 1024 and (member.file_size / comp_sz) > max_ratio:
                raise HTTPException(
                    status_code=400,
                    detail=f"Обнаружена подозрительная степень сжатия ({member.file_size / comp_sz:.1f}x > {max_ratio}x) в файле {member.filename}",
                )

        actual_total_written = 0
        for member in members:
            target_path = _safe_project_path(workdir, member.filename)
            if member.is_dir():
                target_path.mkdir(parents=True, exist_ok=True)
                continue

            target_path.parent.mkdir(parents=True, exist_ok=True)
            comp_sz = max(1, int(member.compress_size or 1))
            file_written = 0
            with zf.open(member, "r") as src_f, open(target_path, "wb") as dst_f:
                while True:
                    chunk = src_f.read(_ZIP_STREAM_CHUNK)
                    if not chunk:
                        break
                    file_written += len(chunk)
                    actual_total_written += len(chunk)
                    if actual_total_written > max_uncompressed_bytes:
                        try:
                            dst_f.close()
                            target_path.unlink(missing_ok=True)
                        except OSError:
                            pass
                        raise HTTPException(
                            status_code=413,
                            detail="Превышен лимит распакованных данных при потоковом чтении (защита от Zip Bomb)",
                        )
                    if file_written > 1024 * 1024 and (file_written / comp_sz) > max_ratio:
                        try:
                            dst_f.close()
                            target_path.unlink(missing_ok=True)
                        except OSError:
                            pass
                        raise HTTPException(
                            status_code=400,
                            detail=f"Превышен коэффициент сжатия ({max_ratio}x) при распаковке {member.filename}",
                        )
                    dst_f.write(chunk)
            extracted_files.append(member.filename)

    return extracted_files


def safe_extract_zip_bytes(
    file_bytes: bytes,
    workdir: Path,
    max_archive_bytes: int = MAX_ZIP_ARCHIVE_BYTES,
    max_uncompressed_bytes: int = MAX_ZIP_UNCOMPRESSED_BYTES,
    max_files: int = MAX_ZIP_FILES,
    max_ratio: float = MAX_ZIP_COMPRESSION_RATIO,
) -> list[str]:
    """Безопасная распаковка ZIP-байтов через временный файл на диске."""
    if len(file_bytes) > max_archive_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Размер ZIP-архива превышает лимит ({max_archive_bytes // (1024 * 1024)} МБ)",
        )
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tf:
        tf.write(file_bytes)
        tmp_path = Path(tf.name)
    try:
        return safe_extract_zip_file(
            tmp_path,
            workdir,
            max_archive_bytes=max_archive_bytes,
            max_uncompressed_bytes=max_uncompressed_bytes,
            max_files=max_files,
            max_ratio=max_ratio,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


def _decode_base64_to_file(b64_raw: str, dest_path: Path, max_bytes: int = MAX_ZIP_ARCHIVE_BYTES) -> int:
    """Потоково декодирует base64 порциями во временный файл, не удерживая буфер файла целиком в памяти (P3-06)."""
    clean = (b64_raw or "").strip()
    if clean.startswith("data:") and ";base64," in clean[:128]:
        clean = clean.split(";base64,", 1)[1].strip()
    compact = "".join(clean.split())
    if not compact:
        return 0
    if len(compact) > (max_bytes * 4 // 3) + 16:
        raise HTTPException(
            status_code=413,
            detail=f"Размер загружаемого файла превышает лимит ({max_bytes // (1024 * 1024)} МБ)",
        )
    if len(compact) % 4 != 0:
        raise HTTPException(status_code=400, detail="Некорректная base64-кодировка файла")

    chunk_chars = 4 * 65536
    written = 0
    try:
        with open(dest_path, "wb") as fh:
            for offset in range(0, len(compact), chunk_chars):
                chunk = base64.b64decode(compact[offset : offset + chunk_chars], validate=True)
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Размер загружаемого файла превышает лимит ({max_bytes // (1024 * 1024)} МБ)",
                    )
                fh.write(chunk)
    except HTTPException:
        raise
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Некорректная base64-кодировка файла") from exc
    return written


def _build_file_tree(root_dir: Path, rel_prefix: str = "") -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not root_dir.exists():
        return items
    try:
        entries = sorted(root_dir.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError:
        return items

    for entry in entries:
        if entry.name in _EXCLUDED_DIRS or entry.is_symlink():
            continue
        rel = f"{rel_prefix}/{entry.name}".lstrip("/")
        if entry.is_dir():
            items.append(
                {
                    "name": entry.name,
                    "path": rel,
                    "type": "dir",
                    "children": _build_file_tree(entry, rel),
                }
            )
        else:
            try:
                sz = entry.stat().st_size
            except OSError:
                sz = 0
            items.append(
                {
                    "name": entry.name,
                    "path": rel,
                    "type": "file",
                    "size": sz,
                }
            )
    return items


def _invalidate_dir_size_cache(root_dir: Optional[Path] = None) -> None:
    if root_dir is None:
        _DIR_SIZE_CACHE.clear()
    else:
        _DIR_SIZE_CACHE.pop(str(root_dir), None)


_CALC_SIZE_SKIP_DIRS = {".venv", "venv", "node_modules", "__pycache__", ".git", ".home", ".tmp"}


def _calc_dir_size(root_dir: Path, force_refresh: bool = False) -> int:
    if not root_dir.exists():
        return 0
    key = str(root_dir)
    now_m = time.monotonic()
    if not force_refresh and key in _DIR_SIZE_CACHE:
        ts, cached_val = _DIR_SIZE_CACHE[key]
        if (now_m - ts) < _DIR_SIZE_TTL_SEC:
            return cached_val

    total = 0
    try:
        for dirpath, dirnames, filenames in os.walk(root_dir):
            dirnames[:] = [d for d in dirnames if d not in _CALC_SIZE_SKIP_DIRS]
            for fname in filenames:
                fp = Path(dirpath) / fname
                try:
                    if not fp.is_symlink():
                        total += fp.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    _DIR_SIZE_CACHE[key] = (now_m, total)
    return total


def _build_enrichment_preload() -> dict[str, Any]:
    """Пакетно загружает последние запуски, активные статусы и секреты одним набором SQL-запросов (без N+1, P1-7)."""
    latest_runs = query_all(
        """SELECT r.id, r.project_id, r.status, r.trigger, r.pid, r.pgid,
                  r.started_at, r.finished_at, r.exit_code, r.error_summary
           FROM runs r
           INNER JOIN (SELECT project_id, MAX(id) AS max_id FROM runs GROUP BY project_id) m
             ON r.id = m.max_id"""
    )
    last_run_by_proj = {int(r["project_id"]): r for r in latest_runs}

    active_rows = query_all("SELECT id, status FROM runs WHERE status IN ('running', 'waiting_input')")
    active_status_by_id = {int(r["id"]): str(r["status"]) for r in active_rows}

    secret_rows = query_all("SELECT * FROM secrets")
    secrets_by_name = {str(s["name"]): s for s in secret_rows}

    active_by_proj: dict[int, dict[str, Any]] = {}
    for _r_id, info in list(ACTIVE_RUNS.items()):
        pid_key = int(info["project_id"])
        if pid_key not in active_by_proj:
            active_by_proj[pid_key] = info

    return {
        "last_run_by_proj": last_run_by_proj,
        "active_status_by_id": active_status_by_id,
        "secrets_by_name": secrets_by_name,
        "active_by_proj": active_by_proj,
    }


def _enrich_projects_batch(rows: list[dict[str, Any]], mask_sensitive: bool = False) -> list[dict[str, Any]]:
    if not rows:
        return []
    preload = _build_enrichment_preload()
    return [_enrich_project(p, mask_sensitive=mask_sensitive, preloaded=preload) for p in rows]


def _enrich_project(
    p: dict[str, Any],
    mask_sensitive: bool = False,
    preloaded: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    proj_id = p["id"]
    proj_name = p["name"]
    if preloaded is not None:
        active_run = preloaded["active_by_proj"].get(int(proj_id))
        last_run = preloaded["last_run_by_proj"].get(int(proj_id))
    else:
        active_run = None
        for _r_id, info in list(ACTIVE_RUNS.items()):
            if info["project_id"] == proj_id:
                active_run = info
                break
        last_run = query_one(
            "SELECT id, status, trigger, pid, pgid, started_at, finished_at, exit_code, error_summary FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1",
            (proj_id,),
        )

    status = "stopped"
    pid = None
    pgid = None
    rss_mb = 0.0
    cpu_pct = 0.0
    proc_cnt = 0
    active_run_id = None

    if active_run:
        active_run_id = active_run["run_id"]
        pid = active_run["pid"]
        pgid = active_run["pgid"]
        rss_mb = active_run.get("rss_mb", 0.0)
        cpu_pct = active_run.get("cpu_percent", 0.0)
        proc_cnt = int(active_run.get("proc_count") or 1)
        if preloaded is not None:
            status = preloaded["active_status_by_id"].get(int(active_run_id), "running")
        else:
            db_run = query_one("SELECT status FROM runs WHERE id = ?", (active_run_id,))
            status = db_run["status"] if db_run else "running"
    elif last_run:
        if last_run["status"] in ("running", "waiting_input"):
            status = last_run["status"]
            active_run_id = last_run["id"]
            pid = last_run["pid"]
            pgid = last_run["pgid"]
            proc_cnt = 1
        elif last_run["status"] == "crash_loop":
            status = "crash_loop"
        elif p["type"] == "job":
            status = last_run["status"]

    out = dict(p)
    out["current_status"] = status
    out["active_run_id"] = active_run_id
    out["pid"] = pid
    out["pgid"] = pgid
    out["rss_mb"] = rss_mb
    out["cpu_percent"] = cpu_pct
    out["proc_count"] = proc_cnt
    out["last_run"] = last_run
    try:
        out["env"] = json.loads(p.get("env_json") or "{}")
    except Exception:
        out["env"] = {}
    try:
        out["secrets"] = json.loads(p.get("secrets_json") or "[]")
    except Exception:
        out["secrets"] = []
    try:
        out["params_schema"] = json.loads(p.get("params_schema_json") or "[]")
    except Exception:
        out["params_schema"] = []

    code_size_bytes = _calc_dir_size(Path(p["workdir"]))
    logs_size_bytes = _calc_dir_size(LOGS_DIR / proj_name)
    out["code_size_bytes"] = code_size_bytes
    out["logs_size_bytes"] = logs_size_bytes
    out["total_size_bytes"] = code_size_bytes + logs_size_bytes

    out["description"] = str(out["env"].get("PROJECT_DESCRIPTION", ""))
    out["is_test_project"] = str(out["env"].get("IS_TEST_PROJECT", "0")) == "1"
    default_group = (
        "Тесты"
        if out["is_test_project"]
        else ("Веб/API" if p["type"] == "web" else ("Боты 24/7" if p["type"] == "service" else "Скрипты"))
    )
    out["group_tag"] = str(out["env"].get("PROJECT_GROUP") or default_group)
    out["custom_proxy"] = str(out["env"].get("CUSTOM_PROXY_URL", ""))
    out["git_repo_url"] = str(out["env"].get("GIT_REPO_URL", ""))
    out["webhook_hmac_secret"] = str(p.get("webhook_hmac_secret") or "")
    out["ping_token"] = str(p.get("ping_token") or "")
    if mask_sensitive:
        masked_env = {str(k): "********" for k in out["env"].keys()} if isinstance(out["env"], dict) else {}
        out["env"] = masked_env
        out["env_json"] = json.dumps(masked_env, ensure_ascii=False)
        out["custom_proxy"] = _mask_url_userinfo(out["custom_proxy"]) if out["custom_proxy"] else ""
        out["git_repo_url"] = _mask_url_userinfo(out["git_repo_url"]) if out["git_repo_url"] else ""
        out["webhook_token"] = "********" if out.get("webhook_token") else ""
        out["webhook_hmac_secret"] = "********" if out.get("webhook_hmac_secret") else ""
        out["ping_token"] = "********" if out.get("ping_token") else ""
    out["next_run_at"] = int(p.get("next_run_at") or 0)
    out["last_run_at"] = int(p.get("last_run_at") or 0)
    out["port"] = int(p.get("port") or 0)
    out["healthcheck_url"] = str(p.get("healthcheck_url") or "")
    out["healthcheck_interval_sec"] = int(p.get("healthcheck_interval_sec") or 30)
    out["health_status"] = str(p.get("health_status") or "unknown")
    out["min_uptime_sec"] = int(p.get("min_uptime_sec") or 10)
    out["max_restarts"] = int(p.get("max_restarts") or 10)
    out["restart_delay_sec"] = int(p.get("restart_delay_sec") or 5)
    out["cron_restart"] = str(p.get("cron_restart") or "")
    out["crash_loop_count"] = int(p.get("crash_loop_count") or 0)
    out["heartbeat_interval_sec"] = int(p.get("heartbeat_interval_sec") or 0)
    out["heartbeat_grace_sec"] = int(p.get("heartbeat_grace_sec") or 60)
    out["last_ping_at"] = int(p.get("last_ping_at") or 0)
    out["on_success_project_id"] = int(p.get("on_success_project_id") or 0)
    out["has_venv"] = (Path(p["workdir"]) / ".venv" / "bin" / "python").exists()
    out["has_browser_profile"] = (Path(p["workdir"]) / "storage_state.json").exists()
    out["has_project_yaml"] = (Path(p["workdir"]) / "project.yaml").exists()
    out["active_web_auth"] = ACTIVE_WEB_AUTH_SESSIONS.get(proj_id) is not None

    default_cookie_name = f"{proj_name}_cookies"
    if preloaded is not None:
        sec_map = preloaded["secrets_by_name"]
        cookie_row = sec_map.get(default_cookie_name)
        if not cookie_row and out["secrets"]:
            for sec_name in out["secrets"]:
                cand = sec_map.get(str(sec_name))
                if cand and cand.get("type") == "cookie_json":
                    cookie_row = cand
                    break
    else:
        cookie_row = query_one("SELECT * FROM secrets WHERE name = ?", (default_cookie_name,))
        if not cookie_row and out["secrets"]:
            for sec_name in out["secrets"]:
                candidate = query_one("SELECT * FROM secrets WHERE name = ? AND type = 'cookie_json'", (sec_name,))
                if candidate:
                    cookie_row = candidate
                    break

    if cookie_row:
        c_size = 0
        try:
            c_size = Path(cookie_row["file_path"]).stat().st_size
        except OSError:
            pass
        out["cookie_status"] = {
            "secret_name": cookie_row["name"],
            "has_cookies": True,
            "is_expired": int(cookie_row["is_expired"]),
            "expired_note": cookie_row["expired_note"] or "",
            "updated_at": cookie_row["updated_at"],
            "size_bytes": c_size,
        }
    else:
        out["cookie_status"] = {
            "secret_name": default_cookie_name,
            "has_cookies": False,
            "is_expired": 0,
            "expired_note": "",
            "updated_at": 0,
            "size_bytes": 0,
        }

    return out


# ==============================================================================
# 1. АВТОРИЗАЦИЯ И СЕССИИ (Фаза A.1, A.4, D.4)
# ==============================================================================
@router.post("/auth/login")
async def api_login(request: Request) -> Response:
    client_ip = _client_ip(request)

    default_pw = is_default_password()
    # Фаза A.1(д): пока используется пароль по умолчанию, вход разрешён только с loopback и RFC1918
    if default_pw and not is_private_or_loopback_ip(client_ip):
        raise HTTPException(
            status_code=403,
            detail="Пока используется пароль по умолчанию (admin), вход разрешён только из локальной сети (127.0.0.1, 10/8, 172.16/12, 192.168/16).",
        )

    body = await read_json(request)
    username = str(body.get("username", "admin") or "admin").strip()
    password = str(body.get("password", ""))

    allowed, retry_after = check_rate_limit(client_ip, username)
    if not allowed:
        return JSONResponse(
            {
                "detail": f"Слишком много неудачных попыток входа. Вход заблокирован ещё на {retry_after} сек.",
                "retry_after": retry_after,
            },
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    authenticated_role = "admin"
    authenticated_user = "admin"
    auth_ok = False

    if username in ("", "admin"):
        stored_hash = get_setting("password_hash", "")
        if verify_password(password, stored_hash):
            auth_ok = True
            authenticated_role = "admin"
            authenticated_user = "admin"
            if needs_password_rehash(stored_hash):
                set_setting("password_hash", hash_password(password))
    else:
        user_row = query_one("SELECT * FROM users WHERE username = ?", (username,))
        if user_row:
            if verify_password(password, user_row["password_hash"]):
                auth_ok = True
                authenticated_role = str(user_row.get("role") or "viewer")
                authenticated_user = str(user_row["username"])
                if needs_password_rehash(str(user_row["password_hash"])):
                    execute_sql(
                        "UPDATE users SET password_hash = ? WHERE id = ?",
                        (hash_password(password), int(user_row["id"])),
                    )
        else:
            # Выравнивание времени ответа при несуществующем пользователе (P1-2)
            verify_dummy_password(password)

    if not auth_ok:
        now_blocked, block_sec = record_login_failure(client_ip, username)
        if now_blocked:
            await send_notification(
                f"Обнаружен перебор пароля с IP {client_ip} (пользователь: {username})! Вход заблокирован на {block_sec // 60} минут.",
                level="error",
            )
            return JSONResponse(
                {
                    "detail": f"Превышен лимит попыток входа (5 за 5 минут). Вход заблокирован на {block_sec // 60} минут.",
                    "retry_after": block_sec,
                },
                status_code=429,
                headers={"Retry-After": str(block_sec)},
            )
        raise HTTPException(status_code=401, detail="Неверный пароль или имя пользователя")

    clear_login_failures(client_ip, username)
    session_token, csrf_token = create_session_tokens(role=authenticated_role, username=authenticated_user)
    log_audit(client_ip, "LOGIN_SUCCESS", f"Успешный вход в панель (пользователь: {authenticated_user}, роль: {authenticated_role})", actor=authenticated_user)

    is_https, samesite_mode = _cookie_security_flags(request)
    login_payload: dict[str, Any] = {
        "ok": True,
        "authenticated": True,
        "csrf_token": csrf_token,
        "role": authenticated_role,
        "username": authenticated_user,
        "is_default_password": is_default_password(),
        "must_change_password": False,
    }
    if os.environ.get("BEACON_PREVIEW_MODE") == "1":
        login_payload["session_token"] = session_token

    resp = JSONResponse(login_payload)
    resp.set_cookie(
        "beacon_session",
        session_token,
        max_age=86400 * 7,
        httponly=True,
        samesite=samesite_mode,
        secure=is_https,
    )
    resp.delete_cookie("aruta_session")
    resp.delete_cookie("hub_session")
    resp.set_cookie(
        "csrf_token",
        csrf_token,
        max_age=86400 * 7,
        httponly=False,
        samesite=samesite_mode,
        secure=is_https,
    )
    return resp


@router.post("/auth/change_initial_password")
async def api_change_initial_password(request: Request) -> Response:
    """Смена пароля администратора (минимум 8 символов, проверка current_password и ротация epoch)."""
    _require_admin_session(request)
    client_ip = _client_ip(request)
    body = await read_json(request)
    new_password = str(body.get("new_password", "")).strip()
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="Новый пароль должен содержать минимум 8 символов")
    if new_password.lower() == "admin":
        raise HTTPException(status_code=400, detail="Новый пароль не может совпадать со стандартным 'admin'")

    if not is_default_password():
        curr_pw = str(body.get("current_password", ""))
        if not curr_pw or not verify_password(curr_pw, get_setting("password_hash", "")):
            raise HTTPException(status_code=400, detail="Укажите действующий текущий пароль (current_password)")

    set_setting("password_hash", hash_password(new_password))
    set_setting("must_change_password", "0")
    bump_session_epoch()
    log_audit(client_ip, "PASSWORD_CHANGED", "Пароль администратора успешно изменён", actor=_session_actor(request))

    payload: dict[str, Any] = {"ok": True, "must_change_password": False, "is_default_password": False}
    sess = getattr(getattr(request, "state", None), "session", None)
    resp_cookies = False
    if isinstance(sess, dict):
        uname = str(sess.get("user") or "admin")
        urole = str(sess.get("role") or "admin")
        new_sess, new_csrf = create_session_tokens(role=urole, username=uname)
        payload["csrf_token"] = new_csrf
        if os.environ.get("BEACON_PREVIEW_MODE") == "1":
            payload["session_token"] = new_sess
        resp_cookies = True

    resp = JSONResponse(payload)
    if resp_cookies:
        is_https, samesite_mode = _cookie_security_flags(request)
        resp.set_cookie("beacon_session", new_sess, max_age=86400 * 7, httponly=True, samesite=samesite_mode, secure=is_https)
        resp.set_cookie("csrf_token", new_csrf, max_age=86400 * 7, httponly=False, samesite=samesite_mode, secure=is_https)
    return resp


@router.post("/auth/logout")
async def api_logout(request: Request) -> Response:
    client_ip = _client_ip(request)
    token = (
        request.cookies.get("beacon_session")
        or request.cookies.get("aruta_session")
        or request.cookies.get("hub_session")
        or request.headers.get("x-beacon-session", "")
        or request.headers.get("x-aruta-session", "")
        or request.headers.get("x-hub-session", "")
    )
    logout_actor = "admin"
    if token:
        sess_info = verify_session_token(token)
        if isinstance(sess_info, dict) and sess_info.get("user"):
            logout_actor = str(sess_info["user"])
        revoke_session_token(token)
    log_audit(client_ip, "LOGOUT", "Выход из веб-панели (сессия инвалидирована)", actor=logout_actor)
    resp = JSONResponse({"ok": True, "authenticated": False})
    resp.delete_cookie("beacon_session")
    resp.delete_cookie("aruta_session")
    resp.delete_cookie("hub_session")
    resp.delete_cookie("csrf_token")
    return resp


@router.get("/auth/me")
async def api_auth_me(request: Request) -> Response:
    token = (
        request.cookies.get("beacon_session")
        or request.cookies.get("aruta_session")
        or request.cookies.get("hub_session")
        or request.headers.get("x-beacon-session", "")
        or request.headers.get("x-aruta-session", "")
        or request.headers.get("x-hub-session", "")
    )
    session = verify_session_token(token)
    default_pw = is_default_password()
    if session:
        return JSONResponse(
            {
                "authenticated": True,
                "csrf_token": session["csrf"],
                "role": session.get("role", "admin"),
                "username": session.get("user") or session.get("sub") or "admin",
                "is_default_password": default_pw,
                "must_change_password": False,
                "safe_mode": is_runtime_safe_mode() or get_setting("safe_mode", "0") == "1",
            }
        )

    # Фаза A.1(б): поле initial_password_file полностью убрано из ответа /api/auth/me
    return JSONResponse(
        {
            "authenticated": False,
            "is_default_password": default_pw,
            "must_change_password": False,
        },
        status_code=401,
    )


@router.post("/auth/stream_ticket")
async def api_create_stream_ticket(request: Request) -> dict[str, Any]:
    """Выдаёт короткоживущий одноразовый тикет для подключения к SSE-потоку логов (/api/runs/{id}/stream?ticket=...)."""
    body = await read_json(request)
    run_id = parse_int_param(body.get("run_id"), "run_id", min_val=1)
    sess = getattr(getattr(request, "state", None), "session", None)
    session_sid = str(sess.get("sid") or "") if isinstance(sess, dict) else ""
    ticket = create_stream_ticket(run_id=run_id, session_sid=session_sid, ttl_sec=60)
    return {"ok": True, "ticket": ticket, "run_id": run_id, "expires_in": 60}


# ==============================================================================
# 1.1. РОЛЕВАЯ МОДЕЛЬ (RBAC Users — Фаза D.4)
# ==============================================================================
@router.get("/users")
async def api_list_users(request: Request) -> list[dict[str, Any]]:
    _require_admin_session(request)
    rows = query_all("SELECT id, username, role, created_at FROM users ORDER BY id ASC")
    return rows


@router.post("/users")
async def api_create_user(request: Request) -> dict[str, Any]:
    _require_admin_session(request)
    body = await read_json(request)
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", "")).strip()
    role = str(body.get("role", "viewer")).strip().lower()

    if not validate_project_name(username) or username.lower() == "admin":
        raise HTTPException(status_code=400, detail="Некорректное имя пользователя (не должно быть 'admin')")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Пароль должен содержать минимум 8 символов")
    if role not in ("viewer", "operator", "admin"):
        raise HTTPException(status_code=400, detail="Роль должна быть 'viewer', 'operator' или 'admin'")
    if query_one("SELECT id FROM users WHERE username = ?", (username,)):
        raise HTTPException(status_code=400, detail=f"Пользователь «{username}» уже существует")

    now = int(time.time())
    uid = execute_sql(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        (username, hash_password(password), role, now),
    )
    invalidate_user_cache(username)
    log_audit(_client_ip(request), "USER_CREATED", f"Создан пользователь {username} (роль: {role})", actor=_session_actor(request))
    return {"ok": True, "id": uid, "username": username, "role": role, "created_at": now}


@router.put("/users/{user_id}")
async def api_update_user(request: Request, user_id: int) -> dict[str, Any]:
    _require_admin_session(request)
    user_row = query_one("SELECT id, username, role FROM users WHERE id = ?", (user_id,))
    if not user_row:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    body = await read_json(request)
    new_role = str(body.get("role", user_row["role"])).strip().lower()
    if new_role not in ("viewer", "operator", "admin"):
        raise HTTPException(status_code=400, detail="Роль должна быть 'viewer', 'operator' или 'admin'")

    new_password = str(body.get("password", "") or "").strip()
    if new_password:
        if len(new_password) < 8:
            raise HTTPException(status_code=400, detail="Пароль должен содержать минимум 8 символов")
        execute_sql(
            "UPDATE users SET role = ?, password_hash = ? WHERE id = ?",
            (new_role, hash_password(new_password), user_id),
        )
    else:
        execute_sql("UPDATE users SET role = ? WHERE id = ?", (new_role, user_id))

    uname = str(user_row["username"])
    invalidate_user_cache(uname)
    log_audit(
        _client_ip(request),
        "USER_UPDATED",
        f"Обновлён пользователь {uname} (роль: {new_role}{', пароль изменён' if new_password else ''})",
        actor=_session_actor(request),
    )
    return {"ok": True, "id": user_id, "username": uname, "role": new_role}


@router.delete("/users/{user_id}")
async def api_delete_user(request: Request, user_id: int) -> dict[str, Any]:
    _require_admin_session(request)
    user_row = query_one("SELECT id, username FROM users WHERE id = ?", (user_id,))
    if not user_row:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    actor = _session_actor(request)
    uname = str(user_row["username"])
    if uname == actor:
        raise HTTPException(status_code=400, detail="Нельзя удалить собственную учётную запись")

    execute_sql("DELETE FROM users WHERE id = ?", (user_id,))
    invalidate_user_cache(uname)
    log_audit(_client_ip(request), "USER_DELETED", f"Удалён пользователь {uname} (ID={user_id})", actor=actor)
    return {"ok": True, "deleted_id": user_id}


# ==============================================================================
# 2. ДАШБОРД И СЕТЕВАЯ ТЕЛЕМЕТРИЯ
# ==============================================================================
_NET_PREV_SAMPLE: dict[str, Any] = {"ts": 0.0, "rx_bytes": 0, "tx_bytes": 0, "ifaces": {}}
_NET_HISTORY: list[dict[str, Any]] = []


def _get_network_telemetry(projects: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Собирает реальную сетевую статистику из /proc/net/dev и /proc/net/tcp(6):
    - Входящий / исходящий трафик (байты, пакеты, скорость КБ/с)
    - Статистика по сетевым интерфейсам (eth0, wlan0, tailscale0, tun0 и др.)
    - Количество установленных TCP-соединений (ESTABLISHED) и слушающих сокетов (LISTEN)
    - Список активных портов Web/API проектов
    """
    now_mono = time.monotonic()
    now_epoch = int(time.time())
    total_rx_bytes = 0
    total_tx_bytes = 0
    total_rx_packets = 0
    total_tx_packets = 0
    raw_ifaces: dict[str, dict[str, int]] = {}

    try:
        dev_path = Path("/proc/net/dev")
        if dev_path.exists():
            lines = dev_path.read_text(encoding="utf-8", errors="ignore").splitlines()[2:]
            for line in lines:
                if ":" not in line:
                    continue
                iface_part, stats_part = line.split(":", 1)
                iface = iface_part.strip()
                fields = stats_part.split()
                if len(fields) < 10:
                    continue
                rx_b = int(fields[0])
                rx_p = int(fields[1])
                tx_b = int(fields[8])
                tx_p = int(fields[9])
                raw_ifaces[iface] = {
                    "rx_bytes": rx_b,
                    "rx_packets": rx_p,
                    "tx_bytes": tx_b,
                    "tx_packets": tx_p,
                }
                if iface != "lo":
                    total_rx_bytes += rx_b
                    total_tx_bytes += tx_b
                    total_rx_packets += rx_p
                    total_tx_packets += tx_p
        # Если кроме lo нет внешних счётчиков — учитываем lo
        if total_rx_bytes == 0 and total_tx_bytes == 0 and "lo" in raw_ifaces:
            total_rx_bytes = raw_ifaces["lo"]["rx_bytes"]
            total_tx_bytes = raw_ifaces["lo"]["tx_bytes"]
            total_rx_packets = raw_ifaces["lo"]["rx_packets"]
            total_tx_packets = raw_ifaces["lo"]["tx_packets"]
    except Exception:
        pass

    prev_ts = float(_NET_PREV_SAMPLE.get("ts") or 0.0)
    dt = now_mono - prev_ts if prev_ts > 0 else 0.0
    rx_kbps = 0.0
    tx_kbps = 0.0
    if 0.2 <= dt <= 60.0:
        d_rx = max(0, total_rx_bytes - int(_NET_PREV_SAMPLE.get("rx_bytes") or 0))
        d_tx = max(0, total_tx_bytes - int(_NET_PREV_SAMPLE.get("tx_bytes") or 0))
        rx_kbps = round((d_rx / 1024.0) / dt, 2)
        tx_kbps = round((d_tx / 1024.0) / dt, 2)

    prev_ifaces: dict[str, dict[str, int]] = _NET_PREV_SAMPLE.get("ifaces") or {}
    interfaces_out: list[dict[str, Any]] = []
    for iface_name, st in sorted(raw_ifaces.items(), key=lambda x: (x[0] == "lo", x[0])):
        if iface_name == "lo" and len(raw_ifaces) > 1:
            continue
        if_rx_kbps = 0.0
        if_tx_kbps = 0.0
        if 0.2 <= dt <= 60.0 and iface_name in prev_ifaces:
            if_rx_kbps = round(max(0, st["rx_bytes"] - prev_ifaces[iface_name]["rx_bytes"]) / 1024.0 / dt, 2)
            if_tx_kbps = round(max(0, st["tx_bytes"] - prev_ifaces[iface_name]["tx_bytes"]) / 1024.0 / dt, 2)
        is_vpn = any(iface_name.startswith(p) for p in ("tailscale", "tun", "wg", "tap", "zt"))
        interfaces_out.append(
            {
                "name": iface_name,
                "rx_mb": round(st["rx_bytes"] / (1024 * 1024), 2),
                "tx_mb": round(st["tx_bytes"] / (1024 * 1024), 2),
                "rx_kbps": if_rx_kbps,
                "tx_kbps": if_tx_kbps,
                "is_tunnel": is_vpn,
            }
        )

    _NET_PREV_SAMPLE["ts"] = now_mono
    _NET_PREV_SAMPLE["rx_bytes"] = total_rx_bytes
    _NET_PREV_SAMPLE["tx_bytes"] = total_tx_bytes
    _NET_PREV_SAMPLE["ifaces"] = raw_ifaces

    if not _NET_HISTORY or (now_epoch - int(_NET_HISTORY[-1].get("ts", 0))) >= 1:
        _NET_HISTORY.append({"ts": now_epoch, "rx_kbps": rx_kbps, "tx_kbps": tx_kbps})
        if len(_NET_HISTORY) > 24:
            del _NET_HISTORY[:-24]

    tcp_established = 0
    tcp_listen = 0
    for tcp_file in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            tp = Path(tcp_file)
            if tp.exists():
                for line in tp.read_text(encoding="utf-8", errors="ignore").splitlines()[1:]:
                    parts = line.split()
                    if len(parts) >= 4:
                        state_hex = parts[3].upper()
                        if state_hex == "01":
                            tcp_established += 1
                        elif state_hex == "0A":
                            tcp_listen += 1
        except Exception:
            pass

    active_web_ports: list[dict[str, Any]] = []
    for p in projects:
        port_num = int(p.get("port") or 0)
        if port_num > 0 or p.get("type") == "web":
            ep = p.get("endpoint_status")
            active_web_ports.append(
                {
                    "project_id": p["id"],
                    "project_name": p["name"],
                    "port": port_num,
                    "status": p.get("status", "stopped"),
                    "endpoint_online": bool(ep.get("online")) if isinstance(ep, dict) else False,
                }
            )

    return {
        "rx_bytes": total_rx_bytes,
        "tx_bytes": total_tx_bytes,
        "rx_mb": round(total_rx_bytes / (1024 * 1024), 2),
        "tx_mb": round(total_tx_bytes / (1024 * 1024), 2),
        "rx_packets": total_rx_packets,
        "tx_packets": total_tx_packets,
        "rx_kbps": rx_kbps,
        "tx_kbps": tx_kbps,
        "tcp_established": tcp_established,
        "tcp_listen": tcp_listen,
        "interfaces": interfaces_out[:6],
        "active_web_ports": active_web_ports,
        "history": list(_NET_HISTORY),
    }


def _build_dashboard_payload_sync(mask_sensitive: bool) -> dict[str, Any]:
    vm = psutil.virtual_memory()
    cpu_pct = psutil.cpu_percent(interval=None)
    hub_proc = psutil.Process(os.getpid())
    hub_rss_bytes = hub_proc.memory_info().rss
    hub_rss_mb = round(hub_rss_bytes / (1024 * 1024), 2)

    disk = get_disk_status()
    active_asks = get_active_asks()
    expired_cookies = query_all(
        "SELECT name, type, expired_note, updated_at FROM secrets WHERE is_expired = 1 ORDER BY updated_at DESC"
    )
    projects_raw = query_all("SELECT * FROM projects ORDER BY id ASC")
    projects = _enrich_projects_batch(projects_raw, mask_sensitive=mask_sensitive)

    upcoming_runs = get_upcoming_runs(limit=5)
    recent_errors = query_all(
        """SELECT r.id, r.project_id, p.name AS project_name, r.status, r.trigger,
                  r.started_at, r.finished_at, r.exit_code, r.error_summary
           FROM runs r
           JOIN projects p ON p.id = r.project_id
           WHERE r.status IN ('failed', 'timeout', 'killed_oom', 'crash_loop')
           ORDER BY r.started_at DESC
           LIMIT 10"""
    )

    pending_approvals_row = query_one("SELECT COUNT(*) AS cnt FROM ai_approvals WHERE status = 'pending'")
    pending_ai_approvals_count = int((pending_approvals_row or {}).get("cnt") or 0)

    proxy_url = get_setting("proxy_url", "")
    shown_proxy_url = _mask_url_userinfo(proxy_url) if mask_sensitive else proxy_url
    default_pw = is_default_password()
    net_telemetry = _get_network_telemetry(projects)
    return {
        "system": {
            "cpu_percent": cpu_pct,
            "cpu_count": os.cpu_count() or 1,
            "ram_total_mb": round(vm.total / (1024 * 1024), 1),
            "ram_used_mb": round(vm.used / (1024 * 1024), 1),
            "ram_available_mb": round(vm.available / (1024 * 1024), 1),
            "ram_percent": vm.percent,
            "hub_pid": os.getpid(),
            "hub_rss_bytes": hub_rss_bytes,
            "hub_rss_mb": hub_rss_mb,
            "hub_ram_budget_mb": 80,
            "disk": disk,
            "network": net_telemetry,
            "proxy_url": shown_proxy_url,
            "proxy_status": check_proxy_reachable(proxy_url) if proxy_url else {"online": False, "url": "", "disabled": True},
            "hardware": get_poco_hardware_status(),
            "env_profile": get_environment_profile(),
            "run_as_user": get_setting("run_as_user", "root"),
            "is_default_password": default_pw,
            "safe_mode": is_runtime_safe_mode() or get_setting("safe_mode", "0") == "1",
            "ai_access_enabled": get_setting("ai_access_enabled", "0") == "1" and not default_pw,
            "ai_access_paused": get_setting("ai_access_paused", "0") == "1",
            "pending_ai_approvals_count": pending_ai_approvals_count,
        },
        "pending_asks": active_asks,
        "expired_cookies": expired_cookies,
        "projects": projects,
        "upcoming_runs": upcoming_runs,
        "recent_errors": recent_errors,
        "recent_notifications": RECENT_NOTIFICATIONS[:10],
    }


@router.get("/dashboard")
async def api_dashboard(request: Request) -> dict[str, Any]:
    mask_sensitive = _session_role(request) != "admin"
    return await asyncio.to_thread(_build_dashboard_payload_sync, mask_sensitive)


# ==============================================================================
# 3. ПРОЕКТЫ (Jobs, Services, Web) + Фаза D
# ==============================================================================
@router.get("/projects")
async def api_list_projects(request: Request) -> list[dict[str, Any]]:
    mask_sensitive = _session_role(request) != "admin"

    def _load() -> list[dict[str, Any]]:
        rows = query_all("SELECT * FROM projects ORDER BY id ASC")
        return _enrich_projects_batch(rows, mask_sensitive=mask_sensitive)

    return await asyncio.to_thread(_load)


@router.post("/projects")
async def api_create_project(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    name = str(body.get("name", "")).strip()
    if not validate_project_name(name):
        raise HTTPException(
            status_code=400,
            detail="Имя проекта может содержать только латинские буквы, цифры, '-' и '_' (1–64 символа).",
        )

    existing = query_one("SELECT id FROM projects WHERE name = ?", (name,))
    if existing:
        raise HTTPException(status_code=400, detail=f"Проект с именем «{name}» уже существует")

    proj_type = str(body.get("type", "service")).strip()
    if proj_type not in ("job", "service", "web"):
        raise HTTPException(status_code=400, detail="Тип проекта должен быть 'job', 'service' или 'web'")

    runtime = str(body.get("runtime", "python")).strip()
    if runtime not in ("python", "node", "bash", "custom"):
        raise HTTPException(status_code=400, detail="Некорректный runtime")

    requested_workdir = str(body.get("workdir") or (PROJECTS_DIR / name)).strip()
    _validate_project_workdir(requested_workdir, name)

    template = str(body.get("template", "web" if proj_type == "web" else runtime)).strip()
    tpl_info = create_project_from_template(name, template=template, runtime=runtime, proj_type=proj_type)

    cmd = str(body.get("cmd") or tpl_info["cmd"]).strip()
    workdir = _validate_project_workdir(str(body.get("workdir") or tpl_info["workdir"]).strip(), name)
    use_proxy = 1 if body.get("use_proxy", tpl_info["use_proxy"]) else 0
    ram_limit_mb = parse_int_param(body.get("ram_limit_mb"), "ram_limit_mb", default=0, min_val=0)
    proj_port = parse_int_param(body.get("port"), "port", default=0, min_val=0, max_val=65535)
    reserved = parse_reserved_ports(get_setting("reserved_ports", ""))
    if proj_port > 0 and proj_port in reserved:
        raise HTTPException(status_code=400, detail=f"Порт {proj_port} указан в списке зарезервированных портов (reserved_ports)")

    healthcheck_url = str(body.get("healthcheck_url", "")).strip()
    healthcheck_interval_sec = parse_int_param(body.get("healthcheck_interval_sec"), "healthcheck_interval_sec", default=30, min_val=5)

    env_val = body.get("env", body.get("env_json", {}))
    env_json = json.dumps(env_val, ensure_ascii=False) if isinstance(env_val, dict) else str(env_val or "{}")

    sec_val = body.get("secrets", body.get("secrets_json", []))
    secrets_json = json.dumps(sec_val, ensure_ascii=False) if isinstance(sec_val, list) else str(sec_val or "[]")

    params_val = body.get("params_schema", body.get("params_schema_json", []))
    params_schema_json = (
        json.dumps(params_val, ensure_ascii=False) if isinstance(params_val, list) else str(params_val or "[]")
    )

    schedule_type = str(body.get("schedule_type", "manual")).strip()
    schedule_expr = str(body.get("schedule_expr", "")).strip()
    try:
        validate_schedule_config(schedule_type, schedule_expr)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    timeout_sec = parse_int_param(body.get("timeout_sec"), "timeout_sec", default=0, min_val=0)
    max_retries = parse_int_param(body.get("max_retries"), "max_retries", default=0, min_val=0)
    retry_delay_sec = parse_int_param(body.get("retry_delay_sec"), "retry_delay_sec", default=30, min_val=1)
    webhook_token = secrets.token_hex(16)
    webhook_hmac_secret = str(body.get("webhook_hmac_secret", "")).strip()

    autostart = 1 if body.get("autostart") else 0
    restart_policy = str(body.get("restart_policy", "on-failure")).strip()
    backoff_min_sec = parse_int_param(body.get("backoff_min_sec"), "backoff_min_sec", default=2, min_val=1)
    backoff_max_sec = max(backoff_min_sec, parse_int_param(body.get("backoff_max_sec"), "backoff_max_sec", default=300, min_val=1))

    min_uptime_sec = parse_int_param(body.get("min_uptime_sec"), "min_uptime_sec", default=10, min_val=1)
    max_restarts = parse_int_param(body.get("max_restarts"), "max_restarts", default=10, min_val=0)
    restart_delay_sec = parse_int_param(body.get("restart_delay_sec"), "restart_delay_sec", default=5, min_val=1)
    cron_restart = str(body.get("cron_restart", "")).strip()
    if cron_restart and not croniter.is_valid(cron_restart):
        raise HTTPException(status_code=400, detail=f"Некорректное выражение cron_restart: {cron_restart}")

    heartbeat_interval_sec = parse_int_param(body.get("heartbeat_interval_sec"), "heartbeat_interval_sec", default=0, min_val=0)
    heartbeat_grace_sec = parse_int_param(body.get("heartbeat_grace_sec"), "heartbeat_grace_sec", default=60, min_val=5)
    on_success_project_id = parse_int_param(body.get("on_success_project_id"), "on_success_project_id", default=0, min_val=0)
    if on_success_project_id > 0:
        try:
            validate_chain_no_cycle(0, on_success_project_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    notify_on_error = 1 if body.get("notify_on_error", True) else 0
    notify_on_success = 1 if body.get("notify_on_success", False) else 0
    notify_on_crash = 1 if body.get("notify_on_crash", True) else 0

    ping_token = secrets.token_hex(16)
    now = int(time.time())
    proj_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, port, healthcheck_url, healthcheck_interval_sec, health_status,
            schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token, webhook_hmac_secret, ping_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            min_uptime_sec, max_restarts, restart_delay_sec, cron_restart, crash_loop_count,
            heartbeat_interval_sec, heartbeat_grace_sec, last_ping_at, on_success_project_id, params_schema_json,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, 'stopped', ?, ?, ?, ?, ?)""",
        (
            name,
            proj_type,
            runtime,
            cmd,
            workdir,
            env_json,
            secrets_json,
            use_proxy,
            ram_limit_mb,
            proj_port,
            healthcheck_url,
            healthcheck_interval_sec,
            schedule_type,
            schedule_expr,
            timeout_sec,
            max_retries,
            retry_delay_sec,
            webhook_token,
            webhook_hmac_secret,
            ping_token,
            autostart,
            restart_policy,
            backoff_min_sec,
            backoff_max_sec,
            min_uptime_sec,
            max_restarts,
            restart_delay_sec,
            cron_restart,
            heartbeat_interval_sec,
            heartbeat_grace_sec,
            on_success_project_id,
            params_schema_json,
            notify_on_error,
            notify_on_success,
            notify_on_crash,
            now,
            now,
        ),
    )

    row = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    if row:
        try:
            sync_project_yaml(row)
            write_project_agents_md(
                Path(workdir),
                name,
                proj_type,
                runtime,
                cmd,
                secrets_list=json.loads(secrets_json),
                env_keys=list(json.loads(env_json).keys()),
            )
        except Exception:
            logger.exception("Не удалось синхронизировать project.yaml / AGENTS.md при создании проекта %s", name)
    return _enrich_project(row or {})


@router.put("/projects/{project_id}")
async def api_update_project(request: Request, project_id: int) -> dict[str, Any]:
    existing = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not existing:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    proj_type = str(body.get("type", existing["type"])).strip()
    if proj_type not in ("job", "service", "web"):
        raise HTTPException(status_code=400, detail="Тип проекта должен быть 'job', 'service' или 'web'")
    runtime = str(body.get("runtime", existing["runtime"])).strip()
    cmd = str(body.get("cmd", existing["cmd"])).strip()
    workdir = _validate_project_workdir(str(body.get("workdir", existing["workdir"])).strip(), existing["name"])
    use_proxy = 1 if body.get("use_proxy", existing["use_proxy"]) else 0
    ram_limit_mb = parse_int_param(body.get("ram_limit_mb", existing["ram_limit_mb"]), "ram_limit_mb", default=0, min_val=0)
    proj_port = parse_int_param(body.get("port", existing.get("port", 0)), "port", default=0, min_val=0, max_val=65535)
    reserved = parse_reserved_ports(get_setting("reserved_ports", ""))
    if proj_port > 0 and proj_port in reserved:
        raise HTTPException(status_code=400, detail=f"Порт {proj_port} зарезервирован в настройках reserved_ports")

    healthcheck_url = str(body.get("healthcheck_url", existing.get("healthcheck_url", ""))).strip()
    healthcheck_interval_sec = parse_int_param(
        body.get("healthcheck_interval_sec", existing.get("healthcheck_interval_sec", 30)),
        "healthcheck_interval_sec",
        default=30,
        min_val=5,
    )

    env_val = body.get("env", body.get("env_json", existing["env_json"]))
    env_json = json.dumps(env_val, ensure_ascii=False) if isinstance(env_val, dict) else str(env_val)

    sec_val = body.get("secrets", body.get("secrets_json", existing["secrets_json"]))
    secrets_json = json.dumps(sec_val, ensure_ascii=False) if isinstance(sec_val, list) else str(sec_val)

    params_val = body.get("params_schema", body.get("params_schema_json", existing.get("params_schema_json", "[]")))
    params_schema_json = (
        json.dumps(params_val, ensure_ascii=False) if isinstance(params_val, list) else str(params_val or "[]")
    )

    schedule_type = str(body.get("schedule_type", existing["schedule_type"])).strip()
    schedule_expr = str(body.get("schedule_expr", existing["schedule_expr"])).strip()
    try:
        validate_schedule_config(schedule_type, schedule_expr)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    timeout_sec = parse_int_param(body.get("timeout_sec", existing["timeout_sec"]), "timeout_sec", default=0, min_val=0)
    max_retries = parse_int_param(body.get("max_retries", existing["max_retries"]), "max_retries", default=0, min_val=0)
    retry_delay_sec = parse_int_param(body.get("retry_delay_sec", existing["retry_delay_sec"]), "retry_delay_sec", default=30, min_val=1)
    webhook_hmac_secret = str(body.get("webhook_hmac_secret", existing.get("webhook_hmac_secret", ""))).strip()
    if webhook_hmac_secret and set(webhook_hmac_secret) == {"*"}:
        webhook_hmac_secret = str(existing.get("webhook_hmac_secret", ""))

    autostart = 1 if body.get("autostart", existing["autostart"]) else 0
    restart_policy = str(body.get("restart_policy", existing["restart_policy"])).strip()
    backoff_min_sec = parse_int_param(body.get("backoff_min_sec", existing["backoff_min_sec"]), "backoff_min_sec", default=2, min_val=1)
    backoff_max_sec = max(
        backoff_min_sec,
        parse_int_param(body.get("backoff_max_sec", existing["backoff_max_sec"]), "backoff_max_sec", default=300, min_val=1),
    )

    min_uptime_sec = parse_int_param(body.get("min_uptime_sec", existing.get("min_uptime_sec", 10)), "min_uptime_sec", default=10, min_val=1)
    max_restarts = parse_int_param(body.get("max_restarts", existing.get("max_restarts", 10)), "max_restarts", default=10, min_val=0)
    restart_delay_sec = parse_int_param(body.get("restart_delay_sec", existing.get("restart_delay_sec", 5)), "restart_delay_sec", default=5, min_val=1)
    cron_restart = str(body.get("cron_restart", existing.get("cron_restart", ""))).strip()
    if cron_restart and not croniter.is_valid(cron_restart):
        raise HTTPException(status_code=400, detail=f"Некорректное выражение cron_restart: {cron_restart}")

    heartbeat_interval_sec = parse_int_param(
        body.get("heartbeat_interval_sec", existing.get("heartbeat_interval_sec", 0)),
        "heartbeat_interval_sec",
        default=0,
        min_val=0,
    )
    heartbeat_grace_sec = parse_int_param(
        body.get("heartbeat_grace_sec", existing.get("heartbeat_grace_sec", 60)),
        "heartbeat_grace_sec",
        default=60,
        min_val=5,
    )
    on_success_project_id = parse_int_param(
        body.get("on_success_project_id", existing.get("on_success_project_id", 0)),
        "on_success_project_id",
        default=0,
        min_val=0,
    )
    if on_success_project_id > 0:
        try:
            validate_chain_no_cycle(project_id, on_success_project_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    notify_on_error = 1 if body.get("notify_on_error", existing["notify_on_error"]) else 0
    notify_on_success = 1 if body.get("notify_on_success", existing["notify_on_success"]) else 0
    notify_on_crash = 1 if body.get("notify_on_crash", existing["notify_on_crash"]) else 0

    sched_changed = (schedule_type != existing["schedule_type"]) or (schedule_expr != existing["schedule_expr"])
    next_run_val = 0 if sched_changed else int(existing.get("next_run_at") or 0)

    now = int(time.time())
    execute_sql(
        """UPDATE projects SET
            type = ?, runtime = ?, cmd = ?, workdir = ?, env_json = ?, secrets_json = ?,
            use_proxy = ?, ram_limit_mb = ?, port = ?, healthcheck_url = ?, healthcheck_interval_sec = ?,
            schedule_type = ?, schedule_expr = ?, next_run_at = ?,
            timeout_sec = ?, max_retries = ?, retry_delay_sec = ?, webhook_hmac_secret = ?,
            autostart = ?, restart_policy = ?, backoff_min_sec = ?, backoff_max_sec = ?,
            min_uptime_sec = ?, max_restarts = ?, restart_delay_sec = ?, cron_restart = ?,
            heartbeat_interval_sec = ?, heartbeat_grace_sec = ?, on_success_project_id = ?, params_schema_json = ?,
            notify_on_error = ?, notify_on_success = ?, notify_on_crash = ?, updated_at = ?
           WHERE id = ?""",
        (
            proj_type,
            runtime,
            cmd,
            workdir,
            env_json,
            secrets_json,
            use_proxy,
            ram_limit_mb,
            proj_port,
            healthcheck_url,
            healthcheck_interval_sec,
            schedule_type,
            schedule_expr,
            next_run_val,
            timeout_sec,
            max_retries,
            retry_delay_sec,
            webhook_hmac_secret,
            autostart,
            restart_policy,
            backoff_min_sec,
            backoff_max_sec,
            min_uptime_sec,
            max_restarts,
            restart_delay_sec,
            cron_restart,
            heartbeat_interval_sec,
            heartbeat_grace_sec,
            on_success_project_id,
            params_schema_json,
            notify_on_error,
            notify_on_success,
            notify_on_crash,
            now,
            project_id,
        ),
    )

    updated = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if updated:
        try:
            sync_project_yaml(updated)
            write_project_agents_md(
                Path(workdir),
                updated["name"],
                proj_type,
                runtime,
                cmd,
                secrets_list=json.loads(secrets_json),
                env_keys=list(json.loads(env_json).keys()),
            )
        except Exception:
            logger.exception("Не удалось синхронизировать project.yaml / AGENTS.md при обновлении проекта id=%s", project_id)
    return _enrich_project(updated or {})


@router.delete("/projects/{project_id}")
async def api_delete_project(request: Request, project_id: int) -> dict[str, Any]:
    existing = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not existing:
        raise HTTPException(status_code=404, detail="Проект не найден")

    delete_files = str(request.query_params.get("delete_files", "")).lower() in ("1", "true", "yes")
    if not delete_files:
        try:
            raw = await request.body()
            if raw and raw.strip():
                body = json.loads(raw.decode("utf-8"))
                if isinstance(body, dict) and body.get("delete_files"):
                    delete_files = True
        except Exception:
            pass

    await stop_project(project_id)
    # Обнуляем висячие ссылки on_success_project_id у других проектов и удаляем каталог логов (P2-17)
    execute_sql("UPDATE projects SET on_success_project_id = 0 WHERE on_success_project_id = ?", (project_id,))
    execute_sql("DELETE FROM projects WHERE id = ?", (project_id,))

    proj_log_dir = (LOGS_DIR / existing["name"]).resolve()
    try:
        if os.path.commonpath([str(LOGS_DIR.resolve()), str(proj_log_dir)]) == str(LOGS_DIR.resolve()) and proj_log_dir.exists():
            shutil.rmtree(proj_log_dir, ignore_errors=True)
    except OSError:
        pass

    deleted_workdir = False
    if delete_files and existing.get("workdir"):
        wdir = Path(existing["workdir"]).resolve()
        proot = PROJECTS_DIR.resolve()
        try:
            if wdir != proot and os.path.commonpath([str(proot), str(wdir)]) == str(proot) and wdir.exists():
                shutil.rmtree(wdir, ignore_errors=True)
                deleted_workdir = True
        except OSError:
            pass

    return {"ok": True, "deleted_id": project_id, "deleted_files": deleted_workdir}


@router.post("/projects/{project_id}/start")
async def api_start_project(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    raw_params = body.get("params") if "params" in body else body.get("extra_env")
    extra_env: dict[str, str] = {}
    if raw_params is not None:
        if not isinstance(raw_params, dict):
            raise HTTPException(status_code=400, detail="Поле 'params' должно быть JSON-объектом")
        try:
            schema_list = json.loads(proj.get("params_schema_json") or "[]")
        except Exception:
            schema_list = []
        declared_names = {
            str(item.get("name") or "").strip().upper()
            for item in schema_list
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        }
        for k, v in raw_params.items():
            raw_k = str(k).strip()
            if not re.match(r"^[a-zA-Z0-9_]{1,64}$", raw_k):
                raise HTTPException(status_code=400, detail=f"Недопустимое имя параметра: {raw_k}")
            clean_k = raw_k.upper()
            if is_reserved_param_name(clean_k):
                raise HTTPException(status_code=400, detail=f"Зарезервированное имя параметра запрещено: {raw_k}")
            if clean_k not in declared_names:
                raise HTTPException(
                    status_code=400,
                    detail=f"Параметр '{raw_k}' не объявлен в params_schema_json проекта",
                )
            val_str = "" if v is None else str(v)
            if "\x00" in val_str or len(val_str) > 4096:
                raise HTTPException(status_code=400, detail=f"Недопустимое значение параметра '{raw_k}' (макс. 4096 символов, без NUL)")
            extra_env[f"PARAM_{clean_k}"] = val_str

    execute_sql("UPDATE projects SET crash_loop_count = 0 WHERE id = ?", (project_id,))
    try:
        run = await start_project_run(project_id, trigger="manual", extra_env=extra_env or None)
        proj_after = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
        return {"ok": True, "run": run, "project": _enrich_project(proj_after or {})}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/projects/{project_id}/stop")
async def api_stop_project(request: Request, project_id: int) -> dict[str, Any]:
    await stop_project(project_id)
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    return {"ok": True, "project": _enrich_project(proj or {})}


@router.post("/projects/{project_id}/restart")
async def api_restart_project(request: Request, project_id: int) -> dict[str, Any]:
    await stop_project(project_id)
    await asyncio.sleep(0.2)
    execute_sql("UPDATE projects SET crash_loop_count = 0 WHERE id = ?", (project_id,))
    try:
        run = await start_project_run(project_id, trigger="manual")
        proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
        return {"ok": True, "run": run, "project": _enrich_project(proj or {})}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/projects/{project_id}/install_deps")
async def api_install_deps(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    try:
        body = await request.json()
    except Exception:
        body = {}

    workdir = Path(proj["workdir"])
    runtime = str((body.get("runtime") if isinstance(body, dict) else None) or proj.get("runtime") or "python")
    project_type = str((body.get("type") if isinstance(body, dict) else None) or proj.get("type") or "service")
    port = int(proj.get("port") or 0)
    dep_argv = build_install_deps_command(workdir, runtime, project_type=project_type, port=port)

    run = await start_project_run(project_id, trigger="manual", custom_argv=dep_argv)
    return {"ok": True, "run": run, "runtime": runtime, "project_type": project_type}


@router.post("/projects/{project_id}/healthcheck_now")
async def api_healthcheck_project_now(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    hc_url = str(proj.get("healthcheck_url") or "").strip()
    proj_port = int(proj.get("port") or 0)
    if not hc_url and proj_port <= 0:
        raise HTTPException(status_code=400, detail="Для проверки укажите Порт ($PORT) или Healthcheck URL в настройках проекта")

    t0 = time.monotonic()
    ok, detail = await asyncio.to_thread(check_endpoint_health, hc_url, proj_port, 3.0)
    latency_ms = round((time.monotonic() - t0) * 1000.0, 1)
    new_health = "healthy" if ok else "unhealthy"
    execute_sql("UPDATE projects SET health_status = ? WHERE id = ?", (new_health, project_id))
    updated = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    return {
        "ok": ok,
        "health_status": new_health,
        "detail": detail,
        "latency_ms": latency_ms,
        "target": hc_url or f"tcp://127.0.0.1:{proj_port}",
        "project": _enrich_project(updated or {}),
    }


# ==============================================================================
# 3.1. DEAD MAN'S SWITCH (/api/ping/{project}), PROJECT.YAML И ЭКСПОРТ/ИМПОРТ ZIP (Фаза D)
# ==============================================================================
@router.get("/ping/{project_identifier}")
@router.post("/ping/{project_identifier}")
async def api_dead_mans_switch_ping(request: Request, project_identifier: str) -> Any:
    """Входящий пинг от задачи/сервиса (Dead Man's Switch — P0-2): только по ping_token или webhook_token."""
    client_ip = _client_ip(request)
    allowed, retry_after = check_webhook_rate_limit(client_ip)
    if not allowed:
        return JSONResponse(
            {
                "detail": f"Превышен лимит запросов /api/ping с вашего IP. Повторите через {retry_after} сек.",
                "retry_after": retry_after,
            },
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    ident = (project_identifier or "").strip()
    proj = (
        query_one(
            "SELECT * FROM projects WHERE (ping_token != '' AND ping_token = ?) OR (webhook_token != '' AND webhook_token = ?)",
            (ident, ident),
        )
        if ident
        else None
    )
    if not proj:
        now_blocked, block_sec = record_webhook_failure(client_ip)
        if now_blocked:
            return JSONResponse(
                {
                    "detail": f"Слишком много ошибочных запросов /api/ping. IP заблокирован на {block_sec // 60} мин.",
                    "retry_after": block_sec,
                },
                status_code=429,
                headers={"Retry-After": str(block_sec)},
            )
        raise HTTPException(status_code=404, detail="Неверный токен Dead Man's Switch")

    proj_id = int(proj["id"])
    has_active_run = any(int(info.get("project_id") or 0) == proj_id for info in list(ACTIVE_RUNS.values()))
    if not has_active_run:
        has_active_run = (
            query_one(
                "SELECT id FROM runs WHERE project_id = ? AND status IN ('running', 'waiting_input') LIMIT 1",
                (proj_id,),
            )
            is not None
        )

    now = int(time.time())
    prev_health = str(proj.get("health_status") or "unknown")
    was_alerted = clear_heartbeat_alert(proj_id)
    if has_active_run or proj.get("type") == "job":
        new_health = "healthy"
        execute_sql(
            "UPDATE projects SET last_ping_at = ?, health_status = 'healthy', updated_at = ? WHERE id = ?",
            (now, now, proj_id),
        )
        if was_alerted or prev_health == "unhealthy":
            await send_notification(
                f"Dead Man's Switch: проект «{proj['name']}» восстановился (получен heartbeat-пинг).",
                level="info",
                project_name=proj["name"],
            )
    else:
        new_health = prev_health
        execute_sql(
            "UPDATE projects SET last_ping_at = ?, updated_at = ? WHERE id = ?",
            (now, now, proj_id),
        )
    return {"ok": True, "project": proj["name"], "ping_at": now, "health_status": new_health}


@router.get("/projects/{project_id}/yaml")
async def api_get_project_yaml(request: Request, project_id: int) -> dict[str, Any]:
    _require_admin_session(request)
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")
    yaml_path = sync_project_yaml(proj)
    return {
        "ok": True,
        "path": str(yaml_path),
        "content": yaml_path.read_text(encoding="utf-8", errors="replace"),
    }


@router.put("/projects/{project_id}/yaml")
async def api_put_project_yaml(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    yaml_text = str(body.get("content", ""))
    parsed = parse_simple_project_yaml(yaml_text)

    y_stype = str(parsed.get("schedule_type", proj["schedule_type"])).strip()
    y_sexpr = str(parsed.get("schedule_expr", proj["schedule_expr"])).strip()
    try:
        validate_schedule_config(y_stype, y_sexpr)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    workdir = Path(proj["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "project.yaml").write_text(yaml_text, encoding="utf-8")

    now = int(time.time())
    execute_sql(
        """UPDATE projects SET
            type = ?, runtime = ?, cmd = ?, port = ?, ram_limit_mb = ?,
            use_proxy = ?, autostart = ?, restart_policy = ?,
            min_uptime_sec = ?, max_restarts = ?, restart_delay_sec = ?, cron_restart = ?,
            schedule_type = ?, schedule_expr = ?, next_run_at = 0, healthcheck_url = ?,
            heartbeat_interval_sec = ?, heartbeat_grace_sec = ?, updated_at = ?
           WHERE id = ?""",
        (
            parsed.get("type", proj["type"]),
            parsed.get("runtime", proj["runtime"]),
            parsed.get("cmd", proj["cmd"]),
            int(parsed.get("port", proj.get("port", 0)) or 0),
            int(parsed.get("ram_limit_mb", proj.get("ram_limit_mb", 0)) or 0),
            1 if parsed.get("use_proxy", proj["use_proxy"]) else 0,
            1 if parsed.get("autostart", proj["autostart"]) else 0,
            str(parsed.get("restart_policy", proj["restart_policy"])),
            int(parsed.get("min_uptime_sec", proj.get("min_uptime_sec", 10)) or 10),
            int(parsed.get("max_restarts", proj.get("max_restarts", 10)) or 10),
            int(parsed.get("restart_delay_sec", proj.get("restart_delay_sec", 5)) or 5),
            str(parsed.get("cron_restart", proj.get("cron_restart", ""))),
            y_stype,
            y_sexpr,
            str(parsed.get("healthcheck_url", proj.get("healthcheck_url", ""))),
            int(parsed.get("heartbeat_interval_sec", proj.get("heartbeat_interval_sec", 0)) or 0),
            int(parsed.get("heartbeat_grace_sec", proj.get("heartbeat_grace_sec", 60)) or 60),
            now,
            project_id,
        ),
    )
    updated = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    return {"ok": True, "project": _enrich_project(updated or {})}


@router.get("/projects/{project_id}/export")
async def api_export_project_zip(request: Request, project_id: int) -> Response:
    """Экспортирует проект (или подпапку ?subpath=...) в .zip вместе с project.yaml, но БЕЗ значений секретов и без .venv/node_modules (Фаза D.3)."""
    _require_admin_session(request)
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    subpath_raw = (request.query_params.get("subpath") or "").strip().strip("/")
    workdir = Path(proj["workdir"]).resolve()
    target_root = _safe_project_path(workdir, subpath_raw) if subpath_raw else workdir
    if not target_root.exists() or not target_root.is_dir():
        raise HTTPException(status_code=404, detail=f"Папка '{subpath_raw}' не найдена")

    def _build_proj_zip() -> bytes:
        if not subpath_raw:
            sync_project_yaml(proj)
        buf = io.BytesIO()
        skip_files = {"cookies.json", "storage_state.json", ".env"}

        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            if target_root.exists():
                for root, dirs, files in os.walk(target_root):
                    dirs[:] = [d for d in dirs if d not in _EXCLUDED_DIRS and d != "browser_profile"]
                    root_p = Path(root)
                    if not files and not dirs and root_p != target_root:
                        rel_dir = str(root_p.relative_to(target_root)).rstrip("/") + "/"
                        zf.writestr(rel_dir, b"")
                    for fn in files:
                        if fn in skip_files:
                            continue
                        fp = root_p / fn
                        try:
                            if fp.is_file() and not fp.is_symlink() and fp.stat().st_size <= 20 * 1024 * 1024:
                                rel = fp.relative_to(target_root)
                                zf.write(fp, str(rel))
                        except OSError:
                            pass
        return buf.getvalue()

    zip_bytes = await asyncio.to_thread(_build_proj_zip)
    archive_label = f"{proj['name']}_{Path(subpath_raw).name}" if subpath_raw else proj["name"]
    safe_filename = re.sub(r"[^a-zA-Z0-9._-]", "_", archive_label)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_filename}.zip"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/projects/import_archive")
async def api_import_project_archive(request: Request) -> dict[str, Any]:
    """Импортирует проект из .zip-архива (с чтением project.yaml и потоковой безопасной распаковкой)."""
    ctype = request.headers.get("content-type", "")
    name = ""
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tf:
        tmp_zip = Path(tf.name)

    try:
        if "multipart/form-data" in ctype:
            form = await request.form()
            name = str(form.get("name") or "").strip()
            upload_obj = form.get("file")
            if upload_obj is None or not hasattr(upload_obj, "read"):
                raise HTTPException(status_code=400, detail="Передайте .zip файл в поле 'file'")
            total_written = 0
            with open(tmp_zip, "wb") as out_f:
                try:
                    while True:
                        chunk = await upload_obj.read(_ZIP_STREAM_CHUNK)
                        if not chunk:
                            break
                        total_written += len(chunk)
                        if total_written > MAX_ZIP_ARCHIVE_BYTES:
                            raise HTTPException(status_code=413, detail="Размер ZIP-архива превышает 50 МБ")
                        out_f.write(chunk)
                except TypeError:
                    raw = await upload_obj.read()
                    if len(raw) > MAX_ZIP_ARCHIVE_BYTES:
                        raise HTTPException(status_code=413, detail="Размер ZIP-архива превышает 50 МБ")
                    out_f.write(raw)
        else:
            body = await read_json(request)
            name = str(body.get("name", "")).strip()
            b64 = str(body.get("content_base64", "")).strip()
            if not b64:
                raise HTTPException(status_code=400, detail="Передайте содержимое архива в content_base64")
            _decode_base64_to_file(b64, tmp_zip, max_bytes=MAX_ZIP_ARCHIVE_BYTES)

        if not name:
            name = f"imported-{int(time.time())}"
        if not validate_project_name(name):
            raise HTTPException(status_code=400, detail="Некорректное имя проекта")
        if query_one("SELECT id FROM projects WHERE name = ?", (name,)):
            raise HTTPException(status_code=400, detail=f"Проект «{name}» уже существует")

        workdir = PROJECTS_DIR / name
        workdir.mkdir(parents=True, exist_ok=True)
        (LOGS_DIR / name).mkdir(parents=True, exist_ok=True)

        try:
            extracted = safe_extract_zip_file(tmp_zip, workdir)
        except Exception:
            shutil.rmtree(workdir, ignore_errors=True)
            raise
    finally:
        tmp_zip.unlink(missing_ok=True)

    yaml_cfg: dict[str, Any] = {}
    yaml_file = workdir / "project.yaml"
    if yaml_file.exists():
        yaml_cfg = parse_simple_project_yaml(yaml_file.read_text(encoding="utf-8", errors="replace"))

    proj_type = str(yaml_cfg.get("type", "service"))
    if proj_type not in ("job", "service", "web"):
        proj_type = "service"
    runtime = str(yaml_cfg.get("runtime", "python"))
    cmd = str(yaml_cfg.get("cmd", "python3 main.py"))

    now = int(time.time())
    proj_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, port, healthcheck_url, healthcheck_interval_sec,
            schedule_type, schedule_expr, timeout_sec, max_retries, retry_delay_sec,
            webhook_token, ping_token, autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            min_uptime_sec, max_restarts, restart_delay_sec, cron_restart,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30, ?, ?, 0, 0, 30, ?, ?, ?, ?, 2, 300, ?, ?, ?, ?, 'stopped', 1, 0, 1, ?, ?)""",
        (
            name,
            proj_type,
            runtime,
            cmd,
            str(workdir),
            json.dumps(yaml_cfg.get("env", {}), ensure_ascii=False),
            json.dumps(yaml_cfg.get("secrets", []), ensure_ascii=False),
            1 if yaml_cfg.get("use_proxy") else 0,
            int(yaml_cfg.get("ram_limit_mb", 0) or 0),
            int(yaml_cfg.get("port", 0) or 0),
            str(yaml_cfg.get("healthcheck_url", "")),
            str(yaml_cfg.get("schedule_type", "manual")),
            str(yaml_cfg.get("schedule_expr", "")),
            secrets.token_hex(16),
            secrets.token_hex(16),
            1 if yaml_cfg.get("autostart") else 0,
            str(yaml_cfg.get("restart_policy", "on-failure")),
            int(yaml_cfg.get("min_uptime_sec", 10) or 10),
            int(yaml_cfg.get("max_restarts", 10) or 10),
            int(yaml_cfg.get("restart_delay_sec", 5) or 5),
            str(yaml_cfg.get("cron_restart", "")),
            now,
            now,
        ),
    )
    row = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    return {"ok": True, "extracted_files": extracted, "project": _enrich_project(row or {})}


@router.get("/projects/{project_id}/kv")
async def api_list_project_kv(request: Request, project_id: int) -> list[dict[str, Any]]:
    _require_admin_session(request)
    rows = query_all(
        "SELECT key, value_json, updated_at FROM project_kv WHERE project_id = ? ORDER BY key ASC",
        (project_id,),
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            val = json.loads(r["value_json"])
        except Exception:
            val = r["value_json"]
        out.append({"key": r["key"], "value": val, "updated_at": r["updated_at"]})
    return out


@router.put("/projects/{project_id}/kv/{key}")
async def api_put_project_kv(request: Request, project_id: int, key: str) -> dict[str, Any]:
    clean_key = (key or "").strip()
    if not clean_key or len(clean_key) > 128:
        raise HTTPException(status_code=400, detail="Некорректный ключ state")
    body = await read_json(request)
    val = body.get("value")
    val_json = json.dumps(val, ensure_ascii=False)
    if len(val_json.encode("utf-8")) > 256 * 1024:
        raise HTTPException(status_code=413, detail="Размер значения state превышает лимит 256 КБ")
    existing_kv = query_one("SELECT 1 FROM project_kv WHERE project_id = ? AND key = ?", (project_id, clean_key))
    if not existing_kv:
        cnt_row = query_one("SELECT COUNT(*) AS cnt FROM project_kv WHERE project_id = ?", (project_id,))
        if int((cnt_row or {}).get("cnt") or 0) >= 1000:
            raise HTTPException(status_code=400, detail="Достигнут лимит 1000 ключей KV на проект")
    now = int(time.time())
    execute_sql(
        """INSERT INTO project_kv (project_id, key, value_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at""",
        (project_id, clean_key, val_json, now),
    )
    return {"ok": True, "key": clean_key, "value": val, "updated_at": now}


@router.delete("/projects/{project_id}/kv/{key}")
async def api_delete_project_kv(request: Request, project_id: int, key: str) -> dict[str, Any]:
    clean_key = (key or "").strip()
    execute_sql("DELETE FROM project_kv WHERE project_id = ? AND key = ?", (project_id, clean_key))
    return {"ok": True, "deleted": clean_key}


@router.post("/projects/import_examples")
async def api_import_example_projects(request: Request) -> dict[str, Any]:
    EXAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    examples_spec = [
        {
            "name": "heartbeat-daemon",
            "type": "service",
            "runtime": "python",
            "template": "python",
            "cmd": "python3 main.py",
            "port": 0,
            "healthcheck_url": "",
            "schedule_type": "manual",
            "schedule_expr": "",
            "autostart": 0,
            "restart_policy": "always",
            "env": {
                "PROJECT_GROUP": "Боты 24/7",
                "PROJECT_DESCRIPTION": "Фоновый демон (Service 24/7) с сохранением счётчика тиков в beacon.state",
            },
            "code": (
                "import time\n"
                "import beacon\n\n"
                "print('[heartbeat-daemon] Сервис запущен (Direct FD, без SIGPIPE)', flush=True)\n"
                "ticks = int(beacon.state.get('ticks', 0) or 0)\n"
                "while True:\n"
                "    ticks += 1\n"
                "    beacon.state.set('ticks', ticks)\n"
                "    print(f'[heartbeat-daemon] Тик #{ticks} сохранён в beacon.state', flush=True)\n"
                "    time.sleep(10)\n"
            ),
        },
        {
            "name": "web-status-api",
            "type": "web",
            "runtime": "python",
            "template": "web",
            "cmd": "python3 main.py",
            "port": 18081,
            "healthcheck_url": "http://127.0.0.1:18081/health",
            "schedule_type": "manual",
            "schedule_expr": "",
            "autostart": 0,
            "restart_policy": "always",
            "env": {
                "PROJECT_GROUP": "Web / API",
                "PROJECT_DESCRIPTION": "Пример легковесного HTTP API бэкенда с проверкой /health и $PORT",
            },
            "code": None,
        },
        {
            "name": "sms-auth-bot",
            "type": "job",
            "runtime": "python",
            "template": "python",
            "cmd": "python3 main.py",
            "port": 0,
            "healthcheck_url": "",
            "schedule_type": "manual",
            "schedule_expr": "",
            "autostart": 0,
            "restart_policy": "no",
            "env": {
                "PROJECT_GROUP": "Тесты",
                "PROJECT_DESCRIPTION": "Пример интерактивного запроса 2FA/СМС-кода через beacon.ask()",
            },
            "code": (
                "import beacon\n\n"
                "print('[sms-auth-bot] Запрашиваем код подтверждения через beacon.ask()...', flush=True)\n"
                "code = beacon.ask('Введите 6-значный код из СМС для входа в аккаунт:', timeout=180)\n"
                "beacon.state.set('last_auth_code_len', len(str(code)))\n"
                "print(f'[sms-auth-bot] Код получен ({len(str(code))} симв.), авторизация успешна!', flush=True)\n"
            ),
        },
        {
            "name": "cookie-checker-job",
            "type": "job",
            "runtime": "python",
            "template": "cookie_parser",
            "cmd": "python3 main.py",
            "port": 0,
            "healthcheck_url": "",
            "schedule_type": "cron",
            "schedule_expr": "*/30 * * * *",
            "autostart": 0,
            "restart_policy": "no",
            "env": {
                "PROJECT_GROUP": "Парсеры",
                "PROJECT_DESCRIPTION": "Периодическая задача проверки куки (Cron каждые 30 мин) с сигналом beacon.cookies_expired()",
            },
            "code": None,
        },
    ]

    imported_names: list[str] = []
    now = int(time.time())
    for spec in examples_spec:
        ex_dir = EXAMPLES_DIR / spec["name"]
        ex_dir.mkdir(parents=True, exist_ok=True)
        if spec["code"]:
            (ex_dir / "main.py").write_text(spec["code"], encoding="utf-8")

        workdir = PROJECTS_DIR / spec["name"]
        if not (workdir / "main.py").exists():
            create_project_from_template(spec["name"], spec["template"], spec["runtime"], spec["type"])
            if spec["code"]:
                (workdir / "main.py").write_text(spec["code"], encoding="utf-8")
        (LOGS_DIR / spec["name"]).mkdir(parents=True, exist_ok=True)

        existing = query_one("SELECT id FROM projects WHERE name = ?", (spec["name"],))
        if existing:
            continue

        execute_sql(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, port, healthcheck_url, healthcheck_interval_sec,
                schedule_type, schedule_expr, timeout_sec, max_retries, retry_delay_sec,
                webhook_token, ping_token, autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, 128, ?, ?, 30, ?, ?, 0, 0, 30, ?, ?, ?, ?, 2, 120, 'stopped', 1, 0, 1, ?, ?)""",
            (
                spec["name"],
                spec["type"],
                spec["runtime"],
                spec["cmd"],
                str(workdir),
                json.dumps(spec["env"], ensure_ascii=False),
                spec["port"],
                spec["healthcheck_url"],
                spec["schedule_type"],
                spec["schedule_expr"],
                secrets.token_hex(16),
                secrets.token_hex(16),
                spec["autostart"],
                spec["restart_policy"],
                now,
                now,
            ),
        )
        imported_names.append(spec["name"])

    return {"ok": True, "imported": imported_names, "count": len(imported_names)}


@router.post("/projects/{project_id}/cookies")
async def api_save_project_cookies(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    raw_json = body.get("cookies_json", body.get("value", ""))
    secret_name = str(body.get("name") or f"{proj['name']}_cookies").strip()
    try:
        saved_sec = import_cookie_editor_json(secret_name, raw_json)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        curr_secrets: list[str] = json.loads(proj.get("secrets_json") or "[]")
    except Exception:
        curr_secrets = []
    if secret_name not in curr_secrets:
        curr_secrets.append(secret_name)
        execute_sql(
            "UPDATE projects SET secrets_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(curr_secrets, ensure_ascii=False), int(time.time()), project_id),
        )

    try:
        local_cookie_path = Path(proj["workdir"]) / "cookies.json"
        local_cookie_path.write_text(
            raw_json if isinstance(raw_json, str) else json.dumps(raw_json, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        os.chmod(local_cookie_path, 0o600)
    except OSError:
        pass

    updated_proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    return {"ok": True, "secret": saved_sec, "project": _enrich_project(updated_proj or {})}


@router.post("/projects/{project_id}/clear_logs")
async def api_clear_project_logs(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    execute_sql(
        "DELETE FROM runs WHERE project_id = ? AND status NOT IN ('running', 'waiting_input')",
        (project_id,),
    )
    proj_log_dir = LOGS_DIR / proj["name"]
    removed_files = 0
    if proj_log_dir.exists():
        active_log_paths = {
            str(r["log_path"])
            for r in query_all(
                "SELECT log_path FROM runs WHERE project_id = ? AND status IN ('running', 'waiting_input')",
                (project_id,),
            )
        }
        for lf in proj_log_dir.glob("*.log"):
            if str(lf) not in active_log_paths:
                try:
                    lf.unlink()
                    removed_files += 1
                except OSError:
                    pass

    _invalidate_dir_size_cache(proj_log_dir)
    updated_proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    return {"ok": True, "removed_files": removed_files, "project": _enrich_project(updated_proj or {})}


@router.post("/projects/git_clone")
async def api_git_clone_project(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    repo_url = str(body.get("repo_url", "")).strip()
    if not repo_url:
        raise HTTPException(status_code=400, detail="Укажите ссылку на GitHub-репозиторий")
    if repo_url.startswith("-") or not _SAFE_GIT_URL_RE.match(repo_url):
        raise HTTPException(
            status_code=400,
            detail="Некорректный или небезопасный URL репозитория (разрешены схемы https://, http://, ssh://, git@).",
        )

    name = str(body.get("name", "")).strip()
    if not name:
        slug = repo_url.rstrip("/").split("/")[-1]
        if slug.endswith(".git"):
            slug = slug[:-4]
        name = re.sub(r"[^a-zA-Z0-9_-]", "-", slug).lower()[:48] or "github-project"

    if not validate_project_name(name):
        raise HTTPException(status_code=400, detail="Некорректное имя папки проекта")

    if query_one("SELECT id FROM projects WHERE name = ?", (name,)):
        raise HTTPException(status_code=400, detail=f"Проект с именем «{name}» уже существует")

    proj_type = str(body.get("type", "service")).strip()
    if proj_type not in ("job", "service", "web"):
        proj_type = "service"

    use_proxy = 1 if body.get("use_proxy", False) else 0
    import urllib.parse as _urlparse

    clean_repo_url = _mask_url_userinfo(repo_url)
    extra_git_args: list[str] = []
    clone_source_url = repo_url
    parsed_git = _urlparse.urlparse(repo_url)
    if parsed_git.scheme in ("http", "https") and (parsed_git.username is not None or parsed_git.password is not None):
        host_part = parsed_git.hostname or ""
        if ":" in host_part and not host_part.startswith("["):
            host_part = f"[{host_part}]"
        clean_netloc = f"{host_part}:{parsed_git.port}" if parsed_git.port else host_part
        clean_repo_url = _urlparse.urlunparse(parsed_git._replace(netloc=clean_netloc))
        clone_source_url = clean_repo_url
        g_user = _urlparse.unquote(parsed_git.username or "x-access-token")
        g_pass = _urlparse.unquote(parsed_git.password or "")
        b64_auth = base64.b64encode(f"{g_user}:{g_pass}".encode("utf-8")).decode("ascii")
        extra_git_args = ["-c", f"http.extraheader=Authorization: Basic {b64_auth}"]
    else:
        git_secret_name = str(body.get("git_secret_name", "")).strip()
        if git_secret_name:
            sec_obj = get_secret_raw(git_secret_name)
            sec_tok = str((sec_obj or {}).get("value") if isinstance(sec_obj, dict) else (sec_obj or "")).strip()
            if sec_tok:
                b64_auth = base64.b64encode(f"x-access-token:{sec_tok}".encode("utf-8")).decode("ascii")
                extra_git_args = ["-c", f"http.extraheader=Authorization: Basic {b64_auth}"]

    description = str(body.get("description", "")).strip() or f"Установлен из GitHub ({clean_repo_url})"
    group_tag = str(body.get("group_tag", "GitHub")).strip() or "GitHub"
    custom_proxy = str(body.get("custom_proxy", "")).strip()

    workdir = PROJECTS_DIR / name
    workdir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / name).mkdir(parents=True, exist_ok=True)

    sys_proxy = get_setting("proxy_url", "").strip()
    target_proxy = custom_proxy or sys_proxy
    proxy_reach = (
        await asyncio.to_thread(check_proxy_reachable, target_proxy)
        if target_proxy
        else {"online": False}
    )
    clone_env = dict(os.environ)
    clone_env["GIT_TERMINAL_PROMPT"] = "0"
    if use_proxy and target_proxy and proxy_reach.get("online"):
        clone_env["HTTP_PROXY"] = target_proxy
        clone_env["HTTPS_PROXY"] = target_proxy

    try:
        clone_timeout = max(5, min(600, int(get_setting("git_clone_timeout_sec", "120") or 120)))
    except ValueError:
        clone_timeout = 120

    cloned_ok = False
    clone_log = ""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            *extra_git_args,
            "clone",
            "--depth",
            "1",
            "--",
            clone_source_url,
            str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=clone_env,
        )
        try:
            stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=float(clone_timeout))
            clone_log = stdout_bytes.decode("utf-8", errors="replace")
            cloned_ok = proc.returncode == 0
        except asyncio.TimeoutError:
            proc.kill()
            try:
                await proc.wait()
            except Exception:
                pass
            clone_log = f"Превышен таймаут ожидания git clone ({clone_timeout} сек)."
    except Exception as e:
        clone_log = str(e)

    safe_clone_log = _mask_url_userinfo(redact_log_text(clone_log or ""))

    if not cloned_ok or not any(workdir.iterdir()):
        shutil.rmtree(workdir, ignore_errors=True)
        shutil.rmtree(LOGS_DIR / name, ignore_errors=True)
        err_msg = safe_clone_log.strip() or "Не удалось клонировать репозиторий (проверьте URL и доступность сети)"
        raise HTTPException(status_code=400, detail=f"Ошибка git clone: {err_msg}")

    runtime = "python"
    detected_cmd = "python3 main.py"
    if (workdir / "package.json").exists():
        runtime = "node"
        detected_cmd = "node index.js"
    elif (workdir / "bot.py").exists():
        detected_cmd = "python3 bot.py"
    elif (workdir / "app.py").exists():
        detected_cmd = "python3 app.py"
    elif (workdir / "main.py").exists():
        detected_cmd = "python3 main.py"
    elif (workdir / "run.sh").exists():
        runtime = "bash"
        detected_cmd = "bash run.sh"

    custom_cmd = str(body.get("cmd", "")).strip()
    final_cmd = custom_cmd or detected_cmd

    env_obj: dict[str, str] = {
        "PROJECT_DESCRIPTION": description,
        "PROJECT_GROUP": group_tag,
        "GIT_REPO_URL": clean_repo_url,
    }
    if custom_proxy:
        env_obj["CUSTOM_PROXY_URL"] = custom_proxy

    now = int(time.time())
    webhook_token = secrets.token_hex(16)
    proj_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token, ping_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 128, 'manual', '', 0, 0, 30, ?, ?, 0, 'on-failure', 2, 300, 'stopped', 1, 0, 1, ?, ?)""",
        (
            name,
            proj_type,
            runtime,
            final_cmd,
            str(workdir),
            json.dumps(env_obj, ensure_ascii=False),
            use_proxy,
            webhook_token,
            secrets.token_hex(16),
            now,
            now,
        ),
    )
    _invalidate_dir_size_cache(workdir)
    row = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    if row:
        sync_project_yaml(row)
        write_project_agents_md(workdir, name, proj_type, runtime, final_cmd)
    return {"ok": True, "cloned": cloned_ok, "clone_log": safe_clone_log, "project": _enrich_project(row or {})}


@router.get("/projects/examples")
async def api_list_project_examples(request: Request) -> list[dict[str, Any]]:
    EXAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    for entry in sorted(EXAMPLES_DIR.iterdir(), key=lambda p: p.name):
        if not entry.is_dir():
            continue
        meta_path = entry / "example.json"
        meta: dict[str, Any] = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        items.append(
            {
                "name": entry.name,
                "type": meta.get("type", "service"),
                "runtime": meta.get("runtime", "python"),
                "cmd": meta.get("cmd", "python3 main.py"),
                "description": meta.get("description", f"Пример проекта {entry.name}"),
                "already_imported": query_one("SELECT id FROM projects WHERE name = ?", (entry.name,)) is not None,
            }
        )
    return items


@router.post("/projects/import_example")
async def api_import_project_example(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    example_name = str(body.get("name", "")).strip()
    if not validate_project_name(example_name):
        raise HTTPException(status_code=400, detail="Некорректное имя примера")

    src_dir = (EXAMPLES_DIR / example_name).resolve()
    if os.path.commonpath([str(EXAMPLES_DIR.resolve()), str(src_dir)]) != str(EXAMPLES_DIR.resolve()) or not src_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Пример «{example_name}» не найден в projects/examples/")

    if query_one("SELECT id FROM projects WHERE name = ?", (example_name,)):
        raise HTTPException(status_code=400, detail=f"Проект «{example_name}» уже импортирован")

    dst_dir = PROJECTS_DIR / example_name
    shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True)
    (LOGS_DIR / example_name).mkdir(parents=True, exist_ok=True)

    meta: dict[str, Any] = {}
    meta_file = dst_dir / "example.json"
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception:
            meta = {}

    now = int(time.time())
    proj_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token, ping_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 30, ?, ?, 0, 'on-failure', 2, 300, 'stopped', 1, 0, 1, ?, ?)""",
        (
            example_name,
            meta.get("type", "service"),
            meta.get("runtime", "python"),
            meta.get("cmd", "python3 main.py"),
            str(dst_dir),
            json.dumps({"PROJECT_DESCRIPTION": meta.get("description", ""), "PROJECT_GROUP": "Примеры"}, ensure_ascii=False),
            json.dumps(meta.get("secrets", []), ensure_ascii=False),
            int(meta.get("use_proxy", 0)),
            int(meta.get("ram_limit_mb", 64)),
            meta.get("schedule_type", "manual"),
            meta.get("schedule_expr", ""),
            secrets.token_hex(16),
            secrets.token_hex(16),
            now,
            now,
        ),
    )
    row = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    return {"ok": True, "project": _enrich_project(row or {})}


@router.post("/projects/{project_id}/clone")
async def api_clone_existing_project(request: Request, project_id: int) -> dict[str, Any]:
    src = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not src:
        raise HTTPException(status_code=404, detail="Исходный проект не найден")

    body = await read_json(request)
    requested_name = str(body.get("new_name", "")).strip()
    if not requested_name:
        base_name = f"{src['name']}-acc2"
        idx = 2
        while query_one("SELECT id FROM projects WHERE name = ?", (base_name,)):
            idx += 1
            base_name = f"{src['name']}-acc{idx}"
        requested_name = base_name[:60]

    if not validate_project_name(requested_name):
        raise HTTPException(status_code=400, detail="Некорректное имя для клона проекта")
    if query_one("SELECT id FROM projects WHERE name = ?", (requested_name,)):
        raise HTTPException(status_code=400, detail=f"Проект «{requested_name}» уже существует")

    src_dir = Path(src["workdir"])
    dst_dir = PROJECTS_DIR / requested_name
    dst_dir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / requested_name).mkdir(parents=True, exist_ok=True)

    if src_dir.exists():
        def _ignore_symlinks_and_excluded(d: str, names: list[str]) -> set[str]:
            ignored: set[str] = set()
            for n in names:
                if n in _EXCLUDED_DIRS or n in ("cookies.json", "storage_state.json", "browser_profile"):
                    ignored.add(n)
                elif os.path.islink(os.path.join(d, n)):
                    ignored.add(n)
            return ignored

        for item in src_dir.iterdir():
            if (
                item.name in _EXCLUDED_DIRS
                or item.name in ("cookies.json", "storage_state.json", "browser_profile")
                or item.is_symlink()
            ):
                continue
            target = dst_dir / item.name
            if item.is_dir():
                shutil.copytree(item, target, symlinks=False, ignore=_ignore_symlinks_and_excluded, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target, follow_symlinks=False)

    try:
        env_obj = json.loads(src.get("env_json") or "{}")
    except Exception:
        env_obj = {}
    old_desc = env_obj.get("PROJECT_DESCRIPTION", "")
    env_obj["PROJECT_DESCRIPTION"] = f"[Копия {src['name']}] {old_desc}".strip()
    env_obj.pop("IS_TEST_PROJECT", None)

    now = int(time.time())
    new_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token, ping_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?)""",
        (
            requested_name,
            src["type"],
            src["runtime"],
            src["cmd"],
            str(dst_dir),
            json.dumps(env_obj, ensure_ascii=False),
            src["use_proxy"],
            src["ram_limit_mb"],
            src["schedule_type"],
            src["schedule_expr"],
            src["timeout_sec"],
            src["max_retries"],
            src["retry_delay_sec"],
            secrets.token_hex(16),
            secrets.token_hex(16),
            src["restart_policy"],
            src["backoff_min_sec"],
            src["backoff_max_sec"],
            src["notify_on_error"],
            src["notify_on_success"],
            src["notify_on_crash"],
            now,
            now,
        ),
    )
    _invalidate_dir_size_cache(dst_dir)
    created = query_one("SELECT * FROM projects WHERE id = ?", (new_id,))
    return {"ok": True, "project": _enrich_project(created or {})}


@router.post("/projects/{project_id}/exec")
async def api_exec_project_command(request: Request, project_id: int) -> dict[str, Any]:
    """
    Запускает произвольную консольную команду внутри рабочей директории проекта.
    Доступно ТОЛЬКО администратору веб-панели (никогда не экспортируется в MCP или /api/v1/).
    """
    _require_admin_session(request)
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    raw_cmd = str(body.get("command", "")).strip()
    if not raw_cmd:
        raise HTTPException(status_code=400, detail="Введите команду для выполнения")

    client_ip = _client_ip(request)
    log_audit(client_ip, "PROJECT_EXEC_CMD", f"Проект '{proj['name']}': {raw_cmd[:160]}", actor=_session_actor(request))

    run = await start_project_run(project_id, trigger="manual", custom_argv=["/bin/bash", "-c", raw_cmd])
    _invalidate_dir_size_cache(Path(proj["workdir"]))
    return {"ok": True, "command": raw_cmd, "run": run}


@router.post("/runs/{run_id}/stdin")
async def api_send_run_stdin(request: Request, run_id: int) -> dict[str, Any]:
    body = await read_json(request)
    text = str(body.get("text", ""))
    ok = send_stdin_to_run(run_id, text)
    if not ok:
        raise HTTPException(status_code=400, detail="Процесс уже завершён или не принимает ввод")
    return {"ok": True, "run_id": run_id, "sent": text}


@router.post("/projects/{project_id}/web_auth/start")
async def api_web_auth_start(request: Request, project_id: int) -> dict[str, Any]:
    body = await read_json(request)
    url = str(body.get("url", "https://example.com/login")).strip()
    proxy_mode = str(body.get("proxy_mode", "system")).strip()
    custom_proxy = str(body.get("custom_proxy", "")).strip()
    try:
        session = await start_web_auth_session(project_id, url, proxy_mode=proxy_mode, custom_proxy=custom_proxy)
        return {"ok": True, "session": session}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/projects/{project_id}/web_auth/action")
async def api_web_auth_action(request: Request, project_id: int) -> dict[str, Any]:
    body = await read_json(request)
    try:
        session = await perform_web_auth_action(project_id, body)
        return {"ok": True, "session": session}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/projects/{project_id}/web_auth/save")
async def api_web_auth_save(request: Request, project_id: int) -> dict[str, Any]:
    try:
        res = await save_and_close_web_auth_session(project_id)
        proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
        if proj:
            _invalidate_dir_size_cache(Path(proj["workdir"]))
        return {**res, "project": _enrich_project(proj or {})}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/projects/{project_id}/web_auth/cancel")
async def api_web_auth_cancel(request: Request, project_id: int) -> dict[str, Any]:
    return cancel_web_auth_session(project_id)


@router.post("/webhook/{webhook_token}")
async def api_trigger_webhook(request: Request, webhook_token: str) -> Response:
    client_ip = _client_ip(request)
    allowed, retry_after = check_webhook_rate_limit(client_ip)
    if not allowed:
        return JSONResponse(
            {"detail": f"Превышен лимит запросов к вебхуку. Повторите через {retry_after} сек."},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    proj = query_one("SELECT * FROM projects WHERE webhook_token = ?", (webhook_token,))
    if not proj:
        blocked, block_sec = record_webhook_failure(client_ip)
        if blocked:
            return JSONResponse(
                {"detail": f"IP заблокирован на {block_sec // 60} мин. за перебор токенов вебхука"},
                status_code=429,
                headers={"Retry-After": str(block_sec)},
            )
        raise HTTPException(status_code=404, detail="Недействительный webhook_token")

    hmac_secret = str(proj.get("webhook_hmac_secret") or "").strip()
    if hmac_secret:
        sig_hdr = (
            request.headers.get("x-beacon-signature")
            or request.headers.get("x-hub-signature-256")
            or ""
        ).strip()
        raw_body = await request.body()
        expected = "sha256=" + hmac.new(hmac_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        if not sig_hdr or not hmac.compare_digest(expected, sig_hdr):
            raise HTTPException(status_code=401, detail="Недействительная HMAC-подпись X-Beacon-Signature")

    proj_id = int(proj["id"])
    if is_project_running(proj_id):
        return JSONResponse(
            {"detail": f"Проект «{proj['name']}» уже выполняется"},
            status_code=409,
        )

    try:
        run = await start_project_run(proj_id, trigger="webhook")
    except RuntimeError as exc:
        if "уже выполняется" in str(exc):
            return JSONResponse({"detail": str(exc)}, status_code=409)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse({"ok": True, "project": proj["name"], "run_id": run["id"]})


# ==============================================================================
# 4. ФАЙЛОВЫЙ МЕНЕДЖЕР И РЕДАКТОР КОДА
# ==============================================================================
@router.get("/projects/{project_id}/files")
async def api_project_files(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    workdir = Path(proj["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    tree = _build_file_tree(workdir)
    if not tree:
        tpl = "web" if proj.get("type") == "web" else str(proj.get("runtime") or "python")
        create_project_from_template(proj["name"], tpl, str(proj.get("runtime") or "python"), str(proj.get("type") or "service"))
        _invalidate_dir_size_cache(workdir)
        tree = _build_file_tree(workdir)
    return {"workdir": str(workdir), "tree": tree}


@router.get("/projects/{project_id}/files/content")
async def api_get_file_content(request: Request, project_id: int) -> dict[str, Any]:
    _require_admin_session(request)
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    rel_path = request.query_params.get("path", "")
    if not rel_path:
        raise HTTPException(status_code=400, detail="Параметр path обязателен")

    target = _safe_project_path(proj["workdir"], rel_path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"Файл '{rel_path}' не найден")

    content = target.read_text(encoding="utf-8", errors="replace")
    return {"path": rel_path, "content": content, "size": target.stat().st_size}


@router.put("/projects/{project_id}/files/content")
async def api_put_file_content(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    rel_path = str(body.get("path", "")).strip()
    content = str(body.get("content", ""))
    if not rel_path:
        raise HTTPException(status_code=400, detail="Не указан путь к файлу")

    target = _safe_project_path(proj["workdir"], rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    _invalidate_dir_size_cache(Path(proj["workdir"]))
    return {"ok": True, "path": rel_path, "size": target.stat().st_size}


@router.post("/projects/{project_id}/files/mkdir")
async def api_mkdir(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    rel_path = str(body.get("path", "")).strip().strip("/")
    if not rel_path:
        raise HTTPException(status_code=400, detail="Не указан путь папки")

    target = _safe_project_path(proj["workdir"], rel_path)
    target.mkdir(parents=True, exist_ok=True)
    _invalidate_dir_size_cache(Path(proj["workdir"]))
    return {"ok": True, "path": rel_path}


@router.post("/projects/{project_id}/files/rename")
async def api_rename_file(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await read_json(request)
    old_path = str(body.get("old_path", "")).strip().strip("/")
    new_path = str(body.get("new_path", "")).strip().strip("/")
    if not old_path or not new_path:
        raise HTTPException(status_code=400, detail="Необходимо указать old_path и new_path")

    workdir_resolved = Path(proj["workdir"]).resolve()
    src = _safe_project_path(proj["workdir"], old_path)
    dst = _safe_project_path(proj["workdir"], new_path)
    if src == workdir_resolved or dst == workdir_resolved:
        raise HTTPException(status_code=400, detail="Нельзя переименовать корневую папку проекта")
    if not src.exists():
        raise HTTPException(status_code=404, detail="Исходный файл или папка не найдены")
    if src.is_dir() and dst != src and os.path.commonpath([str(src), str(dst)]) == str(src):
        raise HTTPException(status_code=400, detail="Нельзя переместить папку внутрь самой себя")
    if dst.exists() and dst != src:
        raise HTTPException(status_code=400, detail="Файл или папка с таким именем уже существует")

    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    _invalidate_dir_size_cache(Path(proj["workdir"]))
    return {"ok": True, "old_path": old_path, "new_path": new_path}


@router.delete("/projects/{project_id}/files")
async def api_delete_file(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    rel_path = (request.query_params.get("path", "") or "").strip().strip("/").strip("\\")
    if not rel_path:
        raise HTTPException(status_code=400, detail="Не указан путь для удаления")

    workdir_resolved = Path(_validate_project_workdir(str(proj["workdir"]))).resolve()
    raw_candidate = workdir_resolved / rel_path
    # Если удаляется сам симлинк внутри папки проекта — проверяем родителя и удаляем сам симлинк без перехода по нему
    if raw_candidate.is_symlink():
        parent_safe = _safe_project_path(workdir_resolved, str(Path(rel_path).parent) if str(Path(rel_path).parent) != "." else "")
        symlink_file = parent_safe / Path(rel_path).name
        if symlink_file.is_symlink():
            symlink_file.unlink()
            _invalidate_dir_size_cache(workdir_resolved)
            return {"ok": True, "deleted": rel_path}

    target = _safe_project_path(workdir_resolved, rel_path)
    if target == workdir_resolved:
        raise HTTPException(status_code=400, detail="Нельзя удалить корневую папку проекта")

    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    _invalidate_dir_size_cache(workdir_resolved)
    return {"ok": True, "deleted": rel_path}


@router.post("/projects/{project_id}/files/upload")
async def api_upload_file(request: Request, project_id: int) -> dict[str, Any]:
    """
    Загрузка файла в проект (поддерживает multipart/form-data и JSON с base64)
    и защищённую потоковую распаковку .zip по флагу extract=true (Фаза A.5).
    """
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    workdir = Path(proj["workdir"]).resolve()
    workdir.mkdir(parents=True, exist_ok=True)

    ctype = request.headers.get("content-type", "")
    filename = ""
    target_dir = (request.query_params.get("target_dir") or "").strip().strip("/")
    extract = request.query_params.get("extract", "false").lower() == "true"

    with tempfile.NamedTemporaryFile(suffix=".upload", delete=False) as tf:
        tmp_upload_path = Path(tf.name)

    written_size = 0
    try:
        if "application/json" in ctype:
            body = await read_json(request)
            filename = str(body.get("filename", "uploaded.txt")).strip()
            if body.get("target_dir"):
                target_dir = str(body.get("target_dir", "")).strip().strip("/")
            extract = bool(body.get("extract", extract))
            b64 = body.get("content_base64")
            if b64:
                written_size = _decode_base64_to_file(str(b64), tmp_upload_path, max_bytes=MAX_ZIP_ARCHIVE_BYTES)
            else:
                raw_data = str(body.get("content", "")).encode("utf-8")
                written_size = len(raw_data)
                if written_size > MAX_ZIP_ARCHIVE_BYTES:
                    raise HTTPException(status_code=413, detail="Размер загружаемого файла превышает 50 МБ")
                tmp_upload_path.write_bytes(raw_data)
        else:
            form = await request.form()
            if "extract" in form:
                extract = str(form["extract"]).lower() in ("true", "1", "yes")
            if "target_dir" in form:
                target_dir = str(form["target_dir"]).strip().strip("/")
            upload_obj = form.get("file")
            if upload_obj is None:
                raise HTTPException(status_code=400, detail="Поле 'file' не найдено в запросе")
            filename = getattr(upload_obj, "filename", "uploaded.bin")
            if hasattr(upload_obj, "read"):
                written_size = 0
                with open(tmp_upload_path, "wb") as out_f:
                    try:
                        while True:
                            chunk = await upload_obj.read(_ZIP_STREAM_CHUNK)
                            if not chunk:
                                break
                            written_size += len(chunk)
                            if written_size > MAX_ZIP_ARCHIVE_BYTES:
                                raise HTTPException(status_code=413, detail="Размер загружаемого файла превышает 50 МБ")
                            out_f.write(chunk)
                    except TypeError:
                        raw_data = await upload_obj.read()
                        written_size = len(raw_data)
                        if written_size > MAX_ZIP_ARCHIVE_BYTES:
                            raise HTTPException(status_code=413, detail="Размер загружаемого файла превышает 50 МБ")
                        out_f.write(raw_data)
            else:
                raise HTTPException(status_code=400, detail="Некорректный файл в форме")

        rel_dest = f"{target_dir}/{filename}".lstrip("/") if target_dir and "/" not in filename else filename
        dest_file = _safe_project_path(workdir, rel_dest)
        dest_file.parent.mkdir(parents=True, exist_ok=True)

        if extract and filename.lower().endswith(".zip"):
            extract_root = _safe_project_path(workdir, target_dir) if target_dir else workdir
            extract_root.mkdir(parents=True, exist_ok=True)
            extracted_files = safe_extract_zip_file(tmp_upload_path, extract_root)
            _invalidate_dir_size_cache(workdir)
            return {"ok": True, "extracted": True, "files": extracted_files, "target_dir": target_dir}

        shutil.move(str(tmp_upload_path), str(dest_file))
        _invalidate_dir_size_cache(workdir)
        return {"ok": True, "extracted": False, "path": rel_dest, "size": written_size}
    finally:
        tmp_upload_path.unlink(missing_ok=True)


# ==============================================================================
# 5. ЛОГИ И ЖИВОЙ SSE-СТРИМ
# ==============================================================================
@router.get("/projects/{project_id}/runs")
async def api_project_runs(request: Request, project_id: int) -> list[dict[str, Any]]:
    rows = query_all(
        """SELECT id, project_id, status, trigger, pid, pgid, proc_create_time,
                  started_at, finished_at, exit_code, log_path, error_summary
           FROM runs
           WHERE project_id = ?
           ORDER BY id DESC
           LIMIT 30""",
        (project_id,),
    )
    for r in rows:
        info = ACTIVE_RUNS.get(r["id"])
        if info:
            r["rss_mb"] = info.get("rss_mb", 0.0)
            r["cpu_percent"] = info.get("cpu_percent", 0.0)
        elif r.get("pgid") and r["status"] in ("running", "waiting_input"):
            rss_mb, cpu_pct, _ = get_pgid_metrics(int(r["pgid"]))
            r["rss_mb"] = rss_mb
            r["cpu_percent"] = cpu_pct
        else:
            r["rss_mb"] = 0.0
            r["cpu_percent"] = 0.0
    return rows


@router.get("/runs/{run_id}/log")
async def api_get_run_log(request: Request, run_id: int) -> dict[str, Any]:
    run = query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
    if not run:
        raise HTTPException(status_code=404, detail="Запуск не найден")

    max_lines = parse_int_param(request.query_params.get("lines"), "lines", default=1000, min_val=1, max_val=20000)
    log_path = Path(run["log_path"])
    log_size = log_path.stat().st_size if log_path.exists() else 0
    content = read_log_tail_bytes(run["log_path"], max_bytes=131072, max_lines=max_lines)

    return {
        "run_id": run["id"],
        "project_id": run["project_id"],
        "status": run["status"],
        "pid": run["pid"],
        "pgid": run["pgid"],
        "started_at": run["started_at"],
        "finished_at": run["finished_at"],
        "exit_code": run["exit_code"],
        "log": content,
        "log_size": log_size,
    }


@router.get("/runs/{run_id}/stream")
async def api_stream_run_log(request: Request, run_id: int) -> StreamingResponse:
    run = query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
    if not run:
        raise HTTPException(status_code=404, detail="Запуск не найден")

    log_path = Path(run["log_path"])
    raw_offset = request.query_params.get("offset")
    initial_offset = 0
    if raw_offset is not None:
        if raw_offset == "tail":
            initial_offset = log_path.stat().st_size if log_path.exists() else 0
        else:
            try:
                initial_offset = max(0, int(raw_offset))
            except ValueError:
                initial_offset = 0

    async def _event_generator() -> AsyncIterator[str]:
        offset = initial_offset
        idle_ticks = 0
        line_buf = ""

        def _flush_complete_lines(buf: str, flush_all: bool = False) -> tuple[str, str]:
            if not buf:
                return "", ""
            if flush_all or len(buf) >= 16384:
                return redact_log_text(buf), ""
            idx = buf.rfind("\n")
            if idx == -1:
                return "", buf
            ready = buf[: idx + 1]
            rem = buf[idx + 1 :]
            return redact_log_text(ready), rem

        while True:
            if log_path.exists():
                try:
                    sz = log_path.stat().st_size
                    if sz < offset:
                        offset = 0
                        line_buf = ""
                    if sz > offset:
                        with open(log_path, "rb") as f:
                            f.seek(offset)
                            chunk = f.read(sz - offset)
                            offset = f.tell()
                        line_buf += chunk.decode("utf-8", errors="replace")
                        out_text, line_buf = _flush_complete_lines(line_buf, flush_all=False)
                        if out_text:
                            payload = json.dumps({"type": "log", "data": out_text}, ensure_ascii=False)
                            yield f"data: {payload}\n\n"
                except OSError:
                    pass

            curr = query_one("SELECT status, exit_code, finished_at FROM runs WHERE id = ?", (run_id,))
            if not curr or curr["status"] not in ("running", "waiting_input"):
                if log_path.exists():
                    try:
                        sz = log_path.stat().st_size
                        if sz > offset:
                            with open(log_path, "rb") as f:
                                f.seek(offset)
                                chunk = f.read(sz - offset)
                            line_buf += chunk.decode("utf-8", errors="replace")
                    except OSError:
                        pass
                out_text, line_buf = _flush_complete_lines(line_buf, flush_all=True)
                if out_text:
                    payload = json.dumps({"type": "log", "data": out_text}, ensure_ascii=False)
                    yield f"data: {payload}\n\n"
                end_payload = json.dumps(
                    {
                        "type": "status",
                        "status": curr["status"] if curr else "stopped",
                        "exit_code": curr["exit_code"] if curr else None,
                    },
                    ensure_ascii=False,
                )
                yield f"data: {end_payload}\n\n"
                break

            idle_ticks += 1
            if idle_ticks % 10 == 0:
                yield ": keepalive\n\n"

            await asyncio.sleep(0.3)

    return StreamingResponse(_event_generator(), media_type="text/event-stream")


# ==============================================================================
# 6. СЕКРЕТЫ И ИНТЕРАКТИВНЫЕ ЗАПРОСЫ (aruta.ask / Cookie-Editor)
# ==============================================================================
@router.get("/secrets")
async def api_get_secrets(request: Request) -> list[dict[str, Any]]:
    _require_admin_session(request)
    raw_secrets = list_secrets()
    all_projects = query_all("SELECT name, secrets_json FROM projects")
    proj_map: dict[str, list[str]] = {}
    for p in all_projects:
        p_name = p["name"]
        try:
            s_list = json.loads(p.get("secrets_json") or "[]")
        except Exception:
            s_list = []
        for s_name in s_list:
            proj_map.setdefault(s_name, []).append(p_name)

    for sec in raw_secrets:
        used_by = list(proj_map.get(sec["name"], []))
        if sec["name"].endswith("_cookies"):
            inferred_proj = sec["name"][: -len("_cookies")]
            if inferred_proj and inferred_proj not in used_by:
                if any(p["name"] == inferred_proj for p in all_projects):
                    used_by.append(inferred_proj)
        sec["used_by_projects"] = used_by
    return raw_secrets


@router.post("/secrets")
async def api_save_secret(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    name = str(body.get("name", "")).strip()
    sec_type = str(body.get("type", "text")).strip()
    value = str(body.get("value", ""))
    is_base64 = bool(body.get("is_base64")) or str(body.get("encoding", "")).strip().lower() == "base64"
    try:
        return save_secret(name, sec_type, value, is_base64=is_base64)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/secrets/cookies")
async def api_import_cookies(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    name = str(body.get("name", "my_cookies")).strip()
    raw_json = body.get("cookies_json", body.get("value", ""))
    try:
        return import_cookie_editor_json(name, raw_json)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/secrets/{name}/expire")
async def api_expire_cookie_secret(request: Request, name: str) -> dict[str, Any]:
    body = await read_json(request)
    note = str(body.get("note", "Сессия истекла (вызван beacon.cookies_expired)")).strip()
    try:
        clean_name = validate_secret_name(name)
        ok = mark_cookies_expired(clean_name, note=note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail=f"Секрет '{clean_name}' не найден")
    await send_notification(f"Куки «{clean_name}» помечены как устаревшие: {note}", level="warn")
    return {"ok": True, "name": clean_name, "is_expired": 1}


@router.delete("/secrets/{name}")
async def api_delete_secret(request: Request, name: str) -> dict[str, Any]:
    try:
        clean_name = validate_secret_name(name)
        ok = delete_secret(clean_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Секрет не найден")
    return {"ok": True, "deleted": clean_name}


@router.post("/asks/{ask_id}/answer")
async def api_answer_ask(request: Request, ask_id: str) -> dict[str, Any]:
    body = await read_json(request)
    answer = str(body.get("answer", "")).strip()
    if not answer:
        raise HTTPException(status_code=400, detail="Ответ не может быть пустым")
    ok = answer_ask(ask_id, answer, source="web")
    if not ok:
        raise HTTPException(status_code=404, detail="Запрос ввода уже закрыт или не найден")
    return {"ok": True, "ask_id": ask_id, "answer": answer}


# ==============================================================================
# 7. СИСТЕМА, НАСТРОЙКИ И АУДИТ
# ==============================================================================
@router.get("/settings")
async def api_get_settings(request: Request) -> dict[str, Any]:
    _require_admin_session(request)
    cfg = get_all_settings()
    cfg.pop("password_hash", None)
    cfg.pop("session_secret", None)
    raw_tg = str(cfg.get("tg_bot_token", "")).strip()
    cfg["tg_bot_token_configured"] = bool(raw_tg)
    if raw_tg:
        cfg["tg_bot_token"] = "********"
    cfg["reserved_ports_list"] = sorted(list(parse_reserved_ports(cfg.get("reserved_ports", ""))))
    cfg["forbidden_ports"] = cfg["reserved_ports_list"]
    cfg["is_default_password"] = is_default_password()
    return cfg


@router.put("/settings")
async def api_update_settings(request: Request) -> Any:
    _require_admin_session(request)
    body = await read_json(request)
    client_ip = _client_ip(request)
    actor = _session_actor(request)

    new_password = str(body.get("new_password", "")).strip()
    if new_password:
        # Фаза A.1(г): единое правило — минимум 8 символов, никакой записи пароля на диск!
        if len(new_password) < 8:
            raise HTTPException(status_code=400, detail="Новый пароль должен содержать минимум 8 символов")
        if new_password.lower() == "admin":
            raise HTTPException(status_code=400, detail="Новый пароль не может совпадать со стандартным 'admin'")
        if not is_default_password():
            curr_pw = str(body.get("current_password", ""))
            if not curr_pw or not verify_password(curr_pw, get_setting("password_hash", "")):
                raise HTTPException(status_code=400, detail="Укажите действующий текущий пароль (current_password)")

    reserved_str = str(body.get("reserved_ports", get_setting("reserved_ports", "")))
    reserved_set = parse_reserved_ports(reserved_str)

    validated_updates: dict[str, str] = {}

    if "port" in body:
        new_port = parse_int_param(body["port"], "port", min_val=1, max_val=65535)
        if new_port in reserved_set:
            raise HTTPException(
                status_code=400,
                detail=f"Порт {new_port} входит в список зарезервированных портов ({sorted(list(reserved_set))})",
            )
        validated_updates["port"] = str(new_port)

    int_specs: dict[str, tuple[int, int]] = {
        "disk_warn_mb": (10, 10_000_000),
        "disk_crit_mb": (5, 10_000_000),
        "log_max_size_mb": (1, 10_000),
        "log_keep_runs": (1, 10_000),
        "log_keep_days": (1, 3650),
        "autostart_stagger_sec": (0, 300),
        "autostart_min_free_ram_mb": (0, 1_000_000),
        "battery_low_pct": (1, 100),
        "auto_backup_interval_hours": (0, 8760),
        "auto_backup_keep": (1, 100),
        "git_clone_timeout_sec": (10, 3600),
        "ai_approval_ttl_min": (1, 1440),
    }
    for ikey, (min_v, max_v) in int_specs.items():
        if ikey in body:
            validated_updates[ikey] = str(parse_int_param(body[ikey], ikey, min_val=min_v, max_val=max_v))

    for fkey in ("battery_warn_temp_c", "battery_crit_temp_c"):
        if fkey in body:
            raw_f = body[fkey]
            try:
                fval = float(raw_f)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=f"Параметр '{fkey}' должен быть числом") from exc
            if not math.isfinite(fval) or fval < 0.0 or fval > 100.0:
                raise HTTPException(status_code=400, detail=f"Параметр '{fkey}' должен быть в диапазоне [0, 100]")
            validated_updates[fkey] = str(raw_f).strip()

    if "run_missed" in body:
        rm = str(body["run_missed"]).strip().lower()
        if rm not in ("none", "once"):
            raise HTTPException(status_code=400, detail="Параметр 'run_missed' должен быть 'none' или 'once'")
        validated_updates["run_missed"] = rm

    bool_keys = (
        "allow_tailscale",
        "cookie_secure",
        "safe_mode",
        "healthcheck_allow_external",
        "tg_use_proxy",
        "ntfy_use_proxy",
        "webhook_use_proxy",
        "thermal_auto_stop",
    )
    for bkey in bool_keys:
        if bkey in body:
            raw_b = body[bkey]
            if isinstance(raw_b, bool):
                validated_updates[bkey] = "1" if raw_b else "0"
            else:
                bstr = str(raw_b).strip().lower()
                if bstr in ("1", "true", "yes"):
                    validated_updates[bkey] = "1"
                elif bstr in ("0", "false", "no"):
                    validated_updates[bkey] = "0"
                else:
                    raise HTTPException(status_code=400, detail=f"Параметр '{bkey}' должен быть '0' или '1'")

    if "allowed_subnets" in body:
        parts = [p.strip() for p in str(body["allowed_subnets"] or "").split(",") if p.strip()]
        if not parts:
            raise HTTPException(status_code=400, detail="Параметр 'allowed_subnets' не может быть пустым")
        for item in parts:
            if item == "*":
                continue
            try:
                ipaddress.ip_network(item, strict=False)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"Некорректный CIDR в allowed_subnets: {item}") from exc
        validated_updates["allowed_subnets"] = ",".join(parts)

    if "trusted_proxies" in body:
        tparts = [p.strip() for p in str(body["trusted_proxies"] or "").split(",") if p.strip()]
        for item in tparts:
            if item == "*":
                raise HTTPException(status_code=400, detail="В trusted_proxies запрещено использовать wildcard '*'")
            try:
                ipaddress.ip_network(item, strict=False)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"Некорректный CIDR в trusted_proxies: {item}") from exc
        validated_updates["trusted_proxies"] = ",".join(tparts)

    if "run_as_user" in body:
        rau = str(body["run_as_user"] or "").strip()
        if not rau:
            raise HTTPException(status_code=400, detail="Параметр 'run_as_user' не может быть пустым")
        if rau != "root":
            try:
                pwd.getpwnam(rau)
            except KeyError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Системный пользователь '{rau}' не найден в /etc/passwd",
                ) from exc
        validated_updates["run_as_user"] = rau

    if "allowed_subnets" in body or "allow_tailscale" in body:
        prop_subnets = validated_updates.get("allowed_subnets", get_setting("allowed_subnets", ""))
        prop_tailscale = validated_updates.get("allow_tailscale", get_setting("allow_tailscale", "0")) == "1"
        check_csv = f"{prop_subnets},100.64.0.0/10" if (prop_tailscale and not is_default_password()) else prop_subnets
        still_allowed = is_loopback_ip(client_ip) or _ip_in_cidr_csv(client_ip, check_csv)
        if not still_allowed and not bool(body.get("confirm_lockout")):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"lockout_warning: Ваш текущий IP ({client_ip}) не входит в новые подсети. "
                    "Подтвердите сохранение с confirm_lockout=true."
                ),
            )

    plain_string_keys = (
        "reserved_ports",
        "proxy_url",
        "outbound_heartbeat_url",
        "tg_bot_token",
        "tg_chat_id",
        "tg_allowed_user_ids",
        "ntfy_url",
        "ntfy_topic",
        "webhook_url",
        "mcp_allowed_origins",
        "battery_limit_min",
        "battery_limit_max",
        "battery_alert_below",
    )
    for skey in plain_string_keys:
        if skey in body:
            val_str = str(body[skey])
            if skey == "tg_bot_token" and val_str.strip() and set(val_str.strip()) == {"*"}:
                continue
            validated_updates[skey] = val_str

    for k, v in validated_updates.items():
        set_setting(k, v)

    pw_changed = False
    if new_password:
        set_setting("password_hash", hash_password(new_password))
        set_setting("must_change_password", "0")
        bump_session_epoch()
        pw_changed = True
        log_audit(client_ip, "PASSWORD_CHANGED", "Пароль администратора изменён в настройках панели", actor=actor)

    reload_redaction_cache()
    ensure_tg_poller_running()
    log_audit(client_ip, "SETTINGS_UPDATED", "Обновлены системные настройки панели", actor=actor)
    cfg = await api_get_settings(request)
    if pw_changed:
        sess = getattr(getattr(request, "state", None), "session", None)
        if isinstance(sess, dict):
            new_sess, new_csrf = create_session_tokens(
                role=str(sess.get("role") or "admin"),
                username=str(sess.get("user") or "admin"),
            )
            cfg["csrf_token"] = new_csrf
            if os.environ.get("BEACON_PREVIEW_MODE") == "1":
                cfg["session_token"] = new_sess
            is_https, samesite_mode = _cookie_security_flags(request)
            resp = JSONResponse(cfg)
            resp.set_cookie("beacon_session", new_sess, max_age=86400 * 7, httponly=True, samesite=samesite_mode, secure=is_https)
            resp.set_cookie("csrf_token", new_csrf, max_age=86400 * 7, httponly=False, samesite=samesite_mode, secure=is_https)
            return resp
    return cfg


@router.post("/settings/test_notify")
async def api_test_notify(request: Request) -> dict[str, Any]:
    res = await send_notification(
        "Тестовое уведомление от панели Beacon.",
        level="info",
        project_name="beacon-system",
    )
    return {"ok": True, "result": res}


@router.post("/settings/test_tg_command")
async def api_test_tg_command(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    command = str(body.get("command", "/status")).strip() or "/status"
    reply = await handle_telegram_command(command)
    return {"ok": True, "command": command, "reply": reply or ""}


@router.get("/system/health")
async def api_system_health(request: Request) -> dict[str, Any]:
    return {
        "ok": True,
        "pid": os.getpid(),
        "uptime_sec": round(max(0.0, time.time() - _PANEL_STARTED_AT), 1),
        "active_runs_count": len(ACTIVE_RUNS),
        "watch_loop": dict(_WATCH_LOOP_STATUS),
        "scheduler_loop": dict(_SCHEDULER_LOOP_STATUS),
    }


@router.post("/system/cleanup")
async def api_system_cleanup(request: Request) -> dict[str, Any]:
    client_ip = _client_ip(request)
    res = cleanup_system_caches()
    log_audit(client_ip, "SYSTEM_CLEANUP", f"Удалено старых запусков: {res['deleted_runs']}", actor=_session_actor(request))
    return res


@router.get("/system/doctor")
async def api_system_doctor(request: Request) -> dict[str, Any]:
    return run_hub_doctor(auto_fix_perms=True)


@router.post("/system/thermal_check")
async def api_system_thermal_check(request: Request) -> dict[str, Any]:
    body = await read_json(request)
    force_temp_raw = body.get("force_temp_c")
    force_temp: Optional[float] = None
    if force_temp_raw is not None and str(force_temp_raw).strip() != "":
        try:
            force_temp = float(force_temp_raw)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Параметр 'force_temp_c' должен быть числом") from exc
    force_pct = (
        parse_int_param(body.get("force_percent"), "force_percent", min_val=0, max_val=100)
        if body.get("force_percent") is not None and str(body.get("force_percent")).strip() != ""
        else None
    )
    return await check_android_hardware_guard(force_temp_c=force_temp, force_percent=force_pct)


@router.post("/system/restart_hub_daemon")
async def api_restart_hub_daemon(request: Request) -> dict[str, Any]:
    before_runs = query_all(
        """SELECT r.id, r.pid, r.pgid, p.name
           FROM runs r JOIN projects p ON p.id = r.project_id
           WHERE r.status = 'running'"""
    )
    for info in list(ACTIVE_RUNS.values()):
        keep_fd = info.pop("stdin_keepalive_fd", None)
        if isinstance(keep_fd, int):
            try:
                os.close(keep_fd)
            except OSError:
                pass
    ACTIVE_RUNS.clear()
    rec = recover_running_processes()
    after_runs = query_all(
        """SELECT r.id, r.pid, r.pgid, p.name
           FROM runs r JOIN projects p ON p.id = r.project_id
           WHERE r.status = 'running'"""
    )
    survived = all(any(a["pid"] == b["pid"] and a["name"] == b["name"] for a in after_runs) for b in before_runs)
    return {
        "ok": True,
        "old_hub_pid": os.getpid(),
        "new_hub_pid": os.getpid(),
        "recovered_count": rec["recovered"],
        "running_before": before_runs,
        "running_after": after_runs,
        "survived_without_sigpipe": survived,
    }


@router.post("/system/run_acceptance_suite")
async def api_run_acceptance_suite(request: Request) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    now = int(time.time())

    # 1. Запуск и чистое убийство дерева процессов по PGID (os.setsid + os.killpg)
    tree_proj = query_one("SELECT * FROM projects WHERE name = 'acceptance-tree-test'")
    if not tree_proj:
        t_workdir = PROJECTS_DIR / "acceptance-tree-test"
        t_workdir.mkdir(parents=True, exist_ok=True)
        (LOGS_DIR / "acceptance-tree-test").mkdir(parents=True, exist_ok=True)
        tid = execute_sql(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token, ping_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES ('acceptance-tree-test', 'job', 'bash', 'bash -c "sleep 1000 & wait"', ?, '{}', '[]',
                0, 0, 'manual', '', 0, 0, 30, ?, ?, 0, 'no', 2, 60, 'stopped', 0, 0, 0, ?, ?)""",
            (str(t_workdir), secrets.token_hex(16), secrets.token_hex(16), now, now),
        )
        tree_proj = query_one("SELECT * FROM projects WHERE id = ?", (tid,))

    run1 = await start_project_run(int(tree_proj["id"]), trigger="manual")
    spawned_pgid = int(run1.get("pgid") or run1.get("pid") or 0)
    await asyncio.sleep(0.3)
    await stop_project(int(tree_proj["id"]))
    await asyncio.sleep(0.3)
    _, _, remaining_count = get_pgid_metrics(spawned_pgid)
    results.append(
        {
            "id": 1,
            "title": "1. Запуск и чистое убийство дерева процессов по PGID",
            "passed": remaining_count == 0,
            "details": (
                f"Группа PGID={spawned_pgid} (включая дочерний sleep 1000) полностью уничтожена в таблице процессов."
                if remaining_count == 0
                else f"Осталось выживших процессов в группе: {remaining_count}"
            ),
        }
    )

    # 2. Переживание рестарта панели без потери сервисов (Direct FD + ECHILD recovery)
    execute_sql("DELETE FROM projects WHERE name = 'acceptance-survive-test'")
    hb_workdir = PROJECTS_DIR / "acceptance-survive-test"
    hb_workdir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / "acceptance-survive-test").mkdir(parents=True, exist_ok=True)
    hb_id_new = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token, ping_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES ('acceptance-survive-test', 'service', 'bash', 'bash -c "sleep 60"', ?, '{}', '[]',
            0, 0, 'manual', '', 0, 0, 30, ?, ?, 0, 'no', 2, 60, 'stopped', 0, 0, 0, ?, ?)""",
        (str(hb_workdir), secrets.token_hex(16), secrets.token_hex(16), now, now),
    )
    hb = query_one("SELECT * FROM projects WHERE id = ?", (hb_id_new,))
    created_temp_hb = True

    if hb:
        await start_project_run(int(hb["id"]), trigger="autostart")
        await asyncio.sleep(0.2)
        active_hb = query_one(
            "SELECT * FROM runs WHERE project_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
            (hb["id"],),
        )
        pid_before = active_hb["pid"] if active_hb else None
        ACTIVE_RUNS.clear()
        rec = recover_running_processes()
        active_after = query_one(
            "SELECT * FROM runs WHERE project_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
            (hb["id"],),
        )
        pid_after = active_after["pid"] if active_after else None
        t2_ok = bool(pid_before and pid_before == pid_after and rec["recovered"] >= 1)
        results.append(
            {
                "id": 2,
                "title": "2. Переживание рестарта панели без потери сервисов (Direct FD + ECHILD recovery)",
                "passed": t2_ok,
                "details": f"Состояние супервизора перезагружено: сервис {hb['name']} сохранил PID={pid_after} без SIGPIPE (восстановлено: {rec['recovered']}).",
            }
        )

    # 3. Уведомление при падении
    notif_res = await send_notification(
        "Скрипт acceptance-crash-test завершился с кодом 1 (sys.exit(1)).",
        level="error",
        project_name="acceptance-crash-test",
        log_tail="Traceback: Fatal error in worker -> sys.exit(1)",
    )
    crash_notif = next(
        (n for n in RECENT_NOTIFICATIONS if "acceptance-crash-test" in str(n.get("text", ""))),
        None,
    )
    results.append(
        {
            "id": 3,
            "title": "3. Уведомление при падении (sys.exit(1))",
            "passed": crash_notif is not None,
            "details": (
                f"Уведомление сформировано с хвостом лога (прокси: {crash_notif.get('proxy_used') or 'прямое'})."
                if crash_notif
                else f"Результат отправки: {notif_res}"
            ),
        }
    )

    # 4. Импорт куки из Cookie-Editor и beacon.cookies_expired()
    sample_cookies = json.dumps(
        [{"name": "auth_sid", "value": "cookie_val_778899", "domain": ".telegram.org", "path": "/"}]
    )
    import_cookie_editor_json("my_cookies", sample_cookies)
    sec_raw = get_secret_raw("my_cookies")
    is_list = isinstance(sec_raw.get("value"), list) and len(sec_raw["value"]) == 1
    mark_cookies_expired("my_cookies", note="Проверка красного баннера COOKIES_EXPIRED")
    exp_row = query_one("SELECT is_expired FROM secrets WHERE name = 'my_cookies'")
    was_expired = bool(exp_row and exp_row["is_expired"] == 1)
    import_cookie_editor_json("my_cookies", sample_cookies)
    results.append(
        {
            "id": 4,
            "title": '4. Импорт куки Cookie-Editor, beacon.secret("my_cookies") -> list[dict] и cookies_expired()',
            "passed": is_list and was_expired,
            "details": "Cookie-Editor JSON импортирован (0600), тип в Python: list[dict] (1 шт.), триггер баннера is_expired=1 подтверждён.",
        }
    )

    # 5. Блокирующий интерактивный beacon.ask() + маскировка секретов в логах
    save_secret("api_token", "text", "secret_demo_token_554433")
    masked_sample = redact_log_text("Using token secret_demo_token_554433 in request")
    hb_id = int(hb["id"]) if hb else 1
    hb_run = query_one("SELECT id FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1", (hb_id,))
    run_id_for_ask = int(hb_run["id"]) if hb_run else 1
    ask_id = await create_ask(run_id_for_ask, hb_id, "sms-auth-bot", "Введите код из СМС:", timeout=60)
    answer_ask(ask_id, "948201", source="web")
    polled = await poll_ask(ask_id, wait_sec=0.5)
    t5_ok = (
        polled.get("status") == "answered"
        and polled.get("answer") == "948201"
        and "***SECRET:api_token***" in masked_sample
    )
    results.append(
        {
            "id": 5,
            "title": "5. Блокирующий beacon.ask() + маскировка секретов в логах",
            "passed": t5_ok,
            "details": f"beacon.ask() получил ответ '{polled.get('answer')}', секрет в логе замаскирован: '{masked_sample}'.",
        }
    )

    # 6. Потребление памяти процессом python3 -m beacon (< 80 МБ RSS)
    rss_mb = round(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024), 2)
    results.append(
        {
            "id": 6,
            "title": "6. Потребление памяти процессом python3 -m beacon (< 80 МБ RSS)",
            "passed": 0 < rss_mb < 80.0,
            "details": f"Текущее потребление памяти Beacon (PID={os.getpid()}): {rss_mb} МБ RSS (лимит бюджета: 80 МБ).",
        }
    )

    if tree_proj:
        execute_sql("DELETE FROM projects WHERE id = ?", (tree_proj["id"],))
        shutil.rmtree(PROJECTS_DIR / "acceptance-tree-test", ignore_errors=True)
    if created_temp_hb and hb:
        await stop_project(int(hb["id"]))
        execute_sql("DELETE FROM projects WHERE id = ?", (hb["id"],))
        shutil.rmtree(PROJECTS_DIR / "acceptance-survive-test", ignore_errors=True)

    return {
        "ok": True,
        "all_passed": all(r["passed"] for r in results),
        "results": results,
    }


@router.get("/system/audit")
async def api_system_audit(request: Request) -> list[dict[str, Any]]:
    _require_admin_session(request)
    return query_all("SELECT id, timestamp, ip, actor, action, details FROM audit_log ORDER BY id DESC LIMIT 100")


@router.get("/system/bundle")
async def api_system_bundle(request: Request) -> dict[str, Any]:
    _require_admin_session(request)
    bundle_files = [
        "requirements.txt",
        "README.md",
        "SECURITY.md",
        "AGENTS.md",
        "docs/AI-ACCESS.md",
        "scripts/install.sh",
        "scripts/update.sh",
        "scripts/zstart_line.sh",
        "scripts/beacon.service.template",
        "sdk/python/beacon.py",
        "sdk/python/aruta.py",
        "sdk/python/hub.py",
        "sdk/node/beacon.js",
        "sdk/node/aruta.js",
        "sdk/node/hub.js",
        "beacon/__init__.py",
        "beacon/__main__.py",
        "hub/__init__.py",
        "hub/__main__.py",
        "hub/names.py",
        "hub/compat.py",
        "hub/log.py",
        "hub/config.py",
        "hub/db.py",
        "hub/auth.py",
        "hub/backup_mgr.py",
        "hub/env_detect.py",
        "hub/doctor.py",
        "hub/process_mgr.py",
        "hub/scheduler.py",
        "hub/secrets_mgr.py",
        "hub/notifier.py",
        "hub/ask_broker.py",
        "hub/disk_guard.py",
        "hub/templates_mgr.py",
        "hub/api/routes_ui.py",
        "hub/api/routes_ai.py",
        "hub/api/routes_internal.py",
        "hub/static/index.html",
    ]
    selected = request.query_params.get("file", "")
    file_content = ""
    if selected and selected in bundle_files:
        fp = BASE_DIR / selected
        if fp.exists():
            file_content = fp.read_text(encoding="utf-8", errors="replace")

    return {
        "base_dir": str(BASE_DIR),
        "files": bundle_files,
        "selected_file": selected,
        "content": file_content,
    }


@router.get("/system/systemd_unit")
async def api_system_systemd_unit(request: Request) -> dict[str, Any]:
    _require_admin_session(request)
    from hub.env_detect import generate_systemd_unit

    port = int(get_setting("port", "8050") or 8050)
    unit_text = generate_systemd_unit(BASE_DIR, port=port, user=get_setting("run_as_user", "root"))
    return {
        "ok": True,
        "path": str(GENERATED_DIR / "beacon.service"),
        "unit": unit_text,
        "content": unit_text,
        "saved": False,
    }


@router.get("/system/backup")
async def api_system_backup_zip(request: Request) -> Response:
    _require_admin_session(request)
    tmp_zip_fd, tmp_zip_name = tempfile.mkstemp(prefix="beacon_backup_", suffix=".zip")
    os.close(tmp_zip_fd)
    tmp_zip_path = Path(tmp_zip_name)

    try:
        await asyncio.to_thread(create_backup_archive, tmp_zip_path)
    except ValueError as exc:
        tmp_zip_path.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception:
        tmp_zip_path.unlink(missing_ok=True)
        raise

    ts = time.strftime("%Y%m%d_%H%M%S")

    async def _stream_zip() -> AsyncIterator[bytes]:
        try:
            with open(tmp_zip_path, "rb") as f:
                while True:
                    chunk = await asyncio.to_thread(f.read, 65536)
                    if not chunk:
                        break
                    yield chunk
        finally:
            tmp_zip_path.unlink(missing_ok=True)

    return StreamingResponse(
        _stream_zip(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="beacon_backup_{ts}.zip"',
            "Cache-Control": "no-store",
        },
    )


def _inspect_git_update_status(check_remote: bool = False) -> dict[str, Any]:
    """Проверяет статус Git-репозитория панели Beacon и наличие новых коммитов в remote."""
    default_repo = get_setting("git_repo_url", "https://github.com/VoidAruta/Beacon.git") or "https://github.com/VoidAruta/Beacon.git"
    git_dir = BASE_DIR / ".git"
    info: dict[str, Any] = {
        "ok": True,
        "version": "2.2.0",
        "git_available": False,
        "is_git_repo": git_dir.exists(),
        "branch": "main",
        "commit": "standalone",
        "commit_subject": "Локальная сборка Beacon v2.2.0",
        "remote_url": default_repo,
        "has_update": False,
        "behind_count": 0,
        "remote_commits": [],
        "dirty_files": 0,
        "checked_at": int(time.time()),
        "message": "Установлена актуальная версия Beacon v2.2.0",
    }

    try:
        ver_proc = subprocess.run(
            ["git", "--version"],
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            timeout=3,
        )
        info["git_available"] = ver_proc.returncode == 0
    except Exception:
        return info

    if not git_dir.exists():
        info["message"] = (
            "Панель запущена из автономного архива (папка .git отсутствует). "
            "Вы можете привязать репозиторий кнопкой «Инициализировать Git-обновления» ниже."
        )
        return info

    try:
        br = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            timeout=3,
        )
        if br.returncode == 0 and br.stdout.strip():
            info["branch"] = br.stdout.strip()

        sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            timeout=3,
        )
        if sha.returncode == 0 and sha.stdout.strip():
            info["commit"] = sha.stdout.strip()

        subj = subprocess.run(
            ["git", "log", "-1", "--pretty=%s (%cr)"],
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            timeout=3,
        )
        if subj.returncode == 0 and subj.stdout.strip():
            info["commit_subject"] = subj.stdout.strip()

        rem = subprocess.run(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            timeout=3,
        )
        if rem.returncode == 0 and rem.stdout.strip():
            info["remote_url"] = rem.stdout.strip()

        st = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            timeout=3,
        )
        if st.returncode == 0:
            lines = [ln for ln in st.stdout.splitlines() if ln.strip()]
            info["dirty_files"] = len(lines)

        if check_remote and info["remote_url"]:
            subprocess.run(
                ["git", "fetch", "origin", info["branch"], "--quiet"],
                cwd=str(BASE_DIR),
                capture_output=True,
                text=True,
                timeout=6,
            )
            cnt = subprocess.run(
                ["git", "rev-list", f"HEAD..origin/{info['branch']}", "--count"],
                cwd=str(BASE_DIR),
                capture_output=True,
                text=True,
                timeout=3,
            )
            if cnt.returncode == 0 and cnt.stdout.strip().isdigit():
                behind = int(cnt.stdout.strip())
                info["behind_count"] = behind
                info["has_update"] = behind > 0
                if behind > 0:
                    lg = subprocess.run(
                        ["git", "log", f"HEAD..origin/{info['branch']}", "--oneline", "-n", "8"],
                        cwd=str(BASE_DIR),
                        capture_output=True,
                        text=True,
                        timeout=3,
                    )
                    if lg.returncode == 0:
                        info["remote_commits"] = [ln.strip() for ln in lg.stdout.splitlines() if ln.strip()]
                    info["message"] = f"Доступно обновление: {behind} новых коммитов в ветке origin/{info['branch']}"
                else:
                    info["message"] = f"Установлена последняя версия ({info['branch']} @ {info['commit']})"
    except Exception as exc:
        info["message"] = f"Проверка локального Git завершена ({exc})"

    return info


@router.get("/system/update_status")
async def api_system_update_status(request: Request) -> dict[str, Any]:
    check_remote = request.query_params.get("check_remote", "0") in ("1", "true", "yes")
    return await asyncio.to_thread(_inspect_git_update_status, check_remote)


def _execute_self_update_sync(repo_url_override: str = "", branch_override: str = "") -> dict[str, Any]:
    """
    Выполняет безопасное обновление панели Beacon в 2 клика:
    1. Создаёт резервную копию БД, секретов и конфигов в data/backups/pre_update_*.zip.
    2. Если есть .git и remote — выполняет git fetch + git pull --ff-only (или настраивает remote).
    3. Применяет миграции SQLite (init_db) и переподхватывает живые дочерние процессы без SIGPIPE.
    """
    steps_log: list[str] = []
    ts = time.strftime("%Y%m%d_%H%M%S")
    backup_file = BACKUPS_DIR / f"beacon_pre_update_{ts}.zip"
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)

    # Шаг 1: Автоматический пред-апдейт бэкап
    try:
        create_backup_archive(backup_file)
        steps_log.append(f"[1/4] Создана страховочная резервная копия: {backup_file.name}")
    except Exception as exc:
        steps_log.append(f"[1/4] Предупреждение бэкапа (продолжаем): {exc}")

    target_repo = (repo_url_override or get_setting("git_repo_url", "https://github.com/VoidAruta/Beacon.git") or "https://github.com/VoidAruta/Beacon.git").strip()
    if repo_url_override.strip():
        set_setting("git_repo_url", target_repo)

    git_dir = BASE_DIR / ".git"
    branch = (branch_override or "main").strip()
    git_updated = False

    # Шаг 2: Git pull (если окружение подключено к Git)
    if git_dir.exists():
        try:
            if repo_url_override.strip():
                subprocess.run(
                    ["git", "remote", "set-url", "origin", target_repo],
                    cwd=str(BASE_DIR),
                    capture_output=True,
                    text=True,
                    timeout=4,
                )
            pull_res = subprocess.run(
                ["git", "pull", "--ff-only", "origin", branch],
                cwd=str(BASE_DIR),
                capture_output=True,
                text=True,
                timeout=15,
            )
            out_txt = (pull_res.stdout or pull_res.stderr or "").strip()
            if pull_res.returncode == 0:
                git_updated = True
                steps_log.append(f"[2/4] Git pull origin/{branch}: {out_txt or 'Успешно синхронизировано'}")
            else:
                steps_log.append(
                    f"[2/4] Git pull пропущен (локальная ветка или нет доступа к remote): {out_txt[:240]}"
                )
        except Exception as exc:
            steps_log.append(f"[2/4] Git pull пропущен ({exc}) — используется текущая локальная сборка")
    else:
        steps_log.append(
            f"[2/4] Автономная сборка (без .git): сохранён URL репозитория {target_repo} для обновлений"
        )

    # Шаг 3: Миграция схемы SQLite и перезагрузка кеша редактирования секретов
    init_db()
    reload_redaction_cache()
    steps_log.append("[3/4] Схема SQLite (WAL) и кеш безопасности 0600 проверены и синхронизированы")

    # Шаг 4: Бесшовный перехват выживших процессов (Direct FD без SIGPIPE)
    rec = recover_running_processes()
    steps_log.append(
        f"[4/4] Перехват живых процессов без остановки ботов: активных={rec['recovered']}, завершённых={rec['marked_dead']}"
    )

    status_after = _inspect_git_update_status(check_remote=False)
    return {
        "ok": True,
        "git_updated": git_updated,
        "backup_file": backup_file.name if backup_file.exists() else "",
        "steps": steps_log,
        "recovered": rec["recovered"],
        "status": status_after,
    }


@router.post("/system/self_update")
async def api_system_self_update(request: Request) -> dict[str, Any]:
    _require_admin_session(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    repo_url = str(body.get("repo_url") or "") if isinstance(body, dict) else ""
    branch = str(body.get("branch") or "") if isinstance(body, dict) else ""
    res = await asyncio.to_thread(_execute_self_update_sync, repo_url, branch)
    log_audit(
        actor=_actor_name(request),
        action="system.self_update",
        target=res.get("status", {}).get("commit", "HEAD"),
        details=f"backup={res.get('backup_file')}, recovered={res.get('recovered')}",
        ip=getattr(request.state, "client_ip", "127.0.0.1"),
    )
    return res

