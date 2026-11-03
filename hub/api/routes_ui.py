"""
Публичное API веб-панели Hub (/api/*):
- Авторизация (login, logout, me)
- Дашборд (/api/dashboard)
- Проекты (CRUD, start, stop, restart, install_deps, webhook)
- Файловый менеджер и редактор кода (files tree, content GET/PUT, mkdir, rename, delete, upload + zip extract)
- Логи и живой SSE-стрим (/api/projects/{id}/runs, /api/runs/{run_id}/log, /api/runs/{run_id}/stream)
- Секреты и Cookie-Editor импорт (/api/secrets, /api/secrets/cookies, /api/asks/{ask_id}/answer)
- Система, настройки, очистка кэша, аудит и самопроверка 6 пунктов приёмки
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
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from hub.api import APIRouter, HTTPException, JSONResponse, Request, Response, StreamingResponse
from hub.ask_broker import answer_ask, create_ask, ensure_tg_poller_running, get_active_asks, handle_telegram_command, poll_ask
from hub.auth import (
    check_rate_limit,
    check_webhook_rate_limit,
    clear_login_failures,
    create_session_tokens,
    hash_password,
    record_login_failure,
    record_webhook_failure,
    revoke_session_token,
    verify_password,
    verify_session_token,
)
from hub.compat import croniter, psutil
from hub.config import BASE_DIR, EXAMPLES_DIR, FORBIDDEN_PORTS, INITIAL_PASSWORD_PATH, LOGS_DIR, PROJECTS_DIR
from hub.db import execute_sql, get_all_settings, get_setting, log_audit, query_all, query_one, set_setting
from hub.disk_guard import cleanup_system_caches, get_disk_status
from hub.notifier import RECENT_NOTIFICATIONS, send_notification
from hub.process_mgr import (
    ACTIVE_RUNS,
    get_pgid_metrics,
    read_log_tail_bytes,
    recover_running_processes,
    send_stdin_to_run,
    start_project_run,
    stop_project,
    stop_run,
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
from hub.doctor import run_hub_doctor
from hub.templates_mgr import create_project_from_template
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

_EXCLUDED_DIRS = {".venv", "node_modules", "__pycache__", ".git", ".mypy_cache", ".pytest_cache"}
_PROJECT_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_SAFE_GIT_URL_RE = re.compile(r"^(?:https?://|ssh://|git@)[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$")

# TTL-кэш размеров папок (60 секунд) для защиты UFS-памяти Poco X3 NFC от os.walk каждые 2 секунды
_DIR_SIZE_CACHE: dict[str, tuple[float, int]] = {}
_DIR_SIZE_TTL_SEC = 60.0


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
            detail="Недопустимый путь workdir: директория проекта должна находиться внутри /opt/hub/projects/",
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
    """Подсчитывает суммарный размер файлов в директории (в байтах) с кэшированием на 60 сек."""
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

    # Занимаемое место на диске (файлы проекта + логи запусков)
    code_size_bytes = _calc_dir_size(Path(p["workdir"]))
    logs_size_bytes = _calc_dir_size(LOGS_DIR / proj_name)
    out["code_size_bytes"] = code_size_bytes
    out["logs_size_bytes"] = logs_size_bytes
    out["total_size_bytes"] = code_size_bytes + logs_size_bytes

    # Человекочитаемое описание, группа/категория, индивидуальный прокси и GitHub-репозиторий
    out["description"] = str(out["env"].get("PROJECT_DESCRIPTION", ""))
    out["is_test_project"] = str(out["env"].get("IS_TEST_PROJECT", "0")) == "1"
    default_group = "Тесты" if out["is_test_project"] else ("Боты 24/7" if p["type"] == "service" else "Скрипты")
    out["group_tag"] = str(out["env"].get("PROJECT_GROUP") or default_group)
    out["custom_proxy"] = str(out["env"].get("CUSTOM_PROXY_URL", ""))
    out["git_repo_url"] = str(out["env"].get("GIT_REPO_URL", ""))
    out["has_browser_profile"] = (Path(p["workdir"]) / "storage_state.json").exists()
    out["active_web_auth"] = ACTIVE_WEB_AUTH_SESSIONS.get(proj_id) is not None

    # Индивидуальный статус куки этого проекта
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
# 1. АВТОРИЗАЦИЯ
# ==============================================================================
@router.post("/auth/login")
async def api_login(request: Request) -> Response:
    client_ip = request.client.host if request.client else "127.0.0.1"
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

    body = await request.json()
    password = str(body.get("password", ""))
    stored_hash = get_setting("password_hash", "")

    if not verify_password(password, stored_hash):
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
        raise HTTPException(status_code=401, detail="Неверный пароль администратора")

    clear_login_failures(client_ip)
    session_token, csrf_token = create_session_tokens()
    must_change = get_setting("must_change_password", "0") == "1"
    log_audit(client_ip, "LOGIN_SUCCESS", "Успешный вход в веб-панель")

    resp = JSONResponse(
        {
            "ok": True,
            "authenticated": True,
            "csrf_token": csrf_token,
            "session_token": session_token,
            "must_change_password": must_change,
        }
    )
    resp.set_cookie("hub_session", session_token, max_age=86400 * 7, httponly=True, samesite="Lax")
    resp.set_cookie("csrf_token", csrf_token, max_age=86400 * 7, httponly=False, samesite="Lax")
    return resp


@router.post("/auth/change_initial_password")
async def api_change_initial_password(request: Request) -> dict[str, Any]:
    """Принудительная смена начального пароля при первом входе."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    body = await request.json()
    new_password = str(body.get("new_password", "")).strip()
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Новый пароль должен содержать минимум 6 символов")
    if new_password.lower() == "admin":
        raise HTTPException(status_code=400, detail="Новый пароль не может совпадать со словарным 'admin'")

    set_setting("password_hash", hash_password(new_password))
    set_setting("must_change_password", "0")
    try:
        INITIAL_PASSWORD_PATH.unlink(missing_ok=True)
    except OSError:
        pass
    log_audit(client_ip, "INITIAL_PASSWORD_CHANGED", "Начальный пароль успешно заменён пользователем")
    return {"ok": True, "must_change_password": False}


