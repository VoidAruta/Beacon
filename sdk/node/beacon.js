/**
 * Beacon Node.js SDK (/opt/beacon/sdk/node/beacon.js)
 * Автоматически подключается через NODE_PATH
 */

const http = require('http');
const fs = require('fs');

function getApiConfig() {
  const apiUrl = (
    process.env.BEACON_API_URL ||
    process.env.ARUTA_API_URL ||
    process.env.HUB_API_URL ||
    'http://127.0.0.1:8050/internal'
  ).replace(/\/+$/, '');
  const runToken =
    process.env.BEACON_RUN_TOKEN ||
    process.env.ARUTA_RUN_TOKEN ||
    process.env.HUB_RUN_TOKEN ||
    '';
  const internalToken =
    process.env.BEACON_INTERNAL_TOKEN ||
    process.env.ARUTA_INTERNAL_TOKEN ||
    process.env.HUB_INTERNAL_TOKEN ||
    '';
  return { apiUrl, runToken, internalToken };
}

function requestJson(method, path, payload = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const { apiUrl, runToken, internalToken } = getApiConfig();
    const target = new URL(`${apiUrl}/${path.replace(/^\/+/, '')}`);
    const bodyStr = payload !== null ? JSON.stringify(payload) : null;

    const headers = {
      'X-Beacon-Token': runToken,
      'X-Aruta-Token': runToken,
      'X-Hub-Token': runToken,
      'Accept': 'application/json',
    };
    if (internalToken) {
      headers['X-Beacon-Internal-Token'] = internalToken;
      headers['X-Aruta-Internal-Token'] = internalToken;
      headers['X-Hub-Internal-Token'] = internalToken;
    }
    if (bodyStr !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 8050,
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
            reject(new Error(`Beacon API HTTP ${res.statusCode}: ${raw}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Beacon API request timeout'));
    });

    if (bodyStr !== null) {
      req.write(bodyStr);
    }
    req.end();
  });
}

async function notify(text, level = 'info') {
  const res = await requestJson('POST', '/notify', { text: String(text), level: String(level) });
  return Boolean(res.ok ?? true);
}

async function secret(name, { asPath = false } = {}) {
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
  return res.value;
}

async function cookies_expired(secretName, note = 'Куки устарели, требуется обновление') {
  const res = await requestJson('POST', '/cookies_expired', {
    secret_name: String(secretName),
    note: String(note),
  });
  return Boolean(res.ok ?? true);
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
    const pollRes = await requestJson('GET', `/ask/poll/${askId}`, null, 15000);
    if (pollRes.status === 'answered') {
      return String(pollRes.answer ?? '');
    }
    if (pollRes.status === 'timeout' || pollRes.status === 'cancelled') {
      throw new Error(`beacon.ask('${prompt}') ended with status: ${pollRes.status}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timeout waiting for beacon.ask('${prompt}')`);
}

const state = {
  async get(key, defaultVal = null) {
    const res = await requestJson('GET', `/kv/${encodeURIComponent(String(key))}`);
    return res.found ? res.value : defaultVal;
  },
  async set(key, value) {
    const res = await requestJson('PUT', `/kv/${encodeURIComponent(String(key))}`, { value });
    return Boolean(res.ok ?? true);
  },
  async delete(key) {
    const res = await requestJson('DELETE', `/kv/${encodeURIComponent(String(key))}`);
    return Boolean(res.ok ?? true);
  },
};

module.exports = {
  notify,
  secret,
  cookies_expired,
  ask,
  state,
};
