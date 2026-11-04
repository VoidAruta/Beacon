"""
Beacon Python SDK (/opt/beacon/sdk/python/beacon.py и /opt/hub/sdk/python/beacon.py)
Автоматически подключается через PYTHONPATH.
Поддерживает:
  - beacon.notify(text, level="info")
  - beacon.secret(name, as_path=False)
  - beacon.cookies_expired(secret_name, note="")
  - beacon.ask(prompt, timeout=300)
  - beacon.state.get(key, default=None) / beacon.state.set(key, val) / beacon.state.delete(key)
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get_api_config() -> tuple[str, str, str]:
    api_url = (
        os.environ.get("BEACON_API_URL")
        or os.environ.get("ARUTA_API_URL")
        or os.environ.get("HUB_API_URL")
        or "http://127.0.0.1:8050/internal"
    ).rstrip("/")
    run_token = (
        os.environ.get("BEACON_RUN_TOKEN")
        or os.environ.get("ARUTA_RUN_TOKEN")
        or os.environ.get("HUB_RUN_TOKEN")
        or ""
    )
    internal_token = (
        os.environ.get("BEACON_INTERNAL_TOKEN")
        or os.environ.get("ARUTA_INTERNAL_TOKEN")
        or os.environ.get("HUB_INTERNAL_TOKEN")
        or ""
    )
    return api_url, run_token, internal_token


def _request_json(
    method: str,
    path: str,
    payload: Optional[dict[str, Any]] = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    api_url, run_token, internal_token = _get_api_config()
    url = f"{api_url}/{path.lstrip('/')}"
    headers = {
        "X-Beacon-Token": run_token,
        "X-Aruta-Token": run_token,
        "X-Hub-Token": run_token,
        "Accept": "application/json",
    }
    if internal_token:
        headers["X-Beacon-Internal-Token"] = internal_token
        headers["X-Aruta-Internal-Token"] = internal_token
        headers["X-Hub-Internal-Token"] = internal_token
    data_bytes = None
    if payload is not None:
        data_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method.upper())
    try:
        with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Beacon API HTTP {e.code} on {path}: {err_body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Beacon API connection error on {path}: {e}") from e


def notify(text: str, level: str = "info") -> bool:
    """
    Отправляет уведомление от имени текущего проекта в настроенные каналы (Telegram, ntfy, Webhook).
    level: 'info' | 'warn' | 'error'
    """
    res = _request_json("POST", "/notify", {"text": str(text), "level": str(level)})
    return bool(res.get("ok", True))


def secret(name: str, as_path: bool = False) -> Any:
    """
    Возвращает значение секрета по имени.
    - Если тип секрета 'cookie_json', возвращает распарсенный список словарей (list[dict]).
    - Если тип секрета 'text', возвращает строку.
    - Если тип секрета 'file' или передан as_path=True, возвращает путь к файлу секрета.
    """
    try:
        res = _request_json("GET", f"/secret/{urllib.parse.quote(name)}")
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

        return val
    except Exception:
        env_file = (
            os.environ.get(f"BEACON_SECRET_FILE_{name}")
            or os.environ.get(f"ARUTA_SECRET_FILE_{name}")
            or os.environ.get(f"HUB_SECRET_FILE_{name}")
        )
        if as_path and env_file:
            return env_file
        if env_file and os.path.exists(env_file):
            with open(env_file, "r", encoding="utf-8") as f:
                content = f.read()
                try:
                    return json.loads(content)
                except Exception:
                    return content
        raise


def cookies_expired(secret_name: str, note: str = "Куки устарели, требуется обновление") -> bool:
    """
    Помечает секрет с куки как истёкший (is_expired = 1), зажигает красный тревожный баннер в UI
    и отправляет срочное уведомление в Telegram.
    """
    res = _request_json(
        "POST",
        "/cookies_expired",
        {"secret_name": str(secret_name), "note": str(note)},
    )
    return bool(res.get("ok", True))


def ask(prompt: str, timeout: int = 300) -> str:
    """
    Блокирующий интерактивный запрос ввода от пользователя (через веб-панель или Reply в Telegram).
    Переводит текущий запуск в статус 'waiting_input' и ждёт ответа до timeout секунд.
    """
    create_res = _request_json(
        "POST",
        "/ask/create",
        {"prompt": str(prompt), "timeout": int(timeout)},
    )
    ask_id = create_res.get("ask_id")
    if not ask_id:
        raise RuntimeError(f"Не удалось создать запрос beacon.ask: {create_res}")

    deadline = time.time() + int(timeout) + 5
    while time.time() < deadline:
        try:
            poll_res = _request_json("GET", f"/ask/poll/{ask_id}", timeout=15.0)
        except Exception:
            time.sleep(1.0)
            continue

        status = poll_res.get("status")
        if status == "answered":
            return str(poll_res.get("answer", ""))
        if status in ("timeout", "cancelled"):
            raise TimeoutError(f"Запрос beacon.ask('{prompt}') завершился со статусом: {status}")

        time.sleep(0.3)

    raise TimeoutError(f"Превышено время ожидания ответа на beacon.ask('{prompt}')")


class _StateStore:
    """Персистентное Key-Value хранилище состояния для скриптов и парсеров в SQLite (beacon.state)."""

    def get(self, key: str, default: Any = None) -> Any:
        res = _request_json("GET", f"/kv/{urllib.parse.quote(str(key))}")
        if not res.get("found"):
            return default
        return res.get("value")

    def set(self, key: str, value: Any) -> bool:
        res = _request_json("PUT", f"/kv/{urllib.parse.quote(str(key))}", {"value": value})
        return bool(res.get("ok", True))

    def delete(self, key: str) -> bool:
        res = _request_json("DELETE", f"/kv/{urllib.parse.quote(str(key))}")
        return bool(res.get("ok", True))


state = _StateStore()
