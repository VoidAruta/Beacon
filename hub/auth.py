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

from hub.config import INTERNAL_TOKEN_PATH, ensure_directories
from hub.db import execute_sql, get_setting, log_audit, query_one, set_setting

# Секретный ключ подписи сессий (генерируется или берётся из настроек)
_SESSION_SECRET: Optional[bytes] = None
# Внутренний токен авторизации локального шлюза /internal/* (хранится в data/internal.token с правами 0600)
_INTERNAL_TOKEN: Optional[str] = None
# Отозванные сессии в памяти: sid -> exp
_REVOKED_SESSIONS: dict[str, int] = {}

# В памяти: ip -> список таймстампов неудачных попыток входа
_FAILED_LOGINS: dict[str, list[float]] = {}
# В памяти: ip -> время окончания блокировки входа (unix timestamp)
_BLOCKED_IPS: dict[str, float] = {}

# В памяти: защита вебхуков от перебора и флуда
_WEBHOOK_HITS: dict[str, list[float]] = {}
_WEBHOOK_FAILS: dict[str, list[float]] = {}
_WEBHOOK_BLOCKED_IPS: dict[str, float] = {}

RATE_LIMIT_WINDOW_SEC = 300   # 5 минут окно наблюдения
RATE_LIMIT_MAX_FAILS = 5      # 5 неудачных попыток входа
RATE_LIMIT_BLOCK_SEC = 900    # 15 минут блокировки

WEBHOOK_WINDOW_SEC = 60       # 1 минута окно для частоты запросов вебхука
WEBHOOK_MAX_HITS = 30         # макс 30 вызовов в минуту с одного IP
WEBHOOK_MAX_FAILS = 10        # макс 10 ошибок 404 по токену вебхука
WEBHOOK_BLOCK_SEC = 600       # 10 минут блокировки при брутфорсе вебхуков


def get_internal_token() -> str:
    """
    Возвращает криптостойкий токен для локального шлюза /internal/*.
    Хранится в data/internal.token (права 0600), чтобы выжившие дочерние сервисы
    сохраняли доступ к SDK после перезапуска самого процесса Hub.
    """
    global _INTERNAL_TOKEN
    if _INTERNAL_TOKEN:
        return _INTERNAL_TOKEN

    ensure_directories()
    env_tok = os.environ.get("HUB_INTERNAL_TOKEN", "").strip()
    if env_tok and len(env_tok) >= 16:
        _INTERNAL_TOKEN = env_tok
        return _INTERNAL_TOKEN

    if INTERNAL_TOKEN_PATH.exists():
        try:
            existing = INTERNAL_TOKEN_PATH.read_text(encoding="utf-8").strip()
            if len(existing) >= 32:
                os.chmod(INTERNAL_TOKEN_PATH, 0o600)
                _INTERNAL_TOKEN = existing
                return _INTERNAL_TOKEN
        except OSError:
            pass

    new_tok = secrets.token_hex(32)
    try:
        INTERNAL_TOKEN_PATH.write_text(new_tok, encoding="utf-8")
        os.chmod(INTERNAL_TOKEN_PATH, 0o600)
    except OSError:
        pass
    _INTERNAL_TOKEN = new_tok
    return _INTERNAL_TOKEN


def verify_internal_token(candidate: str) -> bool:
    """Проверяет заголовок X-Hub-Internal-Token за константное время."""
    if not candidate:
        return False
    expected = get_internal_token()
    return hmac.compare_digest(candidate.strip(), expected)


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
    sid = secrets.token_hex(12)
    now = int(time.time())
    payload = {
        "sid": sid,
        "iat": now,
        "exp": now + ttl_sec,
        "csrf": csrf_token,
    }
    payload_b64 = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    sig = hmac.new(_get_session_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}", csrf_token


