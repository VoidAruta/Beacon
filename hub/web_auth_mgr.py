"""
Модуль аппаратного мониторинга датчиков питания и температуры (/sys/class/power_supply/battery),
проверки доступности прокси и проверки HTTP-сессий / куки.
Не содержит фейковых генераторов SVG или симуляции зарядки при отсутствии sysfs-датчиков.
"""

import json
import os
import platform
import socket
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from hub.compat import httpx
from hub.db import execute_sql, get_all_settings, log_audit, query_all, query_one
from hub.notifier import send_notification
from hub.secrets_mgr import import_cookie_editor_json

# Активные сессии проверки HTTP-ответа и заголовков Set-Cookie (по project_id)
ACTIVE_WEB_AUTH_SESSIONS: dict[int, dict[str, Any]] = {}

# Кулдауны уведомлений аппаратной защиты (чтобы не спамить в Telegram)
_LAST_HW_ALERT_TS: dict[str, float] = {
    "thermal_warn": 0.0,
    "thermal_crit": 0.0,
    "battery_low": 0.0,
}


def check_proxy_reachable(proxy_url: str, timeout: float = 0.4) -> dict[str, Any]:
    """Проверяет TCP-доступность локального прокси (например, 127.0.0.1:10808)."""
    if not proxy_url:
        return {"configured": False, "online": False, "host": "", "port": 0, "latency_ms": 0}
    try:
        parsed = urlparse(proxy_url if "://" in proxy_url else f"http://{proxy_url}")
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 10808
        t0 = time.monotonic()
        with socket.create_connection((host, port), timeout=timeout):
            latency = round((time.monotonic() - t0) * 1000, 1)
            return {
                "configured": True,
                "online": True,
                "host": host,
                "port": port,
                "latency_ms": latency,
            }
    except Exception:
        parsed = urlparse(proxy_url if "://" in proxy_url else f"http://{proxy_url}")
        return {
            "configured": True,
            "online": False,
            "host": parsed.hostname or "127.0.0.1",
            "port": parsed.port or 10808,
            "latency_ms": 0,
        }


def _read_zram_and_uptime() -> dict[str, Any]:
    """Читает реальную статистику ZRAM/Swap из /proc/meminfo и аптайм ядра из /proc/uptime."""
    swap_total_kb = 0
    swap_free_kb = 0
    try:
        meminfo = Path("/proc/meminfo")
        if meminfo.exists():
            for line in meminfo.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("SwapTotal:"):
                    swap_total_kb = int(line.split()[1])
                elif line.startswith("SwapFree:"):
                    swap_free_kb = int(line.split()[1])
    except Exception:
        pass
    swap_total_mb = round(swap_total_kb / 1024.0, 1)
    swap_used_mb = round(max(0, swap_total_kb - swap_free_kb) / 1024.0, 1)
    swap_percent = round((swap_used_mb / swap_total_mb) * 100.0, 1) if swap_total_mb > 0 else 0.0

    uptime_sec = 0
    try:
        up_file = Path("/proc/uptime")
        if up_file.exists():
            uptime_sec = int(float(up_file.read_text().split()[0]))
    except Exception:
        pass
    days = uptime_sec // 86400
    hours = (uptime_sec % 86400) // 3600
    mins = (uptime_sec % 3600) // 60
    uptime_human = f"{days}д {hours}ч {mins}м" if days > 0 else f"{hours}ч {mins}м"

    return {
        "swap_total_mb": swap_total_mb,
        "swap_used_mb": swap_used_mb,
        "swap_percent": swap_percent,
        "uptime_sec": uptime_sec,
        "uptime_human": uptime_human,
    }


def _detect_device_model() -> str:
    """Определяет реальную модель устройства из sysfs или /system/build.prop, иначе возвращает N/A."""
    dt_model = Path("/sys/firmware/devicetree/base/model")
    if dt_model.exists():
        try:
            raw = dt_model.read_bytes().replace(b"\x00", b"").decode("utf-8", errors="ignore").strip()
            if raw:
                return raw
        except Exception:
            pass

    build_prop = Path("/system/build.prop")
    if build_prop.exists():
        try:
            for line in build_prop.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("ro.product.model="):
                    val = line.split("=", 1)[1].strip()
                    if val:
                        return val
        except Exception:
            pass

    dmi_model = Path("/sys/devices/virtual/dmi/id/product_name")
    if dmi_model.exists():
        try:
            raw = dmi_model.read_text(encoding="utf-8", errors="ignore").strip()
            if raw:
                return raw
        except Exception:
            pass

    return "N/A"


