export const FORBIDDEN_PORTS = [22, 3000, 2053, 3199, 8040, 10808, 25325] as const;

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
 * Проверяет, что порт панели не входит в список запрещённых портов среды.
 */
export function isPortAllowed(port: number): { allowed: boolean; reason?: string } {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { allowed: false, reason: 'Порт должен быть целым числом в диапазоне 1024–65535' };
  }
  if ((FORBIDDEN_PORTS as readonly number[]).includes(port)) {
    return {
      allowed: false,
      reason: `Порт ${port} занят системными службами (запрещены: ${FORBIDDEN_PORTS.join(', ')})`,
    };
  }
  return { allowed: true };
}

/**
 * Проверяет корректность расписания задачи (manual | cron | interval).
 */
export function validateScheduleConfig(
  scheduleType: 'manual' | 'cron' | 'interval',
  scheduleExpr: string
): { valid: boolean; error?: string } {
  if (scheduleType === 'manual') return { valid: true };
  const expr = (scheduleExpr || '').trim();
  if (!expr) {
    return { valid: false, error: 'Укажите выражение расписания' };
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

/**
 * Форматирует размер в байтах в понятную строку (Б, КБ, МБ, ГБ).
 */
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

/**
 * Переводит расписание (manual / interval / cron) или режим сервиса на понятный русский язык.
 */
export function describeScheduleHuman(
  type: 'service' | 'job',
  scheduleType: 'manual' | 'cron' | 'interval',
  scheduleExpr: string,
  restartPolicy: 'no' | 'on-failure' | 'always' = 'on-failure',
  autostart: number | boolean = 0
): string {
  if (type === 'service') {
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