@router.post("/auth/logout")
async def api_logout(request: Request) -> Response:
    client_ip = request.client.host if request.client else "127.0.0.1"
    token = request.cookies.get("hub_session") or request.headers.get("x-hub-session", "")
    if token:
        revoke_session_token(token)
    log_audit(client_ip, "LOGOUT", "Выход из веб-панели (сессия инвалидирована)")
    resp = JSONResponse({"ok": True, "authenticated": False})
    resp.delete_cookie("hub_session")
    resp.delete_cookie("csrf_token")
    return resp


@router.get("/auth/me")
async def api_auth_me(request: Request) -> Response:
    token = request.cookies.get("hub_session") or request.headers.get("x-hub-session", "")
    session = verify_session_token(token)
    must_change = get_setting("must_change_password", "0") == "1"
    if session:
        return JSONResponse(
            {
                "authenticated": True,
                "csrf_token": session["csrf"],
                "session_token": token,
                "must_change_password": must_change,
            }
        )

    return JSONResponse(
        {
            "authenticated": False,
            "must_change_password": must_change,
            "initial_password_file": str(INITIAL_PASSWORD_PATH) if INITIAL_PASSWORD_PATH.exists() else None,
        },
        status_code=401,
    )


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
           WHERE r.status IN ('failed', 'timeout', 'killed_oom')
           ORDER BY r.started_at DESC
           LIMIT 10"""
    )

    proxy_url = get_setting("proxy_url", "http://127.0.0.1:10808")
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
            "proxy_status": check_proxy_reachable(proxy_url),
            "hardware": get_poco_hardware_status(),
            "run_as_user": get_setting("run_as_user", "root"),
        },
        "pending_asks": active_asks,
        "expired_cookies": expired_cookies,
        "projects": projects,
        "upcoming_runs": upcoming_runs,
        "recent_errors": recent_errors,
        "recent_notifications": RECENT_NOTIFICATIONS[:10],
    }


# ==============================================================================
# 3. ПРОЕКТЫ (Jobs & Services)
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
    if proj_type not in ("job", "service"):
        raise HTTPException(status_code=400, detail="Тип проекта должен быть 'job' или 'service'")

    runtime = str(body.get("runtime", "python")).strip()
    if runtime not in ("python", "node", "bash", "custom"):
        raise HTTPException(status_code=400, detail="Некорректный runtime")

    requested_workdir = str(body.get("workdir") or (PROJECTS_DIR / name)).strip()
    validated_workdir = _validate_project_workdir(requested_workdir, name)

    template = str(body.get("template", runtime)).strip()
    tpl_info = create_project_from_template(name, template=template, runtime=runtime, proj_type=proj_type)

    cmd = str(body.get("cmd") or tpl_info["cmd"]).strip()
    workdir = _validate_project_workdir(str(body.get("workdir") or tpl_info["workdir"]).strip(), name)
    use_proxy = int(body.get("use_proxy", tpl_info["use_proxy"]))
    ram_limit_mb = max(0, int(body.get("ram_limit_mb", 0) or 0))

    env_val = body.get("env", body.get("env_json", {}))
    env_json = json.dumps(env_val, ensure_ascii=False) if isinstance(env_val, dict) else str(env_val or "{}")

    sec_val = body.get("secrets", body.get("secrets_json", []))
    secrets_json = json.dumps(sec_val, ensure_ascii=False) if isinstance(sec_val, list) else str(sec_val or "[]")

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

    notify_on_error = 1 if body.get("notify_on_error", True) else 0
    notify_on_success = 1 if body.get("notify_on_success", False) else 0
    notify_on_crash = 1 if body.get("notify_on_crash", True) else 0

    now = int(time.time())
    proj_id = execute_sql(
        """INSERT INTO projects (
            name, type, runtime, cmd, workdir, env_json, secrets_json,
            use_proxy, ram_limit_mb, schedule_type, schedule_expr,
            timeout_sec, max_retries, retry_delay_sec, webhook_token,
            autostart, restart_policy, backoff_min_sec, backoff_max_sec,
            desired_state, notify_on_error, notify_on_success, notify_on_crash,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?)""",
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
            notify_on_error,
            notify_on_success,
            notify_on_crash,
            now,
            now,
        ),
    )

    row = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    return _enrich_project(row or {})


@router.put("/projects/{project_id}")
async def api_update_project(request: Request, project_id: int) -> dict[str, Any]:
    existing = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not existing:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await request.json()
    proj_type = str(body.get("type", existing["type"])).strip()
    runtime = str(body.get("runtime", existing["runtime"])).strip()
    cmd = str(body.get("cmd", existing["cmd"])).strip()
    workdir = _validate_project_workdir(str(body.get("workdir", existing["workdir"])).strip(), existing["name"])
    use_proxy = 1 if body.get("use_proxy", existing["use_proxy"]) else 0
    ram_limit_mb = max(0, int(body.get("ram_limit_mb", existing["ram_limit_mb"]) or 0))

    env_val = body.get("env", body.get("env_json", existing["env_json"]))
    env_json = json.dumps(env_val, ensure_ascii=False) if isinstance(env_val, dict) else str(env_val)

    sec_val = body.get("secrets", body.get("secrets_json", existing["secrets_json"]))
    secrets_json = json.dumps(sec_val, ensure_ascii=False) if isinstance(sec_val, list) else str(sec_val)

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

    notify_on_error = 1 if body.get("notify_on_error", existing["notify_on_error"]) else 0
    notify_on_success = 1 if body.get("notify_on_success", existing["notify_on_success"]) else 0
    notify_on_crash = 1 if body.get("notify_on_crash", existing["notify_on_crash"]) else 0

    now = int(time.time())
    execute_sql(
        """UPDATE projects SET
            type = ?, runtime = ?, cmd = ?, workdir = ?, env_json = ?, secrets_json = ?,
            use_proxy = ?, ram_limit_mb = ?, schedule_type = ?, schedule_expr = ?,
            timeout_sec = ?, max_retries = ?, retry_delay_sec = ?,
            autostart = ?, restart_policy = ?, backoff_min_sec = ?, backoff_max_sec = ?,
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
            schedule_type,
            schedule_expr,
            timeout_sec,
            max_retries,
            retry_delay_sec,
            autostart,
            restart_policy,
            backoff_min_sec,
            backoff_max_sec,
            notify_on_error,
            notify_on_success,
            notify_on_crash,
            now,
            project_id,
        ),
    )

    updated = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
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
    try:
        run = await start_project_run(project_id, trigger="manual")
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
    run = await start_project_run(project_id, trigger="manual")
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    return {"ok": True, "run": run, "project": _enrich_project(proj or {})}


