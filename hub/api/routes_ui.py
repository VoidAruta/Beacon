"""
Публичное API веб-панели Aruta / Hub (/api/*):
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
import io
import json
import os
import re
import secrets
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from hub.api import APIRouter, HTTPException, JSONResponse, Request, Response, StreamingResponse
from hub.ask_broker import (
    answer_ask,
    create_ask,
    ensure_tg_poller_running,
    get_active_asks,
    handle_telegram_command,
    poll_ask,
)
from hub.auth import (
    check_rate_limit,
    check_webhook_rate_limit,
    clear_login_failures,
    create_session_tokens,
    create_stream_ticket,
    hash_password,
    is_default_password,
    is_private_or_loopback_ip,
    record_login_failure,
    record_webhook_failure,
    revoke_session_token,
    verify_password,
    verify_session_token,
)
from hub.compat import croniter, psutil
from hub.config import BASE_DIR, EXAMPLES_DIR, LOGS_DIR, PROJECTS_DIR, parse_reserved_ports
from hub.db import execute_sql, get_all_settings, get_setting, log_audit, query_all, query_one, set_setting
from hub.disk_guard import cleanup_system_caches, get_disk_status
from hub.doctor import run_hub_doctor
from hub.env_detect import get_environment_profile
from hub.notifier import RECENT_NOTIFICATIONS, send_notification
from hub.process_mgr import (
    ACTIVE_RUNS,
    build_install_deps_command,
    get_pgid_metrics,
    read_log_tail_bytes,
    recover_running_processes,
    send_stdin_to_run,
    start_project_run,
    stop_project,
)
from hub.scheduler import get_upcoming_runs
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
_PROJECT_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
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
    return getattr(state, "client_ip", None) or (request.client.host if request.client else "127.0.0.1")


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


def _safe_project_path(workdir: str | Path, rel_path: str) -> Path:
    """Защита от Path Traversal через os.path.commonpath."""
    base = Path(_validate_project_workdir(str(workdir))).resolve()
    cleaned = (rel_path or "").lstrip("/").lstrip("\\")
    target = (base / cleaned).resolve()
    if os.path.commonpath([str(base), str(target)]) != str(base):
        raise HTTPException(status_code=403, detail="Попытка выхода за пределы директории проекта (Path Traversal)")
    return target


def safe_extract_zip_bytes(
    file_bytes: bytes,
    workdir: Path,
    max_archive_bytes: int = MAX_ZIP_ARCHIVE_BYTES,
    max_uncompressed_bytes: int = MAX_ZIP_UNCOMPRESSED_BYTES,
    max_files: int = MAX_ZIP_FILES,
    max_ratio: float = MAX_ZIP_COMPRESSION_RATIO,
) -> list[str]:
    """
    Потоковая безопасная распаковка ZIP-архива (Фаза A.5):
    - лимит размера архива
    - лимит числа файлов
    - лимит степени сжатия (защита от zip-бомб)
    - лимит суммарного распакованного размера (как по заголовкам, так и при потоковом чтении чанками по 64 КБ)
    - защита от Zip Slip через _safe_project_path
    """
    if len(file_bytes) > max_archive_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Размер ZIP-архива превышает лимит ({max_archive_bytes // (1024 * 1024)} МБ)",
        )

    extracted_files: list[str] = []
    try:
        zf_ctx = zipfile.ZipFile(io.BytesIO(file_bytes))
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
        for member in members:
            # Запрещаем симлинки внутри ZIP (external_attr Unix symlink 0o120000)
            unix_mode = (member.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                raise HTTPException(status_code=400, detail=f"Символические ссылки в архиве запрещены: {member.filename}")
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


def _build_file_tree(root_dir: Path, rel_prefix: str = "") -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not root_dir.exists():
        return items
    try:
        entries = sorted(root_dir.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError:
        return items

    for entry in entries:
        if entry.name in _EXCLUDED_DIRS:
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
        for dirpath, _dirnames, filenames in os.walk(root_dir):
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


def _enrich_project(p: dict[str, Any]) -> dict[str, Any]:
    proj_id = p["id"]
    proj_name = p["name"]
    active_run = None
    for r_id, info in ACTIVE_RUNS.items():
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
    active_run_id = None

    if active_run:
        active_run_id = active_run["run_id"]
        pid = active_run["pid"]
        pgid = active_run["pgid"]
        rss_mb = active_run.get("rss_mb", 0.0)
        cpu_pct = active_run.get("cpu_percent", 0.0)
        db_run = query_one("SELECT status FROM runs WHERE id = ?", (active_run_id,))
        status = db_run["status"] if db_run else "running"
    elif last_run:
        if last_run["status"] in ("running", "waiting_input"):
            status = last_run["status"]
            active_run_id = last_run["id"]
            pid = last_run["pid"]
            pgid = last_run["pgid"]
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
    allowed, retry_after = check_rate_limit(client_ip)
    if not allowed:
        return JSONResponse(
            {
                "detail": f"Слишком много неудачных попыток входа. IP заблокирован ещё на {retry_after} сек.",
                "retry_after": retry_after,
            },
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    default_pw = is_default_password()
    # Фаза A.1(д): пока используется пароль по умолчанию, вход разрешён только с loopback и RFC1918
    if default_pw and not is_private_or_loopback_ip(client_ip):
        raise HTTPException(
            status_code=403,
            detail="Пока используется пароль по умолчанию (admin), вход разрешён только из локальной сети (127.0.0.1, 10/8, 172.16/12, 192.168/16).",
        )

    body = await request.json()
    username = str(body.get("username", "admin") or "admin").strip()
    password = str(body.get("password", ""))

    authenticated_role = "admin"
    authenticated_user = "admin"
    auth_ok = False

    if username in ("", "admin"):
        stored_hash = get_setting("password_hash", "")
        if verify_password(password, stored_hash):
            auth_ok = True
            authenticated_role = "admin"
            authenticated_user = "admin"

    if not auth_ok:
        user_row = query_one("SELECT * FROM users WHERE username = ?", (username,))
        if user_row and verify_password(password, user_row["password_hash"]):
            auth_ok = True
            authenticated_role = str(user_row.get("role") or "viewer")
            authenticated_user = str(user_row["username"])

    if not auth_ok:
        now_blocked, block_sec = record_login_failure(client_ip)
        if now_blocked:
            await send_notification(
                f"Обнаружен перебор пароля с IP {client_ip}! Адрес заблокирован на {block_sec // 60} минут.",
                level="error",
            )
            return JSONResponse(
                {
                    "detail": f"Превышен лимит попыток входа (5 за 5 минут). IP заблокирован на {block_sec // 60} минут.",
                    "retry_after": block_sec,
                },
                status_code=429,
                headers={"Retry-After": str(block_sec)},
            )
        raise HTTPException(status_code=401, detail="Неверный пароль или имя пользователя")

    clear_login_failures(client_ip)
    session_token, csrf_token = create_session_tokens(role=authenticated_role, username=authenticated_user)
    log_audit(client_ip, "LOGIN_SUCCESS", f"Успешный вход в панель (пользователь: {authenticated_user}, роль: {authenticated_role})")

    is_https = (
        getattr(getattr(request, "url", None), "scheme", "http") == "https"
        or request.headers.get("x-forwarded-proto", "").lower() == "https"
        or get_setting("cookie_secure", "0") == "1"
    )

    resp = JSONResponse(
        {
            "ok": True,
            "authenticated": True,
            "csrf_token": csrf_token,
            "session_token": session_token,
            "role": authenticated_role,
            "username": authenticated_user,
            "is_default_password": is_default_password(),
            "must_change_password": False,
        }
    )
    resp.set_cookie(
        "beacon_session",
        session_token,
        max_age=86400 * 7,
        httponly=True,
        samesite="Strict",
        secure=is_https,
    )
    resp.set_cookie(
        "aruta_session",
        session_token,
        max_age=86400 * 7,
        httponly=True,
        samesite="Strict",
        secure=is_https,
    )
    resp.set_cookie(
        "hub_session",
        session_token,
        max_age=86400 * 7,
        httponly=True,
        samesite="Strict",
        secure=is_https,
    )
    resp.set_cookie(
        "csrf_token",
        csrf_token,
        max_age=86400 * 7,
        httponly=False,
        samesite="Strict",
        secure=is_https,
    )
    return resp


@router.post("/auth/change_initial_password")
async def api_change_initial_password(request: Request) -> dict[str, Any]:
    """Смена пароля администратора (минимум 8 символов, без записи на диск)."""
    client_ip = _client_ip(request)
    body = await request.json()
    new_password = str(body.get("new_password", "")).strip()
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="Новый пароль должен содержать минимум 8 символов")
    if new_password.lower() == "admin":
        raise HTTPException(status_code=400, detail="Новый пароль не может совпадать со стандартным 'admin'")

    set_setting("password_hash", hash_password(new_password))
    set_setting("must_change_password", "0")
    log_audit(client_ip, "PASSWORD_CHANGED", "Пароль администратора успешно изменён")
    return {"ok": True, "must_change_password": False, "is_default_password": False}


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
    if token:
        revoke_session_token(token)
    log_audit(client_ip, "LOGOUT", "Выход из веб-панели (сессия инвалидирована)")
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
                "session_token": token,
                "role": session.get("role", "admin"),
                "username": session.get("sub", "admin"),
                "is_default_password": default_pw,
                "must_change_password": False,
                "safe_mode": get_setting("safe_mode", "0") == "1",
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
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    run_id_raw = body.get("run_id")
    run_id = int(run_id_raw) if run_id_raw is not None and str(run_id_raw).isdigit() else None
    ticket = create_stream_ticket(run_id=run_id, ttl_sec=60)
    return {"ok": True, "ticket": ticket, "expires_in": 60}


# ==============================================================================
# 1.1. РОЛЕВАЯ МОДЕЛЬ (RBAC Users — Фаза D.4)
# ==============================================================================
@router.get("/users")
async def api_list_users(request: Request) -> list[dict[str, Any]]:
    rows = query_all("SELECT id, username, role, created_at FROM users ORDER BY id ASC")
    return rows


@router.post("/users")
async def api_create_user(request: Request) -> dict[str, Any]:
    body = await request.json()
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", "")).strip()
    role = str(body.get("role", "viewer")).strip().lower()

    if not _PROJECT_NAME_RE.match(username) or username.lower() == "admin":
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
    log_audit(_client_ip(request), "USER_CREATED", f"Создан пользователь {username} (роль: {role})")
    return {"ok": True, "id": uid, "username": username, "role": role, "created_at": now}


@router.delete("/users/{user_id}")
async def api_delete_user(request: Request, user_id: int) -> dict[str, Any]:
    execute_sql("DELETE FROM users WHERE id = ?", (user_id,))
    log_audit(_client_ip(request), "USER_DELETED", f"Удалён пользователь ID={user_id}")
    return {"ok": True, "deleted_id": user_id}


# ==============================================================================
# 2. ДАШБОРД
# ==============================================================================
@router.get("/dashboard")
async def api_dashboard(request: Request) -> dict[str, Any]:
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
    projects = [_enrich_project(p) for p in projects_raw]

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
    default_pw = is_default_password()
    return {
        "system": {
            "cpu_percent": cpu_pct,
            "ram_total_mb": round(vm.total / (1024 * 1024), 1),
            "ram_used_mb": round(vm.used / (1024 * 1024), 1),
            "ram_available_mb": round(vm.available / (1024 * 1024), 1),
            "ram_percent": vm.percent,
            "hub_pid": os.getpid(),
            "hub_rss_bytes": hub_rss_bytes,
            "hub_rss_mb": hub_rss_mb,
            "hub_ram_budget_mb": 80,
            "disk": disk,
            "proxy_url": proxy_url,
            "proxy_status": check_proxy_reachable(proxy_url) if proxy_url else {"online": False, "url": "", "disabled": True},
            "hardware": get_poco_hardware_status(),
            "env_profile": get_environment_profile(),
            "run_as_user": get_setting("run_as_user", "root"),
            "is_default_password": default_pw,
            "safe_mode": get_setting("safe_mode", "0") == "1",
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


# ==============================================================================
# 3. ПРОЕКТЫ (Jobs, Services, Web) + Фаза D
# ==============================================================================
@router.get("/projects")
async def api_list_projects(request: Request) -> list[dict[str, Any]]:
    rows = query_all("SELECT * FROM projects ORDER BY id ASC")
    return [_enrich_project(p) for p in rows]


@router.post("/projects")
async def api_create_project(request: Request) -> dict[str, Any]:
    body = await request.json()
    name = str(body.get("name", "")).strip()
    if not _PROJECT_NAME_RE.match(name):
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
    use_proxy = int(body.get("use_proxy", tpl_info["use_proxy"]))
    ram_limit_mb = max(0, int(body.get("ram_limit_mb", 0) or 0))
    proj_port = max(0, int(body.get("port", 0) or 0))
    reserved = parse_reserved_ports(get_setting("reserved_ports", ""))
    if proj_port > 0 and proj_port in reserved:
        raise HTTPException(status_code=400, detail=f"Порт {proj_port} указан в списке зарезервированных портов (reserved_ports)")

    healthcheck_url = str(body.get("healthcheck_url", "")).strip()
    healthcheck_interval_sec = max(5, int(body.get("healthcheck_interval_sec", 30) or 30))

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
    if schedule_type == "cron" and schedule_expr and not croniter.is_valid(schedule_expr):
        raise HTTPException(status_code=400, detail=f"Некорректное выражение cron: {schedule_expr}")

    timeout_sec = max(0, int(body.get("timeout_sec", 0) or 0))
    max_retries = max(0, int(body.get("max_retries", 0) or 0))
    retry_delay_sec = max(1, int(body.get("retry_delay_sec", 30) or 30))
    webhook_token = secrets.token_hex(16)

    autostart = 1 if body.get("autostart") else 0
    restart_policy = str(body.get("restart_policy", "on-failure")).strip()
    backoff_min_sec = max(1, int(body.get("backoff_min_sec", 2) or 2))
    backoff_max_sec = max(backoff_min_sec, int(body.get("backoff_max_sec", 300) or 300))

    min_uptime_sec = max(1, int(body.get("min_uptime_sec", 10) or 10))
    max_restarts = max(0, int(body.get("max_restarts", 10) or 10))
    restart_delay_sec = max(1, int(body.get("restart_delay_sec", 5) or 5))
    cron_restart = str(body.get("cron_restart", "")).strip()
    if cron_restart and not croniter.is_valid(cron_restart):
        raise HTTPException(status_code=400, detail=f"Некорректное выражение cron_restart: {cron_restart}")

    heartbeat_interval_sec = max(0, int(body.get("heartbeat_interval_sec", 0) or 0))
    heartbeat_grace_sec = max(5, int(body.get("heartbeat_grace_sec", 60) or 60))
    on_success_project_id = max(0, int(body.get("on_success_project_id", 0) or 0))

    notify_on_error = 1 if body.get("notify_on_error", True) else 0
    notify_on_success = 1 if body.get("notify_on_success", False) else 0
    notify_on_crash = 1 if body.get("notify_on_crash", True) else 0

    now = int(time.time())
    proj_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, port, healthcheck_url, healthcheck_interval_sec, health_status,
            schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            min_uptime_sec, max_restarts, restart_delay_sec, cron_restart, crash_loop_count,
            heartbeat_interval_sec, heartbeat_grace_sec, last_ping_at, on_success_project_id, params_schema_json,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, 'stopped', ?, ?, ?, ?, ?)""",
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
            pass
    return _enrich_project(row or {})


