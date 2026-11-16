# Руководство для ИИ-разработчика: как писать программы и скрипты под Beacon

> **Назначение документа:** этот файл предназначен для ИИ-ассистентов и разработчиков **без прямого MCP-доступа к панели**, которые пишут код (ботов, воркеров, парсеры, веб-API и периодические задачи) для запуска внутри **Beacon**.  
> Если ИИ-агент подключается к панели напрямую через MCP (`/mcp`) или `/api/v1/`, используйте [`docs/AI-ACCESS.md`](AI-ACCESS.md).

---

## 1. Модель исполнения Beacon: что это и как работает

**Beacon** — это легковесный супервизор процессов без Docker (`Containerless PaaS`), ориентированный на работу 24/7 на Linux VPS, одноплатных ПК (Raspberry Pi / Orange Pi) и Android (`chroot` / Termux на `aarch64`) с жёстким бюджетом памяти.

Каждый проект располагается в изолированной рабочей директории `projects/<имя_проекта>/` (допустимы латинские буквы, цифры, `_`, `-`) и относится к одному из трёх типов (`type`):

| Тип (`type`) | Назначение | Как управляется супервизором |
|---|---|---|
| **`service`** | Постоянные демоны 24/7: Telegram/Discord-боты, воркеры очередей, стримы | Автоперезапуск по `restart_policy` (`always` / `on-failure` / `no`) с экспоненциальным backoff и защитой от `crash-loop` (`min_uptime_sec`, `max_restarts`). |
| **`web`** | HTTP/REST API бэкенды, вебхук-приёмники, мини-панели | Панель пробрасывает `PORT`, проверяет, что порт не занят и не зарезервирован до старта, и периодически проверяет доступность (`/health` или TCP). 3 сбоя подряд → авторестарт. |
| **`job`** | Одноразовые или периодические задачи: парсеры, бэкапы, синхронизаторы, отчёты | Запускается вручную, по расписанию (`interval`, `cron`, `daily`), по вебхуку или по цепочке `on_success_project_id`. Имеет `timeout_sec` и ретраи (`max_retries`, `retry_delay_sec`). |

Поддерживаемые рантаймы (`runtime`): **`python`** (Python 3.10+), **`node`** (Node.js), **`bash`** (скрипты оболочки).

---

## 2. Какие задачи Beacon решает сам (не пишите это вручную)

Когда вы пишете программу под Beacon, **не нужно** реализовывать инфраструктурный бойлерплейт — супервизор уже предоставляет готовые механизмы:

1. **Не нужен собственный демонизатор, `systemd`, `pm2` или `cron` внутри скрипта**
   - Для периодических задач пишите **обычный одноразовый скрипт** (`type: job`), который выполняет шаг работы и завершается с кодом `0` (успех) или `!= 0` (ошибка). Расписание (`interval`, `cron`, `daily HH:MM`) и повторные попытки настроит панель.
   - Для постоянных программ (`service` / `web`) пишите **основной цикл на переднем плане (foreground)** — не делайте fork/демонизацию в фон. Панель сама запускает проект в собственной группе процессов (`PGID` через `os.setsid()`).

2. **Не нужна отдельная БД ради простых счётчиков, курсоров и настроек**
   - Используйте встроенное персистентное Key-Value хранилище **`beacon.state`** (на базе SQLite с WAL-журналом). Данные переживают перезапуски скрипта и перезагрузку сервера.

3. **Не нужен файл `.env` для токенов и паролей**
   - Секреты, API-ключи, сертификаты и JSON-файлы cookies хранятся в защищённом хранилище панели (`data/secrets/<имя>`, права `0600`) и читаются из кода через **`beacon.secret(...)`** **без попадания в `/proc/<pid>/environ`**.
   - Кроме того, Beacon **автоматически маскирует** в консоли/логах значения текстовых секретов и cookies длиной от 8 символов (включая URL-encoded, JSON-escaped и Base64-варианты) на `***SECRET:<имя>***`, а также типовые токены Telegram, GitHub, OpenAI/Anthropic/Slack/AWS/Bearer по регулярным выражениям.

4. **Не нужно поднимать отдельного Telegram-бота для уведомлений и 2FA**
   - `beacon.notify(text, level="info")` шлёт сообщение во все настроенные каналы панели (Telegram, ntfy, Webhook).
   - `beacon.ask(prompt, timeout=300)` позволяет запросить код подтверждения (СМС, 2FA, капчу) прямо у владельца через баннер в веб-панели или `Reply` в Telegram — без остановки и перезапуска скрипта.

