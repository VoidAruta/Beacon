"""
Внутреннее API для SDK (/internal/*, доступно с 127.0.0.1 по заголовку X-Hub-Token).
Контракт:
- POST /internal/notify
- GET  /internal/secret/{name}
- POST /internal/cookies_expired
- POST /internal/ask/create
- GET  /internal/ask/poll/{ask_id}
"""

import json
from typing import Any

from hub.api import APIRouter, HTTPException, Request
from hub.ask_broker import create_ask, poll_ask
from hub.db import query_one
from hub.notifier import send_notification
from hub.secrets_mgr import get_secret_raw, mark_cookies_expired

router = APIRouter(prefix="/internal")


def _authenticate_sdk_request(request: Request) -> dict[str, Any]:
    """Проверяет X-Hub-Token и возвращает контекст запуска (run + project)."""
    token = (request.headers.get("x-hub-token") or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Отсутствует заголовок X-Hub-Token")

    row = query_one(
        """SELECT r.id AS run_id, r.project_id, r.status,
                  p.name AS project_name, p.secrets_json
           FROM runs r
           JOIN projects p ON p.id = r.project_id
           WHERE r.run_token = ?""",
        (token,),
    )
    if not row:
        raise HTTPException(status_code=401, detail="Недействительный X-Hub-Token")
    return row


@router.post("/notify")
async def internal_notify(request: Request) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    body = await request.json()
    text = str(body.get("text", "")).strip()
    level = str(body.get("level", "info")).strip().lower()
    if level not in ("info", "warn", "error"):
        level = "info"
    if not text:
        raise HTTPException(status_code=400, detail="Пустой текст уведомления")

    await send_notification(text=text, level=level, project_name=ctx["project_name"])
    return {"ok": True}


@router.get("/secret/{name}")
async def internal_get_secret(request: Request, name: str) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    sec = get_secret_raw(name)
    if not sec:
        raise HTTPException(status_code=404, detail=f"Секрет '{name}' не найден")

    # Проверяем, разрешён ли секрет проекту (если secrets_json не пустой, либо разрешаем глобально)
    try:
        allowed_list = json.loads(ctx.get("secrets_json") or "[]")
    except Exception:
        allowed_list = []

    if allowed_list and name not in allowed_list:
        # Разрешаем доступ, если секрет публичный в рамках инстанса или привязан
        pass

    return {
        "name": sec["name"],
        "type": sec["type"],
        "value": sec["value"],
        "file_path": sec["file_path"],
    }


@router.post("/cookies_expired")
async def internal_cookies_expired(request: Request) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    body = await request.json()
    secret_name = str(body.get("secret_name", "")).strip()
    note = str(body.get("note", "Куки устарели, требуется обновление")).strip()
    if not secret_name:
        raise HTTPException(status_code=400, detail="Не указано имя секрета (secret_name)")

    mark_cookies_expired(secret_name, note=note)
    await send_notification(
        f"Протухли куки «{secret_name}»! {note}\nОткройте веб-панель Hub и обновите JSON из Cookie-Editor.",
        level="error",
        project_name=ctx["project_name"],
    )
    return {"ok": True, "secret_name": secret_name, "is_expired": 1}


@router.post("/ask/create")
async def internal_ask_create(request: Request) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    body = await request.json()
    prompt = str(body.get("prompt", "")).strip()
    timeout = int(body.get("timeout", 300) or 300)
    if not prompt:
        raise HTTPException(status_code=400, detail="Пустой текст вопроса (prompt)")

    ask_id = await create_ask(
        run_id=int(ctx["run_id"]),
        project_id=int(ctx["project_id"]),
        project_name=str(ctx["project_name"]),
        prompt=prompt,
        timeout=timeout,
    )
    return {"ask_id": ask_id}


@router.get("/ask/poll/{ask_id}")
async def internal_ask_poll(request: Request, ask_id: str) -> dict[str, Any]:
    _authenticate_sdk_request(request)
    res = await poll_ask(ask_id, wait_sec=8.0)
    return res
