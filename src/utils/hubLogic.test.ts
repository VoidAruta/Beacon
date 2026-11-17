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

