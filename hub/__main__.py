"""
Точка входа Beacon (совместимо с `python3 -m beacon` и `python3 -m hub`):
Запускает сервер на 0.0.0.0:8050 (или порту из настроек / аргументов CLI), инициализирует SQLite (WAL),
подхватывает выжившие процессы (recover_running_processes) и запускает фоновые циклы
process_mgr и scheduler.
"""

import asyncio
import getpass
import hmac
import logging
import os
import re
import secrets
import shlex
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable

from hub.api import (
    HAS_NATIVE_FASTAPI,
    MAX_REQUEST_BODY_BYTES,
    FastAPI,
    FileResponse,
    HTMLResponse,
    HTTPException,
    JSONResponse,
    Request,
    run_fallback_http_server,
)
from hub.api.routes_ai import router as ai_router
from hub.api.routes_internal import router as internal_router
from hub.api.routes_ui import router as ui_router
from hub.ask_broker import ensure_tg_poller_running
from hub.auth import (
    bump_session_epoch,
    consume_stream_ticket,
    get_internal_token,
    hash_password,
    is_ip_allowed,
    resolve_request_client_ip,
    verify_session_token,
)
from hub.config import (
    BACKUPS_DIR,
    BASE_DIR,
    DATA_DIR,
    GENERATED_DIR,
    STATIC_DIR,
    ensure_directories,
    get_env_var,
    parse_reserved_ports,
    set_runtime_port,
    set_runtime_safe_mode,
)
from hub.db import get_setting, init_db, log_audit, set_setting
from hub.log import get_logger
from hub.names import ALL_SESSION_COOKIE_NAMES
from hub.notifier import send_notification
from hub.process_mgr import recover_running_processes, watch_processes_loop
from hub.scheduler import autostart_services_on_boot, scheduler_loop
from hub.secrets_mgr import reload_redaction_cache

logger = get_logger("main")

from hub import __version__ as BEACON_VERSION

app = FastAPI(title="Beacon Control Panel", version=BEACON_VERSION)

# Фоновые задачи жизненного цикла
_BG_TASKS: list[asyncio.Task[Any]] = []

_SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; "
        "font-src 'self' data:;"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


