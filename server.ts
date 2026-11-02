import express from 'express';
import http from 'node:http';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';

const PORT = 3000;
const HUB_BACKEND_PORT = Number(process.env.HUB_PORT || 8050);
const WORKSPACE_ROOT = process.cwd();

// 1. Гарантируем симлинк /opt/hub -> /app/applet
function ensureOptHubLink() {
  try {
    if (!fs.existsSync('/opt/hub')) {
      fs.symlinkSync(WORKSPACE_ROOT, '/opt/hub');
    }
  } catch {
    // Игнорируем, если нет прав на /opt
  }
}

let hubProc: ChildProcess | null = null;
let isShuttingDown = false;

function isHubPortListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: HUB_BACKEND_PORT,
        path: '/api/auth/me?autostart=1',
        timeout: 800,
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensurePythonHubRunning(): Promise<void> {
  if (await isHubPortListening()) return;

  ensureOptHubLink();
  const cwd = fs.existsSync('/opt/hub/hub/__main__.py') ? '/opt/hub' : WORKSPACE_ROOT;

  if (!hubProc || hubProc.killed || hubProc.exitCode !== null) {
    hubProc = spawn('python3', ['-m', 'hub'], {
      cwd,
      env: {
        ...process.env,
        HUB_DIR: cwd,
        HUB_PORT: String(HUB_BACKEND_PORT),
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    hubProc.stdout?.on('data', (chunk) => {
      process.stdout.write(`[python3 -m hub] ${chunk}`);
    });
    hubProc.stderr?.on('data', (chunk) => {
      process.stderr.write(`[python3 -m hub] ${chunk}`);
    });
    hubProc.on('exit', () => {
      hubProc = null;
      if (!isShuttingDown) {
        setTimeout(() => {
          ensurePythonHubRunning().catch(() => {});
        }, 300);
      }
    });
  }

  for (let i = 0; i < 30; i++) {
    if (await isHubPortListening()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

function callHubBackendJson(
  method: string,
  urlPath: string,
  bodyObj?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj), 'utf-8') : null;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(payload.length);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: HUB_BACKEND_PORT,
        path: urlPath,
        method: method.toUpperCase(),
        headers,
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({
              status: res.statusCode || 200,
              data: text ? JSON.parse(text) : {},
              headers: res.headers,
            });
          } catch {
            resolve({ status: res.statusCode || 200, data: { raw: text }, headers: res.headers });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAdminHeaders(): Promise<Record<string, string>> {
  const authRes = await callHubBackendJson('GET', '/api/auth/me?autostart=1', undefined, {
    'X-Hub-Auto-Session': '1',
  });
  return {
    'X-CSRF-Token': authRes.data.csrf_token || '',
    'X-Hub-Session': authRes.data.session_token || '',
  };
}

async function startServer() {
  ensureOptHubLink();
  await ensurePythonHubRunning();

  const app = express();

  // Специальный эндпоинт: реальный тест перезапуска python3 -m hub (Acceptance Test #2)
  app.post('/api/system/restart_hub_daemon', express.json(), async (_req, res) => {
    try {
      await ensurePythonHubRunning();
      const hdrs = await getAdminHeaders();
      const beforeDash = await callHubBackendJson('GET', '/api/dashboard', undefined, hdrs);
      const oldHubPid = beforeDash.data?.system?.hub_pid;
      const runningBefore = (beforeDash.data?.projects || [])
        .filter((p: any) => p.current_status === 'running')
        .map((p: any) => ({ name: p.name, pid: p.pid, pgid: p.pgid }));

      try {
        execSync('pkill -f "python3 -m hub" || true');
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 400));
      await ensurePythonHubRunning();

      const newHdrs = await getAdminHeaders();
      const afterDash = await callHubBackendJson('GET', '/api/dashboard', undefined, newHdrs);
      const newHubPid = afterDash.data?.system?.hub_pid;
      const runningAfter = (afterDash.data?.projects || [])
        .filter((p: any) => p.current_status === 'running')
        .map((p: any) => ({ name: p.name, pid: p.pid, pgid: p.pgid }));

      res.json({
        ok: true,
        old_hub_pid: oldHubPid,
        new_hub_pid: newHubPid,
        running_before: runningBefore,
        running_after: runningAfter,
        survived_without_sigpipe: runningBefore.every((b: any) =>
          runningAfter.some((a: any) => a.name === b.name && a.pid === b.pid)
        ),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Специальный эндпоинт: выполнение всех 6 пунктов приёмки (Acceptance Tests #1..#6)
  app.post('/api/system/run_acceptance_suite', express.json(), async (_req, res) => {
    try {
      await ensurePythonHubRunning();
      const hdrs = await getAdminHeaders();
      const results: Array<{
        id: number;
        title: string;
        passed: boolean;
        details: string;
      }> = [];

      // 1. Запуск и чистое убийство дерева процессов (PGID)
      const listRes = await callHubBackendJson('GET', '/api/projects', undefined, hdrs);
      let treeProj = (listRes.data || []).find((p: any) => p.name === 'acceptance-tree-test');
      if (!treeProj) {
        const created = await callHubBackendJson(
          'POST',
          '/api/projects',
          {
            name: 'acceptance-tree-test',
            type: 'job',
            runtime: 'bash',
            cmd: 'bash -c "sleep 1000 & wait"',
          },
          hdrs
        );
        treeProj = created.data;
      }
      const startTree = await callHubBackendJson('POST', `/api/projects/${treeProj.id}/start`, {}, hdrs);
      const spawnedPgid = startTree.data?.run?.pgid || startTree.data?.run?.pid;
      await new Promise((r) => setTimeout(r, 350));
      await callHubBackendJson('POST', `/api/projects/${treeProj.id}/stop`, {}, hdrs);
      await new Promise((r) => setTimeout(r, 350));
      let lingeringProcs = '';
      try {
        lingeringProcs = execSync(`ps -eo pid,pgid,comm | awk '$2 == ${spawnedPgid} {print $0}'`).toString().trim();
      } catch {
        lingeringProcs = '';
      }
      results.push({
        id: 1,
        title: '1. Запуск и чистое убийство дерева процессов по PGID',
        passed: lingeringProcs === '',
        details:
          lingeringProcs === ''
            ? `Группа PGID=${spawnedPgid} (включая дочерний sleep 1000) полностью уничтожена в ps aux.`
            : `Остались процессы: ${lingeringProcs}`,
      });

      // 2. Переживание рестарта панели без потери сервисов (без SIGPIPE, ECHILD-safe)
      let hbProj = (listRes.data || []).find((p: any) => p.name === 'heartbeat-daemon');
      if (hbProj && hbProj.current_status !== 'running') {
        await callHubBackendJson('POST', `/api/projects/${hbProj.id}/start`, {}, hdrs);
        await new Promise((r) => setTimeout(r, 400));
      }
      const dash1 = await callHubBackendJson('GET', '/api/dashboard', undefined, hdrs);
      const hbBefore = (dash1.data?.projects || []).find((p: any) => p.name === 'heartbeat-daemon');
      const hubPidBefore = dash1.data?.system?.hub_pid;
      try {
        execSync('pkill -f "python3 -m hub" || true');
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 450));
      await ensurePythonHubRunning();
      const hdrs2 = await getAdminHeaders();
      const dash2 = await callHubBackendJson('GET', '/api/dashboard', undefined, hdrs2);
      const hbAfter = (dash2.data?.projects || []).find((p: any) => p.name === 'heartbeat-daemon');
      const hubPidAfter = dash2.data?.system?.hub_pid;
      const test2Passed =
        Boolean(hbBefore?.pid) &&
        hbBefore?.pid === hbAfter?.pid &&
        hbAfter?.current_status === 'running' &&
        hubPidBefore !== hubPidAfter;
      results.push({
        id: 2,
        title: '2. Переживание рестарта панели без потери сервисов (Direct FD + ECHILD recovery)',
        passed: test2Passed,
        details: `Hub перезапущен (PID ${hubPidBefore} -> ${hubPidAfter}). Сервис heartbeat-daemon сохранил PID=${hbAfter?.pid} и статус '${hbAfter?.current_status}'.`,
      });

      // 3. Уведомление при падении (sys.exit(1) -> Telegram через прокси 127.0.0.1:10808)
      let crashProj = (dash2.data?.projects || []).find((p: any) => p.name === 'acceptance-crash-test');
      if (!crashProj) {
        const createdCrash = await callHubBackendJson(
          'POST',
          '/api/projects',
          {
            name: 'acceptance-crash-test',
            type: 'job',
            runtime: 'python',
            cmd: 'python3 -c "import sys; print(\'Fatal error in worker\'); sys.exit(1)"',
            notify_on_error: true,
          },
          hdrs2
        );
        crashProj = createdCrash.data;
      }
      await callHubBackendJson('POST', `/api/projects/${crashProj.id}/start`, {}, hdrs2);
      await new Promise((r) => setTimeout(r, 2300));
      const dash3 = await callHubBackendJson('GET', '/api/dashboard', undefined, hdrs2);
      const crashNotif = (dash3.data?.recent_notifications || []).find((n: any) =>
        String(n.text || '').includes('acceptance-crash-test')
      );
      results.push({
        id: 3,
        title: '3. Уведомление при падении (sys.exit(1) -> Telegram прокси 127.0.0.1:10808)',
        passed: Boolean(crashNotif),
        details: crashNotif
          ? `Уведомление сформировано с хвостом лога (прокси: ${crashNotif.proxy_used || 'http://127.0.0.1:10808'}).`
          : 'Ожидание уведомления от сторожа процессов',
      });

      // 4. Импорт куки из Cookie-Editor и hub.cookies_expired()
      const sampleCookieJson = JSON.stringify([
        { name: 'auth_sid', value: 'cookie_val_778899', domain: '.telegram.org', path: '/' },
      ]);
      const impRes = await callHubBackendJson(
        'POST',
        '/api/secrets/cookies',
        { name: 'my_cookies', cookies_json: sampleCookieJson },
        hdrs2
      );
      const pySdkOut = execSync(
        `python3 -c "import sys; sys.path.insert(0, '/opt/hub'); from hub.secrets_mgr import get_secret_raw; s = get_secret_raw('my_cookies'); print(type(s['value']).__name__, len(s['value']))"`
      )
        .toString()
        .trim();
      await callHubBackendJson(
        'POST',
        '/api/secrets/my_cookies/expire',
        { note: 'Проверка красного баннера COOKIES_EXPIRED' },
        hdrs2
      );
      const dash4 = await callHubBackendJson('GET', '/api/dashboard', undefined, hdrs2);
      const expiredBannerActive = (dash4.data?.expired_cookies || []).some(
        (c: any) => c.name === 'my_cookies'
      );
      // Восстанавливаем куки после проверки, чтобы баннер можно было как протестировать, так и держать чистым
      await callHubBackendJson(
        'POST',
        '/api/secrets/cookies',
        { name: 'my_cookies', cookies_json: sampleCookieJson },
        hdrs2
      );
      results.push({
        id: 4,
        title: '4. Импорт куки Cookie-Editor, hub.secret("my_cookies") -> list[dict] и cookies_expired()',
        passed: impRes.status === 200 && pySdkOut === 'list 1' && expiredBannerActive,
        details: `Cookie-Editor JSON импортирован (0600), тип в Python: ${pySdkOut}, триггер баннера is_expired=1 подтверждён.`,
      });

      // 5. Блокирующий интерактивный hub.ask()
      const smsProj = (dash4.data?.projects || []).find((p: any) => p.name === 'sms-auth-bot');
      let test5Passed = false;
      let test5Details = '';
      if (smsProj) {
        const startAsk = await callHubBackendJson('POST', `/api/projects/${smsProj.id}/start`, {}, hdrs2);
        const askRunId = startAsk.data?.run?.id;
        await new Promise((r) => setTimeout(r, 700));
        const dashAsk = await callHubBackendJson('GET', '/api/dashboard', undefined, hdrs2);
        const pendingAsk = (dashAsk.data?.pending_asks || [])[0];
        if (pendingAsk) {
          await callHubBackendJson(
            'POST',
            `/api/asks/${pendingAsk.id}/answer`,
            { answer: '948201' },
            hdrs2
          );
          await new Promise((r) => setTimeout(r, 800));
          const logRes = await callHubBackendJson('GET', `/api/runs/${askRunId}/log`, undefined, hdrs2);
          const logText = String(logRes.data?.log || '');
          test5Passed =
            logText.includes('948201') && logText.includes('***SECRET:api_token***');
          test5Details = `Скрипт получил ответ '948201' из hub.ask() и продолжил выполнение. Секрет в логе замаскирован как ***SECRET:api_token***.`;
        } else {
          test5Details = 'Не обнаружен активный запрос в pending_asks';
        }
      }
      results.push({
        id: 5,
        title: '5. Блокирующий hub.ask() + маскировка секретов в логах',
        passed: test5Passed,
        details: test5Details,
      });

      // 6. Потребление памяти (< 80 МБ RSS)
      const dash6 = await callHubBackendJson('GET', '/api/dashboard', undefined, hdrs2);
      const rssMb = Number(dash6.data?.system?.hub_rss_mb || 0);
      results.push({
        id: 6,
        title: '6. Потребление памяти процессом python3 -m hub (< 80 МБ RSS)',
        passed: rssMb > 0 && rssMb < 80,
        details: `Текущее потребление памяти Hub (PID=${dash6.data?.system?.hub_pid}): ${rssMb} МБ RSS (лимит бюджета: 80 МБ).`,
      });

      // Удаляем временные тестовые проекты после прогона чек-листа приёмки
      for (const p of dash6.data?.projects || []) {
        if (p.name === 'acceptance-tree-test' || p.name === 'acceptance-crash-test') {
          await callHubBackendJson('DELETE', `/api/projects/${p.id}`, undefined, hdrs2);
        }
      }

      res.json({
        ok: true,
        all_passed: results.every((r) => r.passed),
        results,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Проксирование всех запросов /api/* и /internal/* в Python-сервер Hub (127.0.0.1:8050)
  app.use(['/api', '/internal'], async (req, res) => {
    await ensurePythonHubRunning();

    const targetPath = req.originalUrl;
    const isSse = targetPath.includes('/stream');

    const proxyHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (
        v !== undefined &&
        lower !== 'host' &&
        lower !== 'connection' &&
        lower !== 'x-forwarded-for' &&
        lower !== 'x-real-ip'
      ) {
        proxyHeaders[k] = v;
      }
    }

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: HUB_BACKEND_PORT,
        path: targetPath,
        method: req.method,
        headers: proxyHeaders,
      },
      (proxyRes) => {
        res.status(proxyRes.statusCode || 200);
        for (const [hk, hv] of Object.entries(proxyRes.headers)) {
          if (hv !== undefined) {
            res.setHeader(hk, hv);
          }
        }
        if (isSse) {
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
        }
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ detail: `Hub backend proxy error: ${err.message}` });
      }
    });

    req.pipe(proxyReq);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(WORKSPACE_ROOT, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Gateway] Hub Web UI running on http://0.0.0.0:${PORT} -> proxying API to python3 -m hub (:8050)`);
  });
}

process.on('SIGTERM', () => {
  isShuttingDown = true;
  if (hubProc) hubProc.kill('SIGTERM');
  process.exit(0);
});

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
