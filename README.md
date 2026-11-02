# Hub — Автономная веб-панель управления скриптами и ботами

**Hub** — легковесная автономная система управления фоновыми сервисами (`services`) и периодическими задачами (`jobs`), спроектированная специально для работы в среде **Ubuntu 24.04 LTS внутри `chroot` на Android (`aarch64`)** без `systemd`, `Docker` и `cgroups`.

> ⚠️ **ВАЖНОЕ ПРЕДУПРЕЖДЕНИЕ БЕЗОПАСНОСТИ:**
> Панель **Hub** предназначена для работы **только внутри доверенной локальной сети** (LAN / VPN / Wi-Fi роутер) и защищена встроенным фильтром подсетей (`allowed_subnets`), `scrypt`-хешированием пароля, защитой от перебора (Rate Limit) и CSRF-токенами. Не публикуйте порт `8050` напрямую в открытый Интернет (WAN) без VPN (WireGuard / Tailscale) или TLS-прокси.

---

## Ключевые архитектурные гарантии

1. **Без `systemd`, `Docker` и `cgroups`:** Управление группами процессов построено на POSIX-вызовах (`os.setsid`, `os.killpg`), `psutil` и хранении состояния в SQLite (`WAL`).
2. **Нулевой риск `SIGPIPE` при рестарте панели:** `stdout` и `stderr` дочерних процессов направляются напрямую в файловый дескриптор лог-файла (`open(log_path, "ab", buffering=0)`, `close_fds=True`) без использования `subprocess.PIPE`. При перезапуске `Hub` запущенные боты продолжают работать без обрыва вывода.
3. **Защита от `ECHILD` и переиспользования PID:** При рестарте `Hub` выжившие процессы подхватываются из SQLite со сверкой `psutil.Process(pid).create_time()` (`±0.5` сек) и мониторятся пуллингом без вызова `waitpid()`.
4. **Совместимость с Node.js V8 и Android-ядром:** Лимит `RLIMIT_AS` не устанавливается (выставляются только `RLIMIT_CORE=(0,0)` и `RLIMIT_NOFILE=(4096,4096)`), а потребление памяти контролируется по сумме `RSS` группы `PGID`. Для отдельного пользователя `hub-runner` автоматически назначаются группы Android `aid_inet` (`3003`) и `aid_net_raw` (`3004`).
5. **Ультра-низкое потребление ОЗУ:** 1 воркер `uvicorn` потребляет ~25–65 МБ ОЗУ в состоянии покоя.

---

## Быстрая установка в Ubuntu 24.04 chroot

```bash
chmod +x /opt/hub/scripts/install.sh /opt/hub/scripts/zstart_line.sh
sudo /opt/hub/scripts/install.sh
```

### Автозапуск через `zstart`

Добавьте вызов `/opt/hub/scripts/zstart_line.sh` в ваш скрипт инициализации chroot-контейнера:

```bash
/opt/hub/scripts/zstart_line.sh
```

### Ручной запуск

```bash
cd /opt/hub
/opt/hub/.venv/bin/python -m hub
```

По умолчанию панель доступна по адресу `http://<IP_устройства>:8050` (пароль по умолчанию при первой установке: `admin`, если не задан через `HUB_ADMIN_PASSWORD`).

---

## Использование встроенного SDK в проектах

Панель автоматически прокидывает `PYTHONPATH=/opt/hub/sdk/python` и `NODE_PATH=/opt/hub/sdk/node` во все запускаемые проекты.

### Python (`import hub`)

```python
import hub

# 1. Отправка уведомления в Telegram / ntfy / Webhook
hub.notify("Бот успешно запущен!", level="info")

# 2. Получение секрета или JSON-куки из Cookie-Editor
cookies = hub.secret("my_cookies")  # Возвращает list[dict] для cookie_json

# 3. Сигнал о протухших куки (зажигает красный баннер в UI + шлёт алерт в TG)
# hub.cookies_expired("my_cookies", note="Требуется повторный вход")

# 4. Блокирующий интерактивный запрос (ответ из Web UI или Reply в Telegram)
code = hub.ask("Введите код из СМС:", timeout=300)
print("Получен код:", code)
```

### Node.js (`const hub = require('hub')`)

```javascript
const hub = require('hub');

async function main() {
  await hub.notify('Node worker запущен', 'info');
  const cookies = await hub.secret('my_cookies');
  const code = await hub.ask('Введите 2FA код:', 300);
  console.log('Код:', code);
}
main();
```