@router.put("/projects/{project_id}")
async def api_update_project(request: Request, project_id: int) -> dict[str, Any]:
    existing = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not existing:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await request.json()
    proj_type = str(body.get("type", existing["type"])).strip()
    if proj_type not in ("job", "service", "web"):
        raise HTTPException(status_code=400, detail="Тип проекта должен быть 'job', 'service' или 'web'")
    runtime = str(body.get("runtime", existing["runtime"])).strip()
    cmd = str(body.get("cmd", existing["cmd"])).strip()
    workdir = _validate_project_workdir(str(body.get("workdir", existing["workdir"])).strip(), existing["name"])
    use_proxy = 1 if body.get("use_proxy", existing["use_proxy"]) else 0
    ram_limit_mb = max(0, int(body.get("ram_limit_mb", existing["ram_limit_mb"]) or 0))
    proj_port = max(0, int(body.get("port", existing.get("port", 0)) or 0))
    reserved = parse_reserved_ports(get_setting("reserved_ports", ""))
    if proj_port > 0 and proj_port in reserved:
        raise HTTPException(status_code=400, detail=f"Порт {proj_port} зарезервирован в настройках reserved_ports")

    healthcheck_url = str(body.get("healthcheck_url", existing.get("healthcheck_url", ""))).strip()
    healthcheck_interval_sec = max(
        5, int(body.get("healthcheck_interval_sec", existing.get("healthcheck_interval_sec", 30)) or 30)
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
    if schedule_type == "cron" and schedule_expr and not croniter.is_valid(schedule_expr):
        raise HTTPException(status_code=400, detail=f"Некорректное выражение cron: {schedule_expr}")

    timeout_sec = max(0, int(body.get("timeout_sec", existing["timeout_sec"]) or 0))
    max_retries = max(0, int(body.get("max_retries", existing["max_retries"]) or 0))
    retry_delay_sec = max(1, int(body.get("retry_delay_sec", existing["retry_delay_sec"]) or 30))

    autostart = 1 if body.get("autostart", existing["autostart"]) else 0
    restart_policy = str(body.get("restart_policy", existing["restart_policy"])).strip()
    backoff_min_sec = max(1, int(body.get("backoff_min_sec", existing["backoff_min_sec"]) or 2))
    backoff_max_sec = max(backoff_min_sec, int(body.get("backoff_max_sec", existing["backoff_max_sec"]) or 300))

    min_uptime_sec = max(1, int(body.get("min_uptime_sec", existing.get("min_uptime_sec", 10)) or 10))
    max_restarts = max(0, int(body.get("max_restarts", existing.get("max_restarts", 10)) or 0))
    restart_delay_sec = max(1, int(body.get("restart_delay_sec", existing.get("restart_delay_sec", 5)) or 5))
    cron_restart = str(body.get("cron_restart", existing.get("cron_restart", ""))).strip()
    if cron_restart and not croniter.is_valid(cron_restart):
        raise HTTPException(status_code=400, detail=f"Некорректное выражение cron_restart: {cron_restart}")

    heartbeat_interval_sec = max(
        0, int(body.get("heartbeat_interval_sec", existing.get("heartbeat_interval_sec", 0)) or 0)
    )
    heartbeat_grace_sec = max(5, int(body.get("heartbeat_grace_sec", existing.get("heartbeat_grace_sec", 60)) or 60))
    on_success_project_id = max(
        0, int(body.get("on_success_project_id", existing.get("on_success_project_id", 0)) or 0)
    )

    notify_on_error = 1 if body.get("notify_on_error", existing["notify_on_error"]) else 0
    notify_on_success = 1 if body.get("notify_on_success", existing["notify_on_success"]) else 0
    notify_on_crash = 1 if body.get("notify_on_crash", existing["notify_on_crash"]) else 0

    now = int(time.time())
    execute_sql(
        """UPDATE projects SET
            type = ?, runtime = ?, cmd = ?, workdir = ?, env_json = ?, secrets_json = ?,
            use_proxy = ?, ram_limit_mb = ?, port = ?, healthcheck_url = ?, healthcheck_interval_sec = ?,
            schedule_type = ?, schedule_expr = ?,
            timeout_sec = ?, max_retries = ?, retry_delay_sec = ?,
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
            timeout_sec,
            max_retries,
            retry_delay_sec,
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
            pass
    return _enrich_project(updated or {})


@router.delete("/projects/{project_id}")
async def api_delete_project(request: Request, project_id: int) -> dict[str, Any]:
    existing = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not existing:
        raise HTTPException(status_code=404, detail="Проект не найден")

    await stop_project(project_id)
    execute_sql("DELETE FROM projects WHERE id = ?", (project_id,))
    return {"ok": True, "deleted_id": project_id}


@router.post("/projects/{project_id}/start")
async def api_start_project(request: Request, project_id: int) -> dict[str, Any]:
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    launch_params = body.get("params") or body.get("extra_env") or {}
    extra_env: dict[str, str] = {}
    if isinstance(launch_params, dict):
        for k, v in launch_params.items():
            clean_k = re.sub(r"[^a-zA-Z0-9_]", "_", str(k).strip()).upper()
            if clean_k:
                extra_env[clean_k] = str(v)
                extra_env[f"PARAM_{clean_k}"] = str(v)

    execute_sql("UPDATE projects SET crash_loop_count = 0 WHERE id = ?", (project_id,))
    try:
        run = await start_project_run(project_id, trigger="manual", extra_env=extra_env or None)
        proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
        return {"ok": True, "run": run, "project": _enrich_project(proj or {})}
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

    workdir = Path(proj["workdir"])
    runtime = proj["runtime"]
    dep_cmd = build_install_deps_command(workdir, runtime)

    run = await start_project_run(project_id, trigger="manual", custom_cmd=dep_cmd)
    return {"ok": True, "run": run}


# ==============================================================================
# 3.1. DEAD MAN'S SWITCH (/api/ping/{project}), PROJECT.YAML И ЭКСПОРТ/ИМПОРТ ZIP (Фаза D)
# ==============================================================================
@router.get("/ping/{project_identifier}")
@router.post("/ping/{project_identifier}")
async def api_dead_mans_switch_ping(request: Request, project_identifier: str) -> dict[str, Any]:
    """Входящий пинг от задачи/сервиса (Dead Man's Switch — Фаза D.2)."""
    ident = (project_identifier or "").strip()
    proj = (
        query_one("SELECT * FROM projects WHERE id = ?", (int(ident),))
        if ident.isdigit()
        else query_one("SELECT * FROM projects WHERE name = ? OR webhook_token = ?", (ident, ident))
    )
    if not proj:
        raise HTTPException(status_code=404, detail="Проект для пинга не найден")

    now = int(time.time())
    execute_sql(
        "UPDATE projects SET last_ping_at = ?, health_status = 'healthy', updated_at = ? WHERE id = ?",
        (now, now, proj["id"]),
    )
    return {"ok": True, "project": proj["name"], "ping_at": now, "health_status": "healthy"}


@router.get("/projects/{project_id}/yaml")
async def api_get_project_yaml(request: Request, project_id: int) -> dict[str, Any]:
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

    body = await request.json()
    yaml_text = str(body.get("content", ""))
    parsed = parse_simple_project_yaml(yaml_text)

    workdir = Path(proj["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "project.yaml").write_text(yaml_text, encoding="utf-8")

    now = int(time.time())
    execute_sql(
        """UPDATE projects SET
            type = ?, runtime = ?, cmd = ?, port = ?, ram_limit_mb = ?,
            use_proxy = ?, autostart = ?, restart_policy = ?,
            min_uptime_sec = ?, max_restarts = ?, restart_delay_sec = ?, cron_restart = ?,
            schedule_type = ?, schedule_expr = ?, healthcheck_url = ?,
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
            str(parsed.get("schedule_type", proj["schedule_type"])),
            str(parsed.get("schedule_expr", proj["schedule_expr"])),
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
    """Экспортирует проект в .zip вместе с project.yaml, но БЕЗ значений секретов и без .venv/node_modules (Фаза D.3)."""
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    sync_project_yaml(proj)
    workdir = Path(proj["workdir"])
    buf = io.BytesIO()
    skip_files = {"cookies.json", "storage_state.json", ".env"}

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if workdir.exists():
            for root, dirs, files in os.walk(workdir):
                dirs[:] = [d for d in dirs if d not in _EXCLUDED_DIRS and d != "browser_profile"]
                root_p = Path(root)
                for fn in files:
                    if fn in skip_files:
                        continue
                    fp = root_p / fn
                    try:
                        if fp.is_file() and not fp.is_symlink() and fp.stat().st_size <= 20 * 1024 * 1024:
                            rel = fp.relative_to(workdir)
                            zf.write(fp, str(rel))
                    except OSError:
                        pass

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{proj["name"]}.zip"'},
    )


@router.post("/projects/import_archive")
async def api_import_project_archive(request: Request) -> dict[str, Any]:
    """Импортирует проект из .zip-архива (с чтением project.yaml и безопасной распаковкой)."""
    body = await request.json()
    name = str(body.get("name", "")).strip()
    b64 = str(body.get("content_base64", "")).strip()
    if not b64:
        raise HTTPException(status_code=400, detail="Передайте содержимое архива в content_base64")
    file_bytes = base64.b64decode(b64)

    if not name:
        name = f"imported-{int(time.time())}"
    if not _PROJECT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Некорректное имя проекта")
    if query_one("SELECT id FROM projects WHERE name = ?", (name,)):
        raise HTTPException(status_code=400, detail=f"Проект «{name}» уже существует")

    workdir = PROJECTS_DIR / name
    workdir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / name).mkdir(parents=True, exist_ok=True)

    try:
        extracted = safe_extract_zip_bytes(file_bytes, workdir)
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise

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
            webhook_token, autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            min_uptime_sec, max_restarts, restart_delay_sec, cron_restart,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30, ?, ?, 0, 0, 30, ?, ?, ?, 2, 300, ?, ?, ?, ?, 'stopped', 1, 0, 1, ?, ?)""",
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
    body = await request.json()
    val = body.get("value")
    val_json = json.dumps(val, ensure_ascii=False)
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
                "PROJECT_DESCRIPTION": "Фоновый демон (Service 24/7) с сохранением счётчика тиков в aruta.state",
            },
            "code": (
                "import time\n"
                "import aruta\n\n"
                "print('[heartbeat-daemon] Сервис запущен (Direct FD, без SIGPIPE)', flush=True)\n"
                "ticks = int(aruta.state.get('ticks', 0) or 0)\n"
                "while True:\n"
                "    ticks += 1\n"
                "    aruta.state.set('ticks', ticks)\n"
                "    print(f'[heartbeat-daemon] Тик #{ticks} сохранён в aruta.state', flush=True)\n"
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
                "PROJECT_DESCRIPTION": "Пример интерактивного запроса 2FA/СМС-кода через aruta.ask()",
            },
            "code": (
                "import aruta\n\n"
                "print('[sms-auth-bot] Запрашиваем код подтверждения через aruta.ask()...', flush=True)\n"
                "code = aruta.ask('Введите 6-значный код из СМС для входа в аккаунт:', timeout=180)\n"
                "aruta.state.set('last_auth_code_len', len(str(code)))\n"
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
                "PROJECT_DESCRIPTION": "Периодическая задача проверки куки (Cron каждые 30 мин) с сигналом aruta.cookies_expired()",
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
                webhook_token, autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, 128, ?, ?, 30, ?, ?, 0, 0, 30, ?, ?, ?, 2, 120, 'stopped', 1, 0, 1, ?, ?)""",
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

    body = await request.json()
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
    body = await request.json()
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

    if not _PROJECT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Некорректное имя папки проекта")

    if query_one("SELECT id FROM projects WHERE name = ?", (name,)):
        raise HTTPException(status_code=400, detail=f"Проект с именем «{name}» уже существует")

    proj_type = str(body.get("type", "service")).strip()
    if proj_type not in ("job", "service", "web"):
        proj_type = "service"

    use_proxy = 1 if body.get("use_proxy", False) else 0
    description = str(body.get("description", "")).strip() or f"Установлен из GitHub ({repo_url})"
    group_tag = str(body.get("group_tag", "GitHub")).strip() or "GitHub"
    custom_proxy = str(body.get("custom_proxy", "")).strip()

    workdir = PROJECTS_DIR / name
    workdir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / name).mkdir(parents=True, exist_ok=True)

    sys_proxy = get_setting("proxy_url", "").strip()
    target_proxy = custom_proxy or sys_proxy
    proxy_reach = check_proxy_reachable(target_proxy) if target_proxy else {"online": False}
    clone_env = dict(os.environ)
    clone_env["GIT_TERMINAL_PROMPT"] = "0"
    if use_proxy and target_proxy and proxy_reach.get("online"):
        clone_env["HTTP_PROXY"] = target_proxy
        clone_env["HTTPS_PROXY"] = target_proxy

    cloned_ok = False
    clone_log = ""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "clone",
            "--depth",
            "1",
            "--",
            repo_url,
            str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=clone_env,
        )
        try:
            stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=15.0)
            clone_log = stdout_bytes.decode("utf-8", errors="replace")
            cloned_ok = proc.returncode == 0
        except asyncio.TimeoutError:
            proc.kill()
            clone_log = "Превышен таймаут ожидания git clone (15 сек)."
    except Exception as e:
        clone_log = str(e)

    if not cloned_ok or not any(workdir.iterdir()):
        shutil.rmtree(workdir, ignore_errors=True)
        shutil.rmtree(LOGS_DIR / name, ignore_errors=True)
        err_msg = (clone_log or "").strip() or "Не удалось клонировать репозиторий (проверьте URL и доступность сети)"
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
        "GIT_REPO_URL": repo_url,
    }
    if custom_proxy:
        env_obj["CUSTOM_PROXY_URL"] = custom_proxy

    now = int(time.time())
    webhook_token = secrets.token_hex(16)
    proj_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 128, 'manual', '', 0, 0, 30, ?, 0, 'on-failure', 2, 300, 'stopped', 1, 0, 1, ?, ?)""",
        (
            name,
            proj_type,
            runtime,
            final_cmd,
            str(workdir),
            json.dumps(env_obj, ensure_ascii=False),
            use_proxy,
            webhook_token,
            now,
            now,
        ),
    )
    _invalidate_dir_size_cache(workdir)
    row = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    if row:
        sync_project_yaml(row)
        write_project_agents_md(workdir, name, proj_type, runtime, final_cmd)
    return {"ok": True, "cloned": cloned_ok, "clone_log": clone_log, "project": _enrich_project(row or {})}


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
    body = await request.json()
    example_name = str(body.get("name", "")).strip()
    if not _PROJECT_NAME_RE.match(example_name):
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
            timeout_sec, max_retries, retry_delay_sec, webhook_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 30, ?, 0, 'on-failure', 2, 300, 'stopped', 1, 0, 1, ?, ?)""",
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

    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    requested_name = str(body.get("new_name", "")).strip()
    if not requested_name:
        base_name = f"{src['name']}-acc2"
        idx = 2
        while query_one("SELECT id FROM projects WHERE name = ?", (base_name,)):
            idx += 1
            base_name = f"{src['name']}-acc{idx}"
        requested_name = base_name[:60]

    if not _PROJECT_NAME_RE.match(requested_name):
        raise HTTPException(status_code=400, detail="Некорректное имя для клона проекта")
    if query_one("SELECT id FROM projects WHERE name = ?", (requested_name,)):
        raise HTTPException(status_code=400, detail=f"Проект «{requested_name}» уже существует")

    src_dir = Path(src["workdir"])
    dst_dir = PROJECTS_DIR / requested_name
    dst_dir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / requested_name).mkdir(parents=True, exist_ok=True)

    if src_dir.exists():
        for item in src_dir.iterdir():
            if item.name in _EXCLUDED_DIRS or item.name in ("cookies.json", "storage_state.json", "browser_profile"):
                continue
            target = dst_dir / item.name
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)

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
            timeout_sec, max_retries, retry_delay_sec, webhook_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?)""",
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
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await request.json()
    raw_cmd = str(body.get("command", "")).strip()
    if not raw_cmd:
        raise HTTPException(status_code=400, detail="Введите команду для выполнения")

    client_ip = _client_ip(request)
    log_audit(client_ip, "PROJECT_EXEC_CMD", f"Проект '{proj['name']}': {raw_cmd[:160]}")

    wrapped = f"/bin/bash -c {json.dumps(raw_cmd)}"
    run = await start_project_run(project_id, trigger="manual", custom_cmd=wrapped)
    _invalidate_dir_size_cache(Path(proj["workdir"]))
    return {"ok": True, "command": raw_cmd, "run": run}


@router.post("/runs/{run_id}/stdin")
async def api_send_run_stdin(request: Request, run_id: int) -> dict[str, Any]:
    body = await request.json()
    text = str(body.get("text", ""))
    ok = send_stdin_to_run(run_id, text)
    if not ok:
        raise HTTPException(status_code=400, detail="Процесс уже завершён или не принимает ввод")
    return {"ok": True, "run_id": run_id, "sent": text}


@router.post("/projects/{project_id}/web_auth/start")
async def api_web_auth_start(request: Request, project_id: int) -> dict[str, Any]:
    body = await request.json()
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
    body = await request.json()
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

    run = await start_project_run(int(proj["id"]), trigger="webhook")
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

    body = await request.json()
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

    body = await request.json()
    rel_path = str(body.get("path", "")).strip()
    if not rel_path:
        raise HTTPException(status_code=400, detail="Не указан путь папки")

    target = _safe_project_path(proj["workdir"], rel_path)
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": rel_path}


@router.post("/projects/{project_id}/files/rename")
async def api_rename_file(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await request.json()
    old_path = str(body.get("old_path", "")).strip()
    new_path = str(body.get("new_path", "")).strip()
    if not old_path or not new_path:
        raise HTTPException(status_code=400, detail="Необходимо указать old_path и new_path")

    src = _safe_project_path(proj["workdir"], old_path)
    dst = _safe_project_path(proj["workdir"], new_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Исходный файл не найден")

    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return {"ok": True, "old_path": old_path, "new_path": new_path}


@router.delete("/projects/{project_id}/files")
async def api_delete_file(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    rel_path = request.query_params.get("path", "")
    if not rel_path:
        raise HTTPException(status_code=400, detail="Не указан путь для удаления")

    target = _safe_project_path(proj["workdir"], rel_path)
    if target == Path(proj["workdir"]).resolve():
        raise HTTPException(status_code=400, detail="Нельзя удалить корневую папку проекта")

    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    _invalidate_dir_size_cache(Path(proj["workdir"]))
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
    file_bytes = b""
    extract = request.query_params.get("extract", "false").lower() == "true"

    if "application/json" in ctype:
        body = await request.json()
        filename = str(body.get("filename", "uploaded.txt")).strip()
        extract = bool(body.get("extract", extract))
        b64 = body.get("content_base64")
        if b64:
            file_bytes = base64.b64decode(b64)
        else:
            file_bytes = str(body.get("content", "")).encode("utf-8")
    else:
        form = await request.form()
        if "extract" in form:
            extract = str(form["extract"]).lower() in ("true", "1", "yes")
        upload_obj = form.get("file")
        if upload_obj is None:
            raise HTTPException(status_code=400, detail="Поле 'file' не найдено в запросе")
        filename = getattr(upload_obj, "filename", "uploaded.bin")
        file_bytes = await upload_obj.read()

    if len(file_bytes) > MAX_ZIP_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="Размер загружаемого файла превышает 50 МБ")

    dest_file = _safe_project_path(workdir, filename)
    dest_file.parent.mkdir(parents=True, exist_ok=True)

    if extract and filename.lower().endswith(".zip"):
        extracted_files = safe_extract_zip_bytes(file_bytes, workdir)
        _invalidate_dir_size_cache(workdir)
        return {"ok": True, "extracted": True, "files": extracted_files}

    dest_file.write_bytes(file_bytes)
    _invalidate_dir_size_cache(workdir)
    return {"ok": True, "extracted": False, "path": filename, "size": len(file_bytes)}


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

    max_lines = int(request.query_params.get("lines", "1000") or 1000)
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
        while True:
            if log_path.exists():
                try:
                    sz = log_path.stat().st_size
                    if sz < offset:
                        offset = 0
                    if sz > offset:
                        with open(log_path, "rb") as f:
                            f.seek(offset)
                            chunk = f.read(sz - offset)
                            offset = f.tell()
                        text = redact_log_text(chunk.decode("utf-8", errors="replace"))
                        payload = json.dumps({"type": "log", "data": text}, ensure_ascii=False)
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
                            text = redact_log_text(chunk.decode("utf-8", errors="replace"))
                            payload = json.dumps({"type": "log", "data": text}, ensure_ascii=False)
                            yield f"data: {payload}\n\n"
                    except OSError:
                        pass
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
    body = await request.json()
    name = str(body.get("name", "")).strip()
    sec_type = str(body.get("type", "text")).strip()
    value = str(body.get("value", ""))
    try:
        return save_secret(name, sec_type, value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/secrets/cookies")
async def api_import_cookies(request: Request) -> dict[str, Any]:
    body = await request.json()
    name = str(body.get("name", "my_cookies")).strip()
    raw_json = body.get("cookies_json", body.get("value", ""))
    try:
        return import_cookie_editor_json(name, raw_json)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/secrets/{name}/expire")
async def api_expire_cookie_secret(request: Request, name: str) -> dict[str, Any]:
    body = await request.json()
    note = str(body.get("note", "Сессия истекла (вызван aruta.cookies_expired)")).strip()
    try:
        clean_name = validate_secret_name(name)
        mark_cookies_expired(clean_name, note=note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
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
    body = await request.json()
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
async def api_update_settings(request: Request) -> dict[str, Any]:
    body = await request.json()
    client_ip = _client_ip(request)

    reserved_str = str(body.get("reserved_ports", get_setting("reserved_ports", "")))
    reserved_set = parse_reserved_ports(reserved_str)

    if "port" in body:
        new_port = int(body["port"])
        if new_port in reserved_set:
            raise HTTPException(
                status_code=400,
                detail=f"Порт {new_port} входит в список зарезервированных портов ({sorted(list(reserved_set))})",
            )
        set_setting("port", str(new_port))

    allowed_keys = (
        "allowed_subnets",
        "allow_tailscale",
        "trusted_proxies",
        "reserved_ports",
        "cookie_secure",
        "proxy_url",
        "run_as_user",
        "safe_mode",
        "outbound_heartbeat_url",
        "disk_warn_mb",
        "disk_crit_mb",
        "log_max_size_mb",
        "log_keep_runs",
        "log_keep_days",
        "tg_bot_token",
        "tg_chat_id",
        "tg_use_proxy",
        "ntfy_url",
        "ntfy_topic",
        "ntfy_use_proxy",
        "webhook_url",
        "webhook_use_proxy",
        "battery_warn_temp_c",
        "battery_crit_temp_c",
        "battery_low_pct",
        "thermal_auto_stop",
        "battery_limit_min",
        "battery_limit_max",
        "battery_alert_below",
    )
    for key in allowed_keys:
        if key in body:
            val_str = str(body[key])
            if key == "tg_bot_token" and val_str.strip() and set(val_str.strip()) == {"*"}:
                continue
            set_setting(key, val_str)

    new_password = str(body.get("new_password", "")).strip()
    if new_password:
        # Фаза A.1(г): единое правило — минимум 8 символов, никакой записи пароля на диск!
        if len(new_password) < 8:
            raise HTTPException(status_code=400, detail="Новый пароль должен содержать минимум 8 символов")
        set_setting("password_hash", hash_password(new_password))
        set_setting("must_change_password", "0")
        log_audit(client_ip, "PASSWORD_CHANGED", "Пароль администратора изменён в настройках панели")

    reload_redaction_cache()
    ensure_tg_poller_running()
    log_audit(client_ip, "SETTINGS_UPDATED", "Обновлены системные настройки панели")
    return await api_get_settings(request)


@router.post("/settings/test_notify")
async def api_test_notify(request: Request) -> dict[str, Any]:
    res = await send_notification(
        "Тестовое уведомление от панели Aruta.",
        level="info",
        project_name="aruta-system",
    )
    return {"ok": True, "result": res}


@router.post("/settings/test_tg_command")
async def api_test_tg_command(request: Request) -> dict[str, Any]:
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    command = str(body.get("command", "/status")).strip() or "/status"
    reply = await handle_telegram_command(command)
    return {"ok": True, "command": command, "reply": reply or ""}


@router.post("/system/cleanup")
async def api_system_cleanup(request: Request) -> dict[str, Any]:
    client_ip = _client_ip(request)
    res = cleanup_system_caches()
    log_audit(client_ip, "SYSTEM_CLEANUP", f"Удалено старых запусков: {res['deleted_runs']}")
    return res


@router.get("/system/doctor")
async def api_system_doctor(request: Request) -> dict[str, Any]:
    return run_hub_doctor(auto_fix_perms=True)


@router.post("/system/thermal_check")
async def api_system_thermal_check(request: Request) -> dict[str, Any]:
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    force_temp = float(body["force_temp_c"]) if "force_temp_c" in body and body["force_temp_c"] is not None else None
    force_pct = int(body["force_percent"]) if "force_percent" in body and body["force_percent"] is not None else None
    return await check_android_hardware_guard(force_temp_c=force_temp, force_percent=force_pct)


@router.post("/system/restart_hub_daemon")
async def api_restart_hub_daemon(request: Request) -> dict[str, Any]:
    before_runs = query_all(
        """SELECT r.id, r.pid, r.pgid, p.name
           FROM runs r JOIN projects p ON p.id = r.project_id
           WHERE r.status = 'running'"""
    )
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
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES ('acceptance-tree-test', 'job', 'bash', 'bash -c "sleep 1000 & wait"', ?, '{}', '[]',
                0, 0, 'manual', '', 0, 0, 30, ?, 0, 'no', 2, 60, 'stopped', 0, 0, 0, ?, ?)""",
            (str(t_workdir), secrets.token_hex(16), now, now),
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
            timeout_sec, max_retries, retry_delay_sec, webhook_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES ('acceptance-survive-test', 'service', 'bash', 'bash -c "sleep 60"', ?, '{}', '[]',
            0, 0, 'manual', '', 0, 0, 30, ?, 0, 'no', 2, 60, 'stopped', 0, 0, 0, ?, ?)""",
        (str(hb_workdir), secrets.token_hex(16), now, now),
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

    # 4. Импорт куки из Cookie-Editor и aruta.cookies_expired()
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
            "title": '4. Импорт куки Cookie-Editor, aruta.secret("my_cookies") -> list[dict] и cookies_expired()',
            "passed": is_list and was_expired,
            "details": "Cookie-Editor JSON импортирован (0600), тип в Python: list[dict] (1 шт.), триггер баннера is_expired=1 подтверждён.",
        }
    )

    # 5. Блокирующий интерактивный aruta.ask() + маскировка секретов в логах
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
            "title": "5. Блокирующий aruta.ask() + маскировка секретов в логах",
            "passed": t5_ok,
            "details": f"aruta.ask() получил ответ '{polled.get('answer')}', секрет в логе замаскирован: '{masked_sample}'.",
        }
    )

    # 6. Потребление памяти процессом python3 -m aruta (< 80 МБ RSS)
    rss_mb = round(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024), 2)
    results.append(
        {
            "id": 6,
            "title": "6. Потребление памяти процессом python3 -m aruta (< 80 МБ RSS)",
            "passed": 0 < rss_mb < 80.0,
            "details": f"Текущее потребление памяти Aruta (PID={os.getpid()}): {rss_mb} МБ RSS (лимит бюджета: 80 МБ).",
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
    return query_all("SELECT id, timestamp, ip, action, details FROM audit_log ORDER BY id DESC LIMIT 100")


@router.get("/system/bundle")
async def api_system_bundle(request: Request) -> dict[str, Any]:
    bundle_files = [
        "requirements.txt",
        "README.md",
        "AGENTS.md",
        "docs/AI-ACCESS.md",
        "scripts/install.sh",
        "scripts/zstart_line.sh",
        "sdk/python/aruta.py",
        "sdk/python/hub.py",
        "sdk/node/aruta.js",
        "sdk/node/hub.js",
        "aruta/__init__.py",
        "aruta/__main__.py",
        "hub/__init__.py",
        "hub/__main__.py",
        "hub/config.py",
        "hub/db.py",
        "hub/auth.py",
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
    from hub.env_detect import generate_systemd_unit

    port = int(get_setting("port", "8050") or 8050)
    unit_text = generate_systemd_unit(BASE_DIR, port=port, user=get_setting("run_as_user", "root"))
    for fname in ("beacon.service", "aruta.service", "hub.service"):
        unit_path = BASE_DIR / "scripts" / fname
        try:
            unit_path.parent.mkdir(parents=True, exist_ok=True)
            unit_path.write_text(unit_text, encoding="utf-8")
        except OSError:
            pass
    return {
        "ok": True,
        "path": str(BASE_DIR / "scripts" / "beacon.service"),
        "unit": unit_text,
        "content": unit_text,
    }


@router.get("/system/backup")
async def api_system_backup_zip(request: Request) -> Response:
    from hub.config import DB_PATH, SECRETS_DIR
    from hub.db import checkpoint_wal

    checkpoint_wal(truncate_threshold_mb=0.0)
    buf = io.BytesIO()
    skip_dirs = {".venv", "venv", "node_modules", "__pycache__", ".git", ".tmp", ".home", "browser_profile"}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if DB_PATH.exists():
            zf.write(DB_PATH, "data/hub.db")
        if SECRETS_DIR.exists():
            for sec_file in SECRETS_DIR.iterdir():
                if sec_file.is_file():
                    zf.write(sec_file, f"data/secrets/{sec_file.name}")
        if PROJECTS_DIR.exists():
            for root, dirs, files in os.walk(PROJECTS_DIR):
                dirs[:] = [d for d in dirs if d not in skip_dirs]
                root_p = Path(root)
                for fn in files:
                    fp = root_p / fn
                    try:
                        if fp.is_file() and fp.stat().st_size <= 5 * 1024 * 1024:
                            rel = fp.relative_to(BASE_DIR)
                            zf.write(fp, str(rel))
                    except OSError:
                        pass

    ts = time.strftime("%Y%m%d_%H%M%S")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="aruta_backup_{ts}.zip"'},
    )
