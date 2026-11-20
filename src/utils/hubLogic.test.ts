import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBackoffDelay,
  redactSecretsFromLog,
  validateCookieEditorJson,
  isPortAllowed,
  validateNewPassword,
  validateScheduleConfig,
  formatDurationSec,
  formatBytes,
  describeScheduleHuman,
  evaluatePocoBatteryCycle,
  parseGitHubRepoUrl,
} from './hubLogic';

test('calculateBackoffDelay computes exponential backoff and respects max cap', () => {
  const step0 = calculateBackoffDelay(2, 300, 0, 10);
  assert.equal(step0.delaySec, 2);
  assert.equal(step0.nextFailuresCount, 1);

  const step3 = calculateBackoffDelay(2, 300, 3, 15);
  assert.equal(step3.delaySec, 16);
  assert.equal(step3.nextFailuresCount, 4);

  const capped = calculateBackoffDelay(2, 60, 8, 5);
  assert.equal(capped.delaySec, 60);
});

test('calculateBackoffDelay resets consecutive failures after 60s of stable uptime', () => {
  const reset = calculateBackoffDelay(2, 300, 5, 65);
  assert.equal(reset.delaySec, 2);
  assert.equal(reset.nextFailuresCount, 1);
});

test('redactSecretsFromLog masks text secrets >= 4 chars and ignores short strings', () => {
  const secrets = [
    { name: 'api_token', value: 'sk_live_hub_secret_994812', type: 'text' as const },
    { name: 'short_pin', value: '123', type: 'text' as const },
  ];
  const raw = 'Connecting with token=sk_live_hub_secret_994812 and pin=123';
  const redacted = redactSecretsFromLog(raw, secrets);
  assert.equal(redacted, 'Connecting with token=***SECRET:api_token*** and pin=123');
});

test('validateCookieEditorJson validates Cookie-Editor array structure', () => {
  const validJson = JSON.stringify([
    { name: 'session_id', value: 'abc123xyz', domain: '.example.com', path: '/' },
  ]);
  const res = validateCookieEditorJson(validJson);
  assert.equal(res.valid, true);
  assert.equal(res.cookies.length, 1);
  assert.deepEqual(res.domains, ['.example.com']);

  const invalidJson = JSON.stringify([{ name: 'only_name' }]);
  const badRes = validateCookieEditorJson(invalidJson);
  assert.equal(badRes.valid, false);
});

test('isPortAllowed checks valid port range 1024-65535 and configurable reservedPorts', () => {
  assert.equal(isPortAllowed(8050).allowed, true);
  assert.equal(isPortAllowed(3000).allowed, true);
  assert.equal(isPortAllowed(22).allowed, false);
  assert.equal(isPortAllowed(9000, [9000, 9001]).allowed, false);
});

test('validateNewPassword enforces min 8 characters and rejects admin', () => {
  assert.equal(validateNewPassword('short').valid, false);
  assert.equal(validateNewPassword('admin').valid, false);
  assert.equal(validateNewPassword('StrongPass2026!').valid, true);
});

test('validateScheduleConfig validates cron, interval, and daily expressions', () => {
  assert.equal(validateScheduleConfig('cron', '*/15 * * * *').valid, true);
  assert.equal(validateScheduleConfig('cron', 'invalid cron').valid, false);
  assert.equal(validateScheduleConfig('interval', '3600').valid, true);
  assert.equal(validateScheduleConfig('interval', '2').valid, false);
  assert.equal(validateScheduleConfig('daily', '09:30').valid, true);
  assert.equal(validateScheduleConfig('daily', '25:00').valid, false);
  assert.equal(validateScheduleConfig('daily', 'invalid').valid, false);
  assert.equal(formatDurationSec(125), '2м 5с');
});

test('formatBytes and describeScheduleHuman format disk usage and human schedule descriptions', () => {
  assert.equal(formatBytes(512), '512 Б');
  assert.equal(formatBytes(2048), '2.0 КБ');
  assert.equal(
    describeScheduleHuman('job', 'cron', '*/15 * * * *'),
    'Каждые 15 мин. (*/15 * * * *)'
  );
  assert.equal(
    describeScheduleHuman('job', 'cron', '30 9 * * *'),
    'Ежедневно в 09:30 (30 9 * * *)'
  );
  assert.equal(
    describeScheduleHuman('job', 'daily', '08:15'),
    'Ежедневно в 08:15'
  );
  assert.equal(
    describeScheduleHuman('job', 'interval', '1800'),
    'Каждые 30 мин.'
  );
  assert.ok(
    describeScheduleHuman('service', 'manual', '', 'always', 1).includes('Работает 24/7 в фоне')
  );
});

