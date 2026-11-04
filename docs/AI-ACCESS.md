# Подключение ИИ-агентов к Beacon (MCP `/mcp` и REST `/api/v1/`)

**Beacon** включает встроенный **Streamable HTTP MCP-сервер** (`/mcp`) и **REST API** (`/api/v1/*`) с поддержкой гранулярных токенов, очереди одобрения изменений (`unified diff`) и мгновенной блокировки («Пауза ИИ»).

## 1. Выпуск токена
1. Смените стандартный пароль `admin` в вкладке **«Настройки»** (минимум 8 символов). Пока используется пароль по умолчанию `admin`, доступ для ИИ заблокирован.
2. Перейдите во вкладку **«Доступ ИИ (MCP)»** → включите доступ и создайте токен (`beacon_ai_...`) с нужными областями прав (`read`, `files:read`, `files:write`, `run`, `schedule:write`, `templates:create`, `ask:answer`).

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
