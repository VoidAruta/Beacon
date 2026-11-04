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
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

from hub.auth import get_internal_token
from hub.compat import psutil
from hub.config import FORBIDDEN_PORTS, LOGS_DIR, SDK_NODE_DIR, SDK_PYTHON_DIR
from hub.db import execute_sql, get_all_settings, query_all, query_one
from hub.disk_guard import can_start_new_run
from hub.notifier import send_notification
from hub.secrets_mgr import get_secret_raw, redact_log_text

# Активные отслеживаемые запуски в памяти:
# run_id -> {
#   "run_id": int, "project_id": int, "pid": int, "pgid": int,
#   "proc_create_time": float, "started_at": int, "log_path": str,
#   "stdin_fifo": str, "stdin_keepalive_fd": Optional[int],
#   "popen": Optional[subprocess.Popen], "rss_mb": float, "cpu_percent": float,
#   "hc_failures": int, "last_hc_ts": float
# }
ACTIVE_RUNS: dict[int, dict[str, Any]] = {}

_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# Коллбэк в планировщик при завершении процесса
_ON_FINISH_CALLBACK: Optional[Callable[[dict[str, Any], int, str, str], Coroutine[Any, Any, None]]] = None


def set_on_finish_callback(cb: Callable[[dict[str, Any], int, str, str], Coroutine[Any, Any, None]]) -> None:
    global _ON_FINISH_CALLBACK
    _ON_FINISH_CALLBACK = cb


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
            except Exception:
                pass

    while True:
        try:
            wpid, wstatus = os.waitpid(-1, os.WNOHANG)
            if wpid <= 0:
                break
            try:
                code = os.waitstatus_to_exitcode(wstatus)
            except Exception:
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