def revoke_session_token(token: str) -> None:
    """Серверная инвалидация токена сессии при выходе (POST /api/auth/logout)."""
    if not token or "." not in token:
        return
    try:
        payload_b64, _ = token.rsplit(".", 1)
        payload = json.loads(urllib.parse.unquote(payload_b64))
        sid = str(payload.get("sid") or token)
        exp = int(payload.get("exp") or (int(time.time()) + 86400 * 7))
        _REVOKED_SESSIONS[sid] = exp
        execute_sql(
            "INSERT INTO revoked_sessions (sid, exp) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET exp = excluded.exp",
            (sid, exp),
        )
        execute_sql("DELETE FROM revoked_sessions WHERE exp < ?", (int(time.time()),))
    except Exception:
        pass


def verify_session_token(token: str) -> Optional[dict[str, Any]]:
    """Проверяет подпись, срок действия и отсутствие в списке отозванных сессий."""
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
        now = int(time.time())
        if int(payload.get("exp", 0)) < now:
            return None
        sid = str(payload.get("sid") or token)
        if sid in _REVOKED_SESSIONS:
            return None
        try:
            row = query_one("SELECT sid FROM revoked_sessions WHERE sid = ? AND exp >= ?", (sid, now))
            if row:
                _REVOKED_SESSIONS[sid] = int(payload.get("exp", now + 3600))
                return None
        except Exception:
            pass
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
        "127.0.0.0/8,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,100.64.0.0/10",
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
    Если IP заблокирован после 5 неудачных попыток за 5 минут — возвращает (False, remaining_sec).
    """
    now = time.time()
    unblock_at = _BLOCKED_IPS.get(client_ip, 0.0)
    if unblock_at > now:
        return False, max(1, int(unblock_at - now))
    elif client_ip in _BLOCKED_IPS:
        del _BLOCKED_IPS[client_ip]
    return True, 0


def record_login_failure(client_ip: str) -> tuple[bool, int]:
    """
    Регистрирует неудачную попытку входа.
    При достижении 5 попыток за 5 минут блокирует IP на 15 минут, пишет в audit_log.
    Возвращает (is_now_blocked, block_seconds).
    """
    now = time.time()
    attempts = [t for t in _FAILED_LOGINS.get(client_ip, []) if now - t <= RATE_LIMIT_WINDOW_SEC]
    attempts.append(now)
    _FAILED_LOGINS[client_ip] = attempts

    if len(attempts) >= RATE_LIMIT_MAX_FAILS:
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


def check_webhook_rate_limit(client_ip: str) -> tuple[bool, int]:
    """Проверяет лимит частоты вызовов /api/webhook/{token} с одного IP."""
    now = time.time()
    unblock_at = _WEBHOOK_BLOCKED_IPS.get(client_ip, 0.0)
    if unblock_at > now:
        return False, max(1, int(unblock_at - now))
    elif client_ip in _WEBHOOK_BLOCKED_IPS:
        del _WEBHOOK_BLOCKED_IPS[client_ip]

    hits = [t for t in _WEBHOOK_HITS.get(client_ip, []) if now - t <= WEBHOOK_WINDOW_SEC]
    if len(hits) >= WEBHOOK_MAX_HITS:
        return False, WEBHOOK_WINDOW_SEC
    hits.append(now)
    _WEBHOOK_HITS[client_ip] = hits
    return True, 0


def record_webhook_failure(client_ip: str) -> tuple[bool, int]:
    """Регистрирует ошибку неверного webhook_token и блокирует IP при переборе."""
    now = time.time()
    fails = [t for t in _WEBHOOK_FAILS.get(client_ip, []) if now - t <= RATE_LIMIT_WINDOW_SEC]
    fails.append(now)
    _WEBHOOK_FAILS[client_ip] = fails
    if len(fails) >= WEBHOOK_MAX_FAILS:
        _WEBHOOK_BLOCKED_IPS[client_ip] = now + WEBHOOK_BLOCK_SEC
        _WEBHOOK_FAILS[client_ip] = []
        log_audit(client_ip, "WEBHOOK_BRUTEFORCE_BLOCK", f"IP заблокирован на 10 минут после {len(fails)} ошибок вебхука")
        return True, WEBHOOK_BLOCK_SEC
    return False, 0

