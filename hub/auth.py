"""
Безопасность и контроль доступа:
- Фильтр подсетей (CIDR из настройки allowed_subnets + опция Tailscale 100.64.0.0/10)
- Ограничение входа при дефолтном пароле 'admin' строго loopback и RFC1918 (10/8, 172.16/12, 192.168/16)
- Безопасный разбор X-Forwarded-For (только от trusted_proxies, выбор ПРАВОГО недоверенного IP)
- Аутентификация по паролю (hashlib.scrypt, n=16384, r=8, p=1) и RBAC-роли (viewer, operator, admin)
- Сессии в HttpOnly cookie (SameSite=Strict) + одноразовые короткоживущие тикеты для SSE (/api/auth/stream_ticket)
- Токены доступа ИИ (SHA-256 хеш, scopes, IP-фильтр, rate limit, kill-switch)
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

from hub.config import INTERNAL_TOKEN_PATH, ensure_directories, get_env_var
from hub.db import execute_sql, get_setting, log_audit, query_one, set_setting

_SESSION_SECRET: Optional[bytes] = None
_INTERNAL_TOKEN: Optional[str] = None
_REVOKED_SESSIONS: dict[str, int] = {}

_FAILED_LOGINS: dict[str, list[float]] = {}
_BLOCKED_IPS: dict[str, float] = {}

_WEBHOOK_HITS: dict[str, list[float]] = {}
_WEBHOOK_FAILS: dict[str, list[float]] = {}
_WEBHOOK_BLOCKED_IPS: dict[str, float] = {}

# Одноразовые короткоживущие тикеты для SSE-стримов: ticket -> {"exp": float, "run_id": Optional[int]}
_STREAM_TICKETS: dict[str, dict[str, Any]] = {}

# Rate-limit для ИИ-токенов: token_id -> list[float]
_AI_TOKEN_HITS: dict[int, list[float]] = {}

RATE_LIMIT_WINDOW_SEC = 300
RATE_LIMIT_MAX_FAILS = 5
RATE_LIMIT_BLOCK_SEC = 900

WEBHOOK_WINDOW_SEC = 60
WEBHOOK_MAX_HITS = 30
WEBHOOK_MAX_FAILS = 10
WEBHOOK_BLOCK_SEC = 600

_PRIVATE_AND_LOOPBACK_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def get_internal_token() -> str:
    """
    Возвращает криптостойкий токен для локального шлюза /internal/*.
    Хранится в data/internal.token (права 0600).
    """
    global _INTERNAL_TOKEN
    if _INTERNAL_TOKEN:
        return _INTERNAL_TOKEN

    ensure_directories()
    env_tok = get_env_var("ARUTA_INTERNAL_TOKEN", "HUB_INTERNAL_TOKEN", "")
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
    """Проверяет заголовок X-Aruta-Internal-Token / X-Hub-Internal-Token за константное время."""
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


def is_default_password() -> bool:
    """Возвращает True, если текущий пароль администратора равен дефолтному 'admin'."""
    stored_hash = get_setting("password_hash", "")
    if not stored_hash:
        return True
    return verify_password("admin", stored_hash)


def _normalize_ip(raw_ip: str) -> str:
    clean = (raw_ip or "").strip()
    if clean.startswith("::ffff:"):
        clean = clean[7:]
    if clean == "localhost":
        return "127.0.0.1"
    return clean


def is_private_or_loopback_ip(ip_str: str) -> bool:
    """
    Проверяет, принадлежит ли IP к loopback (127.0.0.0/8, ::1) или частным подсетям RFC1918
    (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16). CGNAT (100.64.0.0/10) сюда НЕ входит!
    """
    clean = _normalize_ip(ip_str)
    if not clean:
        return False
    try:
        ip_obj = ipaddress.ip_address(clean)
    except ValueError:
        return False
    return any(ip_obj in net for net in _PRIVATE_AND_LOOPBACK_NETS)


def _ip_in_cidr_csv(ip_str: str, cidr_csv: str) -> bool:
    clean = _normalize_ip(ip_str)
    if not clean or not cidr_csv or not cidr_csv.strip():
        return False
    try:
        ip_obj = ipaddress.ip_address(clean)
    except ValueError:
        return False
    for item in cidr_csv.split(","):
        item = item.strip()
        if not item:
            continue
        if item == "*":
            return True
        try:
            net = ipaddress.ip_network(item, strict=False)
            if ip_obj in net:
                return True
        except ValueError:
            continue
    return False


def resolve_client_ip(direct_ip: str, x_forwarded_for: str = "", trusted_proxies_override: Optional[str] = None) -> str:
    """
    Безопасное определение IP клиента с защитой от спуфинга X-Forwarded-For:
    1. X-Forwarded-For учитывается ТОЛЬКО если непосредственный адрес соединения (direct_ip)
       входит в список доверенных прокси (trusted_proxies). По умолчанию trusted_proxies пуст.
    2. Из цепочки X-Forwarded-For выбирается ПРАВЫЙ (последний не доверенный) элемент, а не левый.
    """
    peer_ip = _normalize_ip(direct_ip or "127.0.0.1")
    trusted_csv = (
        trusted_proxies_override
        if trusted_proxies_override is not None
        else get_setting("trusted_proxies", "")
    ).strip()

    if not trusted_csv or not x_forwarded_for or not _ip_in_cidr_csv(peer_ip, trusted_csv):
        return peer_ip

    hops = [_normalize_ip(part) for part in x_forwarded_for.split(",") if part.strip()]
    if not hops:
        return peer_ip

    # Идём справа налево и берём первый IP, который не является доверенным прокси (и валиден)
    for candidate in reversed(hops):
        try:
            ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if not _ip_in_cidr_csv(candidate, trusted_csv):
            return candidate

    # Если все элементы в XFF входят в trusted_proxies — возвращаем самый левый валидный из них
    for candidate in hops:
        try:
            ipaddress.ip_address(candidate)
            return candidate
        except ValueError:
            continue
    return peer_ip


def is_ip_allowed(client_ip: str) -> bool:
    """
    Проверяет client_ip по списку CIDR из настройки allowed_subnets.
    Если используется пароль по умолчанию 'admin', вход и доступ разрешены ТОЛЬКО
    с loopback и частных диапазонов RFC1918 (10/8, 172.16/12, 192.168/16).
    """
    if not client_ip:
        return True
    clean_ip = _normalize_ip(client_ip)
    if clean_ip in ("127.0.0.1", "::1"):
        return True

    # Пока пароль по умолчанию 'admin', жёстко разрешаем только loopback и RFC1918
    if is_default_password():
        if not is_private_or_loopback_ip(clean_ip):
            return False

    subnets_str = get_setting(
        "allowed_subnets",
        "127.0.0.0/8,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,::1/128",
    )
    if get_setting("allow_tailscale", "0") == "1" and not is_default_password():
        subnets_str = f"{subnets_str},100.64.0.0/10"

    if ("*" in subnets_str or "0.0.0.0/0" in subnets_str) and not is_default_password():
        return True

    return _ip_in_cidr_csv(clean_ip, subnets_str)


def create_session_tokens(
    ttl_sec: int = 86400 * 7,
    role: str = "admin",
    username: str = "admin",
) -> tuple[str, str]:
    """Создаёт подписанный токен сессии и привязанный csrf_token."""
    csrf_token = secrets.token_hex(24)
    sid = secrets.token_hex(12)
    now = int(time.time())
    payload = {
        "sid": sid,
        "iat": now,
        "exp": now + ttl_sec,
        "csrf": csrf_token,
        "role": role,
        "user": username,
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
        if "role" not in payload:
            payload["role"] = "admin"
        return payload
    except Exception:
        return None


def create_stream_ticket(run_id: Optional[int] = None, ttl_sec: int = 30) -> str:
    """Создаёт короткоживущий одноразовый тикет для подключения к SSE-потоку логов."""
    now = time.time()
    # Очистка протухших тикетов
    for k, v in list(_STREAM_TICKETS.items()):
        if v["exp"] < now:
            _STREAM_TICKETS.pop(k, None)
    ticket = secrets.token_urlsafe(24)
    _STREAM_TICKETS[ticket] = {"exp": now + ttl_sec, "run_id": run_id}
    return ticket


def consume_stream_ticket(ticket: str, run_id: Optional[int] = None) -> bool:
    """Одноразово погашает SSE-тикет и возвращает True, если он действителен."""
    if not ticket:
        return False
    entry = _STREAM_TICKETS.pop(ticket, None)
    if not entry:
        return False
    if entry["exp"] < time.time():
        return False
    if entry.get("run_id") is not None and run_id is not None and int(entry["run_id"]) != int(run_id):
        return False
    return True


def hash_ai_token(raw_token: str) -> str:
    """Вычисляет SHA-256 хеш токена ИИ (сам токен в БД никогда не хранится)."""
    return hashlib.sha256(raw_token.strip().encode("utf-8")).hexdigest()


def verify_ai_token(raw_token: str, client_ip: str = "127.0.0.1") -> tuple[Optional[dict[str, Any]], str]:
    """
    Проверяет Bearer-токен ИИ-доступа:
    - Проверяет, что пароль панели НЕ равен дефолтному 'admin'.
    - Проверяет, что ИИ-доступ включён (ai_access_enabled == '1') и не поставлен на паузу (ai_access_paused == '0').
    - Проверяет SHA-256 хеш в таблице ai_tokens, срок действия, статус отзыва, фильтр IP и rate-limit.
    """
    if is_default_password():
        return None, "Доступ ИИ заблокирован, пока используется пароль по умолчанию 'admin'"
    if get_setting("ai_access_enabled", "0") != "1":
        return None, "Доступ для ИИ выключен в настройках панели"
    if get_setting("ai_access_paused", "0") == "1":
        return None, "Доступ для ИИ временно приостановлен переключателем «Пауза ИИ»"

    if not raw_token or len(raw_token.strip()) < 16:
        return None, "Недействительный токен авторизации"

    thash = hash_ai_token(raw_token)
    row = query_one("SELECT * FROM ai_tokens WHERE token_hash = ?", (thash,))
    if not row:
        return None, "Токен ИИ не найден"
    if int(row.get("revoked") or 0) == 1:
        return None, "Токен ИИ отозван"

    now = int(time.time())
    exp = int(row.get("expires_at") or 0)
    if exp > 0 and exp < now:
        return None, "Срок действия токена ИИ истёк"

    allowed_ips = str(row.get("allowed_ips") or "").strip()
    if allowed_ips and not _ip_in_cidr_csv(client_ip, allowed_ips):
        return None, f"IP {client_ip} не разрешён для данного токена ИИ"

    # Rate limit
    token_id = int(row["id"])
    limit_per_min = max(1, int(row.get("rate_limit_per_min") or 60))
    now_f = time.time()
    hits = [t for t in _AI_TOKEN_HITS.get(token_id, []) if now_f - t <= 60.0]
    if len(hits) >= limit_per_min:
        return None, f"Превышен лимит запросов для токена ({limit_per_min}/мин)"
    hits.append(now_f)
    _AI_TOKEN_HITS[token_id] = hits

    execute_sql("UPDATE ai_tokens SET last_used_at = ? WHERE id = ?", (now, token_id))
    try:
        scopes = json.loads(row.get("scopes_json") or '["read"]')
    except Exception:
        scopes = ["read"]
    row["scopes"] = scopes if isinstance(scopes, list) else ["read"]
    return row, ""


def check_rate_limit(client_ip: str) -> tuple[bool, int]:
    now = time.time()
    unblock_at = _BLOCKED_IPS.get(client_ip, 0.0)
    if unblock_at > now:
        return False, max(1, int(unblock_at - now))
    elif client_ip in _BLOCKED_IPS:
        del _BLOCKED_IPS[client_ip]
    return True, 0


def record_login_failure(client_ip: str) -> tuple[bool, int]:
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
