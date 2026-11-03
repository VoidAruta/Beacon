"""
Адаптивное определение среды запуска Hub (hub/env_detect.py):
1. Android Linux Chroot / Termux (aarch64, root, aid_inet=3003, датчики /sys/class/power_supply/battery, без systemd)
2. Полноценный Linux-сервер / VPS / Мини-ПК / Raspberry Pi (с systemd или без него)
3. Контейнерная среда (LXC / Docker / Cloud Run preview)
"""

import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any


def get_environment_profile() -> dict[str, Any]:
    """
    Возвращает полный профиль текущей операционной среды:
    - is_android_chroot: bool
    - is_container: bool
    - has_systemd: bool
    - has_battery: bool
    - has_uv: bool
    - uv_bin: str
    - arch: str
    - kernel: str
    - env_mode: 'android_chroot' | 'linux_systemd' | 'linux_container' | 'linux_host'
    - env_label: человекочитаемое описание среды
    """
    arch = platform.machine() or "unknown"
    try:
        kernel = os.uname().release
    except Exception:
        kernel = ""

    has_battery = Path("/sys/class/power_supply/battery/capacity").exists()
    has_systemd = Path("/run/systemd/system").exists()

    has_aid_inet = False
    try:
        if 3003 in os.getgroups():
            has_aid_inet = True
        elif Path("/etc/group").exists():
            grp_txt = Path("/etc/group").read_text(encoding="utf-8", errors="ignore")
            if ":3003:" in grp_txt or "aid_inet" in grp_txt:
                has_aid_inet = True
    except Exception:
        pass

    is_android_kernel = "android" in kernel.lower() or Path("/system/build.prop").exists()
    is_android_chroot = bool(has_battery or is_android_kernel or has_aid_inet)

    is_container = False
    if Path("/.dockerenv").exists() or Path("/run/.containerenv").exists():
        is_container = True
    else:
        try:
            cg = Path("/proc/1/cgroup")
            if cg.exists():
                cg_txt = cg.read_text(encoding="utf-8", errors="ignore").lower()
                if any(k in cg_txt for k in ("docker", "lxc", "kubepods", "containerd", "sandbox")):
                    is_container = True
        except Exception:
            pass

    uv_bin = shutil.which("uv") or ""
    has_uv = bool(uv_bin)

    if is_android_chroot:
        env_mode = "android_chroot"
        env_label = f"Android Linux Chroot ({arch})"
    elif has_systemd and not is_container:
        env_mode = "linux_systemd"
        env_label = f"Linux Systemd Server ({arch})"
    elif is_container:
        env_mode = "linux_container"
        env_label = f"Linux Container ({arch})"
    else:
        env_mode = "linux_host"
        env_label = f"Linux Host ({arch})"

    return {
        "env_mode": env_mode,
        "env_label": env_label,
        "arch": arch,
        "kernel": kernel,
        "is_android_chroot": is_android_chroot,
        "is_container": is_container,
        "has_systemd": has_systemd,
        "has_battery": has_battery,
        "has_aid_inet": has_aid_inet,
        "has_uv": has_uv,
        "uv_bin": uv_bin,
        "python_executable": sys.executable or "python3",
    }


def generate_systemd_unit(base_dir: Path | None = None, port: int = 8050, user: str = "root") -> str:
    """
    Генерирует готовый unit-файл systemd (hub.service) для стационарных Linux-серверов и VPS
    (вызывается командой `python3 -m hub systemd`).
    """
    from hub.config import BASE_DIR

    resolved_base = Path(base_dir) if base_dir is not None else BASE_DIR
    py_exec = shutil.which("python3") or sys.executable or "/usr/bin/python3"
    venv_py = resolved_base / ".venv" / "bin" / "python"
    if venv_py.exists():
        py_exec = str(venv_py)
    base_dir = resolved_base

    return f"""[Unit]
Description=Hub Control Panel (Lightweight Operations Console & Containerless PaaS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={user}
WorkingDirectory={base_dir}
Environment="HUB_DIR={base_dir}"
Environment="HUB_PORT={port}"
Environment="PYTHONUNBUFFERED=1"
ExecStart={py_exec} -m hub
Restart=always
RestartSec=3
KillMode=process
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
"""