def _read_cpu_temp_c() -> Optional[float]:
    """Читает реальную температуру CPU из /sys/class/thermal/thermal_zone*, иначе возвращает None."""
    try:
        thermal_base = Path("/sys/class/thermal")
        if thermal_base.exists():
            temps: list[float] = []
            for tz in thermal_base.glob("thermal_zone*"):
                t_file = tz / "temp"
                if t_file.exists():
                    val = int(t_file.read_text().strip())
                    c_val = val / 1000.0 if val > 1000 else float(val)
                    if 15.0 <= c_val <= 115.0:
                        temps.append(c_val)
            if temps:
                return round(max(temps), 1)
    except Exception:
        pass
    return None


def get_poco_hardware_status() -> dict[str, Any]:
    """
    Читает реальные датчики питания из /sys/class/power_supply/battery/*.
    Если датчиков батареи в системе нет — возвращает available: False и значения N/A / None
    (без фейковой симуляции зарядки и без хардкода модели).
    """
    settings = get_all_settings()
    min_target = int(settings.get("battery_limit_min", "45") or 45)
    max_target = int(settings.get("battery_limit_max", "55") or 55)
    alert_below = int(settings.get("battery_alert_below", "40") or 40)
    warn_temp_c = float(settings.get("battery_warn_temp_c", "43") or 43.0)
    crit_temp_c = float(settings.get("battery_crit_temp_c", "47") or 47.0)
    low_pct = int(settings.get("battery_low_pct", "20") or 20)
    thermal_auto_stop = str(settings.get("thermal_auto_stop", "1")) == "1"

    bat_cap_path = Path("/sys/class/power_supply/battery/capacity")
    bat_status_path = Path("/sys/class/power_supply/battery/status")
    bat_temp_path = Path("/sys/class/power_supply/battery/temp")
    bat_volt_path = Path("/sys/class/power_supply/battery/voltage_now")
    bat_curr_path = Path("/sys/class/power_supply/battery/current_now")
    bat_health_path = Path("/sys/class/power_supply/battery/health")
    usb_online_path = Path("/sys/class/power_supply/usb/online")
    ac_online_path = Path("/sys/class/power_supply/ac/online")

    is_real_sysfs = bat_cap_path.exists()
    sys_extra = _read_zram_and_uptime()
    cpu_temp_c = _read_cpu_temp_c()
    device_model = _detect_device_model()

    if not is_real_sysfs:
        return {
            "available": False,
            "is_real_sysfs": False,
            "device_model": device_model,
            "battery_percent": None,
            "raw_status": "N/A",
            "power_plugged": False,
            "voltage_mv": None,
            "current_ma": None,
            "battery_health": "N/A",
            "min_target_pct": min_target,
            "max_target_pct": max_target,
            "alert_below_pct": alert_below,
            "battery_low_pct": low_pct,
            "cycle_state": "unavailable",
            "cycle_label": "N/A (датчики батареи отсутствуют)",
            "should_alert": False,
            "battery_temp_c": None,
            "cpu_temp_c": cpu_temp_c,
            "battery_warn_temp_c": warn_temp_c,
            "battery_crit_temp_c": crit_temp_c,
            "thermal_auto_stop": thermal_auto_stop,
            "thermal_state": "unavailable",
            "thermal_warning": False,
            **sys_extra,
        }

    percent: Optional[int] = None
    raw_status = "N/A"
    bat_temp_c: Optional[float] = None
    voltage_mv: Optional[int] = None
    current_ma: Optional[int] = None
    battery_health = "N/A"
    plugged = False

    try:
        percent = int(bat_cap_path.read_text().strip())
    except Exception:
        percent = None
    try:
        if bat_status_path.exists():
            raw_status = bat_status_path.read_text().strip()
    except Exception:
        pass
    try:
        if bat_temp_path.exists():
            bat_temp_c = round(int(bat_temp_path.read_text().strip()) / 10.0, 1)
    except Exception:
        pass
    try:
        if bat_volt_path.exists():
            v_raw = int(bat_volt_path.read_text().strip())
            voltage_mv = v_raw // 1000 if v_raw > 10000 else v_raw
    except Exception:
        pass
    try:
        if bat_curr_path.exists():
            c_raw = int(bat_curr_path.read_text().strip())
            current_ma = c_raw // 1000 if abs(c_raw) > 10000 else c_raw
    except Exception:
        pass
    try:
        if bat_health_path.exists():
            battery_health = bat_health_path.read_text().strip()
    except Exception:
        pass
    try:
        plugged = (
            (usb_online_path.exists() and usb_online_path.read_text().strip() == "1")
            or (ac_online_path.exists() and ac_online_path.read_text().strip() == "1")
            or raw_status in ("Charging", "Full", "Not charging")
        )
    except Exception:
        plugged = False

    if percent is None:
        cycle_state = "unavailable"
        cycle_label = "N/A"
        should_alert = False
    elif percent <= low_pct:
        cycle_state = "critical_low"
        cycle_label = f"Критический разряд {percent}% (<= {low_pct}%)"
        should_alert = True
    elif percent < alert_below:
        cycle_state = "power_loss"
        cycle_label = f"Тревога: заряд {percent}% ниже порога {alert_below}%"
        should_alert = True
    elif raw_status == "Charging":
        cycle_state = "charging_to_target"
        cycle_label = f"Зарядка ({percent}%, коридор {min_target}–{max_target}%)"
        should_alert = False
    else:
        cycle_state = "cycle_ok"
        cycle_label = f"Удержание {min_target}–{max_target}% ({percent}%)"
        should_alert = False

    if bat_temp_c is not None and bat_temp_c >= crit_temp_c:
        thermal_state = "critical"
    elif (bat_temp_c is not None and bat_temp_c >= warn_temp_c) or (cpu_temp_c is not None and cpu_temp_c >= 65.0):
        thermal_state = "warning"
    else:
        thermal_state = "ok"

    return {
        "available": True,
        "is_real_sysfs": True,
        "device_model": device_model,
        "battery_percent": percent,
        "raw_status": raw_status,
        "power_plugged": plugged,
        "voltage_mv": voltage_mv,
        "current_ma": current_ma,
        "battery_health": battery_health,
        "min_target_pct": min_target,
        "max_target_pct": max_target,
        "alert_below_pct": alert_below,
        "battery_low_pct": low_pct,
        "cycle_state": cycle_state,
        "cycle_label": cycle_label,
        "should_alert": should_alert,
        "battery_temp_c": bat_temp_c,
        "cpu_temp_c": cpu_temp_c,
        "battery_warn_temp_c": warn_temp_c,
        "battery_crit_temp_c": crit_temp_c,
        "thermal_auto_stop": thermal_auto_stop,
        "thermal_state": thermal_state,
        "thermal_warning": thermal_state in ("warning", "critical"),
        **sys_extra,
    }


