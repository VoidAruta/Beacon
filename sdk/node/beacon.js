/**
 * Beacon Node.js SDK (/opt/beacon/sdk/node/beacon.js)
 * Автоматически подключается через NODE_PATH
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

const RETRY_DELAYS_MS = [500, 1500];

class BeaconApiError extends Error {
  constructor(message, statusCode = 0) {
    super(message);
    this.name = 'BeaconApiError';
    this.statusCode = Number(statusCode || 0);
  }
}

function getApiConfig() {
  const apiUrl = (
    process.env.BEACON_API_URL ||
    'http://127.0.0.1:8050/internal'
  ).replace(/\/+$/, '');
  const runToken = process.env.BEACON_RUN_TOKEN || '';
  return { apiUrl, runToken };
}

function logStderr(msg) {
  try {
    process.stderr.write(`[beacon-sdk] ${msg}\n`);
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function singleHttpRequest(method, targetUrl, headers, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: method.toUpperCase(),
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new BeaconApiError(`Beacon API HTTP ${res.statusCode}: ${raw}`, res.statusCode));
          }
        });
      }
    );
    req.on('error', (err) => reject(new BeaconApiError(`Beacon API connection error: ${err.message}`, 0)));
    req.on('timeout', () => {
      req.destroy(new BeaconApiError('Beacon API request timeout', 0));
    });
    if (bodyStr !== null) {
      req.write(bodyStr);
    }
    req.end();
  });
}

async function requestRawUrl(method, targetUrl, headers = { Accept: 'application/json' }, payload = null, timeoutMs = 15000, maxAttempts = 3) {
  const reqHeaders = { ...headers };
  const bodyStr = payload !== null ? JSON.stringify(payload) : null;
  if (bodyStr !== null) {
    reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
    reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  let lastErr = null;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await singleHttpRequest(method, targetUrl, reqHeaders, bodyStr, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (err && err.statusCode >= 400 && err.statusCode < 500) {
        throw err;
      }
      if (attempt + 1 < attempts) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

async function requestJson(method, path, payload = null, timeoutMs = 15000, maxAttempts = 3) {
  const { apiUrl, runToken } = getApiConfig();
  const targetUrl = `${apiUrl}/${path.replace(/^\/+/, '')}`;
  const headers = {
    'X-Beacon-Token': runToken,
    Accept: 'application/json',
  };
  return requestRawUrl(method, targetUrl, headers, payload, timeoutMs, maxAttempts);
}

async function notify(text, level = 'info', opts = {}) {
  const strict = Boolean(opts && opts.strict);
  try {
    const res = await requestJson('POST', '/notify', { text: String(text), level: String(level) });
    return Boolean(res.ok ?? true);
  } catch (err) {
    if (strict) throw err;
    logStderr(`notify() failed (non-fatal): ${err.message}`);
    return false;
  }
}

async function secret(name, { asPath = false } = {}) {
  try {
    const res = await requestJson('GET', `/secret/${encodeURIComponent(name)}`);
    if (asPath) return res.file_path;
    if (res.type === 'cookie_json') {
      if (Array.isArray(res.value) || (res.value && typeof res.value === 'object')) {
        return res.value;
      }
      if (typeof res.value === 'string' && res.value.trim()) {
        return JSON.parse(res.value);
      }
      if (res.file_path && fs.existsSync(res.file_path)) {
        return JSON.parse(fs.readFileSync(res.file_path, 'utf8'));
      }
      return [];
    }
    if (res.type === 'file') return res.file_path;
    return res.value === undefined || res.value === null ? res.value : String(res.value);
  } catch (err) {
    const envFile = process.env[`BEACON_SECRET_FILE_${name}`];
    const secType = (process.env[`BEACON_SECRET_TYPE_${name}`] || 'text').trim().toLowerCase();
    if (asPath && envFile) return envFile;
    if (envFile && fs.existsSync(envFile)) {
      if (secType === 'file') return envFile;
      const content = fs.readFileSync(envFile, 'utf8');
      if (secType === 'cookie_json') {
        return JSON.parse(content);
      }
      return content;
    }
    throw err;
  }
}

async function cookies_expired(secretName, note = 'Куки устарели, требуется обновление', opts = {}) {
  const strict = Boolean(opts && opts.strict);
  try {
    const res = await requestJson('POST', '/cookies_expired', {
      secret_name: String(secretName),
      note: String(note),
    });
    return Boolean(res.ok ?? true);
  } catch (err) {
    if (strict) throw err;
    logStderr(`cookies_expired('${secretName}') failed (non-fatal): ${err.message}`);
    return false;
  }
}

async function ask(prompt, timeout = 300) {
  const createRes = await requestJson('POST', '/ask/create', {
    prompt: String(prompt),
    timeout: Number(timeout),
  });
  const askId = createRes.ask_id;
  if (!askId) {
    throw new Error(`Failed to create ask: ${JSON.stringify(createRes)}`);
  }

  const deadline = Date.now() + (Number(timeout) + 5) * 1000;
  while (Date.now() < deadline) {
    let pollRes;
    try {
      pollRes = await requestJson('GET', `/ask/poll/${askId}`, null, 15000, 1);
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 404)) {
        throw err;
      }
      logStderr(`ask poll error (${askId}): ${err.message}`);
      await sleep(1000);
      continue;
    }

    if (pollRes.status === 'answered') {
      return String(pollRes.answer ?? '');
    }
    if (pollRes.status === 'timeout' || pollRes.status === 'cancelled') {
      throw new Error(`beacon.ask('${prompt}') ended with status: ${pollRes.status}`);
    }
    await sleep(300);
  }
  throw new Error(`Timeout waiting for beacon.ask('${prompt}')`);
}

async function ping(token = null, opts = {}) {
  const strict = Boolean(opts && opts.strict);
  const tok = String(token || process.env.BEACON_PING_TOKEN || '').trim();
  if (!tok) {
    if (strict) throw new Error('BEACON_PING_TOKEN is not set');
    logStderr('ping() skipped: BEACON_PING_TOKEN is not set');
    return false;
  }
  const { apiUrl } = getApiConfig();
  const rootUrl = apiUrl.endsWith('/internal') ? apiUrl.slice(0, -'/internal'.length) : apiUrl.split('/internal')[0];
  const pingUrl = `${rootUrl.replace(/\/+$/, '')}/api/ping/${encodeURIComponent(tok)}`;
  try {
    const res = await requestRawUrl('GET', pingUrl, { Accept: 'application/json' }, null, 10000, 3);
    return Boolean(res.ok ?? true);
  } catch (err) {
    if (strict) throw err;
    logStderr(`ping() failed (non-fatal): ${err.message}`);
    return false;
  }
}

const state = {
  async get(key, defaultVal = null, opts = {}) {
    const strict = Boolean(opts && opts.strict);
    try {
      const res = await requestJson('GET', `/kv/${encodeURIComponent(String(key))}`);
      return res.found ? res.value : defaultVal;
    } catch (err) {
      if (strict) throw err;
      logStderr(`state.get('${key}') failed (returning default): ${err.message}`);
      return defaultVal;
    }
  },
  async set(key, value, opts = {}) {
    const strict = Boolean(opts && opts.strict);
    try {
      const res = await requestJson('PUT', `/kv/${encodeURIComponent(String(key))}`, { value });
      return Boolean(res.ok ?? true);
    } catch (err) {
      if (strict) throw err;
      logStderr(`state.set('${key}') failed (non-fatal): ${err.message}`);
      return false;
    }
  },
  async delete(key, opts = {}) {
    const strict = Boolean(opts && opts.strict);
    try {
      const res = await requestJson('DELETE', `/kv/${encodeURIComponent(String(key))}`);
      return Boolean(res.ok ?? true);
    } catch (err) {
      if (strict) throw err;
      logStderr(`state.delete('${key}') failed (non-fatal): ${err.message}`);
      return false;
    }
  },
};

module.exports = {
  BeaconApiError,
  notify,
  secret,
  cookies_expired,
  ask,
  ping,
  state,
};