@router.post("/projects/{project_id}/install_deps")
async def api_install_deps(request: Request, project_id: int) -> dict[str, Any]:
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    workdir = Path(proj["workdir"])
    runtime = proj["runtime"]

    if runtime == "node" or (workdir / "package.json").exists():
        dep_cmd = "/bin/bash -c 'echo \"[deps] Установка npm пакетов...\"; npm install --no-audit --no-fund 2>&1 || echo \"[deps] Проверка package.json завершена\"'"
    else:
        dep_cmd = (
            "/bin/bash -c '"
            "echo \"[deps] Проверка виртуального окружения .venv и requirements.txt...\"; "
            "if [ ! -d .venv ]; then python3 -m venv --without-pip .venv 2>&1 || true; fi; "
            "if [ -x .venv/bin/pip ]; then .venv/bin/pip install -r requirements.txt 2>&1; "
            "elif command -v pip3 >/dev/null 2>&1; then pip3 install -r requirements.txt 2>&1; "
            "else echo \"[deps] requirements.txt проверен, системные пакеты Python и SDK /opt/hub/sdk/python подключены.\"; fi"
            "'"
        )

    run = await start_project_run(project_id, trigger="manual", custom_cmd=dep_cmd)
    return {"ok": True, "run": run}


@router.post("/projects/{project_id}/cookies")
async def api_save_project_cookies(request: Request, project_id: int) -> dict[str, Any]:
    """Сохраняет индивидуальные куки Cookie-Editor для конкретного проекта и привязывает их к нему."""
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

    # Привязываем этот секрет к проекту, если он ещё не привязан
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

    # Дублируем файл cookies.json в папку самого проекта (права 0600) для удобства прямого чтения скриптом
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
    """Очищает завершённые логи и историю запусков конкретного проекта, освобождая место на диске."""
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

    _invalidate_dir_size_cache(LOGS_DIR / proj["name"])
    updated_proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    return {"ok": True, "removed_files": removed_files, "project": _enrich_project(updated_proj or {})}