async def check_android_hardware_guard(
    force_temp_c: Optional[float] = None,
    force_percent: Optional[int] = None,
) -> dict[str, Any]:
    """
    Периодический сторож батареи и температуры:
    - Если датчики батареи отсутствуют (available=False) и не переданы force_temp_c/force_percent, ничего не делает.
    - При температуре батареи >= battery_warn_temp_c (43°C) — предупреждение.
    - При температуре батареи >= battery_crit_temp_c (47°C) — остановка некритичных задач.
    """
    from hub.process_mgr import stop_run

    hw = get_poco_hardware_status()
    is_manual_test = force_temp_c is not None or force_percent is not None

    if not hw.get("available") and not is_manual_test:
        return {
            "ok": True,
            "available": False,
            "battery_temp_c": None,
            "battery_percent": None,
            "warn_temp_c": hw["battery_warn_temp_c"],
            "crit_temp_c": hw["battery_crit_temp_c"],
            "stopped_projects": [],
            "actions_taken": [],
        }

    bat_temp = float(force_temp_c) if force_temp_c is not None else (
        float(hw["battery_temp_c"]) if hw.get("battery_temp_c") is not None else 0.0
    )
    bat_pct = int(force_percent) if force_percent is not None else (
        int(hw["battery_percent"]) if hw.get("battery_percent") is not None else 100
    )
    warn_temp = float(hw["battery_warn_temp_c"])
    crit_temp = float(hw["battery_crit_temp_c"])
    low_pct = int(hw["battery_low_pct"])
    auto_stop = bool(hw["thermal_auto_stop"])

    now = time.time()
    stopped_projects: list[str] = []
    actions_taken: list[str] = []

    if bat_temp >= crit_temp:
        if auto_stop:
            active_runs = query_all(
                """SELECT r.id AS run_id, r.project_id, p.name, p.type, p.env_json
                   FROM runs r
                   JOIN projects p ON p.id = r.project_id
                   WHERE r.status IN ('running', 'waiting_input')"""
            )
            for r in active_runs:
                try:
                    env_dict = json.loads(r.get("env_json") or "{}")
                except Exception:
                    env_dict = {}
                if str(env_dict.get("CRITICAL_SERVICE", "0")) == "1":
                    continue
                if r["type"] == "service":
                    execute_sql(
                        "UPDATE projects SET desired_state = 'stopped', updated_at = ? WHERE id = ?",
                        (int(now), r["project_id"]),
                    )
                await stop_run(int(r["run_id"]), final_status="stopped", reason_note=f"Остановлено термозащитой ({bat_temp}°C)")
                stopped_projects.append(str(r["name"]))

        if stopped_projects:
            log_audit(
                "127.0.0.1",
                "THERMAL_THROTTLE_STOP",
                f"Батарея {bat_temp}°C >= {crit_temp}°C. Остановлены проекты: {', '.join(stopped_projects)}",
            )
            actions_taken.append(f"stopped:{','.join(stopped_projects)}")

        if is_manual_test or (now - _LAST_HW_ALERT_TS["thermal_crit"] > 900):
            _LAST_HW_ALERT_TS["thermal_crit"] = now
            stopped_note = (
                f" Автоматически остановлены проекты: {', '.join(stopped_projects)}."
                if stopped_projects
                else " Активных некритичных задач для остановки не было."
            )
            await send_notification(
                f"КРИТИЧЕСКИЙ ПЕРЕГРЕВ: батарея {bat_temp}°C (порог {crit_temp}°C)!{stopped_note}",
                level="error",
            )
            actions_taken.append("notified_thermal_crit")

    elif bat_temp >= warn_temp:
        if is_manual_test or (now - _LAST_HW_ALERT_TS["thermal_warn"] > 900):
            _LAST_HW_ALERT_TS["thermal_warn"] = now
            await send_notification(
                f"Нагрев батареи: {bat_temp}°C (порог предупреждения {warn_temp}°C, критический {crit_temp}°C).",
                level="warn",
            )
            actions_taken.append("notified_thermal_warn")

    if bat_pct <= low_pct and (is_manual_test or hw.get("raw_status") != "Charging"):
        if is_manual_test or (now - _LAST_HW_ALERT_TS["battery_low"] > 900):
            _LAST_HW_ALERT_TS["battery_low"] = now
            await send_notification(
                f"КРИТИЧЕСКИЙ РАЗРЯД БАТАРЕИ: {bat_pct}% (<= {low_pct}%).",
                level="error",
            )
            actions_taken.append("notified_battery_low")

    return {
        "ok": True,
        "available": bool(hw.get("available") or is_manual_test),
        "battery_temp_c": bat_temp,
        "battery_percent": bat_pct,
        "warn_temp_c": warn_temp,
        "crit_temp_c": crit_temp,
        "stopped_projects": stopped_projects,
        "actions_taken": actions_taken,
    }