5. **Не нужна ротация логов**
   - `stdout` и `stderr` процесса пишутся напрямую в открытый файловый дескриптор лога (`buffering=0`, без `subprocess.PIPE`). Перезапуск самого Beacon **не вызывает `SIGPIPE`** и не роняет запущенные проекты. Панель сама сжимает и удаляет старые логи.

6. **Не нужно вручную парсить настройки прокси**
   - Если в настройках проекта включён прокси (`use_proxy`), Beacon сам пробросит в окружение стандартные переменные `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (и в нижнем регистре), а также `NO_PROXY=127.0.0.1,localhost`.

7. **Не нужно писать отдельный скрипт мониторинга живости**
   - Для `web` и сервисов с `healthcheck_url` супервизор сам проверяет `/health` или `tcp://host:port`.
   - Для `job` и `service` есть встроенный **Dead Man's Switch** (`beacon.ping()`): если скрипт не присылает пинг в заданный интервал + grace-период, панель сама поднимает тревогу.

---

## 3. Среда выполнения, изоляция и ограничения (что важно учитывать в коде)

### 3.1. Рабочая директория и файловая изоляция
- Текущая рабочая директория процесса (`cwd`) — всегда **`projects/<имя_проекта>/`**.
- **Никогда не хардкодьте абсолютные пути** к каталогу проекта или панели: используйте относительные пути или `Path(__file__).resolve().parent` (в Node.js `__dirname`).
- Beacon автоматически создаёт и назначает изолированные системные каталоги внутри папки проекта:
  - `TMPDIR`, `TEMP`, `TMP` → `<workdir>/.tmp`
  - `HOME` → `<workdir>/.home`
  - `XDG_CACHE_HOME` → `<workdir>/.home/.cache`
- **Важно:** содержимое `<workdir>/.tmp` **автоматически очищается** после остановки последнего активного запуска проекта. Храните там только временные файлы, а постоянные данные сохраняйте в подпапке проекта (например, `./data/`) или в `beacon.state`.

### 3.2. Виртуальное окружение и зависимости
- **Python:** если в папке проекта есть `.venv/bin/python`, Beacon автоматически использует его (даже если в `cmd` написано `python3 main.py`), добавляет `<workdir>/.venv/bin` в начало `PATH`, выставляет `VIRTUAL_ENV`, `PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1` и добавляет каталог Python SDK в `PYTHONPATH`.
  - Все сторонние библиотеки обязательно перечисляйте в **`requirements.txt`** в корне проекта.
- **Node.js:** добавляет `<workdir>/node_modules/.bin` в начало `PATH` и каталог Node.js SDK в `NODE_PATH`.
  - Все зависимости перечисляйте в **`package.json`** (желательно с `package-lock.json` — тогда кнопка установки зависимостей автоматически использует воспроизводимый `npm ci`).
- Предпочитайте **лёгкие зависимости и стандартную библиотеку**, если приложение рассчитано на VPS/Android с малым объёмом ОЗУ (`ram_limit_mb` по умолчанию часто 128–256 МБ).

