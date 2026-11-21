# AGENTS.md — Руководство для ИИ-агентов (Beacon)

Этот репозиторий содержит **Beacon** (`v2.4.1`) — автономную легковесную панель управления процессами (`service`, `web`, `job`) без Docker со встроенным Streamable HTTP MCP-сервером (`/mcp`) и REST API (`/api/v1/`).

## 1. Архитектурные инварианты (НЕ НАРУШАТЬ)
1. **Изоляция групп процессов (`os.setsid` / `os.killpg`):** все дочерние процессы запускаются в собственной группе процессов и завершаются по `PGID` (`SIGTERM` → 5 с → `SIGKILL`).
2. **Прямой вывод логов в файловый дескриптор (`buffering=0`):** никогда не используйте `subprocess.PIPE` для `stdout`/`stderr` дочерних процессов, чтобы рестарт самого Beacon не вызывал `SIGPIPE`.
3. **Подхват выживших процессов (`recover_running_processes`):** сверка по `pid` и `abs(psutil.Process(pid).create_time() - proc_create_time) < 0.5` с учётом `ECHILD`.
4. **Контроль памяти по сумме RSS группы `PGID`:** не используйте `RLIMIT_AS` (ломает V8/Node.js и многопоточный Python на `aarch64`).
5. **Бюджет ОЗУ:** процесс Beacon в простое должен потреблять `< 80 МБ ОЗУ`.
6. **Канонические пути и секреты:** база данных SQLite хранится в `data/hub.db` (поддерживается миграция и восстановление из бэкапов); приватные файлы секретов пишутся атомарно с правами `0600` и отказом от симлинков; сырые значения секретов никогда не передаются в `os.environ`.

## 2. Использование встроенного SDK в проектах (`import beacon`)
Во всех проектах в `projects/<name>/` автоматически подключён SDK (без установки из PyPI/npm):
- Python: `import beacon`
- Node.js: `const beacon = require('beacon')`

Доступные вызовы:
- `beacon.notify(text, level="info", strict=False)` — отправка уведомлений (Telegram, Discord, Slack, ntfy, Webhook)
- `beacon.secret(name, as_path=False)` — чтение привязанного секрета (`text`, `cookie_json`, `file`)
- `beacon.cookies_expired(secret_name, note="", strict=False)` — пометка истёкших cookies и тревожный баннер
- `beacon.ask(prompt, timeout=300)` — блокирующий запрос 2FA/SMS/капчи (`timeout` в пределах `1..3600` с)
- `beacon.ping(token=None, strict=False)` — сигнал Dead Man's Switch
- `beacon.state.get(key, default=None, strict=False)` / `beacon.state.set(key, val, strict=False)` / `beacon.state.delete(key, strict=False)` — персистентное SQLite KV-хранилище

SDK по умолчанию отправляет `X-Beacon-Token` только на loopback (`127.0.0.1` / `localhost` / `::1`), не следует HTTP-редиректам (`3xx`), ограничивает размер ответа 16 МБ и маскирует учётные данные/токены в URL ошибок.

## 3. Проверка изменений
Перед завершением задач запускайте проверки:
```bash
python3 -m unittest discover -s tests -v
npx tsx --test src/utils/hubLogic.test.ts
npm run lint && npm run build
bash -n scripts/install.sh scripts/update.sh scripts/zstart_line.sh
```
