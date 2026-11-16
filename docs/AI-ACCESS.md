# Подключение ИИ-агентов к Beacon (MCP `/mcp` и REST `/api/v1/`)

**Beacon** включает встроенный **Streamable HTTP MCP-сервер** (`/mcp`) и **REST API** (`/api/v1/*`) с поддержкой гранулярных токенов, очереди одобрения изменений (`unified diff`) и мгновенной блокировки («Пауза ИИ»).

> Если вы пишете программы и скрипты под Beacon **без прямого MCP-доступа** (например, в чате с LLM или отдельной IDE), используйте руководство [`docs/AI-CODER-GUIDE.md`](AI-CODER-GUIDE.md).

## 1. Выпуск токена
1. Смените стандартный пароль `admin` в вкладке **«Настройки»** (минимум 8 символов). Пока используется пароль по умолчанию `admin`, доступ для ИИ заблокирован.
2. Перейдите во вкладку **«Доступ ИИ (MCP)»** → включите доступ и создайте токен (`beacon_ai_...`) с нужными областями прав (`read`, `files:read`, `files:write`, `run`, `schedule:write`, `templates:create`, `ask:answer`).
3. Укажите список разрешённых IP / CIDR (`127.0.0.1`, подсеть Tailscale или локальная сеть) или явно подтвердите доступ с любых IP-адресов при выпуске токена.

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

## 4. Использование REST API (`/api/v1/`)
```bash
# Список проектов
curl -H "Authorization: Bearer beacon_ai_ВАШ_ТОКЕН" http://127.0.0.1:8050/api/v1/projects

# Хвост логов проекта (в защитной обёртке <untrusted_content>)
curl -H "Authorization: Bearer beacon_ai_ВАШ_ТОКЕН" "http://127.0.0.1:8050/api/v1/projects/heartbeat-daemon/logs?lines=100"

# OpenAPI 3.1 схема
curl http://127.0.0.1:8050/api/v1/openapi.json
```

## 5. Доступные MCP-инструменты и области прав (`scopes`)
- `read`: `list_projects`, `get_project`, `get_run_status`, `tail_logs`, `list_runs`, `list_schedules`, `get_device_health`, `run_doctor`
- `files:read`: `list_files`, `read_file`
- `files:write`: `write_file` (создаёт заявку с `unified diff` или применяет напрямую для `auto_approve_projects`)
- `run`: `start_project`, `stop_project`, `restart_project`, `install_dependencies`
- `schedule:write`: `update_schedule`
- `templates:create`: `create_project_from_template`
- `ask:answer`: `answer_ask`

## 6. MCP-ресурсы (`resources/list`) и Промпты (`prompts/list`)
- **Ресурсы (`project://`):** `project://{project}/logs/latest` (последние 100 строк логов в обёртке `<untrusted_content>`) и `project://{project}/files/AGENTS.md`.
- **Промпты:** `debug_failed_project` (`project`), `create_telegram_bot` (`name`), `optimize_memory_limits`.
