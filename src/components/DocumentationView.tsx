import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Search,
  Terminal,
  Code2,
  KeyRound,
  Shield,
  Bot,
  Activity,
  Cpu,
  Globe,
  Copy,
  Check,
  ArrowRight,
  HelpCircle,
  Zap,
  Clock,
  FolderCode,
  Settings,
  CheckSquare,
  X,
} from 'lucide-react';

interface DocumentationViewProps {
  onNavigateTab?: (tab: 'dashboard' | 'projects' | 'secrets' | 'ai_access' | 'settings' | 'acceptance') => void;
}

interface DocCodeBlock {
  label: string;
  lang: string;
  code: string;
}

interface DocSection {
  id: string;
  category: string;
  title: string;
  summary: string;
  keywords: string[];
  relatedTab?: {
    tab: 'dashboard' | 'projects' | 'secrets' | 'ai_access' | 'settings' | 'acceptance';
    label: string;
  };
  bullets: Array<{ title: string; text: string }>;
  table?: {
    headers: string[];
    rows: string[][];
  };
  codeBlocks?: DocCodeBlock[];
}

const DOC_SECTIONS: DocSection[] = [
  {
    id: 'quickstart',
    category: 'Основы',
    title: '1. Быстрый старт и устройство панели Beacon',
    summary:
      'Как устроена автономная панель управления процессами без Docker: изоляция окружений, прямая запись логов и перехват выживших процессов.',
    keywords: ['быстрый старт', 'обзор', 'архитектура', 'pgid', 'sigpipe', 'озу', 'venv', 'node_modules', 'безопасность'],
    relatedTab: { tab: 'dashboard', label: 'Открыть Главный дашборд' },
    bullets: [
      {
        title: 'Нулевой оверхед без контейнеров Docker',
        text: 'Beacon управляет Python-скриптами, Node.js-сервисами, веб-сайтами и Bash-задачами напрямую через ядро Linux. В простое сама панель потребляет менее 80 МБ ОЗУ.',
      },
      {
        title: 'Изоляция групп процессов (PGID)',
        text: 'Каждый запуск стартует в собственной сессии (os.setsid). При остановке сигнал SIGTERM (и через 5 секунд SIGKILL) отправляется всей группе процессов os.killpg(pgid), поэтому дочерние браузеры Chromium или воркеры никогда не остаются «зомби».',
      },
      {
        title: 'Защита от падения при рестарте панели (No SIGPIPE)',
        text: 'Стандартный вывод stdout/stderr каждого проекта пишется напрямую в файловый дескриптор лога на диске (buffering=0), минуя пайпы. Вы можете перезапускать или обновлять сам Beacon — запущенные боты и сайты продолжат работать без обрыва.',
      },
      {
        title: 'Автоматический подхват после перезапуска (Recovery)',
        text: 'При старте Beacon сверяет PID и точное время создания процесса (create_time) в ОС со списком активных запусков в SQLite и бесшовно восстанавливает мониторинг выживших сервисов.',
      },
    ],
    table: {
      headers: ['Вкладка / Действие', 'Назначение', 'Горячая клавиша (работает в браузере)'],
      rows: [
        ['Главный дашборд', 'Сводка CPU/RAM/Диска, сетевая статистика RX/TX, статусы всех проектов и инциденты', 'Alt + 1'],
        ['Проекты и Консоль', 'Полноценная IDE, файловый менеджер, живой терминал SSE, превью сайтов и тонкая настройка', 'Alt + 2'],
        ['Куки и Секреты (0600)', 'Хранилище API-ключей, JSON-кук из Cookie-Editor и привязка секретов к проектам', 'Alt + 3'],
        ['Доступ ИИ (MCP)', 'Выдача токенов для Claude Code / Cursor / Windsurf, очередь подтверждений и аудит', 'Alt + 4'],
        ['Настройки и RBAC', 'Пароль, сеть и Tailscale, системный Telegram-бот, лимиты диска, роли пользователей и бэкап', 'Alt + 5'],
        ['Приёмка (Doctor)', 'Автоматическая диагностика всех узлов сервера и проверка безопасности в 1 клик', 'Alt + 6'],
        ['Документация по панели', 'Полный справочник архитектуры, встроенного SDK, безопасности и горячих клавиш', 'Alt + 7'],
        ['Командная палитра', 'Мгновенный поиск проекта, запуск/остановка сервиса и переход по разделам', 'Ctrl + K (или Cmd + K)'],
      ],
    },
  },
  {
    id: 'hotkeys-ide',
    category: 'Основы',
    title: '1.1. Горячие клавиши в браузере (Навигация и IDE Проектов)',
    summary:
      'Все комбинации клавиш спроектированы специально для работы внутри веб-браузера: они перехватывают системные действия (Ctrl+S не сохраняет HTML-страницу, а Alt+W закрывает вкладку файла в IDE, не закрывая вкладку браузера).',
    keywords: [
      'горячие клавиши',
      'комбинации клавиш',
      'shortcuts',
      'hotkeys',
      'ctrl+s',
      'ctrl+shift+s',
      'ctrl+enter',
      'alt+p',
      'alt+w',
      'alt+f',
      'alt+1',
      'редактор кода',
    ],
    relatedTab: { tab: 'projects', label: 'Открыть IDE Проектов (Alt+2)' },
    bullets: [
      {
        title: 'Глобальное переключение разделов (Alt + 1…7)',
        text: 'Нажмите Alt+1 … Alt+7 в любом месте панели для мгновенного переключения между семью основными вкладками без использования мыши.',
      },
      {
        title: 'Безопасность для вкладок браузера (Alt+W и Alt+P)',
        text: 'Стандартная комбинация Ctrl+W жёстко зарезервирована браузерами под закрытие вкладки сайта, поэтому в редакторе Beacon для закрытия открытого файла используется Alt+W, а для быстрого поиска файла — Alt+P (или Ctrl+P).',
      },
      {
        title: 'Мгновенный деплой правок (Ctrl+S и Ctrl+Shift+S)',
        text: 'Во вкладке «Проекты и Консоль» нажатие Ctrl+S сразу записывает файл на диск сервера, а Ctrl+Shift+S сохраняет файл и тут же перезапускает процесс проекта (удобно при горячей отладке ботов и API).',
      },
      {
        title: 'Автодополнение Beacon SDK в коде',
        text: 'При наборе beacon. в редакторе кода автоматически всплывает интерактивное меню подсказок (notify, secret, ask, cookies_expired, state, ping) — выбор по стрелкам ↑/↓ и вставка по Enter или Tab.',
      },
    ],
    table: {
      headers: ['Комбинация клавиш', 'Где работает', 'Действие в панели Beacon'],
      rows: [
        ['Alt + 1 … Alt + 7', 'Вся панель', 'Мгновенный переход на вкладку №1…7 (Дашборд, Проекты, Секреты, ИИ, Настройки, Приёмка, Документация)'],
        ['Ctrl + K / Cmd + K', 'Вся панель', 'Открыть / закрыть глобальную командную палитру'],
        ['Ctrl + S / Cmd + S', 'Проекты и Консоль', 'Сохранить текущий открытый файл на диск сервера (блокирует стандартное «Сохранить веб-страницу»)'],
        ['Ctrl + Shift + S', 'Проекты и Консоль', 'Сохранить открытый файл и сразу перезапустить текущий проект (Hot Reload)'],
        ['Ctrl + Enter', 'Проекты и Консоль', 'Запустить (или перезапустить) выбранный проект'],
        ['Alt + P (или Ctrl + P)', 'Проекты и Консоль', 'Быстрый переход к любому файлу проекта по имени (Fuzzy File Finder)'],
        ['Alt + W', 'Проекты и Консоль', 'Закрыть активную вкладку файла в редакторе (не закрывая вкладку браузера)'],
        ['Alt + F (или Ctrl + F в коде)', 'Проекты и Консоль', 'Открыть панель поиска и замены по коду с переключением регистра (Aa)'],
        ['Escape', 'Вся панель / Модалки', 'Закрыть открытое модальное окно, панель поиска, меню действий или автодополнение SDK'],
      ],
    },
  },
  {
    id: 'project-types',
    category: 'Проекты',
    title: '2. Типы проектов: Services, Web/API и Jobs',
    summary:
      'Как правильно выбрать тип проекта для Telegram-бота, парсера по расписанию, веб-приложения FastAPI/Express или тяжёлого воркера.',
    keywords: ['service', 'web', 'job', 'cron', 'расписание', 'порт', 'healthcheck', 'превью', 'автозапуск', 'project.yaml'],
    relatedTab: { tab: 'projects', label: 'Перейти в Проекты и Консоль' },
    bullets: [
      {
        title: 'Постоянный сервис (Service / Daemon)',
        text: 'Предназначен для Telegram/Discord-ботов, фоновых слушателей очередей и демонов. Поддерживает автозапуск при старте сервера (autostart) и автоматический перезапуск при падении (restart_policy: always или on-failure).',
      },
      {
        title: 'Веб-сервис / Сайт / API (Web)',
        text: 'Предназначен для HTTP-серверов (FastAPI, Uvicorn, Gunicorn, Express, Next.js). Панель автоматически передаёт переменную окружения PORT, проверяет доступность порта и HTTP Healthcheck URL, а также позволяет открыть живое превью прямо внутри вкладки «Проекты».',
      },
      {
        title: 'Периодическая или разовая задача (Job)',
        text: 'Предназначена для парсеров, бэкапов, генерации отчётов и чекеров кук. Запускается вручную, по Cron-выражению (например, */15 * * * *), с фиксированным интервалом, раз в сутки или по внешнему вебхуку.',
      },
      {
        title: 'Декларативный файл project.yaml',
        text: 'Все настройки проекта автоматически синхронизируются с файлом project.yaml в папке проекта. При переносе папки или импорте ZIP-архива настройки подхватываются автоматически.',
      },
    ],
    table: {
      headers: ['Тип проекта', 'Переменная PORT', 'Авторестарт при сбое', 'Расписание Cron / Interval', 'Контроль таймаута (timeout_sec)'],
      rows: [
        ['service (Демон / Бот)', 'Опционально', 'Да (on-failure / always)', 'Плановый cron_restart', 'Не ограничен (работает 24/7)'],
        ['web (Сайт / HTTP API)', 'Передаётся автоматически', 'Да ( + HTTP Healthcheck)', 'Плановый cron_restart', 'Не ограничен (работает 24/7)'],
        ['job (Скрипт / Парсер)', 'Нет', 'Повторы max_retries при ошибке', 'Да (cron / interval / daily)', 'Жёсткий лимит времени выполнения'],
      ],
    },
    codeBlocks: [
      {
        label: 'Пример декларативного конфига project.yaml',
        lang: 'yaml',
        code: `name: market-api
type: web
runtime: python
cmd: python3 -m uvicorn main:app --host 127.0.0.1 --port 8091 --workers 2
port: 8091
healthcheck_url: http://127.0.0.1:8091/health
ram_limit_mb: 512
autostart: true
restart_policy: always
secrets:
  - openai_api_key
  - market_cookies
env:
  LOG_LEVEL: info
  PYTHONUNBUFFERED: "1"`,
      },
    ],
  },
  {
    id: 'sdk-guide',
    category: 'Разработка',
    title: '3. Встроенный SDK (import beacon) для Python и Node.js',
    summary:
      'Во всех проектах без установки дополнительных пакетов доступна библиотека beacon для отправки уведомлений, чтения секретов, запроса 2FA-кодов и сохранения состояния.',
    keywords: [
      'sdk',
      'import beacon',
      'notify',
      'secret',
      'cookies_expired',
      'ask',
      'ping',
      'state',
      'python',
      'node',
      'javascript',
    ],
    relatedTab: { tab: 'projects', label: 'Открыть Редактор кода' },
    bullets: [
      {
        title: 'Подключение без pip install / npm install',
        text: 'Панель автоматически пробрасывает PYTHONPATH и NODE_PATH при запуске любого проекта. Достаточно написать import beacon в Python или const beacon = require("beacon") в Node.js.',
      },
      {
        title: 'Персистентное Key-Value хранилище beacon.state',
        text: 'Позволяет сохранять курсоры парсинга, ID последнего обработанного сообщения или токены между запусками без создания собственной БД.',
      },
      {
        title: 'Мгновенные уведомления beacon.notify()',
        text: 'Отправляет сообщение в системный Telegram-бот панели (а также в ntfy/Webhook, если они настроены) с указанием имени проекта и уровня важности (info, warning, error).',
      },
    ],
    table: {
      headers: ['Метод SDK', 'Описание', 'Возвращаемое значение'],
      rows: [
        ['beacon.notify(text, level="info")', 'Отправить уведомление в Telegram / панель (info, warn, error)', 'bool (успех доставки)'],
        ['beacon.secret(name, as_path=False)', 'Прочитать значение секрета/кук или получить путь к файлу 0600', 'str | list | dict | None'],
        ['beacon.cookies_expired(name, note="")', 'Пометить куки протухшими и поднять красный баннер в панели и ТГ', 'bool'],
        ['beacon.ask(prompt, timeout=300)', 'Запросить 2FA/SMS-код у оператора в ТГ или веб-панели и ждать ответ', 'str | None'],
        ['beacon.ping(token=None)', 'Отправить сигнал жизни для Dead Man’s Switch (контроль зависания)', 'bool'],
        ['beacon.state.get(key, default=None)', 'Прочитать сохранённое значение из SQLite-хранилища проекта', 'Any'],
        ['beacon.state.set(key, value)', 'Атомарно сохранить JSON-значение в хранилище проекта', 'bool'],
        ['beacon.state.delete(key)', 'Удалить ключ из хранилища состояния проекта', 'bool'],
      ],
    },
    codeBlocks: [
      {
        label: 'Python — полный пример использования SDK',
        lang: 'python',
        code: `import time
import beacon

# 1. Чтение секрета из защищённого хранилища (обязательно разрешите его в настройках проекта!)
api_key = beacon.secret("my_service_token")
cookies = beacon.secret("shop_cookies")  # для cookie_json вернёт готовый list[dict]

# 2. Чтение и запись персистентного состояния между запусками
last_order_id = beacon.state.get("last_order_id", default=0)
print(f"Начинаем проверку с заказа #{last_order_id}")

# 3. Запрос 2FA / SMS-кода у человека (скрипт встанет на паузу до ответа в ТГ или веб-панели)
if not cookies:
    sms_code = beacon.ask("Введите 6-значный код из СМС для входа:", timeout=300)
    if not sms_code:
        beacon.notify("Не дождались СМС-кода за 5 минут!", level="error")
        raise SystemExit(1)

# 4. Отметка протухших кук (если сайт вернул 401/403)
# beacon.cookies_expired("shop_cookies", "Сессия истекла (HTTP 403), обновите куки")

# 5. Сохранение прогресса и отправка пульса Dead Man's Switch
beacon.state.set("last_order_id", last_order_id + 1)
beacon.ping()
beacon.notify("Парсинг успешно завершён", level="info")`,
      },
      {
        label: 'Node.js — пример использования SDK',
        lang: 'javascript',
        code: `const beacon = require('beacon');

async function main() {
  const token = await beacon.secret('api_token');
  const cursor = (await beacon.state.get('cursor')) || 0;

  await beacon.notify(\`Воркер запущен с позиции \${cursor}\`, 'info');

  // Если требуется ввод кода подтверждения от пользователя:
  // const code = await beacon.ask('Введите код из Telegram:', 180);

  await beacon.state.set('cursor', cursor + 10);
  await beacon.ping();
}

main().catch(async (err) => {
  await beacon.notify(\`Ошибка воркера: \${err.message}\`, 'error');
  process.exit(1);
});`,
      },
    ],
  },
  {
    id: 'secrets-and-cookies',
    category: 'Безопасность',
    title: '4. Куки, Секреты (0600) и интерактивный 2FA',
    summary:
      'Как безопасно хранить токены, импортировать куки из браузера через Cookie-Editor в один клик и автоматически скрывать секреты в логах.',
    keywords: ['куки', 'cookie-editor', 'секреты', '0600', 'маскировка', 'redaction', '2fa', 'ask', 'acl', 'привязка'],
    relatedTab: { tab: 'secrets', label: 'Открыть Куки и Секреты' },
    bullets: [
      {
        title: 'Хранение на диске с правами 0600',
        text: 'Каждый секрет записывается атомарно в отдельный файл в каталоге data/secrets/<имя> с правами 0600 (чтение только владельцем).',
      },
      {
        title: 'Белый список доступа по проектам (ACL)',
        text: 'Проект не может прочитать чужой секрет: чтобы вызов beacon.secret("name") сработал, секрет должен быть явно отмечен галочкой в настройках этого проекта или во вкладке «Куки и Секреты».',
      },
      {
        title: 'Автоматическая маскировка (Redaction) в логах',
        text: 'Любой текстовый секрет или значение куки длиной от 8 символов (включая их URL-encoded, JSON и Base64 представления) автоматически заменяется в логах и ответах ИИ на ***SECRET:<name>***. Дополнительно регулярными выражениями маскируются токены Telegram, GitHub, OpenAI и Bearer-заголовки.',
      },
      {
        title: 'Импорт из браузера через расширение Cookie-Editor',
        text: 'Установите расширение Cookie-Editor в браузере, авторизуйтесь на целевом сайте, нажмите Export → Export as JSON и вставьте скопированный массив во вкладке «Куки и Секреты».',
      },
    ],
  },
  {
    id: 'reliability-supervisor',
    category: 'Надёжность',
    title: '5. Супервизор, Crash-Loop, Dead Man’s Switch и Вебхуки',
    summary:
      'Защита от бесконечных перезапусков, экспоненциальный Backoff, отслеживание тихого зависания скриптов и запуск по внешним вебхукам.',
    keywords: ['crash-loop', 'backoff', 'dead mans switch', 'heartbeat', 'ping', 'webhook', 'hmac', 'цепочки', 'ram limit'],
    relatedTab: { tab: 'projects', label: 'Настроить Супервизор в Проектах' },
    bullets: [
      {
        title: 'Экспоненциальный Backoff и защита от Crash-Loop',
        text: 'Если сервис падает быстрее чем за min_uptime_sec (по умолчанию 10 с), задержка перед следующим рестартом удваивается (backoff_min_sec → backoff_max_sec). После исчерпания лимита max_restarts (например, 5 раз подряд) проект переводится в статус crash_loop и отправляет критический алерт.',
      },
      {
        title: 'Контроль памяти по сумме RSS группы процессов (PGID)',
        text: 'Вместо RLIMIT_AS (который ломает выделение виртуальной памяти в V8/Node.js и многопоточном Python на ARM64) супервизор каждые 2 секунды считает реальный физический RSS родителя и всех дочерних процессов. При превышении ram_limit_mb вся группа корректно останавливается со статусом killed_oom.',
      },
      {
        title: 'Dead Man’s Switch (Контроль пульса beacon.ping)',
        text: 'Бывает, что процесс формально жив (PID существует), но завис на сетевом сокете. Если задать в настройках проекта интервал пульса (например, 60 сек), панель проверит, вызывает ли скрипт beacon.ping(), и пришлёт тревогу при молчании.',
      },
      {
        title: 'Запуск по внешнему Webhook (с поддержкой HMAC-SHA256)',
        text: 'У каждого проекта есть уникальный токен вебхука для запуска из GitHub Actions, GitLab или внешних сервисов. При включении HMAC-секрета панель дополнительно проверяет подпись заголовка X-Hub-Signature-256.',
      },
    ],
    codeBlocks: [
      {
        label: 'Запуск проекта извне через HTTP Webhook (curl)',
        lang: 'bash',
        code: `# Простой запуск по токену вебхука проекта:
curl -X POST "http://127.0.0.1:8050/api/webhooks/run/<WEBHOOK_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"params": {"TARGET_URL": "https://example.com"}}'`,
      },
    ],
  },
  {
    id: 'heavy-workloads',
    category: 'Производительность',
    title: '6. Работа на мощном железе и тяжёлые нагрузки',
    summary:
      'Как настраивать многопоточные веб-серверы, ресурсоёмкие парсеры с браузерами и распределять ядра CPU и ОЗУ на мощных VPS и выделенных серверах.',
    keywords: ['мощное железо', 'воркеры', 'uvicorn', 'gunicorn', 'pm2', 'нагрузка', 'сеть', 'трафик', 'оптимизация'],
    relatedTab: { tab: 'projects', label: 'Открыть Шаблоны запуска' },
    bullets: [
      {
        title: 'Многопроцессные Web/API серверы (Uvicorn / Gunicorn)',
        text: 'На многоядерных серверах запускайте FastAPI/Django с флагом --workers N (по числу ядер). Beacon отслеживает всю группу процессов по единому PGID, суммирует их CPU% и RSS-память и показывает количество активных процессов (N проц.) на карточке проекта.',
      },
      {
        title: 'Калькулятор бюджета ОЗУ и защита от перегрузки',
        text: 'В настройках каждого проекта шкала памяти автоматически подстраивается под объём ОЗУ вашего сервера (от 64 МБ до десятков гигабайт) и показывает, сколько свободной памяти остаётся системе.',
      },
      {
        title: 'Плавный автозапуск (Autostart Stagger)',
        text: 'Если на сервере настроено 20+ тяжёлых проектов с автозапуском, параметр «Задержка автостарта (сек)» в Настройках запускает их по очереди с паузой, исключая пиковый шторм CPU и диска при загрузке ОС.',
      },
      {
        title: 'Мониторинг сетевого трафика на главном дашборде',
        text: 'Блок сетевой телеметрии на Главном дашборде читает счётчики ядра /proc/net/dev и /proc/net/tcp, позволяя в реальном времени видеть скорость входящего/исходящего потока (RX/TX в КБ/с и МБ/с), число активных TCP-соединений и нагрузку по интерфейсам.',
      },
    ],
  },
  {
    id: 'ai-mcp-api',
    category: 'ИИ и Автоматизация',
    title: '7. Подключение ИИ-агентов (MCP и REST API v1)',
    summary:
      'Как подключить Claude Code, Cursor, Windsurf или собственного автономного агента к серверу по протоколу Streamable HTTP MCP (/mcp) и REST API (/api/v1/).',
    keywords: ['mcp', 'ai', 'claude', 'cursor', 'windsurf', 'токен', 'api v1', 'подтверждение', 'approvals', 'sse'],
    relatedTab: { tab: 'ai_access', label: 'Открыть Доступ ИИ (MCP)' },
    bullets: [
      {
        title: 'Встроенный сервер Model Context Protocol (/mcp)',
        text: 'Поддерживает стандарт JSON-RPC 2.0 (методы initialize, tools/list, tools/call). Агент может самостоятельно смотреть статус сервера, читать замаскированные логи, править файлы проектов, устанавливать зависимости и перезапускать сервисы.',
      },
      {
        title: 'Гранулярные права (Scopes) и привязка к проектам',
        text: 'Каждому токену можно выдать только нужные права: read (чтение статуса и логов), process (запуск/остановка), files (чтение/запись кода), secrets_acl (привязка секретов без чтения их значений) и опасный admin.',
      },
      {
        title: 'Ручное подтверждение опасных операций (Human-in-the-Loop)',
        text: 'Если для токена включён флаг «Требовать подтверждение опасных действий», попытка удалить проект или остановить сервис создаст заявку в очереди во вкладке «Доступ ИИ (MCP)» и уведомление в Telegram.',
      },
      {
        title: 'Кнопка мгновенной блокировки (Kill-Switch)',
        text: 'Во вкладке «Доступ ИИ (MCP)» доступна кнопка экстренной паузы, которая в один клик блокирует все запросы по всем токенам без их удаления.',
      },
    ],
    codeBlocks: [
      {
        label: 'Подключение в Claude Code (CLI)',
        lang: 'bash',
        code: `claude mcp add --transport http beacon http://<IP_ВАШЕГО_СЕРВЕРА>:8050/mcp \\
  --header "Authorization: Bearer bcn_live_ВАШ_ТОКЕН"`,
      },
      {
        label: 'Конфигурация для Cursor / Windsurf (mcp.json)',
        lang: 'json',
        code: `{
  "mcpServers": {
    "beacon": {
      "url": "http://<IP_ВАШЕГО_СЕРВЕРА>:8050/mcp",
      "headers": {
        "Authorization": "Bearer bcn_live_ВАШ_ТОКЕН"
      }
    }
  }
}`,
      },
    ],
  },
  {
    id: 'security-network-systemd',
    category: 'Администрирование',
    title: '8. Сеть, Tailscale, Роли (RBAC) и автозапуск Systemd',
    summary:
      'Защита панели в локальной сети и через VPN Tailscale, разделение прав пользователей (viewer / operator / admin) и установка службы Linux.',
    keywords: ['tailscale', 'cidr', 'подсети', 'rbac', 'роли', 'systemd', 'бэкап', 'zip', 'безопасность', 'прокси'],
    relatedTab: { tab: 'settings', label: 'Открыть Настройки и RBAC' },
    bullets: [
      {
        title: 'Сетевой фильтр подсетей (CIDR + Tailscale)',
        text: 'По умолчанию панель принимает подключения из локальных подсетей (127.0.0.0/8, 192.168.0.0/16, 10.0.0.0/8) и VPN-сети Tailscale (100.64.0.0/10). Вы можете тонко настроить разрешённые CIDR-диапазоны во вкладке «Настройки».',
      },
      {
        title: 'Ролевая модель доступа (RBAC)',
        text: 'Создавайте отдельные учётные записи для коллег: роль viewer разрешает только просмотр дашборда и логов (с маскировкой чувствительных URL), operator позволяет запускать проекты и отвечать на 2FA-запросы, а admin даёт полный доступ к секретам и настройкам.',
      },
      {
        title: 'Автозапуск через systemd с KillMode=process',
        text: 'В юните beacon.service используется директива KillMode=process, чтобы при перезапуске самой службы Beacon через systemctl restart beacon система systemd не убивала дочерние процессы ваших проектов.',
      },
    ],
    codeBlocks: [
      {
        label: 'Установка и проверка службы systemd в Linux',
        lang: 'bash',
        code: `# Сгенерировать актуальный beacon.service можно прямо во вкладке «Настройки» -> «Бэкап и Systemd»
sudo cp /opt/beacon/data/generated/beacon.service /etc/systemd/system/beacon.service
sudo systemctl daemon-reload
sudo systemctl enable --now beacon
sudo systemctl status beacon`,
      },
    ],
  },
  {
    id: 'faq-troubleshooting',
    category: 'Справка',
    title: '9. Частые вопросы и устранение неполадок (FAQ)',
    summary:
      'Быстрые решения типичных ситуаций: почему не читается секрет, как освободить место на диске, что делать при Safe Mode и как проверить сервер.',
    keywords: ['faq', 'ошибки', 'проблемы', 'safe mode', 'диск', 'doctor', 'порт занят', 'зависимости'],
    relatedTab: { tab: 'acceptance', label: 'Запустить диагностику Doctor' },
    bullets: [
      {
        title: 'Скрипт вызывает beacon.secret("name"), но получает None или ошибку 403',
        text: 'Проверьте две вещи: 1) Секрет с таким именем создан во вкладке «Куки и Секреты»; 2) Этот секрет отмечен галочкой в списке разрешённых для данного проекта (во вкладке «Куки и Секреты» или в настройках самого проекта).',
      },
      {
        title: 'Запуск проектов по расписанию заблокирован (Disk Guard)',
        text: 'Когда свободное место на диске падает ниже критического порога (по умолчанию 150 МБ), панель блокирует новые фоновые запуски для защиты SQLite от повреждения. Перейдите в «Настройки» → «Ресурсы и Диск» и нажмите «Очистить кэш pip/npm, старые логи и WAL».',
      },
      {
        title: 'Что такое Safe Mode (Безопасный режим)?',
        text: 'При включённом Safe Mode панель стартует без автоматического запуска проектов (autostart и планировщик приостановлены). Это удобно, если какой-то тяжёлый проект перегружает сервер при старте — вы можете спокойно зайти в панель и отключить его.',
      },
      {
        title: 'Как быстро проверить, что все функции сервера работают исправно?',
        text: 'Откройте вкладку «Приёмка (Doctor)» в левом меню и нажмите «Запустить полную проверку». Встроенный доктор проверит права 0600, изоляцию путей, лимиты памяти, работу SQLite WAL и сетевое окружение.',
      },
    ],
  },
];

