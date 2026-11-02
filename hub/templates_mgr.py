"""
Генератор шаблонов новых проектов в /opt/hub/projects/<name>:
- python: Универсальный Python-скрипт с поддержкой .venv и SDK hub.py
- tg_bot: Шаблон Telegram-бота с индивидуальным BOT_TOKEN проекта и прокси 127.0.0.1:10808
- cookie_parser: Шаблон скрипта с индивидуальными куки проекта (Cookie-Editor) и интерактивным hub.ask()
- node: Node.js проект с SDK hub.js
- bash: Bash-скрипт для системных и периодических задач
"""

import json
import subprocess
from pathlib import Path
from typing import Any

from hub.config import LOGS_DIR, PROJECTS_DIR


def create_project_from_template(name: str, template: str, runtime: str, proj_type: str) -> dict[str, Any]:
    workdir = PROJECTS_DIR / name
    workdir.mkdir(parents=True, exist_ok=True)
    (LOGS_DIR / name).mkdir(parents=True, exist_ok=True)

    default_cmd = "python3 main.py"
    use_proxy = 0

    if template == "tg_bot":
        use_proxy = 1
        default_cmd = ".venv/bin/python bot.py" if (workdir / ".venv" / "bin" / "python").exists() else "python3 bot.py"
        (workdir / "bot.py").write_text(
            f"""import os
import time
import hub

# Индивидуальные данные Telegram этого проекта (задаются во вкладке «Куки и Telegram скрипта»)
BOT_TOKEN = os.environ.get("BOT_TOKEN", "не_задан_токен_бота_проекта")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "не_задан_chat_id")
PROXY_URL = os.environ.get("HTTP_PROXY", "http://127.0.0.1:10808")

print(f"[{name}] Старт Telegram-бота проекта. Прокси={{PROXY_URL}}", flush=True)
print(f"[{name}] Целевой TG_CHAT_ID={{TG_CHAT_ID}}, BOT_TOKEN задан={{BOT_TOKEN != 'не_задан_токен_бота_проекта'}}", flush=True)

hub.notify(f"Бот проекта {name} запущен (прокси {{PROXY_URL}})", level="info")

cycle = 0
while True:
    cycle += 1
    print(f"[{name}] Ожидание событий Telegram Bot API... цикл #{{cycle}}", flush=True)
    time.sleep(2.0)
""",
            encoding="utf-8",
        )
        (workdir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    elif template == "cookie_parser":
        use_proxy = 1
        default_cmd = "python3 main.py"
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
    hub.cookies_expired(COOKIE_SECRET, note="Загрузите свежие куки во вкладке проекта «Куки и Telegram скрипта»")
    raise SystemExit(1)

print(f"[{name}] Проверка авторизации прошла успешно.", flush=True)
# Пример запроса СМС-кода при двухфакторной авторизации:
# code = hub.ask("Введите код подтверждения из СМС:", timeout=300)
""",
            encoding="utf-8",
        )
        (workdir / "requirements.txt").write_text("httpx>=0.27.2\n", encoding="utf-8")

    elif template == "node" or runtime == "node":
        default_cmd = "node index.js"
        (workdir / "index.js").write_text(
            """const hub = require('hub');

async function main() {
  console.log('[node-worker] Старт процесса PID=' + process.pid);
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

echo "[bash-runner] Проект запущен. PID=$$, Workdir=$(pwd)"
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
        try:
            if not (workdir / ".venv").exists():
                subprocess.run(
                    ["python3", "-m", "venv", "--without-pip", str(workdir / ".venv")],
                    timeout=5,
                    check=False,
                    capture_output=True,
                )
        except Exception:
            pass

        if (workdir / ".venv" / "bin" / "python").exists():
            default_cmd = ".venv/bin/python main.py"
        else:
            default_cmd = "python3 main.py"

        if proj_type == "service":
            code = f"""import os
import time
import hub

print(f"[{name}] Постоянная программа запущена (PID={{os.getpid()}})", flush=True)
while True:
    print(f"[{name}] Работа в штатном режиме · timestamp={{time.time():.2f}}", flush=True)
    time.sleep(2.0)
"""
        else:
            code = f"""import os
import time
import hub

print(f"[{name}] Запуск скрипта по заданию (PID={{os.getpid()}})", flush=True)
time.sleep(1.0)
hub.notify("Скрипт {name} успешно выполнил задачу!", level="info")
print("[{name}] Выполнение завершено.", flush=True)
"""
        (workdir / "main.py").write_text(code, encoding="utf-8")
        (workdir / "requirements.txt").write_text("# Зависимости Python проекта\n", encoding="utf-8")

    return {
        "workdir": str(workdir),
        "cmd": default_cmd,
        "use_proxy": use_proxy,
    }
