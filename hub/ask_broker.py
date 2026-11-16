"""
Менеджер интерактивных запросов hub.ask() (ожидание ответа из Web UI или Reply в Telegram).
"""

import asyncio
import time
import uuid
from typing import Any, Optional

from hub.compat import httpx
from hub.db import execute_sql, get_all_settings, get_setting, query_all, query_one, set_setting
from hub.log import get_logger
from hub.notifier import send_telegram_message

logger = get_logger("ask_broker")

# В памяти: ask_id -> asyncio.Event
_ASK_EVENTS: dict[str, asyncio.Event] = {}
_TG_OFFSET: int = 0
_TG_BOOTSTRAPPED: bool = False
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


async def poll_ask(
    ask_id: str,
    wait_sec: float = 10.0,
    expected_project_id: Optional[int] = None,
) -> dict[str, Any]:
    """
    Long-poll ожидания ответа до wait_sec секунд.
    Контракт: { "status": "pending|answered|timeout|cancelled", "answer": "..." }
    """
    row = query_one(
        "SELECT id, run_id, project_id, status, answer, expires_at FROM pending_asks WHERE id = ?",
        (ask_id,),
    )
    if not row:
        return {"status": "cancelled", "answer": None}

    if expected_project_id is not None and int(row["project_id"]) != int(expected_project_id):
        raise PermissionError("Доступ к запросу ввода другого проекта запрещён")

    if row["status"] != "pending":
        ans = row["answer"]
        if row["status"] == "answered" and ans is not None:
            execute_sql("UPDATE pending_asks SET answer = NULL WHERE id = ?", (ask_id,))
        return {"status": row["status"], "answer": ans}

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

    ans = updated["answer"]
    if updated["status"] == "answered" and ans is not None:
        execute_sql("UPDATE pending_asks SET answer = NULL WHERE id = ?", (ask_id,))

    return {"status": updated["status"], "answer": ans}


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


async def handle_telegram_command(raw_text: str) -> Optional[str]:
    """
    Обрабатывает системные команды управления сервером из Telegram-бота панели:
    /status, /projects, /start <имя>, /stop <имя>, /doctor, /help
    """
    text = (raw_text or "").strip()
    if not text.startswith("/"):
        return None

    parts = text.split(maxsplit=1)
    cmd = parts[0].split("@")[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""

    if cmd in ("/help", "/start") and not arg:
        return (
            "🤖 Команды системного бота Beacon:\n"
            "• /status — ОЗУ, CPU, батарея смартфона, ZRAM и диск\n"
            "• /projects — список всех программ (service) и скриптов (job)\n"
            "• /start <имя> — запустить проект\n"
            "• /stop <имя> — остановить проект\n"
            "• /doctor — самодиагностика среды (11 проверок)\n"
            "• Reply на запрос — передать код в beacon.ask()"
        )

    if cmd == "/status":
        import os
        from hub.compat import psutil
        from hub.disk_guard import get_disk_status
        from hub.web_auth_mgr import check_proxy_reachable, get_poco_hardware_status

        vm = psutil.virtual_memory()
        cpu_pct = psutil.cpu_percent(interval=None)
        hub_rss = round(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024), 1)
        disk = get_disk_status()
        hw = get_poco_hardware_status()
        cfg = get_all_settings()
        proxy_st = check_proxy_reachable(cfg.get("proxy_url", ""))
        running_cnt = len(
            query_all("SELECT id FROM runs WHERE status IN ('running', 'waiting_input')")
        )
        return (
            f"📊 Статус сервера Beacon:\n"
            f"• Память Beacon: {hub_rss} МБ (лимит 80 МБ)\n"
            f"• CPU: {cpu_pct}% | ОЗУ: {round(vm.used / 1048576)}/{round(vm.total / 1048576)} МБ ({vm.percent}%)\n"
            f"• ZRAM Swap: {hw['swap_used_mb']}/{hw['swap_total_mb']} МБ | Аптайм: {hw['uptime_human']}\n"
            f"• Батарея: {hw['battery_percent']}% ({hw['raw_status']}, {hw['battery_temp_c']}°C, {hw['voltage_mv']} мВ)\n"
            f"• Диск UFS: свободно {disk['free_mb']} МБ (WAL: {disk.get('wal_size_kb', 0)} КБ)\n"
            f"• Прокси: {'Онлайн' if proxy_st['online'] else 'Выкл/Офлайн'} | Активных запусков: {running_cnt}"
        )

    if cmd == "/projects":
        projs = query_all("SELECT id, name, type, desired_state FROM projects ORDER BY id ASC")
        if not projs:
            return "Список проектов пуст."
        lines = ["📦 Проекты в Beacon:"]
        for p in projs:
            last_r = query_one(
                "SELECT status, pid FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1",
                (p["id"],),
            )
            st = last_r["status"] if last_r else "stopped"
            pid_str = f" (PID {last_r['pid']})" if last_r and last_r.get("pid") and st in ("running", "waiting_input") else ""
            icon = "🟢" if st == "running" else ("🟡" if st == "waiting_input" else ("🔴" if st in ("failed", "killed_oom", "crash_loop") else "⚪"))
            lines.append(f"{icon} {p['name']} [{p['type']}] — {st}{pid_str}")
        return "\n".join(lines)

    if cmd == "/start" and arg:
        from hub.process_mgr import start_project_run

        proj = query_one("SELECT id, name FROM projects WHERE name = ?", (arg,))
        if not proj:
            return f"❌ Проект «{arg}» не найден."
        try:
            run = await start_project_run(int(proj["id"]), trigger="manual")
            return f"▶️ Проект «{proj['name']}» запущен (run #{run['id']}, PID {run.get('pid')})."
        except Exception as e:
            return f"❌ Ошибка запуска «{arg}»: {e}"

    if cmd == "/stop":
        if not arg:
            return "Укажите имя проекта: /stop <имя>"
        from hub.process_mgr import stop_project

        proj = query_one("SELECT id, name FROM projects WHERE name = ?", (arg,))
        if not proj:
            return f"❌ Проект «{arg}» не найден."
        await stop_project(int(proj["id"]))
        return f"⏹ Проект «{proj['name']}» остановлен (дерево процессов PGID завершено)."

    if cmd == "/doctor":
        from hub.doctor import run_hub_doctor

        rep = run_hub_doctor(auto_fix_perms=True)
        lines = [
            f"🩺 Beacon Doctor ({rep['duration_ms']} мс): OK={rep['ok_count']} | WARN={rep['warn_count']} | ERROR={rep['error_count']}"
        ]
        for c in rep["checks"]:
            mark = "✅" if c["status"] == "ok" else ("⚠️" if c["status"] == "warn" else "❌")
            lines.append(f"{mark} {c['title']}: {c['summary']}")
        return "\n".join(lines)

    return f"Неизвестная команда «{cmd}». Отправьте /help для списка команд."