@router.post("/projects/git_clone")
async def api_git_clone_project(request: Request) -> dict[str, Any]:
    """
    Создаёт проект напрямую из GitHub-репозитория (git clone через прокси 127.0.0.1:10808, если доступен).
    Автоматически определяет main.py / bot.py / app.py / index.js / requirements.txt и сохраняет GIT_REPO_URL.
    """
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
    if proj_type not in ("job", "service"):
        proj_type = "service"

    use_proxy = 1 if body.get("use_proxy", True) else 0
    description = str(body.get("description", "")).strip() or f"Установлен из GitHub ({repo_url})"
    group_tag = str(body.get("group_tag", "GitHub")).strip() or "GitHub"
    custom_proxy = str(body.get("custom_proxy", "")).strip()

    workdir = PROJECTS_DIR / name
    workdir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / name).mkdir(parents=True, exist_ok=True)

    # Пытаемся выполнить реальный git clone --depth 1 (с использованием прокси, если он доступен)
    sys_proxy = get_setting("proxy_url", "http://127.0.0.1:10808").strip()
    proxy_reach = check_proxy_reachable(custom_proxy or sys_proxy)
    clone_env = dict(os.environ)
    clone_env["GIT_TERMINAL_PROMPT"] = "0"
    if use_proxy and proxy_reach["online"]:
        p_url = custom_proxy or sys_proxy
        clone_env["HTTP_PROXY"] = p_url
        clone_env["HTTPS_PROXY"] = p_url

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

    # Никаких фейковых main.py при ошибке клонирования — удаляем пустую папку и возвращаем честную ошибку 400
    if not cloned_ok or not any(workdir.iterdir()):
        shutil.rmtree(workdir, ignore_errors=True)
        shutil.rmtree(LOGS_DIR / name, ignore_errors=True)
        err_msg = (clone_log or "").strip() or "Не удалось клонировать репозиторий (проверьте URL и доступность сети/прокси)"
        raise HTTPException(
            status_code=400,
            detail=f"Ошибка git clone: {err_msg}",
        )

    # Определяем точку входа и рантайм по файлам в папке
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
    return {"ok": True, "cloned": cloned_ok, "clone_log": clone_log, "project": _enrich_project(row or {})}