def _attach_security_headers(response: Any, path: str = "", is_https: bool = False) -> Any:
    headers_to_apply = dict(_SECURITY_HEADERS)
    if os.environ.get("BEACON_PREVIEW_MODE") != "1":
        headers_to_apply["X-Frame-Options"] = "DENY"
    if path.startswith("/api/"):
        headers_to_apply["Cache-Control"] = "no-store"
    elif path in ("/", "/index.html") or os.environ.get("BEACON_PREVIEW_MODE") == "1":
        headers_to_apply["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    if is_https:
        headers_to_apply["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    if hasattr(response, "headers") and isinstance(response.headers, dict):
        for k, v in headers_to_apply.items():
            response.headers.setdefault(k, v)
    elif hasattr(response, "headers"):
        try:
            for k, v in headers_to_apply.items():
                if k not in response.headers:
                    response.headers[k] = v
        except Exception as exc:
            logger.debug("Не удалось добавить security headers: %s", exc)
    return response


# Декларативная таблица правил RBAC (P0-1, P3-08): белый список по ролям
_RBAC_ALLOWLIST: dict[str, tuple[tuple[str, re.Pattern[str]], ...]] = {
    "viewer": (
        ("GET", re.compile(r"^/api/dashboard$")),
        ("GET", re.compile(r"^/api/projects$")),
        ("GET", re.compile(r"^/api/projects/\d+$")),
        ("GET", re.compile(r"^/api/projects/\d+/runs$")),
        ("GET", re.compile(r"^/api/projects/\d+/webhooks$")),
        ("GET", re.compile(r"^/api/projects/\d+/git_info$")),
        ("GET", re.compile(r"^/api/projects/\d+/processes$")),
        ("GET", re.compile(r"^/api/logs/search$")),
        ("GET", re.compile(r"^/api/analytics/summary$")),
        ("GET", re.compile(r"^/api/metrics$")),
        ("GET", re.compile(r"^/api/runs/\d+/log$")),
        ("GET", re.compile(r"^/api/runs/\d+/stream$")),
        ("GET", re.compile(r"^/api/auth/me$")),
        ("GET", re.compile(r"^/api/system/health$")),
        ("GET", re.compile(r"^/api/system/ports$")),
        ("GET", re.compile(r"^/api/system/update_status$")),
        ("POST", re.compile(r"^/api/auth/logout$")),
        ("POST", re.compile(r"^/api/auth/stream_ticket$")),
    ),
    "operator": (
        ("POST", re.compile(r"^/api/projects/\d+/start$")),
        ("POST", re.compile(r"^/api/projects/\d+/stop$")),
        ("POST", re.compile(r"^/api/projects/\d+/restart$")),
        ("POST", re.compile(r"^/api/projects/batch_action$")),
        ("POST", re.compile(r"^/api/projects/\d+/webhook_test$")),
        ("POST", re.compile(r"^/api/projects/\d+/cookies_fixed$")),
        ("POST", re.compile(r"^/api/settings/maintenance$")),
        ("POST", re.compile(r"^/api/runs/\d+/stdin$")),
        ("POST", re.compile(r"^/api/asks/[^/]+/answer$")),
    ),
}


def _check_rbac_permission(role: str, method: str, path: str) -> bool:
    """
    Инвертированная модель RBAC на основе белого списка (P0-1, P3-08):
    - admin: полный доступ
    - viewer: только чтение дашборда, статусов проектов, запусков, логов, SSE-потока, /api/auth/me, /api/system/health + logout/stream_ticket
    - operator: права viewer + управление жизненным циклом запусков (start/stop/restart/stdin/answer)
    """
    norm_role = (role or "").strip().lower()
    if norm_role == "admin":
        return True
    norm_method = (method or "GET").strip().upper()
    if norm_method in ("HEAD", "OPTIONS"):
        norm_method = "GET"

    if norm_role not in ("viewer", "operator"):
        return False

    rules = list(_RBAC_ALLOWLIST["viewer"])
    if norm_role == "operator":
        rules.extend(_RBAC_ALLOWLIST["operator"])

    for allowed_method, pattern in rules:
        if norm_method == allowed_method and pattern.match(path):
            return True
    return False


@app.middleware("http")
async def security_and_auth_middleware(request: Request, call_next: Callable[[Request], Any]) -> Any:
    # 0. Жёсткий лимит размера тела запроса (50 МБ -> 413) ДО проверки подсети и авторизации
    cl_header = request.headers.get("content-length", "0")
    try:
        content_len = int(cl_header or 0)
    except ValueError:
        content_len = 0
    if content_len > MAX_REQUEST_BODY_BYTES:
        return _attach_security_headers(
            JSONResponse(
                {
                    "detail": f"Превышен максимальный размер тела запроса ({MAX_REQUEST_BODY_BYTES // (1024 * 1024)} МБ)",
                    "max_bytes": MAX_REQUEST_BODY_BYTES,
                },
                status_code=413,
            )
        )

    # Ограничение реально прочитанных байт для Transfer-Encoding: chunked / ASGI без Content-Length (P3-06)
    orig_receive = getattr(request, "_receive", None)
    if callable(orig_receive):
        bytes_seen = 0

        async def _bounded_receive() -> dict[str, Any]:
            nonlocal bytes_seen
            msg = await orig_receive()
            if isinstance(msg, dict) and msg.get("type") == "http.request":
                bytes_seen += len(msg.get("body", b"") or b"")
                if bytes_seen > MAX_REQUEST_BODY_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Превышен максимальный размер тела запроса ({MAX_REQUEST_BODY_BYTES // (1024 * 1024)} МБ)",
                    )
            return msg

        try:
            request._receive = _bounded_receive  # type: ignore[attr-defined]
        except Exception:
            pass

    path = request.url.path
    direct_ip = request.client.host if request.client else "127.0.0.1"
    client_ip, proxy_rejected, proxy_err = resolve_request_client_ip(direct_ip, request.headers)
    trusted_csv = (get_setting("trusted_proxies", "") or "").strip()
    from hub.auth import _ip_in_cidr_csv

    trust_xfp = (
        os.environ.get("BEACON_PREVIEW_MODE") == "1"
        or (bool(trusted_csv) and _ip_in_cidr_csv(direct_ip, trusted_csv))
    )
    is_https = (
        getattr(getattr(request, "url", None), "scheme", "http") == "https"
        or (trust_xfp and request.headers.get("x-forwarded-proto", "").lower() == "https")
    )
    try:
        request.state.client_ip = client_ip
    except Exception as exc:
        logger.debug("Не удалось записать request.state.client_ip: %s", exc)

    def _finish(resp: Any) -> Any:
        return _attach_security_headers(resp, path=path, is_https=is_https)

    # 1. Запросы на /internal/* разрешены только с локального интерфейса (127.0.0.1 / ::1)
    if path.startswith("/internal"):
        clean_direct = direct_ip.replace("::ffff:", "")
        if clean_direct not in ("127.0.0.1", "::1", "localhost"):
            return _finish(
                JSONResponse({"detail": "Доступ к /internal разрешён только с 127.0.0.1"}, status_code=403)
            )
        try:
            return _finish(await call_next(request))
        except HTTPException as he:
            return _finish(JSONResponse({"detail": he.detail}, status_code=he.status_code))
        except Exception:
            err_id = secrets.token_hex(4)
            traceback.print_exc()
            return _finish(
                JSONResponse(
                    {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                    status_code=500,
                )
            )

    # 1.5 Защита от обхода фильтра подсетей через reverse proxy на loopback при пустом trusted_proxies (P0-5)
    if proxy_rejected:
        return _finish(JSONResponse({"detail": proxy_err}, status_code=403))

    # 2. Маршруты ИИ (/mcp, /api/v1/*) и Dead Man's Switch (/api/ping/*) используют собственную авторизацию
    if path == "/mcp" or path.startswith("/api/v1/") or path.startswith("/api/ping/"):
        try:
            return _finish(await call_next(request))
        except HTTPException as he:
            return _finish(JSONResponse({"detail": he.detail}, status_code=he.status_code))
        except Exception:
            err_id = secrets.token_hex(4)
            traceback.print_exc()
            return _finish(
                JSONResponse(
                    {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                    status_code=500,
                )
            )

    # 3. Фильтр подсетей (allowed_subnets + ограничение для дефолтного пароля admin)
    if not is_ip_allowed(client_ip):
        return _finish(
            JSONResponse({"detail": f"Доступ с IP {client_ip} запрещён фильтром подсетей"}, status_code=403)
        )

    # 4. Открытые маршруты (статика, вход, проверка сессии, внешние вебхуки)
    if (
        path in ("/", "/index.html", "/favicon.ico", "/api/auth/login", "/api/auth/me")
        or path.startswith("/static/")
        or path.startswith("/assets/")
        or path.startswith("/api/webhook/")
    ):
        try:
            return _finish(await call_next(request))
        except HTTPException as he:
            return _finish(JSONResponse({"detail": he.detail}, status_code=he.status_code))
        except Exception:
            err_id = secrets.token_hex(4)
            traceback.print_exc()
            return _finish(
                JSONResponse(
                    {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                    status_code=500,
                )
            )

    # 5. Проверка сессии, одноразовых SSE-тикетов, RBAC и CSRF для защищённых маршрутов /api/*
    if path.startswith("/api/"):
        # ВНИМАНИЕ (Фаза A.4): приём session_token из query-параметра удалён!
        # Для SSE (/api/runs/{id}/stream) поддерживается одноразовый короткоживущий ?ticket=
        token = ""
        for cname in ALL_SESSION_COOKIE_NAMES:
            if request.cookies.get(cname):
                token = str(request.cookies.get(cname) or "")
                break
        if not token:
            token = request.headers.get("x-beacon-session", "")
        session = verify_session_token(token)

        if path.startswith("/api/runs/") and path.endswith("/stream") and request.method == "GET":
            ticket = request.query_params.get("ticket", "")
            if ticket:
                parts = path.strip("/").split("/")
                # ["api", "runs", "{run_id}", "stream"]
                run_id_val = int(parts[2]) if len(parts) >= 4 and parts[2].isdigit() else 0
                cookie_sid = str(session.get("sid") or "") if isinstance(session, dict) else None
                if not consume_stream_ticket(ticket, run_id=run_id_val, session_sid=cookie_sid):
                    return _finish(JSONResponse({"detail": "Недействительный или просроченный SSE-тикет"}, status_code=401))
                if not session:
                    session = {"sub": "stream_ticket", "user": "stream_ticket", "role": "viewer", "csrf": ""}

        # Разрешаем скрапинг Prometheus GET /api/metrics по Bearer-токену с правом 'read' (без открытого доступа)
        if not session and path == "/api/metrics" and request.method == "GET":
            auth_hdr = request.headers.get("authorization", "")
            if auth_hdr.lower().startswith("bearer "):
                from hub.auth import verify_ai_token

                raw_tok = auth_hdr[7:].strip()
                tok_row, _tok_err = verify_ai_token(raw_tok, client_ip=client_ip)
                if tok_row and "read" in (tok_row.get("scopes") or []):
                    session = {
                        "sub": f"metrics_token:{tok_row.get('name', 'prometheus')}",
                        "user": f"metrics:{tok_row.get('name', 'prometheus')}",
                        "role": "viewer",
                        "csrf": "",
                    }

        if not session:
            return _finish(
                JSONResponse({"detail": "Требуется авторизация"}, status_code=401)
            )

        try:
            request.state.session = session
        except Exception as exc:
            logger.debug("Не удалось записать request.state.session: %s", exc)

        # Проверка CSRF на ВСЕ небезопасные методы (POST, PUT, PATCH, DELETE)
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            csrf_header = request.headers.get("x-csrf-token", "")
            expected_csrf = str(session.get("csrf") or "")
            if not csrf_header or not expected_csrf or not hmac.compare_digest(csrf_header, expected_csrf):
                return _finish(
                    JSONResponse({"detail": "Недействительный или отсутствующий X-CSRF-Token"}, status_code=403)
                )

        # Проверка RBAC роли
        user_role = str(session.get("role") or "")
        if not _check_rbac_permission(user_role, request.method, path):
            return _finish(
                JSONResponse(
                    {"detail": f"Недостаточно прав для роли «{user_role}» ({request.method} {path})"},
                    status_code=403,
                )
            )

    try:
        return _finish(await call_next(request))
    except HTTPException as he:
        return _finish(JSONResponse({"detail": he.detail}, status_code=he.status_code))
    except Exception:
        err_id = secrets.token_hex(4)
        print(f"[Beacon Error {err_id}] Внутренняя ошибка при обработке {request.method} {path}:", flush=True)
        traceback.print_exc()
        return _finish(
            JSONResponse(
                {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                status_code=500,
            )
        )


app.include_router(internal_router)
app.include_router(ai_router)
app.include_router(ui_router)


@app.get("/")
async def serve_spa_index(request: Request) -> Any:
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html; charset=utf-8")
    return HTMLResponse("<h1>Beacon Control Panel</h1>")


@app.get("/assets/{subpath}")
async def serve_static_assets(request: Request, subpath: str) -> Any:
    assets_dir = (STATIC_DIR / "assets").resolve()
    target = (assets_dir / subpath).resolve()
    if os.path.commonpath([str(assets_dir), str(target)]) != str(assets_dir):
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    return FileResponse(target)


@app.get("/static/{subpath}")
async def serve_static_top(request: Request, subpath: str) -> Any:
    target = (STATIC_DIR / subpath).resolve()
    if os.path.commonpath([str(STATIC_DIR.resolve()), str(target)]) != str(STATIC_DIR.resolve()):
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    return FileResponse(target)


@app.get("/static/vendor/{subpath}")
async def serve_static_vendor(request: Request, subpath: str) -> Any:
    vendor_dir = (STATIC_DIR / "vendor").resolve()
    target = (vendor_dir / subpath).resolve()
    if os.path.commonpath([str(vendor_dir), str(target)]) != str(vendor_dir):
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    return FileResponse(target)


def _start_supervised_task(
    loop: asyncio.AbstractEventLoop,
    name: str,
    coro_factory: Callable[[], Any],
    restart_delay: float = 2.0,
) -> asyncio.Task[Any]:
    task = loop.create_task(coro_factory(), name=name)
    _BG_TASKS.append(task)

    def _on_done(done_task: asyncio.Task[Any]) -> None:
        if done_task in _BG_TASKS:
            _BG_TASKS.remove(done_task)
        if done_task.cancelled():
            return
        exc = done_task.exception()
        if exc is not None:
            logger.error("Фоновая задача %s аварийно завершилась: %r", name, exc, exc_info=(type(exc), exc, exc.__traceback__))
            try:
                loop.create_task(
                    send_notification(
                        f"Фоновая задача супервизора «{name}» упала ({exc}) и будет перезапущена.",
                        level="error",
                        project_name="beacon-supervisor",
                    )
                )
            except Exception:
                logger.exception("Не удалось запланировать уведомление об упавшей задаче %s", name)
        else:
            logger.warning("Фоновая задача %s завершилась неожиданно, выполняется перезапуск", name)

        def _respawn() -> None:
            _start_supervised_task(loop, name, coro_factory, restart_delay=min(30.0, restart_delay * 1.5))

        try:
            loop.call_later(restart_delay, _respawn)
        except Exception:
            logger.exception("Не удалось запланировать перезапуск фоновой задачи %s", name)

    task.add_done_callback(_on_done)
    return task


@app.on_event("startup")
async def on_startup() -> None:
    ensure_directories()
    init_db()
    get_internal_token()
    reload_redaction_cache()
    rec = recover_running_processes()
    logger.info(
        "Восстановлено выживших процессов: %s (завершено во время простоя: %s)",
        rec["recovered"],
        rec["marked_dead"],
    )
    ensure_tg_poller_running()
    loop = asyncio.get_running_loop()
    loop.create_task(autostart_services_on_boot(), name="autostart_services_on_boot")
    _start_supervised_task(loop, "watch_processes_loop", watch_processes_loop)
    _start_supervised_task(loop, "scheduler_loop", scheduler_loop)


def _run_cli_migrate() -> int:
    """Команда `python3 -m beacon migrate`: миграция БД, автоматический переезд и проверка путей."""
    from hub.names import migrate_legacy_installation

    ensure_directories()
    init_db()
    mig_res = migrate_legacy_installation(BASE_DIR)
    print(f"[Beacon Migrate] Схема базы данных SQLite успешно обновлена до версии {BEACON_VERSION}.")
    if mig_res.get("migrated_files"):
        print(f"[Beacon Migrate] Автоматически перенесено файлов старых версий: {mig_res['migrated_files']}")
    print(f"[Beacon Migrate] Рабочая директория: {BASE_DIR}")
    return 0


def _run_cli_backup(args: list[str]) -> int:
    from hub.backup_mgr import create_backup_archive

    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = Path(args[1]).resolve() if len(args) > 1 and not args[1].startswith("-") else (BACKUPS_DIR / f"beacon_backup_{ts}.zip")
    dest = create_backup_archive(out_path)
    print(f"[Beacon Backup] Резервная копия создана: {dest} ({dest.stat().st_size} байт)")
    return 0


def _run_cli_restore(args: list[str]) -> int:
    from hub.backup_mgr import restore_backup_archive

    pos = [a for a in args[1:] if not a.startswith("-")]
    if not pos:
        print("Использование: python3 -m beacon restore ARCHIVE.zip [--yes]", file=sys.stderr)
        return 2
    archive = Path(pos[0]).resolve()
    force_yes = "--yes" in args or "-y" in args
    if not force_yes and sys.stdin.isatty():
        confirm = input(f"Восстановить Beacon из {archive}? Текущая БД и проекты будут заменены [y/N]: ").strip().lower()
        if confirm not in ("y", "yes", "д", "да"):
            print("Отменено пользователем.")
            return 1
    res = restore_backup_archive(archive, stop_running=True)
    print(
        f"[Beacon Restore] Успешно восстановлено: БД={res['db_restored']}, "
        f"секретов={res['restored_secrets']}, файлов проектов={res['restored_project_files']}"
    )
    return 0


def _run_cli_reset_password(args: list[str]) -> int:
    new_pw = ""
    for i, a in enumerate(args[1:], start=1):
        if a == "--password" and i + 1 < len(args):
            new_pw = args[i + 1]
            break
        if a.startswith("--password="):
            new_pw = a.split("=", 1)[1]
            break
    if not new_pw:
        new_pw = getpass.getpass("Новый пароль администратора (мин. 8 символов): ")
    new_pw = new_pw.strip()
    if len(new_pw) < 8:
        print("[Beacon Reset-Password] Ошибка: пароль должен содержать минимум 8 символов.", file=sys.stderr)
        return 1
    if new_pw.lower() == "admin":
        print("[Beacon Reset-Password] Ошибка: новый пароль не может быть 'admin'.", file=sys.stderr)
        return 1
    set_setting("password_hash", hash_password(new_pw))
    set_setting("must_change_password", "0")
    bump_session_epoch()
    log_audit("127.0.0.1", "PASSWORD_RESET_CLI", "Пароль администратора сброшен через CLI", actor="cli")
    print("[Beacon Reset-Password] Пароль администратора успешно обновлён, активные сессии отозваны.")
    return 0


_TOKEN_PATH_LOG_RE = re.compile(r"(/api/(?:webhook|ping)/)([^/\s?\"]+)")


class _WebhookRedactFilter(logging.Filter):
    """Маскирует токены вебхуков и Dead Man's Switch в access-логах uvicorn (P2-17)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
            redacted = _TOKEN_PATH_LOG_RE.sub(r"\1***", msg)
            if redacted != msg:
                record.msg = redacted
                record.args = ()
        except Exception:
            pass
        return True


def _install_access_log_filter() -> None:
    acc_logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, _WebhookRedactFilter) for f in acc_logger.filters):
        acc_logger.addFilter(_WebhookRedactFilter())


def _write_runtime_pid_and_cmd(args: list[str]) -> Path:
    pid_file = DATA_DIR / "beacon.pid"
    cmd_file = DATA_DIR / "start.cmd"
    try:
        pid_file.write_text(f"{os.getpid()}\n", encoding="utf-8")
        cmd_str = shlex.join([sys.executable, "-m", "beacon", *args])
        cmd_file.write_text(f"{cmd_str}\n", encoding="utf-8")
    except OSError as exc:
        logger.warning("Не удалось записать beacon.pid / start.cmd: %s", exc)
    return pid_file


def main() -> None:
    ensure_directories()
    init_db()
    get_internal_token()

    args = sys.argv[1:]

    if "--safe-mode" in args or "safe-mode" in args:
        set_runtime_safe_mode(True)
        print("[Beacon Safe Mode] Включён временный безопасный режим процесса: автозапуск и фоновые циклы отключены.", flush=True)

    if args and args[0] in ("doctor", "--doctor", "check"):
        from hub.doctor import print_doctor_cli, run_hub_doctor

        report = run_hub_doctor(auto_fix_perms=True)
        sys.exit(print_doctor_cli(report))

    if args and args[0] in ("migrate", "--migrate"):
        sys.exit(_run_cli_migrate())

    if args and args[0] in ("backup", "--backup"):
        sys.exit(_run_cli_backup(args))

    if args and args[0] in ("restore", "--restore"):
        sys.exit(_run_cli_restore(args))

    if args and args[0] in ("reset-password", "--reset-password"):
        sys.exit(_run_cli_reset_password(args))

    if args and args[0] in ("ai-pause", "--ai-pause"):
        set_setting("ai_access_paused", "1")
        print("[Beacon AI Kill-Switch] Доступ ИИ (MCP и /api/v1/) поставлен на паузу.", flush=True)
        sys.exit(0)

    if args and args[0] in ("ai-resume", "--ai-resume"):
        set_setting("ai_access_paused", "0")
        print("[Beacon AI Kill-Switch] Доступ ИИ возобновлён.", flush=True)
        sys.exit(0)

    port_str = get_env_var("BEACON_PORT") or get_setting("port", "8050")
    host = get_env_var("BEACON_HOST") or "0.0.0.0"

    for i, arg in enumerate(args):
        if arg == "--port" and i + 1 < len(args):
            port_str = args[i + 1]
        elif arg.startswith("--port="):
            port_str = arg.split("=", 1)[1]
        elif arg == "--host" and i + 1 < len(args):
            host = args[i + 1]
        elif arg.startswith("--host="):
            host = arg.split("=", 1)[1]

    port = int(port_str)
    reserved = parse_reserved_ports(get_setting("reserved_ports", ""))
    if port in reserved:
        port = 8050
    set_runtime_port(port)

    if args and args[0] in ("systemd", "--systemd"):
        from hub.env_detect import generate_systemd_unit

        unit_text = generate_systemd_unit(BASE_DIR, port=port, user=get_setting("run_as_user", "root"))
        GENERATED_DIR.mkdir(parents=True, exist_ok=True)
        unit_file = GENERATED_DIR / "beacon.service"
        unit_file.write_text(unit_text, encoding="utf-8")
        print(unit_text)
        print(f"# Сохранено в {unit_file}.")
        sys.exit(0)

    pid_file = _write_runtime_pid_and_cmd(args)
    try:
        if HAS_NATIVE_FASTAPI:
            try:
                import uvicorn  # type: ignore

                _install_access_log_filter()
                # Фаза A.3: отключаем слепое доверие к заголовкам прокси в uvicorn,
                # чтобы локальные процессы не могли подделать X-Forwarded-For.
                uvicorn.run(
                    app,
                    host=host,
                    port=port,
                    workers=1,
                    log_level="info",
                    proxy_headers=False,
                    forwarded_allow_ips="",
                )
                return
            except ImportError:
                pass

        asyncio.run(run_fallback_http_server(app, host=host, port=port))
    finally:
        try:
            if pid_file.exists() and pid_file.read_text(encoding="utf-8").strip() == str(os.getpid()):
                pid_file.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    main()