def ensure_tg_poller_running() -> None:
    global _POLLER_TASK
    try:
        loop = asyncio.get_running_loop()
        if _POLLER_TASK is None or _POLLER_TASK.done():
            _POLLER_TASK = loop.create_task(_tg_polling_loop())
    except RuntimeError:
        pass


async def _process_tg_updates(updates: list[dict[str, Any]], cfg: dict[str, str]) -> int:
    """
    Обрабатывает список update-объектов Telegram Bot API (P2-05):
    - Отслеживает tg_offset (и сохраняет в settings).
    - Проверяет chat_id и список разрешённых tg_allowed_user_ids (from.id).
    - Принимает ответы на ask строго через Reply на сообщение вопроса и не старше ask.created_at.
    """
    global _TG_OFFSET
    chat_id = str(cfg.get("tg_chat_id") or "").strip()
    allowed_uids = {
        uid.strip()
        for uid in str(cfg.get("tg_allowed_user_ids") or "").split(",")
        if uid.strip()
    }
    prev_offset = _TG_OFFSET

    for upd in updates:
        upd_id = int(upd.get("update_id") or 0)
        if upd_id + 1 > _TG_OFFSET:
            _TG_OFFSET = upd_id + 1

        msg = upd.get("message") or {}
        msg_chat_id = str((msg.get("chat") or {}).get("id") or "")
        text = str(msg.get("text") or "").strip()
        if not text or (chat_id and msg_chat_id != chat_id):
            continue

        sender_id = str((msg.get("from") or {}).get("id") or "").strip()
        if allowed_uids and sender_id not in allowed_uids:
            logger.warning("Игнорировано Telegram-сообщение от неавторизованного user_id=%s", sender_id or "unknown")
            continue

        # 1. Системные команды управления панелью (/status, /projects, /start, /stop, /doctor)
        if text.startswith("/"):
            reply_text = await handle_telegram_command(text)
            if reply_text:
                await send_telegram_message(reply_text, settings=cfg)
            continue

        # 2. Ответ на интерактивный запрос beacon.ask() строго через Reply и не старше создания ask
        reply_to_id = (msg.get("reply_to_message") or {}).get("message_id")
        if reply_to_id is None:
            continue

        msg_date = int(msg.get("date") or 0)
        matched_ask_id: Optional[str] = None
        current_asks = get_active_asks()
        for a in current_asks:
            if a.get("tg_message_id") == reply_to_id:
                if msg_date > 0 and msg_date < int(a.get("created_at") or 0):
                    logger.warning(
                        "Игнорирован устаревший Telegram Reply (msg_date=%s < ask.created_at=%s) для ask=%s",
                        msg_date,
                        a.get("created_at"),
                        a["id"],
                    )
                    break
                matched_ask_id = a["id"]
                break

        if matched_ask_id:
            answer_ask(matched_ask_id, text, source="telegram")
            await send_telegram_message(f"✅ Ответ передан в скрипт (ask_id={matched_ask_id[:8]}).", settings=cfg)

    if _TG_OFFSET > prev_offset:
        set_setting("tg_offset", str(_TG_OFFSET))
    return _TG_OFFSET