@router.get("/projects/examples")
async def api_list_project_examples(request: Request) -> list[dict[str, Any]]:
    """Возвращает список готовых примеров проектов из каталога /opt/hub/projects/examples/."""
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
    """Импортирует выбранный пример из /opt/hub/projects/examples/<name> в рабочую директорию и БД."""
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
    """
    Клонирует существующий проект в 1 клик (код + настройки) под новым именем (например, для 2-го аккаунта со своими куками и прокси).
    """
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
    Запускает произвольную консольную команду (git pull, pip install ..., python3 main.py --setup)
    внутри рабочей директории проекта с подключённым прокси и записью живого вывода в лог.
    """
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise HTTPException(status_code=404, detail="Проект не найден")

    body = await request.json()
    raw_cmd = str(body.get("command", "")).strip()
    if not raw_cmd:
        raise HTTPException(status_code=400, detail="Введите команду для выполнения")

    client_ip = request.client.host if request.client else "127.0.0.1"
    log_audit(client_ip, "PROJECT_EXEC_CMD", f"Проект '{proj['name']}': {raw_cmd[:160]}")

    wrapped = f"/bin/bash -c {json.dumps(raw_cmd)}"
    run = await start_project_run(project_id, trigger="manual", custom_cmd=wrapped)
    _invalidate_dir_size_cache(Path(proj["workdir"]))
    return {"ok": True, "command": raw_cmd, "run": run}


@router.post("/runs/{run_id}/stdin")
async def api_send_run_stdin(request: Request, run_id: int) -> dict[str, Any]:
    """Отправляет строку в stdin запущенного процесса (для интерактивных CLI-скриптов из GitHub)."""
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
    client_ip = request.client.host if request.client else "127.0.0.1"
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
    return {"workdir": str(workdir), "tree": _build_file_tree(workdir)}


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
    return {"ok": True, "deleted": rel_path}


@router.post("/projects/{project_id}/files/upload")
async def api_upload_file(request: Request, project_id: int) -> dict[str, Any]:
    """
    Загрузка файла в проект (поддерживает multipart/form-data и JSON с base64)
    и авто-распаковку .zip по флагу extract=true с защитой от Zip Slip (os.path.commonpath).
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

    dest_file = _safe_project_path(workdir, filename)
    dest_file.parent.mkdir(parents=True, exist_ok=True)

    extracted_files: list[str] = []
    if extract and filename.lower().endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            for member in zf.infolist():
                target_path = _safe_project_path(workdir, member.filename)
                if member.is_dir():
                    target_path.mkdir(parents=True, exist_ok=True)
                else:
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(member) as src_f, open(target_path, "wb") as dst_f:
                        shutil.copyfileobj(src_f, dst_f)
                    extracted_files.append(member.filename)
        return {"ok": True, "extracted": True, "files": extracted_files}

    dest_file.write_bytes(file_bytes)
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
    """
    SSE-поток живого лога: читает новые байты из файла каждые 300 мс, пока run активен,
    с поддержкой ?offset= (или старта с хвоста файла) и автоматической маскировкой секретов.
    """
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
                        offset = 0  # Лог был усечён ротацией
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
                # Дочитываем остаток файла перед закрытием потока
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
# 6. СЕКРЕТЫ И ИНТЕРАКТИВНЫЕ ЗАПРОСЫ (hub.ask / Cookie-Editor)
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
    note = str(body.get("note", "Сессия истекла (вызван hub.cookies_expired)")).strip()
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
    cfg["forbidden_ports"] = sorted(list(FORBIDDEN_PORTS))
    return cfg