test('evaluatePocoBatteryCycle treats 45-55% discharging cycle as normal without false alerts', () => {
  const normalDrift = evaluatePocoBatteryCycle(50, 'Discharging', 45, 55, 40);
  assert.equal(normalDrift.state, 'cycle_ok');
  assert.equal(normalDrift.shouldAlert, false);

  const charging = evaluatePocoBatteryCycle(48, 'Charging', 45, 55, 40);
  assert.equal(charging.state, 'charging_to_target');
  assert.equal(charging.shouldAlert, false);

  const powerLoss = evaluatePocoBatteryCycle(37, 'Discharging', 45, 55, 40);
  assert.equal(powerLoss.state, 'power_loss');
  assert.equal(powerLoss.shouldAlert, true);

  const critical = evaluatePocoBatteryCycle(15, 'Discharging', 45, 55, 40);
  assert.equal(critical.state, 'critical_low');
  assert.equal(critical.shouldAlert, true);
});

test('parseGitHubRepoUrl validates GitHub URLs and extracts clean project slug', () => {
  const ok = parseGitHubRepoUrl('https://github.com/pyrogram/pyrogram');
  assert.equal(ok.valid, true);
  assert.equal(ok.suggestedName, 'pyrogram');
  assert.equal(ok.cleanUrl, 'https://github.com/pyrogram/pyrogram.git');

  const bad = parseGitHubRepoUrl('not-a-url');
  assert.equal(bad.valid, false);
});

import {
  classifyStatusNotice,
  formatLiveUptime,
  getDepsButtonMeta,
  generateBeaconFileTemplate,
  getRuntimeSdkSnippets,
  findNextInCode,
  findAndReplaceInCode,
} from '../components/projects/projectWorkspaceUtils';

test('findNextInCode and findAndReplaceInCode respect caseSensitive flag consistently', () => {
  const code = 'import beacon\nBeacon.notify("Hello")\nbeacon.notify("World")';

  // Case-insensitive search finds both "Beacon" and "beacon"
  const firstInsensitive = findNextInCode(code, 'beacon.notify', 0, false);
  assert.equal(firstInsensitive, 14);
  const secondInsensitive = findNextInCode(code, 'beacon.notify', 20, false);
  assert.equal(secondInsensitive, 37);

  // Case-sensitive search skips "Beacon.notify" and finds only lowercase "beacon.notify"
  const onlySensitive = findNextInCode(code, 'beacon.notify', 0, true);
  assert.equal(onlySensitive, 37);

  // Case-sensitive replace only replaces exact case matches
  const replacedSensitive = findAndReplaceInCode(code, 'beacon.notify', 'beacon.ask', true);
  assert.equal(replacedSensitive.count, 1);
  assert.ok(replacedSensitive.nextContent.includes('Beacon.notify("Hello")'));
  assert.ok(replacedSensitive.nextContent.includes('beacon.ask("World")'));

  // Case-insensitive replace replaces both
  const replacedInsensitive = findAndReplaceInCode(code, 'beacon.notify', 'beacon.ask', false);
  assert.equal(replacedInsensitive.count, 2);
});

test('getDepsButtonMeta adapts dependency button to project type (service/web/job), runtime (python/node/bash), and language', () => {
  // Python across service, web, and job types
  const pyService = getDepsButtonMeta('python', 'service');
  assert.equal(pyService.show, true);
  assert.equal(pyService.label, '.venv / pip (24/7)');

  const pyWeb = getDepsButtonMeta('python', 'web');
  assert.equal(pyWeb.show, true);
  assert.equal(pyWeb.label, '.venv + pip (Web API)');

  const pyJob = getDepsButtonMeta('python', 'job');
  assert.equal(pyJob.show, true);
  assert.equal(pyJob.label, '.venv + Проверка Job');

  // Node across web and service
  const nodeWeb = getDepsButtonMeta('node', 'web');
  assert.equal(nodeWeb.show, true);
  assert.equal(nodeWeb.label, 'npm install (Web API)');

  // Bash runtime now shows syntax & chmod action tailored to project type
  const bashJob = getDepsButtonMeta('bash', 'job');
  assert.equal(bashJob.show, true);
  assert.equal(bashJob.label, 'chmod +x / bash -n (Job)');

  // English localization
  const pyWebEn = getDepsButtonMeta('python', 'web', '', [], 'en');
  assert.equal(pyWebEn.label, '.venv + pip (Web API)');
  const pyJobEn = getDepsButtonMeta('python', 'job', '', [], 'en');
  assert.equal(pyJobEn.label, '.venv + Check Job');
});