async def start_web_auth_session(
    project_id: int,
    target_url: str,
    proxy_mode: str = "system",
    custom_proxy: str = "",
) -> dict[str, Any]:
    """
    Выполняет реальный HTTP-запрос к целевому URL (с учётом прокси) и собирает настоящие Set-Cookie,
    возвращённые сервером. Никакие фейковые куки или SVG-картинки не генерируются.
    """
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise ValueError("Проект не найден")

    clean_url = (target_url or "").strip()
    if not clean_url:
        raise ValueError("Укажите целевой URL")
    if not clean_url.startswith(("http://", "https://")):
        clean_url = f"https://{clean_url}"

    parsed_url = urlparse(clean_url)
    domain = parsed_url.hostname or "localhost"

    settings = get_all_settings()
    sys_proxy = settings.get("proxy_url", "").strip()

    if proxy_mode == "custom" and custom_proxy.strip():
        active_proxy: Optional[str] = custom_proxy.strip()
    elif proxy_mode == "none" or not sys_proxy:
        active_proxy = None
    else:
        reach = check_proxy_reachable(sys_proxy)
        active_proxy = sys_proxy if reach["online"] else None

    fetched_cookies: list[dict[str, Any]] = []
    page_title = domain
    http_status = 0
    error_note = ""
    ua = f"HubHTTPProbe/1.0 ({platform.system()}; {platform.machine()})"

    try:
        async with httpx.AsyncClient(
            proxy=active_proxy,
            timeout=8.0,
            follow_redirects=True,
            headers={"User-Agent": ua},
        ) as client:
            resp = await client.get(clean_url)
            http_status = resp.status_code
            for c_name, c_val in resp.cookies.items():
                fetched_cookies.append(
                    {
                        "domain": f".{domain}",
                        "name": c_name,
                        "value": c_val,
                        "path": "/",
                        "httpOnly": True,
                        "secure": clean_url.startswith("https"),
                    }
                )
            text_sample = resp.text[:4096]
            if "<title>" in text_sample.lower():
                low = text_sample.lower()
                s_idx = low.find("<title>") + 7
                e_idx = low.find("</title>", s_idx)
                if e_idx > s_idx:
                    page_title = text_sample[s_idx:e_idx].strip()[:80] or page_title
    except Exception as e:
        error_note = str(e)

    session_data: dict[str, Any] = {
        "project_id": project_id,
        "project_name": proj["name"],
        "current_url": clean_url,
        "domain": domain,
        "page_title": page_title,
        "http_status": http_status,
        "proxy_mode": proxy_mode,
        "proxy_used": active_proxy or "Без прокси",
        "user_agent": ua,
        "cookies": fetched_cookies,
        "local_storage": {},
        "started_at": int(time.time()),
        "error": error_note,
        "last_action": (
            f"HTTP {http_status}: получено {len(fetched_cookies)} Set-Cookie с {domain}"
            if http_status
            else f"Ошибка подключения к {domain}: {error_note}"
        ),
    }
    ACTIVE_WEB_AUTH_SESSIONS[project_id] = session_data
    return session_data


