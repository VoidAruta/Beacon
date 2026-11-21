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

from hub.api import APIRouter, HTTPException, Request, parse_int_param, read_json
from hub.ask_broker import create_ask, poll_ask
from hub.db import db_session, execute_sql, log_audit, query_one
from hub.notifier import send_notification
from hub.secrets_mgr import get_secret_raw, mark_cookies_expired, validate_secret_name

from collections import deque

router = APIRouter(prefix="/internal")

_KV_KEY_RE = re.compile(r"^[a-zA-Z0-9_.:-]{1,128}$")
_NOTIFY_RATE_WINDOW_SEC = 60.0
_NOTIFY_RATE_MAX_PER_PROJECT = 20
_NOTIFY_MAX_TEXT_LEN = 4000
_ASK_MAX_PROMPT_LEN = 1000
_ASK_MAX_PENDING_PER_PROJECT = 10
_NOTIFY_TIMESTAMPS: dict[int, deque[float]] = {}


def reset_internal_rate_limits() -> None:
    """Сбрасывает счётчики rate-limit внутреннего SDK (используется в тестах)."""
    _NOTIFY_TIMESTAMPS.clear()


def _check_notify_rate_limit(project_id: int) -> None:
    now = time.monotonic()
    bucket = _NOTIFY_TIMESTAMPS.setdefault(project_id, deque())
    cutoff = now - _NOTIFY_RATE_WINDOW_SEC
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= _NOTIFY_RATE_MAX_PER_PROJECT:
        raise HTTPException(
            status_code=429,
            detail=f"Превышен лимит уведомлений SDK ({_NOTIFY_RATE_MAX_PER_PROJECT}/мин на проект)",
        )
    bucket.append(now)


def _authenticate_sdk_request(request: Request) -> dict[str, Any]:
    """
    Аутентифицирует внутренний запрос SDK строго по одноразовому токену активного запуска
    (X-Beacon-Token) в статусе running/waiting_input (P0-4).
    """
    token = (request.headers.get("x-beacon-token") or "").strip()

    if not token:
        raise HTTPException(status_code=401, detail="Отсутствует заголовок X-Beacon-Token")

    row = query_one(
        """SELECT r.id AS run_id, r.project_id, r.status,
                  p.name AS project_name, p.secrets_json
           FROM runs r
           JOIN projects p ON p.id = r.project_id
           WHERE r.run_token = ?""",
        (token,),
    )
    if not row:
        raise HTTPException(status_code=401, detail="Недействительный X-Beacon-Token")
    if row["status"] not in ("running", "waiting_input"):
        raise HTTPException(status_code=403, detail="Токен запуска (X-Beacon-Token) больше не активен (процесс завершён)")
    return row


def _enforce_project_secret_acl(ctx: dict[str, Any], clean_name: str) -> None:
    """Строгая изоляция секретов: проект может обращаться только к секретам из secrets_json или <project>_cookies."""
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
            f"Проект '{proj_name}' (run_id={ctx['run_id']}) попытался обратиться к непривязанному секрету '{clean_name}'",
        )
        raise HTTPException(
            status_code=403,
            detail=f"Секрет '{clean_name}' не привязан к проекту '{proj_name}'. Добавьте его в настройках проекта.",
        )


def _validate_kv_key(key: str) -> str:
    clean = (key or "").strip()
    if not clean or not _KV_KEY_RE.match(clean):
        raise HTTPException(
            status_code=400,
            detail="Недопустимый ключ beacon.state (разрешены латинские буквы, цифры, '_', '-', '.', ':' до 128 символов)",
        )
    return clean


