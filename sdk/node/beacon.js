/**
 * Beacon Node.js SDK (/opt/beacon/sdk/node/beacon.js)
 * Автоматически подключается через NODE_PATH
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

const RETRY_DELAYS_MS = [500, 1500];
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 4096;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function redactUrl(url) {
  let cleaned = String(url || '')
    .replace(/(https?:\/\/)([^/@\s]+)@/g, '$1***@')
    .replace(/(\/api\/ping\/)([^/?#\s]+)/g, '$1***');
  const qIdx = cleaned.indexOf('?');
  if (qIdx !== -1) {
    cleaned = `${cleaned.slice(0, qIdx)}?***`;
  }
  return cleaned;
}

class BeaconApiError extends Error {
  constructor(message, statusCode = 0) {
    super(message);
    this.name = 'BeaconApiError';
    this.statusCode = Number(statusCode || 0);
  }
}

function validateApiUrl(targetUrl) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch (_) {
    throw new BeaconApiError(`Invalid Beacon API URL: ${redactUrl(targetUrl)}`, 0);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new BeaconApiError(`Unsupported Beacon API protocol: ${redactUrl(targetUrl)}`, 0);
  }
  const allowRemote = ['1', 'true', 'yes'].includes(
    String(process.env.BEACON_ALLOW_REMOTE_API || '').trim().toLowerCase()
  );
  if (!allowRemote && !LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) {
    throw new BeaconApiError(
      `Refusing to send Beacon API request to non-loopback host '${target.hostname}' (set BEACON_ALLOW_REMOTE_API=1 to override)`,
      0
    );
  }
  return target;
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
  const target = validateApiUrl(targetUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

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
        let totalBytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (settled) return;
          totalBytes += Buffer.byteLength(chunk, 'utf8');
          if (totalBytes > MAX_RESPONSE_BYTES) {
            req.destroy();
            finishReject(
              new BeaconApiError(
                `Beacon API response exceeded ${MAX_RESPONSE_BYTES} bytes on ${redactUrl(targetUrl)}`,
                0
              )
            );
            return;
          }
          raw += chunk;
        });
        res.on('error', (err) => {
          finishReject(new BeaconApiError(`Beacon API stream error on ${redactUrl(targetUrl)}: ${err.message}`, 0));
        });
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              finishResolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
              finishReject(err);
            }
          } else {
            const snippet = raw.length > MAX_ERROR_BODY_CHARS ? `${raw.slice(0, MAX_ERROR_BODY_CHARS)}...` : raw;
            finishReject(
              new BeaconApiError(
                `Beacon API HTTP ${res.statusCode} on ${redactUrl(targetUrl)}: ${snippet}`,
                res.statusCode
              )
            );
          }
        });
      }
    );
    req.on('error', (err) => {
      finishReject(new BeaconApiError(`Beacon API connection error on ${redactUrl(targetUrl)}: ${err.message}`, 0));
    });
    req.on('timeout', () => {
      const timeoutErr = new BeaconApiError(`Beacon API request timeout on ${redactUrl(targetUrl)}`, 0);
      finishReject(timeoutErr);
      req.destroy();
    });
    if (bodyStr !== null) {
      req.write(bodyStr);
    }
    req.end();
  });
}

async function requestRawUrl(method, targetUrl, headers = { Accept: 'application/json' }, payload = null, timeoutMs = 15000, maxAttempts = 3) {
  validateApiUrl(targetUrl);
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
      if (err && err.statusCode >= 300 && err.statusCode < 500) {
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
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw new Error('Secret name must not be empty');
  }
  try {
    const res = await requestJson('GET', `/secret/${encodeURIComponent(cleanName)}`);
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
    const envFile = process.env[`BEACON_SECRET_FILE_${cleanName}`];
    const secType = (process.env[`BEACON_SECRET_TYPE_${cleanName}`] || 'text').trim().toLowerCase();
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
  const parsedTimeout = Number(timeout);
  const safeTimeout = Number.isFinite(parsedTimeout) ? Math.max(1, Math.min(3600, Math.floor(parsedTimeout))) : 300;
  const createRes = await requestJson('POST', '/ask/create', {
    prompt: String(prompt),
    timeout: safeTimeout,
  });
  const askId = createRes.ask_id;
  if (!askId) {
    throw new Error(`Failed to create ask: ${JSON.stringify(createRes)}`);
  }

  const deadline = Date.now() + (safeTimeout + 5) * 1000;
  while (Date.now() < deadline) {
    let pollRes;
    try {
      pollRes = await requestJson('GET', `/ask/poll/${encodeURIComponent(String(askId))}`, null, 15000, 1);
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
