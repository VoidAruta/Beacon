# Beacon (Hub ControlPanel) v2.2.0 — Autonomous Lightweight Operations Console & Containerless PaaS

**Beacon** (ранее **Hub ControlPanel**, обратная совместимость с `hub` полностью сохранена) — автономная легковесная веб-панель и супервизор процессов для круглосуточного (24/7) управления ботами, сервисами, веб-API и фоновыми задачами **без использования Docker**, со встроенным **MCP-сервером (`/mcp`)** и **REST API (`/api/v1/`)** для безопасного управления проектами через ИИ-агентов (Claude Code, Cursor, OpenAI Codex, локальные LLM).

Панель потребляет **< 45–60 МБ ОЗУ** в простое и одинаково стабильно работает в двух целевых средах:
1. **Домашние серверы на базе Android-смартфонов** (Ubuntu 24.04 в chroot / Termux, `aarch64`, без `systemd` и Docker, с жёсткими лимитами памяти, `aid_inet=3003` и аппаратным контролем температуры батареи).
2. **Классические Linux-серверы** (бюджетные VPS, Raspberry Pi / Orange Pi, мини-ПК, LXC-контейнеры с `systemd` или без него).

---

## Быстрый старт и CLI

```bash
# Установка зависимостей и сборка фронтенда
bash scripts/install.sh

# Запуск панели (по умолчанию порт 8050)
python3 -m beacon --port 8050
# Или через совместимый алиас:
python3 -m hub --port 8050

# Запуск в Safe Mode (без автозапуска сервисов и крон-задач)
python3 -m beacon --safe-mode

# Самодиагностика среды и безопасности
python3 -m beacon doctor

# Мгновенная блокировка/разблокировка ИИ-доступа из терминала
python3 -m beacon ai-pause
python3 -m beacon ai-resume

# Миграция схемы БД и проверка путей
python3 -m beacon migrate
```

---

## Безопасность, пароль по умолчанию и права `hub-runner`

- **Пароль по умолчанию `admin`:** меняется в разделе «Настройки» (минимум 8 символов для любого нового пароля). На диск пароль никогда не записывается открытым текстом (`data/initial_password` не создаётся). Пока активен пароль `admin`:
  - В интерфейсе отображается постоянный жёлтый баннер предупреждения, а `beacon doctor` выводит `WARN`.
  - Вход в панель разрешён **только** с loopback (`127.0.0.0/8`, `::1/128`) и частных сетей RFC1918 (`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`).
  - Доступ для ИИ-агентов принудительно заблокирован.
- **Пользователь запуска процессов (`hub-runner`):** если в системе существует изолированный пользователь `hub-runner` (с группами `3003 aid_inet` и `3004 aid_net_raw` для Android), Beacon по умолчанию запускает дочерние проекты от его имени. При ошибке сброса привилегий в `_preexec` дочерний процесс завершается с кодом `126`.
  - **Как вернуть `root`:** откройте вкладку **«Настройки»** → **«Расширенные системные настройки»** → выберите `root (полные права)` в поле «Пользователь запуска процессов» и сохраните настройки.

---

## Внутренний SDK (`import beacon` / `import hub`)

```python
import beacon  # также поддерживается import hub (с DeprecationWarning)

beacon.notify("Сервис запущен", level="info")
api_key = beacon.secret("MY_API_KEY")
code = beacon.ask("Введите код из СМС:", timeout=300)
cursor = beacon.state.get("cursor", default=0)
beacon.state.set("cursor", cursor + 1)
```

---

## English Overview (EN)

**Beacon** (formerly **Hub ControlPanel**, fully backward-compatible with `hub`) is a self-hosted, lightweight operations console and containerless process supervisor designed for both **Android chroot / Termux home servers (`aarch64`)** and **standard Linux VPS / SBCs (`x86_64` / `aarch64`)**.

- **< 80 MB Idle RAM Footprint:** Built on FastAPI + Uvicorn + SQLite WAL + React/Vite static bundle with zero external CDN dependencies.
- **Resilient Process Supervisor:** Process group isolation (`os.setsid` / `os.killpg`), direct unbuffered file-descriptor logging (no `subprocess.PIPE` / no `SIGPIPE` when restarting the panel), surviving process re-adoption across restarts, and single-pass PGID RSS memory enforcement.
- **Built-in AI Access (`/mcp` & `/api/v1/`):** Native Streamable HTTP Model Context Protocol server with 17 tools, scoped SHA-256 API tokens (`beacon_ai_...`), human-in-the-loop approval queue with unified diffs, prompt-injection log redaction (`<untrusted_content>`), and an instant «Pause AI» kill-switch.
