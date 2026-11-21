"""
Жизненный цикл процессов и легковесная «контейнеризация без Docker» (hub/process_mgr.py):
- Запуск через os.setsid() с направлением stdout/stderr напрямую в файловый дескриптор лога (БЕЗ subprocess.PIPE!).
- RLIMIT_CORE=(0,0) и RLIMIT_NOFILE=(4096,4096) без RLIMIT_AS.
- Опциональный запуск от hub-runner с группами Android aid_inet (3003) и aid_net_raw (3004).
- Изоляция окружений (.venv / uv, node_modules/.bin в PATH) и ФС (TMPDIR=<workdir>/.tmp, HOME=<workdir>/.home, XDG_CACHE_HOME).
- Маркировка процессов _HUB_PROJECT_ID / _HUB_RUN_ID и отлов осиротевших процессов в /proc/*/environ.
- Поддержка веб-бэкендов ($PORT, проверка свободного порта, HTTP/TCP Healthchecks с авто-рестартом после 3 сбоев).
- Восстановление выживших процессов после рестарта панели по pid + proc_create_time (±0.5с) с учётом ECHILD.
"""

import asyncio
import fcntl
import ipaddress
import json
import os
import pwd
import resource
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

from hub.compat import psutil
from hub.config import FORBIDDEN_PORTS, LOGS_DIR, SDK_NODE_DIR, SDK_PYTHON_DIR, get_runtime_port, parse_reserved_ports
from hub.db import execute_sql, get_all_settings, get_setting, query_all, query_one
from hub.disk_guard import can_start_new_run
from hub.env_detect import get_environment_profile
from hub.log import get_logger
from hub.notifier import send_notification
from hub.secrets_mgr import get_secret_raw, redact_log_text

logger = get_logger("process_mgr")

_LAUNCHER_PATH = Path(__file__).resolve().parent / "launcher.py"

_WATCH_LOOP_STATUS: dict[str, Any] = {
    "last_tick_at": 0.0,
    "ticks": 0,
    "error_count": 0,
    "last_error": "",
    "last_error_at": 0.0,
}

# Активные отслеживаемые запуски в памяти:
# run_id -> {
#   "run_id": int, "project_id": int, "pid": int, "pgid": int,
#   "proc_create_time": float, "started_at": int, "log_path": str,
#   "stdin_fifo": str, "stdin_keepalive_fd": Optional[int],
#   "popen": Optional[subprocess.Popen], "rss_mb": float, "cpu_percent": float,
#   "hc_failures": int, "last_hc_ts": float
# }
ACTIVE_RUNS: dict[int, dict[str, Any]] = {}

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Запрещает автоматическое следование по HTTP 301/302/307/308 редиректам при проверке healthcheck (защита от SSRF)."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


_NO_PROXY_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    _NoRedirectHandler(),
)

# Коллбэк в планировщик при завершении процесса
_ON_FINISH_CALLBACK: Optional[Callable[[dict[str, Any], int, str, str], Coroutine[Any, Any, None]]] = None
_ON_HEALTHCHECK_FAIL_CALLBACK: Optional[Callable[[dict[str, Any], str, str], Coroutine[Any, Any, None]]] = None


def set_on_finish_callback(cb: Callable[[dict[str, Any], int, str, str], Coroutine[Any, Any, None]]) -> None:
    global _ON_FINISH_CALLBACK
    _ON_FINISH_CALLBACK = cb


def set_on_healthcheck_fail_callback(cb: Callable[[dict[str, Any], str, str], Coroutine[Any, Any, None]]) -> None:
    global _ON_HEALTHCHECK_FAIL_CALLBACK
    _ON_HEALTHCHECK_FAIL_CALLBACK = cb


def _reap_zombies() -> None:
    """
    Неблокирующий сбор осиротевших дочерних зомби-процессов.
    Сначала опрашивает все Popen-объекты в ACTIVE_RUNS, чтобы os.waitpid(-1)
    не перехватил реальный код возврата (exit_code) отслеживаемых процессов.
    """
    for info in list(ACTIVE_RUNS.values()):
        popen_obj = info.get("popen")
        if popen_obj is not None:
            try:
                rc = popen_obj.poll()
                if rc is not None:
                    info["reaped_exit_code"] = int(rc)
            except Exception as exc:
                logger.warning("Ошибка poll() при сборе зомби (PID=%s): %s", info.get("pid"), exc)

    while True:
        try:
            wpid, wstatus = os.waitpid(-1, os.WNOHANG)
            if wpid <= 0:
                break
            try:
                code = os.waitstatus_to_exitcode(wstatus)
            except Exception as exc:
                logger.debug("Не удалось декодировать waitstatus=%s: %s", wstatus, exc)
                code = 0
            for info in list(ACTIVE_RUNS.values()):
                if info.get("pid") == wpid and info.get("reaped_exit_code") is None:
                    info["reaped_exit_code"] = int(code)
        except (ChildProcessError, OSError):
            break