async def perform_web_auth_action(project_id: int, action_payload: dict[str, Any]) -> dict[str, Any]:
    """
    Обновляет активную HTTP-сессию проекта (переход по новому URL или добавление реальных куки).
    """
    session = ACTIVE_WEB_AUTH_SESSIONS.get(project_id)
    if not session:
        raise ValueError("Сессия не запущена.")

    act = str(action_payload.get("action", "")).strip()
    if act == "navigate":
        new_url = str(action_payload.get("url", "")).strip()
        if not new_url:
            raise ValueError("Не указан URL для перехода")
        return await start_web_auth_session(
            project_id,
            new_url,
            proxy_mode=session.get("proxy_mode", "system"),
        )
    elif act == "set_cookies":
        raw_cookies = action_payload.get("cookies", [])
        if isinstance(raw_cookies, list):
            session["cookies"] = raw_cookies
            session["last_action"] = f"Обновлен список куки ({len(raw_cookies)} шт.)"
        return session

    raise ValueError(f"Неподдерживаемое действие: {act}. Используйте импорт JSON из Cookie-Editor.")


async def save_and_close_web_auth_session(project_id: int) -> dict[str, Any]:
    """Сохраняет собранные реальные куки в секрет <project_name>_cookies (0600) и закрывает сессию."""
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not proj:
        raise ValueError("Проект не найден")

    session = ACTIVE_WEB_AUTH_SESSIONS.pop(project_id, None)
    if not session:
        raise ValueError("Нет активной сессии для сохранения")

    cookies_list = session.get("cookies", [])
    if not cookies_list:
        raise ValueError("В сессии нет полученных куки для сохранения. Импортируйте JSON из Cookie-Editor.")

    cookies_raw = json.dumps(cookies_list, indent=2, ensure_ascii=False)
    secret_name = f"{proj['name']}_cookies"
    saved_secret = import_cookie_editor_json(secret_name, cookies_raw)

    try:
        curr_secrets: list[str] = json.loads(proj.get("secrets_json") or "[]")
    except Exception:
        curr_secrets = []
    if secret_name not in curr_secrets:
        curr_secrets.append(secret_name)
        execute_sql(
            "UPDATE projects SET secrets_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(curr_secrets, ensure_ascii=False), int(time.time()), project_id),
        )

    workdir = Path(proj["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    cookies_file = workdir / "cookies.json"
    cookies_file.write_text(cookies_raw, encoding="utf-8")
    try:
        os.chmod(cookies_file, 0o600)
    except OSError:
        pass

    return {
        "ok": True,
        "secret_name": secret_name,
        "cookies_count": len(cookies_list),
        "secret": saved_secret,
    }


def cancel_web_auth_session(project_id: int) -> dict[str, Any]:
    ACTIVE_WEB_AUTH_SESSIONS.pop(project_id, None)
    return {"ok": True, "closed": True}
