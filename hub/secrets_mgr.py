"""
Управление секретами (/opt/hub/data/secrets/<name>, права 0600),
импорт куки из Cookie-Editor в 1 клик и редактирование (маскировка) секретов в логах.
"""

import base64
import binascii
import json
import os
import re
import secrets
import time
import urllib.parse
from pathlib import Path
from typing import Any, Optional

from hub.config import SECRETS_DIR, ensure_directories
from hub.db import db_session, execute_rowcount, get_setting, query_all, query_one
from hub.log import get_logger

logger = get_logger("secrets")

_SECRET_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_MIN_PLAIN_SECRET_LEN = 8

# Регулярные выражения для автоматического маскирования типичных токенов в логах (даже если они не внесены в таблицу secrets)
_REGEX_REDACTORS: list[tuple[re.Pattern[str], str]] = [
    # Telegram Bot API токен
    (re.compile(r"\b\d{8,11}:[A-Za-z0-9_-]{24,45}\b"), "***REDACTED_TG_TOKEN***"),
    # GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_)
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,60}|github_pat_[A-Za-z0-9_]{40,110})\b"), "***REDACTED_GH_TOKEN***"),
    # OpenAI / Anthropic / Stripe generic sk- tokens
    (re.compile(r"\bsk-(?:proj-|live-|test-|ant-api\d*-)?[A-Za-z0-9_-]{20,}\b"), "***REDACTED_API_KEY***"),
    # AWS Access Key ID
    (re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b"), "***REDACTED_AWS_KEY***"),
    # Slack tokens и Slack Incoming Webhooks
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "***REDACTED_SLACK_TOKEN***"),
    (re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+"), "***REDACTED_SLACK_WEBHOOK***"),
    # Discord Webhooks
    (
        re.compile(r"https://(?:canary\.|ptb\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]+"),
        "***REDACTED_DISCORD_WEBHOOK***",
    ),
    # Authorization: Bearer / Basic <token>
    (re.compile(r"(?i)(Bearer\s+|Basic\s+)[A-Za-z0-9_\-\.~+/=]{12,}"), r"\1***REDACTED_AUTH***"),
    # Учётные данные в URL (scheme://user:pass@host)
    (re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://)([^/\s:@]+):([^/\s@]+)@"), r"\1***:***@"),
    # Секреты в CLI-флагах (--password=..., --api-key=..., --token=...)
    (
        re.compile(r"(?i)(--?(?:token|password|passwd|secret|api[-_]?key|auth|bearer)\s*[=\s]\s*)([^\s\"'`]+)"),
        r"\1***REDACTED_CLI_SECRET***",
    ),
]

# Кэш вариантов секретов (сырых и кодированных) длиной >= 8 символов: list[(secret_name, candidate_str)]
_REDACTION_CACHE: list[tuple[str, str]] = []
_CACHE_LOADED = False


def validate_secret_name(name: str) -> str:
    """
    Строгая валидация имени секрета / профиля куки против Path Traversal:
    разрешены только латинские буквы, цифры, '_' и '-' (1–64 символа).
    """
    clean = (name or "").strip()
    if not clean or clean in (".", "..") or not _SECRET_NAME_RE.match(clean):
        raise ValueError(
            "Недопустимое имя секрета или профиля куки: разрешены только латинские буквы (a-z, A-Z), цифры (0-9), '_' и '-' (1–64 символа)."
        )
    base_dir = SECRETS_DIR.resolve()
    target = (base_dir / clean).resolve()
    if os.path.commonpath([str(base_dir), str(target)]) != str(base_dir):
        raise ValueError("Обнаружена попытка выхода за пределы каталога секретов (Path Traversal).")
    return clean


def validate_cookie_name(name: str) -> str:
    """Алиас валидации имени профиля куки."""
    return validate_secret_name(name)


def _atomic_write_secret_bytes(target_path: Path, data: bytes) -> None:
    """Атомарная запись файла секрета через временный файл с правами 0600 с первого байта."""
    ensure_directories()
    tmp_path = target_path.with_name(f".{target_path.name}.{secrets.token_hex(6)}.tmp")
    try:
        fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            view = memoryview(data)
            written = 0
            while written < len(view):
                written += os.write(fd, view[written:])
        finally:
            os.close(fd)
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, target_path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _expand_secret_variants(name: str, val: str) -> list[tuple[str, str]]:
    """Добавляет сырое значение секрета, а также URL-encoded, JSON-escaped и base64 варианты."""
    out: list[tuple[str, str]] = []
    if not val or len(val) < _MIN_PLAIN_SECRET_LEN:
        return out
    seen: set[str] = set()
    candidates = [val]
    try:
        candidates.append(urllib.parse.quote(val, safe=""))
        candidates.append(urllib.parse.quote_plus(val))
    except Exception:
        pass
    try:
        json_esc = json.dumps(val, ensure_ascii=True)
        if len(json_esc) >= 2:
            candidates.append(json_esc[1:-1])
        json_utf = json.dumps(val, ensure_ascii=False)
        if len(json_utf) >= 2:
            candidates.append(json_utf[1:-1])
    except Exception:
        pass
    try:
        b64 = base64.b64encode(val.encode("utf-8")).decode("ascii")
        if len(b64) >= _MIN_PLAIN_SECRET_LEN:
            candidates.append(b64)
    except Exception:
        pass

    for c in candidates:
        if c and len(c) >= _MIN_PLAIN_SECRET_LEN and c not in seen:
            seen.add(c)
            out.append((name, c))
    return out


def reload_redaction_cache() -> None:
    """Перезагружает в память текстовые секреты длиной >= 8 символов (и их кодировки) для маскировки логов."""
    global _REDACTION_CACHE, _CACHE_LOADED
    ensure_directories()
    rows = query_all("SELECT name, type, file_path FROM secrets")
    items: list[tuple[str, str]] = []

    try:
        sys_tg = get_setting("tg_bot_token", "").strip()
        if len(sys_tg) >= _MIN_PLAIN_SECRET_LEN:
            items.extend(_expand_secret_variants("tg_bot_token", sys_tg))
    except Exception:
        logger.exception("Не удалось прочитать tg_bot_token для кэша редактирования")

    for row in rows:
        name = row["name"]
        sec_type = row["type"]
        fpath = Path(row["file_path"])
        if not fpath.exists():
            continue
        try:
            if sec_type == "file":
                try:
                    fsize = fpath.stat().st_size
                except OSError:
                    continue
                if fsize <= 64 * 1024:
                    raw_bytes = fpath.read_bytes()
                    try:
                        file_text = raw_bytes.decode("utf-8")
                    except UnicodeDecodeError:
                        # Бинарный файл (ключ/сертификат DER и т.п.) не индексируем как текст
                        file_text = ""
                    if file_text:
                        stripped_full = file_text.strip()
                        if _MIN_PLAIN_SECRET_LEN <= len(stripped_full) <= 4096:
                            items.extend(_expand_secret_variants(name, stripped_full))
                        for raw_line in file_text.splitlines():
                            ln = raw_line.strip()
                            if not ln or ln.startswith("#"):
                                continue
                            if ln.startswith("-----BEGIN ") or ln.startswith("-----END "):
                                continue
                            if "=" in ln:
                                _, rhs = ln.split("=", 1)
                                rhs_clean = rhs.strip().strip('"').strip("'")
                                if len(rhs_clean) >= _MIN_PLAIN_SECRET_LEN:
                                    items.extend(_expand_secret_variants(name, rhs_clean))
                            if len(ln) >= _MIN_PLAIN_SECRET_LEN:
                                items.extend(_expand_secret_variants(name, ln))
                continue

            content = fpath.read_text(encoding="utf-8", errors="ignore").strip()
            if sec_type == "text" and len(content) >= _MIN_PLAIN_SECRET_LEN:
                items.extend(_expand_secret_variants(name, content))
            elif sec_type == "cookie_json":
                try:
                    cookies = json.loads(content)
                    if isinstance(cookies, list):
                        for c in cookies:
                            if isinstance(c, dict):
                                val = str(c.get("value", "")).strip()
                                if len(val) >= _MIN_PLAIN_SECRET_LEN:
                                    items.extend(_expand_secret_variants(name, val))
                except Exception as exc:
                    logger.warning("Не удалось разобрать cookie_json секрет '%s': %s", name, exc)
        except Exception:
            logger.exception("Не удалось прочитать файл секрета '%s'", name)
            continue
    # Сортируем по убыванию длины значения, чтобы длинные секреты заменялись первыми
    items.sort(key=lambda x: len(x[1]), reverse=True)
    _REDACTION_CACHE = items
    _CACHE_LOADED = True


def redact_log_text(text: str) -> str:
    """
    Заменяет вхождения значений секретов длиной >= 8 символов (и их URL/JSON/base64 представлений)
    на ***SECRET:<name>***, скрывает путь SECRETS_DIR и маскирует токены/URL/CLI-флаги по регуляркам.
    """
    if not text:
        return text
    if not _CACHE_LOADED:
        reload_redaction_cache()
    result = text
    for name, secret_val in _REDACTION_CACHE:
        if secret_val and secret_val in result:
            result = result.replace(secret_val, f"***SECRET:{name}***")
    for sec_dir_str in {str(SECRETS_DIR), str(SECRETS_DIR.resolve())}:
        if sec_dir_str and sec_dir_str in result:
            result = result.replace(sec_dir_str, "***SECRETS_DIR***")
    for pattern, replacement in _REGEX_REDACTORS:
        result = pattern.sub(replacement, result)
    return result


def list_secrets() -> list[dict[str, Any]]:
    """Возвращает список секретов со скрытыми значениями (********) и безопасными метаданными кук."""
    rows = query_all("SELECT name, type, file_path, is_expired, expired_note, updated_at FROM secrets ORDER BY name ASC")
    out: list[dict[str, Any]] = []
    for r in rows:
        fpath = Path(r["file_path"])
        size_bytes = fpath.stat().st_size if fpath.exists() else 0
        cookie_meta: Optional[dict[str, Any]] = None
        if r["type"] == "cookie_json" and fpath.exists() and size_bytes <= 2 * 1024 * 1024:
            try:
                parsed = json.loads(fpath.read_text(encoding="utf-8", errors="ignore"))
                if isinstance(parsed, list):
                    domains: list[str] = []
                    earliest_exp: Optional[int] = None
                    for item in parsed:
                        if isinstance(item, dict):
                            dom = str(item.get("domain") or "").strip()
                            if dom and dom not in domains:
                                domains.append(dom)
                            exp = item.get("expirationDate") or item.get("expires")
                            if isinstance(exp, (int, float)) and exp > 1_000_000_000:
                                exp_int = int(exp)
                                if earliest_exp is None or exp_int < earliest_exp:
                                    earliest_exp = exp_int
                    cookie_meta = {
                        "count": len(parsed),
                        "domains": domains[:6],
                        "earliest_expiry": earliest_exp,
                    }
            except Exception:
                pass
        item_dict: dict[str, Any] = {
            "name": r["name"],
            "type": r["type"],
            "file_path": r["file_path"],
            "is_expired": int(r["is_expired"]),
            "expired_note": r["expired_note"] or "",
            "updated_at": r["updated_at"],
            "masked_value": "********",
            "size_bytes": size_bytes,
        }
        if cookie_meta is not None:
            item_dict["cookie_meta"] = cookie_meta
        out.append(item_dict)
    return out


def get_secret_raw(name: str) -> Optional[dict[str, Any]]:
    """Возвращает метаданные и содержимое секрета для внутреннего SDK."""
    clean_name = validate_secret_name(name)
    row = query_one(
        "SELECT name, type, file_path, is_expired, expired_note, updated_at FROM secrets WHERE name = ?",
        (clean_name,),
    )
    if not row:
        return None
    fpath = Path(row["file_path"]).resolve()
    base_dir = SECRETS_DIR.resolve()
    if os.path.commonpath([str(base_dir), str(fpath)]) != str(base_dir):
        raise ValueError("Недопустимый путь файла секрета")

    raw_val: Any = ""
    value_b64: Optional[str] = None
    is_binary = False
    if fpath.exists():
        raw_bytes = fpath.read_bytes()
        if row["type"] == "file":
            try:
                raw_val = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                is_binary = True
                value_b64 = base64.b64encode(raw_bytes).decode("ascii")
                raw_val = f"base64:{value_b64}"
        else:
            content = raw_bytes.decode("utf-8", errors="replace")
            if row["type"] == "cookie_json":
                try:
                    raw_val = json.loads(content)
                except Exception:
                    raw_val = content
            else:
                raw_val = content
    res: dict[str, Any] = {
        "name": row["name"],
        "type": row["type"],
        "file_path": str(fpath),
        "value": raw_val,
        "is_expired": int(row["is_expired"]),
        "expired_note": row["expired_note"] or "",
        "is_binary": is_binary,
    }
    if value_b64 is not None:
        res["value_b64"] = value_b64
    return res


def save_secret(name: str, sec_type: str, content: str, *, is_base64: bool = False) -> dict[str, Any]:
    """Сохраняет секрет атомарно в data/secrets/<name> с правами 0600 и обновляет SQLite."""
    clean_name = validate_secret_name(name)
    if sec_type not in ("text", "file", "cookie_json"):
        raise ValueError("Недопустимый тип секрета (ожидается text, file или cookie_json)")

    ensure_directories()
    fpath = SECRETS_DIR / clean_name

    raw_text = content or ""
    if sec_type == "file" and (is_base64 or raw_text.startswith("base64:")):
        b64_payload = raw_text[len("base64:") :] if raw_text.startswith("base64:") and not is_base64 else raw_text
        try:
            data_bytes = base64.b64decode(b64_payload.strip(), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"Некорректное base64-содержимое файла секрета: {exc}") from exc
    else:
        data_bytes = raw_text.encode("utf-8")

    _atomic_write_secret_bytes(fpath, data_bytes)

    now = int(time.time())
    with db_session() as conn:
        conn.execute(
            """INSERT INTO secrets (name, type, file_path, is_expired, expired_note, updated_at)
               VALUES (?, ?, ?, 0, '', ?)
               ON CONFLICT(name) DO UPDATE SET
                 type = excluded.type,
                 file_path = excluded.file_path,
                 is_expired = 0,
                 expired_note = '',
                 updated_at = excluded.updated_at""",
            (clean_name, sec_type, str(fpath), now),
        )
    reload_redaction_cache()
    return {
        "name": clean_name,
        "type": sec_type,
        "file_path": str(fpath),
        "is_expired": 0,
        "updated_at": now,
        "size_bytes": len(data_bytes),
    }


def import_cookie_editor_json(name: str, raw_json: Any) -> dict[str, Any]:
    """
    Импорт куки из расширения Cookie-Editor в 1 клик:
    - Валидирует структуру JSON-массива (наличие ключей name, value, domain).
    - Сохраняет в /opt/hub/data/secrets/<name> с правами 0600.
    - Сбрасывает флаг is_expired = 0.
    """
    clean_name = validate_secret_name(name)
    if isinstance(raw_json, str):
        try:
            parsed = json.loads(raw_json)
        except Exception as e:
            raise ValueError(f"Некорректный JSON куки: {e}") from e
    else:
        parsed = raw_json

    if not isinstance(parsed, list) or len(parsed) == 0:
        raise ValueError("JSON из Cookie-Editor должен быть непустым массивом объектов куки.")

    normalized: list[dict[str, Any]] = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            raise ValueError(f"Элемент #{idx} не является JSON-объектом.")
        if "name" not in item or "value" not in item or "domain" not in item:
            raise ValueError(f"Кука #{idx} должна содержать обязательные поля 'name', 'value' и 'domain'.")
        normalized.append(item)

    formatted = json.dumps(normalized, indent=2, ensure_ascii=False)
    res = save_secret(clean_name, "cookie_json", formatted)
    res["cookies_count"] = len(normalized)
    return res


def mark_cookies_expired(name: str, note: str = "Куки устарели, требуется обновление") -> bool:
    """Помечает существующий секрет is_expired = 1 (не создаёт новых произвольных секретов, P2-09)."""
    clean_name = validate_secret_name(name)
    now = int(time.time())
    changed = execute_rowcount(
        "UPDATE secrets SET is_expired = 1, expired_note = ?, updated_at = ? WHERE name = ?",
        (note, now, clean_name),
    )
    return changed > 0


def delete_secret(name: str) -> bool:
    clean_name = validate_secret_name(name)
    row = query_one("SELECT file_path FROM secrets WHERE name = ?", (clean_name,))
    if not row:
        return False
    fpath = Path(row["file_path"]).resolve()
    base_dir = SECRETS_DIR.resolve()
    if os.path.commonpath([str(base_dir), str(fpath)]) == str(base_dir) and fpath.exists():
        try:
            fpath.unlink()
        except OSError:
            pass
    execute_rowcount("DELETE FROM secrets WHERE name = ?", (clean_name,))
    reload_redaction_cache()
    return True
