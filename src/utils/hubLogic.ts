export const FORBIDDEN_PORTS: readonly number[] = [] as const;

export interface SecretRedactionEntry {
  name: string;
  value: string;
  type: 'text' | 'file' | 'cookie_json';
}

export interface CookieEditorItem {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

/**
 * Вычисляет паузу экспоненциального backoff для сервиса:
 * min(backoff_max, backoff_min * 2^consecutive_failures)
 * Если сервис проработал стабильно более 60 секунд, счётчик сбрасывается в 0.
 */
export function calculateBackoffDelay(
  backoffMinSec: number,
  backoffMaxSec: number,
  consecutiveFailures: number,
  previousUptimeSec: number = 0
): { delaySec: number; nextFailuresCount: number } {
  const minSec = Math.max(1, Math.floor(backoffMinSec || 2));
  const maxSec = Math.max(minSec, Math.floor(backoffMaxSec || 300));
  const effectiveFailures = previousUptimeSec >= 60 ? 0 : Math.max(0, Math.floor(consecutiveFailures));
  const rawDelay = minSec * Math.pow(2, effectiveFailures);
  const delaySec = Math.min(maxSec, rawDelay);
  return {
    delaySec,
    nextFailuresCount: effectiveFailures + 1,
  };
}

/**
 * Фильтрация секретов из логов (Redaction):
 * Заменяет вхождения текстовых секретов длиной >= 4 символов на ***SECRET:<name>***.
 */
export function redactSecretsFromLog(logText: string, secrets: SecretRedactionEntry[]): string {
  if (!logText || !secrets || secrets.length === 0) return logText;
  const eligible = secrets
    .filter((s) => s.type === 'text' && typeof s.value === 'string' && s.value.trim().length >= 4)
    .map((s) => ({ name: s.name, value: s.value.trim() }))
    .sort((a, b) => b.value.length - a.value.length);

  let output = logText;
  for (const item of eligible) {
    if (output.includes(item.value)) {
      output = output.split(item.value).join(`***SECRET:${item.name}***`);
    }
  }
  return output;
}

/**
 * Валидация JSON-массива из браузерного расширения Cookie-Editor.
 */
export function validateCookieEditorJson(rawJson: string): {
  valid: boolean;
  cookies: CookieEditorItem[];
  domains: string[];
  error?: string;
} {
  if (!rawJson || !rawJson.trim()) {
    return { valid: false, cookies: [], domains: [], error: 'Вставьте JSON-массив из Cookie-Editor' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return {
      valid: false,
      cookies: [],
      domains: [],
      error: `Ошибка синтаксиса JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      valid: false,
      cookies: [],
      domains: [],
      error: 'JSON должен быть непустым массивом объектов куки ([{ "name": ..., "value": ..., "domain": ... }])',
    };
  }

  const cookies: CookieEditorItem[] = [];
  const domainSet = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object') {
      return { valid: false, cookies: [], domains: [], error: `Элемент #${i} не является объектом` };
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name.trim()) {
      return { valid: false, cookies: [], domains: [], error: `Кука #${i} не содержит поле 'name'` };
    }
    if (typeof rec.value !== 'string') {
      return { valid: false, cookies: [], domains: [], error: `Кука '${rec.name}' не содержит строковое поле 'value'` };
    }
    if (typeof rec.domain !== 'string' || !rec.domain.trim()) {
      return { valid: false, cookies: [], domains: [], error: `Кука '${rec.name}' не содержит поле 'domain'` };
    }
    cookies.push({
      name: rec.name,
      value: rec.value,
      domain: rec.domain,
      path: typeof rec.path === 'string' ? rec.path : '/',
      secure: Boolean(rec.secure),
      httpOnly: Boolean(rec.httpOnly),
    });
    domainSet.add(rec.domain);
  }

  return {
    valid: true,
    cookies,
    domains: Array.from(domainSet),
  };
}

/**
 * Проверяет, что порт находится в допустимом диапазоне 1024–65535 и не входит в настраиваемый список reserved_ports.
 */
export function isPortAllowed(
  port: number,
  reservedPorts: readonly number[] | string = FORBIDDEN_PORTS
): { allowed: boolean; reason?: string } {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { allowed: false, reason: 'Порт должен быть целым числом в диапазоне 1024–65535' };
  }
  const parsedList: number[] =
    typeof reservedPorts === 'string'
      ? reservedPorts
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
      : Array.from(reservedPorts);
  if (parsedList.includes(port)) {
    return {
      allowed: false,
      reason: `Порт ${port} зарезервирован в настройках (reserved_ports: ${parsedList.join(', ')})`,
    };
  }
  return { allowed: true };
}

/**
 * Единое правило проверки нового пароля (Фаза A.1(г)): минимум 8 символов и не 'admin'.
 */
export function validateNewPassword(password: string): { valid: boolean; error?: string } {
  const trimmed = (password || '').trim();
  if (trimmed.length < 8) {
    return { valid: false, error: 'Новый пароль должен содержать минимум 8 символов' };
  }
  if (trimmed.toLowerCase() === 'admin') {
    return { valid: false, error: 'Новый пароль не может совпадать со стандартным "admin"' };
  }
  return { valid: true };
}

/**
 * Проверяет корректность расписания задачи (manual | cron | interval | daily).
 */
export function validateScheduleConfig(
  scheduleType: 'manual' | 'cron' | 'interval' | 'daily',
  scheduleExpr: string
): { valid: boolean; error?: string } {
  if (scheduleType === 'manual') return { valid: true };
  const expr = (scheduleExpr || '').trim();
  if (!expr) {
    return { valid: false, error: 'Укажите выражение расписания' };
  }
  if (scheduleType === 'daily') {
    const m = expr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      return { valid: false, error: 'Укажите время в формате HH:MM (например 09:00)' };
    }
    return { valid: true };
  }
  if (scheduleType === 'interval') {
    const sec = Number(expr);
    if (!Number.isInteger(sec) || sec < 5) {
      return { valid: false, error: 'Интервал должен быть целым числом секунд (>= 5)' };
    }
    return { valid: true };
  }
  if (scheduleType === 'cron') {
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) {
      return { valid: false, error: 'Выражение cron должно состоять из 5 полей (например: */15 * * * *)' };
    }
    const fieldRe = /^(\*|(\*\/\d+)|(\d+(-\d+)?(\/\d+)?))(,(\*|(\*\/\d+)|(\d+(-\d+)?(\/\d+)?)))*$/;
    for (const p of parts) {
      if (!fieldRe.test(p)) {
        return { valid: false, error: `Некорректное поле cron: "${p}"` };
      }
    }
    return { valid: true };
  }
  return { valid: false, error: 'Неизвестный тип расписания' };
}

