# Beacon — Containerless PaaS, Process Supervisor & MCP Server (`< 80 MB RAM`)

[![License: MIT](https://img.shields.io/badge/License-MIT-indigo.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![Platform: Linux / Raspberry Pi / Android chroot](https://img.shields.io/badge/Platform-Linux%20%7C%20RPi%20%7C%20Android%20chroot-emerald.svg)](#)
[![MCP: Streamable HTTP](https://img.shields.io/badge/MCP-Streamable%20HTTP%20%2Fmcp-purple.svg)](#доступ-для-ии-агентов-mcp-и-rest-api)

> **🌍 Language / Язык:** [English Summary](#-english-overview--quick-start) | [Русская документация](#описание-на-русском)  
> **UI Languages:** Built-in `RU | EN` instant language switcher in the web panel header + **2-Click Git Self-Update** (`v2.2 / Обновить`).

---

## 🌐 English Overview & Quick Start

**Beacon** is a self-hosted, ultra-lightweight **containerless PaaS and process supervisor** (`< 80 MB RAM` idle) designed to run 24/7 Telegram/Discord bots (`service`), HTTP APIs & websites (`web`), and scheduled cron/webhook scrapers (`job`) **without Docker**.

It runs natively on **low-cost Linux VPS, Raspberry Pi / Orange Pi (`x86_64` / `aarch64`)**, and **Android home servers (`chroot` / Termux)** where Docker or `systemd` are unavailable:
- **Zero-Downtime Updates & No `SIGPIPE`:** Child `stdout`/`stderr` write directly to disk file descriptors (`buffering=0`), and processes run in isolated process groups (`os.setsid` / `os.killpg`). Restarting or updating Beacon itself never terminates running bots or web servers.
- **Built-in SDK (`import beacon` / `require('beacon')`):** Zero-install SDK injected into every project for Telegram/Webhook alerts (`beacon.notify`), `0600` secrets & `Cookie-Editor` sessions (`beacon.secret`), interactive 2FA/SMS prompts (`beacon.ask`), Dead Man's Switch (`beacon.ping`), and persistent SQLite KV state (`beacon.state`).
- **Built-in AI Agent MCP Server (`/mcp`):** Streamable HTTP Model Context Protocol server + REST API (`/api/v1/`) for **Claude Code, Cursor, and Windsurf** with granular token scopes, human-in-the-loop diff approvals, secret redaction, and an emergency AI Kill-Switch.
- **2-Click Panel Self-Update:** Click **`v2.2 / Update`** in the top navbar to check Git commits, create an automatic backup in `data/backups/`, pull updates (`git pull --ff-only`), run SQLite migrations, and seamlessly re-attach running processes.

```bash
git clone https://github.com/VoidAruta/Beacon.git beacon
cd beacon
pip install -r requirements.txt
npm install && npm run build
python3 -m beacon --port 8050
# Open http://127.0.0.1:8050 (Default password: admin)
```

**GitHub Topics / Keywords:** `containerless-paas` `process-manager` `process-supervisor` `systemd-alternative` `pm2-alternative` `telegram-bot-hosting` `mcp-server` `model-context-protocol` `raspberry-pi` `android-chroot` `termux` `self-hosted-paas` `python-supervisor`

---

## Описание на русском

**Beacon** — автономная легковесная панель управления процессами и серверная консоль (Containerless PaaS), созданная для круглосуточного (24/7) запуска и мониторинга ботов, фоновых сервисов, веб-бэкендов и периодических задач **без использования Docker**.

Панель спроектирована с жёстким бюджетом ресурсов (**< 80 МБ ОЗУ** в простое, нулевая нагрузка на CPU в фоне), поддерживает **мгновенное переключение языка интерфейса (`RU | EN`)** и **обновление из Git в 2 клика** прямо из браузера, и одинаково нативно работает в двух средах:

1. **Классические Linux-серверы** — бюджетные VPS, одноплатные компьютеры (Raspberry Pi, Orange Pi), мини-ПК и LXC-контейнеры (`x86_64` / `aarch64`, с `systemd` или без него).
2. **Домашние серверы на базе Android-устройств** — Linux в `chroot` / Termux (`aarch64`, без `systemd` и Docker, с жёсткими лимитами памяти, поддержкой сетевых групп ядра Android `aid_inet` / `aid_net_raw` и мониторингом температуры/заряда батареи).

---

## Содержание

- [English Overview & Quick Start](#-english-overview--quick-start)
- [Ключевые возможности](#ключевые-возможности)
- [Архитектура супервизора](#архитектура-супервизора)
- [Быстрый старт](#быстрый-старт)
- [Обновление панели в 2 клика (Self-Update)](#обновление-панели-в-2-клика-self-update)
- [Команды CLI и режимы запуска](#команды-cli-и-режимы-запуска)
- [Типы проектов и Config-as-Code (`project.yaml`)](#типы-проектов-и-config-as-code-projectyaml)
- [Встроенный SDK (`beacon`) для Python и Node.js](#встроенный-sdk-beacon-для-python-и-nodejs)
- [Доступ для ИИ-агентов (MCP и REST API)](#доступ-для-ии-агентов-mcp-и-rest-api)
- [Безопасность](#безопасность)
- [Переменные окружения](#переменные-окружения)
- [Тестирование](#тестирование)

---

## Ключевые возможности

### 1. Управление процессами без контейнеров
- **Три класса нагрузок:**
  - **Services (`service`)** — постоянные демоны, Telegram/Discord-боты, парсеры и воркеры с автоматическим перезапуском при падении и защитой от `crash-loop`.
  - **Web / API (`web`)** — HTTP-сервисы с передачей `$PORT`, проверкой занятости порта и активными **HTTP/TCP Healthchecks** (авторестарт после серии неудачных проверок).
  - **Jobs (`job`)** — периодические задачи по расписанию (`interval` / `cron` / `daily` `HH:MM`), запуск по внешнему вебхуку (с опциональным HMAC-SHA256 `X-Beacon-Signature`), цепочки запуска (`on_success_project_id`) и контроль **Dead Man's Switch** (`/api/ping/{ping_token}`).
- **Живая консоль и интерактивный ввод:** потоковое чтение логов в реальном времени (SSE) и отправка команд в `stdin` запущенного процесса через неблокирующий именованный FIFO-канал без разрыва пайпа.
- **Изоляция окружения каждого проекта:**
  - Автоматическое создание и подключение `.venv` (с поддержкой `uv` или стандартного `venv`) для Python и `node_modules/.bin` для Node.js.
  - Изолированные каталоги `<workdir>/.tmp` (`TMPDIR`), `<workdir>/.home` (`HOME`) и `<workdir>/.cache` (`XDG_CACHE_HOME`) внутри директории проекта.

### 2. Встроенный SDK для проектов
Любой скрипт, запущенный через Beacon, может без установки внешних пакетов импортировать модуль `beacon` (`import beacon` в Python или `const beacon = require('beacon')` в Node.js):
- отправка уведомлений владельцу в Telegram, ntfy или Webhook (`beacon.notify`);
- чтение секретов и файлов cookies из защищённого хранилища с правами `0600` (`beacon.secret`);
- **сигнал Dead Man's Switch (`beacon.ping`)** — отметка успешного завершения/живости задачи без ручного формирования HTTP-запроса;
- **интерактивный запрос (`beacon.ask`)** — процесс может запросить у владельца одноразовый код (2FA/SMS/капчу) прямо в веб-интерфейсе или Telegram и дождаться ответа без перезапуска скрипта;
- **персистентное KV-хранилище (`beacon.state`)** — сохранение курсоров, ID последних обработанных сообщений и состояния между перезапусками.

### 3. Безопасное подключение ИИ-агентов (MCP + REST API)
- Встроенный **MCP-сервер (Streamable HTTP `/mcp`)** и **REST API (`/api/v1/`)** с OpenAPI-спецификацией (`/api/v1/openapi.json`).
- Позволяет подключить Claude Code, Cursor, Windsurf или собственных агентов для диагностики логов, проверки метрик, чтения кода и деплоя правок.
- **Токены с гранулярными правами (`beacon_ai_...`)**, привязкой к конкретным проектам, IP-подсетям и лимитам запросов.
- **Очередь одобрений (Human-in-the-Loop):** изменение файлов, расписания или команды запуска формирует заявку с визуальным `unified diff`, которую владелец подтверждает или отклоняет в один клик.
- **Защита от Prompt Injection** в логах и мгновенная кнопка **«Пауза ИИ»** (Kill-Switch) в шапке панели.

### 4. Веб-интерфейс и инструментарий
- Встроенный файловый менеджер, редактор кода с проверкой изменений, просмотрщик KV-хранилища и установка зависимостей (`pip` / `uv` / `npm`) в один клик.
- Хранилище секретов (`text`, `file` и `cookie_json` с правами `0600`) с привязкой к проектам и автоматическим редактированием (`***SECRET:<имя>***`) секретов в логах.
- Менеджер веб-авторизаций и импорт/проверка `Cookie-Editor` JSON-сессий.
- Экспорт и импорт проектов в `.zip` вместе с декларативным манифестом `project.yaml`, а также полные бэкапы состояния панели и авто-ротация архивов.

---

## Архитектура супервизора

Ядро управления процессами построено вокруг пяти жёстких инвариантов, обеспечивающих выживаемость сервисов на любом оборудовании:

1. **Изоляция групп процессов (`os.setsid` / `os.killpg`):** каждый проект запускается в собственной группе процессов (`PGID`). При остановке сигналами `SIGTERM` → (ожидание 5 с) → `SIGKILL` гарантированно завершается всё дерево дочерних процессов (включая воркеры, браузеры и субпроцессы), не оставляя процессов-зомби.
2. **Прямая запись логов в файловый дескриптор (`buffering=0`, без `subprocess.PIPE`):** `stdout` и `stderr` дочернего процесса направляются напрямую в открытый файловый дескриптор лога. Благодаря этому **перезапуск или обновление самого Beacon не вызывает `SIGPIPE`** и не убивает работающие боты и веб-сервисы.
3. **Подхват выживших процессов при старте:** при запуске Beacon сверяет сохранённые в БД `pid` и время старта процесса в ОС (`abs(psutil.Process(pid).create_time() - proc_create_time) < 0.5`) и продолжает мониторинг выживших проектов в `ECHILD`-безопасном режиме.
4. **Контроль памяти по сумме RSS группы `PGID`:** лимит ОЗУ проверяется за один проход по дереву процессов группы без использования `RLIMIT_AS` (который ломает аллокатор виртуальной памяти V8/Node.js и многопоточный Python на `aarch64`).
5. **Бережная работа с накопителем (UFS / microSD):** SQLite работает в режиме `WAL` (`synchronous=NORMAL`), чтение хвоста логов выполняется через `os.SEEK_END` за `O(1)`, а ротация логов сжимает старые файлы в `.gz`.

---

## Быстрый старт

### Требования
- **Python 3.10+** (зависимости: `fastapi`, `uvicorn`, `psutil`, `pydantic`, `python-multipart`, `httpx`, `croniter` — при отсутствии внешних библиотек ядро умеет запускаться в fallback-режиме на стандартной библиотеке Python)
- **Node.js 18+** (только при самостоятельной сборке фронтенда из исходников; готовый статический интерфейс уже собран в `hub/static/`)

### 1. Установка и сборка

```bash
git clone https://github.com/VoidAruta/Beacon.git beacon
cd beacon

# Автоматическая установка (создаёт .venv, пользователя beacon-runner, каталог data/ и сервис)
sudo bash scripts/install.sh
```

Либо вручную в локальном окружении:

```bash
pip install -r requirements.txt
npm install && npm run build
python3 -m beacon --port 8050
```

После запуска панель доступна по адресу `http://127.0.0.1:8050` (или IP вашего сервера в локальной сети).

- **Пароль по умолчанию:** `admin`
- Сразу после первого входа рекомендуется сменить пароль во вкладке **«Настройки»** (минимум 8 символов). Пока установлен пароль `admin`, вход разрешён только из локальной сети (`127.0.0.1` и частные диапазоны `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`), а модуль ИИ-доступа выключен.

---

## Обновление панели в 2 клика (Self-Update)

Вам не нужно подключаться по SSH для обновления Beacon:
1. Нажмите кнопку **`v2.2 / Обновить`** (`Update`) в правом верхнем углу веб-панели.
2. Нажмите **«1. Проверить обновления в Git»** — панель выполнит `git fetch` и покажет список новых коммитов.
3. Нажмите **«2. Обновить панель (с авто-бэкапом)»** — Beacon автоматически создаст резервную копию конфигурации в `data/backups/`, подтянет свежий код (`git pull --ff-only`), применит миграции SQLite и переподхватит все запущенные проекты без их остановки (`No SIGPIPE`).

---

## Команды CLI и режимы запуска

```bash
# Стандартный запуск на указанном хосте и порту
python3 -m beacon --host 0.0.0.0 --port 8050

# Безопасный режим (Safe Mode): запуск панели БЕЗ автозапуска сервисов и расписаний
python3 -m beacon --safe-mode --port 8050

# Диагностика окружения, прав, портов, зависимостей и безопасности
python3 -m beacon doctor

# Экстренная приостановка и возобновление доступа для ИИ-агентов
python3 -m beacon ai-pause
python3 -m beacon ai-resume

# Проверка и применение миграций БД SQLite
python3 -m beacon migrate

# Создание и восстановление полной резервной копии (SQLite + secrets + проекты)
python3 -m beacon backup
python3 -m beacon restore data/backups/beacon_backup_YYYYMMDD_HHMMSS.zip

# Сброс пароля администратора через CLI (отзывает все активные сессии)
python3 -m beacon reset-password

# Генерация шаблона systemd-юнита в data/generated/beacon.service
python3 -m beacon systemd
```

### Установка как `systemd`-сервис (Linux VPS / Raspberry Pi)

```bash
python3 -m beacon systemd
sudo cp data/generated/beacon.service /etc/systemd/system/beacon.service
sudo systemctl daemon-reload
sudo systemctl enable --now beacon
sudo systemctl status beacon
```

### Запуск в Android chroot / Termux (без `systemd`)

```bash
bash scripts/zstart_line.sh
```

Скрипт идемпотентно запускает Beacon в фоне через `nohup` с перенаправлением вывода в `data/logs/beacon-daemon.log`; сам процесс Beacon записывает PID в `data/beacon.pid` и команду перезапуска в `data/start.cmd`.

---

## Типы проектов и Config-as-Code (`project.yaml`)

Настройки каждого проекта автоматически синхронизируются с файлом `project.yaml` в рабочей папке проекта (`projects/<имя>/project.yaml`). При экспорте/импорте архива или переносе папки проект восстанавливает свою конфигурацию:

```yaml
name: weather-bot
type: service
runtime: python
cmd: "python3 main.py"
port: 0
ram_limit_mb: 150
schedule_type: manual
schedule_expr: ""
restart_policy: on-failure
min_uptime_sec: 10
max_restarts: 5
restart_delay_sec: 5
heartbeat_interval_sec: 0
secrets: ["TG_BOT_TOKEN", "OPENWEATHER_KEY"]
```

---

## Встроенный SDK (`beacon`) для Python и Node.js

В каждом запускаемом проекте пути к SDK (`PYTHONPATH` и `NODE_PATH`) подключаются автоматически.

### Python (`import beacon`)

```python
import beacon

# 1. Уведомление владельцу (level: "info" | "warn" | "error")
beacon.notify("Парсер успешно запущен", level="info")

# 2. Получение секрета (строкой или путём к защищённому файлу 0600)
api_key = beacon.secret("OPENWEATHER_KEY")
cookies_file = beacon.secret("ACCOUNT_COOKIES", as_path=True)

# 3. Запрос интерактивного ввода у владельца (например, код подтверждения / 2FA)
code = beacon.ask("Введите 6-значный код подтверждения:", timeout=300)

# 4. Уведомление о протухших cookies (переводит сессию в статус "Требуется вход")
beacon.cookies_expired("ACCOUNT_COOKIES", note="Получен HTTP 403 при запросе профиля")

# 5. Сигнал Dead Man's Switch (использует BEACON_PING_TOKEN из окружения)
beacon.ping()

# 6. Персистентное KV-хранилище состояния проекта
last_id = beacon.state.get("last_processed_id", default=0)
beacon.state.set("last_processed_id", last_id + 1)
beacon.state.delete("temp_flag")
```

### Node.js (`require('beacon')`)

```javascript
const beacon = require('beacon');

async function main() {
  await beacon.notify('Воркер запущен', 'info');

  const token = await beacon.secret('API_TOKEN');
  const cursor = await beacon.state.get('cursor', 0);

  await beacon.state.set('cursor', cursor + 10);
  await beacon.ping();
}

main();
```

- Подробная инструкция для ИИ-разработчика без MCP-доступа (архитектура среды, упрощения, полный справочник SDK и готовые шаблоны): [`docs/AI-CODER-GUIDE.md`](docs/AI-CODER-GUIDE.md).

---

## Доступ для ИИ-агентов (MCP и REST API)

Beacon включает встроенный сервер **Model Context Protocol (Streamable HTTP)** на эндпоинте `/mcp` и версионированный REST API на `/api/v1/`.

### Как подключить ИИ-агента:
1. Смените стандартный пароль администратора во вкладке **«Настройки»**.
2. Откройте вкладку **«Доступ ИИ (MCP)»** и включите модуль.
3. Создайте новый токен (`beacon_ai_...`), выберите разрешённые области прав (`read`, `files:read`, `files:write`, `run`, `schedule:write`, `templates:create`, `ask:answer`), белый список проектов и разрешённые IP/CIDR.
4. Добавьте MCP-сервер в ваш клиент:

```bash
# Подключение в Claude Code
claude mcp add --transport http beacon http://<IP-СЕРВЕРА>:8050/mcp \
  --header "Authorization: Bearer beacon_ai_ваш_токен"
```

Либо в `mcp.json` (Cursor / Claude Desktop / другие клиенты):

```json
{
  "mcpServers": {
    "beacon": {
      "type": "http",
      "url": "http://127.0.0.1:8050/mcp",
      "headers": {
        "Authorization": "Bearer beacon_ai_ваш_токен"
      }
    }
  }
}
```

### Основные MCP-инструменты (18 tools)
- **Наблюдение и диагностика (`read`):** `list_projects`, `get_project`, `get_run_status`, `tail_logs`, `list_runs`, `list_schedules`, `get_device_health`, `run_doctor`.
- **Работа с файлами (`files:read`, `files:write`):** `list_files`, `read_file`, `write_file` (создаёт заявку с `unified diff` или пишет напрямую при включённом `auto_approve_projects`).
- **Управление жизненным циклом (`run`, `schedule:write`, `templates:create`, `ask:answer`):** `start_project`, `stop_project`, `restart_project`, `install_dependencies`, `update_schedule`, `create_project_from_template`, `answer_ask`.

Подробная документация по API и областям прав находится в [`docs/AI-ACCESS.md`](docs/AI-ACCESS.md), а руководство по написанию кода под Beacon без MCP — в [`docs/AI-CODER-GUIDE.md`](docs/AI-CODER-GUIDE.md).

---

## Безопасность

- **Сетевой фильтр подсетей (`ALLOWED_SUBNETS`):** доступ к панели по умолчанию разрешён только с loopback и локальных подсетей RFC1918 (`127.0.0.0/8`, `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `169.254.0.0/16`, `::1/128`). Подсеть Tailscale/CGNAT (`100.64.0.0/10`) включается отдельной опцией в настройках.
- **Сброс привилегий (`beacon-runner`):** если в системе создан непривилегированный пользователь `beacon-runner`, дочерние проекты запускаются от его имени (на Android автоматически добавляются дополнительные группы `3003 aid_inet` и `3004 aid_net_raw`). При любой ошибке сброса привилегий в `_preexec` дочерний процесс немедленно завершается с кодом `126`.
  - *Как переключить обратно на `root`:* откройте **«Настройки» → «Расширенные системные настройки» → «Пользователь запуска процессов»** и выберите `root`.
- **Защита веб-сессий:** `HttpOnly`, `SameSite=Lax` (или `SameSite=None; Secure` в preview-iframe при `BEACON_PREVIEW_MODE=1`), проверка `X-CSRF-Token` через `hmac.compare_digest` на всех изменяющих запросах (`POST`, `PUT`, `PATCH`, `DELETE`), одноразовые короткоживущие тикеты для SSE-стримов (`/api/auth/stream_ticket`) и строгий `Content-Security-Policy` без внешних источников.
- **Безопасная распаковка архивов:** потоковая проверка ZIP-архивов с лимитами на размер архива (`50 МБ`), суммарный распакованный объём (`150 МБ`), число файлов (`1000`), степень сжатия (`50:1`) и блокировкой симлинков и Path Traversal (`..`).

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BEACON_DIR` / `BEACON_BASE_DIR` | `/opt/beacon` (или корень репозитория) | Базовая директория данных, логов, бэкапов и проектов |
| `BEACON_HOST` | `0.0.0.0` | Хост привязки HTTP-сервера |
| `BEACON_PORT` | `8050` | Порт веб-панели |
| `BEACON_ADMIN_PASSWORD` | `admin` | Начальный пароль администратора (при первом создании БД) |
| `BEACON_ALLOWED_SUBNETS` | `127.0.0.0/8,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,169.254.0.0/16,::1/128` | Разрешённые подсети для доступа к панели |
| `BEACON_TRUSTED_PROXIES` | `""` (пусто) | Доверенные CIDR обратных прокси (`127.0.0.1/32` для nginx/Caddy/Docker) |

---

## Тестирование

В проекте предусмотрены модульные и интеграционные тесты ядра супервизора, механизмов безопасности, SDK, MCP-сервера и фронтенд-логики:

```bash
# Запуск тестов серверного ядра, безопасности и SDK (Python unittest)
python3 -m unittest discover -s tests -v

# Запуск тестов фронтенд-логики (TypeScript / Node test runner)
npx tsx --test src/utils/hubLogic.test.ts
```