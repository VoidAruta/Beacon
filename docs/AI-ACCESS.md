# Подключение ИИ-агентов к Beacon (MCP `/mcp` и REST `/api/v1/`)

**Beacon** включает встроенный **Streamable HTTP MCP-сервер** (`/mcp`) и **REST API** (`/api/v1/*`) с поддержкой гранулярных токенов, быстрых профилей прав, очереди одобрения изменений (`unified diff`), защиты от prompt-инъекций и мгновенной блокировки (**«Пауза ИИ»**).

> Если вы пишете программы и скрипты под Beacon **без прямого MCP-доступа** (например, в чате с LLM или отдельной IDE), используйте руководство [`docs/AI-CODER-GUIDE.md`](AI-CODER-GUIDE.md).

## 1. Выпуск токена и профили прав
1. Смените стандартный пароль `admin` во вкладке **«Настройки»** (минимум 8 символов). Пока используется пароль по умолчанию `admin`, доступ для ИИ принудительно заблокирован.
2. Перейдите во вкладку **«Доступ ИИ (MCP)»** → включите доступ и создайте токен (`beacon_ai_...`).
3. Выберите готовый пресет прав или настройте `scopes` вручную:
   - **Только чтение** — `read`, `files:read` (мониторинг статуса, логов, аналитики и кода без права изменений);
   - **Под присмотром** — `read`, `files:read`, `files:write`, `run`, `schedule:write` (все изменения кода и расписания проходят через очередь одобрения с `unified diff`);
   - **Автономный** — расширенные права с выборочным добавлением проектов в `auto_approve_projects`.
4. Обязательно задайте срок жизни токена (`ttl_days >= 1`) и список разрешённых IP / CIDR (`127.0.0.1/32`, подсеть Tailscale `100.64.0.0/10` или локальная сеть). Для доступа с любых IP требуется явное подтверждение (`allow_any_ip: true`).
5. При необходимости ограничьте токен конкретными проектами (`allowed_projects`).

## 2. Подключение в Claude Code
```bash
claude mcp add --transport http beacon http://127.0.0.1:8050/mcp \
  --header "Authorization: Bearer beacon_ai_ВАШ_ТОКЕН"
```

## 3. Подключение в Cursor / Windsurf / Claude Desktop (`mcp.json`)
```json
{
  "mcpServers": {
    "beacon": {
      "type": "http",
      "url": "http://127.0.0.1:8050/mcp",
      "headers": {
        "Authorization": "Bearer beacon_ai_ВАШ_ТОКЕН"
      }
    }
  }
}
```

## 4. Использование REST API (`/api/v1/`) и метрик Prometheus
```bash
# Список проектов
curl -H "Authorization: Bearer beacon_ai_ВАШ_ТОКЕН" http://127.0.0.1:8050/api/v1/projects

# Хвост логов проекта (в защитной обёртке <untrusted_content> с маскировкой секретов)
curl -H "Authorization: Bearer beacon_ai_ВАШ_ТОКЕН" "http://127.0.0.1:8050/api/v1/projects/heartbeat-daemon/logs?lines=100"

# Метрики Prometheus / OpenMetrics (требует scope: read)
curl -H "Authorization: Bearer beacon_ai_ВАШ_ТОКЕН" http://127.0.0.1:8050/api/metrics

# OpenAPI 3.1 схема
curl http://127.0.0.1:8050/api/v1/openapi.json
```

## 5. Доступные MCP-инструменты и области прав (`scopes`)
- `read`: `list_projects`, `get_project`, `get_run_status`, `tail_logs`, `list_runs`, `list_schedules`, `get_device_health`, `run_doctor`
- `files:read`: `list_files`, `read_file`
- `files:write`: `write_file` (создаёт заявку с `unified diff` или применяет напрямую только для `auto_approve_projects`)
- `run`: `start_project`, `stop_project`, `restart_project`, `install_dependencies`
- `schedule:write`: `update_schedule`
- `templates:create`: `create_project_from_template`
- `ask:answer`: `answer_ask` (с проверкой `allowed_projects` и очередью одобрения)

Метод `tools/list` автоматически фильтрует список доступных инструментов согласно `scopes` конкретного токена.

## 6. MCP-ресурсы (`resources/list`) и Промпты (`prompts/list`)
- **Ресурсы (`project://`):** `project://{project}/logs/latest` (последние 100 строк логов в обёртке `<untrusted_content>`) и `project://{project}/files/AGENTS.md`.
- **Промпты:** `debug_failed_project` (`project`), `create_telegram_bot` (`name`), `optimize_memory_limits`.

## 7. Ограничения безопасности и защита очереди одобрений
- **Изоляция секретов и файлов:** значения секретов никогда не выдаются ИИ-токенам; пути `.env*`, `.git/config`, `.home/.ssh/*`, `*.pem`, `*.key`, `*.session`, `*cookies*` заблокированы для чтения и списка файлов независимо от регистра.
- **Контроль очереди одобрений (`ai_approvals`):**
  - максимальный размер diff — `64 КБ`, максимум `10` активных `pending`-заявок на токен;
  - при одобрении проверяется `base_sha256` файла (защита от перезаписи параллельных правок) и срок действия заявки (`expires_at`);
  - при отзыве токена все его ожидающие заявки автоматически отменяются.
- **Защита MCP-транспорта:** отклоняются JSON-RPC batch-запросы свыше `20` элементов, проверяется заголовок `Origin` (настройка `mcp_allowed_origins` для защиты от DNS rebinding), а все неуспешные попытки авторизации фиксируются в `ai_audit_log`.
- **Экстренная остановка:** кнопка **«Пауза ИИ»** в шапке панели или команда `python3 -m beacon ai-pause` мгновенно блокирует все ИИ-запросы.