### 3.3. Чистое окружение (`environ` Allowlist)
Панель **не копирует** весь `os.environ` хоста в запускаемый скрипт (для изоляции и безопасности). В дочерний процесс попадают только:
- безопасный базовый набор: `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `SSL_CERT_FILE`, `SSL_CERT_DIR`;
- пользовательские переменные из настроек проекта (`env_json`, включая `CUSTOM_PROXY_URL`, `BOT_TOKEN`, `TG_CHAT_ID` и т.п.);
- `PORT` (если у проекта задан порт > 0);
- служебные переменные Beacon: `BEACON_API_URL`, `BEACON_RUN_TOKEN`, `BEACON_PING_TOKEN`, `_BEACON_PROJECT_ID`, `_BEACON_RUN_ID`;
- пути/типы привязанных секретов: `BEACON_SECRET_FILE_<NAME>`, `BEACON_SECRET_TYPE_<NAME>` (сырые значения в `environ` **не кладутся**);
- параметры разового запуска с префиксом **`PARAM_<NAME>`** (см. раздел 5.4);
- переменные прокси (только если у проекта включён `use_proxy`).

### 3.4. Права процесса и сеть (Linux & Android chroot)
- В production-установке проекты могут запускаться не от `root`, а от непривилегированного системного пользователя `beacon-runner` (на Android ему выдаются сетевые группы `3003 aid_inet` и `3004 aid_net_raw`).
- Код **не должен** пытаться писать в `/etc`, `/var/log`, `/root` или требовать `sudo`. Все файлы проекта и кеши должны жить внутри папки проекта (`./`, `$HOME`, `$TMPDIR`).

### 3.5. Сигналы завершения и контроль ОЗУ (`PGID` RSS)
- При нажатии «Стоп» или перезапуске Beacon посылает **`SIGTERM`** всей группе процессов (`PGID`), ждёт завершения до **5 секунд**, после чего принудительно завершает оставшиеся процессы сигналом **`SIGKILL`**.
  - Обязательно обрабатывайте `SIGTERM` / `SIGINT`, чтобы корректно закрывать SQLite-соединения, HTTP-сервер, Playwright/браузер или сохранять финальное состояние в `beacon.state`.
- **Ограничение памяти (`ram_limit_mb`):** Beacon суммирует RSS всех процессов в `PGID` каждые 2 секунды (и на Linux с `systemd`/cgroups v2 при работе от `root` может оборачивать запуск в `systemd-run --scope MemoryMax=<N>M`). `RLIMIT_AS` не используется, поэтому Node.js/V8 и многопоточный Python работают стабильно. Если суммарный RSS превысит лимит, группа будет остановлена со статусом `killed_oom`.
  - Если ваш скрипт порождает дочерние процессы (браузеры, ffmpeg, субпроцессы), не оставляйте их «висеть» после завершения задачи — они суммируются в общий `ram_limit_mb` и при остановке всё равно будут убиты по `PGID` / `_BEACON_PROJECT_ID`.

### 3.6. Логи и интерактивный консоль-ввод (`stdin`)
- Пишите диагностику в `stdout`/`stderr` с явным сбросом буфера:
  - Python: `print(..., flush=True)` или `logging` в `sys.stdout`.
  - Не используйте `\r` для прогресс-баров (в веб-консоли и лог-файле каждая строка лучше читается через `\n`).
- У каждого запущенного процесса подключён неблокирующий именованный FIFO-канал `stdin`: пользователь может отправить строку прямо из веб-консоли в ваш `input()` / `sys.stdin.readline()` / `process.stdin`. Но для запросов кодов (2FA, SMS, подтверждений) используйте `beacon.ask()` — он работает также через Telegram и не требует держать консоль открытой.

---

## 4. Полный справочник встроенного SDK (`beacon`)

SDK подключается автоматически — **не добавляйте `beacon` в `requirements.txt` или `package.json`**!

- **Python:** `import beacon`
- **Node.js (CommonJS):** `const beacon = require('beacon');`
- В обоих языках при сетевых сбоях/HTTP 5xx SDK автоматически делает до **3 попыток** (паузы `0.5с`, `1.5с`) в обход `HTTP_PROXY` (напрямую на `127.0.0.1`), а ошибки 4xx (`400`, `401`, `403`, `404`) выбрасывает сразу (`BeaconApiError` со свойством `status_code`).

> **Важно про `strict`:** у `notify`, `cookies_expired`, `ping` и `state.*` по умолчанию `strict=False` (`best-effort`) — при временной недоступности панели методы пишут предупреждение в `stderr` и возвращают `False` / `default`, не роняя ваш скрипт. Передавайте `strict=True`, если хотите перехватывать исключение.

### 4.1. Уведомления: `notify`
Отправляет уведомление владельцу проекта в настроенные каналы (Telegram, ntfy, Webhook).

- **Python:**
  ```python
  ok = beacon.notify("Собрано 42 новых объявления", level="info")  # 'info' | 'warn' | 'error'
  ```
- **Node.js:**
  ```javascript
  const ok = await beacon.notify('Собрано 42 новых объявления', 'info'); // 'info' | 'warn' | 'error'
  ```

### 4.2. Безопасное чтение секретов и cookies: `secret`
> **Правило ACL:** скрипт имеет доступ **только** к тем секретам, которые явно привязаны к проекту в его настройках (или `secrets` в `project.yaml`), а также к собственному профилю куки проекта с именем `<имя_проекта>_cookies`. Попытка прочитать непривязанный секрет вернёт HTTP `403`.

В Beacon существуют 3 типа секретов:
1. **`text`** (API-ключ, токен бота, пароль):
   - `beacon.secret("MY_API_KEY")` → возвращает точную `str` (числовые строки вроде `"12345"` не преобразуются в `int`).
2. **`cookie_json`** (экспорт из браузерного расширения **Cookie-Editor**):
   - `beacon.secret("my-parser_cookies")` → сразу возвращает распарсенный список объектов куки (`list[dict]` в Python, `Array<Object>` в Node.js) с полями `name`, `value`, `domain`, `path`, `httpOnly`, `secure`, `expirationDate` и др.
   - При передаче `as_path=True` (`{ asPath: true }` в JS) → возвращает путь к JSON-файлу с правами `0600`.
3. **`file`** (приватный SSH/PEM-ключ, `.session`-файл Telethon/Pyrogram, `.db`, сертификат):
   - `beacon.secret("TG_SESSION_FILE")` (или `as_path=True`) → возвращает строковый путь к файлу с правами `0600` (поддерживает и бинарные файлы!).

Если внутренний API панели временно недоступен, `beacon.secret()` автоматически использует безопасный fallback и читает файл напрямую по переменным `BEACON_SECRET_FILE_<NAME>` и `BEACON_SECRET_TYPE_<NAME>`.

### 4.3. Сигнал о протухании cookies: `cookies_expired`
Вызывайте этот метод, когда сайт вернул `401`/`403`, редирект на страницу логина или пропала авторизационная кука. Панель пометит секрет флагом `is_expired = 1`, зажжёт красный тревожный баннер в веб-интерфейсе и отправит предупреждение в Telegram.

- **Python:**
  ```python
  beacon.cookies_expired("my-parser_cookies", note="HTTP 403 на /api/profile")
  ```
- **Node.js:**
  ```javascript
  await beacon.cookies_expired('my-parser_cookies', 'HTTP 403 на /api/profile');
  ```
*(Примечание: секрет с таким именем должен уже существовать в панели и быть привязан к проекту или называться `<имя_проекта>_cookies`.)*

### 4.4. Интерактивный запрос ввода (2FA / SMS / Captcha): `ask`
Переводит текущий запуск в статус `waiting_input`, отображает поле ввода в шапке веб-панели и отправляет вопрос в Telegram. Блокирует выполнение до получения ответа от пользователя или истечения таймаута (`5..3600` секунд). Ответ пользователя **не записывается в открытый лог** (в логе появляется только `[Ввод ответа на запрос stdin >>> (скрыто)]`).

- **Python:**
  ```python
  try:
      code = beacon.ask("Введите 6-значный код из СМС:", timeout=300)
  except TimeoutError:
      beacon.notify("Не дождался SMS-кода за 5 минут", level="error")
      raise SystemExit(1)
  ```
- **Node.js:**
  ```javascript
  try {
    const code = await beacon.ask('Введите 6-значный код из СМС:', 300);
  } catch (err) {
    await beacon.notify('Не дождался SMS-кода: ' + err.message, 'error');
    process.exit(1);
  }
  ```

### 4.5. Dead Man's Switch (пульс живости): `ping`
Отправляет heartbeat-сигнал на `/api/ping/{BEACON_PING_TOKEN}`. Если в проекте задан `heartbeat_interval_sec > 0`, но в течение `heartbeat_interval_sec + heartbeat_grace_sec` пинг не поступил, Beacon переводит здоровье проекта в `unhealthy` и шлёт алерт.

- **Python:** `beacon.ping()` (или `beacon.ping(token="...")`)
- **Node.js:** `await beacon.ping()` (или `await beacon.ping(token)`)

### 4.6. Персистентное Key-Value хранилище: `beacon.state`
Хранит произвольные JSON-сериализуемые значения (`int`, `float`, `str`, `bool`, `list`, `dict`, `None`) в SQLite с привязкой к текущему проекту.
- Допустимый ключ: `^[a-zA-Z0-9_.:-]{1,128}$`
- Ограничения: не более **256 КБ** на одно значение и до **1000 ключей** на проект.

- **Python:**
  ```python
  cursor = beacon.state.get("last_post_id", default=0)
  beacon.state.set("last_post_id", cursor + 1)
  beacon.state.delete("tmp_lock")
  ```
- **Node.js:**
  ```javascript
  const cursor = await beacon.state.get('last_post_id', 0);
  await beacon.state.set('last_post_id', cursor + 1);
  await beacon.state.delete('tmp_lock');
  ```

---

## 5. Паттерны и правила для разных типов проектов

### 5.1. Веб-бэкенды и API (`type: web`)
1. **Обязательно читайте порт из `$PORT`:**
   ```python
   PORT = int(os.environ.get("PORT", "8080") or 8080)
   ```
   Не привязывайтесь жёстко к константному порту в коде, иначе панель не сможет управлять портом, а проверка занятости порта до старта не совпадёт с реальным сокетом.
2. **Реализуйте быстрый `GET /health`:**
   - Супервизор начинает проверять healthcheck через 5 секунд после старта с интервалом `healthcheck_interval_sec` (минимум 5 с, таймаут запроса 2.5 с).
   - Ответ с кодом `200..399` считается успешным; **3 ошибки подряд** вызывают автоматический перезапуск с backoff.
   - Если `healthcheck_url` не задан явно для проекта типа `web`, панель автоматически проверяет TCP-подключение на `127.0.0.1:$PORT`.
   - По умолчанию разрешены только loopback-адреса (`127.0.0.1`, `localhost`, `::1`, `0.0.0.0` или имя локального хоста).
3. Если привязываете веб-сервис только для локального прокси (Nginx/Caddy/Tailscale на этом же сервере) — слушайте `127.0.0.1`, если нужен прямой доступ в LAN — `0.0.0.0`.

### 5.2. Постоянные сервисы и боты (`type: service`)
1. Используйте корректный цикл ожидания (`time.sleep`, `asyncio.sleep`, polling/webhook), не сжигайте CPU в пустых `while True: pass`.
2. Реализуйте **корректную обработку `SIGTERM` / `SIGINT`**, чтобы уложиться в 5-секундный grace-период остановки Beacon.
3. Избегайте падений сразу после старта (в первые `min_uptime_sec`, по умолчанию 10 секунд): серия из `max_restarts` быстрых падений подряд переведёт проект в статус `crash_loop` и остановит автоперезапуск до вмешательства владельца.
4. Для Telegram-ботов:
   - Безопаснее всего читать токен через `beacon.secret("TG_BOT_TOKEN")`, а если пользователь передаёт токен через переменные окружения проекта (`BOT_TOKEN` / `TG_CHAT_ID`), поддерживать fallback:
     ```python
     token = os.environ.get("BOT_TOKEN") or beacon.secret("BOT_TOKEN")
     ```
   - Учтите: переменные из `env_json` видны в `/proc/<pid>/environ`, а секреты из `beacon.secret()` — **нет**.

### 5.3. Периодические и триггерные задачи (`type: job`)
1. **Завершайтесь корректным кодом возврата:**
   - `0` — задача выполнена успешно (сработает `notify_on_success`, если включён, и запустится следующий проект из цепочки `on_success_project_id`).
   - `!= 0` — ошибка (сработают ретраи `max_retries` через `retry_delay_sec` и отправится уведомление `notify_on_error`).
2. Защита от наложения: если плановый запуск по `cron`/`interval`/`daily` наступил, а предыдущий запуск задачи ещё идёт, планировщик автоматически пропускает новый тик.
3. **Запуск по внешнему вебхуку:**
   - В панели у каждого проекта есть `POST /api/webhook/{webhook_token}` (при активном `webhook_hmac_secret` ожидается заголовок `X-Beacon-Signature: sha256=<hmac_hex>` от тела запроса).
   - Если задача уже выполняется, вебхук вернёт `409 Conflict` (учитывайте идемпотентность).

### 5.4. Параметризованный запуск (`params_schema_json` → `PARAM_*`)
В настройках проекта можно объявить схему параметров ручного запуска (например: `[{"name": "TARGET_DATE", "label": "Дата", "default": "today"}]`). При ручном запуске с параметрами Beacon передаёт их в окружение процесса с префиксом **`PARAM_`** в верхнем регистре:
- Параметр `target_date` → переменная окружения **`PARAM_TARGET_DATE`**.
- Запрещено называть параметры зарезервированными системными именами (`PATH`, `PORT`, `HOME`, `TMPDIR`, `LD_*`, `PYTHON*`, `NODE_*`, `BEACON*`, `*PROXY*` и др.).
- В коде читайте с fallback на значение по умолчанию:
  ```python
  target_date = os.environ.get("PARAM_TARGET_DATE", "today")
  ```

---

## 6. Декларативный манифест `project.yaml` и структура папки проекта

Beacon автоматически синхронизирует настройки проекта с файлом `project.yaml` в корне проекта и считывает его при экспорте/импорте `.zip` архивов. Если вы готовите готовый проект к импорту или деплою, приложите `project.yaml` и `AGENTS.md`:

```yaml
name: my-service
type: service          # service | web | job
runtime: python        # python | node | bash
cmd: "python3 main.py" # команда запуска внутри workdir
port: 0                # TCP-порт для type=web (0 если не нужен)
ram_limit_mb: 128      # лимит RSS всей группы PGID в МБ (0 = без лимита)
schedule_type: manual  # manual | interval | cron | daily (для type=job)
schedule_expr: ""      # напр. "60" (сек >=5), "*/15 * * * *" или "03:30"
restart_policy: on-failure # always | on-failure | no
min_uptime_sec: 10     # порог стабильного старта (секунд)
max_restarts: 10       # макс. быстрых падений подряд до crash_loop
restart_delay_sec: 2   # базовая задержка рестарта (экспоненциальный backoff)
heartbeat_interval_sec: 0 # Dead Man's Switch интервал в сек (0 = выкл)
secrets: ["MY_API_KEY"]   # ТОЛЬКО имена секретов, без значений!
```

Рекомендуемая структура каталога `projects/<name>/`:
```text
projects/my-project/
├── project.yaml        # Декларативный конфиг (опционально для импорта)
├── requirements.txt    # Для Python (.venv создаётся автоматически)
├── package.json        # Для Node.js (плюс package-lock.json при наличии)
├── main.py             # Точка входа (или index.js / main.sh)
└── data/               # Постоянные локальные файлы (НЕ .tmp!)
```

---

## 7. Готовые шаблоны кода (Copy-Paste Ready)

### 7.1. Постоянный сервис / бот (`type: service`, Python)
```python
import os
import signal
import time
import beacon

