"""
Генератор шаблонов новых проектов в projects/<name>:
- python: Универсальный Python-скрипт с поддержкой .venv (через uv или python3 -m venv) и SDK beacon
- web: Веб-бэкенд / REST API с переменной $PORT и HTTP /health эндпоинтом
- tg_bot: Шаблон Telegram-бота с индивидуальным BOT_TOKEN проекта
- cookie_parser: Шаблон скрипта с индивидуальными куки проекта (Cookie-Editor) и интерактивным ask()
- node: Node.js проект с SDK beacon
- bash: Bash-скрипт для системных и периодических задач
Также автоматически генерирует AGENTS.md (контекст для ИИ-агентов) и project.yaml (конфигурация как код).
"""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from hub.config import LOGS_DIR, PROJECTS_DIR


def _ensure_python_venv(workdir: Path) -> None:
    """Создаёт изолированное окружение .venv через uv (если установлен) или python3 -m venv."""
    venv_dir = workdir / ".venv"
    if (venv_dir / "bin" / "python").exists():
        return
    uv_bin = shutil.which("uv")
    try:
        if uv_bin:
            subprocess.run([uv_bin, "venv", str(venv_dir)], timeout=10, check=False, capture_output=True)
            return
        res = subprocess.run(["python3", "-m", "venv", str(venv_dir)], timeout=10, check=False, capture_output=True)
        if res.returncode != 0:
            subprocess.run(
                ["python3", "-m", "venv", "--without-pip", str(venv_dir)],
                timeout=10,
                check=False,
                capture_output=True,
            )
            if (venv_dir / "bin" / "python").exists():
                subprocess.run(
                    [str(venv_dir / "bin" / "python"), "-m", "ensurepip", "--upgrade"],
                    timeout=10,
                    check=False,
                    capture_output=True,
                )
    except Exception:
        pass


def write_project_agents_md(
    workdir: Path | str,
    name: str,
    proj_type: str = "service",
    runtime: str = "python",
    cmd: str = "",
    secrets_list: list[str] | None = None,
    env_keys: list[str] | None = None,
) -> Path:
    """Генерирует локальный файл AGENTS.md внутри директории проекта для ИИ-агентов (MCP / Claude Code / Cursor)."""
    wdir = Path(workdir)
    agents_file = wdir / "AGENTS.md"
    sec_line = f"- **Привязанные секреты:** {', '.join(secrets_list) if secrets_list else 'нет'}\n" if secrets_list is not None else ""
    env_line = f"- **Переменные окружения (ключи):** {', '.join(env_keys) if env_keys else 'нет'}\n" if env_keys is not None else ""
    content = f"""# AGENTS.md — Контекст проекта «{name}» (Beacon Control Panel)

Этот проект выполняется под управлением легковесного супервизора **Beacon Control Panel** без Docker.

## 1. Среда выполнения и изоляция
- **Тип проекта:** `{proj_type}` (`service` — демон 24/7, `web` — HTTP/API сервер с `$PORT`, `job` — задача по расписанию/вручную).
- **Рантайм:** `{runtime}` (рабочая директория: `{wdir}`, команда: `{cmd or 'main.py'}`).
{sec_line}{env_line}- **Изолированные каталоги:** `TMPDIR={wdir}/.tmp`, `HOME={wdir}/.home`, виртуальное окружение Python: `.venv/bin/python`.
- **Логирование:** весь вывод `stdout` и `stderr` пишется напрямую в файловый дескриптор лога (`buffering=0`, без `subprocess.PIPE`). Всегда используйте `flush=True` в `print()`.

## 2. Встроенный SDK (`import beacon` или `import hub`)
В Python (`PYTHONPATH`) и Node.js (`NODE_PATH`) автоматически доступен встроенный SDK:

```python
import beacon  # (также поддерживается: import hub)

# 1. Отправка уведомлений в Telegram / ntfy / Webhook
beacon.notify("Парсинг завершён успешно", level="info")  # 'info' | 'warn' | 'error'

# 2. Безопасное чтение секретов и куки (значения читаются из файлов 0600, не светятся в /proc/*/environ)
api_key = beacon.secret("MY_API_KEY")
cookies = beacon.secret("{name}_cookies")  # для типа cookie_json возвращает list[dict]

# 3. Сигнал об устаревших куки (зажигает красный баннер в UI и шлёт алерт в Telegram)
beacon.cookies_expired("{name}_cookies", note="Требуется повторный вход")

# 4. Блокирующий запрос 2FA / СМС-кода у владельца (через веб-панель или Reply в Telegram)
code = beacon.ask("Введите код подтверждения из СМС:", timeout=300)

# 5. Персистентное Key-Value состояние проекта в SQLite (переживает рестарты)
last_id = beacon.state.get("last_id", default=0)
beacon.state.set("last_id", last_id + 1)
```

## 3. Правила безопасности для ИИ-агентов
1. **Никогда не хардкодьте секреты и токены** в исходном коде — используйте `beacon.secret("<NAME>")` или переменные из `project.yaml`.
2. **Не выходите за пределы рабочей директории проекта** (`..` / абсолютные системные пути заблокированы).
3. Для установки пакетов используйте файл `requirements.txt` (Python) или `package.json` (Node.js) и инструмент `install_dependencies`.
"""
    try:
        wdir.mkdir(parents=True, exist_ok=True)
        agents_file.write_text(content, encoding="utf-8")
    except OSError:
        pass
    return agents_file


