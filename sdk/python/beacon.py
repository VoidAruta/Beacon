"""
Beacon Python SDK (/opt/beacon/sdk/python/beacon.py)
Автоматически подключается через PYTHONPATH.
Поддерживает:
  - beacon.notify(text, level="info", strict=False)
  - beacon.secret(name, as_path=False)
  - beacon.cookies_expired(secret_name, note="", strict=False)
  - beacon.ask(prompt, timeout=300)
  - beacon.ping(token=None, strict=False)
  - beacon.state.get(key, default=None, strict=False) / .set(key, val, strict=False) / .delete(key, strict=False)
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        return None


_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
_RETRY_DELAYS = (0.5, 1.5)
_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
_MAX_ERROR_BODY_BYTES = 4096
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_PING_URL_RE = re.compile(r"(/api/ping/)([^/?#\s]+)")
_USERINFO_URL_RE = re.compile(r"(https?://)([^/@\s]+)@")


def _redact_url(url: str) -> str:
    cleaned = _USERINFO_URL_RE.sub(r"\1***@", str(url or ""))
    cleaned = _PING_URL_RE.sub(r"\1***", cleaned)
    if "?" in cleaned:
        cleaned = cleaned.split("?", 1)[0] + "?***"
    return cleaned


def _validate_api_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise BeaconApiError(f"Invalid Beacon API URL: {_redact_url(url)}", status_code=0)
    allow_remote = str(os.environ.get("BEACON_ALLOW_REMOTE_API", "")).strip().lower() in ("1", "true", "yes")
    if not allow_remote and parsed.hostname.lower() not in _LOOPBACK_HOSTS:
        raise BeaconApiError(
            f"Refusing to send Beacon API request to non-loopback host '{parsed.hostname}' "
            "(set BEACON_ALLOW_REMOTE_API=1 to override)",
            status_code=0,
        )


class BeaconApiError(RuntimeError):
    def __init__(self, message: str, status_code: int = 0):
        super().__init__(message)
        self.status_code = int(status_code)


def _get_api_config() -> tuple[str, str]:
    api_url = (
        os.environ.get("BEACON_API_URL")
        or "http://127.0.0.1:8050/internal"
    ).rstrip("/")
    run_token = os.environ.get("BEACON_RUN_TOKEN") or ""
    return api_url, run_token


def _log_stderr(msg: str) -> None:
    try:
        sys.stderr.write(f"[beacon-sdk] {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


def _request_raw_url(
    method: str,
    url: str,
    payload: Optional[dict[str, Any]] = None,
    headers: Optional[dict[str, str]] = None,
    timeout: float = 15.0,
    max_attempts: int = 3,
) -> dict[str, Any]:
    _validate_api_url(url)
    req_headers = dict(headers or {"Accept": "application/json"})
    data_bytes = None
    if payload is not None:
        data_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req_headers["Content-Type"] = "application/json; charset=utf-8"

    last_exc: Optional[Exception] = None
    attempts = max(1, int(max_attempts))
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=data_bytes, headers=req_headers, method=method.upper())
        try:
            with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
                raw_bytes = resp.read(_MAX_RESPONSE_BYTES + 1)
                if len(raw_bytes) > _MAX_RESPONSE_BYTES:
                    raise BeaconApiError(
                        f"Beacon API response exceeded {_MAX_RESPONSE_BYTES} bytes on {_redact_url(url)}",
                        status_code=0,
                    )
                raw = raw_bytes.decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            err_body = e.read(_MAX_ERROR_BODY_BYTES).decode("utf-8", errors="replace")
            exc = BeaconApiError(f"Beacon API HTTP {e.code} on {_redact_url(url)}: {err_body}", status_code=int(e.code))
            # 3xx (редиректы запрещены) и 4xx не ретраим — это клиентская ошибка/ACL/авторизация
            if 300 <= int(e.code) < 500:
                raise exc from e
            last_exc = exc
        except BeaconApiError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_exc = BeaconApiError(f"Beacon API connection error on {_redact_url(url)}: {e}", status_code=0)

        if attempt + 1 < attempts:
            delay = _RETRY_DELAYS[attempt] if attempt < len(_RETRY_DELAYS) else _RETRY_DELAYS[-1]
            time.sleep(delay)

    assert last_exc is not None
    raise last_exc


def _request_json(
    method: str,
    path: str,
    payload: Optional[dict[str, Any]] = None,
    timeout: float = 15.0,
    max_attempts: int = 3,
) -> dict[str, Any]:
    api_url, run_token = _get_api_config()
    url = f"{api_url}/{path.lstrip('/')}"
    headers = {
        "X-Beacon-Token": run_token,
        "Accept": "application/json",
    }
    return _request_raw_url(method, url, payload=payload, headers=headers, timeout=timeout, max_attempts=max_attempts)


def notify(text: str, level: str = "info", strict: bool = False) -> bool:
    """
    Отправляет уведомление от имени текущего проекта (Telegram, Discord, Slack, ntfy, Webhook).
    По умолчанию best-effort (не роняет скрипт при временной недоступности панели, если strict=False).
    """
    try:
        res = _request_json("POST", "/notify", {"text": str(text), "level": str(level)})
        return bool(res.get("ok", True))
    except Exception as exc:
        if strict:
            raise
        _log_stderr(f"notify() failed (non-fatal): {exc}")
        return False


def secret(name: str, as_path: bool = False) -> Any:
    """
    Возвращает значение секрета по имени.
    - Если тип секрета 'cookie_json', возвращает распарсенный список словарей (list[dict]).
    - Если тип секрета 'text', возвращает строку (не меняя тип для числовых строк вроде '12345').
    - Если тип секрета 'file' или передан as_path=True, возвращает путь к файлу секрета.
    """
    clean_name = str(name or "").strip()
    if not clean_name:
        raise ValueError("Имя секрета не может быть пустым")
    try:
        res = _request_json("GET", f"/secret/{urllib.parse.quote(clean_name, safe='')}")
        sec_type = res.get("type", "text")
        file_path = res.get("file_path", "")
        val = res.get("value")

        if as_path:
            return file_path

        if sec_type == "cookie_json":
            if isinstance(val, (list, dict)):
                return val
            if isinstance(val, str) and val.strip():
                return json.loads(val)
            if file_path and os.path.exists(file_path):
                with open(file_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            return []

        if sec_type == "file":
            return file_path

        return val if val is None or isinstance(val, str) else str(val)
    except Exception:
        env_file = os.environ.get(f"BEACON_SECRET_FILE_{clean_name}")
        sec_type = (os.environ.get(f"BEACON_SECRET_TYPE_{clean_name}") or "text").strip().lower()
        if as_path and env_file:
            return env_file
        if env_file and os.path.exists(env_file):
            if sec_type == "file":
                return env_file
            with open(env_file, "r", encoding="utf-8") as f:
                content = f.read()
            if sec_type == "cookie_json":
                return json.loads(content)
            return content
        raise


def cookies_expired(secret_name: str, note: str = "Куки устарели, требуется обновление", strict: bool = False) -> bool:
    """
    Помечает секрет с куки как истёкший (is_expired = 1), зажигает тревожный баннер в UI
    и отправляет срочное уведомление в Telegram.
    """
    try:
        res = _request_json(
            "POST",
            "/cookies_expired",
            {"secret_name": str(secret_name), "note": str(note)},
        )
        return bool(res.get("ok", True))
    except Exception as exc:
        if strict:
            raise
        _log_stderr(f"cookies_expired('{secret_name}') failed (non-fatal): {exc}")
        return False


def ask(prompt: str, timeout: int = 300) -> str:
    """
    Блокирующий интерактивный запрос ввода от пользователя (через веб-панель или Reply в Telegram).
    Переводит текущий запуск в статус 'waiting_input' и ждёт ответа до timeout секунд (1..3600).
    """
    try:
        safe_timeout = max(1, min(3600, int(timeout)))
    except (TypeError, ValueError):
        safe_timeout = 300

    create_res = _request_json(
        "POST",
        "/ask/create",
        {"prompt": str(prompt), "timeout": safe_timeout},
    )
    ask_id = create_res.get("ask_id")
    if not ask_id:
        raise RuntimeError(f"Не удалось создать запрос beacon.ask: {create_res}")

    deadline = time.time() + safe_timeout + 5
    while time.time() < deadline:
        try:
            poll_res = _request_json("GET", f"/ask/poll/{urllib.parse.quote(str(ask_id), safe='')}", timeout=15.0, max_attempts=1)
        except BeaconApiError as exc:
            if exc.status_code in (401, 403, 404):
                raise
            _log_stderr(f"ask poll error ({ask_id}): {exc}")
            time.sleep(1.0)
            continue
        except Exception as exc:
            _log_stderr(f"ask poll error ({ask_id}): {exc}")
            time.sleep(1.0)
            continue

        status = poll_res.get("status")
        if status == "answered":
            return str(poll_res.get("answer", ""))
        if status in ("timeout", "cancelled"):
            raise TimeoutError(f"Запрос beacon.ask('{prompt}') завершился со статусом: {status}")

        time.sleep(0.3)

    raise TimeoutError(f"Превышено время ожидания ответа на beacon.ask('{prompt}')")


def ping(token: Optional[str] = None, strict: bool = False) -> bool:
    """
    Отправляет Dead Man's Switch heartbeat-пинг на GET /api/ping/{ping_token}.
    По умолчанию читает BEACON_PING_TOKEN из окружения процесса.
    """
    tok = (token or os.environ.get("BEACON_PING_TOKEN") or "").strip()
    if not tok:
        if strict:
            raise RuntimeError("Не задан ping_token (передайте аргумент token или BEACON_PING_TOKEN)")
        _log_stderr("ping() skipped: BEACON_PING_TOKEN is not set")
        return False

    api_url, _ = _get_api_config()
    root_url = api_url[:-len("/internal")] if api_url.endswith("/internal") else api_url.rsplit("/internal", 1)[0]
    ping_url = f"{root_url.rstrip('/')}/api/ping/{urllib.parse.quote(tok, safe='')}"
    try:
        res = _request_raw_url("GET", ping_url, headers={"Accept": "application/json"}, timeout=10.0, max_attempts=3)
        return bool(res.get("ok", True))
    except Exception as exc:
        if strict:
            raise
        _log_stderr(f"ping() failed (non-fatal): {exc}")
        return False


class _StateStore:
    """Персистентное Key-Value хранилище состояния для скриптов и парсеров в SQLite (beacon.state)."""

    def get(self, key: str, default: Any = None, strict: bool = False) -> Any:
        try:
            res = _request_json("GET", f"/kv/{urllib.parse.quote(str(key), safe='')}")
            if not res.get("found"):
                return default
            return res.get("value")
        except Exception as exc:
            if strict:
                raise
            _log_stderr(f"state.get('{key}') failed (returning default): {exc}")
            return default

    def set(self, key: str, value: Any, strict: bool = False) -> bool:
        try:
            res = _request_json("PUT", f"/kv/{urllib.parse.quote(str(key), safe='')}", {"value": value})
            return bool(res.get("ok", True))
        except Exception as exc:
            if strict:
                raise
            _log_stderr(f"state.set('{key}') failed (non-fatal): {exc}")
            return False

    def delete(self, key: str, strict: bool = False) -> bool:
        try:
            res = _request_json("DELETE", f"/kv/{urllib.parse.quote(str(key), safe='')}")
            return bool(res.get("ok", True))
        except Exception as exc:
            if strict:
                raise
            _log_stderr(f"state.delete('{key}') failed (non-fatal): {exc}")
            return False


state = _StateStore()
