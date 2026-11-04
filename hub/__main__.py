"""
Точка входа Aruta (совместимо с `python3 -m aruta` и `python3 -m hub`):
Запускает сервер на 0.0.0.0:8050 (или порту из настроек / аргументов CLI), инициализирует SQLite (WAL),
подхватывает выжившие процессы (recover_running_processes) и запускает фоновые циклы
process_mgr и scheduler.
"""

import asyncio
import hmac
import os
import secrets
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

from hub.api import (
    HAS_NATIVE_FASTAPI,
    MAX_REQUEST_BODY_BYTES,
    FastAPI,
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Request,
    run_fallback_http_server,
)
from hub.api.routes_ai import router as ai_router
from hub.api.routes_internal import router as internal_router
from hub.api.routes_ui import router as ui_router
from hub.ask_broker import ensure_tg_poller_running
from hub.auth import (
    consume_stream_ticket,
    get_internal_token,
    is_ip_allowed,
    resolve_client_ip,
    verify_session_token,
)
from hub.config import BASE_DIR, STATIC_DIR, ensure_directories, get_env_var, parse_reserved_ports
from hub.db import get_setting, init_db, set_setting
from hub.process_mgr import recover_running_processes, watch_processes_loop
from hub.scheduler import autostart_services_on_boot, scheduler_loop
from hub.secrets_mgr import reload_redaction_cache

app = FastAPI(title="Beacon Control Panel", version="2.2.0")

# Фоновые задачи жизненного цикла
_BG_TASKS: list[asyncio.Task[Any]] = []

_SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; "
        "font-src 'self' data:; "
        "frame-ancestors 'none'"
    ),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


def _attach_security_headers(response: Any) -> Any:
    if hasattr(response, "headers") and isinstance(response.headers, dict):
        for k, v in _SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
    elif hasattr(response, "headers"):
        try:
            for k, v in _SECURITY_HEADERS.items():
                if k not in response.headers:
                    response.headers[k] = v
        except Exception:
            pass
    return response


