"""
Менеджер интерактивных запросов hub.ask() (ожидание ответа из Web UI или Reply в Telegram).
"""

import asyncio
import time
import uuid
from typing import Any, Optional

from hub.compat import httpx
from hub.db import execute_sql, get_all_settings, query_all, query_one
from hub.notifier import send_telegram_message

# В памяти: ask_id -> asyncio.Event
_ASK_EVENTS: dict[str, asyncio.Event] = {}
_TG_OFFSET: int = 0
_POLLER_TASK: Optional[asyncio.Task[None]] = None


def _get_or_create_event(ask_id: str) -> asyncio.Event:
    ev = _ASK_EVENTS.get(ask_id)
    if ev is None:
        ev = asyncio.Event()
        _ASK_EVENTS[ask_id] = ev
    return ev


async def create_ask(run_id: int, project_id: int, project_name: str, prompt: str, timeout: int = 300) -> str:
    """
    Создаёт интерактивный запрос в pending_asks, переводит run в waiting_input,
    отправляет сообщение в Telegram и запускает фоновый пуллинг getUpdates.
    """
    ask_id = str(uuid.uuid4())
    now = int(time.time())
    timeout_sec = max(5, int(timeout))
    expires_at = now + timeout_sec

    _get_or_create_event(ask_id)

    execute_sql(
        """INSERT INTO pending_asks (id, run_id, project_id, prompt, status, answer, created_at, expires_at, tg_message_id)
           VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)""",
        (ask_id, run_id, project_id, prompt, now, expires_at),
    )
    execute_sql(
        "UPDATE runs SET status = 'waiting_input' WHERE id = ? AND status = 'running'",
        (run_id,),
    )

    tg_text = (
        f"🔐 [Проект: {project_name}] Запрос ввода (таймаут {timeout_sec}с):\n\n"
        f"{prompt}\n\n"
        f"Ответьте Reply на это сообщение или введите ответ в веб-панели."
    )
    tg_msg_id = await send_telegram_message(tg_text)
    if tg_msg_id is not None:
        execute_sql("UPDATE pending_asks SET tg_message_id = ? WHERE id = ?", (tg_msg_id, ask_id))

    ensure_tg_poller_running()
    return ask_id


def answer_ask(ask_id: str, answer: str, source: str = "web") -> bool:
    """
    Записывает ответ в pending_asks, переводит статус в 'answered',
    возвращает run в 'running' и пробуждает ожидающий скрипт через asyncio.Event.
    """
    row = query_one("SELECT id, run_id, status FROM pending_asks WHERE id = ?", (ask_id,))
    if not row or row["status"] != "pending":
        return False

    execute_sql(
        "UPDATE pending_asks SET status = 'answered', answer = ? WHERE id = ?",
        (str(answer), ask_id),
    )
    execute_sql(
        "UPDATE runs SET status = 'running' WHERE id = ? AND status = 'waiting_input'",
        (row["run_id"],),
    )
    ev = _ASK_EVENTS.get(ask_id)
    if ev is not None:
        ev.set()
    return True


async def poll_ask(ask_id: str, wait_sec: float = 10.0) -> dict[str, Any]:
    """
    Long-poll ожидания ответа до wait_sec секунд.
    Контракт: { "status": "pending|answered|timeout|cancelled", "answer": "..." }
    """
    row = query_one("SELECT id, run_id, status, answer, expires_at FROM pending_asks WHERE id = ?", (ask_id,))
    if not row:
        return {"status": "cancelled", "answer": None}

    if row["status"] != "pending":
        return {"status": row["status"], "answer": row["answer"]}

    now = time.time()
    if now >= row["expires_at"]:
        execute_sql("UPDATE pending_asks SET status = 'timeout' WHERE id = ?", (ask_id,))
        execute_sql(
            "UPDATE runs SET status = 'running' WHERE id = ? AND status = 'waiting_input'",
            (row["run_id"],),
        )
        _ASK_EVENTS.pop(ask_id, None)
        return {"status": "timeout", "answer": None}

    ev = _get_or_create_event(ask_id)
    remaining = max(0.1, min(wait_sec, float(row["expires_at"]) - now))
    try:
        await asyncio.wait_for(ev.wait(), timeout=remaining)
    except asyncio.TimeoutError:
        pass

    updated = query_one("SELECT status, answer, expires_at, run_id FROM pending_asks WHERE id = ?", (ask_id,))
    if not updated:
        return {"status": "cancelled", "answer": None}

    if updated["status"] == "pending" and time.time() >= updated["expires_at"]:
        execute_sql("UPDATE pending_asks SET status = 'timeout' WHERE id = ?", (ask_id,))
        execute_sql(
            "UPDATE runs SET status = 'running' WHERE id = ? AND status = 'waiting_input'",
            (updated["run_id"],),
        )
        _ASK_EVENTS.pop(ask_id, None)
        return {"status": "timeout", "answer": None}

    if updated["status"] != "pending":
        _ASK_EVENTS.pop(ask_id, None)

    return {"status": updated["status"], "answer": updated["answer"]}