test('classifyStatusNotice, formatLiveUptime, getRuntimeSdkSnippets, and generateBeaconFileTemplate work as expected', () => {
  assert.equal(classifyStatusNotice('Ошибка сохранения: 500'), 'error');
  assert.equal(classifyStatusNotice('Сетевой сбой при запросе'), 'error');
  assert.equal(classifyStatusNotice('Требуется перезапуск'), 'warning');
  assert.equal(classifyStatusNotice('Файл сохранён'), 'success');

  const now = Date.UTC(2026, 4, 10, 12, 5, 30);
  const started = new Date(Date.UTC(2026, 4, 10, 12, 0, 0)).toISOString();
  assert.equal(formatLiveUptime(started, now), '5м 30с');

  const pySnippets = getRuntimeSdkSnippets('python', 'my_cookies');
  assert.equal(pySnippets.length, 6);
  assert.ok(pySnippets.some((s) => s.id === 'notify' && s.code.includes('import beacon')));

  const nodeSnippets = getRuntimeSdkSnippets('node', 'my_cookies');
  assert.equal(nodeSnippets.length, 6);
  assert.ok(nodeSnippets.some((s) => s.id === 'notify' && s.code.includes("require('beacon')")));

  const reqTpl = generateBeaconFileTemplate('requirements.txt', 'demo_bot');
  assert.ok(reqTpl.includes('httpx>=0.27.0'));
  const yamlTpl = generateBeaconFileTemplate('project.yaml', 'demo_bot');
  assert.ok(yamlTpl.includes('name: demo_bot'));
});

import {
  parseDotEnvText,
  isSensitiveEnvKey,
  AI_TOKEN_PRESETS,
  filterLogLinesByLevel,
  SCHEDULE_PRESETS,
  computeNextScheduleRunPreview,
} from './hubLogic';

test('parseDotEnvText parses .env lines, strips quotes/export/comments, and detects sensitive keys', () => {
  const sample = `
    # Production configuration
    PORT=8080
    export APP_ENV="production"
    BOT_TOKEN='123456:ABC-DEF'
    STRIPE_API_KEY=sk_live_999111 # inline comment
    INVALID-KEY=ignored
  `;
  const parsed = parseDotEnvText(sample);
  assert.equal(parsed.count, 4);
  assert.equal(parsed.entries.PORT, '8080');
  assert.equal(parsed.entries.APP_ENV, 'production');
  assert.equal(parsed.entries.BOT_TOKEN, '123456:ABC-DEF');
  assert.equal(parsed.entries.STRIPE_API_KEY, 'sk_live_999111');
  assert.ok(parsed.secretCandidates.includes('BOT_TOKEN'));
  assert.ok(parsed.secretCandidates.includes('STRIPE_API_KEY'));
  assert.ok(!parsed.secretCandidates.includes('PORT'));
  assert.equal(isSensitiveEnvKey('DB_PASSWORD'), true);
  assert.equal(isSensitiveEnvKey('LOG_LEVEL'), false);
  assert.equal(AI_TOKEN_PRESETS.length, 3);
});

test('filterLogLinesByLevel counts WARN/ERROR lines and preserves Python/Node stack traces', () => {
  const raw = [
    '2026-11-18 10:00:00 [INFO] Server started on :8080',
    '2026-11-18 10:01:00 [WARNING] High latency detected (450ms)',
    'Traceback (most recent call last):',
    '  File "/app/main.py", line 14, in <module>',
    '    raise ValueError("Invalid token")',
    'ValueError: Invalid token',
    '2026-11-18 10:02:00 [INFO] Healthcheck OK',
  ].join('\n');

  const allRes = filterLogLinesByLevel(raw, 'all');
  assert.equal(allRes.totalLines, 7);
  assert.equal(allRes.errorCount, 1); // Contiguous Traceback block counted as 1 error event
  assert.equal(allRes.warnCount, 1);

  const errOnly = filterLogLinesByLevel(raw, 'error_only');
  assert.equal(errOnly.matchedLines, 4); // Traceback + 2 indented stack lines + ValueError
  assert.ok(errOnly.text.includes('File "/app/main.py"'));
  assert.ok(!errOnly.text.includes('Healthcheck OK'));

  const warnErr = filterLogLinesByLevel(raw, 'warn_error');
  assert.equal(warnErr.matchedLines, 5);
  assert.ok(warnErr.text.includes('High latency detected'));
});

test('computeNextScheduleRunPreview validates presets and calculates upcoming run summaries', () => {
  assert.equal(SCHEDULE_PRESETS.length, 6);
  const fixedNow = new Date('2026-11-18T10:10:00Z').getTime();
  for (const preset of SCHEDULE_PRESETS) {
    const res = computeNextScheduleRunPreview(preset.type, preset.expr, fixedNow);
    assert.equal(res.valid, true, `Preset ${preset.label} must be valid`);
    assert.ok(res.nextRunText.length > 0);
  }
  const invalidCron = computeNextScheduleRunPreview('cron', 'bad cron', fixedNow);
  assert.equal(invalidCron.valid, false);
});

