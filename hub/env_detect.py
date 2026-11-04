"""
Адаптивное определение среды запуска Aruta / Hub (hub/env_detect.py):
Поддерживает три основных профиля:
1. android_chroot — Android Linux Chroot / Termux (aarch64, root, aid_inet=3003, датчики батареи, без systemd)
2. systemd_linux — Полноценный Linux-сервер / VPS / Мини-ПК / Raspberry Pi (systemd + cgroups v2)
3. container — Контейнерная среда (Docker / LXC / Cloud Run preview, без systemd и датчиков батареи)
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
    - env_mode: 'android_chroot' | 'systemd_linux' | 'container'
    - is_android_chroot: bool
    - is_container: bool
    - has_systemd: bool
    - has_cgroups_v2: bool
    - has_battery: bool
    - has_uv: bool
    - uv_bin: str
    - arch: str
    - kernel: str
    - env_label: человекочитаемое описание среды
    """
    arch = platform.machine() or "unknown"
    try:
        kernel = os.uname().release
    except Exception:
        kernel = ""

    has_battery = Path("/sys/class/power_supply/battery/capacity").exists()
    has_systemd = Path("/run/systemd/system").exists()
    has_cgroups_v2 = Path("/sys/fs/cgroup/cgroup.controllers").exists()

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
    is_android_chroot = bool(has_battery or is_android_kernel or (has_aid_inet and not has_systemd))

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
    systemd_run_bin = shutil.which("systemd-run") or ""

    if is_android_chroot:
        env_mode = "android_chroot"
        env_label = f"Android Linux Chroot ({arch})"
    elif has_systemd and not is_container:
        env_mode = "systemd_linux"
        env_label = f"Linux Systemd Server ({arch})"
    else:
        env_mode = "container"
        env_label = f"Linux Container ({arch})" if is_container else f"Linux Standalone ({arch})"

    return {
        "env_mode": env_mode,
        "env_label": env_label,
        "arch": arch,
        "kernel": kernel,
        "is_android_chroot": is_android_chroot,
        "is_container": is_container,
        "has_systemd": has_systemd,
        "has_cgroups_v2": has_cgroups_v2,
        "has_systemd_run": bool(systemd_run_bin and has_systemd),
        "has_battery": has_battery,
        "has_aid_inet": has_aid_inet,
        "has_uv": has_uv,
        "uv_bin": uv_bin,
        "python_executable": sys.executable or "python3",
    }


def generate_systemd_unit(base_dir: Path | None = None, port: int = 8050, user: str = "root") -> str:
    """
    Генерирует защищённый unit-файл systemd (aruta.service / hub.service) для стационарных Linux-серверов
    с опциями hardening: NoNewPrivileges, ProtectSystem=strict, PrivateTmp, ReadWritePaths.
    """
    from hub.config import BASE_DIR

    resolved_base = Path(base_dir) if base_dir is not None else BASE_DIR
    py_exec = shutil.which("python3") or sys.executable or "/usr/bin/python3"
    venv_py = resolved_base / ".venv" / "bin" / "python"
    if venv_py.exists():
        py_exec = str(venv_py)

    return f"""[Unit]
Description=Beacon / Hub Control Panel (Lightweight Operations Console & Containerless PaaS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={user}
WorkingDirectory={resolved_base}
Environment="BEACON_DIR={resolved_base}"
Environment="HUB_DIR={resolved_base}"
Environment="BEACON_PORT={port}"
Environment="HUB_PORT={port}"
Environment="PYTHONUNBUFFERED=1"
ExecStart={py_exec} -m beacon
Restart=always
RestartSec=3
KillMode=process
LimitNOFILE=4096

# Systemd Hardening
NoNewPrivileges=yes
ProtectSystem=strict
PrivateTmp=yes
ProtectControlGroups=yes
ProtectKernelTunables=yes
ReadWritePaths={resolved_base}/data {resolved_base}/projects {resolved_base}/scripts

[Install]
WantedBy=multi-user.target
"""
