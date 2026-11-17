import { ProjectItem } from '../../types/hub';
import { getRunStatusBadge } from '../../utils/hubLogic';

export function statusBadge(status: string | undefined): {
  label: string;
  cls: string;
  colorClass: string;
  dotClass: string;
} {
  const b = getRunStatusBadge(status || 'stopped');
  return {
    label: b.label,
    cls: b.colorClass,
    colorClass: b.colorClass,
    dotClass: b.dotClass,
  };
}

export const DEFAULTS = {
  POLL_RUNS_MS: 2500,
  POLL_LOG_MS: 2000,
  STATUS_CLEAR_MS: 2800,
  SIDEBAR_MAX_HEIGHT_PX: 640,
  EDITOR_HEIGHT_NORMAL_PX: 470,
  EDITOR_HEIGHT_TALL_PX: 660,
  DEFAULT_RAM_LIMIT_MB: 128,
  RAM_LIMIT_MB: 128,
  TIMEOUT_SEC: 0,
  HEALTHCHECK_INTERVAL_SEC: 30,
  MIN_UPTIME_SEC: 10,
  MAX_RESTARTS: 5,
  RESTART_DELAY_SEC: 3,
  BACKOFF_MIN_SEC: 2,
  BACKOFF_MAX_SEC: 300,
  MAX_RETRIES: 2,
  RETRY_DELAY_SEC: 30,
  HEARTBEAT_INTERVAL_SEC: 0,
  HEARTBEAT_GRACE_SEC: 60,
  SCHED_EVERY_MIN: 15,
  SCHED_EVERY_HOUR: 1,
  SCHED_DAILY_TIME: '09:00',
  SCHED_INTERVAL_SEC: 300,
  INITIAL_RUNS_LIMIT: 15,
  RUNS_PAGE_STEP: 15,
  RUNS_PAGE_SIZE: 15,
  APPROX_LINE_HEIGHT_PX: 20,
} as const;

export const LABELS = {
  LOADING: 'Загрузка файла...',
  SAVING: 'Сохранение...',
  SAVED: 'Сохранено ✓',
  startNowBtn: 'Запустить сейчас',
  stopBtn: 'Остановить',
  restartBtn: 'Рестарт',
  healthProbeBtn: 'Проверить /health',
  moreActionsBtn: 'Действия',
  saveFileBtn: 'Сохранить (Ctrl+S)',
  saveConfigBtn: 'Сохранить настройки',
  saveCookiesBtn: 'Сохранить и привязать куки к проекту',
  saveTelegramProxyBtn: 'Сохранить Telegram и Прокси в ENV',
  workspaceEmptyTitle: 'Рабочая область проектов пуста',
  workspaceEmptySubtitle:
    'Создайте новый проект (бота, веб-сервис с портом $PORT или периодическую задачу) либо загрузите готовые эталонные шаблоны в один клик.',
  dirtyDeployWarning:
    'Файлы или настройки проекта были изменены после запуска процесса — перезапустите проект, чтобы изменения вступили в силу.',
  dirtyDeployAction: 'Перезапустить сейчас (Ctrl+Shift+S)',
  actionsMenuLabel: 'Действия',
  fuzzyModalTitle: 'Быстрый переход к файлу проекта (Alt+P)',
  deleteFileModalTitle: 'Подтверждение удаления',
  dragDropHint: 'Перетащите файлы или .zip сюда для загрузки в выбранную папку',
} as const;

export type NoticeTone = 'success' | 'error' | 'warning' | 'info';

export function classifyStatusNotice(message: string): NoticeTone {
  const lower = (message || '').toLowerCase();
  if (
    lower.includes('ошибк') ||
    lower.includes('сбой') ||
    lower.includes('не удал') ||
    lower.includes('невалид') ||
    lower.includes('не найден') ||
    lower.includes('fail') ||
    lower.includes('error')
  ) {
    return 'error';
  }
  if (
    lower.includes('внимание') ||
    lower.includes('предупрежд') ||
    lower.includes('истек') ||
    lower.includes('ожидает') ||
    lower.includes('требуется перезапуск')
  ) {
    return 'warning';
  }
  if (
    lower.includes('загрузк') ||
    lower.includes('сохранение...') ||
    lower.includes('отправка') ||
    lower.includes('выполнение') ||
    lower.includes('проверка...')
  ) {
    return 'info';
  }
  return 'success';
}