import {
  classifySlaTier,
  getSlaStatusBarColor,
  buildPrometheusScrapeConfig,
} from './hubLogic';

test('classifySlaTier, getSlaStatusBarColor, and buildPrometheusScrapeConfig work deterministically', () => {
  assert.equal(classifySlaTier(null).label, 'Нет данных');
  assert.ok(classifySlaTier(99.5).colorCls.includes('emerald'));
  assert.ok(classifySlaTier(94.0).colorCls.includes('amber'));
  assert.ok(classifySlaTier(72.5).colorCls.includes('rose'));

  assert.equal(getSlaStatusBarColor('success'), 'bg-emerald-400');
  assert.equal(getSlaStatusBarColor('killed_oom'), 'bg-rose-500');
  assert.equal(getSlaStatusBarColor('killed_timeout'), 'bg-amber-400');

  const yamlCfg = buildPrometheusScrapeConfig('https://panel.example.com:8443');
  assert.ok(yamlCfg.includes('metrics_path: "/api/metrics"'));
  assert.ok(yamlCfg.includes('scheme: "https"'));
  assert.ok(yamlCfg.includes('targets: ["panel.example.com:8443"]'));
});

import {
  buildReverseProxyConfig,
  classifyPortOwnerBadge,
  normalizeProjectGroupTag,
} from './hubLogic';

test('buildReverseProxyConfig, classifyPortOwnerBadge, and normalizeProjectGroupTag work for Stage 7', () => {
  const nginxCfg = buildReverseProxyConfig('nginx', 'https://api.mybox.dev/v1', 18081, 'web-status-api');
  assert.ok(nginxCfg.includes('server_name api.mybox.dev;'));
  assert.ok(nginxCfg.includes('proxy_pass http://127.0.0.1:18081;'));
  assert.ok(nginxCfg.includes('Upgrade $http_upgrade'));

  const caddyCfg = buildReverseProxyConfig('caddy', 'bot.mybox.dev', 18082, 'tg-hook');
  assert.ok(caddyCfg.includes('bot.mybox.dev {'));
  assert.ok(caddyCfg.includes('reverse_proxy 127.0.0.1:18082'));

  const cfCfg = buildReverseProxyConfig('cloudflared', '', 9000, 'demo');
  assert.ok(cfCfg.includes('hostname: api.example.com'));
  assert.ok(cfCfg.includes('service: http://127.0.0.1:9000'));

  assert.equal(classifyPortOwnerBadge('conflict').label, 'Конфликт порта');
  assert.ok(classifyPortOwnerBadge('beacon_project').colorCls.includes('emerald'));
  assert.equal(normalizeProjectGroupTag('  Продакшн   API  '), 'Продакшн API');
});

import {
  resolveNextSelectedRunId,
  getRunStatusBadge,
} from './hubLogic';

test('resolveNextSelectedRunId switches to new run when autoSwitch is enabled and preserves manual selection otherwise', () => {
  // Empty runs -> null
  assert.equal(resolveNextSelectedRunId([], 10, 10, true, false), null);

  // Initial load (no selection yet) -> selects latest
  assert.equal(resolveNextSelectedRunId([25, 24, 23], null, null, true, false), 25);

  // New run #26 arrives while autoSwitch is ON -> switches automatically to #26
  assert.equal(resolveNextSelectedRunId([26, 25, 24], 25, 25, true, false), 26);

  // User manually selected older run #24 and NO new run appeared -> stays on #24
  assert.equal(resolveNextSelectedRunId([26, 25, 24], 24, 26, true, false), 24);

  // Explicit restart (forceLatest=true) while viewing older run #24 -> switches to #27
  assert.equal(resolveNextSelectedRunId([27, 26, 25, 24], 24, 26, true, true), 27);

  // Auto-switch OFF -> stays on #25 even when new run #27 arrives
  assert.equal(resolveNextSelectedRunId([27, 26, 25], 25, 26, false, false), 25);

  // Auto-switch OFF but previously selected run #10 was pruned -> falls back to latest #27
  assert.equal(resolveNextSelectedRunId([27, 26, 25], 10, 26, false, false), 27);
});

test('getRunStatusBadge and getSlaStatusBarColor treat timeout and killed_timeout consistently', () => {
  assert.equal(getRunStatusBadge('timeout').label, getRunStatusBadge('killed_timeout').label);
  assert.equal(getSlaStatusBarColor('timeout'), 'bg-amber-400');
  assert.equal(getSlaStatusBarColor('killed_timeout'), 'bg-amber-400');
});

