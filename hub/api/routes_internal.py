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
from hub.auth import verify_internal_token
from hub.db import log_audit, query_one
from hub.notifier import send_notification
from hub.secrets_mgr import get_secret_raw, mark_cookies_expired, validate_secret_name

router = APIRouter(prefix="/internal")


def _authenticate_sdk_request(request: Request) -> dict[str, Any]:
    """
    Проверяет:
    1. Заголовок X-Hub-Token (уникальный токен активного запуска run_token в статусе running/waiting_input);
    2. Заголовок X-Hub-Internal-Token (токен экземпляра Hub из data/internal.token), если он передан.
    """
    token = (request.headers.get("x-hub-token") or "").strip()
    internal_hdr = (request.headers.get("x-hub-internal-token") or "").strip()

    if internal_hdr and not verify_internal_token(internal_hdr):
        raise HTTPException(status_code=403, detail="Недействительный X-Hub-Internal-Token")

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
    if row["status"] not in ("running", "waiting_input"):
        raise HTTPException(status_code=403, detail="Токен запуска (X-Hub-Token) больше не активен (процесс завершён)")
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
    try:
        clean_name = validate_secret_name(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # Строгая изоляция секретов: проект может читать только секреты из своего secrets_json (или свои <project_name>_cookies)
    try:
        raw_allowed = json.loads(ctx.get("secrets_json") or "[]")
        allowed_list = [str(x) for x in raw_allowed] if isinstance(raw_allowed, list) else []
    except Exception:
        allowed_list = []

    proj_name = str(ctx.get("project_name") or "")
    own_cookies = f"{proj_name}_cookies"
    if clean_name not in allowed_list and clean_name != own_cookies:
        log_audit(
            "127.0.0.1",
            "SECRET_ACCESS_DENIED",
            f"Проект '{proj_name}' (run_id={ctx['run_id']}) попытался прочитать непривязанный секрет '{clean_name}'",
        )
        raise HTTPException(
            status_code=403,
            detail=f"Секрет '{clean_name}' не привязан к проекту '{proj_name}'. Добавьте его в настройках проекта.",
        )

    sec = get_secret_raw(clean_name)
    if not sec:
        raise HTTPException(status_code=404, detail=f"Секрет '{clean_name}' не найден")

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

    try:
        clean_name = validate_secret_name(secret_name)
        mark_cookies_expired(clean_name, note=note)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    await send_notification(
        f"Протухли куки «{clean_name}»! {note}\nОткройте веб-панель Hub и обновите JSON из Cookie-Editor.",
        level="error",
        project_name=ctx["project_name"],
    )
    return {"ok": True, "secret_name": clean_name, "is_expired": 1}


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