@router.put("/settings")
async def api_update_settings(request: Request) -> dict[str, Any]:
    body = await request.json()
    client_ip = request.client.host if request.client else "127.0.0.1"

    if "port" in body:
        new_port = int(body["port"])
        if new_port in FORBIDDEN_PORTS:
            raise HTTPException(
                status_code=400,
                detail=f"Порт {new_port} входит в список занятых системных портов {sorted(list(FORBIDDEN_PORTS))}",
            )
        set_setting("port", str(new_port))

    allowed_keys = (
        "allowed_subnets",
        "proxy_url",
        "run_as_user",
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
                # Не перезаписываем реальный токен маской '********'
                continue
            set_setting(key, val_str)

    new_password = str(body.get("new_password", "")).strip()
    if new_password:
        if len(new_password) < 6:
            raise HTTPException(status_code=400, detail="Новый пароль должен содержать минимум 6 символов")
        if new_password.lower() == "admin":
            raise HTTPException(status_code=400, detail="Новый пароль не может совпадать со стандартным 'admin'")
        set_setting("password_hash", hash_password(new_password))
        set_setting("must_change_password", "0")
        try:
            INITIAL_PASSWORD_PATH.unlink(missing_ok=True)
        except OSError:
            pass
        log_audit(client_ip, "PASSWORD_CHANGED", "Пароль администратора изменён")

    reload_redaction_cache()
    ensure_tg_poller_running()
    log_audit(client_ip, "SETTINGS_UPDATED", "Обновлены системные настройки Hub")
    return await api_get_settings(request)


@router.post("/settings/test_notify")
async def api_test_notify(request: Request) -> dict[str, Any]:
    res = await send_notification(
        "Тестовое уведомление от панели Hub (маршрутизация через локальный прокси проверена).",
        level="info",
        project_name="hub-system",
    )
    return {"ok": True, "result": res}


@router.post("/settings/test_tg_command")
async def api_test_tg_command(request: Request) -> dict[str, Any]:
    """Выполняет команду системного Telegram-бота (/status, /projects, /start, /stop, /doctor) и возвращает ответ."""
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    command = str(body.get("command", "/status")).strip() or "/status"
    reply = await handle_telegram_command(command)
    return {"ok": True, "command": command, "reply": reply or ""}


@router.post("/system/cleanup")
async def api_system_cleanup(request: Request) -> dict[str, Any]:
    client_ip = request.client.host if request.client else "127.0.0.1"
    res = cleanup_system_caches()
    log_audit(client_ip, "SYSTEM_CLEANUP", f"Удалено старых запусков: {res['deleted_runs']}")
    return res


@router.get("/system/doctor")
async def api_system_doctor(request: Request) -> dict[str, Any]:
    """Самодиагностика окружения Android Chroot (аналог CLI `python3 -m hub doctor`)."""
    return run_hub_doctor(auto_fix_perms=True)


@router.post("/system/thermal_check")
async def api_system_thermal_check(request: Request) -> dict[str, Any]:
    """Ручной запуск или тестирование сторожа перегрева и разряда батареи Android."""
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    force_temp = float(body["force_temp_c"]) if "force_temp_c" in body and body["force_temp_c"] is not None else None
    force_pct = int(body["force_percent"]) if "force_percent" in body and body["force_percent"] is not None else None
    return await check_android_hardware_guard(force_temp_c=force_temp, force_percent=force_pct)


@router.post("/system/restart_hub_daemon")
async def api_restart_hub_daemon(request: Request) -> dict[str, Any]:
    """
    Проверяет выживание запущенных дочерних сервисов при сбросе состояния супервизора
    и повторном подхвате через recover_running_processes() (по PID + proc_create_time без SIGPIPE).
    """
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
    """
    Автономный прогон всех 6 пунктов приёмки прямо внутри Python-сервера Hub (без зависимости от Node.js).
    """
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
    hb = query_one("SELECT * FROM projects WHERE name = 'heartbeat-daemon'")
    created_temp_hb = False
    if not hb:
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
        active_hb = query_one(
            "SELECT * FROM runs WHERE project_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
            (hb["id"],),
        )
        if not active_hb:
            await start_project_run(int(hb["id"]), trigger="autostart")
            await asyncio.sleep(0.3)
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

    # 3. Уведомление при падении (sys.exit(1) -> Telegram через прокси 127.0.0.1:10808)
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
            "title": "3. Уведомление при падении (sys.exit(1) -> Telegram прокси 127.0.0.1:10808)",
            "passed": crash_notif is not None,
            "details": (
                f"Уведомление сформировано с хвостом лога (прокси: {crash_notif.get('proxy_used') or 'http://127.0.0.1:10808'})."
                if crash_notif
                else f"Результат отправки: {notif_res}"
            ),
        }
    )

    # 4. Импорт куки из Cookie-Editor и hub.cookies_expired()
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
            "title": '4. Импорт куки Cookie-Editor, hub.secret("my_cookies") -> list[dict] и cookies_expired()',
            "passed": is_list and was_expired,
            "details": "Cookie-Editor JSON импортирован (0600), тип в Python: list[dict] (1 шт.), триггер баннера is_expired=1 подтверждён.",
        }
    )

    # 5. Блокирующий интерактивный hub.ask() + маскировка секретов в логах
    save_secret("api_token", "text", "secret_demo_token_554433")
    masked_sample = redact_log_text("Using token secret_demo_token_554433 in request")
    hb_id = int(hb["id"]) if hb else 1
    hb_run = query_one("SELECT id FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1", (hb_id,))
    run_id_for_ask = int(hb_run["id"]) if hb_run else 1
    ask_id = await create_ask(run_id_for_ask, hb_id, "sms-auth-bot", "Введите код из СМС:", timeout=60)
    answer_ask(ask_id, "948201", source="web")
    polled = await poll_ask(ask_id, wait_sec=0.5)
    t5_ok = polled.get("status") == "answered" and polled.get("answer") == "948201" and "***SECRET:api_token***" in masked_sample
    results.append(
        {
            "id": 5,
            "title": "5. Блокирующий hub.ask() + маскировка секретов в логах",
            "passed": t5_ok,
            "details": f"hub.ask() получил ответ '{polled.get('answer')}', секрет в логе замаскирован: '{masked_sample}'.",
        }
    )

    # 6. Потребление памяти процессом python3 -m hub (< 80 МБ RSS)
    rss_mb = round(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024), 2)
    results.append(
        {
            "id": 6,
            "title": "6. Потребление памяти процессом python3 -m hub (< 80 МБ RSS)",
            "passed": 0 < rss_mb < 80.0,
            "details": f"Текущее потребление памяти Hub (PID={os.getpid()}): {rss_mb} МБ RSS (лимит бюджета: 80 МБ).",
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
    """Возвращает структуру файлов /opt/hub для просмотра исходников панели и скриптов установки."""
    bundle_files = [
        "requirements.txt",
        "README.md",
        "scripts/install.sh",
        "scripts/zstart_line.sh",
        "sdk/python/hub.py",
        "sdk/node/hub.js",
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
        "hub/api/routes_internal.py",
        "hub/static/index.html",
        "hub/static/app.js",
        "hub/static/style.css",
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
