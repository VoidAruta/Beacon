"""
Управление секретами (/opt/hub/data/secrets/<name>, права 0600),
импорт куки из Cookie-Editor в 1 клик и редактирование (маскировка) секретов в логах.
"""

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

from hub.config import SECRETS_DIR, ensure_directories
from hub.db import db_session, execute_sql, query_all, query_one

_SECRET_NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")

# Кэш текстовых секретов длиной >= 4 символов для фильтрации логов: list[(secret_name, secret_value)]
_REDACTION_CACHE: list[tuple[str, str]] = []
_CACHE_LOADED = False


def validate_secret_name(name: str) -> str:
    clean = (name or "").strip()
    if not _SECRET_NAME_RE.match(clean):
        raise ValueError("Имя секрета должно содержать только латинские буквы, цифры и '_' (1–64 символа).")
    return clean


def reload_redaction_cache() -> None:
    """Перезагружает в память текстовые секреты длиной >= 4 символов для маскировки логов."""
    global _REDACTION_CACHE, _CACHE_LOADED
    ensure_directories()
    rows = query_all("SELECT name, type, file_path FROM secrets")
    items: list[tuple[str, str]] = []
    for row in rows:
        name = row["name"]
        sec_type = row["type"]
        fpath = Path(row["file_path"])
        if not fpath.exists():
            continue
        try:
            content = fpath.read_text(encoding="utf-8", errors="ignore").strip()
            if sec_type == "text" and len(content) >= 4:
                items.append((name, content))
            elif sec_type == "cookie_json":
                # Маскируем также значения куки длиной >= 6 символов
                try:
                    cookies = json.loads(content)
                    if isinstance(cookies, list):
                        for c in cookies:
                            if isinstance(c, dict):
                                val = str(c.get("value", "")).strip()
                                if len(val) >= 6:
                                    items.append((name, val))
                except Exception:
                    pass
        except Exception:
            continue
    # Сортируем по убыванию длины значения, чтобы длинные секреты заменялись первыми
    items.sort(key=lambda x: len(x[1]), reverse=True)
    _REDACTION_CACHE = items
    _CACHE_LOADED = True


def redact_log_text(text: str) -> str:
    """Заменяет вхождения значений секретов длиной >= 4 символов на ***SECRET:<name>***."""
    if not text:
        return text
    if not _CACHE_LOADED:
        reload_redaction_cache()
    result = text
    for name, secret_val in _REDACTION_CACHE:
        if secret_val and secret_val in result:
            result = result.replace(secret_val, f"***SECRET:{name}***")
    return result


def list_secrets() -> list[dict[str, Any]]:
    """Возвращает список секретов со скрытыми значениями (********)."""
    rows = query_all("SELECT name, type, file_path, is_expired, expired_note, updated_at FROM secrets ORDER BY name ASC")
    out: list[dict[str, Any]] = []
    for r in rows:
        fpath = Path(r["file_path"])
        size_bytes = fpath.stat().st_size if fpath.exists() else 0
        out.append(
            {
                "name": r["name"],
                "type": r["type"],
                "file_path": r["file_path"],
                "is_expired": int(r["is_expired"]),
                "expired_note": r["expired_note"] or "",
                "updated_at": r["updated_at"],
                "masked_value": "********",
                "size_bytes": size_bytes,
            }
        )
    return out


def get_secret_raw(name: str) -> Optional[dict[str, Any]]:
    """Возвращает метаданные и расшифрованное содержимое секрета для внутреннего SDK."""
    row = query_one(
        "SELECT name, type, file_path, is_expired, expired_note, updated_at FROM secrets WHERE name = ?",
        (name,),
    )
    if not row:
        return None
    fpath = Path(row["file_path"])
    raw_val: Any = ""
    if fpath.exists():
        content = fpath.read_text(encoding="utf-8", errors="replace")
        if row["type"] == "cookie_json":
            try:
                raw_val = json.loads(content)
            except Exception:
                raw_val = content
        else:
            raw_val = content
    return {
        "name": row["name"],
        "type": row["type"],
        "file_path": row["file_path"],
        "value": raw_val,
        "is_expired": int(row["is_expired"]),
        "expired_note": row["expired_note"] or "",
    }


def save_secret(name: str, sec_type: str, content: str) -> dict[str, Any]:
    """Сохраняет секрет в файл /opt/hub/data/secrets/<name> с правами 0600 и обновляет SQLite."""
    clean_name = validate_secret_name(name)
    if sec_type not in ("text", "file", "cookie_json"):
        raise ValueError("Недопустимый тип секрета (ожидается text, file или cookie_json)")

    ensure_directories()
    fpath = SECRETS_DIR / clean_name
    fpath.write_text(content or "", encoding="utf-8")
    try:
        os.chmod(fpath, 0o600)
    except OSError:
        pass

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
    """Помечает секрет is_expired = 1."""
    row = query_one("SELECT name FROM secrets WHERE name = ?", (name,))
    now = int(time.time())
    if not row:
        # Если секрет ещё не существовал, создаём пустой слот cookie_json со статусом is_expired=1
        ensure_directories()
        clean_name = validate_secret_name(name)
        fpath = SECRETS_DIR / clean_name
        if not fpath.exists():
            fpath.write_text("[]", encoding="utf-8")
            try:
                os.chmod(fpath, 0o600)
            except OSError:
                pass
        execute_sql(
            "INSERT INTO secrets (name, type, file_path, is_expired, expired_note, updated_at) VALUES (?, 'cookie_json', ?, 1, ?, ?)",
            (clean_name, str(fpath), note, now),
        )
        return True

    execute_sql(
        "UPDATE secrets SET is_expired = 1, expired_note = ?, updated_at = ? WHERE name = ?",
        (note, now, name),
    )
    return True


def delete_secret(name: str) -> bool:
    row = query_one("SELECT file_path FROM secrets WHERE name = ?", (name,))
    if not row:
        return False
    fpath = Path(row["file_path"])
    if fpath.exists():
        try:
            fpath.unlink()
        except OSError:
            pass
    execute_sql("DELETE FROM secrets WHERE name = ?", (name,))
    reload_redaction_cache()
    return True
