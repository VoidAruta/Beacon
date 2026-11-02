"""
Безопасность и контроль доступа:
- Фильтр подсетей (CIDR из настройки allowed_subnets)
- Аутентификация по паролю (hashlib.scrypt, n=16384, r=8, p=1)
- Сессии в HttpOnly cookie (HMAC-SHA256) + CSRF токен (X-CSRF-Token)
- Защита от перебора (Rate Limit: >5 неудачных попыток за 10 мин -> блок на 15 мин + audit_log + TG)
"""

import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import time
import urllib.parse
from typing import Any, Optional

from hub.db import get_setting, log_audit, set_setting

# Секретный ключ подписи сессий (генерируется или берётся из настроек)
_SESSION_SECRET: Optional[bytes] = None

# В памяти: ip -> список таймстампов неудачных попыток
_FAILED_LOGINS: dict[str, list[float]] = {}
# В памяти: ip -> время окончания блокировки (unix timestamp)
_BLOCKED_IPS: dict[str, float] = {}

RATE_LIMIT_WINDOW_SEC = 600   # 10 минут
RATE_LIMIT_MAX_FAILS = 5      # 5 неудачных попыток
RATE_LIMIT_BLOCK_SEC = 900    # 15 минут блокировки


def _get_session_secret() -> bytes:
    global _SESSION_SECRET
    if _SESSION_SECRET is not None:
        return _SESSION_SECRET
    saved = get_setting("session_secret", "")
    if not saved:
        saved = secrets.token_hex(32)
        set_setting("session_secret", saved)
    _SESSION_SECRET = saved.encode("utf-8")
    return _SESSION_SECRET


def hash_password(password: str) -> str:
    """Хеширует пароль через hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)."""
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    return f"scrypt${salt.hex()}${derived.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Проверяет пароль против сохранённого scrypt-хеша."""
    if not stored_hash or not stored_hash.startswith("scrypt$"):
        return False
    try:
        parts = stored_hash.split("$")
        if len(parts) != 3:
            return False
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
        derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
        return hmac.compare_digest(derived, expected)
    except Exception:
        return False


def create_session_tokens(ttl_sec: int = 86400 * 7) -> tuple[str, str]:
    """Создаёт подписанный токен сессии (hub_session) и привязанный csrf_token."""
    csrf_token = secrets.token_hex(24)
    now = int(time.time())
    payload = {
        "iat": now,
        "exp": now + ttl_sec,
        "csrf": csrf_token,
    }
    payload_b64 = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    sig = hmac.new(_get_session_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}", csrf_token


def verify_session_token(token: str) -> Optional[dict[str, Any]]:
    """Проверяет подпись и срок действия токена сессии."""
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig = token.rsplit(".", 1)
        expected_sig = hmac.new(
            _get_session_secret(), payload_b64.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        payload = json.loads(urllib.parse.unquote(payload_b64))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


def is_ip_allowed(client_ip: str) -> bool:
    """
    Проверяет client_ip по списку CIDR из настройки allowed_subnets.
    Локальные адреса (127.0.0.1, ::1, ::ffff:127.0.0.1) всегда разрешены.
    """
    if not client_ip:
        return True
    clean_ip = client_ip.strip()
    if clean_ip.startswith("::ffff:"):
        clean_ip = clean_ip[7:]
    if clean_ip in ("127.0.0.1", "::1", "localhost"):
        return True

    subnets_str = get_setting(
        "allowed_subnets",
        "127.0.0.0/8,192.168.100.0/24,192.168.1.0/24,10.0.0.0/8,172.16.0.0/12",
    )
    if "*" in subnets_str or "0.0.0.0/0" in subnets_str:
        return True

    try:
        ip_obj = ipaddress.ip_address(clean_ip)
    except ValueError:
        return False

    for cidr in subnets_str.split(","):
        cidr = cidr.strip()
        if not cidr:
            continue
        try:
            net = ipaddress.ip_network(cidr, strict=False)
            if ip_obj in net:
                return True
        except ValueError:
            continue
    return False


def check_rate_limit(client_ip: str) -> tuple[bool, int]:
    """
    Возвращает (allowed, retry_after_sec).
    Если IP заблокирован после >5 неудачных попыток за 10 минут — возвращает (False, remaining_sec).
    """
    now = time.time()
    unblock_at = _BLOCKED_IPS.get(client_ip, 0.0)
    if unblock_at > now:
        return False, int(unblock_at - now)
    elif client_ip in _BLOCKED_IPS:
        del _BLOCKED_IPS[client_ip]
    return True, 0


def record_login_failure(client_ip: str) -> tuple[bool, int]:
    """
    Регистрирует неудачную попытку входа.
    При превышении 5 попыток за 10 минут блокирует IP на 15 минут, пишет в audit_log.
    Возвращает (is_now_blocked, block_seconds).
    """
    now = time.time()
    attempts = [t for t in _FAILED_LOGINS.get(client_ip, []) if now - t <= RATE_LIMIT_WINDOW_SEC]
    attempts.append(now)
    _FAILED_LOGINS[client_ip] = attempts

    if len(attempts) > RATE_LIMIT_MAX_FAILS:
        _BLOCKED_IPS[client_ip] = now + RATE_LIMIT_BLOCK_SEC
        _FAILED_LOGINS[client_ip] = []
        log_audit(
            client_ip,
            "RATE_LIMIT_BLOCK",
            f"IP заблокирован на 15 минут после {len(attempts)} неудачных попыток входа",
        )
        return True, RATE_LIMIT_BLOCK_SEC

    log_audit(client_ip, "LOGIN_FAILED", f"Неверный пароль (попытка {len(attempts)}/{RATE_LIMIT_MAX_FAILS})")
    return False, 0


def clear_login_failures(client_ip: str) -> None:
    _FAILED_LOGINS.pop(client_ip, None)
    _BLOCKED_IPS.pop(client_ip, None)