export function formatShortTime(ts: number | string | null | undefined, locale?: string): string {
  if (!ts) return '—';
  try {
    const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return String(ts);
    const resolvedLocale =
      locale ||
      (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : undefined) ||
      'ru-RU';
    return d.toLocaleTimeString(resolvedLocale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

export function formatLiveUptime(
  startedAtRaw: number | string | null | undefined,
  nowRaw: number = Date.now()
): string {
  if (!startedAtRaw) return '';
  let startMs = 0;
  if (typeof startedAtRaw === 'number') {
    startMs = startedAtRaw < 1e12 ? startedAtRaw * 1000 : startedAtRaw;
  } else {
    const parsed = Date.parse(startedAtRaw);
    if (!isNaN(parsed)) {
      startMs = parsed;
    } else {
      const asNum = Number(startedAtRaw);
      if (!isNaN(asNum) && asNum > 0) {
        startMs = asNum < 1e12 ? asNum * 1000 : asNum;
      }
    }
  }
  if (!startMs || startMs <= 0) return '';
  const nowMs = nowRaw < 1e12 ? nowRaw * 1000 : nowRaw;
  const diff = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (diff < 60) return `${diff}с`;
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  if (mins < 60) return `${mins}м ${secs}с`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}ч ${remMins}м`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}д ${remHours}ч ${remMins}м`;
}

export function getDepsButtonMeta(runtime: string | undefined): {
  show: boolean;
  visible: boolean;
  label: string;
  busyLabel: string;
  title: string;
} {
  const rt = (runtime || 'python').toLowerCase();
  if (rt.includes('node') || rt.includes('js') || rt.includes('ts')) {
    return {
      show: true,
      visible: true,
      label: 'npm install',
      busyLabel: 'npm install...',
      title: 'Установить пакеты Node.js из package.json (npm ci / npm install)',
    };
  }
  if (rt.includes('bash') || rt.includes('sh') || rt.includes('shell')) {
    return {
      show: false,
      visible: false,
      label: 'Зависимости',
      busyLabel: 'Проверка...',
      title: 'Проверить окружение Shell-скрипта',
    };
  }
  return {
    show: true,
    visible: true,
    label: '.venv / pip install',
    busyLabel: 'Установка .venv...',
    title: 'Создать изолированный .venv и установить зависимости из requirements.txt через uv / pip',
  };
}

export function generateBeaconFileTemplate(
  targetPath: string,
  projectOrName?: Partial<ProjectItem> | string | null
): string {
  const lower = (targetPath || '').toLowerCase();
  const baseName = lower.split('/').pop() || lower;
  const project: Partial<ProjectItem> | null =
    typeof projectOrName === 'string' ? { name: projectOrName } : projectOrName || null;
  const projName = project?.name || 'my-service';
  const projType = project?.type || 'service';
  const projRuntime = project?.runtime || 'python';
  const projCmd = project?.cmd || 'python3 main.py';

  if (baseName === 'requirements.txt') {
    return [
      '# Зависимости Python-проекта (устанавливаются в изолированный .venv)',
      'httpx>=0.27.0',
      'pyyaml>=6.0.1',
      '',
    ].join('\n');
  }

  if (baseName === 'project.yaml' || baseName === 'project.yml') {
    return [
      `# Декларативный манифест проекта Beacon`,
      `name: ${projName}`,
      `type: ${projType}`,
      `runtime: ${projRuntime}`,
      `cmd: ${projCmd}`,
      `autostart: ${project?.autostart ? 'true' : 'false'}`,
      `restart_policy: ${project?.restart_policy || 'on-failure'}`,
      `ram_limit_mb: ${project?.ram_limit_mb ?? DEFAULTS.DEFAULT_RAM_LIMIT_MB}`,
      ...(projType === 'web'
        ? [`port: ${project?.port || 8080}`, `healthcheck_url: http://127.0.0.1:${project?.port || 8080}/health`]
        : []),
      ...(projType === 'job'
        ? [
            `schedule_type: ${project?.schedule_type || 'cron'}`,
            `schedule_expr: "${project?.schedule_expr || '*/15 * * * *'}"`,
          ]
        : []),
      '',
    ].join('\n');
  }

  if (baseName === 'package.json') {
    return (
      JSON.stringify(
        {
          name: projName,
          version: '1.0.0',
          private: true,
          scripts: {
            start: 'node index.js',
          },
          dependencies: {},
        },
        null,
        2
      ) + '\n'
    );
  }

  if (lower.endsWith('.py')) {
    return [
      '# -*- coding: utf-8 -*-',
      'import beacon',
      '',
      'def main() -> None:',
      `    print("Старт проекта ${projName}...", flush=True)`,
      '    # Чтение и сохранение состояния в SQLite:',
      '    runs = int(beacon.state.get("runs_count", 0) or 0) + 1',
      '    beacon.state.set("runs_count", runs)',
      '    beacon.ping()',
      '',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n');
  }

  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return [
      "const beacon = require('beacon');",
      '',
      'async function main() {',
      `  console.log('Старт проекта ${projName}...');`,
      "  const runs = Number((await beacon.state.get('runs_count', 0)) || 0) + 1;",
      "  await beacon.state.set('runs_count', runs);",
      '  await beacon.ping();',
      '}',
      '',
      'main().catch((err) => {',
      '  console.error(err);',
      '  process.exit(1);',
      '});',
      '',
    ].join('\n');
  }

  if (lower.endsWith('.sh') || lower.endsWith('.bash')) {
    return [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      `echo "Запуск скрипта ${projName}..."`,
      '',
    ].join('\n');
  }

  if (lower.endsWith('.json')) {
    return '{\n  \n}\n';
  }

  return '';
}

export interface SdkSnippetItem {
  id: string;
  label: string;
  colorCls: string;
  badgeColor: string;
  description: string;
  code: string;
}

export function getRuntimeSdkSnippets(
  runtime: string | undefined,
  cookieSecretOrProjName: string,
  optionalCookieSecret?: string
): SdkSnippetItem[] {
  const rt = (runtime || 'python').toLowerCase();
  const secCookie = optionalCookieSecret || cookieSecretOrProjName || 'project_cookies';

  if (rt.includes('node') || rt.includes('js') || rt.includes('ts')) {
    return [
      {
        id: 'notify',
        label: '+ beacon.notify()',
        colorCls: 'text-sky-300 border-sky-800/60',
        badgeColor: 'text-sky-300 border-sky-800/60',
        description: 'Отправить уведомление в Telegram и журнал панели',
        code: [
          "const beacon = require('beacon');",
          "// Отправка уведомления ('info' | 'warn' | 'error'):",
          "await beacon.notify('Задача успешно выполнена!', 'info');",
        ].join('\n'),
      },
      {
        id: 'ask',
        label: '+ beacon.ask("2FA")',
        colorCls: 'text-amber-300 border-amber-800/60',
        badgeColor: 'text-amber-300 border-amber-800/60',
        description: 'Запросить 2FA-код или капчу в панели и в Telegram',
        code: [
          "const beacon = require('beacon');",
          '// Ожидание интерактивного ответа от оператора (таймаут 300с):',
          "const code = await beacon.ask('Введите 2FA-код из SMS:', 300);",
          "console.log('Получен код:', code);",
        ].join('\n'),
      },
      {
        id: 'state',
        label: '+ beacon.state.get/set',
        colorCls: 'text-indigo-300 border-indigo-800/60',
        badgeColor: 'text-indigo-300 border-indigo-800/60',
        description: 'Чтение и запись постоянного состояния (KV)',
        code: [
          "const beacon = require('beacon');",
          '// Постоянное состояние проекта (переживает перезапуски):',
          "const count = Number((await beacon.state.get('processed_count', 0)) || 0);",
          "await beacon.state.set('processed_count', count + 1);",
        ].join('\n'),
      },
      {
        id: 'secret',
        label: '+ beacon.secret("cookies")',
        colorCls: 'text-emerald-300 border-emerald-800/60',
        badgeColor: 'text-emerald-300 border-emerald-800/60',
        description: 'Чтение кук или API-ключа из сейфа 0600',
        code: [
          "const beacon = require('beacon');",
          '// Чтение защищённого секрета или JSON кук из сейфа:',
          `const rawCookies = await beacon.secret('${secCookie}');`,
          "const cookies = typeof rawCookies === 'string' && rawCookies ? JSON.parse(rawCookies) : (rawCookies || []);",
        ].join('\n'),
      },
      {
        id: 'cookies_expired',
        label: '+ beacon.cookies_expired()',
        colorCls: 'text-rose-300 border-rose-800/60',
        badgeColor: 'text-rose-300 border-rose-800/60',
        description: 'Сигнал о протухших куках (вызывает баннер в панели)',
        code: [
          "const beacon = require('beacon');",
          '// Пометить куки как истекшие и уведомить администратора:',
          `await beacon.cookies_expired('${secCookie}', 'Сессия истекла (HTTP 401), обновите Cookie-Editor JSON');`,
        ].join('\n'),
      },
      {
        id: 'ping',
        label: '+ beacon.ping()',
        colorCls: 'text-cyan-300 border-cyan-800/60',
        badgeColor: 'text-cyan-300 border-cyan-800/60',
        description: "Dead Man's Switch (пульс живучести)",
        code: [
          "const beacon = require('beacon');",
          "// Отправка пульса Dead Man's Switch:",
          'await beacon.ping();',
        ].join('\n'),
      },
    ];
  }

  return [
    {
      id: 'notify',
      label: '+ beacon.notify()',
      colorCls: 'text-sky-300 border-sky-800/60',
      badgeColor: 'text-sky-300 border-sky-800/60',
      description: 'Отправить уведомление в Telegram и журнал панели',
      code: [
        'import beacon',
        '# Отправка уведомления в Telegram и панель (level="info" | "warn" | "error"):',
        'beacon.notify("Задача успешно выполнена!", level="info")',
      ].join('\n'),
    },
    {
      id: 'ask',
      label: '+ beacon.ask("2FA код")',
      colorCls: 'text-amber-300 border-amber-800/60',
      badgeColor: 'text-amber-300 border-amber-800/60',
      description: 'Запросить 2FA-код или капчу в веб-панели и Telegram',
      code: [
        'import beacon',
        '# Запрос 2FA/капчи в веб-панели и Telegram (таймаут 300с):',
        'code = beacon.ask("Введите код подтверждения из SMS:", timeout=300)',
        'print("Получен код:", code, flush=True)',
      ].join('\n'),
    },
    {
      id: 'state',
      label: '+ beacon.state.get/set',
      colorCls: 'text-indigo-300 border-indigo-800/60',
      badgeColor: 'text-indigo-300 border-indigo-800/60',
      description: 'Чтение и запись постоянного состояния (KV)',
      code: [
        'import beacon',
        '# Чтение и запись постоянного состояния (переживает рестарты):',
        'count = int(beacon.state.get("processed_count", 0) or 0)',
        'beacon.state.set("processed_count", count + 1)',
      ].join('\n'),
    },
    {
      id: 'secret',
      label: '+ beacon.secret("cookies")',
      colorCls: 'text-emerald-300 border-emerald-800/60',
      badgeColor: 'text-emerald-300 border-emerald-800/60',
      description: 'Чтение кук или API-ключа из сейфа 0600',
      code: [
        'import beacon, json',
        '# Чтение кук из защищённого хранилища (0600):',
        `raw_cookies = beacon.secret("${secCookie}")`,
        'cookies = json.loads(raw_cookies) if isinstance(raw_cookies, str) and raw_cookies else (raw_cookies or [])',
      ].join('\n'),
    },
    {
      id: 'cookies_expired',
      label: '+ beacon.cookies_expired()',
      colorCls: 'text-rose-300 border-rose-800/60',
      badgeColor: 'text-rose-300 border-rose-800/60',
      description: 'Сигнал об истечении кук (вызовет тревогу в панели)',
      code: [
        'import beacon',
        '# Сигнал об истечении кук (вызовет тревогу в панели и Telegram):',
        `beacon.cookies_expired("${secCookie}", "Требуется свежий экспорт Cookie-Editor")`,
      ].join('\n'),
    },
    {
      id: 'ping',
      label: '+ beacon.ping()',
      colorCls: 'text-cyan-300 border-cyan-800/60',
      badgeColor: 'text-cyan-300 border-cyan-800/60',
      description: "Сигнал Dead Man's Switch",
      code: [
        'import beacon',
        "# Сигнал Dead Man's Switch (использует BEACON_PING_TOKEN):",
        'beacon.ping()',
      ].join('\n'),
    },
  ];
}

export interface SdkCompletionItem {
  label: string;
  insertSuffix: string;
  detail: string;
}

export const BEACON_SDK_COMPLETIONS: readonly SdkCompletionItem[] = [
  {
    label: 'beacon.notify(text, level="info")',
    insertSuffix: 'notify("Сообщение", level="info")',
    detail: 'Уведомление в Telegram и журнал панели',
  },
  {
    label: 'beacon.ask(prompt, timeout=300)',
    insertSuffix: 'ask("Введите 2FA-код:", timeout=300)',
    detail: 'Интерактивный запрос ввода 2FA / капчи',
  },
  {
    label: 'beacon.secret(name, as_path=False)',
    insertSuffix: 'secret("my_secret")',
    detail: 'Чтение секрета или кук из хранилища 0600',
  },
  {
    label: 'beacon.cookies_expired(secret_name, note="")',
    insertSuffix: 'cookies_expired("cookies_name", "Сессия истекла")',
    detail: 'Пометить куки проекта как истекшие',
  },
  {
    label: 'beacon.ping()',
    insertSuffix: 'ping()',
    detail: "Отправить пульс Dead Man's Switch",
  },
  {
    label: 'beacon.state.get(key, default=None)',
    insertSuffix: 'state.get("key", 0)',
    detail: 'Прочитать значение из KV-хранилища проекта',
  },
  {
    label: 'beacon.state.set(key, value)',
    insertSuffix: 'state.set("key", 1)',
    detail: 'Сохранить значение в KV-хранилище проекта',
  },
  {
    label: 'beacon.state.delete(key)',
    insertSuffix: 'state.delete("key")',
    detail: 'Удалить ключ из KV-хранилища проекта',
  },
] as const;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findNextInCode(
  source: string,
  query: string,
  startPos: number,
  caseSensitive: boolean = false
): number {
  if (!query || !source) return -1;
  const hay = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const safeStart = Math.max(0, Math.min(source.length, startPos));
  let idx = hay.indexOf(needle, safeStart);
  if (idx === -1 && safeStart > 0) {
    idx = hay.indexOf(needle, 0);
  }
  return idx;
}

export function findAndReplaceInCode(
  source: string,
  query: string,
  replacement: string,
  caseSensitive: boolean = false
): { nextText: string; nextContent: string; output: string; count: number } {
  if (!query || !source) {
    return { nextText: source, nextContent: source, output: source, count: 0 };
  }
  const flags = caseSensitive ? 'g' : 'gi';
  const re = new RegExp(escapeRegExp(query), flags);
  const matches = source.match(re);
  if (!matches || matches.length === 0) {
    return { nextText: source, nextContent: source, output: source, count: 0 };
  }
  const output = source.replace(re, () => replacement);
  return { nextText: output, nextContent: output, output, count: matches.length };
}

export interface FileTreeNode {
  name: string;
  path: string;
  is_dir?: boolean;
  type?: 'file' | 'dir' | 'directory';
  size?: number;
  children?: FileTreeNode[];
}

export interface FlatFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  depth?: number;
}

export type FlatFileTreeRow = FlatFileEntry;

export function flattenFileTree(
  nodes: FileTreeNode[] | undefined | null,
  expandedDirs: Set<string> | Record<string, boolean> = new Set(),
  depth: number = 0
): FlatFileEntry[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const sorted = [...nodes].sort((a, b) => {
    const aDir = Boolean(a.is_dir || a.type === 'dir' || a.type === 'directory');
    const bDir = Boolean(b.is_dir || b.type === 'dir' || b.type === 'directory');
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const rows: FlatFileEntry[] = [];
  for (const node of sorted) {
    const isDir = Boolean(node.is_dir || node.type === 'dir' || node.type === 'directory');
    rows.push({
      name: node.name,
      path: node.path,
      depth,
      is_dir: isDir,
      size: Number(node.size || 0),
    });
    if (isDir && Array.isArray(node.children) && node.children.length > 0) {
      rows.push(...flattenFileTree(node.children, expandedDirs, depth + 1));
    }
  }
  return rows;
}

export function getFileLanguageMeta(filePath: string): {
  label: string;
  badgeCls: string;
  badgeClass: string;
  language: string;
  tabSize: number;
} {
  const lower = (filePath || '').toLowerCase();
  const baseName = lower.split('/').pop() || lower;

  if (lower.endsWith('.py')) {
    const cls = 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    return {
      label: 'Python',
      badgeCls: cls,
      badgeClass: cls,
      language: 'python',
      tabSize: 4,
    };
  }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    const cls = 'bg-blue-500/15 text-blue-300 border-blue-500/30';
    return {
      label: 'TypeScript',
      badgeCls: cls,
      badgeClass: cls,
      language: 'typescript',
      tabSize: 2,
    };
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    const cls = 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    return {
      label: 'JavaScript',
      badgeCls: cls,
      badgeClass: cls,
      language: 'javascript',
      tabSize: 2,
    };
  }
  if (lower.endsWith('.json')) {
    const cls = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    return {
      label: 'JSON',
      badgeCls: cls,
      badgeClass: cls,
      language: 'json',
      tabSize: 2,
    };
  }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    const cls = 'bg-purple-500/15 text-purple-300 border-purple-500/30';
    return {
      label: 'YAML',
      badgeCls: cls,
      badgeClass: cls,
      language: 'yaml',
      tabSize: 2,
    };
  }
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) {
    const cls = 'bg-lime-500/15 text-lime-300 border-lime-500/30';
    return {
      label: 'Shell',
      badgeCls: cls,
      badgeClass: cls,
      language: 'shell',
      tabSize: 2,
    };
  }
  if (lower.endsWith('.md')) {
    const cls = 'bg-slate-700/60 text-slate-300 border-slate-600';
    return {
      label: 'Markdown',
      badgeCls: cls,
      badgeClass: cls,
      language: 'markdown',
      tabSize: 2,
    };
  }
  if (baseName === 'requirements.txt' || lower.endsWith('.txt') || lower.endsWith('.log')) {
    const cls = 'bg-slate-800 text-slate-300 border-slate-700';
    return {
      label: baseName === 'requirements.txt' ? 'Pip Deps' : 'Text',
      badgeCls: cls,
      badgeClass: cls,
      language: 'plaintext',
      tabSize: 2,
    };
  }
  const cls = 'bg-slate-800 text-slate-400 border-slate-700';
  return {
    label: 'File',
    badgeCls: cls,
    badgeClass: cls,
    language: 'plaintext',
    tabSize: 2,
  };
}