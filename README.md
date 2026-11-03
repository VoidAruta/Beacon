# Hub (`VoidAruta/Hub-server`)

> **Автономная веб-панель управления фоновыми сервисами (`services`) и расписанием скриптов (`jobs`) для домашних серверов на базе старых Android-смартфонов (Linux chroot / ARM64).**
>
> *[English documentation is available below](#hub--autonomous-control-panel-for-android-linux-chroot-servers-en)*

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Platform: Linux aarch64 / Android Chroot](https://img.shields.io/badge/Platform-Android%20Chroot%20%7C%20aarch64-blue.svg)](#требования-к-железу-и-среде)
[![Python: 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg)](requirements.txt)
[![RAM Footprint: < 80 MB](https://img.shields.io/badge/Idle%20RAM-%3C%2080%20MB-amber.svg)](#почему-именно-hub-сравнение-с-аналогами)

---

## Содержание

1. [Концепция и назначение](#концепция-и-назначение)
2. [Почему именно Hub? Сравнение с аналогами](#почему-именно-hub-сравнение-с-аналогами)
3. [Скриншоты интерфейса](#скриншоты-интерфейса)
4. [Требования к железу и среде](#требования-к-железу-и-среде)
5. [Быстрый старт (установка в `/opt/hub`)](#быстрый-старт-установка-в-opthub)
6. [Обновление и удаление](#обновление-и-удаление)
7. [Локальный SDK (`hub_sdk`) и обход антибот-защиты](#локальный-sdk-hub_sdk-и-обход-антибот-защиты)
8. [Модель безопасности](#модель-безопасности)
9. [Частые вопросы (FAQ)](#частые-вопросы-faq)
10. [English Documentation (EN)](#hub--autonomous-control-panel-for-android-linux-chroot-servers-en)

---

## Концепция и назначение

Старый смартфон на базе Snapdragon со сломанным экраном или просто лежащий в ящике стола — это идеальный бесшумный домашний микросервер с встроенным ИБП (аккумулятором), потреблением **1.5–3 Вт** из розетки и 6–8 ГБ оперативной памяти.

Однако при развёртывании полноценного **Ubuntu / Debian chroot** поверх ядра Android классические серверные инструменты сталкиваются с суровой реальностью:
- **Внутри chroot нет `systemd` и `cgroups v2`**, поэтому стандартные `systemctl`-юниты и контейнеры Docker либо не работают вовсе, либо требуют пересборки ядра телефона;
- **Патч ядра `CONFIG_ANDROID_PARANOID_NETWORK`** блокирует доступ в сеть любому пользователю, не входящему в специальные группы Android `aid_inet` (`3003`) и `aid_net_raw` (`3004`);
- **Ограничения `RLIMIT_AS`** мгновенно убивают процессы с JIT/V8 (Node.js, Chromium, JVM);
- **Перезапуск панели управления** при использовании обычных пайпов (`subprocess.PIPE`) приводит к падению всех дочерних 24/7-ботов от `SIGPIPE`;
- **Круглосуточная зарядка до 100%** вздувает литий-полимерный аккумулятор через несколько месяцев, если не контролировать коридор заряда (**45–55%**) и температуру батареи.

**Hub** спроектирован специально под эти условия. Он объединяет в одном легковесном процессе (< 80 МБ ОЗУ в покое, SQLite WAL, 0 внешних брокеров):
1. **Супервизор 24/7-демонов (`service`) и планировщик задач (`job`)** с управлением группами процессов через `os.setsid()` / `os.killpg()`, прямым выводом логов в файловые дескрипторы и подхватом выживших процессов после перезапуска панели;
2. **Интерактивный CLI-терминал и двусторонний `stdin` (FIFO)** для каждого проекта — позволяет как выполнять команды (`pip`, `git`, `npm`) в папке проекта, так и вводить одноразовые коды 2FA/SMS прямо в работающий скрипт;
3. **Встроенный удалённый браузер для прохождения антибот-проверок и логина (`Куки и сессии`)** — вы один раз проходите Cloudflare Turnstile / hCaptcha / 2FA прямо в браузере панели, а ваши скрипты на Python или Node.js забирают свежие `HttpOnly` cookies одной строчкой кода;
4. **Зашифрованное хранилище секретов (`Fernet` AES-128-CBC + HMAC-SHA256)** с автоматической фильтрацией `***REDACTED***` в логах и централизованным шлюзом уведомлений в Telegram;
5. **Аппаратный мониторинг Android-хоста** (температура, уровень и статус контроллера заряда 45–55%, CPU, RAM, ZRAM/Swap, UFS-накопитель).

---

## Почему именно Hub? Сравнение с аналогами

На рынке есть отличные оркестраторы задач, но ни один из них не учитывает специфику работы внутри Android Linux chroot и задачи персональной автоматизации (боты, скрейперы с сессиями, интерактивный ввод 2FA):

| Критерий | **Hub (`Hub-server`)** | **Dagu** | **Cronicle** | **Windmill** |
| :--- | :--- | :--- | :--- | :--- |
| **Целевая ниша** | Домашний сервер на Android chroot: 24/7-боты + cron-скрипты + парсеры | DAG-пайплайны на YAML для классического Linux | Распределённый планировщик cron-задач (Node.js) | Корпоративная платформа workflow и внутренних UI |
| **Потребление ОЗУ в покое** | **~45–75 МБ** (Python + SQLite WAL) | ~30–50 МБ (Go) | ~90–150 МБ (Node.js) | **> 1.5 ГБ** (PostgreSQL + воркеры + Docker) |
| **Зависимости инфраструктуры** | **Один процесс Python + SQLite** | Один бинарник Go (файлы) | Node.js + локальное хранилище | PostgreSQL, Docker / Kubernetes |
| **Поддержка 24/7-демонов (`service`) с авторестартом и подхватом PID** | **Да** (`setsid`/`killpg` + сверка `create_time` после рестарта) | Нет (ориентирован на конечные DAG-задачи) | Частично (через долгоживущие джобы, без перехвата сирот после рестарта) | Нет (заточен под короткие serverless-скрипты) |
| **Интерактивный `stdin` в работающий процесс (ввод кода из SMS/2FA)** | **Да** (именованный канал FIFO прямо из веб-панели) | Нет | Нет | Нет |
| **Встроенный захват `HttpOnly` Cookies через интерактивный браузер** | **Да** (вкладка «Куки и сессии» + генератор кода) | Нет | Нет | Нет |
| **Специфика Android Chroot (`aid_inet` 3003, телеметрия батареи 45–55%)** | **Из коробки** | Нет | Нет | Нет |
| **Контроль лимита RAM по сумме RSS группы процессов (без `RLIMIT_AS`)** | **Да** (безопасно для Node.js, JVM, Chromium) | Нет | Нет | Через cgroups/Docker (недоступно в chroot) |

---

## Скриншоты интерфейса

> *Примечание: скриншоты интерфейса хранятся в каталоге `docs/screenshots/`.*

| Проекты и телеметрия смартфона | Логи в реальном времени, CLI-терминал и `stdin` |
| :---: | :---: |
| ![Панель проектов и телеметрия батареи](docs/screenshots/dashboard-projects.png) | ![Живые логи и интерактивный терминал](docs/screenshots/project-terminal-logs.png) |

| Интерактивный захват куки и антибот-сессий | Секреты (Fernet) и локальный `hub_sdk` |
| :---: | :---: |
| ![Удалённый браузер и экспорт куки](docs/screenshots/web-auth-cookies.png) | ![Управление секретами и SDK](docs/screenshots/secrets-and-sdk.png) |

---

## Требования к железу и среде

### Референсная конфигурация
Проект разрабатывается и круглосуточно тестируется на следующей конфигурации:
- **Устройство:** Xiaomi Poco X3 NFC (`surya`), SoC Qualcomm Snapdragon 732G (8 ядер Kryo 470, `aarch64`), 6 ГБ LPDDR4X, 128 ГБ UFS 2.1;
- **Права и питание:** Root (Magisk / KernelSU) + модуль контроллера заряда (ACC / Battery Charge Limit), удерживающий уровень заряда в диапазоне **45–55%** для предотвращения деградации и вздутия батареи;
- **Окружение Linux:** Ubuntu 24.04 LTS (`aarch64`) в chroot (через Linux Deploy, chroot-скрипт или BusyBox `chroot`), смонтированные `/proc`, `/sys`, `/dev`, `/dev/pts`;
- **ПО внутри chroot:**
  - `Python 3.11+` (`python3`, `python3-venv`, `python3-pip`);
  - `git`, `procps`, `curl`, `ca-certificates`;
  - *(Опционально)* `nodejs` / `npm` — **только если ваши собственные проекты написаны на Node.js**. Для работы самого интерфейса Hub Node.js на телефоне **не нужен** (статика уже предсобрана в `hub/static/`).

### Проверка сетевых групп Android в chroot
Чтобы непривилегированный пользователь `runner` мог открывать сокеты в ядре Android, убедитесь, что в `/etc/group` вашего chroot прописаны группы `aid_inet` и `aid_net_raw`:
```bash
groupadd -g 3003 aid_inet 2>/dev/null || true
groupadd -g 3004 aid_net_raw 2>/dev/null || true
id -u runner >/dev/null 2>&1 || useradd -m -s /bin/bash -G aid_inet,aid_net_raw runner
usermod -aG aid_inet,aid_net_raw runner
```

---

## Быстрый старт (установка в `/opt/hub`)

Вы можете установить Hub двумя способами: **через `git clone`** (рекомендуется для быстрых обновлений) или **из готового релизного архива** (с предсобранной статикой в `hub/static/`).

### Вариант А: Установка через `git clone` в `/opt/hub`

Выполните команды внутри вашего Ubuntu chroot от имени `root`:

```bash
# 1. Установка базовых системных пакетов
apt-get update && apt-get install -y python3 python3-venv python3-pip git curl ca-certificates

# 2. Клонирование репозитория в /opt/hub
git clone https://github.com/VoidAruta/Hub-server.git /opt/hub
cd /opt/hub

# 3. Создание виртуального окружения и установка легковесных зависимостей (aarch64 wheels)
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# 4. Установка локального пакета hub_sdk в режиме редактирования
pip install -e ./sdk

# 5. Копирование стартовых примеров проектов (по желанию)
cp -rn projects/examples/* projects/ 2>/dev/null || true

# 6. Самодиагностика окружения Android Chroot (8 проверок) и авто-исправление прав 0700/0600
python3 -m hub doctor

# 7. (Опционально) Прогон встроенных модульных и приёмочных тестов
python3 -m unittest discover -s tests -v

# 8. Запуск сервера Hub (по умолчанию на порту 8050)
python3 -m hub
```

### Вариант Б: Установка из готового Release-архива (без сборки статики)

```bash
mkdir -p /opt/hub && cd /opt/hub
curl -L https://github.com/VoidAruta/Hub-server/releases/latest/download/hub-server-aarch64-release.tar.gz | tar -xz --strip-components=1
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt && pip install -e ./sdk
python3 -m hub doctor
python3 -m hub
```

### Автозапуск при старте контейнера chroot
Поскольку в chroot обычно не используется `systemd`, используйте готовый скрипт запуска с защитой через `flock`:
```bash
chmod +x /opt/hub/scripts/start_hub.sh
/opt/hub/scripts/start_hub.sh
```
Добавьте вызов `/opt/hub/scripts/start_hub.sh` в `/etc/rc.local` или в хук инициализации вашего chroot-менеджера (Linux Deploy / Magisk `service.d`).

После запуска откройте в браузере в локальной сети:
```text
http://<IP-вашего-смартфона>:8050
```
*(Пароль по умолчанию при первом входе: `admin` — при первом открытии панели сверху появится баннер быстрой смены стандартного пароля.)*

---

## Обновление и удаление

### Безопасное обновление (`git pull`)
Благодаря тому, что дочерние процессы пишут логи напрямую в файлы (`buffering=0`, без `subprocess.PIPE`) и работают в собственных группах `setsid`, **обновление и перезапуск Hub не останавливают ваши работающие 24/7-сервисы** — после старта Hub автоматически подхватит их по `PID` и времени старта (`create_time`):

```bash
cd /opt/hub
git pull origin main
source .venv/bin/activate
pip install -r requirements.txt

# Перезапуск процесса самого Hub (дочерние сервисы продолжат работу!)
pkill -f "python3 -m hub" && nohup /opt/hub/.venv/bin/python3 -m hub >/var/log/hub.log 2>&1 &
```

### Полное удаление
Если вы хотите полностью удалить Hub со всеми проектами и базой данных:

```bash
# 1. Остановите сначала все дочерние проекты через веб-панель или завершите процессы
pkill -f "python3 -m hub"

# 2. (Опционально) Сохраните резервную копию ваших данных и проектов
tar -czf ~/hub-backup-$(date +%F).tar.gz /opt/hub/data /opt/hub/projects

# 3. Удалите директорию /opt/hub
rm -rf /opt/hub
```

---

## Локальный SDK (`hub_sdk`), интерактивный `hub.ask()` и работа с куки

Каждому запущенному из Hub проекту автоматически передаются переменные окружения `HUB_INTERNAL_URL=http://127.0.0.1:8050`, `HUB_INTERNAL_TOKEN=<persistent_0600_token>`, `HUB_PROJECT_ID` и `HUB_RUN_ID`. Библиотека `hub_sdk` работает на чистой стандартной библиотеке Python (`urllib.request`) и не требует внешних зависимостей.

### Пример использования `from hub_sdk import hub` в Python
```python
from hub_sdk import hub

# 1. Получение секрета (str) или JSON-списка куки Cookie-Editor (list[dict]) из data/secrets/ (0600)
api_token = hub.secret("api_token")
cookies = hub.secret("my_project_cookies")  # -> list[dict]

# 2. Блокирующий запрос ввода к пользователю (одновременно зажигает жёлтый баннер в Web UI
#    и присылает вопрос в системный Telegram-бот — достаточно ответить Reply в ТГ или нажать кнопку в браузере!)
sms_code = hub.ask("Введите 6-значный код из СМС для входа:", timeout=300)

# 3. Сигнал об устаревании куки (зажигает красный баннер замены куки в Web UI и шлёт алерт в Telegram)
if not cookies:
    hub.cookies_expired("my_project_cookies", note="Сессия истекла (HTTP 401/403)")

# 4. Отправка уведомления в системный Telegram-бот через прокси 127.0.0.1:10808
hub.notify("Парсинг успешно завершён, обработано 120 записей", level="info")

# 5. Запись структурированного сообщения в лог запуска
hub.log("Задача выполнена штатно")
```

### Двустороннее управление через системного Telegram-бота
Помимо отправки уведомлений об ошибках, OOM и устаревших куки, системный бот панели поддерживает команды управления прямо из чата администратора (`tg_chat_id`):
- `/status` — сводка по смартфону Poco X3 NFC (заряд `45–55%`, температура, напряжение, ток, CPU, ОЗУ, ZRAM, аптайм ядра и список активных процессов);
- `/projects` — полный список проектов со статусами, `PID` и потреблением памяти;
- `/start <имя_проекта>` — удалённый запуск проекта из Telegram;
- `/stop <имя_проекта>` — принудительная остановка дерева процессов проекта (`PGID`);
- `/doctor` — отчёт самодиагностики Android Chroot (8 проверок);
- `/help` — справка по доступным командам;
- **Ответ (`Reply`) на сообщение или любой текст при активном `hub.ask()`** — мгновенно передаёт код/ответ в ожидающий скрипт.

---

## Термозащита смартфона и обслуживание диска UFS

1. **Аппаратный сторож батареи (`check_android_hardware_guard`)**:
   - Каждые 30 секунд считывает датчики `/sys/class/power_supply/battery/*` (`capacity`, `temp`, `voltage_now`, `current_now`) и `/proc/meminfo` (`SwapTotal`/`SwapFree`).
   - При нагреве батареи до **`>= 43.0°C`** отправляет предупреждение в системный Telegram-бот.
   - При критическом нагреве **`>= 47.0°C`** автоматически останавливает некритичные задачи (`jobs` и сервисы без флага `autostart=1`), защищая литий-полимерный аккумулятор от вздутия.
2. **Контроль диска и SQLite WAL**:
   - Непрерывная ротация логов по схеме **`copytruncate`** (сохраняет открытые дескрипторы `O_APPEND` у 24/7-демонов).
   - Автоматическое усечение журнала `PRAGMA wal_checkpoint(TRUNCATE)` при превышении `hub.db-wal > 4 МБ` и во время ночной/ручной очистки диска.

---

## Модель безопасности

Hub спроектирован как инструмент управления вашим личным сервером. Поскольку панель по своей природе выполняет пользовательский код и предоставляет CLI-терминал:

1. **Никогда не открывайте порт `8050` напрямую в публичный Интернет** (через порт-форвардинг на роутере без защиты).
2. **Используйте локальную сеть (Wi-Fi / Ethernet) или VPN:** для доступа вне дома поднимите на смартфоне или домашнем роутере **WireGuard** или **Tailscale** (подсеть Tailscale `100.64.0.0/10` уже включена в список разрешённых по умолчанию).
3. **Многоуровневая защита из коробки**:
   - Пароли хешируются через `hashlib.scrypt` (`n=16384, r=8, p=1`), а при активном стартовом пароле `admin` панель требует его смены;
   - Локальный IPC-токен хранится в `data/internal.token` с правами `0600` (сохраняется при рестарте Hub, чтобы выжившие 24/7-демоны не теряли доступ к `hub.ask()` и `hub.secret()`);
   - Все секреты автоматически маскируются в логах и Telegram-уведомлениях через скомпилированное регулярное выражение (`***SECRET:<name>***`);
   - Встроенная защита от брутфорса как на вход в панель (`5` попыток -> блок IP на `15` минут), так и на вебхуки (`/api/webhook/{token}`).
4. Подробное описание модели угроз приведено в файле [SECURITY.md](SECURITY.md).

---

## Частые вопросы (FAQ)

<details>
<summary><b>1. Почему при установке лимита памяти в других панелях Node.js и браузеры падают с ошибкой <code>Out of Memory</code> сразу при старте?</b></summary>

Потому что вызов `resource.setrlimit(RLIMIT_AS, ...)` ограничивает *виртуальное адресное пространство*, а движок V8 (Node.js / Chromium) и JVM резервируют гигабайты виртуальных адресов под JIT-песочницу, реально потребляя при этом всего 40–80 МБ физической памяти. В Hub контроль `max_ram_mb` реализован правильно: фоновый цикл считает сумму реального физического потребления (`RSS`) по всей группе процессов `PGID` и перезапускает сервис только при реальном превышении физической памяти.
</details>

<details>
<summary><b>2. Что произойдёт с моими работающими Telegram-ботами, если я перезапущу сам Hub?</b></summary>

Они продолжат работать без единого разрыва соединения. Дочерние процессы запускаются в отдельных сессиях (`os.setsid()`) и пишут вывод напрямую в файл лога (`buffering=0`), а не в пайп родительского процесса. При следующем старте Hub вызывает `recover_running_processes()`, сверяет `PID` и точное время создания процесса (`psutil.Process(pid).create_time()`) и снова берёт выжившие процессы под свой контроль.
</details>

<details>
<summary><b>3. Скрипт падает с <code>PermissionError: [Errno 13] Permission denied</code> при попытке выполнить HTTP-запрос. Как исправить?</b></summary>

Это особенность ядра Android (`CONFIG_ANDROID_PARANOID_NETWORK`). Убедитесь, что пользователь, от имени которого запускаются скрипты, состоит в группах `3003` (`aid_inet`) и `3004` (`aid_net_raw`). См. раздел [Проверка сетевых групп Android в chroot](#проверка-сетевых-групп-android-в-chroot).
</details>

<details>
<summary><b>4. Нужно ли устанавливать Node.js на смартфон для работы веб-интерфейса Hub?</b></summary>

Нет. Веб-интерфейс Hub поставляется в виде готовой статики в папке `hub/static/` (и автоматически собирается через GitHub Actions при каждом релизе). Node.js на смартфоне нужен только в том случае, если вы сами запускаете внутри Hub свои проекты на JavaScript/TypeScript.
</details>

---
---

# Hub — Autonomous Control Panel for Android Linux Chroot Servers (EN)

**Hub (`VoidAruta/Hub-server`)** is a lightweight, self-hosted web control panel for managing 24/7 background daemons (`services`), scheduled scripts (`jobs`), interactive CLI/stdin sessions, encrypted secrets, and browser cookies — purpose-built for repurposed Android smartphones running a Linux chroot environment (e.g., Xiaomi Poco X3 NFC `surya`, Snapdragon 732G, Ubuntu 24.04 LTS `aarch64`).

### Key Highlights
- **True Process Group Isolation (`os.setsid` + `os.killpg`):** Cleanly terminates entire process trees (`SIGTERM` -> `SIGKILL`) without leaving orphaned browser or sub-shell processes.
- **Zero-Downtime Daemon Recovery:** Direct unbuffered file descriptor logging (`buffering=0`, no `subprocess.PIPE`) allows child daemons to survive Hub restarts; surviving processes are re-attached on boot with `psutil.Process(pid).create_time()` verification to prevent PID reuse bugs.
- **V8 / JVM Safe RAM Limiter:** Enforces `max_ram_mb` by summing physical `RSS` across the entire `PGID` process group instead of setting `RLIMIT_AS`.
- **Android Kernel Compatibility:** Preserves Android supplementary networking groups (`aid_inet` = `3003`, `aid_net_raw` = `3004`) and reads smartphone battery/thermal telemetry (`/sys/class/power_supply/battery/*`, 45–55% charge limiter awareness).
- **Interactive Web Session Capture & CLI Terminal:** Pass Cloudflare / 2FA challenges once in the built-in remote browser view to export `HttpOnly` cookies to `data/cookies/*.json`, or send interactive `stdin` (2FA codes, prompts) directly into a running script via named FIFO pipes.
- **Minimal Footprint:** Single Python process + SQLite (WAL mode), consuming **< 80 MB RAM** at idle with zero external brokers (no Docker, Redis, or PostgreSQL required).

### Quick Start (Ubuntu / Debian `aarch64` Chroot)
```bash
apt-get update && apt-get install -y python3 python3-venv python3-pip git curl ca-certificates
git clone https://github.com/VoidAruta/Hub-server.git /opt/hub
cd /opt/hub
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt && pip install -e ./sdk
cp -rn projects/examples/* projects/ 2>/dev/null || true
python3 -m hub
```
Open `http://<PHONE_LAN_IP>:8050` in your browser (default initial password: `admin`).

### License
Distributed under the [MIT License](LICENSE). See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for security guidelines and architectural invariants.