def sync_project_yaml(workdir_or_meta: Path | str | dict[str, Any], meta: dict[str, Any] | None = None) -> Path:
    """
    Сохраняет декларативный манифест project.yaml в папке проекта (Config as Code).
    Содержит только имена привязанных секретов (без их секретных значений!).
    Принимает либо (proj_dict), либо (workdir, meta_dict) и возвращает Path к project.yaml.
    """
    if isinstance(workdir_or_meta, dict):
        proj_meta = workdir_or_meta
        wdir = Path(proj_meta.get("workdir") or (PROJECTS_DIR / str(proj_meta.get("name", "project"))))
    else:
        wdir = Path(workdir_or_meta)
        proj_meta = meta or {}

    wdir.mkdir(parents=True, exist_ok=True)
    yaml_file = wdir / "project.yaml"
    name = proj_meta.get("name", wdir.name)
    proj_type = proj_meta.get("type", "service")
    runtime = proj_meta.get("runtime", "python")
    cmd = proj_meta.get("cmd", "python3 main.py")
    port = int(proj_meta.get("port") or 0)
    ram_limit_mb = int(proj_meta.get("ram_limit_mb") or 0)
    schedule_type = proj_meta.get("schedule_type", "manual")
    schedule_expr = proj_meta.get("schedule_expr", "")
    restart_policy = proj_meta.get("restart_policy", "on-failure")
    min_uptime_sec = int(proj_meta.get("min_uptime_sec") or 10)
    max_restarts = int(proj_meta.get("max_restarts") or 10)
    restart_delay_sec = int(proj_meta.get("restart_delay_sec") or 2)
    heartbeat_interval_sec = int(proj_meta.get("heartbeat_interval_sec") or 0)
    secrets_list = proj_meta.get("secrets", proj_meta.get("secrets_json", []))
    if isinstance(secrets_list, str):
        try:
            secrets_list = json.loads(secrets_list)
        except Exception:
            secrets_list = []

    lines = [
        "# Декларативная конфигурация проекта Beacon (project.yaml)",
        f"name: {name}",
        f"type: {proj_type}",
        f"runtime: {runtime}",
        f"cmd: {json.dumps(str(cmd), ensure_ascii=False)}",
        f"port: {port}",
        f"ram_limit_mb: {ram_limit_mb}",
        f"schedule_type: {schedule_type}",
        f"schedule_expr: {json.dumps(str(schedule_expr))}",
        f"restart_policy: {restart_policy}",
        f"min_uptime_sec: {min_uptime_sec}",
        f"max_restarts: {max_restarts}",
        f"restart_delay_sec: {restart_delay_sec}",
        f"heartbeat_interval_sec: {heartbeat_interval_sec}",
        f"secrets: {json.dumps(list(secrets_list), ensure_ascii=False)}",
    ]
    try:
        yaml_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass
    return yaml_file


def parse_simple_project_yaml(text: str) -> dict[str, Any]:
    """Разбирает project.yaml (поддерживает стандартный key: value и JSON-значения без внешних зависимостей)."""
    out: dict[str, Any] = {}
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        key = k.strip()
        val_str = v.strip()
        if not val_str:
            out[key] = ""
            continue
        try:
            out[key] = json.loads(val_str)
        except Exception:
            if val_str.isdigit():
                out[key] = int(val_str)
            elif val_str.lower() in ("true", "yes"):
                out[key] = True
            elif val_str.lower() in ("false", "no"):
                out[key] = False
            else:
                out[key] = val_str.strip("'\"")
    return out