export function formatDurationSec(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}м ${remS}с` : `${m}м`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}ч ${remM}м`;
}

export const formatDurationSeconds = formatDurationSec;

export function formatBytes(bytes: number): string {
  const b = Math.max(0, Number(bytes || 0));
  if (b < 1024) return `${b} Б`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} КБ`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} МБ`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} ГБ`;
}

export function describeScheduleHuman(
  type: 'service' | 'job' | 'web',
  scheduleType: 'manual' | 'cron' | 'interval' | 'daily',
  scheduleExpr: string,
  restartPolicy: 'no' | 'on-failure' | 'always' = 'on-failure',
  autostart: number | boolean = 0
): string {
  if (type === 'service' || type === 'web') {
    const policyMap: Record<string, string> = {
      always: 'Автоперезапуск всегда',
      'on-failure': 'Перезапуск при ошибке',
      no: 'Без автоперезапуска',
    };
    const autoText = autostart ? 'Автостарт при включении' : 'Старт вручную';
    return `Работает 24/7 в фоне · ${policyMap[restartPolicy] || restartPolicy} · ${autoText}`;
  }

  if (scheduleType === 'manual') {
    return 'Только вручную (по кнопке «Старт» или по ссылке Webhook)';
  }

  if (scheduleType === 'daily') {
    return `Ежедневно в ${(scheduleExpr || '09:00').trim()}`;
  }

  if (scheduleType === 'interval') {
    const sec = Number(scheduleExpr || 0);
    if (!sec || sec <= 0) return 'По интервалу';
    if (sec < 60) return `Каждые ${sec} сек.`;
    if (sec % 3600 === 0) {
      const hrs = sec / 3600;
      return hrs === 1 ? 'Каждый час' : `Каждые ${hrs} ч.`;
    }
    if (sec % 60 === 0) {
      return `Каждые ${sec / 60} мин.`;
    }
    return `Каждые ${formatDurationSec(sec)}`;
  }

  const expr = (scheduleExpr || '').trim();
  const parts = expr.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
      return `Каждые ${min.slice(2)} мин. (${expr})`;
    }
    if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
      return `Каждые ${hour.slice(2)} ч. в начале часа (${expr})`;
    }
    if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
      return `Каждый час в :00 минут (${expr})`;
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
      const hh = hour.padStart(2, '0');
      const mm = min.padStart(2, '0');
      return `Ежедневно в ${hh}:${mm} (${expr})`;
    }
  }
  return `По расписанию Cron: ${expr}`;
}

export function evaluatePocoBatteryCycle(
  percent: number,
  status: string,
  minTarget: number = 45,
  maxTarget: number = 55,
  alertBelowPct: number = 40
): {
  state: 'cycle_ok' | 'charging_to_target' | 'power_loss' | 'critical_low';
  label: string;
  shouldAlert: boolean;
} {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (pct < 20) {
    return {
      state: 'critical_low',
      label: `Критический разряд ${pct}% (< 20%) — сбой питания!`,
      shouldAlert: true,
    };
  }
  if (pct < alertBelowPct) {
    return {
      state: 'power_loss',
      label: `Внимание: заряд ${pct}% ниже порога ${alertBelowPct}% (проверьте питание / Root-контроллер)`,
      shouldAlert: true,
    };
  }
  if (status === 'Charging') {
    return {
      state: 'charging_to_target',
      label: `Зарядка до ${maxTarget}% (сейчас ${pct}%, цикл ${minTarget}–${maxTarget}%)`,
      shouldAlert: false,
    };
  }
  return {
    state: 'cycle_ok',
    label: `Удержание ${minTarget}–${maxTarget}% в норме (${pct}%, плавный спуск до ${minTarget}%)`,
    shouldAlert: false,
  };
}

export function parseGitHubRepoUrl(rawUrl: string): {
  valid: boolean;
  cleanUrl: string;
  suggestedName: string;
  owner?: string;
  repo?: string;
  error?: string;
} {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, cleanUrl: '', suggestedName: '', error: 'Введите ссылку на GitHub-репозиторий' };
  }
  const match = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git|\/)?$/i);
  if (!match) {
    return {
      valid: false,
      cleanUrl: trimmed,
      suggestedName: '',
      error: 'Ссылка должна иметь вид https://github.com/автор/репозиторий',
    };
  }
  const owner = match[1];
  const repo = match[2];
  const safeName = repo.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().slice(0, 48) || 'github-app';
  return {
    valid: true,
    cleanUrl: `https://github.com/${owner}/${repo}.git`,
    suggestedName: safeName,
    owner,
    repo,
  };
}