@router.post("/notify")
async def internal_notify(request: Request) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    _check_notify_rate_limit(int(ctx["project_id"]))
    body = await read_json(request)
    text = str(body.get("text", "")).strip()
    level = str(body.get("level", "info")).strip().lower()
    if level not in ("info", "warn", "error"):
        level = "info"
    if not text:
        raise HTTPException(status_code=400, detail="Пустой текст уведомления")
    if len(text) > _NOTIFY_MAX_TEXT_LEN:
        text = text[:_NOTIFY_MAX_TEXT_LEN] + "… [truncated]"

    await send_notification(text=text, level=level, project_name=ctx["project_name"])
    return {"ok": True}


@router.get("/secret/{name}")
async def internal_get_secret(request: Request, name: str) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    try:
        clean_name = validate_secret_name(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    _enforce_project_secret_acl(ctx, clean_name)

    sec = get_secret_raw(clean_name)
    if not sec:
        raise HTTPException(status_code=404, detail=f"Секрет '{clean_name}' не найден")

    log_audit("127.0.0.1", "SECRET_READ", f"Проект '{ctx['project_name']}' прочитал секрет '{clean_name}'")
    return sec


@router.post("/cookies_expired")
async def internal_cookies_expired(request: Request) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    body = await read_json(request)
    secret_name = str(body.get("secret_name", "")).strip()
    note = str(body.get("note", "Куки устарели, требуется обновление")).strip()
    try:
        clean_name = validate_secret_name(secret_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    _enforce_project_secret_acl(ctx, clean_name)
    updated = mark_cookies_expired(clean_name, note=note)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Секрет '{clean_name}' не найден")

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
    proj_id = int(ctx["project_id"])
    pending_row = query_one(
        "SELECT COUNT(*) AS cnt FROM pending_asks WHERE project_id = ? AND status = 'pending'",
        (proj_id,),
    )
    if int((pending_row or {}).get("cnt") or 0) >= _ASK_MAX_PENDING_PER_PROJECT:
        raise HTTPException(
            status_code=429,
            detail=f"Превышен лимит активных запросов beacon.ask() ({_ASK_MAX_PENDING_PER_PROJECT} на проект)",
        )
    body = await read_json(request)
    prompt = str(body.get("prompt", "Введите код подтверждения:")).strip()
    if len(prompt) > _ASK_MAX_PROMPT_LEN:
        prompt = prompt[:_ASK_MAX_PROMPT_LEN] + "…"
    timeout = parse_int_param(body.get("timeout"), "timeout", default=300, min_val=5, max_val=3600)

    ask_id = await create_ask(
        run_id=int(ctx["run_id"]),
        project_id=proj_id,
        project_name=str(ctx["project_name"]),
        prompt=prompt,
        timeout=timeout,
    )
    return {"ok": True, "ask_id": ask_id}


@router.get("/ask/poll/{ask_id}")
async def internal_ask_poll(request: Request, ask_id: str) -> dict[str, Any]:
    ctx = _authenticate_sdk_request(request)
    try:
        return await poll_ask(ask_id, wait_sec=10.0, expected_project_id=int(ctx["project_id"]))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


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
    body = await read_json(request)
    val = body.get("value")
    val_json = json.dumps(val, ensure_ascii=False)
    if len(val_json.encode("utf-8")) > 256 * 1024:
        raise HTTPException(status_code=413, detail="Размер значения state превышает лимит 256 КБ")
    proj_id = int(ctx["project_id"])
    now = int(time.time())
    with db_session() as conn:
        existing_kv = conn.execute(
            "SELECT 1 FROM project_kv WHERE project_id = ? AND key = ?",
            (proj_id, clean_key),
        ).fetchone()
        if not existing_kv:
            cnt_row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM project_kv WHERE project_id = ?",
                (proj_id,),
            ).fetchone()
            if int((cnt_row["cnt"] if cnt_row else 0) or 0) >= 1000:
                raise HTTPException(status_code=400, detail="Достигнут лимит 1000 ключей KV на проект")
        conn.execute(
            """INSERT INTO project_kv (project_id, key, value_json, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(project_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at""",
            (proj_id, clean_key, val_json, now),
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