def create_project_from_template(name: str, template: str, runtime: str, proj_type: str) -> dict[str, Any]:
    workdir = PROJECTS_DIR / name
    workdir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / name).mkdir(parents=True, exist_ok=True)
    (workdir / ".tmp").mkdir(parents=True, exist_ok=True)
    (workdir / ".home").mkdir(parents=True, exist_ok=True)

    default_cmd = "python3 main.py"
    use_proxy = 0

    if template == "tg_bot":
        _ensure_python_venv(workdir)
        use_proxy = 1
        default_cmd = ".venv/bin/python bot.py" if (workdir / ".venv" / "bin" / "python").exists() else "python3 bot.py"
        (workdir / "bot.py").write_text(
            f"""import os
import time
import beacon

BOT_TOKEN = os.environ.get("BOT_TOKEN", "не_задан_токен_бота_проекта")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "не_задан_chat_id")
PROXY_URL = os.environ.get("HTTP_PROXY", "")

print(f"[{name}] Старт Telegram-бота проекта. Прокси={{PROXY_URL or 'прямое соединение'}}", flush=True)
beacon.notify(f"Бот проекта {name} запущен", level="info")

cycle = int(beacon.state.get("cycle", 0) or 0)
while True:
    cycle += 1
    beacon.state.set("cycle", cycle)
    print(f"[{name}] Ожидание событий Telegram Bot API... цикл #{{cycle}}", flush=True)
    time.sleep(2.0)
""",
            encoding="utf-8",
        )
        (workdir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    elif template == "cookie_parser":
        _ensure_python_venv(workdir)
        use_proxy = 1
        default_cmd = ".venv/bin/python main.py" if (workdir / ".venv" / "bin" / "python").exists() else "python3 main.py"
        cookie_secret_name = f"{name}_cookies"
        (workdir / "main.py").write_text(
            f"""import os
import time
import beacon

COOKIE_SECRET = "{cookie_secret_name}"
print(f"[{name}] Чтение индивидуальных куки проекта '{{COOKIE_SECRET}}'...", flush=True)

try:
    cookies = beacon.secret(COOKIE_SECRET)
    print(f"[{name}] Загружено куки: {{len(cookies)}} шт.", flush=True)
except Exception as err:
    print(f"[{name}] Куки ещё не загружены ({{err}}). Отправляем сигнал cookies_expired()...", flush=True)
    beacon.cookies_expired(COOKIE_SECRET, note="Загрузите свежие куки во вкладке проекта")
    raise SystemExit(1)

last_id = beacon.state.get("last_item_id", 0)
print(f"[{name}] Последний обработанный ID из beacon.state: {{last_id}}", flush=True)
beacon.state.set("last_item_id", int(last_id) + 1)
""",
            encoding="utf-8",
        )
        (workdir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    elif template == "fastapi":
        _ensure_python_venv(workdir)
        default_cmd = ".venv/bin/python main.py" if (workdir / ".venv" / "bin" / "python").exists() else "python3 main.py"
        (workdir / "main.py").write_text(
            f"""import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
import beacon

PORT = int(os.environ.get("PORT", "18080") or 18080)

class ApiHandler(BaseHTTPRequestHandler):
    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {{"ok": True, "service": "{name}", "port": PORT, "status": "healthy"}})
            return
        requests_total = int(beacon.state.get("requests_total", 0) or 0) + 1
        beacon.state.set("requests_total", requests_total)
        self._send_json(200, {{"service": "{name}", "path": self.path, "requests_total": requests_total}})

    def log_message(self, fmt, *args):
        print(f"[{name}] " + (fmt % args), flush=True)

HOST = os.environ.get("HOST", "127.0.0.1")
server = HTTPServer((HOST, PORT), ApiHandler)

def _graceful_stop(signum, _frame):
    print(f"[{name}] Получен сигнал {{signum}}, корректная остановка HTTP-сервера...", flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, _graceful_stop)
signal.signal(signal.SIGINT, _graceful_stop)

print(f"[{name}] Микросервис API запущен на http://127.0.0.1:{{PORT}} (/health активен)", flush=True)
server.serve_forever()
""",
            encoding="utf-8",
        )
        (workdir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    elif template == "webhook_job":
        _ensure_python_venv(workdir)
        default_cmd = ".venv/bin/python main.py" if (workdir / ".venv" / "bin" / "python").exists() else "python3 main.py"
        (workdir / "main.py").write_text(
            f"""import os
import time
import beacon

target_env = os.environ.get("PARAM_TARGET", "production")
dry_run = os.environ.get("PARAM_DRY_RUN", "false")
run_num = int(beacon.state.get("runs_count", 0) or 0) + 1
beacon.state.set("runs_count", run_num)

print(f"[{name}] Старт задачи #{{run_num}} · PARAM_TARGET={{target_env}} · PARAM_DRY_RUN={{dry_run}}", flush=True)
time.sleep(1.0)
beacon.notify(f"Задача {name} (#{{run_num}}, target={{target_env}}) успешно выполнена", level="info")
print(f"[{name}] Завершено успешно.", flush=True)
""",
            encoding="utf-8",
        )
        (workdir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    elif template == "node_api":
        default_cmd = "node index.js"
        (workdir / "index.js").write_text(
            f"""const http = require('http');
const beacon = require('beacon');

const PORT = Number(process.env.PORT || 18080);

const server = http.createServer(async (req, res) => {{
  if (req.url === '/health') {{
    res.writeHead(200, {{ 'Content-Type': 'application/json' }});
    res.end(JSON.stringify({{ ok: true, service: '{name}', port: PORT }}));
    return;
  }}
  const hits = Number((await beacon.state.get('hits', 0)) || 0) + 1;
  await beacon.state.set('hits', hits);
  res.writeHead(200, {{ 'Content-Type': 'application/json' }});
  res.end(JSON.stringify({{ service: '{name}', url: req.url, hits }}));
}});

process.on('SIGTERM', () => {{
  console.log('[{name}] SIGTERM received, shutting down HTTP server...');
  server.close(() => process.exit(0));
}});

const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {{
  console.log('[{name}] Node.js HTTP API listening on http://' + HOST + ':' + PORT + ' (/health ready)');
}});
""",
            encoding="utf-8",
        )
        (workdir / "package.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "version": "1.0.0",
                    "main": "index.js",
                    "scripts": {"start": "node index.js"},
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    elif template == "node" or runtime == "node":
        default_cmd = "node index.js"
        (workdir / "index.js").write_text(
            """const beacon = require('beacon');

async function main() {
  console.log('[node-worker] Старт процесса PID=' + process.pid + ' PORT=' + (process.env.PORT || 'none'));
  await beacon.notify('Node.js проект успешно запущен', 'info');
  setInterval(() => {
    console.log('[node-worker] Heartbeat ' + new Date().toISOString());
  }, 2000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
""",
            encoding="utf-8",
        )
        (workdir / "package.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "version": "1.0.0",
                    "main": "index.js",
                    "scripts": {"start": "node index.js"},
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    elif template == "bash" or runtime == "bash":
        default_cmd = "bash main.sh"
        script_path = workdir / "main.sh"
        script_path.write_text(
            """#!/usr/bin/env bash
set -euo pipefail

echo "[bash-runner] Проект запущен. PID=$$, Workdir=$(pwd), TMPDIR=${TMPDIR:-/tmp}"
for i in 1 2 3; do
    echo "[bash-runner] Шаг выполнения #${i}..."
    sleep 1
done
echo "[bash-runner] Успешное завершение."
""",
            encoding="utf-8",
        )
        try:
            script_path.chmod(0o755)
        except OSError:
            pass

    else:
        _ensure_python_venv(workdir)
        if (workdir / ".venv" / "bin" / "python").exists():
            default_cmd = ".venv/bin/python main.py"
        else:
            default_cmd = "python3 main.py"

        if proj_type == "web" or template == "web":
            code = f"""import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
import beacon

PORT = int(os.environ.get("PORT", "8080") or 8080)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({{"ok": True, "service": "{name}", "port": PORT}}).encode("utf-8"))
            return
        hits = int(beacon.state.get("hits", 0) or 0) + 1
        beacon.state.set("hits", hits)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({{"service": "{name}", "hits": hits}}).encode("utf-8"))

    def log_message(self, fmt, *args):
        print(f"[{name}] " + (fmt % args), flush=True)

HOST = os.environ.get("HOST", "127.0.0.1")
print(f"[{name}] Запуск HTTP/API сервера на {{HOST}}:{{PORT}} (/health готов)...", flush=True)
HTTPServer((HOST, PORT), Handler).serve_forever()
"""
        elif proj_type == "service":
            code = f"""import os
import time
import beacon

print(f"[{name}] Постоянный сервис запущен (PID={{os.getpid()}}, TMPDIR={{os.environ.get('TMPDIR')}})", flush=True)
while True:
    print(f"[{name}] Работа в штатном режиме · timestamp={{time.time():.2f}}", flush=True)
    time.sleep(2.0)
"""
        else:
            code = f"""import os
import time
import beacon

print(f"[{name}] Запуск задачи (PID={{os.getpid()}})", flush=True)
runs_cnt = int(beacon.state.get("runs_count", 0) or 0) + 1
beacon.state.set("runs_count", runs_cnt)
time.sleep(1.0)
beacon.notify(f"Задача {name} выполнена (#{{runs_cnt}})!", level="info")
print(f"[{name}] Выполнение #{{runs_cnt}} завершено.", flush=True)
"""
        (workdir / "main.py").write_text(code, encoding="utf-8")
        (workdir / "requirements.txt").write_text("# Зависимости Python проекта\n", encoding="utf-8")

    write_project_agents_md(workdir, name, runtime=runtime, proj_type=proj_type)
    sync_project_yaml(
        workdir,
        {
            "name": name,
            "type": proj_type,
            "runtime": runtime,
            "cmd": default_cmd,
            "use_proxy": use_proxy,
        },
    )

    return {
        "workdir": str(workdir),
        "cmd": default_cmd,
        "use_proxy": use_proxy,
    }
