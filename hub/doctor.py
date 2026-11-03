"""
Адаптивная самодиагностика окружения Hub (`python3 -m hub doctor` и `GET /api/system/doctor`).
Одинаково корректно работает в двух средах:
1. Android Linux Chroot / Termux (aarch64, GID 3003/3004, датчики батареи /sys/class/power_supply/battery)
2. Полноценный Linux-сервер / VPS / Контейнер (x86_64 / aarch64, systemd или без него, стационарное питание)
"""

import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from hub.auth import get_internal_token
from hub.compat import psutil
from hub.config import BASE_DIR, DATA_DIR, INTERNAL_TOKEN_PATH, SECRETS_DIR, ensure_directories
from hub.db import checkpoint_wal, db_session, get_all_settings
from hub.disk_guard import get_disk_status
from hub.env_detect import get_environment_profile
from hub.web_auth_mgr import check_proxy_reachable, get_poco_hardware_status


def _check_cmd_version(cmd: list[str]) -> str:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        if res.returncode == 0:
            out = (res.stdout or res.stderr or "").strip().splitlines()
            return out[0].strip() if out else "OK"
    except Exception:
        pass
    return ""


def run_hub_doctor(auto_fix_perms: bool = True) -> dict[str, Any]:
    """Выполняет полную адаптивную диагностику окружения (Android Chroot или Linux Server/Container)."""
    t0 = time.monotonic()
    ensure_directories()
    get_internal_token()
    settings = get_all_settings()
    env_prof = get_environment_profile()
    is_android = bool(env_prof.get("is_android_chroot"))

    checks: list[dict[str, Any]] = []

    # 1. Профиль среды и сетевые привилегии (Android GID 3003/3004 vs Linux Network Stack)
    proc_groups = set()
    try:
        proc_groups = set(os.getgroups())
    except Exception:
        pass

    etc_group_gids: set[int] = set()
    try:
        grp_path = Path("/etc/group")
        if grp_path.exists():
            for line in grp_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                parts = line.split(":")
                if len(parts) >= 3 and parts[2].isdigit():
                    etc_group_gids.add(int(parts[2]))
    except Exception:
        pass

    has_3003 = (3003 in proc_groups) or (3003 in etc_group_gids)
    has_3004 = (3004 in proc_groups) or (3004 in etc_group_gids)

    if is_android:
        if has_3003 and has_3004:
            grp_status = "ok"
            grp_summary = "Среда Android Chroot: группы GID 3003 (aid_inet) и 3004 (aid_net_raw) активны."
        else:
            grp_status = "warn"
            grp_summary = (
                "Среда Android Chroot: в /etc/group не найдены GID 3003/3004. "
                "При запуске от root Hub автоматически передаёт GID 3003/3004 через os.setgroups."
            )
    else:
        grp_status = "ok"
        grp_summary = (
            f"Определена среда {env_prof['env_label']} (ядро {env_prof['kernel']}). "
            "Стандартный сетевой стек Linux активен, группы Android aid_inet не требуются."
        )

    checks.append(
        {
            "id": "android_groups",
            "title": "Профиль ОС и сетевой стек (Linux / Android Chroot)",
            "status": grp_status,
            "summary": grp_summary,
            "fix_hint": (
                "groupadd -g 3003 aid_inet && groupadd -g 3004 aid_net_raw"
                if is_android
                else "Для автозапуска на Linux с systemd выполните: python3 -m hub systemd"
            ),
            "details": {
                "env_mode": env_prof["env_mode"],
                "env_label": env_prof["env_label"],
                "is_android_chroot": is_android,
                "has_systemd": env_prof["has_systemd"],
                "process_gids": sorted(list(proc_groups)),
                "gid_3003_present": has_3003,
                "gid_3004_present": has_3004,
            },
        }
    )

    # 2. Системные файловые системы (/proc, /sys, /dev/pts)
    proc_ok = Path("/proc/stat").exists() and Path("/proc/meminfo").exists()
    sys_ok = Path("/sys/class").exists()
    pts_ok = Path("/dev/pts").exists()
    mounts_ok = proc_ok and sys_ok and pts_ok
    checks.append(
        {
            "id": "chroot_mounts",
            "title": "Системные файловые системы (/proc, /sys, /dev/pts)",
            "status": "ok" if mounts_ok else "error",
            "summary": (
                "Все системные файловые системы (/proc, /sys, /dev/pts) смонтированы и доступны для телеметрии процессов."
                if mounts_ok
                else f"Отсутствуют точки монтирования: /proc={proc_ok}, /sys={sys_ok}, /dev/pts={pts_ok}."
            ),
            "fix_hint": "mount -t proc proc /proc && mount -t sysfs sys /sys && mount -t devpts devpts /dev/pts",
            "details": {"proc": proc_ok, "sys": sys_ok, "dev_pts": pts_ok},
        }
    )

    # 3. Права доступа к директориям, секретам и internal.token
    fixed_perms = 0
    perm_errors: list[str] = []
    for d_path in (DATA_DIR, SECRETS_DIR):
        try:
            mode = d_path.stat().st_mode & 0o777
            if mode != 0o700:
                if auto_fix_perms:
                    os.chmod(d_path, 0o700)
                    fixed_perms += 1
                else:
                    perm_errors.append(f"{d_path.name}: {oct(mode)} != 0o700")
        except OSError as e:
            perm_errors.append(str(e))

    secret_files = list(SECRETS_DIR.iterdir()) if SECRETS_DIR.exists() else []
    if INTERNAL_TOKEN_PATH.exists():
        secret_files.append(INTERNAL_TOKEN_PATH)

    for f_path in secret_files:
        if not f_path.is_file():
            continue
        try:
            mode = f_path.stat().st_mode & 0o777
            if mode != 0o600:
                if auto_fix_perms:
                    os.chmod(f_path, 0o600)
                    fixed_perms += 1
                else:
                    perm_errors.append(f"{f_path.name}: {oct(mode)} != 0o600")
        except OSError as e:
            perm_errors.append(str(e))

    sec_status = "error" if perm_errors else "ok"
    sec_summary = (
        f"Права 0700 (data, secrets) и 0600 ({len(secret_files)} файлов) верифицированы"
        + (f" (автоматически исправлено: {fixed_perms})." if fixed_perms else ".")
    )

    checks.append(
        {
            "id": "security_permissions",
            "title": "Права доступа к хранилищу секретов (0700 / 0600)",
            "status": sec_status,
            "summary": sec_summary,
            "fix_hint": "chmod 700 data data/secrets && chmod 600 data/internal.token data/secrets/*",
            "details": {
                "checked_files": len(secret_files),
                "auto_fixed_count": fixed_perms,
            },
        }
    )

    # 4. Целостность SQLite WAL, размер hub.db-wal и таблица project_kv
    wal_info = checkpoint_wal(truncate_threshold_mb=4.0)
    journal_mode = "unknown"
    integrity = "unknown"
    has_kv_table = False
    try:
        with db_session() as conn:
            jm_row = conn.execute("PRAGMA journal_mode;").fetchone()
            ic_row = conn.execute("PRAGMA quick_check;").fetchone()
            kv_row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='project_kv'").fetchone()
            journal_mode = str(jm_row[0]).lower() if jm_row else "unknown"
            integrity = str(ic_row[0]) if ic_row else "unknown"
            has_kv_table = kv_row is not None
    except Exception as e:
        integrity = f"error: {e}"

    db_ok = journal_mode == "wal" and integrity.lower() == "ok" and has_kv_table
    checks.append(
        {
            "id": "sqlite_wal",
            "title": "База данных SQLite (WAL + хранилище состояния project_kv)",
            "status": "ok" if db_ok else "error",
            "summary": (
                f"Режим {journal_mode.upper()}, quick_check={integrity}, project_kv={'OK' if has_kv_table else 'missing'}, "
                f"размер WAL после чекпоинта ({wal_info['mode']}): {wal_info['wal_size_after_kb']} КБ."
            ),
            "fix_hint": "sqlite3 data/hub.db 'PRAGMA wal_checkpoint(TRUNCATE);'",
            "details": {
                "journal_mode": journal_mode,
                "quick_check": integrity,
                "project_kv_ready": has_kv_table,
                **wal_info,
            },
        }
    )

    # 5. Доступность локального прокси 127.0.0.1:10808
    proxy_url = settings.get("proxy_url", "http://127.0.0.1:10808")
    proxy_st = check_proxy_reachable(proxy_url, timeout=0.4)
    checks.append(
        {
            "id": "proxy_bridge",
            "title": f"Локальный прокси-туннель ({proxy_url or 'не задан'})",
            "status": "ok" if proxy_st["online"] else "warn",
            "summary": (
                f"Прокси {proxy_st['host']}:{proxy_st['port']} доступен (задержка {proxy_st['latency_ms']} мс)."
                if proxy_st["online"]
                else f"Прокси {proxy_st['host']}:{proxy_st['port']} сейчас офлайн (проекты без use_proxy работают напрямую)."
            ),
            "fix_hint": "При необходимости проксирования запустите локальный туннель (xray/sing-box/v2ray) на порту 10808.",
            "details": proxy_st,
        }
    )

    # 6. Наличие и версии рантаймов и изоляции окружений (python3, uv, venv, git, node, bash)
    py_ver = _check_cmd_version(["python3", "--version"])
    uv_ver = _check_cmd_version(["uv", "--version"]) if env_prof["has_uv"] else ""
    git_ver = _check_cmd_version(["git", "--version"])
    node_ver = _check_cmd_version(["node", "--version"])
    bash_ver = _check_cmd_version(["bash", "--version"])
    runtimes_ok = bool(py_ver and git_ver and bash_ver)
    checks.append(
        {
            "id": "runtimes_and_tools",
            "title": "Рантаймы и изоляция окружений (Python .venv / uv, Node.js, Git, Bash)",
            "status": "ok" if runtimes_ok else "warn",
            "summary": (
                f"Python: {py_ver or 'нет'} · Менеджер пакетов: {uv_ver or 'python3 -m venv + pip'} · "
                f"Node: {node_ver or 'опционально'} · Git: {git_ver or 'нет'}"
            ),
            "fix_hint": "apt update && apt install -y python3 python3-venv python3-pip git nodejs bash curl",
            "details": {
                "python3": py_ver,
                "uv": uv_ver,
                "has_uv": env_prof["has_uv"],
                "git": git_ver,
                "node": node_ver,
                "bash": bool(bash_ver),
            },
        }
    )

    # 7. Бюджет ОЗУ самого Hub (< 80 МБ) и свободное место на диске
    hub_proc = psutil.Process(os.getpid())
    hub_rss_mb = round(hub_proc.memory_info().rss / (1024 * 1024), 1)
    disk_st = get_disk_status()
    ram_ok = hub_rss_mb < 80.0
    res_status = "ok" if (ram_ok and disk_st["state"] == "ok") else ("error" if disk_st["state"] == "critical" else "warn")
    checks.append(
        {
            "id": "ram_and_disk_budget",
            "title": "Бюджет ОЗУ панели Hub (< 80 МБ) и свободное место на диске",
            "status": res_status,
            "summary": (
                f"Потребление Hub RSS: {hub_rss_mb} МБ (лимит 80 МБ). Свободно на диске: {disk_st['free_mb']} МБ из {disk_st['total_mb']} МБ."
            ),
            "fix_hint": "Используйте кнопку «Очистить кэш pip/uv/npm, .tmp и старые логи» в Настройках при нехватке места.",
            "details": {
                "hub_rss_mb": hub_rss_mb,
                "hub_rss_budget_mb": 80.0,
                "disk_free_mb": disk_st["free_mb"],
                "disk_state": disk_st["state"],
            },
        }
    )

    # 8. Аппаратные датчики питания и температуры (адаптивно: Android sysfs vs стационарный Linux)
    hw = get_poco_hardware_status()
    if hw.get("available"):
        hw_status = "ok"
        if hw["thermal_state"] == "critical" or hw["cycle_state"] == "critical_low":
            hw_status = "error"
        elif hw["thermal_state"] == "warning" or hw["should_alert"]:
            hw_status = "warn"
        hw_summary = (
            f"Батарея: {hw['battery_percent']}% ({hw['raw_status']}), "
            f"T° батареи: {hw['battery_temp_c']}°C, CPU: {hw['cpu_temp_c']}°C, "
            f"Swap: {hw['swap_used_mb']}/{hw['swap_total_mb']} МБ."
        )
    else:
        hw_status = "ok"
        hw_summary = (
            f"Стационарное питание ({env_prof['env_label']}): датчики батареи отсутствуют (available=false). "
            f"Swap: {hw['swap_used_mb']}/{hw['swap_total_mb']} МБ, аптайм: {hw['uptime_human']}."
        )

    checks.append(
        {
            "id": "android_battery_thermal",
            "title": "Датчики питания и термомониторинг (Адаптивный режим)",
            "status": hw_status,
            "summary": hw_summary,
            "fix_hint": "На смартфонах с root при нагреве >= 47°C Hub автоматически останавливает некритичные проекты.",
            "details": hw,
        }
    )

    ok_count = sum(1 for c in checks if c["status"] == "ok")
    warn_count = sum(1 for c in checks if c["status"] == "warn")
    err_count = sum(1 for c in checks if c["status"] == "error")
    overall = "error" if err_count > 0 else ("warn" if warn_count > 0 else "ok")

    return {
        "ok": err_count == 0,
        "overall_status": overall,
        "ok_count": ok_count,
        "warn_count": warn_count,
        "error_count": err_count,
        "total_checks": len(checks),
        "duration_ms": round((time.monotonic() - t0) * 1000, 1),
        "timestamp": int(time.time()),
        "base_dir": str(BASE_DIR),
        "env_profile": env_prof,
        "checks": checks,
    }


def print_doctor_cli(report: dict[str, Any]) -> int:
    """Форматированный вывод результата `python3 -m hub doctor` в терминал."""
    icons = {"ok": "[ OK ]", "warn": "[WARN]", "error": "[FAIL]"}
    env_label = report.get("env_profile", {}).get("env_label", "Linux")
    print("=" * 78)
    print(f"  HUB DOCTOR · Самодиагностика окружения [{env_label}] ({report['duration_ms']} мс)")
    print(f"  Рабочая директория: {report['base_dir']}")
    print("=" * 78)
    for chk in report["checks"]:
        badge = icons.get(chk["status"], "[INFO]")
        print(f"{badge} {chk['title']}")
        print(f"       {chk['summary']}")
        if chk["status"] != "ok" and chk.get("fix_hint"):
            print(f"       Подсказка: {chk['fix_hint']}")
        print("-" * 78)
    print(
        f"ИТОГ: Успешно: {report['ok_count']} | Предупреждений: {report['warn_count']} | Ошибок: {report['error_count']}"
    )
    print("=" * 78)
    return 0 if report["error_count"] == 0 else 1
