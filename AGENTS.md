# AGENTS.md — Руководство для ИИ-агентов (Beacon)

Этот репозиторий содержит **Beacon** — автономную легковесную панель управления процессами (Services, Web/API, Jobs) без Docker со встроенным Streamable HTTP MCP-сервером (`/mcp`) и REST API (`/api/v1/`).

## 1. Архитектурные инварианты (НЕ НАРУШАТЬ)
1. **Изоляция групп процессов (`os.setsid` / `os.killpg`):** все дочерние процессы запускаются в собственной группе процессов и завершаются по `PGID` (`SIGTERM` → 5 с → `SIGKILL`).
2. **Прямой вывод логов в файловый дескриптор (`buffering=0`):** никогда не используйте `subprocess.PIPE` для `stdout`/`stderr` дочерних процессов, чтобы рестарт самого Beacon не вызывал `SIGPIPE`.
3. **Подхват выживших процессов (`recover_running_processes`):** сверка по `pid` и `abs(psutil.Process(pid).create_time() - proc_create_time) < 0.5` с учётом `ECHILD`.
4. **Контроль памяти по сумме RSS группы `PGID`:** не используйте `RLIMIT_AS` (ломает V8/Node.js и многопоточный Python на `aarch64`).
5. **Бюджет ОЗУ:** процесс Beacon в простое должен потреблять `< 80 МБ ОЗУ`.

## 2. Использование встроенного SDK в проектах (`import beacon`)
Во всех проектах в `projects/<name>/` автоматически подключён SDK:
- Python: `import beacon`
- Node.js: `const beacon = require('beacon')`

Доступные вызовы:
- `beacon.notify(text, level="info")`
- `beacon.secret(name, as_path=False)`
- `beacon.cookies_expired(secret_name, note="")`
- `beacon.ask(prompt, timeout=300)`
- `beacon.state.get(key, default=None)` / `beacon.state.set(key, val)` / `beacon.state.delete(key)`
