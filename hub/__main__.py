"""
Точка входа Hub: python3 -m hub
Запускает сервер на 0.0.0.0:8050 (или порту из настроек), инициализирует SQLite (WAL),
подхватывает выжившие процессы (recover_running_processes) и запускает фоновые циклы
process_mgr и scheduler.
"""

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Callable

from hub.api import (
    HAS_NATIVE_FASTAPI,
    FastAPI,
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Request,
    run_fallback_http_server,
)
from hub.api.routes_internal import router as internal_router
from hub.api.routes_ui import router as ui_router
from hub.auth import is_ip_allowed, verify_session_token
from hub.config import FORBIDDEN_PORTS, STATIC_DIR, ensure_directories
from hub.db import get_setting, init_db
from hub.process_mgr import recover_running_processes, watch_processes_loop
from hub.scheduler import autostart_services_on_boot, scheduler_loop
from hub.secrets_mgr import reload_redaction_cache

app = FastAPI(title="Hub Control Panel", version="1.0.0")

# Фоновые задачи жизненного цикла
_BG_TASKS: list[asyncio.Task[Any]] = []


@app.middleware("http")
async def security_and_auth_middleware(request: Request, call_next: Callable[[Request], Any]) -> Any:
    path = request.url.path
    client_ip = request.client.host if request.client else "127.0.0.1"

    # 1. Запросы на /internal/* разрешены только с локального интерфейса (127.0.0.1 / ::1)
    if path.startswith("/internal"):
        clean_ip = client_ip.replace("::ffff:", "")
        if clean_ip not in ("127.0.0.1", "::1", "localhost"):
            return JSONResponse({"detail": "Доступ к /internal разрешён только с 127.0.0.1"}, status_code=403)
        return await call_next(request)

    # 2. Фильтр подсетей (allowed_subnets)
    if not is_ip_allowed(client_ip):
        return JSONResponse({"detail": f"Доступ с IP {client_ip} запрещён фильтром подсетей"}, status_code=403)

    # 3. Открытые маршруты (статика, вход, проверка сессии, внешние вебхуки)
    if (
        path in ("/", "/index.html", "/favicon.ico", "/api/auth/login", "/api/auth/me")
        or path.startswith("/static/")
        or path.startswith("/assets/")
        or path.startswith("/api/webhook/")
    ):
        return await call_next(request)

    # 4. Проверка сессии и CSRF для защищённых маршрутов /api/*
    if path.startswith("/api/"):
        token = request.cookies.get("hub_session") or request.headers.get("x-hub-session", "")
        session = verify_session_token(token)
        if not session:
            return JSONResponse({"detail": "Требуется авторизация"}, status_code=401)

        if request.method in ("POST", "PUT", "DELETE"):
            csrf_header = request.headers.get("x-csrf-token", "")
            if not csrf_header or csrf_header != session.get("csrf"):
                return JSONResponse({"detail": "Недействительный или отсутствующий X-CSRF-Token"}, status_code=403)

    return await call_next(request)


app.include_router(internal_router)
app.include_router(ui_router)


@app.get("/")
async def serve_spa_index(request: Request) -> Any:
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html; charset=utf-8")
    return HTMLResponse("<h1>Hub Control Panel</h1>")


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
    reload_redaction_cache()
    rec = recover_running_processes()
    print(
        f"[Hub Startup] Восстановлено выживших процессов: {rec['recovered']} (завершено во время простоя: {rec['marked_dead']})",
        flush=True,
    )
    await autostart_services_on_boot()
    loop = asyncio.get_running_loop()
    _BG_TASKS.append(loop.create_task(watch_processes_loop()))
    _BG_TASKS.append(loop.create_task(scheduler_loop()))


def main() -> None:
    ensure_directories()
    init_db()
    port_str = os.environ.get("HUB_PORT") or get_setting("port", "8050")
    port = int(port_str)
    if port in FORBIDDEN_PORTS:
        port = 8050

    if HAS_NATIVE_FASTAPI:
        try:
            import uvicorn  # type: ignore

            uvicorn.run(app, host="0.0.0.0", port=port, workers=1, log_level="info")
            return
        except ImportError:
            pass

    asyncio.run(run_fallback_http_server(app, host="0.0.0.0", port=port))


if __name__ == "__main__":
    main()