export type ProjectTypeFilter = 'all' | 'service' | 'web' | 'job';

export function filterDashboardProjects<
  T extends {
    name: string;
    description?: string;
    group_tag?: string;
    type: 'service' | 'job' | 'web';
    is_test?: number | boolean;
  }
>(
  projects: T[],
  searchQuery: string,
  typeFilter: ProjectTypeFilter = 'all',
  hideTests: boolean = false
): T[] {
  const q = (searchQuery || '').trim().toLowerCase();
  return (projects || []).filter((p) => {
    if (hideTests && (p.is_test === 1 || p.is_test === true)) {
      return false;
    }
    if (typeFilter !== 'all' && p.type !== typeFilter) {
      return false;
    }
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      (p.group_tag || '').toLowerCase().includes(q)
    );
  });
}

export function getRunStatusBadge(status: string): {
  label: string;
  colorClass: string;
  dotClass: string;
} {
  switch (status) {
    case 'running':
      return {
        label: 'Работает',
        colorClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
        dotClass: 'bg-emerald-400',
      };
    case 'waiting_input':
      return {
        label: 'Ждёт 2FA / Ввод',
        colorClass: 'bg-amber-500/20 text-amber-200 border-amber-500/50 animate-pulse',
        dotClass: 'bg-amber-400',
      };
    case 'failed':
      return {
        label: 'Ошибка',
        colorClass: 'bg-red-500/15 text-red-300 border-red-500/40',
        dotClass: 'bg-red-400',
      };
    case 'crash_loop':
      return {
        label: 'Crash Loop',
        colorClass: 'bg-red-500/25 text-red-200 border-red-500/50',
        dotClass: 'bg-red-500',
      };
    case 'killed_oom':
      return {
        label: 'OOM Kill',
        colorClass: 'bg-rose-500/20 text-rose-200 border-rose-500/50',
        dotClass: 'bg-rose-400',
      };
    case 'killed_timeout':
      return {
        label: 'Таймаут',
        colorClass: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
        dotClass: 'bg-amber-400',
      };
    case 'stopped':
    default:
      return {
        label: 'Остановлен',
        colorClass: 'bg-slate-800 text-slate-400 border-slate-700',
        dotClass: 'bg-slate-500',
      };
  }
}