async def _tg_polling_loop() -> None:
    global _TG_OFFSET, _TG_BOOTSTRAPPED
    backoff = 2.0

    # Загружаем сохранённый offset из настроек при старте
    try:
        saved_offset = int(get_setting("tg_offset", "0") or 0)
        if saved_offset > _TG_OFFSET:
            _TG_OFFSET = saved_offset
    except (TypeError, ValueError):
        pass

    while True:
        cfg = get_all_settings()
        token = cfg.get("tg_bot_token", "").strip()
        chat_id = cfg.get("tg_chat_id", "").strip()
        active = get_active_asks()

        if not token or not chat_id:
            if not active:
                await asyncio.sleep(5.0)
                continue
            await asyncio.sleep(2.0)
            continue

        use_proxy = cfg.get("tg_use_proxy", "0") == "1"
        raw_proxy = cfg.get("proxy_url", "").strip()
        proxy_url = raw_proxy if (use_proxy and raw_proxy) else None
        url = f"https://api.telegram.org/bot{token}/getUpdates"

        try:
            async with httpx.AsyncClient(proxy=proxy_url, timeout=15.0) as client:
                # Если offset ещё не задан при запуске — пропускаем старые накопившиеся команды (offset=-1)
                if not _TG_BOOTSTRAPPED and _TG_OFFSET == 0:
                    boot_resp = await client.get(url, params={"offset": -1, "limit": 1, "timeout": 0})
                    if boot_resp.status_code == 200:
                        boot_data = boot_resp.json()
                        boot_updates = boot_data.get("result", []) if isinstance(boot_data, dict) else []
                        if boot_updates:
                            _TG_OFFSET = max(_TG_OFFSET, int(boot_updates[-1].get("update_id", 0)) + 1)
                            set_setting("tg_offset", str(_TG_OFFSET))
                        _TG_BOOTSTRAPPED = True
                        backoff = 2.0
                    else:
                        retry_after = 0.0
                        try:
                            err_json = boot_resp.json()
                            if isinstance(err_json, dict):
                                retry_after = float((err_json.get("parameters") or {}).get("retry_after") or 0.0)
                        except Exception:
                            pass
                        sleep_sec = max(backoff, retry_after) if retry_after > 0 else backoff
                        backoff = min(60.0, backoff * 2.0)
                        logger.warning(
                            "Telegram getUpdates bootstrap вернул HTTP %s, повтор через %.1fс",
                            boot_resp.status_code,
                            sleep_sec,
                        )
                        await asyncio.sleep(sleep_sec)
                        continue
                else:
                    _TG_BOOTSTRAPPED = True

                resp = await client.get(url, params={"offset": _TG_OFFSET, "timeout": 10})
                if resp.status_code == 200:
                    backoff = 2.0
                    data = resp.json()
                    updates = data.get("result", []) if isinstance(data, dict) else []
                    if updates:
                        await _process_tg_updates(updates, cfg)
                else:
                    retry_after = 0.0
                    try:
                        err_json = resp.json()
                        if isinstance(err_json, dict):
                            retry_after = float((err_json.get("parameters") or {}).get("retry_after") or 0.0)
                    except Exception:
                        pass
                    sleep_sec = max(backoff, retry_after) if retry_after > 0 else backoff
                    backoff = min(60.0, backoff * 2.0)
                    logger.warning(
                        "Telegram getUpdates вернул HTTP %s, повтор через %.1fс",
                        resp.status_code,
                        sleep_sec,
                    )
                    await asyncio.sleep(sleep_sec)
        except Exception:
            logger.exception("Ошибка в цикле _tg_polling_loop (повтор через %.1fс)", backoff)
            await asyncio.sleep(backoff)
            backoff = min(60.0, backoff * 2.0)