def get_active_asks() -> list[dict[str, Any]]:
    """Возвращает список активных запросов ввода для жёлтого баннера WAITING_INPUT в шапке UI."""
    now = int(time.time())
    # Сначала помечаем истёкшие запросы
    expired = query_all("SELECT id, run_id FROM pending_asks WHERE status = 'pending' AND expires_at <= ?", (now,))
    for ex in expired:
        execute_sql("UPDATE pending_asks SET status = 'timeout' WHERE id = ?", (ex["id"],))
        execute_sql(
            "UPDATE runs SET status = 'running' WHERE id = ? AND status = 'waiting_input'",
            (ex["run_id"],),
        )
        ev = _ASK_EVENTS.pop(ex["id"], None)
        if ev:
            ev.set()

    rows = query_all(
        """SELECT a.id, a.run_id, a.project_id, p.name AS project_name,
                  a.prompt, a.status, a.created_at, a.expires_at, a.tg_message_id
           FROM pending_asks a
           JOIN projects p ON p.id = a.project_id
           WHERE a.status = 'pending'
           ORDER BY a.created_at ASC"""
    )
    for r in rows:
        r["remaining_sec"] = max(0, int(r["expires_at"]) - now)
    return rows


def ensure_tg_poller_running() -> None:
    global _POLLER_TASK
    try:
        loop = asyncio.get_running_loop()
        if _POLLER_TASK is None or _POLLER_TASK.done():
            _POLLER_TASK = loop.create_task(_tg_polling_loop())
    except RuntimeError:
        pass


async def _tg_polling_loop() -> None:
    """
    Пока есть хотя бы один pending_ask со статусом 'pending',
    опрашивает Telegram getUpdates (через прокси 127.0.0.1:10808 с long polling timeout=10).
    """
    global _TG_OFFSET
    while True:
        active = get_active_asks()
        if not active:
            return

        cfg = get_all_settings()
        token = cfg.get("tg_bot_token", "").strip()
        chat_id = cfg.get("tg_chat_id", "").strip()
        if not token or not chat_id:
            await asyncio.sleep(2.0)
            continue

        use_proxy = cfg.get("tg_use_proxy", "1") == "1"
        proxy_url = cfg.get("proxy_url", "http://127.0.0.1:10808").strip() if use_proxy else None
        url = f"https://api.telegram.org/bot{token}/getUpdates"

        try:
            async with httpx.AsyncClient(proxy=proxy_url, timeout=15.0) as client:
                resp = await client.get(url, params={"offset": _TG_OFFSET, "timeout": 10})
                if resp.status_code == 200:
                    data = resp.json()
                    for upd in data.get("result", []):
                        _TG_OFFSET = max(_TG_OFFSET, int(upd.get("update_id", 0)) + 1)
                        msg = upd.get("message") or {}
                        msg_chat_id = str(msg.get("chat", {}).get("id", ""))
                        text = (msg.get("text") or "").strip()
                        if not text or (chat_id and msg_chat_id != chat_id):
                            continue

                        reply_to_id = (msg.get("reply_to_message") or {}).get("message_id")
                        matched_ask_id: Optional[str] = None
                        current_asks = get_active_asks()

                        if reply_to_id is not None:
                            for a in current_asks:
                                if a.get("tg_message_id") == reply_to_id:
                                    matched_ask_id = a["id"]
                                    break

                        if matched_ask_id is None and len(current_asks) == 1:
                            matched_ask_id = current_asks[0]["id"]

                        if matched_ask_id:
                            answer_ask(matched_ask_id, text, source="telegram")
        except Exception:
            await asyncio.sleep(3.0)