RUNNING = True

def _handle_stop(signum, frame):
    global RUNNING
    print(f"[my-bot] Получен сигнал {signum}, завершаем работу...", flush=True)
    RUNNING = False

signal.signal(signal.SIGTERM, _handle_stop)
signal.signal(signal.SIGINT, _handle_stop)

def main():
    api_token = beacon.secret("BOT_API_TOKEN")
    offset = int(beacon.state.get("offset", default=0) or 0)
    print(f"[my-bot] Старт воркера (offset={offset})", flush=True)
    beacon.notify("Воркер my-bot запущен", level="info")

    while RUNNING:
        try:
            # ... основная логика шага с использованием api_token ...
            offset += 1
            beacon.state.set("offset", offset)
            beacon.ping()  # опционально, если включён Dead Man's Switch
        except Exception as exc:
            print(f"[my-bot] Ошибка цикла: {exc}", flush=True)
            beacon.notify(f"Сбой в my-bot: {exc}", level="warn")
        for _ in range(10):
            if not RUNNING:
                break
            time.sleep(0.5)

    print("[my-bot] Чистое завершение.", flush=True)

if __name__ == "__main__":
    main()
```

### 7.2. HTTP/API бэкенд (`type: web`, Python)
```python
import json
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import beacon

PORT = int(os.environ.get("PORT", "8080") or 8080)

class ApiHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True})
            return
        hits = int(beacon.state.get("hits", 0) or 0) + 1
        beacon.state.set("hits", hits)
        self._send_json(200, {"ok": True, "hits": hits})

    def log_message(self, fmt, *args):
        print(f"[web-api] {self.address_string()} - {fmt % args}", flush=True)

def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), ApiHandler)

    def _shutdown(signum, frame):
        print(f"[web-api] Остановка HTTP-сервера ({signum})...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    print(f"[web-api] Слушаем 0.0.0.0:{PORT} (/health готов)", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
```

### 7.3. Парсер с cookies, прокси и 2FA (`type: job`, Python)
```python
import os
import sys
import httpx
import beacon

COOKIE_SECRET = "my-parser_cookies"

def load_cookies_dict() -> dict[str, str]:
    raw_cookies = beacon.secret(COOKIE_SECRET)
    return {c["name"]: c["value"] for c in raw_cookies if isinstance(c, dict) and "name" in c and "value" in c}

def main():
    last_id = int(beacon.state.get("last_id", 0) or 0)
    cookies = load_cookies_dict()

    # HTTP_PROXY / HTTPS_PROXY подхватываются httpx автоматически, если trust_env=True (по умолчанию)
    with httpx.Client(cookies=cookies, timeout=20.0) as client:
        resp = client.get("https://example.com/api/feed", params={"since": last_id})
        if resp.status_code in (401, 403):
            beacon.cookies_expired(COOKIE_SECRET, note=f"HTTP {resp.status_code} на /api/feed")
            # При необходимости можно сразу запросить код подтверждения у владельца:
            # otp = beacon.ask("Сессия сброшена. Введите SMS/2FA код для переавторизации:", timeout=300)
            sys.exit(1)
        resp.raise_for_status()
        items = resp.json().get("items", [])

    if items:
        new_last_id = max(int(x["id"]) for x in items)
        beacon.state.set("last_id", new_last_id)
        beacon.notify(f"Обработано {len(items)} новых записей (last_id={new_last_id})", level="info")

    beacon.ping()
    print(f"[my-parser] Готово. Обработано: {len(items)}", flush=True)

if __name__ == "__main__":
    main()
```

### 7.4. Параметризованная задача (`type: job`, `PARAM_*`)
```python
import os
import sys
import beacon

def main():
    target_date = os.environ.get("PARAM_TARGET_DATE", "").strip()
    dry_run = os.environ.get("PARAM_DRY_RUN", "false").lower() in ("1", "true", "yes")
    if not target_date:
        print("[report-job] Переменная PARAM_TARGET_DATE не задана, используем 'yesterday'", flush=True)
        target_date = "yesterday"

    print(f"[report-job] Формируем отчёт за {target_date} (dry_run={dry_run})", flush=True)
    # ... выполнение задачи ...
    if not dry_run:
        beacon.notify(f"Отчёт за {target_date} готов", level="info")

if __name__ == "__main__":
    main()
```

### 7.5. Воркер на Node.js (`type: service`, `runtime: node`)
```javascript
const beacon = require('beacon');

let stopping = false;

function handleSignal(sig) {
  console.log(`[node-worker] Получен сигнал ${sig}, останавливаемся...`);
  stopping = true;
}

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));