const CATEGORIES = ['Все разделы', 'Основы', 'Проекты', 'Разработка', 'Безопасность', 'Надёжность', 'Производительность', 'ИИ и Автоматизация', 'Администрирование', 'Справка'];

export const DocumentationView: React.FC<DocumentationViewProps> = ({ onNavigateTab }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Все разделы');
  const [activeSectionId, setActiveSectionId] = useState<string>('quickstart');
  const [copiedCodeKey, setCopiedCodeKey] = useState<string | null>(null);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredSections = useMemo(() => {
    return DOC_SECTIONS.filter((sec) => {
      if (selectedCategory !== 'Все разделы' && sec.category !== selectedCategory) {
        return false;
      }
      if (!normalizedQuery) return true;
      const haystack = [
        sec.title,
        sec.summary,
        sec.category,
        ...sec.keywords,
        ...sec.bullets.map((b) => `${b.title} ${b.text}`),
        ...(sec.codeBlocks || []).map((c) => `${c.label} ${c.code}`),
        ...(sec.table ? [...sec.table.headers, ...sec.table.rows.flat()] : []),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, selectedCategory]);

  const handleCopyCode = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCodeKey(key);
      setTimeout(() => setCopiedCodeKey(null), 1800);
    } catch {
      // ignore
    }
  };

  const scrollToSection = (id: string) => {
    setActiveSectionId(id);
    const el = document.getElementById(`doc-sec-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="space-y-5">
      {/* Шапка документации с живым поиском */}
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shrink-0">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-bold text-white">
                  Документация и справочник панели Beacon
                </h2>
                <p className="text-xs text-slate-400">
                  Подробное руководство по настройке проектов, встроенному SDK (<code className="font-mono text-indigo-300">import beacon</code>), секретам 0600, MCP-агентам и эксплуатации
                </p>
              </div>
            </div>
          </div>

          {/* Поле быстрого поиска */}
          <div className="relative w-full lg:w-96 shrink-0">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по разделам, командам, SDK, ошибкам..."
              aria-label="Поиск по документации"
              className="w-full bg-[#0f172a] border border-slate-700 focus:border-indigo-500 rounded-lg pl-10 pr-9 py-2 text-xs text-white placeholder-slate-500 outline-none transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                title="Очистить поиск"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-0.5 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Быстрые фильтры по категориям */}
        <div className="flex flex-wrap items-center gap-1.5 mt-4 pt-3.5 border-t border-slate-800/80">
          {CATEGORIES.map((cat) => {
            const active = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-900/70 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'
                }`}
              >
                {cat}
              </button>
            );
          })}

          <span className="ml-auto text-[11px] font-mono text-slate-400">
            Найдено разделов: {filteredSections.length} из {DOC_SECTIONS.length}
          </span>
        </div>
      </div>

      {/* Основная сетка: Оглавление слева + Статьи справа */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Боковое оглавление */}
        <aside className="lg:col-span-3 bg-[#1e293b] border border-slate-800 rounded-xl p-3.5 lg:sticky lg:top-20 space-y-3">
          <div className="px-2 py-1 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Разделы справки
            </span>
            <span className="text-[11px] font-mono text-indigo-400">{filteredSections.length}</span>
          </div>

          <nav className="space-y-1 max-h-[65vh] overflow-y-auto pr-1">
            {filteredSections.map((sec) => {
              const isSelected = activeSectionId === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => scrollToSection(sec.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors flex flex-col gap-0.5 cursor-pointer ${
                    isSelected
                      ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 font-semibold'
                      : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                  }`}
                >
                  <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                    {sec.category}
                  </span>
                  <span className="leading-snug">{sec.title}</span>
                </button>
              );
            })}
          </nav>

          {/* Шпаргалка быстрых вызовов SDK */}
          <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-lg space-y-1.5">
            <div className="text-[11px] font-semibold text-indigo-300 flex items-center gap-1.5">
              <Code2 className="w-3.5 h-3.5" />
              Шпаргалка SDK (Python)
            </div>
            <div className="text-[11px] font-mono text-slate-300 space-y-1">
              <div>import beacon</div>
              <div className="text-slate-400">beacon.secret("name")</div>
              <div className="text-slate-400">beacon.notify("ok")</div>
              <div className="text-slate-400">beacon.ask("Код:")</div>
              <div className="text-slate-400">beacon.state.get("k")</div>
              <div className="text-slate-400">beacon.ping()</div>
            </div>
          </div>
        </aside>

        {/* Контент разделов */}
        <div className="lg:col-span-9 space-y-5">
          {filteredSections.length === 0 ? (
            <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-8 text-center space-y-3">
              <HelpCircle className="w-8 h-8 text-slate-400 mx-auto" />
              <div className="text-sm font-semibold text-white">
                По запросу «{searchQuery}» ничего не найдено
              </div>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Попробуйте ввести другое ключевое слово (например: <code className="font-mono text-indigo-300">secret</code>,{' '}
                <code className="font-mono text-indigo-300">ask</code>, <code className="font-mono text-indigo-300">cron</code>,{' '}
                <code className="font-mono text-indigo-300">mcp</code>, <code className="font-mono text-indigo-300">tailscale</code>).
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedCategory('Все разделы');
                }}
                className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium cursor-pointer"
              >
                Показать все разделы
              </button>
            </div>
          ) : (
            filteredSections.map((sec) => (
              <section
                key={sec.id}
                id={`doc-sec-${sec.id}`}
                onMouseEnter={() => setActiveSectionId(sec.id)}
                className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-4 scroll-mt-20"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-slate-800">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-indigo-950/80 text-indigo-300 border border-indigo-500/30 rounded">
                        {sec.category}
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-white">{sec.title}</h3>
                    <p className="text-xs text-slate-300 leading-relaxed">{sec.summary}</p>
                  </div>

                  {sec.relatedTab && onNavigateTab && (
                    <button
                      type="button"
                      onClick={() => onNavigateTab(sec.relatedTab!.tab)}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white border border-slate-700 hover:border-indigo-500 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                    >
                      {sec.relatedTab.label}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Ключевые пункты раздела */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {sec.bullets.map((b, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 bg-[#0f172a]/80 border border-slate-800/90 rounded-lg space-y-1"
                    >
                      <div className="text-xs font-semibold text-indigo-300">{b.title}</div>
                      <p className="text-xs text-slate-300 leading-relaxed">{b.text}</p>
                    </div>
                  ))}
                </div>

                {/* Таблица справочника (если есть) */}
                {sec.table && (
                  <div className="overflow-x-auto border border-slate-800 rounded-lg">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-900/80 border-b border-slate-800 text-slate-300">
                          {sec.table.headers.map((h, i) => (
                            <th key={i} className="py-2.5 px-3.5 font-semibold">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {sec.table.rows.map((row, rIdx) => (
                          <tr key={rIdx} className="hover:bg-slate-800/30">
                            {row.map((cell, cIdx) => (
                              <td
                                key={cIdx}
                                className={`py-2 px-3.5 ${
                                  cIdx === 0 ? 'font-mono text-indigo-300 font-medium' : 'text-slate-300'
                                }`}
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Примеры кода с кнопкой копирования */}
                {sec.codeBlocks && sec.codeBlocks.length > 0 && (
                  <div className="space-y-3">
                    {sec.codeBlocks.map((cb, cIdx) => {
                      const codeKey = `${sec.id}-${cIdx}`;
                      const isCopied = copiedCodeKey === codeKey;
                      return (
                        <div
                          key={codeKey}
                          className="bg-[#0b0f17] border border-slate-800 rounded-lg overflow-hidden"
                        >
                          <div className="px-3.5 py-2 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
                              <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                              {cb.label}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleCopyCode(codeKey, cb.code)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer"
                            >
                              {isCopied ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" />
                                  Скопировано
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  Копировать код
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="p-3.5 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
                            {cb.code}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