def _check_rbac_permission(role: str, method: str, path: str) -> bool:
    """
    Ролевая модель RBAC (Фаза D.4):
    - admin: полный доступ
    - operator: чтение + запуск/остановка/рестарт/stdin/ответы на ask/создание stream_ticket
    - viewer: только чтение (GET/HEAD) и создание одноразового stream_ticket для просмотра лога
    """
    norm_role = (role or "admin").lower()
    if norm_role == "admin":
        return True
    if method in ("GET", "HEAD", "OPTIONS"):
        return True
    if path in ("/api/auth/logout", "/api/auth/stream_ticket"):
        return True
    if norm_role == "operator":
        if (
            path.endswith("/start")
            or path.endswith("/stop")
            or path.endswith("/restart")
            or path.endswith("/stdin")
            or path.endswith("/answer")
        ):
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

    path = request.url.path
    direct_ip = request.client.host if request.client else "127.0.0.1"
    fwd_for = request.headers.get("x-forwarded-for", "")
    client_ip = resolve_client_ip(direct_ip, fwd_for)
    try:
        request.state.client_ip = client_ip
    except Exception:
        pass

    # 1. Запросы на /internal/* разрешены только с локального интерфейса (127.0.0.1 / ::1)
    if path.startswith("/internal"):
        clean_direct = direct_ip.replace("::ffff:", "")
        if clean_direct not in ("127.0.0.1", "::1", "localhost"):
            return _attach_security_headers(
                JSONResponse({"detail": "Доступ к /internal разрешён только с 127.0.0.1"}, status_code=403)
            )
        try:
            resp = await call_next(request)
            return _attach_security_headers(resp)
        except Exception:
            err_id = secrets.token_hex(4)
            traceback.print_exc()
            return _attach_security_headers(
                JSONResponse(
                    {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                    status_code=500,
                )
            )

    # 2. Маршруты ИИ (/mcp, /api/v1/*) и Dead Man's Switch (/api/ping/*) используют собственную авторизацию
    if path == "/mcp" or path.startswith("/api/v1/") or path.startswith("/api/ping/"):
        try:
            resp = await call_next(request)
            return _attach_security_headers(resp)
        except Exception:
            err_id = secrets.token_hex(4)
            traceback.print_exc()
            return _attach_security_headers(
                JSONResponse(
                    {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                    status_code=500,
                )
            )

    # 3. Фильтр подсетей (allowed_subnets + ограничение для дефолтного пароля admin)
    if not is_ip_allowed(client_ip):
        return _attach_security_headers(
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
            resp = await call_next(request)
            return _attach_security_headers(resp)
        except Exception:
            err_id = secrets.token_hex(4)
            traceback.print_exc()
            return _attach_security_headers(
                JSONResponse(
                    {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                    status_code=500,
                )
            )

    # 5. Проверка сессии, одноразовых SSE-тикетов, RBAC и CSRF для защищённых маршрутов /api/*
    if path.startswith("/api/"):
        # ВНИМАНИЕ (Фаза A.4): приём session_token из query-параметра удалён!
        # Для SSE (/api/runs/{id}/stream) поддерживается одноразовый короткоживущий ?ticket=
        token = (
            request.cookies.get("beacon_session")
            or request.cookies.get("aruta_session")
            or request.cookies.get("hub_session")
            or request.headers.get("x-beacon-session", "")
            or request.headers.get("x-aruta-session", "")
            or request.headers.get("x-hub-session", "")
        )
        session = verify_session_token(token)

        if not session and path.startswith("/api/runs/") and path.endswith("/stream") and request.method == "GET":
            ticket = request.query_params.get("ticket", "")
            parts = path.strip("/").split("/")
            # ["api", "runs", "{run_id}", "stream"]
            run_id_val = int(parts[2]) if len(parts) >= 4 and parts[2].isdigit() else None
            if ticket and consume_stream_ticket(ticket, run_id=run_id_val):
                session = {"sub": "stream_ticket", "role": "viewer", "csrf": ""}

        if not session:
            return _attach_security_headers(
                JSONResponse({"detail": "Требуется авторизация"}, status_code=401)
            )

        try:
            request.state.session = session
        except Exception:
            pass

        # Проверка CSRF на ВСЕ небезопасные методы (POST, PUT, PATCH, DELETE)
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            csrf_header = request.headers.get("x-csrf-token", "")
            expected_csrf = str(session.get("csrf") or "")
            if not csrf_header or not expected_csrf or not hmac.compare_digest(csrf_header, expected_csrf):
                return _attach_security_headers(
                    JSONResponse({"detail": "Недействительный или отсутствующий X-CSRF-Token"}, status_code=403)
                )

        # Проверка RBAC роли
        user_role = str(session.get("role") or "admin")
        if not _check_rbac_permission(user_role, request.method, path):
            return _attach_security_headers(
                JSONResponse(
                    {"detail": f"Недостаточно прав для роли «{user_role}» ({request.method} {path})"},
                    status_code=403,
                )
            )

    try:
        resp = await call_next(request)
        return _attach_security_headers(resp)
    except Exception:
        err_id = secrets.token_hex(4)
        print(f"[Aruta Error {err_id}] Внутренняя ошибка при обработке {request.method} {path}:", flush=True)
        traceback.print_exc()
        return _attach_security_headers(
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
    return HTMLResponse("<h1>Aruta Control Panel</h1>")


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


@app.on_event("startup")
async def on_startup() -> None:
    ensure_directories()
    init_db()
    get_internal_token()
    reload_redaction_cache()
    rec = recover_running_processes()
    print(
        f"[Aruta Startup] Восстановлено выживших процессов: {rec['recovered']} (завершено во время простоя: {rec['marked_dead']})",
        flush=True,
    )
    await autostart_services_on_boot()
    ensure_tg_poller_running()
    loop = asyncio.get_running_loop()
    _BG_TASKS.append(loop.create_task(watch_processes_loop()))
    _BG_TASKS.append(loop.create_task(scheduler_loop()))


def _run_cli_migrate() -> int:
    """Команда `python3 -m aruta migrate`: миграция БД и проверка совместимости путей."""
    ensure_directories()
    init_db()
    print("[Aruta Migrate] Схема базы данных SQLite успешно обновлена до версии 2.2.0.")
    print(f"[Aruta Migrate] Рабочая директория: {BASE_DIR}")
    return 0


def main() -> None:
    ensure_directories()
    init_db()
    get_internal_token()

    args = sys.argv[1:]

    if "--safe-mode" in args or "safe-mode" in args:
        set_setting("safe_mode", "1")
        print("[Aruta Safe Mode] Включён безопасный режим: автозапуск сервисов и фоновых задач отключён.", flush=True)

    if args and args[0] in ("doctor", "--doctor", "check"):
        from hub.doctor import print_doctor_cli, run_hub_doctor

        report = run_hub_doctor(auto_fix_perms=True)
        sys.exit(print_doctor_cli(report))

    if args and args[0] in ("migrate", "--migrate"):
        sys.exit(_run_cli_migrate())

    if args and args[0] in ("ai-pause", "--ai-pause"):
        set_setting("ai_access_paused", "1")
        print("[Aruta AI Kill-Switch] Доступ ИИ (MCP и /api/v1/) поставлен на паузу.", flush=True)
        sys.exit(0)

    if args and args[0] in ("ai-resume", "--ai-resume"):
        set_setting("ai_access_paused", "0")
        print("[Aruta AI Kill-Switch] Доступ ИИ возобновлён.", flush=True)
        sys.exit(0)

    port_str = get_env_var("ARUTA_PORT", "HUB_PORT") or get_setting("port", "8050")
    host = get_env_var("ARUTA_HOST", "HUB_HOST") or "0.0.0.0"

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

    if args and args[0] in ("systemd", "--systemd"):
        from hub.env_detect import generate_systemd_unit

        unit_text = generate_systemd_unit(BASE_DIR, port=port, user=get_setting("run_as_user", "root"))
        for fname in ("beacon.service", "aruta.service", "hub.service"):
            unit_file = BASE_DIR / "scripts" / fname
            try:
                unit_file.parent.mkdir(parents=True, exist_ok=True)
                unit_file.write_text(unit_text, encoding="utf-8")
            except OSError:
                pass
        print(unit_text)
        print(f"# Сохранено в {BASE_DIR / 'scripts' / 'beacon.service'} и hub.service.")
        sys.exit(0)

    if HAS_NATIVE_FASTAPI:
        try:
            import uvicorn  # type: ignore

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


if __name__ == "__main__":
    main()