def _get_pgid_processes(pgid: int) -> list[Any]:
    """Возвращает все живые процессы, принадлежащие группе PGID."""
    if not pgid or pgid <= 1:
        return []
    procs: list[Any] = []
    for p in psutil.process_iter():
        try:
            if os.getpgid(p.pid) == pgid and p.is_running() and p.status() != "zombie":
                procs.append(p)
        except (ProcessLookupError, PermissionError, psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return procs


def _has_other_active_runs(project_id: int, exclude_run_id: Optional[int] = None) -> bool:
    """Проверяет, есть ли у проекта другие активные запуски в памяти или БД."""
    for rid, info in list(ACTIVE_RUNS.items()):
        if int(info.get("project_id") or 0) == int(project_id) and int(rid) != int(exclude_run_id or -1):
            return True
    row = query_one(
        "SELECT id FROM runs WHERE project_id = ? AND status IN ('running', 'waiting_input') AND id != ? LIMIT 1",
        (int(project_id), int(exclude_run_id or -1)),
    )
    return row is not None


def _kill_pids_gracefully(pids: list[int]) -> int:
    if not pids:
        return 0
    for opid in pids:
        try:
            os.kill(opid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    time.sleep(0.15)
    for opid in pids:
        try:
            os.kill(opid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    _reap_zombies()
    return len(pids)


def kill_orphan_processes_by_run_id(
    run_id: int,
    project_id: Optional[int] = None,
    exclude_pids: Optional[set[int]] = None,
) -> int:
    """
    Находит и завершает осиротевшие процессы только конкретного запуска (_BEACON_RUN_ID),
    не затрагивая параллельно работающие сервисы того же проекта (P0-3).
    """
    target_run = str(run_id)
    target_proj = str(project_id) if project_id is not None else None
    my_pid = os.getpid()
    excluded = (exclude_pids or set()) | {my_pid}
    orphan_pids: list[int] = []

    for p in psutil.process_iter():
        try:
            if p.pid in excluded or not p.is_running() or p.status() == "zombie":
                continue
            env = p.environ()
            if not env:
                continue
            env_run = env.get("_BEACON_RUN_ID")
            if env_run != target_run:
                continue
            if target_proj is not None:
                env_proj = env.get("_BEACON_PROJECT_ID")
                if env_proj and env_proj != target_proj:
                    continue
            orphan_pids.append(p.pid)
        except (ProcessLookupError, PermissionError, psutil.NoSuchProcess, psutil.AccessDenied, Exception):
            continue

    return _kill_pids_gracefully(orphan_pids)


def kill_orphan_processes_by_project_id(project_id: int, exclude_pids: Optional[set[int]] = None) -> int:
    """
    Сканирует /proc/*/environ через psutil и находит процессы-сироты с меткой проекта,
    которые могли сменить группу через собственный os.setsid(), и принудительно завершает их.
    """
    target_val = str(project_id)
    my_pid = os.getpid()
    excluded = (exclude_pids or set()) | {my_pid}
    orphan_pids: list[int] = []

    for p in psutil.process_iter():
        try:
            if p.pid in excluded or not p.is_running() or p.status() == "zombie":
                continue
            env = p.environ()
            if not env:
                continue
            env_proj = env.get("_BEACON_PROJECT_ID")
            if env_proj == target_val:
                orphan_pids.append(p.pid)
        except (ProcessLookupError, PermissionError, psutil.NoSuchProcess, psutil.AccessDenied, Exception):
            continue

    return _kill_pids_gracefully(orphan_pids)


def cleanup_project_tmp_dir(workdir: str | Path) -> int:
    """Очищает содержимое изолированной директории <workdir>/.tmp проекта."""
    tmp_dir = Path(workdir) / ".tmp"
    removed = 0
    if not tmp_dir.exists():
        return 0
    try:
        for item in tmp_dir.iterdir():
            try:
                if item.is_dir() and not item.is_symlink():
                    shutil.rmtree(item, ignore_errors=True)
                else:
                    item.unlink(missing_ok=True)
                removed += 1
            except OSError:
                pass
    except OSError:
        pass
    return removed


def _exit_file_for_log(log_path: str | Path, run_id: int) -> Path:
    lp = Path(log_path)
    return lp.with_name(f"{run_id}.exit")


def _read_exit_code_file(exit_path: Optional[Path]) -> Optional[int]:
    if not exit_path or not exit_path.exists():
        return None
    try:
        raw = exit_path.read_text(encoding="utf-8", errors="ignore").strip()
        if not raw:
            return None
        return int(raw.splitlines()[0].strip())
    except (OSError, ValueError):
        return None


def is_tcp_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """Проверяет, занят ли TCP-порт локальным процессом."""
    if port <= 0:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((host, int(port))) == 0


def _is_loopback_or_self_host(host: str) -> bool:
    """Проверяет, что хост healthcheck указывает на loopback или собственный локальный адрес панели (P2-11)."""
    clean = (host or "").strip().strip("[]").lower()
    if not clean:
        return True
    if clean in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        return True
    try:
        ip_obj = ipaddress.ip_address(clean)
        return ip_obj.is_loopback
    except ValueError:
        pass
    try:
        local_name = socket.gethostname().lower()
        if clean == local_name:
            return True
        infos = socket.getaddrinfo(clean, None)
        if not infos:
            return False
        for fam, _, _, _, sockaddr in infos:
            addr = sockaddr[0].split("%", 1)[0]
            try:
                if not ipaddress.ip_address(addr).is_loopback:
                    return False
            except ValueError:
                return False
        return True
    except OSError:
        return False


def check_endpoint_health(
    healthcheck_url: str,
    fallback_port: int = 0,
    timeout: float = 2.5,
    allow_external: Optional[bool] = None,
) -> tuple[bool, str]:
    """
    Проверяет доступность сервиса по HTTP/HTTPS (код 200..399) или TCP (tcp://host:port).
    По умолчанию разрешены только loopback / собственный хост (SSRF-защита, P2-11).
    """
    url = (healthcheck_url or "").strip()
    if not url and fallback_port > 0:
        url = f"tcp://127.0.0.1:{int(fallback_port)}"
    if not url:
        return True, "not_configured"

    if allow_external is None:
        allow_external = get_setting("healthcheck_allow_external", "0") == "1"

    if url.startswith("tcp://"):
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname or "127.0.0.1"
        if not allow_external and not _is_loopback_or_self_host(host):
            return False, "blocked_external_healthcheck_host"
        port = parsed.port or fallback_port
        if not port:
            return False, "invalid_tcp_port"
        try:
            with socket.create_connection((host, int(port)), timeout=timeout):
                return True, f"TCP {host}:{port} OK"
        except TimeoutError:
            return False, f"TCP {host}:{port} timeout"
        except OSError:
            return False, f"TCP {host}:{port} failed"

    if not url.startswith(("http://", "https://")):
        if "://" in url:
            return False, "unsupported_healthcheck_scheme"
        url = f"http://{url}"

    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if not host or (not allow_external and not _is_loopback_or_self_host(host)):
        return False, "blocked_external_healthcheck_host"

    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Beacon-Healthcheck/2.4"})
    try:
        with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
            code = getattr(resp, "status", 200)
            if 200 <= int(code) < 400:
                return True, f"HTTP {code} OK"
            return False, f"HTTP {code}"
    except urllib.error.HTTPError as e:
        if 300 <= int(e.code) < 400:
            return True, f"HTTP {e.code} Redirect (not followed)"
        return False, f"HTTP {e.code}"
    except TimeoutError:
        return False, "healthcheck_timeout"
    except Exception:
        return False, "healthcheck_connection_failed"


def build_install_deps_command(
    workdir: Path,
    runtime: str,
    project_type: str = "service",
    port: int = 0,
) -> list[str]:
    """
    Формирует argv-команду подготовки окружения, установки зависимостей и проверки проекта
    с адаптацией под runtime (python / node / bash) и тип проекта (service / web / job):
    - Для Bash / Shell: выставляет chmod +x на *.sh и проверяет синтаксис через bash -n.
    - Для Node.js: npm ci / npm install + проверка синтаксиса JS (node --check) и порта для web.
    - Для Python: uv venv / python3 -m venv .venv + pip install -r requirements.txt + py_compile.
    """
    rt = (runtime or "python").strip().lower()
    ptype = (project_type or "service").strip().lower()

    if rt in ("bash", "sh", "shell"):
        script = (
            "set -e; "
            f'echo "[env:{ptype}] Подготовка Shell-скриптов и проверка синтаксиса (bash -n)..."; '
            "chmod +x *.sh 2>/dev/null || true; "
            "checked=0; "
            "for f in *.sh; do "
            '  if [ -f "$f" ]; then '
            '    bash -n "$f" 2>&1 && echo "[shell-ok] Синтаксис и права +x проверены: $f"; '
            "    checked=$((checked + 1)); "
            "  fi; "
            "done; "
            'if [ "$checked" -eq 0 ]; then echo "[shell-info] .sh файлы в корне не найдены, окружение Bash готово."; fi; '
            f'echo "[env:{ptype}] Готово ($(bash --version | head -n 1))."'
        )
        return ["/bin/bash", "-c", script]

    if rt == "node" or ((workdir / "package.json").exists() and not (workdir / "requirements.txt").exists()):
        npm_subcmd = (
            "npm ci --no-audit --no-fund 2>&1"
            if (workdir / "package-lock.json").exists() or (workdir / "npm-shrinkwrap.json").exists()
            else "npm install --no-audit --no-fund 2>&1"
        )
        web_note = (
            f'echo "[web-check] Веб-проект настроен на порт PORT={port or 8080}."; '
            if ptype == "web"
            else f'echo "[{ptype}-check] Проверка синтаксиса JS-скриптов..."; '
        )
        script = (
            "set -e; "
            'if [ ! -f package.json ]; then echo "[deps] Файл package.json не найден — инициализируем npm init -y..."; npm init -y >/dev/null 2>&1 || true; fi; '
            f'echo "[deps:{ptype}] Установка npm-пакетов в локальный node_modules..."; '
            f"{npm_subcmd}; "
            f"{web_note}"
            'for jf in *.js; do [ -f "$jf" ] && node --check "$jf" 2>&1 && echo "[node-ok] Синтаксис проверен: $jf"; done; '
            'echo "[deps] Окружение Node.js готово ($(node -v 2>&1))."'
        )
        return ["/bin/bash", "-c", script]

    type_post_check = ""
    if ptype == "web":
        type_post_check = (
            f'echo "[web-env] Проверка синтаксиса Python и готовности веб-сервиса (PORT={port or 8080})..."; '
            'for pf in *.py; do [ -f "$pf" ] && (.venv/bin/python -m py_compile "$pf" 2>&1 || python3 -m py_compile "$pf" 2>&1) && echo "[py-ok] Модуль проверен: $pf"; done; '
        )
    elif ptype == "job":
        type_post_check = (
            'echo "[job-env] Проверка синтаксиса скрипта задачи (py_compile перед запуском по расписанию)..."; '
            'for pf in *.py; do [ -f "$pf" ] && (.venv/bin/python -m py_compile "$pf" 2>&1 || python3 -m py_compile "$pf" 2>&1) && echo "[job-ok] Скрипт проверен: $pf"; done; '
        )
    else:
        type_post_check = (
            'echo "[service-env] Проверка синтаксиса постоянного 24/7 сервиса..."; '
            'for pf in *.py; do [ -f "$pf" ] && (.venv/bin/python -m py_compile "$pf" 2>&1 || python3 -m py_compile "$pf" 2>&1) && echo "[service-ok] Демон проверен: $pf"; done; '
        )

    script = (
        "set -e; "
        "if command -v uv >/dev/null 2>&1; then "
        f'  echo "[deps:{ptype}] Обнаружен пакетный менеджер uv — создаём изолированное окружение .venv..."; '
        "  if [ ! -x .venv/bin/python ]; then uv venv .venv 2>&1; fi; "
        "  if [ -f requirements.txt ]; then "
        '    echo "[deps] Установка зависимостей через uv pip install -r requirements.txt..."; '
        "    uv pip install --python .venv/bin/python -r requirements.txt 2>&1; "
        "  fi; "
        "else "
        f'  echo "[deps:{ptype}] Настройка изолированного Python окружения .venv..."; '
        "  if [ ! -x .venv/bin/python ]; then "
        "    python3 -m venv .venv 2>&1 || python3 -m venv --without-pip .venv 2>&1; "
        "  fi; "
        "  if [ ! -x .venv/bin/pip ]; then "
        "    .venv/bin/python -m ensurepip --upgrade 2>/dev/null || true; "
        "  fi; "
        "  if [ -f requirements.txt ]; then "
        "    if [ -x .venv/bin/pip ]; then "
        '      echo "[deps] Установка пакетов в .venv/bin/pip..."; '
        "      .venv/bin/pip install --no-input -r requirements.txt 2>&1; "
        "    elif command -v pip3 >/dev/null 2>&1; then "
        '      echo "[deps] Установка пакетов в .venv через системный pip3..."; '
        "      pip3 install --python .venv/bin/python --no-input -r requirements.txt 2>&1 || "
        "      pip3 install --prefix .venv --no-input -r requirements.txt 2>&1; "
        "    fi; "
        "  fi; "
        "fi; "
        f"{type_post_check}"
        'echo "[deps] Окружение .venv готово ($(.venv/bin/python --version 2>&1 || python3 --version))."'
    )
    return ["/bin/bash", "-c", script]


def collect_all_pgid_metrics(target_pgids: set[int]) -> dict[int, tuple[float, float, int]]:
    """
    Собирает метрики (rss_mb, cpu_percent, proc_count) для всех указанных PGID
    за ОДИН проход по psutil.process_iter().
    """
    valid_pgids = {pg for pg in target_pgids if pg and pg > 1}
    if not valid_pgids:
        return {}

    agg_rss: dict[int, int] = {pg: 0 for pg in valid_pgids}
    agg_cpu: dict[int, float] = {pg: 0.0 for pg in valid_pgids}
    agg_cnt: dict[int, int] = {pg: 0 for pg in valid_pgids}

    for p in psutil.process_iter():
        try:
            pg = os.getpgid(p.pid)
            if pg not in valid_pgids:
                continue
            if not p.is_running() or p.status() == "zombie":
                continue
            agg_rss[pg] += p.memory_info().rss
            agg_cpu[pg] += p.cpu_percent(interval=None)
            agg_cnt[pg] += 1
        except (ProcessLookupError, PermissionError, psutil.NoSuchProcess, psutil.AccessDenied, Exception):
            continue

    result: dict[int, tuple[float, float, int]] = {}
    for pg in valid_pgids:
        rss_mb = round(agg_rss[pg] / (1024.0 * 1024.0), 2)
        result[pg] = (rss_mb, round(agg_cpu[pg], 1), agg_cnt[pg])
    return result


def get_pgid_metrics(pgid: int) -> tuple[float, float, int]:
    """Возвращает (rss_mb, cpu_percent, proc_count) по всем процессам группы PGID."""
    if not pgid or pgid <= 1:
        return 0.0, 0.0, 0
    return collect_all_pgid_metrics({pgid}).get(pgid, (0.0, 0.0, 0))


def _cleanup_run_fifo(
    run_id: int,
    mem_info: Optional[dict[str, Any]] = None,
    project_name: Optional[str] = None,
) -> None:
    """Закрывает удерживающий дескриптор записи FIFO и удаляет файл stdin_<run_id>.fifo."""
    if mem_info:
        keep_fd = mem_info.pop("stdin_keepalive_fd", None)
        if isinstance(keep_fd, int):
            try:
                os.close(keep_fd)
            except OSError:
                pass
        fifo_str = mem_info.get("stdin_fifo")
        if fifo_str:
            try:
                Path(fifo_str).unlink(missing_ok=True)
            except OSError:
                pass
    if project_name:
        fifo_p = LOGS_DIR / project_name / f"stdin_{run_id}.fifo"
        try:
            fifo_p.unlink(missing_ok=True)
        except OSError:
            pass


def read_log_tail_bytes(log_path: str | Path, max_bytes: int = 131072, max_lines: int = 500) -> str:
    """
    Потоковое чтение хвоста лог-файла с конца через f.seek() (без загрузки всего файла в ОЗУ)
    с автоматической маскировкой секретов (redact_log_text).
    """
    path = Path(log_path)
    if not path.exists():
        return ""
    try:
        with open(path, "rb") as f:
            sz = os.fstat(f.fileno()).st_size
            start_pos = max(0, sz - max_bytes)
            f.seek(start_pos, os.SEEK_SET)
            raw_bytes = f.read(max_bytes)
        raw_text = raw_bytes.decode("utf-8", errors="replace")
        lines = raw_text.splitlines()
        if start_pos > 0 and len(lines) > 1:
            lines = lines[1:]
        if max_lines > 0 and len(lines) > max_lines:
            lines = lines[-max_lines:]
        return redact_log_text("\n".join(lines))
    except Exception:
        logger.exception("Ошибка чтения хвоста лога %s", path)
        return ""


def _read_log_tail(log_path: str, max_lines: int = 15) -> str:
    return read_log_tail_bytes(log_path, max_bytes=8192, max_lines=max_lines)


_SHELL_META_RE_CHARS = ("&&", "||", "|", ";", ">", "<", "$(", "`")
_NODE_DIRECT_BINS = frozenset({"npm", "npx", "pnpm", "yarn", "bun", "tsx", "ts-node", "pm2", "next", "vite", "nuxt"})


def _build_command_args(project: dict[str, Any], custom_cmd: Optional[str] = None) -> list[str]:
    cmd_str = (custom_cmd or project.get("cmd") or "").strip()
    runtime = project.get("runtime", "python")
    workdir = Path(project.get("workdir", ""))

    if not cmd_str:
        raise ValueError("Пустая команда запуска проекта")

    bash_bin = "/bin/bash" if os.path.exists("/bin/bash") else (shutil.which("bash") or "bash")

    if runtime == "bash":
        parts = shlex.split(cmd_str)
        if not parts:
            raise ValueError("Не удалось разобрать команду запуска")
        if parts[0] in ("bash", "sh", "/bin/bash", "/bin/sh") and not any(tok in cmd_str for tok in _SHELL_META_RE_CHARS):
            parts[0] = bash_bin
            return parts
        return [bash_bin, "-c", cmd_str]

    proj_port = int(project.get("port") or 0)

    # Если команда содержит пайплайны или составные операторы (например: alembic upgrade head && uvicorn ...)
    if any(tok in cmd_str for tok in _SHELL_META_RE_CHARS):
        resolved_cmd = (
            cmd_str.replace("${PORT}", str(proj_port)).replace("$PORT", str(proj_port))
            if proj_port > 0
            else cmd_str
        )
        return [bash_bin, "-c", resolved_cmd]

    parts = shlex.split(cmd_str)
    if not parts:
        raise ValueError("Не удалось разобрать команду запуска")

    # Подстановка $PORT / ${PORT} в аргументы прямого запуска, если порт задан у проекта
    if proj_port > 0:
        port_str = str(proj_port)
        parts = [p.replace("${PORT}", port_str).replace("$PORT", port_str) for p in parts]

    first_bin = parts[0]

    if runtime == "python":
        venv_bin_dir = workdir / ".venv" / "bin"
        venv_py = venv_bin_dir / "python"
        py_bin = str(venv_py) if venv_py.exists() else (shutil.which("python3") or "python3")
        if first_bin in ("python", "python3", ".venv/bin/python", ".venv/bin/python3"):
            parts[0] = py_bin
        elif os.path.isabs(first_bin) or first_bin.startswith("./"):
            pass
        else:
            # Проверяем CLI-инструменты внутри .venv/bin (uvicorn, gunicorn, celery, rq, streamlit, pytest и т.д.)
            venv_tool = venv_bin_dir / first_bin
            if venv_tool.is_file():
                parts[0] = str(venv_tool)
            elif first_bin.endswith(".py"):
                parts = [py_bin] + parts
            else:
                sys_tool = shutil.which(first_bin)
                if sys_tool and not first_bin.endswith(("python", "python3")):
                    parts[0] = sys_tool
                elif not first_bin.endswith(("python", "python3")):
                    parts = [py_bin] + parts
    elif runtime == "node":
        node_bin = shutil.which("node") or "node"
        local_node_tool = workdir / "node_modules" / ".bin" / first_bin
        if first_bin == "node":
            parts[0] = node_bin
        elif local_node_tool.exists() and os.access(local_node_tool, os.X_OK):
            parts[0] = str(local_node_tool)
        elif first_bin in _NODE_DIRECT_BINS:
            resolved_mgr = shutil.which(first_bin)
            if resolved_mgr:
                parts[0] = resolved_mgr
        elif not first_bin.endswith("node") and not os.path.isabs(first_bin) and not first_bin.startswith("./"):
            sys_tool = shutil.which(first_bin)
            if sys_tool and not first_bin.endswith((".js", ".mjs", ".cjs", ".ts")):
                parts[0] = sys_tool
            else:
                parts = [node_bin] + parts

    return parts


_RESERVED_PARAM_EXACT = frozenset(
    {"PATH", "ENV", "SHELLOPTS", "PS4", "PORT", "HOME", "TMPDIR", "TEMP", "TMP", "VIRTUAL_ENV", "IFS"}
)
_RESERVED_PARAM_PREFIXES = ("LD_", "PYTHON", "NODE_", "BASH_", "GIT_", "BEACON", "XDG_")
_RESERVED_PARAM_SUBSTRS = ("PROXY",)


def is_reserved_param_name(name: str) -> bool:
    clean = (name or "").strip().upper()
    if not clean:
        return True
    if clean in _RESERVED_PARAM_EXACT:
        return True
    if any(clean.startswith(pref) for pref in _RESERVED_PARAM_PREFIXES):
        return True
    if any(sub in clean for sub in _RESERVED_PARAM_SUBSTRS):
        return True
    return False


_SAFE_CHILD_ENV_KEYS = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR")


def _build_process_env(
    project: dict[str, Any],
    run_token: str,
    settings: dict[str, str],
    run_id: Optional[int] = None,
    extra_env: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    # Собираем окружение ребёнка ТОЛЬКО из безопасного белого списка, никогда не копируя весь os.environ (P0-4)
    env: dict[str, str] = {}
    for k in _SAFE_CHILD_ENV_KEYS:
        val = os.environ.get(k)
        if val is not None:
            env[k] = val
    if extra_env and isinstance(extra_env, dict):
        for ek, ev in extra_env.items():
            key_str = str(ek).strip()
            if key_str.startswith(("PARAM_", "BEACON_WEBHOOK_")) or not is_reserved_param_name(key_str):
                env[key_str] = str(ev)
    workdir = Path(project.get("workdir", "")).resolve()

    # 1. Изоляция ФС проекта: собственные каталоги .tmp, .home и .home/.cache
    tmp_dir = workdir / ".tmp"
    home_dir = workdir / ".home"
    cache_dir = home_dir / ".cache"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
        home_dir.mkdir(parents=True, exist_ok=True)
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    env["TMPDIR"] = str(tmp_dir)
    env["TEMP"] = str(tmp_dir)
    env["TMP"] = str(tmp_dir)
    env["HOME"] = str(home_dir)
    env["XDG_CACHE_HOME"] = str(cache_dir)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    # 2. Изоляция окружения PATH: <workdir>/.venv/bin и <workdir>/node_modules/.bin в начале PATH
    venv_dir = workdir / ".venv"
    venv_bin = venv_dir / "bin"
    node_bin = workdir / "node_modules" / ".bin"
    orig_path = env.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    path_parts = [str(venv_bin), str(node_bin), orig_path]
    env["PATH"] = ":".join(p for p in path_parts if p)
    if venv_dir.exists():
        env["VIRTUAL_ENV"] = str(venv_dir)

    # 3. Проброс переменной PORT для веб-бэкендов и сервисов
    proj_port = int(project.get("port") or 0)
    if proj_port > 0:
        env["PORT"] = str(proj_port)

    # 4. Пользовательские переменные из project.env_json (с фильтрацией опасных/служебных ключей)
    _blocked_env_keys = {
        "_BEACON_PROJECT_ID",
        "_BEACON_RUN_ID",
        "BEACON_API_URL",
        "BEACON_RUN_TOKEN",
        "BEACON_INTERNAL_TOKEN",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "PYTHONSTARTUP",
        "NODE_OPTIONS",
    }
    try:
        proj_env = json.loads(project.get("env_json") or "{}")
        if isinstance(proj_env, dict):
            for k, v in proj_env.items():
                key_s = str(k).strip()
                key_u = key_s.upper()
                if not key_s or key_u in _blocked_env_keys or key_u.startswith(("_BEACON_", "BEACON_INTERNAL_")):
                    continue
                env[key_s] = str(v)
    except Exception:
        logger.exception("Некорректный env_json у проекта id=%s", project.get("id"))

    # 5. Служебные переменные Beacon всегда устанавливаются ПОСЛЕ пользовательского env_json
    if project.get("id") is not None:
        env["_BEACON_PROJECT_ID"] = str(project["id"])
    if run_id is not None:
        env["_BEACON_RUN_ID"] = str(run_id)

    hub_port = str(get_runtime_port() or settings.get("port", "8050") or "8050")
    internal_url = f"http://127.0.0.1:{hub_port}/internal"
    env["BEACON_API_URL"] = internal_url
    env["BEACON_RUN_TOKEN"] = run_token
    ping_tok = str(project.get("ping_token") or "").strip()
    if ping_tok:
        env["BEACON_PING_TOKEN"] = ping_tok

    # Подключение SDK через PYTHONPATH и NODE_PATH
    existing_py = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = f"{SDK_PYTHON_DIR}:{existing_py}" if existing_py else str(SDK_PYTHON_DIR)

    existing_node = env.get("NODE_PATH", "")
    env["NODE_PATH"] = f"{SDK_NODE_DIR}:{existing_node}" if existing_node else str(SDK_NODE_DIR)

    # Прокси проекта: индивидуальный CUSTOM_PROXY_URL или системный proxy_url (по умолчанию пустой)
    custom_proxy = str(env.get("CUSTOM_PROXY_URL", "")).strip()
    if int(project.get("use_proxy", 0)) == 1:
        proxy_url = custom_proxy if custom_proxy else settings.get("proxy_url", "").strip()
        if proxy_url:
            for pk in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
                env[pk] = proxy_url
            env["NO_PROXY"] = "127.0.0.1,localhost"
            env["no_proxy"] = "127.0.0.1,localhost"

    # Привязанные секреты проекта: НЕ передаём сырые значения текстовых секретов в /proc/<pid>/environ!
    try:
        sec_names = json.loads(project.get("secrets_json") or "[]")
        if isinstance(sec_names, list):
            for sec_name in sec_names:
                sec = get_secret_raw(str(sec_name))
                if sec:
                    sec_type = str(sec.get("type") or "text")
                    env[f"BEACON_SECRET_FILE_{sec['name']}"] = str(sec["file_path"])
                    env[f"BEACON_SECRET_TYPE_{sec['name']}"] = sec_type
    except Exception:
        logger.exception("Ошибка подготовки секретов для проекта id=%s", project.get("id"))

    return env


def _make_preexec_fn(run_as_user: str, drop_privileges: bool = True) -> Callable[[], None]:
    """
    Создаёт функцию preexec_fn для дочернего процесса:
    1. os.setsid() -> лидер новой группы процессов (PGID = PID).
    2. resource.setrlimit: ТОЛЬКО RLIMIT_CORE=(0,0) и RLIMIT_NOFILE=(4096,4096). (БЕЗ RLIMIT_AS!)
    3. Сброс привилегий (run_as_user != 'root' и drop_privileges=True):
       если привилегии сбрасывает systemd-run (--uid/--gid), preexec не сбрасывает uid раньше exec (P1-8).
    """
    user_clean = (run_as_user or "root").strip() or "root"
    target_uid: Optional[int] = None
    target_gid: Optional[int] = None
    lookup_error: Optional[str] = None
    is_android = bool(get_environment_profile().get("is_android_chroot"))

    if drop_privileges and user_clean != "root":
        try:
            pw = pwd.getpwnam(user_clean)
            target_uid = pw.pw_uid
            target_gid = pw.pw_gid
        except KeyError as e:
            lookup_error = f"Системный пользователь '{user_clean}' не найден в /etc/passwd: {e}"

    def _preexec() -> None:
        os.setsid()
        try:
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except Exception:
            pass
        try:
            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            target_nofile = min(4096, hard) if hard != resource.RLIM_INFINITY else 4096
            resource.setrlimit(resource.RLIMIT_NOFILE, (target_nofile, max(target_nofile, min(hard, 4096))))
        except Exception:
            pass

        if drop_privileges and user_clean != "root":
            if lookup_error is not None or target_uid is None or target_gid is None:
                msg = f"\n[Privilege Drop Fatal Error (exit 126)]: {lookup_error or 'UID/GID не определены'}\n"
                try:
                    os.write(2, msg.encode("utf-8", errors="replace"))
                except OSError:
                    pass
                os._exit(126)

            try:
                if os.geteuid() != 0 and os.geteuid() != target_uid:
                    raise PermissionError(
                        f"Процесс панели запущен от UID={os.geteuid()} и не имеет прав переключиться на '{user_clean}' (UID={target_uid})"
                    )
                if os.geteuid() == 0:
                    gids = [target_gid, 3003, 3004] if is_android else [target_gid]
                    os.setgroups(gids)
                    os.setgid(target_gid)
                    os.setuid(target_uid)
            except Exception as exc:
                msg = f"\n[Privilege Drop Fatal Error (exit 126)]: Не удалось сбросить привилегии до '{user_clean}' (UID={target_uid}, GID={target_gid}): {exc}\n"
                try:
                    os.write(2, msg.encode("utf-8", errors="replace"))
                except OSError:
                    pass
                os._exit(126)

    return _preexec


_SYSTEMD_RUN_SCOPE_CAPABLE: Optional[bool] = None


def check_systemd_run_scope_capable(systemd_run_bin: Optional[str] = None) -> tuple[bool, str]:
    """Проверяет на хосте работу `systemd-run --scope --property=MemoryMax=64M` (P1-8)."""
    bin_path = systemd_run_bin or shutil.which("systemd-run")
    if not bin_path:
        return False, "systemd-run не установлен"
    if os.geteuid() != 0:
        return False, "для создания cgroup scope требуются права root"
    try:
        res = subprocess.run(
            [bin_path, "--scope", "-q", "--property=MemoryMax=64M", "--", "/bin/true"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if res.returncode == 0:
            return True, "OK"
        err = (res.stderr or res.stdout or f"exit {res.returncode}").strip()
        return False, err[:160]
    except Exception as exc:
        return False, str(exc)[:160]


def _can_use_systemd_run_scope(systemd_run_bin: str) -> bool:
    global _SYSTEMD_RUN_SCOPE_CAPABLE
    if _SYSTEMD_RUN_SCOPE_CAPABLE is None:
        ok, _ = check_systemd_run_scope_capable(systemd_run_bin)
        _SYSTEMD_RUN_SCOPE_CAPABLE = ok
    return _SYSTEMD_RUN_SCOPE_CAPABLE


def build_systemd_run_args(
    systemd_run_bin: str,
    ram_limit_mb: int,
    run_as_user: str = "root",
) -> tuple[list[str], bool]:
    """Собирает корректные аргументы systemd-run --scope (--property=MemoryMax=..., --uid, --gid) (P1-8)."""
    cmd = [systemd_run_bin, "--scope", "-q", f"--property=MemoryMax={int(ram_limit_mb)}M"]
    user_clean = (run_as_user or "root").strip() or "root"
    if user_clean != "root":
        try:
            pw = pwd.getpwnam(user_clean)
            cmd.extend([f"--uid={pw.pw_uid}", f"--gid={pw.pw_gid}"])
        except KeyError:
            return [], False
    return cmd, True


def _prepare_workdir_ownership(workdir: Path, uid: int, gid: int, exit_path: Optional[Path] = None) -> None:
    """
    Меняет владельца workdir (lchown) только если владелец корня отличается от целевого uid/gid.
    Строго пропускает символические ссылки и файлы с st_nlink > 1 (защита от hardlink-атаки, P2-18).
    """
    try:
        root_st = os.lstat(str(workdir))
        if root_st.st_uid != uid or root_st.st_gid != gid:
            if not os.path.islink(str(workdir)):
                os.lchown(str(workdir), uid, gid)
            for dirpath, dirnames, filenames in os.walk(str(workdir), followlinks=False):
                for dname in list(dirnames):
                    dp = os.path.join(dirpath, dname)
                    try:
                        if os.path.islink(dp):
                            continue
                        st = os.lstat(dp)
                        if st.st_uid != uid or st.st_gid != gid:
                            os.lchown(dp, uid, gid)
                    except OSError:
                        pass
                for fname in filenames:
                    fp = os.path.join(dirpath, fname)
                    try:
                        st = os.lstat(fp)
                        if os.path.islink(fp) or st.st_nlink > 1:
                            continue
                        if st.st_uid != uid or st.st_gid != gid:
                            os.lchown(fp, uid, gid)
                    except OSError:
                        pass
    except OSError:
        pass
    if exit_path is not None:
        try:
            fd_exit = os.open(str(exit_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.close(fd_exit)
            os.lchown(str(exit_path), uid, gid)
        except OSError:
            pass


async def start_project_run(
    project_id: int,
    trigger: str = "manual",
    custom_cmd: Optional[str] = None,
    extra_env: Optional[dict[str, str]] = None,
    custom_argv: Optional[list[str]] = None,
    chain_depth: int = 0,
) -> dict[str, Any]:
    """
    Запускает проект (или команду установки зависимостей) с записью вывода напрямую в файловый дескриптор лога.
    Все проверки, разбор команды и сборка окружения выполняются ДО INSERT INTO runs (P1-5).
    """
    allowed, reason = can_start_new_run()
    if not allowed:
        raise RuntimeError(reason)

    project = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not project:
        raise ValueError(f"Проект id={project_id} не найден")

    is_auxiliary = custom_cmd is not None or custom_argv is not None

    for r_id, info in list(ACTIVE_RUNS.items()):
        if info["project_id"] == project_id and not is_auxiliary:
            raise RuntimeError(f"Проект «{project['name']}» уже выполняется (run_id={r_id}, PID={info['pid']})")

    # Автоматический каскадный запуск зависимости DEPENDS_ON (до глубины 3, защита от циклов)
    if not is_auxiliary and chain_depth < 3:
        try:
            proj_env_map = json.loads(project.get("env_json") or "{}")
        except Exception:
            proj_env_map = {}
        dep_ref = str(proj_env_map.get("DEPENDS_ON", "")).strip() if isinstance(proj_env_map, dict) else ""
        if dep_ref and dep_ref != str(project_id) and dep_ref != str(project.get("name")):
            dep_proj = (
                query_one("SELECT id, name FROM projects WHERE id = ?", (int(dep_ref),))
                if dep_ref.isdigit()
                else query_one("SELECT id, name FROM projects WHERE name = ?", (dep_ref,))
            )
            if dep_proj and int(dep_proj["id"]) != int(project_id) and not _has_other_active_runs(int(dep_proj["id"])):
                try:
                    dep_run = await start_project_run(
                        int(dep_proj["id"]),
                        trigger="chain",
                        chain_depth=chain_depth + 1,
                    )
                    if dep_run and dep_run.get("id"):
                        execute_sql(
                            "UPDATE runs SET triggered_by = ? WHERE id = ?",
                            (f"depends_on:{project['name']}", int(dep_run["id"])),
                        )
                except Exception as dep_exc:
                    logger.warning(
                        "Не удалось автоматически запустить зависимый проект %s для %s: %s",
                        dep_proj["name"],
                        project["name"],
                        dep_exc,
                    )

    settings = get_all_settings()
    reserved_ports = parse_reserved_ports(settings.get("reserved_ports", "")) | FORBIDDEN_PORTS
    panel_port = int(settings.get("port", "8050") or 8050)

    # Проверка сетевого порта до создания записи запуска
    proj_port = int(project.get("port") or 0)
    if proj_port > 0 and not is_auxiliary:
        if proj_port == panel_port or proj_port in reserved_ports:
            raise RuntimeError(
                f"Порт {proj_port} зарезервирован настройками панели ({sorted(list(reserved_ports | {panel_port}))})"
            )
        if is_tcp_port_in_use(proj_port):
            if not _has_other_active_runs(project_id):
                await asyncio.to_thread(kill_orphan_processes_by_project_id, project_id)
            if is_tcp_port_in_use(proj_port):
                raise RuntimeError(f"Порт {proj_port} уже занят другим процессом в системе (авто-подмена порта запрещена)")

    # Разбор команды и подготовка argv + окружения ДО INSERT INTO runs (P1-5)
    if custom_argv is not None:
        if not isinstance(custom_argv, list) or not custom_argv:
            raise ValueError("Пустой список аргументов запуска")
        cmd_args = [str(a) for a in custom_argv]
    else:
        cmd_args = _build_command_args(project, custom_cmd=custom_cmd)

    run_as_user = settings.get("run_as_user", "root").strip() or "root"
    workdir = Path(project["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    proj_log_dir = LOGS_DIR / project["name"]
    proj_log_dir.mkdir(parents=True, exist_ok=True)

    now = int(time.time())
    run_token = secrets.token_hex(24)

    # Предварительная сборка и валидация окружения до INSERT (extra_env применяется ДО служебных переменных, P1-1)
    env = _build_process_env(project, run_token, settings, run_id=None, extra_env=extra_env)

    prev_desired_state = str(project.get("desired_state") or "stopped")
    prev_health_status = str(project.get("health_status") or "stopped")

    temp_log_path = str(proj_log_dir / f"pending_{now}.log")
    run_id = execute_sql(
        """INSERT INTO runs (
            project_id, status, trigger, pid, pgid, proc_create_time,
            started_at, finished_at, exit_code, run_token, log_path, error_summary, is_auxiliary
        ) VALUES (?, 'running', ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, '', ?)""",
        (project_id, trigger, now, run_token, temp_log_path, 1 if is_auxiliary else 0),
    )

    log_path = proj_log_dir / f"{run_id}.log"
    exit_path = _exit_file_for_log(log_path, run_id)
    log_fd = None
    stdin_r_fd: Optional[int] = None
    stdin_w_fd: Optional[int] = None
    stdin_fifo_path = proj_log_dir / f"stdin_{run_id}.fifo"

    try:
        execute_sql("UPDATE runs SET log_path = ? WHERE id = ?", (str(log_path), run_id))

        if project["type"] in ("service", "web") and not is_auxiliary:
            execute_sql(
                "UPDATE projects SET desired_state = 'running', health_status = 'starting', updated_at = ? WHERE id = ?",
                (now, project_id),
            )

        # Прописываем идентификатор запуска для отлова сирот конкретно этого run_id
        env["_BEACON_RUN_ID"] = str(run_id)

        # Оборачиваем запуск в тонкий launcher, сохраняющий код возврата в <run_id>.exit (P1-6)
        launch_args = [sys.executable, str(_LAUNCHER_PATH), str(exit_path), "--"] + cmd_args

        env_prof = get_environment_profile()
        ram_limit_mb = int(project.get("ram_limit_mb") or 0)
        use_systemd_scope = False
        if (
            env_prof.get("env_mode") == "systemd_linux"
            and env_prof.get("has_systemd_run")
            and env_prof.get("has_cgroups_v2")
            and ram_limit_mb > 0
            and not is_auxiliary
            and os.geteuid() == 0
        ):
            systemd_run_bin = shutil.which("systemd-run")
            if systemd_run_bin and await asyncio.to_thread(_can_use_systemd_run_scope, systemd_run_bin):
                sr_args, sr_ok = build_systemd_run_args(systemd_run_bin, ram_limit_mb, run_as_user)
                if sr_ok and sr_args:
                    launch_args = sr_args + ["--"] + launch_args
                    use_systemd_scope = True

        if run_as_user and run_as_user != "root" and os.geteuid() == 0:
            try:
                pw = pwd.getpwnam(run_as_user)

                await asyncio.to_thread(_prepare_workdir_ownership, workdir, pw.pw_uid, pw.pw_gid, exit_path)
            except (KeyError, OSError):
                pass

        log_fd = open(log_path, "ab", buffering=0)
        header_line = (
            f"=== [Beacon Run #{run_id}] Started at {time.strftime('%Y-%m-%d %H:%M:%S')} | "
            f"Trigger: {trigger} | Cmd: {' '.join(cmd_args)} ===\n"
        ).encode("utf-8")
        log_fd.write(header_line)

        try:
            if stdin_fifo_path.exists():
                stdin_fifo_path.unlink()
            os.mkfifo(stdin_fifo_path, 0o600)
            stdin_r_fd = os.open(str(stdin_fifo_path), os.O_RDONLY | os.O_NONBLOCK)
            stdin_w_fd = os.open(str(stdin_fifo_path), os.O_WRONLY | os.O_NONBLOCK)
            r_flags = fcntl.fcntl(stdin_r_fd, fcntl.F_GETFL)
            fcntl.fcntl(stdin_r_fd, fcntl.F_SETFL, r_flags & ~os.O_NONBLOCK)
        except Exception as exc:
            logger.warning("Не удалось создать stdin FIFO для run_id=%s: %s", run_id, exc)
            if stdin_r_fd is not None:
                try:
                    os.close(stdin_r_fd)
                except OSError:
                    pass
            if stdin_w_fd is not None:
                try:
                    os.close(stdin_w_fd)
                except OSError:
                    pass
            stdin_r_fd = None
            stdin_w_fd = None

        try:
            proc = subprocess.Popen(
                launch_args,
                cwd=str(workdir),
                env=env,
                stdin=stdin_r_fd if stdin_r_fd is not None else subprocess.DEVNULL,
                stdout=log_fd,
                stderr=log_fd,
                close_fds=True,
                preexec_fn=_make_preexec_fn(run_as_user, drop_privileges=not use_systemd_scope),
            )
        finally:
            if log_fd is not None and not log_fd.closed:
                log_fd.close()
            if stdin_r_fd is not None:
                try:
                    os.close(stdin_r_fd)
                except OSError:
                    pass
                stdin_r_fd = None

        pid = proc.pid
        try:
            pgid = os.getpgid(pid)
        except Exception:
            pgid = pid

        try:
            p_info = psutil.Process(pid)
            proc_create_time = float(p_info.create_time())
        except Exception:
            proc_create_time = time.time()

        execute_sql(
            "UPDATE runs SET pid = ?, pgid = ?, proc_create_time = ? WHERE id = ?",
            (pid, pgid, proc_create_time, run_id),
        )

        ACTIVE_RUNS[run_id] = {
            "run_id": run_id,
            "project_id": project_id,
            "project_name": project["name"],
            "project_type": project["type"],
            "pid": pid,
            "pgid": pgid,
            "proc_create_time": proc_create_time,
            "started_at": now,
            "log_path": str(log_path),
            "exit_path": str(exit_path),
            "stdin_fifo": str(stdin_fifo_path),
            "stdin_keepalive_fd": stdin_w_fd,
            "popen": proc,
            "rss_mb": 0.0,
            "peak_rss_mb": 0.0,
            "rss_history": [],
            "cpu_percent": 0.0,
            "is_deps_install": is_auxiliary,
            "chain_depth": int(chain_depth),
            "hc_failures": 0,
            "last_hc_ts": float(now),
        }

        return query_one("SELECT * FROM runs WHERE id = ?", (run_id,)) or {"id": run_id, "pid": pid, "pgid": pgid}
    except Exception as e:
        if log_fd is not None:
            try:
                if not log_fd.closed:
                    log_fd.write(f"\n[Beacon Launch Error]: {e}\n".encode("utf-8"))
                    log_fd.close()
            except OSError:
                pass
        for fd_item in (stdin_r_fd, stdin_w_fd):
            if fd_item is not None:
                try:
                    os.close(fd_item)
                except OSError:
                    pass
        for p_item in (stdin_fifo_path, exit_path):
            try:
                p_item.unlink(missing_ok=True)
            except OSError:
                pass
        execute_sql(
            "UPDATE runs SET status = 'failed', finished_at = ?, exit_code = -1, error_summary = ? WHERE id = ?",
            (int(time.time()), str(e)[:300], run_id),
        )
        if project["type"] in ("service", "web") and not is_auxiliary:
            execute_sql(
                "UPDATE projects SET desired_state = ?, health_status = ?, updated_at = ? WHERE id = ?",
                (prev_desired_state, prev_health_status, int(time.time()), project_id),
            )
        raise


def send_stdin_to_run(run_id: int, text: str, echo_to_log: bool = True) -> bool:
    """
    Отправляет строку пользовательского ввода в stdin работающего процесса через именованный FIFO.
    Ответы на интерактивные запросы (waiting_input / echo_to_log=False) не дублируются в лог (P2-09).
    """
    row = query_one("SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?", (run_id,))
    if not row or row["status"] not in ("running", "waiting_input"):
        return False

    log_path = Path(row["log_path"])
    fifo_path = LOGS_DIR / row["project_name"] / f"stdin_{run_id}.fifo"

    clean_line = text.rstrip("\r\n")
    try:
        if log_path.exists():
            if not echo_to_log or row["status"] == "waiting_input":
                with open(log_path, "ab", buffering=0) as lf:
                    lf.write("[Ввод ответа на запрос stdin >>> (скрыто)]\n".encode("utf-8"))
            else:
                with open(log_path, "ab", buffering=0) as lf:
                    lf.write(f"[Ввод в консоль stdin >>>] {clean_line}\n".encode("utf-8"))
    except OSError:
        pass

    payload = (clean_line + "\n").encode("utf-8")
    mem_info = ACTIVE_RUNS.get(run_id)
    keep_fd = mem_info.get("stdin_keepalive_fd") if mem_info else None
    if isinstance(keep_fd, int):
        try:
            os.write(keep_fd, payload)
            return True
        except OSError:
            pass

    if fifo_path.exists():
        try:
            fd = os.open(str(fifo_path), os.O_WRONLY | os.O_NONBLOCK)
            try:
                os.write(fd, payload)
            finally:
                os.close(fd)
            return True
        except OSError:
            return False
    return False


_STOPPING_RUNS: set[int] = set()
_BG_TASKS: set[asyncio.Task[Any]] = set()


async def stop_run(
    run_id: int,
    final_status: str = "stopped",
    reason_note: str = "",
    grace_sec: float = 5.0,
) -> bool:
    """
    Останавливает дерево процессов по PGID + добивает сирот конкретного запуска (_BEACON_RUN_ID),
    а .tmp чистит только если у проекта нет других активных запусков (P0-3).
    """
    row = query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
    if not row:
        return False

    project_id = int(row["project_id"])
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    should_mark_stopped = final_status == "stopped" or (
        final_status == "killed_oom" and proj is not None and str(proj.get("restart_policy") or "on-failure") == "no"
    )
    if proj and proj["type"] in ("service", "web") and should_mark_stopped and not _has_other_active_runs(project_id, exclude_run_id=run_id):
        execute_sql(
            "UPDATE projects SET desired_state = 'stopped', health_status = 'stopped', updated_at = ? WHERE id = ?",
            (int(time.time()), project_id),
        )

    pid = row.get("pid")
    pgid = row.get("pgid") or pid
    expected_ctime = row.get("proc_create_time")

    mem_info = ACTIVE_RUNS.pop(run_id, None)
    popen_obj: Optional[subprocess.Popen[bytes]] = mem_info.get("popen") if mem_info else None
    _cleanup_run_fifo(run_id, mem_info, proj["name"] if proj else None)

    if pgid and pgid > 1:
        can_signal = False
        if pid:
            try:
                p = psutil.Process(int(pid))
                if expected_ctime is None or abs(p.create_time() - float(expected_ctime)) <= 0.5:
                    can_signal = True
            except psutil.NoSuchProcess:
                if _get_pgid_processes(int(pgid)):
                    can_signal = True

        escalated_sigkill = False
        if can_signal:
            try:
                os.killpg(int(pgid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass

            wait_steps = max(1, int(round(max(0.2, float(grace_sec)) / 0.2)))
            for _ in range(wait_steps):
                if popen_obj is not None:
                    popen_obj.poll()
                _reap_zombies()
                alive = _get_pgid_processes(int(pgid))
                if not alive:
                    break
                await asyncio.sleep(0.2)

            if _get_pgid_processes(int(pgid)):
                escalated_sigkill = True
                try:
                    os.killpg(int(pgid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                await asyncio.sleep(0.1)
                if popen_obj is not None:
                    popen_obj.poll()
                _reap_zombies()
    else:
        escalated_sigkill = False

    # Убиваем сирот ТОЛЬКО этого запуска по _BEACON_RUN_ID / _HUB_RUN_ID (P0-3)
    await asyncio.to_thread(kill_orphan_processes_by_run_id, run_id, project_id)
    if proj and proj.get("workdir") and not _has_other_active_runs(project_id, exclude_run_id=run_id):
        await asyncio.to_thread(cleanup_project_tmp_dir, proj["workdir"])

    now = int(time.time())
    log_path = row.get("log_path", "")
    if log_path:
        try:
            _exit_file_for_log(log_path, run_id).unlink(missing_ok=True)
        except OSError:
            pass
    if log_path and os.path.exists(log_path):
        try:
            with open(log_path, "ab", buffering=0) as f:
                msg = f"\n=== [Beacon Run #{run_id}] Terminated ({final_status}) at {time.strftime('%Y-%m-%d %H:%M:%S')} {reason_note} ===\n"
                f.write(msg.encode("utf-8"))
        except OSError:
            pass

    term_exit_code = -9 if escalated_sigkill else -15
    execute_sql(
        """UPDATE runs SET status = ?, finished_at = ?, exit_code = COALESCE(exit_code, ?), error_summary = ?
           WHERE id = ?""",
        (final_status, now, term_exit_code, reason_note, run_id),
    )
    execute_sql(
        "UPDATE pending_asks SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'",
        (run_id,),
    )
    return True


async def stop_project(project_id: int) -> bool:
    """Останавливает все активные запуски проекта, убивает сирот по _BEACON_PROJECT_ID и очищает .tmp."""
    now = int(time.time())
    execute_sql(
        "UPDATE projects SET desired_state = 'stopped', health_status = 'stopped', updated_at = ? WHERE id = ?",
        (now, project_id),
    )
    active = query_all(
        "SELECT id FROM runs WHERE project_id = ? AND status IN ('running', 'waiting_input')",
        (project_id,),
    )
    for r in active:
        await stop_run(r["id"], final_status="stopped", reason_note="Остановлено пользователем")

    if not _has_other_active_runs(project_id):
        await asyncio.to_thread(kill_orphan_processes_by_project_id, project_id)
        proj = query_one("SELECT workdir FROM projects WHERE id = ?", (project_id,))
        if proj and proj.get("workdir"):
            await asyncio.to_thread(cleanup_project_tmp_dir, proj["workdir"])
    return True


def recover_running_processes() -> dict[str, int]:
    """
    КРИТИЧЕСКОЕ ПРАВИЛО #3 (Учёт ECHILD при рестарте панели) + чтение <run_id>.exit (P1-6):
    При старте Beacon выбирает из БД все runs со статусом 'running' или 'waiting_input'.
    Проверяет psutil.Process(pid) и abs(proc.create_time() - run.proc_create_time) < 0.5.
    """
    rows = query_all(
        """SELECT r.*, p.name AS project_name, p.type AS project_type
           FROM runs r
           JOIN projects p ON p.id = r.project_id
           WHERE r.status IN ('running', 'waiting_input')"""
    )
    recovered = 0
    marked_dead = 0
    now = int(time.time())

    row_states: list[tuple[dict[str, Any], bool]] = []
    live_project_ids: set[int] = set()
    for r in rows:
        pid = r.get("pid")
        expected_ctime = r.get("proc_create_time")
        is_alive = False
        if pid and expected_ctime is not None:
            try:
                p = psutil.Process(int(pid))
                if p.is_running() and p.status() != "zombie":
                    if abs(p.create_time() - float(expected_ctime)) < 0.5:
                        is_alive = True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                is_alive = False
        row_states.append((r, is_alive))
        if is_alive:
            live_project_ids.add(int(r["project_id"]))

    for r, is_alive in row_states:
        run_id = int(r["id"])
        pid = r.get("pid")
        pgid = r.get("pgid") or pid
        expected_ctime = r.get("proc_create_time")
        exit_path = _exit_file_for_log(r["log_path"], run_id)

        if is_alive:
            fifo_path = LOGS_DIR / r["project_name"] / f"stdin_{run_id}.fifo"
            keep_fd: Optional[int] = None
            if fifo_path.exists():
                try:
                    keep_fd = os.open(str(fifo_path), os.O_WRONLY | os.O_NONBLOCK)
                except OSError:
                    keep_fd = None
            ACTIVE_RUNS[run_id] = {
                "run_id": run_id,
                "project_id": r["project_id"],
                "project_name": r["project_name"],
                "project_type": r["project_type"],
                "pid": int(pid),
                "pgid": int(pgid),
                "proc_create_time": float(expected_ctime),
                "started_at": int(r["started_at"]),
                "log_path": r["log_path"],
                "exit_path": str(exit_path),
                "stdin_fifo": str(fifo_path),
                "stdin_keepalive_fd": keep_fd,
                "popen": None,
                "rss_mb": 0.0,
                "cpu_percent": 0.0,
                "is_deps_install": bool(r.get("is_auxiliary")),
                "hc_failures": 0,
                "last_hc_ts": float(now),
            }
            recovered += 1
        else:
            _cleanup_run_fifo(run_id, None, r["project_name"])
            kill_orphan_processes_by_run_id(run_id, int(r["project_id"]))
            if int(r["project_id"]) not in live_project_ids:
                kill_orphan_processes_by_project_id(int(r["project_id"]))
            file_rc = _read_exit_code_file(exit_path)
            try:
                exit_path.unlink(missing_ok=True)
            except OSError:
                pass
            if file_rc is not None:
                final_status = "success" if file_rc == 0 else "failed"
                final_rc = file_rc
                err_msg = "" if file_rc == 0 else f"Процесс завершился во время перезапуска Beacon (код {file_rc})"
            else:
                final_status = "failed"
                final_rc = -1
                err_msg = "Процесс завершился во время перезапуска Beacon (код возврата неизвестен)"
            execute_sql(
                """UPDATE runs
                   SET status = ?, exit_code = ?, finished_at = ?,
                       error_summary = ?
                   WHERE id = ?""",
                (final_status, final_rc, now, err_msg, run_id),
            )
            execute_sql(
                "UPDATE pending_asks SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'",
                (run_id,),
            )
            marked_dead += 1

    return {"recovered": recovered, "marked_dead": marked_dead}


async def watch_processes_loop() -> None:
    """
    Фоновый сторож процессов (каждые 2 секунды):
    - Неблокирующе собирает осиротевших зомби (os.waitpid(-1, os.WNOHANG)).
    - Проверяет завершение всех ACTIVE_RUNS и читает <run_id>.exit для восстановленных запусков (P1-6).
    - За ОДИН проход по psutil.process_iter() считает суммарный RSS и CPU% для всех активных PGID.
    - Проверяет HTTP/TCP Healthchecks для веб-бэкендов и сервисов (3 ошибки подряд -> рестарт).
    - При превышении project.ram_limit_mb убивает группу, ставит killed_oom и шлёт уведомление.
    - При превышении project.timeout_sec для job убивает группу и ставит timeout.
    """
    while True:
        try:
            _reap_zombies()
            now = int(time.time())
            now_f = time.time()
            target_pgids = {int(info["pgid"]) for info in ACTIVE_RUNS.values() if info.get("pgid")}
            pgid_metrics_map = await asyncio.to_thread(collect_all_pgid_metrics, target_pgids) if target_pgids else {}

            for run_id, info in list(ACTIVE_RUNS.items()):
                try:
                    pid = info["pid"]
                    pgid = info["pgid"]
                    popen_obj: Optional[subprocess.Popen[bytes]] = info.get("popen")
                    project = query_one("SELECT * FROM projects WHERE id = ?", (info["project_id"],))
                    if not project:
                        mem_info = ACTIVE_RUNS.pop(run_id, None)
                        _cleanup_run_fifo(run_id, mem_info)
                        continue

                    exit_path = Path(info.get("exit_path") or _exit_file_for_log(info["log_path"], run_id))

                    # 1. Проверка завершения процесса
                    exit_code: Optional[int] = info.get("reaped_exit_code")
                    still_alive = False
                    unknown_exit = False

                    if exit_code is not None:
                        still_alive = False
                        file_rc = _read_exit_code_file(exit_path)
                        if file_rc is not None:
                            exit_code = file_rc
                    elif popen_obj is not None:
                        rc = popen_obj.poll()
                        if rc is None:
                            still_alive = True
                        else:
                            file_rc = _read_exit_code_file(exit_path)
                            exit_code = file_rc if file_rc is not None else int(rc)
                    else:
                        is_dead_recovered = False
                        try:
                            p = psutil.Process(pid)
                            if (
                                p.is_running()
                                and p.status() != "zombie"
                                and abs(p.create_time() - info["proc_create_time"]) < 0.5
                            ):
                                still_alive = True
                            else:
                                is_dead_recovered = True
                        except psutil.NoSuchProcess:
                            is_dead_recovered = True

                        if is_dead_recovered:
                            file_rc = _read_exit_code_file(exit_path)
                            if file_rc is not None:
                                exit_code = file_rc
                            else:
                                exit_code = -1
                                unknown_exit = True

                    if not still_alive:
                        leftover = _get_pgid_processes(pgid)
                        if leftover:
                            try:
                                os.killpg(pgid, signal.SIGTERM)
                            except OSError as exc:
                                logger.warning("Не удалось отправить SIGTERM группе PGID=%s (run_id=%s): %s", pgid, run_id, exc)
                        # Зачищаем только процессы этого run_id, а .tmp — только если нет других активных запусков (P0-3)
                        await asyncio.to_thread(kill_orphan_processes_by_run_id, run_id, int(project["id"]))
                        if project.get("workdir") and not _has_other_active_runs(int(project["id"]), exclude_run_id=run_id):
                            await asyncio.to_thread(cleanup_project_tmp_dir, project["workdir"])

                        mem_info = ACTIVE_RUNS.pop(run_id, None)
                        _cleanup_run_fifo(run_id, mem_info, project["name"])
                        try:
                            exit_path.unlink(missing_ok=True)
                        except OSError:
                            pass

                        code = exit_code if exit_code is not None else -1
                        final_status = "success" if (code == 0 and not unknown_exit) else "failed"
                        tail = _read_log_tail(info["log_path"], max_lines=15)
                        if unknown_exit:
                            err_summary = "код возврата неизвестен"
                        elif code != 0 and tail:
                            err_summary = tail.splitlines()[-1][:200]
                        else:
                            err_summary = ""

                        try:
                            with open(info["log_path"], "ab", buffering=0) as f:
                                f.write(
                                    f"\n=== [Beacon Run #{run_id}] Finished with exit_code={code} ({final_status}) at {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode(
                                        "utf-8"
                                    )
                                )
                        except OSError:
                            pass

                        execute_sql(
                            """UPDATE runs
                               SET status = ?, finished_at = ?, exit_code = ?, error_summary = ?
                               WHERE id = ?""",
                            (final_status, now, code, err_summary, run_id),
                        )
                        execute_sql(
                            "UPDATE pending_asks SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'",
                            (run_id,),
                        )

                        if _ON_FINISH_CALLBACK and not info.get("is_deps_install"):
                            proj_ctx = dict(project)
                            proj_ctx["_chain_depth"] = int(info.get("chain_depth") or 0)
                            await _ON_FINISH_CALLBACK(proj_ctx, code, final_status, tail)
                        continue

                    # 2. Метрики RSS, CPU% и числа процессов по всей группе PGID из единого снимка за тик
                    rss_mb, cpu_pct, proc_cnt = pgid_metrics_map.get(int(pgid), (0.0, 0.0, 0))
                    info["rss_mb"] = rss_mb
                    info["cpu_percent"] = cpu_pct
                    info["proc_count"] = proc_cnt
                    info["peak_rss_mb"] = max(float(info.get("peak_rss_mb") or 0.0), float(rss_mb))
                    rss_hist = list(info.get("rss_history") or [])
                    rss_hist.append(round(float(rss_mb), 1))
                    if len(rss_hist) > 16:
                        del rss_hist[:-16]
                    info["rss_history"] = rss_hist

                    # 3. Контроль лимита ОЗУ (ram_limit_mb) — не блокируем сторож на 5 с при остановке
                    ram_limit_mb = int(project.get("ram_limit_mb") or 0)
                    if ram_limit_mb > 0 and rss_mb > ram_limit_mb and run_id not in _STOPPING_RUNS:
                        _STOPPING_RUNS.add(run_id)
                        oom_msg = f"Превышен лимит памяти PGID: {rss_mb} МБ > {ram_limit_mb} МБ"
                        proj_snap = dict(project)
                        log_path_snap = str(info["log_path"])
                        is_aux_snap = bool(info.get("is_deps_install"))
                        pgid_snap = pgid

                        async def _handle_oom_kill(
                            rid: int = run_id,
                            p_snap: dict[str, Any] = proj_snap,
                            lp_snap: str = log_path_snap,
                            aux_snap: bool = is_aux_snap,
                            pg_snap: int = pgid_snap,
                            msg_snap: str = oom_msg,
                        ) -> None:
                            try:
                                await stop_run(rid, final_status="killed_oom", reason_note=msg_snap, grace_sec=1.0)
                                tail = _read_log_tail(lp_snap, max_lines=15)
                                await send_notification(
                                    f"{msg_snap}. Группа процессов PGID={pg_snap} принудительно остановлена.",
                                    level="oom",
                                    project_name=p_snap["name"],
                                    log_tail=tail,
                                )
                                if _ON_FINISH_CALLBACK and not aux_snap:
                                    await _ON_FINISH_CALLBACK(p_snap, -9, "killed_oom", tail)
                            except Exception:
                                logger.exception("Ошибка обработки OOM для run_id=%s", rid)
                            finally:
                                _STOPPING_RUNS.discard(rid)

                        oom_task = asyncio.create_task(_handle_oom_kill())
                        _BG_TASKS.add(oom_task)
                        oom_task.add_done_callback(_BG_TASKS.discard)
                        continue

                    # 4. Контроль таймаута для задач (type == 'job')
                    timeout_sec = int(project.get("timeout_sec") or 0)
                    if project["type"] == "job" and timeout_sec > 0 and (now - info["started_at"]) > timeout_sec:
                        t_msg = f"Превышен таймаут выполнения ({timeout_sec} сек)"
                        await stop_run(run_id, final_status="timeout", reason_note=t_msg)
                        tail = _read_log_tail(info["log_path"], max_lines=15)
                        if int(project.get("notify_on_error", 1)) == 1:
                            await send_notification(
                                f"Задача остановлена по таймауту ({timeout_sec} сек).",
                                level="error",
                                project_name=project["name"],
                                log_tail=tail,
                            )
                        if _ON_FINISH_CALLBACK and not info.get("is_deps_install"):
                            await _ON_FINISH_CALLBACK(project, -15, "timeout", tail)
                        continue

                    # 5. HTTP / TCP Healthcheck для веб-бэкендов и сервисов
                    hc_url = str(project.get("healthcheck_url") or "").strip()
                    proj_port = int(project.get("port") or 0)
                    if not info.get("is_deps_install") and (hc_url or (project["type"] == "web" and proj_port > 0)):
                        hc_interval = max(5, int(project.get("healthcheck_interval_sec") or 30))
                        last_hc = float(info.get("last_hc_ts") or info["started_at"])
                        if (now - info["started_at"]) >= 5 and (now_f - last_hc) >= hc_interval:
                            info["last_hc_ts"] = now_f
                            hc_ok, hc_detail = await asyncio.to_thread(
                                check_endpoint_health, hc_url, proj_port, 2.5
                            )
                            if hc_ok:
                                info["hc_failures"] = 0
                                if project.get("health_status") != "healthy":
                                    execute_sql(
                                        "UPDATE projects SET health_status = 'healthy' WHERE id = ?",
                                        (project["id"],),
                                    )
                            else:
                                fails = int(info.get("hc_failures") or 0) + 1
                                info["hc_failures"] = fails
                                execute_sql(
                                    "UPDATE projects SET health_status = 'unhealthy' WHERE id = ?",
                                    (project["id"],),
                                )
                                if fails >= 3:
                                    hc_msg = f"Healthcheck не прошёл 3 раза подряд ({hc_detail}) — выполняется перезапуск"
                                    await stop_run(run_id, final_status="failed", reason_note=hc_msg)
                                    tail = _read_log_tail(info["log_path"], max_lines=15)
                                    if _ON_HEALTHCHECK_FAIL_CALLBACK is not None:
                                        await _ON_HEALTHCHECK_FAIL_CALLBACK(project, hc_msg, tail)
                                    else:
                                        await send_notification(
                                            f"Сервис «{project['name']}» завис ({hc_msg}). Выполнен автоматический перезапуск.",
                                            level="error",
                                            project_name=project["name"],
                                            log_tail=tail,
                                        )
                                        await start_project_run(int(project["id"]), trigger="healthcheck")
                                    continue
                except Exception as exc:
                    _WATCH_LOOP_STATUS["error_count"] += 1
                    _WATCH_LOOP_STATUS["last_error"] = str(exc)
                    _WATCH_LOOP_STATUS["last_error_at"] = time.time()
                    logger.exception("Ошибка обработки запуска run_id=%s в watch_processes_loop", run_id)

        except Exception as exc:
            _WATCH_LOOP_STATUS["error_count"] += 1
            _WATCH_LOOP_STATUS["last_error"] = str(exc)
            _WATCH_LOOP_STATUS["last_error_at"] = time.time()
            logger.exception("Критическая ошибка в тике watch_processes_loop")
        finally:
            _WATCH_LOOP_STATUS["last_tick_at"] = time.time()
            _WATCH_LOOP_STATUS["ticks"] += 1

        await asyncio.sleep(2.0)