const SENSITIVE_KEY_PATTERNS = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH_KEY|WEBHOOK_SECRET|HASH)/i;

/**
 * Проверяет, содержит ли имя переменной окружения признаки секрета/токена,
 * который безопаснее хранить в зашифрованном сейфе (chmod 0600), а не в открытом env_json.
 */
export function isSensitiveEnvKey(key: string): boolean {
  const clean = (key || '').trim();
  if (!clean) return false;
  return SENSITIVE_KEY_PATTERNS.test(clean);
}

/**
 * Парсит многострочный текст в формате .env (KEY=VALUE, export KEY="VAL", комментарии #)
 * и возвращает словарь переменных + список ключей-кандидатов для переноса в Сейф Секретов (0600).
 */
export function parseDotEnvText(raw: string): {
  entries: Record<string, string>;
  secretCandidates: string[];
  count: number;
} {
  const entries: Record<string, string> = {};
  const secretSet = new Set<string>();
  if (!raw || !raw.trim()) {
    return { entries, secretCandidates: [], count: 0 };
  }

  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = withoutExport.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = withoutExport.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim();
      }
    }

    entries[key] = val;
    if (isSensitiveEnvKey(key) && val.length > 0) {
      secretSet.add(key);
    }
  }

  return {
    entries,
    secretCandidates: Array.from(secretSet),
    count: Object.keys(entries).length,
  };
}

export interface AiTokenScopePreset {
  id: 'readonly' | 'supervised' | 'autonomous';
  title: string;
  description: string;
  scopes: string[];
  rateLimit: number;
}

export const AI_TOKEN_PRESETS: readonly AiTokenScopePreset[] = [
  {
    id: 'readonly',
    title: 'Только диагностика (Read-Only)',
    description: 'Чтение логов, статуса и исходного кода без права правок и перезапуска',
    scopes: ['read', 'files:read'],
    rateLimit: 60,
  },
  {
    id: 'supervised',
    title: 'Напарник с подтверждением (Diff Approval)',
    description: 'Чтение, правка кода (через очередь с diff) и перезапуск сервисов',
    scopes: ['read', 'files:read', 'files:write', 'run', 'ask:answer'],
    rateLimit: 90,
  },
  {
    id: 'autonomous',
    title: 'Полный цикл разработки (Dev Sandbox)',
    description: 'Все разрешения, включая создание проектов из шаблонов и настройку Cron',
    scopes: ['read', 'files:read', 'files:write', 'run', 'schedule:write', 'templates:create', 'ask:answer'],
    rateLimit: 120,
  },
] as const;


