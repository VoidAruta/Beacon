import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type AppLanguage = 'ru' | 'en';

interface I18nContextValue {
  lang: AppLanguage;
  setLang: (next: AppLanguage) => void;
  toggleLang: () => void;
  t: (ruText: string, enText: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'ru',
  setLang: () => {},
  toggleLang: () => {},
  t: (ruText) => ruText,
});

// Comprehensive exact phrase dictionary (RU -> EN) covering all 7 tabs, modals, tables, and alerts
const EXACT_RU_TO_EN: Record<string, string> = {
  // Navigation & App Shell
  'Инициализация Beacon Control Panel...': 'Initializing Beacon Control Panel...',
  'Главный дашборд': 'Main Dashboard',
  'Дашборд': 'Dashboard',
  'Проекты и Консоль': 'Projects & Console',
  'Проекты': 'Projects',
  'Куки и Секреты (0600)': 'Cookies & Secrets (0600)',
  'Куки и Секреты': 'Cookies & Secrets',
  'Секреты': 'Secrets',
  'Доступ ИИ (MCP)': 'AI Access (MCP)',
  'MCP / ИИ': 'MCP / AI',
  'Настройки и RBAC': 'Settings & RBAC',
  'Настройки': 'Settings',
  'Приёмка (Doctor)': 'Acceptance (Doctor)',
  'Документация': 'Documentation',
  'Документация по панели': 'Panel Documentation',
  'Справка': 'Docs & FAQ',
  'Поиск / Команды': 'Search / Commands',
  'Командная палитра': 'Command Palette',
  'Командная палитра Beacon': 'Beacon Command Palette',
  'Основная навигация': 'Primary Navigation',
  'Мобильная навигация': 'Mobile Navigation',
  'Безопасный режим (Safe Mode)': 'Safe Mode',
  'Безопасный режим (Safe Mode) активен:': 'Safe Mode is active:',
  'автоматический запуск сервисов и фоновых задач по расписанию временно отключён.':
    'automatic service startup and scheduled background jobs are temporarily paused.',
  'Отключить в Настройках': 'Disable in Settings',
  'Автозапуск и планировщик приостановлены': 'Autostart & scheduler paused',
  'Режим: Safe Mode': 'Mode: Safe Mode',
  'Штатный режим': 'Normal Mode',
  'Стандартный пароль «admin»': 'Default password "admin"',
  'Запуск процессов от root': 'Processes running as root',
  'Настроить безопасность': 'Configure Security',
  'Развернуть': 'Expand',
  'Свернуть': 'Collapse',
  'Свернуть системные баннеры в тонкую полоску': 'Collapse system banners into a compact bar',
  'Внимание: используется стандартный пароль «admin»!': 'Warning: default password "admin" is active!',
  'Вход ограничен локальной сетью (RFC1918/loopback), а доступ для ИИ (MCP) заблокирован. Задайте новый пароль (мин. 8 символов):':
    'Login is restricted to local subnets (RFC1918/loopback) and AI Access (MCP) is locked. Set a new password (min 8 chars):',
  'Новый пароль (от 8 симв.)': 'New password (min 8 chars)',
  'В Настройки': 'Open Settings',
  'ERROR: Проекты запускаются от root!': 'ERROR: Child projects are running as root!',
  'Для изоляции процессов создайте непривилегированного пользователя':
    'To isolate child processes, create an unprivileged system user',
  'и выберите его в Настройках.': 'and select it in Settings.',
  'Переключить в Настройках': 'Switch in Settings',
  'Выйти': 'Sign Out',
  'Выход': 'Sign Out',
  'Войти в панель': 'Sign In to Panel',
  'Вход в панель управления': 'Control Panel Sign In',
  'Имя пользователя': 'Username',
  'Пароль (по умолчанию': 'Password (default',
  ', меняется в разделе «Настройки»)': ', changeable in Settings)',
  'Пароль администратора или пользователя': 'Administrator or user password',
  'Имя пользователя (необязательно)': 'Username (optional)',
  'По умолчанию: admin': 'Default: admin',
  'Введите пароль...': 'Enter password...',
  'Неверный пароль или имя пользователя': 'Invalid username or password',
  'Обновить': 'Update',
  'Обновить сейчас': 'Update Now',
  'Проверить обновления': 'Check for Updates',
  'Закрыть': 'Close',
  'Закрыть (Esc)': 'Close (Esc)',
  'Скрыть': 'Hide',
  'Отмена': 'Cancel',
  'Сохранить': 'Save',
  'Изменить': 'Edit',
  'Удалить': 'Delete',
  'Создать': 'Create',
  'Добавить': 'Add',
  'Применить': 'Apply',
  'Копировать': 'Copy',
  'Скопировано': 'Copied',
  'Скопировано!': 'Copied!',
  'Повторить': 'Retry',
  'Загрузка...': 'Loading...',
  'Сохранение...': 'Saving...',
  'Выполняется...': 'Running...',
  'Создание...': 'Creating...',
  'Открыть': 'Open',
  'Отправить': 'Send',
  'ОК': 'OK',
  'Все': 'All',
  'Да': 'Yes',
  'Нет': 'No',

  // DashboardView
  'Загрузка телеметрии Beacon...': 'Loading Beacon telemetry...',
  'uv ускоритель активен': 'uv accelerator active',
  'Изоляция юзера:': 'User isolation:',
  'Скрыть подсказки': 'Hide Hints',
  'Справка по метрикам': 'Metrics Guide',
  'Как считается ОЗУ и CPU': 'How RAM & CPU Are Tracked',
  'Панель отдельно контролирует собственный процесс Beacon (лимит < 80 МБ) и суммирует физическую память (RSS) каждой группы процессов проекта по её':
    'Beacon monitors its own supervisor process (< 80 MB budget) and sums the physical RSS memory of every child process group by its',
  'Откуда берётся сетевая статистика': 'Network Telemetry Source',
  'Счётчики входящего (': 'Inbound (',
  ') и исходящего (': ') and outbound (',
  ') трафика снимаются напрямую из ядра Linux (': ') traffic counters are read directly from the Linux kernel (',
  ') каждые 2 секунды без накладных расходов.': ') every 2 seconds with zero overhead.',
  'Быстрые действия с проектами': 'Quick Project Actions',
  'Кликните по имени любого проекта в таблице ниже, чтобы открыть полноценную IDE, редактор кода, живой терминал и превью веб-сервиса.':
    'Click any project name in the table below to open the full IDE, code editor, live terminal, and web service preview.',
  'ОЗУ системы': 'System RAM',
  'Хранилище и SQLite WAL': 'Storage & SQLite WAL',
  'свободно': 'free',
  'Сетевая статистика и нагрузка трафика': 'Network Telemetry & Traffic Load',
  'Скорость приёма/отдачи по интерфейсам ядра, открытые TCP-соединения и порты запущенных веб-проектов':
    'Kernel interface RX/TX throughput, established TCP sockets, and active web project ports',
  'Прокси: выкл (прямой канал)': 'Proxy: off (direct connection)',
  'Приём (RX)': 'Inbound (RX)',
  'Отдача (TX)': 'Outbound (TX)',
  'Соединения TCP': 'TCP Connections',
  'актив.': 'active',
  'Веб-порты (Web)': 'Web Ports (Web)',
  'Нет веб-проектов': 'No web projects',
  'Панель: :8050': 'Panel: :8050',
  'Динамика сетевого потока (RX / TX)': 'Live Network Throughput (RX / TX)',
  'Интерфейсы: lo (локальный контур)': 'Interfaces: lo (loopback)',
  'Поиск проекта...': 'Search project...',
  'Фильтр по типу проекта': 'Filter by project type',
  'Фильтр по группе': 'Filter by group',
  'Все типы': 'All Types',
  'Services (Демоны)': 'Services (Daemons)',
  'Web / HTTP API': 'Web / HTTP API',
  'Jobs (По расписанию)': 'Jobs (Scheduled)',
  'Все группы': 'All Groups',
  'Скрыть примеры': 'Hide Examples',
  'Загрузить 4 примера': 'Load 4 Examples',
  'Проект': 'Project',
  'Тип / Порт': 'Type / Port',
  'Статус': 'Status',
  'PID / PGID': 'PID / PGID',
  'Нагрузка (RSS / CPU)': 'Load (RSS / CPU)',
  'Куки / Расписание': 'Cookies / Schedule',
  'Диск': 'Disk',
  'Управление': 'Controls',
  'Проекты не найдены. Нажмите «Новый проект» в шапке или «Загрузить 4 примера».':
    'No projects found. Click "New Project" in the header or "Load 4 Examples".',
  'пример': 'example',
  'Боты 24/7': '24/7 Bots',
  'Парсеры': 'Scrapers / Jobs',
  'Тесты': 'Tests',
  'Домашний сервер': 'Home Server',
  'Бэкапы': 'Backups',
  'Фоновый демон (Service 24/7) с сохранением счётчика тиков в beacon.state':
    'Background daemon (24/7 Service) persisting tick counters in beacon.state',
  'Пример легковесного HTTP API бэкенда с проверкой /health и $PORT':
    'Lightweight HTTP API backend example with /health endpoint and $PORT binding',
  'Пример интерактивного запроса 2FA/СМС-кода через beacon.ask()':
    'Interactive 2FA/SMS prompt example using beacon.ask()',
  'Периодическая задача проверки куки (Cron каждые 30 мин) с сигналом beacon.cookies_expired()':
    'Periodic cookie validation job (Cron every 30 min) using beacon.cookies_expired()',
  'Имя копии...': 'Clone name...',
  'Куки истекли': 'Cookies Expired',
  'Куки ОК': 'Cookies OK',
  'Запустить': 'Start',
  'Остановить': 'Stop',
  'Перезапустить': 'Restart',
  'Рестарт': 'Restart',
  'Остановить группу процессов (PGID)': 'Stop process group (PGID)',
  'Клонировать проект': 'Clone Project',
  'Открыть IDE, файлы и терминал': 'Open IDE, files & terminal',
  'Операционный журнал сервера': 'Server Operations Log',
  'Аварийных завершений (failed / timeout / killed_oom / crash_loop) не зафиксировано.':
    'No abnormal terminations (failed / timeout / killed_oom / crash_loop) recorded.',
  'Журнал исходящих уведомлений пуст.': 'Outbound notifications log is empty.',
  'Нет активных периодических задач (Cron / интервал / ежедневно).':
    'No active scheduled jobs (Cron / interval / daily).',
  'Инструменты быстрой самопроверки SDK и живучести процессов (2FA ask, протухшие куки, тест без SIGPIPE)':
    'Quick SDK & Process Resilience Self-Test Tools (2FA ask, expired cookies, zero-SIGPIPE restart test)',
  'Симулировать запрос 2FA (beacon.ask)': 'Simulate 2FA Prompt (beacon.ask)',
  'Симулировать протухание кук (beacon.cookies_expired)': 'Simulate Expired Cookies (beacon.cookies_expired)',
  'Проверить выживание сервисов при рестарте (без SIGPIPE)': 'Test Service Survival Across Restart (No SIGPIPE)',

  // Statuses & Types
  'Работает': 'Running',
  'Остановлен': 'Stopped',
  'Успешно': 'Succeeded',
  'Ошибка': 'Failed',
  'Сбой': 'Failed',
  'Таймаут': 'Timed Out',
  'Превышен ОЗУ (OOM)': 'Out of Memory (OOM)',
  'Аварийный цикл (Crash-Loop)': 'Crash-Loop',
  'Ждёт 2FA / ввод': 'Waiting for 2FA / Input',
  'Сервис 24/7': '24/7 Service',
  'Веб / API': 'Web / API',
  'Задача (Job)': 'Scheduled Job',
  'Демон / Сервис': 'Daemon / Service',
  'Сайт / HTTP API': 'Web / HTTP API',
  'Скрипт / Парсер': 'Script / Job',

  // SettingsAndAcceptanceView (Settings + Doctor)
  'Конфигурация сервера Beacon, Уведомления и RBAC': 'Beacon Server Configuration, Notifications & RBAC',
  'Все параметры разделены по логическим категориям. После изменения полей нажмите «Сохранить настройки панели».':
    'All settings are organized by category. After making changes, click "Save Panel Settings".',
  'Сохранить настройки панели': 'Save Panel Settings',
  '1. Пароль, Сеть и Прокси': '1. Password, Network & Proxy',
  '2. Telegram-бот и Оповещения': '2. Telegram Bot & Alerts',
  '3. Диск, Логи и Питание': '3. Disk, Logs & Power',
  '5. Журнал аудита': '5. Audit Log',
  'Все разделы сразу': 'Show All Sections',
  '1. Пароль администратора, Сетевой доступ (CIDR / Tailscale) и Прокси':
    '1. Administrator Password, Network Access (CIDR / Tailscale) & Proxy',
  'Управление входом в панель, разрешёнными IP-подсетями и глобальным SOCKS5/HTTP прокси для проектов':
    'Manage panel sign-in credentials, allowed IP subnets, and global SOCKS5/HTTP proxy for child projects',
  'Смена пароля главного администратора (': 'Change Primary Administrator Password (',
  'Установлен стандартный пароль!': 'Default password is active!',
  'Действующий пароль (нужен только если вы меняете пароль)': 'Current Password (required only when changing password)',
  'Введите текущий пароль...': 'Enter current password...',
  'Новый пароль (от 8 символов; оставьте пустым, чтобы не менять)':
    'New Password (min 8 characters; leave blank to keep current)',
  'Минимум 8 символов (PBKDF2-SHA256)': 'Minimum 8 characters (scrypt / PBKDF2)',
  'Глобальный исходящий прокси для проектов и Telegram': 'Global Outbound Proxy for Projects & Telegram',
  'Передаётся в': 'Injected into',
  'всем проектам, у которых включён флаг «Использовать прокси»':
    'for all projects with "Use Proxy" enabled',
  'socks5://127.0.0.1:10808 или http://user:pass@ip:port': 'socks5://127.0.0.1:10808 or http://user:pass@ip:port',
  'Быстрые шаблоны:': 'Quick presets:',
  'Отключить прокси': 'Disable Proxy',
  'Сетевой фильтр доступа к панели (Разрешённые подсети CIDR)':
    'Panel Network Access Filter (Allowed CIDR Subnets)',
  'Определяет, с каких IP-адресов разрешён вход в веб-панель и к API':
    'Defines which client IP addresses are allowed to access the web panel and API',
  'Локальная сеть + Tailscale': 'LAN + Tailscale',
  'Только localhost': 'Localhost Only',
  'Любой IP (0.0.0.0/0)': 'Any IP (0.0.0.0/0)',
  'Список разрешённых подсетей CIDR (через запятую)': 'Allowed CIDR Subnets (comma-separated)',
  'Порт веб-панели (по умолчанию 8050)': 'Web Panel Port (default 8050)',
  'Пользователь ОС для запуска проектов': 'OS User for Child Projects (run_as_user)',
  'beacon-runner (изолированный юзер)': 'beacon-runner (isolated system user)',
  'root (без понижения привилегий)': 'root (no privilege drop)',
  'Доверенные обратные прокси (Nginx / Caddy IP)': 'Trusted Reverse Proxies (Nginx / Caddy IP)',
  'Пусто или 127.0.0.1/32': 'Empty or 127.0.0.1/32',
  'Зарезервированные системные порты': 'Reserved System Ports',
  'Разрешить VPN Tailscale (100.64.0.0/10)': 'Allow Tailscale VPN (100.64.0.0/10)',
  'Флаг Secure для cookie (только HTTPS)': 'Secure Cookie Flag (HTTPS only)',
  'Safe Mode (отключить автостарт проектов)': 'Safe Mode (disable project autostart)',
  '2. Системный Telegram-бот панели и внешние каналы оповещений':
    '2. System Telegram Bot & External Notification Channels',
  'Доставка уведомлений о падениях проектов, запрос 2FA-кодов (':
    'Delivers project crash alerts, interactive 2FA prompts (',
  ') и управление сервером из чата': '), and chat commands',
  'Проверить отправку': 'Send Test Alert',
  'Пошаговое подключение системного бота:': 'Step-by-step Telegram Bot setup:',
  '1. Откройте в Telegram': '1. Open in Telegram',
  ', отправьте': ', send',
  'и скопируйте выданный HTTP API Token.': 'and copy the issued HTTP API Token.',
  '2. Напишите вашему новому боту любое сообщение (например,': '2. Send any message to your new bot (e.g.',
  '3. Узнайте свой числовой ID через': '3. Find your numeric user ID via',
  'и вставьте его в поле «Admin Chat ID» ниже.': 'and paste it into the "Admin Chat ID" field below.',
  'Токен системного бота (': 'System Bot Token (',
  'Личный Admin Chat ID (': 'Personal Admin Chat ID (',
  'Доп. разрешённые ID (': 'Additional Allowed IDs (',
  'Отправлять в ТГ через глобальный прокси': 'Route Telegram requests through global proxy',
  'Быстрый эмулятор команд Telegram-бота (проверка ответа без телефона):':
    'Quick Telegram Bot Command Emulator (test responses without a phone):',
  'Push-уведомления ntfy.sh': 'ntfy.sh Push Notifications',
  'Резервный канал уведомлений на смартфон или ПК': 'Fallback push channel for mobile or desktop',
  'Внешний Webhook для алертов': 'External Alert Webhook',
  'POST JSON при сбоях, OOM и истечении кук': 'Sends POST JSON on crashes, OOM kills, and expired cookies',
  'Внешний мониторинг (Uptime Kuma / Healthchecks)': 'External Heartbeat (Uptime Kuma / Healthchecks)',
  'Панель периодически пингует этот URL, пока жива': 'Beacon periodically pings this URL while healthy',
  '3. Контроль диска (Disk Guard), ротация логов, планировщик и питание':
    '3. Disk Guard, Log Rotation, Scheduler & Power Management',
  'Настройка квот хранения логов, плавного старта тяжёлых проектов и защиты по температуре/батарее':
    'Configure log retention quotas, staggered autostart, and thermal/battery protection',
  'Очистить кэш pip / npm, логи и SQLite WAL': 'Clean pip / npm Cache, Old Logs & SQLite WAL',
  'Предупреждение о диске (МБ)': 'Disk Warning Threshold (MB)',
  'Жёлтый баннер при нехватке места': 'Shows yellow warning banner on low disk space',
  'Критическая блокировка (МБ)': 'Critical Disk Lock Threshold (MB)',
  'Пауза фоновых задач для защиты БД': 'Pauses scheduled jobs to protect SQLite DB',
  'Макс. размер лог-файла (МБ)': 'Max Log File Size (MB)',
  'Автоусечение длинных логов': 'Auto-truncates oversized log files',
  'Хранить запусков (runs)': 'Runs Retention per Project',
  'Количество историй на каждый проект': 'Number of historical runs kept per project',
  'Хранить логи (дней)': 'Log Retention (days)',
  'Удаление старых архивов': 'Automatically purges old log archives',
  'Пауза автостарта (сек)': 'Autostart Stagger Delay (sec)',
  'Задержка между стартами при загрузке десятков ботов и сайтов':
    'Delay between project startups on boot to prevent CPU/RAM spikes',
  'Пропущенные задачи расписания при выключенном сервере (': 'Missed Scheduled Jobs Policy (',
  'Что делать с периодическими Job-проектами, чей запуск пришёлся на время простоя сервера':
    'How to handle scheduled jobs whose trigger window occurred while the server was offline',
  'Ждать следующего планового окна по расписанию (рекомендуется)':
    'Wait for the next scheduled window (recommended)',
  'Запустить пропущенную задачу 1 раз сразу при старте панели':
    'Run missed job once immediately on panel startup',
  'Контроль батареи и защита от перегрева (актуально для мобильных серверов и узлов с датчиками)':
    'Battery & Thermal Protection (for mobile servers and nodes with hardware sensors)',
  'На обычных облачных VPS без аккумулятора эти пороги автоматически игнорируются':
    'Automatically ignored on standard cloud VPS instances without battery sensors',
  'Авто-стоп задач при критическом перегреве': 'Auto-stop non-critical projects on critical overheating',
  'Мин. цикл (%)': 'Min Charge (%)',
  'Макс. цикл (%)': 'Max Charge (%)',
  'Тревога разряда (%)': 'Low Battery Alert (%)',
  'Блок запуска (%)': 'Block Runs Below (%)',
  'Нагрев Warn (°C)': 'Thermal Warn (°C)',
  'Перегрев Crit (°C)': 'Thermal Crit (°C)',
  'Резервное копирование сервера (.zip) и служба автозапуска Linux (':
    'Full Server Backup (.zip) & Linux Systemd Service (',
  'Архив включает консистентный слепок БД (': 'Archive includes a consistent SQLite snapshot (',
  '), все файлы из': '), all secret files from',
  'и исходный код проектов (без тяжёлых папок': 'and project source code (excluding heavy',
  'Скачать полный бэкап (.zip)': 'Download Full Backup (.zip)',
  'Предпросмотр beacon.service (systemd)': 'Preview beacon.service (systemd)',
  'Интервал автоматического бэкапа (часов, 0 = выключено)': 'Auto-Backup Interval (hours, 0 = disabled)',
  'Сколько последних архивов автобэкапа хранить на диске (шт.)': 'Number of Auto-Backup Archives to Retain on Disk',
  'Переезд на другой сервер в 2 клика: Загрузка и восстановление бэкапа (.zip)':
    '2-Click Server Migration: Upload & Restore Backup (.zip)',
  'Загрузите архив': 'Upload a',
  'со старого сервера или выберите локальный архив из': 'archive from your old server or select a local archive from',
  '. Перед заменой автоматически создаётся страховочный слепок':
    '. Before restoring, Beacon automatically creates a safety snapshot',
  'и проверяется': 'and runs',
  '1. Загрузить файл архива (.zip) с вашего устройства': '1. Upload Backup Archive (.zip) from Your Device',
  'Восстановить из файла': 'Restore from File',
  '2. Восстановить из архива на сервере (': '2. Restore from Server Archive (',
  'Восстановить выбранный': 'Restore Selected',
  'пока нет сохранённых архивов. Нажмите «Скачать полный бэкап (.zip)» выше или загрузите файл слева.':
    'has no saved archives yet. Click "Download Full Backup (.zip)" above or upload a file on the left.',
  'Подтвердите восстановление сервера из архива:': 'Confirm Server Restore from Archive:',
  'Все запущенные проекты будут аккуратно остановлены, текущее состояние сохранится в страховочный архив':
    'All running projects will be cleanly stopped, current state will be saved to a safety backup',
  ', после чего база данных': ', and then the database',
  ', секреты': ', secrets',
  'и папки': 'and directories',
  'будут заменены данными из выбранного бэкапа.': 'will be replaced with the contents of the selected backup.',
  'Да, восстановить сейчас': 'Yes, Restore Now',
  'Пользователи и роли доступа (RBAC)': 'Users & Access Roles (RBAC)',
  '— полный доступ.': '— full administrative access.',
  'Логин (латиница)': 'Username (alphanumeric)',
  'Пароль (от 8 символов)': 'Password (min 8 chars)',
  'Роль доступа': 'Access Role',
  'viewer (только чтение)': 'viewer (read-only)',
  'operator (запуск и 2FA)': 'operator (run & 2FA)',
  'admin (полный доступ)': 'admin (full access)',
  'Пользователь': 'User',
  'Роль': 'Role',
  'Создан': 'Created',
  '(вы)': '(you)',
  'Запись входов, изменений настроек, операций с секретами и запусков проектов':
    'Audit trail of sign-ins, settings changes, secret operations, and project runs',
  'Время': 'Time',
  'IP-адрес': 'IP Address',
  'Событие': 'Event',
  'Подробности': 'Details',
  'Фильтр по событию, IP, актору...': 'Filter by event, IP, actor...',
  'Обновить журнал': 'Refresh Log',
  'Адаптивная самодиагностика среды (': 'Adaptive Environment Self-Diagnostics (',
  'Автоматически определяет профиль ОС (Android Chroot vs Standard Linux) и проверяет точки монтирования, права':
    'Automatically detects OS profile (Android Chroot vs Standard Linux) and verifies mounts, permissions',
  'на секреты, чекпоинт SQLite WAL, наличие': 'on secrets, SQLite WAL checkpoint, available',
  ', прокси и датчики.': ', proxy bridge, and hardware sensors.',
  'Загрузка отчёта самодиагностики...': 'Loading diagnostic report...',
  'Готовые тестовые проекты (Песочница для ручной проверки)': 'Built-in Test Projects (Interactive Sandbox)',
  'Автоматический прогон 6 системных тестов приёмки (в 1 клик)':
    'Automated 6-Point Supervisor Acceptance Suite (1-Click)',

  // SecretsView
  'Хранилище секретов и профилей куки (0600)': 'Secrets & Cookie Profiles Vault (0600)',
  'Автомаскировка логов активна': 'Log Redaction Active',
  'Скрыть инструкцию': 'Hide Guide',
  'Как читать секреты в коде': 'How to Read Secrets in Code',
  '1. Чтение в Python и Node.js': '1. Reading in Python & Node.js',
  '2. Привязка секрета к проекту (ACL)': '2. Project Access Binding (ACL)',
  '3. Сигнал о протухании кук': '3. Cookie Expiration Signal',
  'Введите код или ответ...': 'Enter code or reply...',
  'Отправить в скрипт': 'Send to Script',
  'Импорт куки из браузера (Cookie-Editor JSON)': 'Import Browser Cookies (Cookie-Editor JSON)',
  'Из файла': 'From File',
  'Образец': 'Sample',
  'например: youtube_cookies': 'e.g. youtube_cookies',
  'Привязать к проекту (разрешить чтение)': 'Bind to Project (Grant Read ACL)',
  'Не привязывать автоматически': 'Do not bind automatically',
  'Сохранение 0600...': 'Saving 0600...',
  'Импортировать куки и сбросить флаг «Истекли»': 'Import Cookies & Clear "Expired" Flag',
  'Добавить или обновить API-ключ / Файл секрета': 'Add or Update API Key / Secret File',
  'Токены ботов, ключи OpenAI/GitHub, приватные SSH/PEM-ключи и сервисные аккаунты':
    'Bot tokens, OpenAI/GitHub keys, private SSH/PEM keys, and service accounts',
  'Сгенерировать': 'Generate',
  'например: openai_api_key': 'e.g. openai_api_key',
  'Формат хранения': 'Storage Format',
  'Текст / API-ключ': 'Text / API Key',
  'Многострочный файл / .pem': 'Multiline File / .pem',
  'Значение секрета (будет скрыто после сохранения и замаскировано в логах)':
    'Secret Value (hidden after saving and automatically redacted in logs)',
  'Вставьте токен, пароль или содержимое сертификата...': 'Paste token, password, or certificate content...',
  'Разрешить чтение этого секрета проектам (ACL):': 'Grant projects read access to this secret (ACL):',
  'Запись в data/secrets/...': 'Writing to data/secrets/...',
  'Сохранить секрет с правами 0600': 'Save Secret with 0600 Permissions',
  'Поиск по имени, домену, проекту...': 'Search by name, domain, or project...',
  'Куки JSON': 'Cookie JSON',
  'API-ключи': 'API Keys',
  'Файлы': 'Files',
  'Истёкшие': 'Expired',
  'Имя секрета и вызов в коде': 'Secret Name & SDK Call',
  'Тип и метаданные': 'Type & Metadata',
  'Доступ проектов (ACL)': 'Project Access (ACL)',
  'Размер / Обновлён': 'Size / Updated',
  'Действия': 'Actions',
  'Секреты не найдены. Создайте API-ключ или импортируйте куки в формах выше.':
    'No secrets found. Create an API key or import cookies using the forms above.',
  'Не привязан к проектам': 'Not bound to any projects',
  'Скопировать код вызова для Python / Node.js': 'Copy SDK call for Python / Node.js',

  // AiAccessView
  'Управление ИИ-доступом доступно только администратору (admin)':
    'AI Access management is restricted to administrators (admin)',
  'Доступ для ИИ заблокирован, пока установлен стандартный пароль «admin»':
    'AI Access is locked while the default "admin" password is active',
  'Сменить пароль в Настройках': 'Change Password in Settings',
  'Подсистема доступа ИИ (Streamable HTTP MCP & REST v1)': 'AI Access Subsystem (Streamable HTTP MCP & REST v1)',
  'ЗАБЛОКИРОВАНО (ПАРОЛЬ ADMIN)': 'LOCKED (DEFAULT ADMIN PASSWORD)',
  'ВЫКЛЮЧЕНО': 'DISABLED',
  'НА ПАУЗЕ (KILL-SWITCH)': 'PAUSED (KILL-SWITCH)',
  'АКТИВНО (/mcp)': 'ACTIVE (/mcp)',
  'Выключить доступ ИИ': 'Disable AI Access',
  'Разрешить доступ для ИИ': 'Enable AI Access',
  'Возобновить ИИ': 'Resume AI Access',
  'Пауза ИИ (Kill-Switch)': 'Pause AI (Kill-Switch)',
  'Запись файлов, запуск, остановка и смена расписания требуют одобрения владельца':
    'Writing files, starting, stopping, and changing schedules require owner approval',
  'Заявок от ИИ-агентов пока нет.': 'No pending requests from AI agents.',
  'Одобрить и выполнить': 'Approve & Execute',
  'Отклонить': 'Reject',
  'Выпустить новый API-токен для ИИ': 'Issue New AI API Token',
  'Название токена (агента)': 'Token (Agent) Name',
  'Разрешённые IP / CIDR (обязательно или подтвердите любой IP)':
    'Allowed IP / CIDR (required unless any IP is confirmed)',
  'Разрешить подключение с любого IP-адреса': 'Allow connections from any IP address',
  'Лимит запросов в минуту (Rate Limit)': 'Requests per minute (Rate Limit)',
  'Срок действия (дней, от 1)': 'Expiration (days, min 1)',
  'Разрешения (Scopes)': 'Permissions (Scopes)',
  'Статус, здоровье, список проектов, логи, имена секретов': 'Status, health, project list, logs, secret names',
  'Чтение дерева файлов и исходного кода проектов': 'Read project file trees and source code',
  'Запись файлов в директории проекта (с diff и подтверждением)':
    'Write files in project directory (with diff & approval)',
  'Запуск, остановка, перезапуск и install_deps': 'Start, stop, restart, and install_deps',
  'Изменение расписания cron и restart_policy': 'Modify cron schedule and restart_policy',
  'Создание проектов строго из шаблонов': 'Create projects strictly from templates',
  'Ответы на интерактивные запросы beacon.ask()': 'Answer interactive beacon.ask() prompts',
  'Разрешённые проекты (белый список доступа для этого токена)': 'Allowed Projects (whitelist for this token)',
  '* (Все проекты)': '* (All Projects)',
  'Проекты с авто-одобрением (без постановки в очередь подтверждений)':
    'Auto-Approved Projects (bypass approval queue)',
  'Создать токен ИИ (SHA-256)': 'Create AI Token (SHA-256)',
  'Сохраните ваш токен (показывается только один раз):': 'Save your token now (shown only once):',
  'Подключение Claude Code / Cursor': 'Connect Claude Code / Cursor',
  'Гарантии защиты от Prompt Injection:': 'Prompt Injection Safeguards:',
  'Значения секретов и куки никогда не передаются ИИ (только имена).':
    'Secret and cookie values are never exposed to AI (names only).',
  'Вывод логов оборачивается в теги <untrusted_content>.': 'Log output is wrapped in <untrusted_content> tags.',
  'Произвольный shell exec недоступен по токену ИИ.': 'Arbitrary shell exec is disabled for AI tokens.',
  'Активных токенов нет.': 'No active tokens.',
  'Имя': 'Name',
  'Префикс': 'Prefix',
  'Права (Scopes)': 'Scopes',
  'IP / Лимит': 'IP / Limit',
  'Действие': 'Action',
  'ОТОЗВАН': 'REVOKED',
  'АКТИВЕН': 'ACTIVE',
  'Отозвать': 'Revoke',
  'Журнал действий ИИ (ai_audit_log)': 'AI Actions Audit Log (ai_audit_log)',
  'Записей в журнале действий ИИ пока нет.': 'No entries in the AI audit log yet.',
  'Токен': 'Token',
  'Инструмент / Путь': 'Tool / Path',
  'Аргументы / Результат': 'Arguments / Result',
  'IP / Длит.': 'IP / Duration',

  // CreateProjectModal & CommandPaletteModal
  'Мастер создания проекта (Service / Web API / Job)': 'Project Creation Wizard (Service / Web API / Job)',
  'Из готового шаблона': 'From Built-in Template',
  'Клонировать из GitHub (git clone)': 'Clone from GitHub (git clone)',
  'Ссылка на репозиторий GitHub:': 'GitHub Repository URL:',
  '1. Архитектура запуска процесса': '1. Process Execution Architecture',
  'Постоянный бот или воркер с автоперезапуском по PGID.': 'Long-running bot or worker with PGID auto-restart.',
  'Периодическая задача по расписанию, вебхуку или кнопке.':
    'Scheduled task triggered by cron, webhook, or manually.',
  '2. Короткое имя (slug)': '2. Short Name (slug)',
  'Группа': 'Group',
  'Краткое назначение': 'Short Description',
  'Порт ($PORT)': 'Port ($PORT)',
  'URL проверки живости (HTTP 200..399 или tcp://)': 'Healthcheck URL (HTTP 200..399 or tcp://)',
  '3. Шаблон окружения и кода': '3. Runtime & Code Template',
  'Расписание запуска (Cron / Интервал)': 'Execution Schedule (Cron / Interval)',
  'Политика супервизора и Автостарт': 'Supervisor Policy & Autostart',
  'Политика перезапуска:': 'Restart Policy:',
  'Автостарт при запуске Beacon': 'Autostart when Beacon boots',
  'Каждые N мин.': 'Every N min',
  'Каждые N ч.': 'Every N hr',
  'Раз в сутки': 'Daily',
  'Вручную': 'Manual',
  'Интервал (минут):': 'Interval (minutes):',
  'Интервал (часов):': 'Interval (hours):',
  'Время запуска:': 'Run time:',
  'Индивидуальные Куки и Telegram-токен проекта (необязательно)': 'Project Cookies & Telegram Token (optional)',
  'Токен бота (BOT_TOKEN)': 'Bot Token (BOT_TOKEN)',
  'ID чата (TG_CHAT_ID)': 'Chat ID (TG_CHAT_ID)',
  'JSON куки из Cookie-Editor:': 'Cookie-Editor JSON:',
  'Лимит ОЗУ группы PGID (МБ, 0 = без лимита)': 'PGID Group RAM Limit (MB, 0 = unlimited)',
  'Склонировать и создать': 'Clone & Create',
  'Создать проект': 'Create Project',
  'Быстрые действия': 'Quick Actions',
  'Навигация': 'Navigation',
  'Введите имя проекта, команду (start, stop, import) или раздел...':
    'Enter project name, command (start, stop, import), or section...',
  '↑↓ выбор · Enter выполнить · Esc закрыть': '↑↓ select · Enter run · Esc close',

  // Documentation Categories
  'Все разделы': 'All Sections',
  'Основы': 'Basics',
  'Разработка': 'Development',
  'Безопасность': 'Security',
  'Надёжность': 'Reliability',
  'Производительность': 'Performance',
  'ИИ и Автоматизация': 'AI & Automation',
  'Администрирование': 'Administration',
};

