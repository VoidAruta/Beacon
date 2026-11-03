"""
Генератор шаблонов новых проектов в /opt/hub/projects/<name>:
- python: Универсальный Python-скрипт с поддержкой .venv (через uv или python3 -m venv) и SDK hub.py
- web: Веб-бэкенд / REST API с переменной $PORT и HTTP /health эндпоинтом
- tg_bot: Шаблон Telegram-бота с индивидуальным BOT_TOKEN проекта и прокси 127.0.0.1:10808
- cookie_parser: Шаблон скрипта с индивидуальными куки проекта (Cookie-Editor) и интерактивным hub.ask()
- node: Node.js проект с SDK hub.js
- bash: Bash-скрипт для системных и периодических задач
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
import hub

BOT_TOKEN = os.environ.get("BOT_TOKEN", "не_задан_токен_бота_проекта")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "не_задан_chat_id")
PROXY_URL = os.environ.get("HTTP_PROXY", "http://127.0.0.1:10808")

print(f"[{name}] Старт Telegram-бота проекта. Прокси={{PROXY_URL}}", flush=True)
hub.notify(f"Бот проекта {name} запущен (прокси {{PROXY_URL}})", level="info")

cycle = int(hub.state.get("cycle", 0) or 0)
while True:
    cycle += 1
    hub.state.set("cycle", cycle)
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
import hub

COOKIE_SECRET = "{cookie_secret_name}"
print(f"[{name}] Чтение индивидуальных куки проекта '{{COOKIE_SECRET}}'...", flush=True)

try:
    cookies = hub.secret(COOKIE_SECRET)
    print(f"[{name}] Загружено куки: {{len(cookies)}} шт.", flush=True)
except Exception as err:
    print(f"[{name}] Куки ещё не загружены ({{err}}). Отправляем сигнал cookies_expired()...", flush=True)
    hub.cookies_expired(COOKIE_SECRET, note="Загрузите свежие куки во вкладке проекта")
    raise SystemExit(1)

last_id = hub.state.get("last_item_id", 0)
print(f"[{name}] Последний обработанный ID из hub.state: {{last_id}}", flush=True)
hub.state.set("last_item_id", int(last_id) + 1)
""",
            encoding="utf-8",
        )
        (workdir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    elif template == "node" or runtime == "node":
        default_cmd = "node index.js"
        (workdir / "index.js").write_text(
            """const hub = require('hub');

async function main() {
  console.log('[node-worker] Старт процесса PID=' + process.pid + ' PORT=' + (process.env.PORT || 'none'));
  await hub.notify('Node.js проект успешно запущен', 'info');
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
import hub

PORT = int(os.environ.get("PORT", "8080") or 8080)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({{"ok": True, "service": "{name}", "port": PORT}}).encode("utf-8"))
            return
        hits = int(hub.state.get("hits", 0) or 0) + 1
        hub.state.set("hits", hits)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({{"service": "{name}", "hits": hits}}).encode("utf-8"))

    def log_message(self, fmt, *args):
        print(f"[{name}] " + (fmt % args), flush=True)

print(f"[{name}] Запуск HTTP/API сервера на 127.0.0.1:{{PORT}} (/health готов)...", flush=True)
HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
"""
        elif proj_type == "service":
            code = f"""import os
import time
import hub

print(f"[{name}] Постоянный сервис запущен (PID={{os.getpid()}}, TMPDIR={{os.environ.get('TMPDIR')}})", flush=True)
while True:
    print(f"[{name}] Работа в штатном режиме · timestamp={{time.time():.2f}}", flush=True)
    time.sleep(2.0)
"""
        else:
            code = f"""import os
import time
import hub

print(f"[{name}] Запуск задачи (PID={{os.getpid()}})", flush=True)
runs_cnt = int(hub.state.get("runs_count", 0) or 0) + 1
hub.state.set("runs_count", runs_cnt)
time.sleep(1.0)
hub.notify(f"Задача {name} выполнена (#{{runs_cnt}})!", level="info")
print(f"[{name}] Выполнение #{{runs_cnt}} завершено.", flush=True)
"""
        (workdir / "main.py").write_text(code, encoding="utf-8")
        (workdir / "requirements.txt").write_text("# Зависимости Python проекта\n", encoding="utf-8")

    return {
        "workdir": str(workdir),
        "cmd": default_cmd,
        "use_proxy": use_proxy,
    }
