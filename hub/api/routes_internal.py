"""
Внутреннее API для SDK (/internal/*, доступно с 127.0.0.1 по заголовку X-Hub-Token).
Контракт:
- POST   /internal/notify
- GET    /internal/secret/{name}
- POST   /internal/cookies_expired
- POST   /internal/ask/create
- GET    /internal/ask/poll/{ask_id}
- GET    /internal/kv/{key}
- PUT    /internal/kv/{key}
- DELETE /internal/kv/{key}
"""

import json
import re
import time
from typing import Any

from hub.api import APIRouter, HTTPException, Request
from hub.ask_broker import create_ask, poll_ask
from hub.auth import verify_internal_token
from hub.db import execute_sql, log_audit, query_one
from hub.notifier import send_notification
from hub.secrets_mgr import get_secret_raw, mark_cookies_expired, validate_secret_name

router = APIRouter(prefix="/internal")

_KV_KEY_RE = re.compile(r"^[a-zA-Z0-9_.:-]{1,128}$")


def _authenticate_sdk_request(request: Request) -> dict[str, Any]:
    """
    Проверяет:
    1. Заголовок X-Hub-Token (уникальный токен активного запуска run_token в статусе running/waiting_input);
    2. Заголовок X-Hub-Internal-Token (токен экземпляра Hub из data/internal.token), если он передан.
    """
    token = (
        request.headers.get("x-beacon-token")
        or request.headers.get("x-aruta-token")
        or request.headers.get("x-hub-token")
        or ""
    ).strip()
    internal_hdr = (
        request.headers.get("x-beacon-internal-token")
        or request.headers.get("x-aruta-internal-token")
        or request.headers.get("x-hub-internal-token")
        or ""
    ).strip()

    if internal_hdr and not verify_internal_token(internal_hdr):
        raise HTTPException(status_code=403, detail="Недействительный X-Beacon-Internal-Token / X-Hub-Internal-Token")

    if not token:
        raise HTTPException(status_code=401, detail="Отсутствует заголовок X-Beacon-Token / X-Hub-Token")

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


def _validate_kv_key(key: str) -> str:
    clean = (key or "").strip()
    if not clean or not _KV_KEY_RE.match(clean):
        raise HTTPException(
            status_code=400,
            detail="Недопустимый ключ hub.state (разрешены латинские буквы, цифры, '_', '-', '.', ':' до 128 символов)",
        )
    return clean


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

    log_audit("127.0.0.1", "SECRET_READ", f"Проект '{proj_name}' прочитал секрет '{clean_name}'")
    return sec


@router.post("/cookies_expired")
async def internal_cookies_expired(request: Request) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    body = await request.json()
    secret_name = str(body.get("secret_name", "")).strip()
    note = str(body.get("note", "Куки устарели, требуется обновление")).strip()
    try:
        clean_name = validate_secret_name(secret_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    mark_cookies_expired(clean_name, note=note)
    log_audit(
        "127.0.0.1",
        "COOKIES_EXPIRED_SIGNAL",
        f"Проект '{ctx['project_name']}' пометил куки '{clean_name}' как устаревшие: {note}",
    )
    await send_notification(
        f"Проект «{ctx['project_name']}» сообщил об истечении куки «{clean_name}»: {note}",
        level="warn",
        project_name=ctx["project_name"],
    )
    return {"ok": True, "secret_name": clean_name, "is_expired": 1}


@router.post("/ask/create")
async def internal_ask_create(request: Request) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    body = await request.json()
    prompt = str(body.get("prompt", "Введите код подтверждения:")).strip()
    timeout = max(5, min(3600, int(body.get("timeout", 300) or 300)))

    ask_id = await create_ask(
        run_id=int(ctx["run_id"]),
        project_id=int(ctx["project_id"]),
        project_name=str(ctx["project_name"]),
        prompt=prompt,
        timeout=timeout,
    )
    return {"ok": True, "ask_id": ask_id}


@router.get("/ask/poll/{ask_id}")
async def internal_ask_poll(request: Request, ask_id: str) -> dict[str, Any]:
    _authenticate_sdk_request(request)
    return await poll_ask(ask_id, wait_sec=10.0)


@router.get("/kv/{key}")
async def internal_kv_get(request: Request, key: str) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    clean_key = _validate_kv_key(key)
    row = query_one(
        "SELECT value_json, updated_at FROM project_kv WHERE project_id = ? AND key = ?",
        (int(ctx["project_id"]), clean_key),
    )
    if not row:
        return {"ok": True, "found": False, "key": clean_key, "value": None}
    try:
        val = json.loads(row["value_json"])
    except Exception:
        val = row["value_json"]
    return {"ok": True, "found": True, "key": clean_key, "value": val, "updated_at": row["updated_at"]}


@router.put("/kv/{key}")
async def internal_kv_put(request: Request, key: str) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    clean_key = _validate_kv_key(key)
    body = await request.json()
    val = body.get("value")
    val_json = json.dumps(val, ensure_ascii=False)
    now = int(time.time())
    execute_sql(
        """INSERT INTO project_kv (project_id, key, value_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at""",
        (int(ctx["project_id"]), clean_key, val_json, now),
    )
    return {"ok": True, "key": clean_key, "value": val, "updated_at": now}


@router.delete("/kv/{key}")
async def internal_kv_delete(request: Request, key: str) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    clean_key = _validate_kv_key(key)
    execute_sql(
        "DELETE FROM project_kv WHERE project_id = ? AND key = ?",
        (int(ctx["project_id"]), clean_key),
    )
    return {"ok": True, "deleted": clean_key}