def kill_orphan_processes_by_project_id(project_id: int, exclude_pids: Optional[set[int]] = None) -> int:
    """
    Сканирует /proc/*/environ через psutil и находит процессы-сироты с меткой _HUB_PROJECT_ID=<project_id>,
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
            if env and env.get("_HUB_PROJECT_ID") == target_val:
                orphan_pids.append(p.pid)
        except (ProcessLookupError, PermissionError, psutil.NoSuchProcess, psutil.AccessDenied, Exception):
            continue

    for opid in orphan_pids:
        try:
            os.kill(opid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    if orphan_pids:
        time.sleep(0.15)
        for opid in orphan_pids:
            try:
                os.kill(opid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        _reap_zombies()

    return len(orphan_pids)


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


def is_tcp_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """Проверяет, занят ли TCP-порт локальным процессом."""
    if port <= 0:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((host, int(port))) == 0


def check_endpoint_health(healthcheck_url: str, fallback_port: int = 0, timeout: float = 2.5) -> tuple[bool, str]:
    """
    Проверяет доступность сервиса по HTTP/HTTPS (ожидается код 200..399) или TCP (tcp://host:port).
    Если healthcheck_url пуст, но задан fallback_port > 0, проверяет TCP-соединение с 127.0.0.1:<fallback_port>.
    """
    url = (healthcheck_url or "").strip()
    if not url and fallback_port > 0:
        url = f"tcp://127.0.0.1:{int(fallback_port)}"
    if not url:
        return True, "not_configured"

    if url.startswith("tcp://"):
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or fallback_port
        if not port:
            return False, "invalid_tcp_port"
        try:
            with socket.create_connection((host, int(port)), timeout=timeout):
                return True, f"TCP {host}:{port} OK"
        except OSError as e:
            return False, f"TCP {host}:{port} failed: {e}"

    if not url.startswith(("http://", "https://")):
        url = f"http://{url}"

    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Hub-Healthcheck/2.0"})
    try:
        with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
            code = getattr(resp, "status", 200)
            if 200 <= int(code) < 400:
                return True, f"HTTP {code} OK"
            return False, f"HTTP {code}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)


def build_install_deps_command(workdir: Path, runtime: str) -> str:
    """
    Формирует команду изолированной установки зависимостей проекта:
    - Для Node.js: npm install --no-audit --no-fund
    - Для Python:
      1) Если установлен `uv` (shutil.which("uv")), использует `uv venv .venv` и `uv pip install --python .venv/bin/python -r requirements.txt` (с кэшем хардлинков).
      2) Если `uv` нет — создаёт полноценный `python3 -m venv .venv` (с fallback на `--without-pip` + `ensurepip` или установкой через системный `pip3 --python .venv/bin/python` / `--prefix .venv`), чтобы пакеты ставились строго внутрь `.venv` проекта.
    """
    if runtime == "node" or (workdir / "package.json").exists() and not (workdir / "requirements.txt").exists():
        return (
            "/bin/bash -c '"
            'echo "[deps] Установка npm-пакетов в локальный node_modules..."; '
            "npm install --no-audit --no-fund 2>&1 || echo \"[deps] Завершено\"'"
        )

    return (
        "/bin/bash -c '"
        "set -e; "
        "if command -v uv >/dev/null 2>&1; then "
        '  echo "[deps] Обнаружен пакетный менеджер uv — создаём изолированное окружение .venv..."; '
        "  if [ ! -x .venv/bin/python ]; then uv venv .venv 2>&1; fi; "
        "  if [ -f requirements.txt ]; then "
        '    echo "[deps] Установка зависимостей через uv pip install -r requirements.txt..."; '
        "    uv pip install --python .venv/bin/python -r requirements.txt 2>&1; "
        "  fi; "
        "else "
        '  echo "[deps] Настройка изолированного Python окружения .venv..."; '
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
        'echo "[deps] Окружение .venv готово ($(.venv/bin/python --version 2>&1 || python3 --version))."\''
    )


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
        return ""


def _read_log_tail(log_path: str, max_lines: int = 15) -> str:
    return read_log_tail_bytes(log_path, max_bytes=8192, max_lines=max_lines)


def _build_command_args(project: dict[str, Any], custom_cmd: Optional[str] = None) -> list[str]:
    cmd_str = (custom_cmd or project.get("cmd") or "").strip()
    runtime = project.get("runtime", "python")
    workdir = Path(project.get("workdir", ""))

    if not cmd_str:
        raise ValueError("Пустая команда запуска проекта")

    parts = shlex.split(cmd_str)
    if not parts:
        raise ValueError("Не удалось разобрать команду запуска")

    if runtime == "python":
        venv_py = workdir / ".venv" / "bin" / "python"
        py_bin = str(venv_py) if venv_py.exists() else (shutil.which("python3") or "python3")
        if parts[0] in ("python", "python3", ".venv/bin/python"):
            parts[0] = py_bin
        elif not parts[0].endswith("python") and not parts[0].endswith("python3") and not os.path.isabs(parts[0]):
            parts = [py_bin] + parts
    elif runtime == "node":
        node_bin = shutil.which("node") or "node"
        if parts[0] == "node":
            parts[0] = node_bin
        elif not parts[0].endswith("node") and not os.path.isabs(parts[0]):
            parts = [node_bin] + parts
    elif runtime == "bash":
        bash_bin = "/bin/bash" if os.path.exists("/bin/bash") else (shutil.which("bash") or "bash")
        if parts[0] in ("bash", "sh", "/bin/bash", "/bin/sh"):
            parts[0] = bash_bin
        else:
            parts = [bash_bin, "-c", cmd_str]

    return parts


def _build_process_env(
    project: dict[str, Any],
    run_token: str,
    settings: dict[str, str],
    run_id: Optional[int] = None,
) -> dict[str, str]:
    env = dict(os.environ)
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

    # 3. Маркировка процессов для отлова сирот (_HUB_PROJECT_ID и _HUB_RUN_ID)
    if project.get("id") is not None:
        env["_HUB_PROJECT_ID"] = str(project["id"])
    if run_id is not None:
        env["_HUB_RUN_ID"] = str(run_id)

    # 4. Проброс переменной PORT для веб-бэкендов и сервисов
    proj_port = int(project.get("port") or 0)
    if proj_port > 0:
        env["PORT"] = str(proj_port)

    # 5. Пользовательские переменные из project.env_json
    try:
        proj_env = json.loads(project.get("env_json") or "{}")
        if isinstance(proj_env, dict):
            for k, v in proj_env.items():
                env[str(k)] = str(v)
    except Exception:
        pass

    hub_port = settings.get("port", "8050")
    env["HUB_API_URL"] = f"http://127.0.0.1:{hub_port}/internal"
    env["HUB_RUN_TOKEN"] = run_token
    env["HUB_INTERNAL_TOKEN"] = get_internal_token()

    # Подключение SDK через PYTHONPATH и NODE_PATH
    existing_py = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = f"{SDK_PYTHON_DIR}:{existing_py}" if existing_py else str(SDK_PYTHON_DIR)

    existing_node = env.get("NODE_PATH", "")
    env["NODE_PATH"] = f"{SDK_NODE_DIR}:{existing_node}" if existing_node else str(SDK_NODE_DIR)

    # Прокси проекта: индивидуальный CUSTOM_PROXY_URL или системный 127.0.0.1:10808
    custom_proxy = str(env.get("CUSTOM_PROXY_URL", "")).strip()
    if int(project.get("use_proxy", 0)) == 1:
        proxy_url = custom_proxy if custom_proxy else settings.get("proxy_url", "http://127.0.0.1:10808").strip()
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
                    env[f"HUB_SECRET_FILE_{sec['name']}"] = str(sec["file_path"])
    except Exception:
        pass

    return env


def _make_preexec_fn(run_as_user: str) -> Callable[[], None]:
    """
    Создаёт функцию preexec_fn для дочернего процесса:
    1. os.setsid() -> лидер новой группы процессов (PGID = PID).
    2. resource.setrlimit: ТОЛЬКО RLIMIT_CORE=(0,0) и RLIMIT_NOFILE=(4096,4096). (БЕЗ RLIMIT_AS!)
    3. При run_as_user == 'hub-runner' и root: группы Android 3003 (aid_inet), 3004 (aid_net_raw) + setgid/setuid.
    """
    target_uid: Optional[int] = None
    target_gid: Optional[int] = None
    if run_as_user and run_as_user != "root" and os.geteuid() == 0:
        try:
            pw = pwd.getpwnam(run_as_user)
            target_uid = pw.pw_uid
            target_gid = pw.pw_gid
        except KeyError:
            pass

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

        if target_uid is not None and target_gid is not None:
            try:
                os.setgroups([target_gid, 3003, 3004])
                os.setgid(target_gid)
                os.setuid(target_uid)
            except Exception:
                pass

    return _preexec


async def start_project_run(
    project_id: int,
    trigger: str = "manual",
    custom_cmd: Optional[str] = None,
) -> dict[str, Any]:
    """
    Запускает проект (или команду установки зависимостей) с записью вывода напрямую в файловый дескриптор лога.
    """
    allowed, reason = can_start_new_run()
    if not allowed:
        raise RuntimeError(reason)

    project = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not project:
        raise ValueError(f"Проект id={project_id} не найден")

    for r_id, info in list(ACTIVE_RUNS.items()):
        if info["project_id"] == project_id and custom_cmd is None:
            raise RuntimeError(f"Проект «{project['name']}» уже выполняется (run_id={r_id}, PID={info['pid']})")

    # Если у проекта задан сетевой порт (port > 0) и это штатный запуск (не install_deps):
    proj_port = int(project.get("port") or 0)
    if proj_port > 0 and custom_cmd is None:
        if proj_port in FORBIDDEN_PORTS:
            raise RuntimeError(f"Порт {proj_port} зарезервирован системой ({sorted(list(FORBIDDEN_PORTS))})")
        if is_tcp_port_in_use(proj_port):
            # Сначала пробуем зачистить возможные осиротевшие процессы этого же проекта
            kill_orphan_processes_by_project_id(project_id)
            if is_tcp_port_in_use(proj_port):
                raise RuntimeError(f"Порт {proj_port} уже занят другим процессом в системе")

    settings = get_all_settings()
    run_as_user = settings.get("run_as_user", "root").strip()

    workdir = Path(project["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)
    proj_log_dir = LOGS_DIR / project["name"]
    proj_log_dir.mkdir(parents=True, exist_ok=True)

    now = int(time.time())
    run_token = secrets.token_hex(24)

    temp_log_path = str(proj_log_dir / f"pending_{now}.log")
    run_id = execute_sql(
        """INSERT INTO runs (
            project_id, status, trigger, pid, pgid, proc_create_time,
            started_at, finished_at, exit_code, run_token, log_path, error_summary
        ) VALUES (?, 'running', ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, '')""",
        (project_id, trigger, now, run_token, temp_log_path),
    )

    log_path = proj_log_dir / f"{run_id}.log"
    execute_sql("UPDATE runs SET log_path = ? WHERE id = ?", (str(log_path), run_id))

    if project["type"] in ("service", "web") and custom_cmd is None:
        execute_sql(
            "UPDATE projects SET desired_state = 'running', health_status = 'starting', updated_at = ? WHERE id = ?",
            (now, project_id),
        )

    cmd_args = _build_command_args(project, custom_cmd=custom_cmd)
    env = _build_process_env(project, run_token, settings, run_id=run_id)

    if run_as_user and run_as_user != "root" and os.geteuid() == 0:
        try:
            pw = pwd.getpwnam(run_as_user)
            subprocess.run(["chown", "-R", f"{pw.pw_uid}:{pw.pw_gid}", str(workdir)], check=False)
        except KeyError:
            pass

    log_fd = open(log_path, "ab", buffering=0)
    header_line = (
        f"=== [Hub Run #{run_id}] Started at {time.strftime('%Y-%m-%d %H:%M:%S')} | "
        f"Trigger: {trigger} | Cmd: {' '.join(cmd_args)} ===\n"
    ).encode("utf-8")
    log_fd.write(header_line)

    stdin_fifo_path = proj_log_dir / f"stdin_{run_id}.fifo"
    stdin_r_fd: Optional[int] = None
    stdin_w_fd: Optional[int] = None
    try:
        if stdin_fifo_path.exists():
            stdin_fifo_path.unlink()
        os.mkfifo(stdin_fifo_path, 0o600)
        stdin_r_fd = os.open(str(stdin_fifo_path), os.O_RDONLY | os.O_NONBLOCK)
        stdin_w_fd = os.open(str(stdin_fifo_path), os.O_WRONLY | os.O_NONBLOCK)
        r_flags = fcntl.fcntl(stdin_r_fd, fcntl.F_GETFL)
        fcntl.fcntl(stdin_r_fd, fcntl.F_SETFL, r_flags & ~os.O_NONBLOCK)
    except Exception:
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
            cmd_args,
            cwd=str(workdir),
            env=env,
            stdin=stdin_r_fd if stdin_r_fd is not None else subprocess.DEVNULL,
            stdout=log_fd,
            stderr=log_fd,
            close_fds=True,
            preexec_fn=_make_preexec_fn(run_as_user),
        )
    except Exception as e:
        log_fd.write(f"\n[Hub Launch Error]: {e}\n".encode("utf-8"))
        log_fd.close()
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
        try:
            stdin_fifo_path.unlink(missing_ok=True)
        except OSError:
            pass
        execute_sql(
            "UPDATE runs SET status = 'failed', finished_at = ?, exit_code = -1, error_summary = ? WHERE id = ?",
            (int(time.time()), str(e), run_id),
        )
        raise
    finally:
        if not log_fd.closed:
            log_fd.close()
        if stdin_r_fd is not None:
            try:
                os.close(stdin_r_fd)
            except OSError:
                pass

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
        "stdin_fifo": str(stdin_fifo_path),
        "stdin_keepalive_fd": stdin_w_fd,
        "popen": proc,
        "rss_mb": 0.0,
        "cpu_percent": 0.0,
        "is_deps_install": custom_cmd is not None,
        "hc_failures": 0,
        "last_hc_ts": float(now),
    }

    return query_one("SELECT * FROM runs WHERE id = ?", (run_id,)) or {"id": run_id, "pid": pid, "pgid": pgid}


def send_stdin_to_run(run_id: int, text: str) -> bool:
    """
    Отправляет строку пользовательского ввода в stdin работающего процесса через именованный FIFO
    и дублирует эхо команды в лог-файл запуска.
    """
    row = query_one("SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?", (run_id,))
    if not row or row["status"] not in ("running", "waiting_input"):
        return False

    log_path = Path(row["log_path"])
    fifo_path = LOGS_DIR / row["project_name"] / f"stdin_{run_id}.fifo"

    clean_line = text.rstrip("\r\n")
    try:
        if log_path.exists():
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


async def stop_run(run_id: int, final_status: str = "stopped", reason_note: str = "") -> bool:
    """
    Останавливает дерево процессов по PGID + добивает сирот по _HUB_PROJECT_ID и очищает <workdir>/.tmp.
    """
    row = query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
    if not row:
        return False

    project_id = int(row["project_id"])
    proj = query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if proj and proj["type"] in ("service", "web") and final_status == "stopped":
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

        if can_signal:
            try:
                os.killpg(int(pgid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass

            for _ in range(25):
                if popen_obj is not None:
                    popen_obj.poll()
                _reap_zombies()
                alive = _get_pgid_processes(int(pgid))
                if not alive:
                    break
                await asyncio.sleep(0.2)

            if _get_pgid_processes(int(pgid)):
                try:
                    os.killpg(int(pgid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                await asyncio.sleep(0.1)
                if popen_obj is not None:
                    popen_obj.poll()
                _reap_zombies()

    # Дополнительно отлавливаем осиротевшие процессы по метке _HUB_PROJECT_ID в /proc/*/environ
    kill_orphan_processes_by_project_id(project_id)
    if proj and proj.get("workdir"):
        cleanup_project_tmp_dir(proj["workdir"])

    now = int(time.time())
    log_path = row.get("log_path", "")
    if log_path and os.path.exists(log_path):
        try:
            with open(log_path, "ab", buffering=0) as f:
                msg = f"\n=== [Hub Run #{run_id}] Terminated ({final_status}) at {time.strftime('%Y-%m-%d %H:%M:%S')} {reason_note} ===\n"
                f.write(msg.encode("utf-8"))
        except OSError:
            pass

    execute_sql(
        """UPDATE runs SET status = ?, finished_at = ?, exit_code = COALESCE(exit_code, -15), error_summary = ?
           WHERE id = ?""",
        (final_status, now, reason_note, run_id),
    )
    execute_sql(
        "UPDATE pending_asks SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'",
        (run_id,),
    )
    return True


async def stop_project(project_id: int) -> bool:
    """Останавливает активный запуск проекта, убивает сирот по _HUB_PROJECT_ID и очищает .tmp."""
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

    kill_orphan_processes_by_project_id(project_id)
    proj = query_one("SELECT workdir FROM projects WHERE id = ?", (project_id,))
    if proj and proj.get("workdir"):
        cleanup_project_tmp_dir(proj["workdir"])
    return True


def recover_running_processes() -> dict[str, int]:
    """
    КРИТИЧЕСКОЕ ПРАВИЛО #3 (Учёт ECHILD при рестарте панели):
    При старте Hub выбирает из БД все runs со статусом 'running' или 'waiting_input'.
    Проверяет psutil.Process(pid) и abs(proc.create_time() - run.proc_create_time) < 0.5.
    Если жив — добавляет в ACTIVE_RUNS в режиме psutil-пуллинга (popen=None, без waitpid!).
    Если мёртв — зачищает возможные осиротевшие подпроцессы по _HUB_PROJECT_ID и переводит run в 'failed'.
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

    for r in rows:
        run_id = r["id"]
        pid = r.get("pid")
        pgid = r.get("pgid") or pid
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
                "stdin_fifo": str(fifo_path),
                "stdin_keepalive_fd": keep_fd,
                "popen": None,
                "rss_mb": 0.0,
                "cpu_percent": 0.0,
                "is_deps_install": False,
                "hc_failures": 0,
                "last_hc_ts": float(now),
            }
            recovered += 1
        else:
            _cleanup_run_fifo(run_id, None, r["project_name"])
            kill_orphan_processes_by_project_id(int(r["project_id"]))
            execute_sql(
                """UPDATE runs
                   SET status = 'failed', exit_code = -1, finished_at = ?,
                       error_summary = 'Процесс завершился во время перезапуска Hub'
                   WHERE id = ?""",
                (now, run_id),
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
    - Проверяет завершение всех ACTIVE_RUNS.
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
            pgid_metrics_map = collect_all_pgid_metrics(target_pgids)

            for run_id, info in list(ACTIVE_RUNS.items()):
                pid = info["pid"]
                pgid = info["pgid"]
                popen_obj: Optional[subprocess.Popen[bytes]] = info.get("popen")
                project = query_one("SELECT * FROM projects WHERE id = ?", (info["project_id"],))
                if not project:
                    mem_info = ACTIVE_RUNS.pop(run_id, None)
                    _cleanup_run_fifo(run_id, mem_info)
                    continue

                # 1. Проверка завершения процесса
                exit_code: Optional[int] = info.get("reaped_exit_code")
                still_alive = False

                if exit_code is not None:
                    still_alive = False
                elif popen_obj is not None:
                    rc = popen_obj.poll()
                    if rc is None:
                        still_alive = True
                    else:
                        exit_code = int(rc)
                else:
                    try:
                        p = psutil.Process(pid)
                        if (
                            p.is_running()
                            and p.status() != "zombie"
                            and abs(p.create_time() - info["proc_create_time"]) < 0.5
                        ):
                            still_alive = True
                        else:
                            exit_code = 0
                    except psutil.NoSuchProcess:
                        exit_code = 0

                if not still_alive:
                    leftover = _get_pgid_processes(pgid)
                    if leftover:
                        try:
                            os.killpg(pgid, signal.SIGTERM)
                        except Exception:
                            pass
                    kill_orphan_processes_by_project_id(int(project["id"]))
                    cleanup_project_tmp_dir(project["workdir"])

                    mem_info = ACTIVE_RUNS.pop(run_id, None)
                    _cleanup_run_fifo(run_id, mem_info, project["name"])
                    code = exit_code if exit_code is not None else 0
                    final_status = "success" if code == 0 else "failed"
                    tail = _read_log_tail(info["log_path"], max_lines=15)
                    err_summary = tail.splitlines()[-1][:200] if (code != 0 and tail) else ""

                    try:
                        with open(info["log_path"], "ab", buffering=0) as f:
                            f.write(
                                f"\n=== [Hub Run #{run_id}] Finished with exit_code={code} ({final_status}) at {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode(
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
                        await _ON_FINISH_CALLBACK(project, code, final_status, tail)
                    continue

                # 2. Метрики RSS и CPU% по всей группе PGID из единого снимка за тик
                rss_mb, cpu_pct, _ = pgid_metrics_map.get(int(pgid), (0.0, 0.0, 0))
                info["rss_mb"] = rss_mb
                info["cpu_percent"] = cpu_pct

                # 3. Контроль лимита ОЗУ (ram_limit_mb)
                ram_limit_mb = int(project.get("ram_limit_mb") or 0)
                if ram_limit_mb > 0 and rss_mb > ram_limit_mb:
                    oom_msg = f"Превышен лимит памяти PGID: {rss_mb} МБ > {ram_limit_mb} МБ"
                    await stop_run(run_id, final_status="killed_oom", reason_note=oom_msg)
                    tail = _read_log_tail(info["log_path"], max_lines=15)
                    await send_notification(
                        f"{oom_msg}. Группа процессов PGID={pgid} принудительно остановлена.",
                        level="oom",
                        project_name=project["name"],
                        log_tail=tail,
                    )
                    if _ON_FINISH_CALLBACK and not info.get("is_deps_install"):
                        await _ON_FINISH_CALLBACK(project, -9, "killed_oom", tail)
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
                                await send_notification(
                                    f"Сервис «{project['name']}» завис ({hc_msg}). Выполнен автоматический перезапуск.",
                                    level="error",
                                    project_name=project["name"],
                                    log_tail=tail,
                                )
                                await start_project_run(int(project["id"]), trigger="healthcheck")
                                continue

        except Exception:
            pass

        await asyncio.sleep(2.0)
