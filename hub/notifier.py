"""
Отправка уведомлений (Telegram, ntfy, Webhook) с маршрутизацией через HTTP-прокси 127.0.0.1:10808.
"""

import time
from typing import Any, Optional

from hub.compat import httpx
from hub.db import get_all_settings, log_audit

# Кольцевой буфер последних отправленных уведомлений для диагностики и проверки в UI
RECENT_NOTIFICATIONS: list[dict[str, Any]] = []
MAX_RECENT_NOTIFICATIONS = 50


def _record_notification_event(
    channel: str,
    title: str,
    text: str,
    level: str,
    proxy_used: Optional[str],
    delivered: bool,
    detail: str = "",
) -> dict[str, Any]:
    event = {
        "timestamp": int(time.time()),
        "channel": channel,
        "title": title,
        "text": text,
        "level": level,
        "proxy_used": proxy_used or "",
        "delivered": delivered,
        "detail": detail,
    }
    RECENT_NOTIFICATIONS.insert(0, event)
    if len(RECENT_NOTIFICATIONS) > MAX_RECENT_NOTIFICATIONS:
        del RECENT_NOTIFICATIONS[MAX_RECENT_NOTIFICATIONS:]
    return event


async def send_telegram_message(
    text: str,
    reply_markup: Optional[dict[str, Any]] = None,
    settings: Optional[dict[str, str]] = None,
) -> Optional[int]:
    """
    Отправляет сообщение в Telegram (через прокси 127.0.0.1:10808, если tg_use_proxy == '1').
    Возвращает message_id при успехе.
    """
    cfg = settings or get_all_settings()
    token = cfg.get("tg_bot_token", "").strip()
    chat_id = cfg.get("tg_chat_id", "").strip()
    use_proxy = cfg.get("tg_use_proxy", "0") == "1"
    raw_proxy = cfg.get("proxy_url", "").strip()
    proxy_url = raw_proxy if (use_proxy and raw_proxy) else None

    if not token or not chat_id:
        _record_notification_event(
            "telegram",
            "Telegram",
            text,
            "info",
            proxy_url,
            False,
            "tg_bot_token / tg_chat_id не заданы (сохранено в локальном журнале уведомлений)",
        )
        return None

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup

    try:
        async with httpx.AsyncClient(proxy=proxy_url, timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            data = resp.json() if resp.status_code == 200 else {}
            ok = bool(resp.status_code == 200 and data.get("ok"))
            msg_id = data.get("result", {}).get("message_id") if ok else None
            _record_notification_event(
                "telegram",
                "Telegram",
                text,
                "info",
                proxy_url,
                ok,
                f"HTTP {resp.status_code}",
            )
            return int(msg_id) if msg_id is not None else None
    except Exception as e:
        _record_notification_event(
            "telegram",
            "Telegram",
            text,
            "error",
            proxy_url,
            False,
            f"Ошибка прокси/сети ({proxy_url or 'direct'}): {e}",
        )
        return None


async def send_notification(
    text: str,
    level: str = "info",
    project_name: Optional[str] = None,
    log_tail: Optional[str] = None,
) -> dict[str, Any]:
    """
    Отправляет уведомление во все активные каналы (Telegram, ntfy, Webhook)
    с опциональной поддержкой HTTP-прокси из настроек.
    """
    cfg = get_all_settings()
    prefix_map = {
        "info": "ℹ️ [INFO]",
        "warn": "⚠️ [WARN]",
        "error": "❌ [ERROR]",
        "crash": "🚨 [CRASH]",
        "oom": "💥 [OOM KILLED]",
    }
    prefix = prefix_map.get(level, "ℹ️ [ARUTA]")
    proj_tag = f" Проект: {project_name}" if project_name else ""
    full_text = f"{prefix}{proj_tag}\n{text}"
    if log_tail:
        tail_trimmed = log_tail.strip()[-800:]
        if tail_trimmed:
            full_text += f"\n\nПоследние строки лога:\n{tail_trimmed}"

    results: dict[str, Any] = {"channels": [], "full_text": full_text}
    proxy_default = cfg.get("proxy_url", "").strip()

    # 1. Telegram
    tg_proxy = proxy_default if (cfg.get("tg_use_proxy", "0") == "1" and proxy_default) else None
    msg_id = await send_telegram_message(full_text, settings=cfg)
    results["channels"].append(
        {"channel": "telegram", "proxy": tg_proxy, "message_id": msg_id, "configured": bool(cfg.get("tg_bot_token"))}
    )

    # 2. ntfy
    ntfy_url = cfg.get("ntfy_url", "").strip().rstrip("/")
    ntfy_topic = cfg.get("ntfy_topic", "").strip().lstrip("/")
    if ntfy_url and ntfy_topic:
        ntfy_proxy = proxy_default if cfg.get("ntfy_use_proxy", "0") == "1" else None
        target = f"{ntfy_url}/{ntfy_topic}"
        try:
            async with httpx.AsyncClient(proxy=ntfy_proxy, timeout=10.0) as client:
                resp = await client.post(
                    target,
                    content=full_text.encode("utf-8"),
                    headers={"Title": f"Hub {project_name or 'Alert'}", "Priority": "high" if level in ("error", "crash", "oom") else "default"},
                )
                ok = 200 <= resp.status_code < 300
                _record_notification_event("ntfy", target, full_text, level, ntfy_proxy, ok, f"HTTP {resp.status_code}")
                results["channels"].append({"channel": "ntfy", "ok": ok, "proxy": ntfy_proxy})
        except Exception as e:
            _record_notification_event("ntfy", target, full_text, level, ntfy_proxy, False, str(e))
            results["channels"].append({"channel": "ntfy", "ok": False, "error": str(e)})

    # 3. Произвольный Webhook
    webhook_url = cfg.get("webhook_url", "").strip()
    if webhook_url:
        wh_proxy = proxy_default if cfg.get("webhook_use_proxy", "0") == "1" else None
        payload = {
            "source": "hub",
            "level": level,
            "project": project_name,
            "text": text,
            "log_tail": log_tail or "",
            "timestamp": int(time.time()),
        }
        try:
            async with httpx.AsyncClient(proxy=wh_proxy, timeout=10.0) as client:
                resp = await client.post(webhook_url, json=payload)
                ok = 200 <= resp.status_code < 300
                _record_notification_event("webhook", webhook_url, full_text, level, wh_proxy, ok, f"HTTP {resp.status_code}")
                results["channels"].append({"channel": "webhook", "ok": ok, "proxy": wh_proxy})
        except Exception as e:
            _record_notification_event("webhook", webhook_url, full_text, level, wh_proxy, False, str(e))
            results["channels"].append({"channel": "webhook", "ok": False, "error": str(e)})

    log_audit("127.0.0.1", f"NOTIFY_{level.upper()}", f"{project_name or 'System'}: {text[:180]}")
    return results
