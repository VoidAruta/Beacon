"""
Безопасность и контроль доступа:
- Фильтр подсетей (CIDR из настройки allowed_subnets + опция Tailscale 100.64.0.0/10)
- Ограничение входа при дефолтном пароле 'admin' строго loopback и RFC1918 (10/8, 172.16/12, 192.168/16)
- Безопасный разбор X-Forwarded-For (только от trusted_proxies, выбор ПРАВОГО недоверенного IP)
- Аутентификация по паролю (hashlib.scrypt, n=16384, r=8, p=1) и RBAC-роли (viewer, operator, admin)
- Сессии в HttpOnly cookie (SameSite=Lax) + одноразовые короткоживущие тикеты для SSE (/api/auth/stream_ticket)
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

from hub.config import INTERNAL_TOKEN_PATH, SESSION_SECRET_PATH, ensure_directories, get_env_var
from hub.db import execute_sql, get_setting, log_audit, query_one, set_setting

_SESSION_SECRET: Optional[bytes] = None
_INTERNAL_TOKEN: Optional[str] = None
_REVOKED_SESSIONS: dict[str, int] = {}

_FAILED_LOGINS: dict[str, list[float]] = {}
_BLOCKED_IPS: dict[str, float] = {}

# Кэш проверки существования пользователя (TTL 30 сек, P1-2)
_USER_EXISTS_CACHE: dict[str, tuple[float, str, bool]] = {}
_USER_CACHE_TTL_SEC = 30.0

# Кэш проверки дефолтного пароля (P1-3): stored_hash -> bool
_DEFAULT_PW_CACHE: dict[str, bool] = {}

# Кэш скомпилированных CIDR-сетей (P1-3): cidr_csv -> (allow_all, [ip_network, ...])
_PARSED_NETS_CACHE: dict[str, tuple[bool, list[Any]]] = {}

# Rate-limit неудачных попыток AI-аутентификации по IP (P1-3 / P2-04)
_AI_AUTH_FAILS: dict[str, list[float]] = {}
_AI_AUTH_BLOCKED_IPS: dict[str, float] = {}
AI_AUTH_WINDOW_SEC = 300
AI_AUTH_MAX_FAILS = 10
AI_AUTH_BLOCK_SEC = 900

_DUMMY_SCRYPT_HASH = "scrypt$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

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
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def get_internal_token() -> str:
    """
    Возвращает криптостойкий токен для локального шлюза /internal/*.
    Хранится в data/internal.token (создаётся атомарно с правами 0600).
    """
    global _INTERNAL_TOKEN
    if _INTERNAL_TOKEN:
        return _INTERNAL_TOKEN

    ensure_directories()
    env_tok = get_env_var("BEACON_INTERNAL_TOKEN", "")
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
    tmp_path = INTERNAL_TOKEN_PATH.with_name(f".{INTERNAL_TOKEN_PATH.name}.{secrets.token_hex(6)}.tmp")
    try:
        fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, new_tok.encode("utf-8"))
        finally:
            os.close(fd)
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, INTERNAL_TOKEN_PATH)
    except OSError:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
    _INTERNAL_TOKEN = new_tok
    return _INTERNAL_TOKEN


def verify_internal_token(candidate: str) -> bool:
    """Проверяет заголовок X-Beacon-Internal-Token / X-Hub-Internal-Token за константное время."""
    if not candidate:
        return False
    expected = get_internal_token()
    return hmac.compare_digest(candidate.strip(), expected)


def _get_session_secret() -> bytes:
    """Читает или создаёт секрет подписи сессий в data/session.secret (0600), никогда не в SQLite (P0-1)."""
    global _SESSION_SECRET
    if _SESSION_SECRET is not None:
        return _SESSION_SECRET

    ensure_directories()
    if SESSION_SECRET_PATH.exists():
        try:
            existing = SESSION_SECRET_PATH.read_text(encoding="utf-8").strip()
            if len(existing) >= 32:
                os.chmod(SESSION_SECRET_PATH, 0o600)
                _SESSION_SECRET = existing.encode("utf-8")
                return _SESSION_SECRET
        except OSError:
            pass

    # Проверяем, нет ли legacy-значения в БД (на случай вызова до миграции)
    legacy = get_setting("session_secret", "").strip()
    secret_val = legacy if len(legacy) >= 32 else secrets.token_hex(32)
    try:
        tmp_secret = SESSION_SECRET_PATH.with_name(f".session.secret.{secrets.token_hex(4)}.tmp")
        fd = os.open(str(tmp_secret), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, secret_val.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(tmp_secret, 0o600)
        os.replace(str(tmp_secret), str(SESSION_SECRET_PATH))
    except OSError:
        pass
    if legacy:
        execute_sql("DELETE FROM settings WHERE key = 'session_secret'")

    _SESSION_SECRET = secret_val.encode("utf-8")
    return _SESSION_SECRET


def get_session_epoch() -> int:
    try:
        return max(1, int(get_setting("session_epoch", "1") or "1"))
    except ValueError:
        return 1


def bump_session_epoch() -> int:
    new_epoch = get_session_epoch() + 1
    set_setting("session_epoch", str(new_epoch))
    return new_epoch


def invalidate_user_cache(username: Optional[str] = None) -> None:
    if username is None:
        _USER_EXISTS_CACHE.clear()
    else:
        _USER_EXISTS_CACHE.pop(username, None)


_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1


def hash_password(password: str, n: int = _SCRYPT_N, r: int = _SCRYPT_R, p: int = _SCRYPT_P) -> str:
    """Хеширует пароль через hashlib.scrypt и сохраняет параметры n/r/p в строке хеша (P3-08)."""
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p))
    return f"scrypt${int(n)}${int(r)}${int(p)}${salt.hex()}${derived.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Проверяет пароль против scrypt-хеша (поддерживает новый формат scrypt$n$r$p$salt$hex и старый scrypt$salt$hex)."""
    if not stored_hash or not stored_hash.startswith("scrypt$"):
        return False
    try:
        parts = stored_hash.split("$")
        if len(parts) == 6:
            n = int(parts[1])
            r = int(parts[2])
            p = int(parts[3])
            salt = bytes.fromhex(parts[4])
            expected = bytes.fromhex(parts[5])
        elif len(parts) == 3:
            n, r, p = _SCRYPT_N, _SCRYPT_R, _SCRYPT_P
            salt = bytes.fromhex(parts[1])
            expected = bytes.fromhex(parts[2])
        else:
            return False
        derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p)
        return hmac.compare_digest(derived, expected)
    except Exception:
        return False


def needs_password_rehash(stored_hash: str) -> bool:
    """Возвращает True для старого формата хеша без параметров n/r/p или при устаревших параметрах."""
    if not stored_hash or not stored_hash.startswith("scrypt$"):
        return True
    parts = stored_hash.split("$")
    if len(parts) != 6:
        return True
    try:
        return int(parts[1]) != _SCRYPT_N or int(parts[2]) != _SCRYPT_R or int(parts[3]) != _SCRYPT_P
    except ValueError:
        return True


def verify_dummy_password(password: str) -> bool:
    """Фиктивная проверка scrypt для выравнивания времени ответа при несуществующем пользователе (P1-2)."""
    return verify_password(password or "dummy", _DUMMY_SCRYPT_HASH)


def is_default_password() -> bool:
    """Возвращает True, если текущий пароль администратора равен дефолтному 'admin' (кэш по password_hash, P1-3)."""
    stored_hash = get_setting("password_hash", "")
    if not stored_hash:
        return True
    cached = _DEFAULT_PW_CACHE.get(stored_hash)
    if cached is not None:
        return cached
    res = verify_password("admin", stored_hash)
    if len(_DEFAULT_PW_CACHE) >= 16:
        _DEFAULT_PW_CACHE.clear()
    _DEFAULT_PW_CACHE[stored_hash] = res
    return res


_UNTRUSTED_PROXY_HEADERS_SEEN = False


def record_untrusted_proxy_header_seen() -> None:
    global _UNTRUSTED_PROXY_HEADERS_SEEN
    _UNTRUSTED_PROXY_HEADERS_SEEN = True


def was_untrusted_proxy_header_seen() -> bool:
    return _UNTRUSTED_PROXY_HEADERS_SEEN


def _normalize_ip(raw_ip: str) -> str:
    clean = (raw_ip or "").strip()
    if clean.startswith("[") and "]" in clean:
        clean = clean[1 : clean.index("]")]
    elif clean.count(":") == 1 and "." in clean:
        # IPv4:port
        clean = clean.split(":", 1)[0]
    if clean.startswith("::ffff:"):
        clean = clean[7:]
    if clean == "localhost":
        return "127.0.0.1"
    return clean


def is_loopback_ip(ip_str: str) -> bool:
    clean = _normalize_ip(ip_str)
    if not clean:
        return False
    try:
        return ipaddress.ip_address(clean).is_loopback
    except ValueError:
        return False


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


def _get_parsed_nets(cidr_csv: str) -> tuple[bool, list[Any]]:
    key = (cidr_csv or "").strip()
    if not key:
        return False, []
    cached = _PARSED_NETS_CACHE.get(key)
    if cached is not None:
        return cached
    nets: list[Any] = []
    allow_all = False
    for item in key.split(","):
        item = item.strip()
        if not item:
            continue
        if item == "*":
            allow_all = True
            break
        try:
            nets.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            continue
    res = (allow_all, nets)
    if len(_PARSED_NETS_CACHE) >= 128:
        _PARSED_NETS_CACHE.clear()
    _PARSED_NETS_CACHE[key] = res
    return res


def _ip_in_cidr_csv(ip_str: str, cidr_csv: str) -> bool:
    clean = _normalize_ip(ip_str)
    if not clean or not cidr_csv or not cidr_csv.strip():
        return False
    try:
        ip_obj = ipaddress.ip_address(clean)
    except ValueError:
        return False
    allow_all, nets = _get_parsed_nets(cidr_csv)
    if allow_all:
        return True
    for net in nets:
        if ip_obj in net:
            return True
    return False


def _extract_forwarded_hops(headers: Any) -> tuple[bool, list[str]]:
    """Извлекает IP-адреса из X-Forwarded-For, Forwarded, X-Real-IP, CF-Connecting-IP."""
    if not headers:
        return False, []
    lower_hdrs = {str(k).lower(): str(v) for k, v in headers.items()}
    has_fwd = any(
        bool(lower_hdrs.get(h, "").strip())
        for h in ("x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip")
    )
    if not has_fwd:
        return False, []

    hops: list[str] = []
    xff = lower_hdrs.get("x-forwarded-for", "").strip()
    if xff:
        for part in xff.split(","):
            cand = _normalize_ip(part)
            if cand:
                hops.append(cand)

    fwd = lower_hdrs.get("forwarded", "").strip()
    if fwd and not hops:
        for seg in fwd.split(","):
            for kv in seg.split(";"):
                kv = kv.strip()
                if kv.lower().startswith("for="):
                    val = kv[4:].strip().strip('"').strip("'")
                    cand = _normalize_ip(val)
                    if cand:
                        hops.append(cand)

    for single_hdr in ("cf-connecting-ip", "x-real-ip"):
        raw_val = lower_hdrs.get(single_hdr, "").strip()
        if raw_val and not hops:
            cand = _normalize_ip(raw_val)
            if cand:
                hops.append(cand)

    return True, hops


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


def resolve_request_client_ip(
    direct_ip: str,
    headers: Any = None,
    trusted_proxies_override: Optional[str] = None,
) -> tuple[str, bool, str]:
    """
    Определяет клиентский IP с защитой от обхода фильтра подсетей через reverse proxy на loopback (P0-5).
    Возвращает (client_ip, proxy_rejected, reject_reason).
    Если TCP-пир является loopback и в запросе есть proxy-заголовки (X-Forwarded-For / Forwarded /
    X-Real-IP / CF-Connecting-IP), но loopback не указан в trusted_proxies:
    не считает запрос локальным (proxy_rejected=True) и возвращает подсказку настроить trusted_proxies.
    """
    peer_ip = _normalize_ip(direct_ip or "127.0.0.1")
    trusted_csv = (
        trusted_proxies_override
        if trusted_proxies_override is not None
        else get_setting("trusted_proxies", "")
    ).strip()

    has_fwd, hops = _extract_forwarded_hops(headers)
    if not has_fwd:
        return peer_ip, False, ""

    if os.environ.get("BEACON_PREVIEW_MODE") == "1" and not trusted_csv and is_loopback_ip(peer_ip):
        return "127.0.0.1", False, ""

    peer_is_trusted = bool(trusted_csv and _ip_in_cidr_csv(peer_ip, trusted_csv))
    if not peer_is_trusted:
        if is_loopback_ip(peer_ip):
            record_untrusted_proxy_header_seen()
            fwd_candidate = peer_ip
            for h in hops:
                try:
                    ipaddress.ip_address(h)
                    fwd_candidate = h
                    break
                except ValueError:
                    continue
            return (
                fwd_candidate,
                True,
                "Обнаружены заголовки прокси (X-Forwarded-For/Forwarded/X-Real-IP/CF-Connecting-IP) с loopback, "
                "но trusted_proxies не настроен. Добавьте 127.0.0.1/32 в Настройки -> trusted_proxies.",
            )
        return peer_ip, False, ""

    # Прокси доверенный — берём правый недоверенный валидный IP
    for candidate in reversed(hops):
        try:
            ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if not _ip_in_cidr_csv(candidate, trusted_csv):
            return candidate, False, ""

    for candidate in hops:
        try:
            ipaddress.ip_address(candidate)
            return candidate, False, ""
        except ValueError:
            continue

    return peer_ip, False, ""


def is_ip_allowed(client_ip: str, headers: Any = None, direct_ip: Optional[str] = None) -> bool:
    """
    Проверяет client_ip по списку CIDR из настройки allowed_subnets.
    Если используется пароль по умолчанию 'admin', вход и доступ разрешены ТОЛЬКО
    с loopback и частных диапазонов RFC1918 (10/8, 172.16/12, 192.168/16).
    Также учитывает P0-5: proxy-заголовки с недоверенного loopback не считаются локальным доступом.
    """
    effective_ip = client_ip
    if headers is not None:
        resolved_ip, proxy_rejected, _ = resolve_request_client_ip(direct_ip or client_ip or "127.0.0.1", headers)
        if proxy_rejected:
            return False
        effective_ip = resolved_ip

    if not effective_ip:
        return True
    clean_ip = _normalize_ip(effective_ip)
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
    """Создаёт подписанный токен сессии (с session_epoch) и привязанный csrf_token."""
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
        "ep": get_session_epoch(),
    }
    payload_b64 = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    sig = hmac.new(_get_session_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}", csrf_token


def _prune_revoked_sessions_cache(now: Optional[int] = None) -> None:
    ts = now if now is not None else int(time.time())
    if len(_REVOKED_SESSIONS) > 128:
        expired = [sid for sid, exp in list(_REVOKED_SESSIONS.items()) if exp < ts]
        for sid in expired:
            _REVOKED_SESSIONS.pop(sid, None)


def revoke_session_token(token: str) -> None:
    """Серверная инвалидация токена сессии при выходе (POST /api/auth/logout)."""
    if not token or "." not in token:
        return
    try:
        payload_b64, _ = token.rsplit(".", 1)
        payload = json.loads(urllib.parse.unquote(payload_b64))
        now_ts = int(time.time())
        sid = str(payload.get("sid") or token)
        exp = int(payload.get("exp") or (now_ts + 86400 * 7))
        _REVOKED_SESSIONS[sid] = exp
        _prune_revoked_sessions_cache(now_ts)
        execute_sql(
            "INSERT INTO revoked_sessions (sid, exp) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET exp = excluded.exp",
            (sid, exp),
        )
        execute_sql("DELETE FROM revoked_sessions WHERE exp < ?", (now_ts,))
    except Exception:
        pass


def verify_session_token(token: str) -> Optional[dict[str, Any]]:
    """Проверяет подпись, срок действия, session_epoch, существование пользователя и отсутствие отзыва."""
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
        if int(payload.get("ep", 0)) != get_session_epoch():
            return None
        sid = str(payload.get("sid") or token)
        _prune_revoked_sessions_cache(now)
        if sid in _REVOKED_SESSIONS:
            return None
        try:
            row = query_one("SELECT sid FROM revoked_sessions WHERE sid = ? AND exp >= ?", (sid, now))
            if row:
                _REVOKED_SESSIONS[sid] = int(payload.get("exp", now + 3600))
                return None
        except Exception:
            pass

        uname = str(payload.get("user") or payload.get("sub") or "admin").strip()
        if uname and uname != "admin" and sid != "stream_ticket":
            now_m = time.monotonic()
            cached = _USER_EXISTS_CACHE.get(uname)
            if cached and (now_m - cached[0]) < _USER_CACHE_TTL_SEC:
                _, cached_role, exists = cached
                if not exists:
                    return None
                payload["role"] = cached_role
            else:
                u_row = query_one("SELECT role FROM users WHERE username = ?", (uname,))
                if not u_row:
                    _USER_EXISTS_CACHE[uname] = (now_m, "", False)
                    return None
                db_role = str(u_row.get("role") or "viewer")
                _USER_EXISTS_CACHE[uname] = (now_m, db_role, True)
                payload["role"] = db_role

        if "role" not in payload:
            payload["role"] = "admin"
        return payload
    except Exception:
        return None


def create_stream_ticket(run_id: int, session_sid: str = "", ttl_sec: int = 30) -> str:
    """Создаёт короткоживущий одноразовый тикет для SSE, привязанный к run_id и sid сессии (P3-08)."""
    if not run_id or int(run_id) <= 0:
        raise ValueError("Для создания SSE-тикета требуется положительный run_id")
    now = time.time()
    for k, v in list(_STREAM_TICKETS.items()):
        if v["exp"] < now:
            _STREAM_TICKETS.pop(k, None)
    ticket = secrets.token_urlsafe(24)
    _STREAM_TICKETS[ticket] = {
        "exp": now + ttl_sec,
        "run_id": int(run_id),
        "sid": str(session_sid or ""),
        "ep": get_session_epoch(),
    }
    return ticket


def consume_stream_ticket(ticket: str, run_id: int, session_sid: Optional[str] = None) -> bool:
    """Одноразово погашает SSE-тикет и проверяет run_id, sid сессии и session_epoch (P3-08)."""
    if not ticket or not run_id or int(run_id) <= 0:
        return False
    entry = _STREAM_TICKETS.pop(ticket, None)
    if not entry:
        return False
    if entry["exp"] < time.time():
        return False
    if int(entry["run_id"]) != int(run_id):
        return False
    if int(entry.get("ep", 0)) != get_session_epoch():
        return False
    expected_sid = str(entry.get("sid") or "")
    if expected_sid:
        if expected_sid in _REVOKED_SESSIONS:
            return False
        if session_sid:
            if not hmac.compare_digest(expected_sid, str(session_sid)):
                return False
        elif os.environ.get("BEACON_PREVIEW_MODE") != "1":
            return False
    return True


def hash_ai_token(raw_token: str) -> str:
    """Вычисляет SHA-256 хеш токена ИИ (сам токен в БД никогда не хранится)."""
    return hashlib.sha256(raw_token.strip().encode("utf-8")).hexdigest()


_MAX_RATE_BUCKET_KEYS = 4096


def _prune_attempts_bucket(bucket: dict[Any, list[float]], window_sec: float, now: float) -> None:
    if len(bucket) <= _MAX_RATE_BUCKET_KEYS:
        return
    for k, ts_list in list(bucket.items()):
        fresh = [t for t in ts_list if now - t <= window_sec]
        if fresh:
            bucket[k] = fresh
        else:
            bucket.pop(k, None)
    while len(bucket) > _MAX_RATE_BUCKET_KEYS:
        bucket.pop(next(iter(bucket)), None)


def _prune_blocked_bucket(bucket: dict[str, float], now: float) -> None:
    if len(bucket) <= _MAX_RATE_BUCKET_KEYS:
        return
    for k, unblock_at in list(bucket.items()):
        if unblock_at <= now:
            bucket.pop(k, None)
    while len(bucket) > _MAX_RATE_BUCKET_KEYS:
        bucket.pop(next(iter(bucket)), None)


def check_ai_auth_rate_limit(client_ip: str) -> tuple[bool, int]:
    """Проверяет блокировку IP по превышению неудачных попыток AI-аутентификации (без обращений к БД)."""
    clean_ip = _normalize_ip(client_ip or "127.0.0.1") or "127.0.0.1"
    now = time.time()
    unblock_at = _AI_AUTH_BLOCKED_IPS.get(clean_ip, 0.0)
    if unblock_at > now:
        return False, max(1, int(unblock_at - now))
    if clean_ip in _AI_AUTH_BLOCKED_IPS:
        _AI_AUTH_BLOCKED_IPS.pop(clean_ip, None)
    return True, 0


def record_ai_auth_failure(client_ip: str) -> tuple[bool, int]:
    clean_ip = _normalize_ip(client_ip or "127.0.0.1") or "127.0.0.1"
    now = time.time()
    _prune_attempts_bucket(_AI_AUTH_FAILS, AI_AUTH_WINDOW_SEC, now)
    _prune_blocked_bucket(_AI_AUTH_BLOCKED_IPS, now)
    attempts = [t for t in _AI_AUTH_FAILS.get(clean_ip, []) if now - t <= AI_AUTH_WINDOW_SEC]
    attempts.append(now)
    _AI_AUTH_FAILS[clean_ip] = attempts
    if len(attempts) >= AI_AUTH_MAX_FAILS:
        _AI_AUTH_BLOCKED_IPS[clean_ip] = now + AI_AUTH_BLOCK_SEC
        _AI_AUTH_FAILS[clean_ip] = []
        return True, AI_AUTH_BLOCK_SEC
    return False, 0


def clear_ai_auth_failures(client_ip: str) -> None:
    clean_ip = _normalize_ip(client_ip or "127.0.0.1") or "127.0.0.1"
    _AI_AUTH_FAILS.pop(clean_ip, None)
    _AI_AUTH_BLOCKED_IPS.pop(clean_ip, None)


def verify_ai_token(raw_token: str, client_ip: str = "127.0.0.1") -> tuple[Optional[dict[str, Any]], str]:
    """
    Проверяет Bearer-токен ИИ-доступа:
    - Сначала проверяет формат токена и rate-limit неудач по IP (защита от CPU-DoS до scrypt/БД, P1-3).
    - Затем проверяет пароль по умолчанию 'admin', флаги ai_access_enabled / ai_access_paused.
    - Проверяет SHA-256 хеш в таблице ai_tokens, срок действия, статус отзыва, фильтр IP и rate-limit токена.
    """
    clean_tok = (raw_token or "").strip()
    if not clean_tok or len(clean_tok) < 16:
        record_ai_auth_failure(client_ip)
        return None, "Недействительный токен авторизации"

    ai_ip_ok, ai_retry = check_ai_auth_rate_limit(client_ip)
    if not ai_ip_ok:
        return None, f"Превышен лимит неудачных попыток авторизации ИИ. Повторите через {ai_retry} сек."

    if is_default_password():
        return None, "Доступ ИИ заблокирован, пока используется пароль по умолчанию 'admin'"
    if get_setting("ai_access_enabled", "0") != "1":
        return None, "Доступ для ИИ выключен в настройках панели"
    if get_setting("ai_access_paused", "0") == "1":
        return None, "Доступ для ИИ временно приостановлен переключателем «Пауза ИИ»"

    thash = hash_ai_token(clean_tok)
    row = query_one("SELECT * FROM ai_tokens WHERE token_hash = ?", (thash,))
    if not row or int(row.get("revoked") or 0) == 1:
        record_ai_auth_failure(client_ip)
        return None, "Недействительный или отозванный токен ИИ"

    now = int(time.time())
    exp = int(row.get("expires_at") or 0)
    if exp > 0 and exp < now:
        record_ai_auth_failure(client_ip)
        return None, "Недействительный или истёкший токен ИИ"

    allowed_ips = str(row.get("allowed_ips") or "").strip()
    if allowed_ips and not _ip_in_cidr_csv(client_ip, allowed_ips):
        record_ai_auth_failure(client_ip)
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
    clear_ai_auth_failures(client_ip)

    execute_sql("UPDATE ai_tokens SET last_used_at = ? WHERE id = ?", (now, token_id))
    try:
        scopes = json.loads(row.get("scopes_json") or '["read"]')
    except Exception:
        scopes = ["read"]
    row["scopes"] = scopes if isinstance(scopes, list) else ["read"]
    return row, ""


def consume_ai_token_rate_limit(token_row: dict[str, Any], count: int = 1) -> tuple[bool, str]:
    """Списывает дополнительные единицы rate-limit для пакета JSON-RPC (batch, P2-04)."""
    if count <= 0:
        return True, ""
    token_id = int(token_row["id"])
    limit_per_min = max(1, int(token_row.get("rate_limit_per_min") or 60))
    now_f = time.time()
    hits = [t for t in _AI_TOKEN_HITS.get(token_id, []) if now_f - t <= 60.0]
    if len(hits) + count > limit_per_min:
        return False, f"Превышен лимит запросов для токена ({limit_per_min}/мин)"
    hits.extend([now_f] * count)
    _AI_TOKEN_HITS[token_id] = hits
    return True, ""


_RATE_LIMIT_GLOBAL_IP_MAX_FAILS = RATE_LIMIT_MAX_FAILS * 3


def _login_rate_key(client_ip: str, username: str = "") -> str:
    clean_user = (username or "").strip().lower()
    return f"{client_ip}|{clean_user}" if clean_user else client_ip


def check_rate_limit(client_ip: str, username: str = "") -> tuple[bool, int]:
    now = time.time()
    for check_key in (_login_rate_key(client_ip, username), f"__ip__|{client_ip}"):
        unblock_at = _BLOCKED_IPS.get(check_key, 0.0)
        if unblock_at > now:
            return False, max(1, int(unblock_at - now))
        elif check_key in _BLOCKED_IPS:
            del _BLOCKED_IPS[check_key]
    return True, 0


def record_login_failure(client_ip: str, username: str = "") -> tuple[bool, int]:
    key = _login_rate_key(client_ip, username)
    ip_global_key = f"__ip__|{client_ip}"
    now = time.time()
    _prune_attempts_bucket(_FAILED_LOGINS, RATE_LIMIT_WINDOW_SEC, now)
    _prune_blocked_bucket(_BLOCKED_IPS, now)

    attempts = [t for t in _FAILED_LOGINS.get(key, []) if now - t <= RATE_LIMIT_WINDOW_SEC]
    attempts.append(now)
    _FAILED_LOGINS[key] = attempts

    ip_attempts = [t for t in _FAILED_LOGINS.get(ip_global_key, []) if now - t <= RATE_LIMIT_WINDOW_SEC]
    ip_attempts.append(now)
    _FAILED_LOGINS[ip_global_key] = ip_attempts

    if len(attempts) >= RATE_LIMIT_MAX_FAILS:
        _BLOCKED_IPS[key] = now + RATE_LIMIT_BLOCK_SEC
        _FAILED_LOGINS[key] = []
        log_audit(
            client_ip,
            "RATE_LIMIT_BLOCK",
            f"Попытки входа для '{username or '*'}' с IP {client_ip} заблокированы на 15 минут ({len(attempts)} неудач)",
        )
        return True, RATE_LIMIT_BLOCK_SEC

    if len(ip_attempts) >= _RATE_LIMIT_GLOBAL_IP_MAX_FAILS:
        _BLOCKED_IPS[ip_global_key] = now + RATE_LIMIT_BLOCK_SEC
        _FAILED_LOGINS[ip_global_key] = []
        log_audit(
            client_ip,
            "RATE_LIMIT_BLOCK",
            f"IP {client_ip} заблокирован на 15 минут за перебор разных логинов ({len(ip_attempts)} неудач)",
        )
        return True, RATE_LIMIT_BLOCK_SEC

    log_audit(client_ip, "LOGIN_FAILED", f"Неверный пароль для '{username or '*'}' (попытка {len(attempts)}/{RATE_LIMIT_MAX_FAILS})")
    return False, 0


def clear_login_failures(client_ip: str, username: str = "") -> None:
    if username:
        key = _login_rate_key(client_ip, username)
        _FAILED_LOGINS.pop(key, None)
        _BLOCKED_IPS.pop(key, None)
    else:
        prefix = f"{client_ip}|"
        ip_global_key = f"__ip__|{client_ip}"
        for k in [k for k in list(_FAILED_LOGINS.keys()) if k == client_ip or k == ip_global_key or k.startswith(prefix)]:
            _FAILED_LOGINS.pop(k, None)
        for k in [k for k in list(_BLOCKED_IPS.keys()) if k == client_ip or k == ip_global_key or k.startswith(prefix)]:
            _BLOCKED_IPS.pop(k, None)


def check_webhook_rate_limit(client_ip: str) -> tuple[bool, int]:
    now = time.time()
    unblock_at = _WEBHOOK_BLOCKED_IPS.get(client_ip, 0.0)
    if unblock_at > now:
        return False, max(1, int(unblock_at - now))
    elif client_ip in _WEBHOOK_BLOCKED_IPS:
        del _WEBHOOK_BLOCKED_IPS[client_ip]

    _prune_attempts_bucket(_WEBHOOK_HITS, WEBHOOK_WINDOW_SEC, now)
    hits = [t for t in _WEBHOOK_HITS.get(client_ip, []) if now - t <= WEBHOOK_WINDOW_SEC]
    if len(hits) >= WEBHOOK_MAX_HITS:
        return False, WEBHOOK_WINDOW_SEC
    hits.append(now)
    _WEBHOOK_HITS[client_ip] = hits
    return True, 0


def record_webhook_failure(client_ip: str) -> tuple[bool, int]:
    now = time.time()
    _prune_attempts_bucket(_WEBHOOK_FAILS, RATE_LIMIT_WINDOW_SEC, now)
    _prune_blocked_bucket(_WEBHOOK_BLOCKED_IPS, now)
    fails = [t for t in _WEBHOOK_FAILS.get(client_ip, []) if now - t <= RATE_LIMIT_WINDOW_SEC]
    fails.append(now)
    _WEBHOOK_FAILS[client_ip] = fails
    if len(fails) >= WEBHOOK_MAX_FAILS:
        _WEBHOOK_BLOCKED_IPS[client_ip] = now + WEBHOOK_BLOCK_SEC
        _WEBHOOK_FAILS[client_ip] = []
        log_audit(client_ip, "WEBHOOK_BRUTEFORCE_BLOCK", f"IP заблокирован на 10 минут после {len(fails)} ошибок вебхука")
        return True, WEBHOOK_BLOCK_SEC
    return False, 0