// Ordered phrase & regex replacements for composite / dynamic strings (never single-word partial matches!)
const PHRASE_REPLACEMENTS: Array<[RegExp | string, string]> = [
  // Documentation sections & headers
  ['1. Быстрый старт и устройство панели Beacon', '1. Quick Start & Beacon Architecture'],
  [
    'Как устроена автономная панель управления процессами без Docker: изоляция окружений, прямая запись логов и перехват выживших процессов.',
    'How the autonomous containerless process supervisor works: environment isolation, direct log descriptors, and survivor process recovery.',
  ],
  ['Нулевой оверхед без контейнеров Docker', 'Zero Container Overhead (No Docker Required)'],
  ['Изоляция групп процессов (PGID)', 'Process Group Isolation (PGID)'],
  ['Защита от падения при рестарте панели (No SIGPIPE)', 'Zero-SIGPIPE Direct Log Streaming'],
  ['Автоматический подхват после перезапуска (Recovery)', 'Automatic Survivor Process Recovery'],
  ['1.1. Горячие клавиши в браузере (Навигация и IDE Проектов)', '1.1. Browser Keyboard Shortcuts (Navigation & Project IDE)'],
  ['2. Типы проектов: Services, Web/API и Jobs', '2. Project Types: Services, Web/API & Scheduled Jobs'],
  ['3. Встроенный SDK (import beacon) для Python и Node.js', '3. Built-in SDK (import beacon) for Python & Node.js'],
  ['4. Куки, Секреты (0600) и интерактивный 2FA', '4. Cookies, Secrets (0600) & Interactive 2FA'],
  ['5. Супервизор, Crash-Loop, Dead Man’s Switch и Вебхуки', '5. Supervisor, Crash-Loop, Dead Man’s Switch & Webhooks'],
  ['6. Работа на мощном железе и тяжёлые нагрузки', '6. High-Concurrency & Heavy Workloads'],
  ['7. Подключение ИИ-агентов (MCP и REST API v1)', '7. Connecting AI Agents (MCP & REST API v1)'],
  ['8. Сеть, Tailscale, Роли (RBAC) и автозапуск Systemd', '8. Network, Tailscale, RBAC Roles & Systemd Autostart'],
  [
    '9. Обновление панели в 2 клика (Self-Update), Мультиязычность (RU/EN) и Окружение',
    '9. 2-Click Self-Update, Bilingual UI (RU/EN) & Runtime Check',
  ],
  ['10. Частые вопросы и устранение неполадок (FAQ)', '10. Frequently Asked Questions & Troubleshooting (FAQ)'],
  ['Быстрый переход по разделам', 'Quick Section Jump'],
  ['По вашему запросу ничего не найдено', 'No matching sections found'],
  ['Сбросить фильтры', 'Reset filters'],

  // Dynamic regex patterns & split JSX text nodes
  [/4\.\s*Пользователи\s*\((\d+)\),\s*Бэкап и Systemd/g, '4. Users ($1), Backup & Systemd'],
  [/4\.\s*Пользователи\s*\(/g, '4. Users ('],
  [/\),\s*Бэкап и Systemd/g, '), Backup & Systemd'],
  [/5\.\s*Журнал аудита\s*\((\d+)\)/g, '5. Audit Log ($1)'],
  [/5\.\s*Журнал аудита\s*\(/g, '5. Audit Log ('],
  [/Проекты на сервере\s*\((\d+)\s*из\s*(\d+)\)/g, 'Server Projects ($1 of $2)'],
  [/Проекты на сервере\s*\(/g, 'Server Projects ('],
  [/Реестр сохранённых секретов\s*\((\d+)\s*из\s*(\d+)\)/g, 'Saved Secrets Registry ($1 of $2)'],
  [/Реестр сохранённых секретов\s*\(/g, 'Saved Secrets Registry ('],
  [/Выпущенные токены ИИ\s*\((\d+)\)/g, 'Issued AI Tokens ($1)'],
  [/Выпущенные токены ИИ\s*\(/g, 'Issued AI Tokens ('],
  [/Очередь подтверждений действий ИИ\s*\((\d+)\s*ожидают\)/g, 'AI Action Approval Queue ($1 pending)'],
  [/Очередь подтверждений действий ИИ\s*\(/g, 'AI Action Approval Queue ('],
  [/Процессор\s*\((\d+)\s*ядер\)/g, 'Processor ($1 cores)'],
  [/Процессор\s*\(/g, 'Processor ('],
  [/Процесс Beacon\s*\(PID\s*(\d+)\)/g, 'Beacon Process (PID $1)'],
  [/Процесс Beacon\s*\(PID/g, 'Beacon Process (PID'],
  [/Сбои и OOM\s*\((\d+)\)/g, 'Failures & OOM ($1)'],
  [/Сбои и OOM\s*\(/g, 'Failures & OOM ('],
  [/Уведомления ТГ\s*\((\d+)\)/g, 'TG Notifications ($1)'],
  [/Уведомления ТГ\s*\(/g, 'TG Notifications ('],
  [/Очередь Cron\s*\((\d+)\)/g, 'Cron Queue ($1)'],
  [/Очередь Cron\s*\(/g, 'Cron Queue ('],
  [/Расписание\s*\((\d+)\)/g, 'Schedule ($1)'],
  [/Ближайшие запуски\s*\((\d+)\)/g, 'Upcoming Runs ($1)'],
  [/Разделов:\s*(\d+)\s*из\s*(\d+)/g, 'Sections: $1 of $2'],
  [/Разделов:\s*/g, 'Sections: '],
  [/Показано\s*(\d+)\s*из\s*(\d+)/gi, 'Showing $1 of $2'],
  [/Запущено\s*(\d+)\s*из\s*(\d+)/gi, 'Running $1 of $2'],
  [/Всего проектов:\s*(\d+)/gi, 'Total projects: $1'],
  [/Ядро:\s*([^\s(]+)\s*\((\d+)\s*ядер CPU\)/g, 'Kernel: $1 ($2 CPU cores)'],
  [/Ядро:\s*/g, 'Kernel: '],
  [/ядер CPU\)/g, 'CPU cores)'],
  [/ядер\)/g, 'cores)'],
  [/Проекты:\s*([0-9.]+)%\s*\((\d+)\s*проц\.\)/g, 'Projects: $1% ($2 proc.)'],
  [/Проекты:\s*([0-9.]+)\s*МБ/g, 'Projects: $1 MB'],
  [/Проекты:\s*/g, 'Projects: '],
  [/Свободно:\s*([0-9.]+)\s*МБ/g, 'Free: $1 MB'],
  [/Свободно:\s*/g, 'Free: '],
  [/Занято:\s*([0-9.]+)%/g, 'Used: $1%'],
  [/Занято:\s*/g, 'Used: '],
  [/Активно:\s*(\d+)/g, 'Active: $1'],
  [/Активно:\s*/g, 'Active: '],
  [/Работают:\s*(\d+)/g, 'Running: $1'],
  [/Работают:\s*/g, 'Running: '],
  [/Требуют внимания:\s*(\d+)/g, 'Needs attention: $1'],
  [/Требуют внимания:\s*/g, 'Needs attention: '],
  [/Статус бюджета ОЗУ:\s*В норме/g, 'RAM budget status: Healthy'],
  [/Статус бюджета ОЗУ:\s*Превышен/g, 'RAM budget status: Exceeded'],
  [/Статус бюджета ОЗУ:\s*/g, 'RAM budget status: '],
  [/Ошибка\s*\(код:\s*(\d+)\)/g, 'Failed (exit: $1)'],
  [/Failed\s*\(код:\s*(\d+)\)/g, 'Failed (exit: $1)'],
  [/Лимит\s*(\d+)\s*МБ/g, 'Limit $1 MB'],
  [/лимит\s*(\d+)\s*МБ/g, 'limit $1 MB'],
  [/^Лимит$/g, 'Limit'],
  [/^лимит$/g, 'limit'],
  [/Пакетов:\s*([0-9\s,\u00A0]+)/g, 'Packets: $1'],
  [/Пакетов:\s*/g, 'Packets: '],
  [/Всего:\s*([0-9.,]+\s*(?:МБ|ГБ|КБ|MB|GB|KB))/g, 'Total: $1'],
  [/Всего:\s*/g, 'Total: '],
  [/Пик:\s*([0-9.,]+\s*(?:МБ\/с|КБ\/с|MB\/s|KB\/s))/g, 'Peak: $1'],
  [/Пик:\s*/g, 'Peak: '],
  [/Слушают\s*\(LISTEN\):\s*(\d+)/g, 'Listening (LISTEN): $1'],
  [/Слушают\s*\(LISTEN\):\s*/g, 'Listening (LISTEN): '],
  [/Распознано кук:\s*(\d+)\s*шт\./g, 'Cookies parsed: $1'],
  [/Кук в профиле:\s*/g, 'Cookies in profile: '],
  [/(\d+)\s*проц\./g, '$1 proc.'],
  [/проц\.\)/g, 'proc.)'],
  [/(\d+)\s*сек\.?/g, '$1 sec'],
  [/(\d+)\s*мин\.?/g, '$1 min'],
  [/(\d+)\s*ч\.?/g, '$1 hr'],
  [/(\d+)\s*мс/g, '$1 ms'],
  [/(\d+)\/мин/g, '$1/min'],
  [/(\d+(?:[.,]\d+)?)\s*МБ\/с/g, '$1 MB/s'],
  [/(\d+(?:[.,]\d+)?)\s*КБ\/с/g, '$1 KB/s'],
  [/(\d+(?:[.,]\d+)?)\s*Б\/с/g, '$1 B/s'],
  [/(\d+(?:[.,]\d+)?)\s*ГБ/g, '$1 GB'],
  [/(\d+(?:[.,]\d+)?)\s*МБ/g, '$1 MB'],
  [/(\d+(?:[.,]\d+)?)\s*КБ/g, '$1 KB'],
  [/(\d+(?:[.,]\d+)?)\s*Б(?![А-Яа-яЁё])/g, '$1 B'],
  [/^МБ$/g, 'MB'],
  [/^ГБ$/g, 'GB'],
  [/^КБ$/g, 'KB'],
  [/\bиз\b/g, 'of'],
  ['логи:', 'logs:'],
  ['вручную', 'manual'],
  ['Точка подключения MCP:', 'MCP Endpoint:'],
  ['спецификация:', 'specification:'],
  ['Горячая клавиша (работает в браузере)', 'Shortcut (browser-safe)'],
  ['Комбинация клавиш', 'Keyboard Shortcut'],
  ['Где работает', 'Scope'],
  ['Действие в панели Beacon', 'Action in Beacon'],
  ['Вкладка / Действие', 'Tab / Action'],
  ['Назначение', 'Purpose'],
  ['Вся панель', 'Global (All Tabs)'],
  ['Метод SDK', 'SDK Method'],
  ['Возвращаемое значение', 'Return Value'],
  ['Описание', 'Description'],
  ['Тип проекта', 'Project Type'],
  ['Переменная PORT', 'PORT Env Var'],
  ['Авторестарт при сбое', 'Auto-Restart on Crash'],
  ['Расписание Cron / Interval', 'Cron / Interval Schedule'],
  ['Контроль таймаута (timeout_sec)', 'Timeout Control (timeout_sec)'],
  ['Открыть Главный дашборд', 'Open Main Dashboard'],
  ['Открыть IDE Проектов (Alt+2)', 'Open Projects IDE (Alt+2)'],
  ['Перейти в Проекты и Консоль', 'Go to Projects & Console'],
  ['Открыть Редактор кода', 'Open Code Editor'],
  ['Открыть Куки и Секреты', 'Open Cookies & Secrets'],
  ['Настроить Супервизор в Проектах', 'Configure Supervisor in Projects'],
  ['Открыть Шаблоны запуска', 'Open Launch Templates'],
  ['Открыть Доступ ИИ (MCP)', 'Open AI Access (MCP)'],
  ['Открыть Настройки и RBAC', 'Open Settings & RBAC'],
  ['Запустить диагностику Doctor', 'Run Doctor Diagnostics'],
];

const CYRILLIC_RE = /[А-Яа-яЁё]/;

export function translateStringToEn(input: string): string {
  if (!input || !CYRILLIC_RE.test(input)) return input;

  const leading = input.match(/^\s*/)?.[0] ?? '';
  const trailing = input.match(/\s*$/)?.[0] ?? '';
  const normalized = input.replace(/\s+/g, ' ').trim();

  if (EXACT_RU_TO_EN[normalized]) {
    return leading + EXACT_RU_TO_EN[normalized] + trailing;
  }

  let result = normalized;
  for (const [pattern, replacement] of PHRASE_REPLACEMENTS) {
    if (typeof pattern === 'string') {
      if (result.includes(pattern)) {
        result = result.split(pattern).join(replacement);
      }
    } else {
      result = result.replace(pattern, replacement);
    }
    if (!CYRILLIC_RE.test(result)) break;
  }

  return leading + result + trailing;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'] as const;

interface TrackedTextNode extends Text {
  __beaconOrigText?: string;
  __beaconLastEnText?: string;
}

function processDomTree(root: Node, lang: AppLanguage) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.currentNode;

  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const textNode = current as TrackedTextNode;
      const parent = textNode.parentElement;
      if (parent && !SKIP_TAGS.has(parent.tagName) && !parent.closest('[data-no-i18n="true"]')) {
        const currentVal = textNode.nodeValue || '';
        if (lang === 'en') {
          if (CYRILLIC_RE.test(currentVal) && currentVal !== textNode.__beaconLastEnText) {
            textNode.__beaconOrigText = currentVal;
          }
          const source = textNode.__beaconOrigText ?? currentVal;
          if (CYRILLIC_RE.test(source)) {
            const translated = translateStringToEn(source);
            if (translated !== currentVal) {
              textNode.__beaconLastEnText = translated;
              textNode.nodeValue = translated;
            }
          }
        } else if (lang === 'ru' && textNode.__beaconOrigText !== undefined) {
          if (currentVal === textNode.__beaconLastEnText) {
            textNode.nodeValue = textNode.__beaconOrigText;
          }
          delete textNode.__beaconOrigText;
          delete textNode.__beaconLastEnText;
        }
      }
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement;
      if (!SKIP_TAGS.has(el.tagName)) {
        for (const attr of TRANSLATABLE_ATTRS) {
          const val = el.getAttribute(attr);
          const origKey = `data-beacon-orig-${attr}`;
          if (lang === 'en' && val) {
            if (CYRILLIC_RE.test(val)) {
              el.setAttribute(origKey, val);
              const translated = translateStringToEn(val);
              if (translated !== val) {
                el.setAttribute(attr, translated);
              }
            }
          } else if (lang === 'ru') {
            const orig = el.getAttribute(origKey);
            if (orig !== null) {
              el.setAttribute(attr, orig);
              el.removeAttribute(origKey);
            }
          }
        }
      }
    }
    current = walker.nextNode();
  }
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<AppLanguage>(() => {
    try {
      const saved = localStorage.getItem('beacon_lang') || sessionStorage.getItem('beacon_lang');
      if (saved === 'en' || saved === 'ru') return saved;
    } catch {
      // ignore storage errors
    }
    return 'ru';
  });

  const setLang = useCallback((next: AppLanguage) => {
    setLangState(next);
    try {
      localStorage.setItem('beacon_lang', next);
      sessionStorage.setItem('beacon_lang', next);
      document.documentElement.lang = next;
    } catch {
      // ignore
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === 'ru' ? 'en' : 'ru');
  }, [lang, setLang]);

  const t = useCallback(
    (ruText: string, enText: string) => {
      return lang === 'en' ? enText : ruText;
    },
    [lang]
  );

  useEffect(() => {
    document.documentElement.lang = lang;
    const root = document.getElementById('root') || document.body;
    let isApplying = false;

    const runPass = () => {
      if (isApplying) return;
      isApplying = true;
      try {
        processDomTree(root, lang);
      } finally {
        isApplying = false;
      }
    };

    runPass();

    if (lang !== 'en') {
      return;
    }

    let rafId: number | null = null;
    const observer = new MutationObserver(() => {
      if (isApplying) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        runPass();
      });
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label'],
    });

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, toggleLang, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
