"""
Отправка уведомлений (Telegram, ntfy, Webhook) с маршрутизацией через HTTP-прокси 127.0.0.1:10808.
"""

import ipaddress
import socket
import time
import urllib.parse
from typing import Any, Optional

from hub.compat import httpx
from hub.db import get_all_settings, log_audit

# Кольцевой буфер последних отправленных уведомлений для диагностики и проверки в UI
RECENT_NOTIFICATIONS: list[dict[str, Any]] = []
MAX_RECENT_NOTIFICATIONS = 50


def _is_safe_outbound_webhook_url(raw_url: str) -> tuple[bool, str]:
    """
    Проверяет URL исходящего вебхука/ntfy на защиту от SSRF (блокирует loopback, link-local metadata 169.254.169.254, 0.0.0.0).
    """
    url = (raw_url or "").strip()
    if not url:
        return False, "Пустой URL"
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception as exc:
        return False, f"Некорректный URL: {exc}"
    if parsed.scheme not in ("http", "https"):
        return False, "Разрешены только схемы http:// и https://"
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False, "Не указан хост"
    if host in ("localhost", "localhost.localdomain", "metadata.google.internal"):
        return False, f"Хост {host} запрещён политикой SSRF"

    try:
        ip_obj = ipaddress.ip_address(host)
        if ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_unspecified or ip_obj.is_multicast:
            return False, f"IP-адрес {host} запрещён политикой SSRF"
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None)
            for info in infos:
                addr_str = str(info[4][0]).split("%")[0]
                ip_obj = ipaddress.ip_address(addr_str)
                if ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_unspecified or ip_obj.is_multicast:
                    return False, f"DNS-резолв {host} -> {addr_str} запрещён политикой SSRF"
        except socket.gaierror:
            pass
    return True, "OK"


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
    force: bool = False,
) -> dict[str, Any]:
    """
    Отправляет уведомление во все активные каналы (Telegram, ntfy, Webhook)
    с опциональной поддержкой HTTP-прокси из настроек и режима тишины (alerts_muted_until).
    """
    cfg = get_all_settings()
    prefix_map = {
        "info": "ℹ️ [INFO]",
        "warn": "⚠️ [WARN]",
        "error": "❌ [ERROR]",
        "crash": "🚨 [CRASH]",
        "oom": "💥 [OOM KILLED]",
    }
    prefix = prefix_map.get(level, "ℹ️ [BEACON]")
    proj_tag = f" Проект: {project_name}" if project_name else ""
    full_text = f"{prefix}{proj_tag}\n{text}"
    if log_tail:
        tail_trimmed = log_tail.strip()[-800:]
        if tail_trimmed:
            full_text += f"\n\nПоследние строки лога:\n{tail_trimmed}"

    now_ts = int(time.time())
    try:
        muted_until = int(cfg.get("alerts_muted_until", "0") or 0)
    except ValueError:
        muted_until = 0

    if not force and muted_until > now_ts:
        _record_notification_event(
            "muted",
            "Тихий режим (Maintenance)",
            full_text,
            level,
            None,
            False,
            f"Уведомления на паузе до {muted_until}",
        )
        return {"channels": [], "full_text": full_text, "muted": True, "muted_until": muted_until}

    results: dict[str, Any] = {"channels": [], "full_text": full_text, "muted": False}
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
        safe_url, safe_reason = _is_safe_outbound_webhook_url(target)
        if not safe_url:
            _record_notification_event("ntfy", target, full_text, level, ntfy_proxy, False, f"SSRF Guard: {safe_reason}")
            results["channels"].append({"channel": "ntfy", "ok": False, "error": safe_reason})
        else:
            try:
                async with httpx.AsyncClient(proxy=ntfy_proxy, timeout=10.0) as client:
                    resp = await client.post(
                        target,
                        content=full_text.encode("utf-8"),
                        headers={"Title": f"Beacon {project_name or 'Alert'}", "Priority": "high" if level in ("error", "crash", "oom") else "default"},
                    )
                    ok = 200 <= resp.status_code < 300
                    _record_notification_event("ntfy", target, full_text, level, ntfy_proxy, ok, f"HTTP {resp.status_code}")
                    results["channels"].append({"channel": "ntfy", "ok": ok, "proxy": ntfy_proxy})
            except Exception as e:
                _record_notification_event("ntfy", target, full_text, level, ntfy_proxy, False, str(e))
                results["channels"].append({"channel": "ntfy", "ok": False, "error": str(e)})

    # 3. Универсальный Webhook (Discord / Slack / Mattermost / n8n / Custom JSON)
    webhook_url = cfg.get("webhook_url", "").strip()
    if webhook_url:
        wh_proxy = proxy_default if cfg.get("webhook_use_proxy", "0") == "1" else None
        safe_wh, wh_reason = _is_safe_outbound_webhook_url(webhook_url)
        if not safe_wh:
            _record_notification_event("webhook", webhook_url, full_text, level, wh_proxy, False, f"SSRF Guard: {wh_reason}")
            results["channels"].append({"channel": "webhook", "ok": False, "error": wh_reason})
        else:
            lower_wh = webhook_url.lower()
            if "discord.com/api/webhooks/" in lower_wh or "discordapp.com/api/webhooks/" in lower_wh:
                payload: dict[str, Any] = {
                    "username": "Beacon Supervisor",
                    "content": full_text[:1950],
                }
            elif "hooks.slack.com/" in lower_wh:
                payload = {
                    "text": full_text,
                }
            else:
                payload = {
                    "source": "beacon",
                    "level": level,
                    "project": project_name,
                    "text": full_text,
                    "content": full_text,
                    "raw_text": text,
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