async function main() {
  const apiKey = await beacon.secret('SERVICE_API_KEY');
  let count = Number(await beacon.state.get('processed_count', 0)) || 0;

  await beacon.notify('Node.js воркер запущен', 'info');

  while (!stopping) {
    // ... работа с apiKey ...
    count += 1;
    await beacon.state.set('processed_count', count);
    await beacon.ping();
    console.log(`[node-worker] Итерация #${count} завершена`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log('[node-worker] Чистое завершение.');
}

main().catch(async (err) => {
  console.error('[node-worker] Фатальная ошибка:', err);
  await beacon.notify(`Аварийная остановка node-worker: ${err.message}`, 'error');
  process.exit(1);
});
```

---

## 8. Чеклист для ИИ-разработчика перед выдачей кода

Перед тем как отдавать пользователю готовый проект под Beacon, проверьте:
1. **Нет хардкода секретов:** все ключи/токены/пароли/куки читаются через `beacon.secret(...)` (и не логируются открытым текстом).
2. **Нет зависимости `beacon` в `requirements.txt` / `package.json`:** встроенный SDK уже доступен через `PYTHONPATH` / `NODE_PATH`.
3. **Зависимости явно описаны:** все внешние пакеты добавлены в `requirements.txt` или `package.json`.
4. **Нет абсолютных путей и записи в системные каталоги:** всё работает относительно `cwd` (`projects/<name>/`), временные файлы пишутся в `$TMPDIR` (с пониманием, что `.tmp` очищается при остановке).
5. **Для `type: web`:** порт берётся из `os.environ.get("PORT")` и реализован быстрый `GET /health` (`200`).
6. **Для `type: service`:** процесс не уходит в фон, корректно обрабатывает `SIGTERM` (успевает завершиться за `< 5` сек) и не падает в мгновенный цикл.
7. **Для `type: job`:** процесс завершается сам (`0` при успехе, `!= 0` при ошибке), а параметры ручного запуска читаются через `PARAM_<NAME>`.
8. **В ответе пользователю явно перечислено, что выставить в UI Beacon:**
   - тип проекта (`service` / `web` / `job`) и команда запуска (`cmd`);
   - какие секреты создать и привязать во вкладке проекта (имена секретов);
   - нужен ли `port` + `healthcheck_url` (`/health`), прокси (`use_proxy`), `ram_limit_mb`, расписание или `params_schema`.
