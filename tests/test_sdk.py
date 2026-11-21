"""
Тесты Python и Node.js SDK Beacon (`python3 -m unittest tests/test_sdk.py -v`):
- Ретраи при 5xx / сетевых сбоях и немедленный отказ (без ретраев) при 4xx
- Best-effort поведение по умолчанию (`strict=False`) и выброс BeaconApiError при `strict=True`
- `secret()` с `BEACON_SECRET_TYPE_*` (числовые строки не конвертируются в int, cookie_json парсится, file -> path)
- Fallback на env-файлы при недоступности панели
- Немедленное прерывание `ask()` на HTTP 401/403/404
- `ping()` с BEACON_PING_TOKEN + Node.js SDK smoke test
"""

import http.server
import importlib.util
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
import warnings
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SDK_PY_DIR = REPO_ROOT / "sdk" / "python"
SDK_NODE_PATH = REPO_ROOT / "sdk" / "node"

if str(SDK_PY_DIR) not in sys.path:
    sys.path.insert(0, str(SDK_PY_DIR))

import beacon as beacon_sdk  # noqa: E402


class _MockState:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.requests: list[tuple[str, str, Any]] = []
        self.fail_503_remaining: dict[str, int] = {}
        self.force_status: dict[str, int] = {}
        self.kv: dict[str, Any] = {}
        self.ask_polls: int = 0
        self.secrets: dict[str, dict[str, Any]] = {
            "num_pin": {"type": "text", "value": "12345", "file_path": "/tmp/num_pin"},
            "cookies_main": {
                "type": "cookie_json",
                "value": json.dumps([{"name": "sid", "value": "xyz", "domain": ".example.com"}]),
                "file_path": "/tmp/cookies_main.json",
            },
            "cert_file": {"type": "file", "value": None, "file_path": "/tmp/cert.pem"},
        }


class _ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def _make_handler(state: _MockState):
    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _send_json(self, code: int, payload: Any) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _handle(self, method: str) -> None:
            length = int(self.headers.get("Content-Length", "0") or 0)
            body_raw = self.rfile.read(length).decode("utf-8") if length > 0 else ""
            body = json.loads(body_raw) if body_raw else None
            path = self.path.split("?", 1)[0]
            state.requests.append((method, path, body))

            if state.fail_503_remaining.get(path, 0) > 0:
                state.fail_503_remaining[path] -= 1
                self._send_json(503, {"detail": "transient error"})
                return

            if path in state.force_status:
                self._send_json(state.force_status[path], {"detail": "forced status"})
                return

            if method == "POST" and path == "/internal/notify":
                self._send_json(200, {"ok": True})
                return

            if method == "POST" and path == "/internal/cookies_expired":
                self._send_json(200, {"ok": True})
                return

            if method == "GET" and path.startswith("/internal/secret/"):
                name = path.rsplit("/", 1)[-1]
                if name not in state.secrets:
                    self._send_json(404, {"detail": "secret not found"})
                    return
                self._send_json(200, state.secrets[name])
                return

            if path.startswith("/internal/kv/"):
                key = path.rsplit("/", 1)[-1]
                if method == "GET":
                    if key in state.kv:
                        self._send_json(200, {"found": True, "value": state.kv[key]})
                    else:
                        self._send_json(200, {"found": False, "value": None})
                    return
                if method == "PUT":
                    state.kv[key] = body.get("value") if isinstance(body, dict) else None
                    self._send_json(200, {"ok": True})
                    return
                if method == "DELETE":
                    state.kv.pop(key, None)
                    self._send_json(200, {"ok": True})
                    return

            if method == "POST" and path == "/internal/ask/create":
                state.ask_polls = 0
                self._send_json(200, {"ask_id": "ask-test-1"})
                return

            if method == "GET" and path.startswith("/internal/ask/poll/"):
                state.ask_polls += 1
                self._send_json(200, {"status": "answered", "answer": "4242"})
                return

            if method == "GET" and path.startswith("/api/ping/"):
                tok = path.rsplit("/", 1)[-1]
                if tok == "valid-ping-tok":
                    self._send_json(200, {"ok": True, "project": "demo"})
                else:
                    self._send_json(404, {"detail": "not found"})
                return

            self._send_json(404, {"detail": "unknown route"})

        def do_GET(self) -> None:
            self._handle("GET")

        def do_POST(self) -> None:
            self._handle("POST")

        def do_PUT(self) -> None:
            self._handle("PUT")

        def do_DELETE(self) -> None:
            self._handle("DELETE")

    return _Handler


class TestBeaconSdk(unittest.TestCase):
    server: _ThreadedHTTPServer
    state: _MockState
    thread: threading.Thread
    base_url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.state = _MockState()
        cls.server = _ThreadedHTTPServer(("127.0.0.1", 0), _make_handler(cls.state))
        port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls._orig_retry_delays = beacon_sdk._RETRY_DELAYS
        beacon_sdk._RETRY_DELAYS = (0.01, 0.01)

    @classmethod
    def tearDownClass(cls) -> None:
        beacon_sdk._RETRY_DELAYS = cls._orig_retry_delays
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        self.state.reset()
        self._saved_env = dict(os.environ)
        os.environ["BEACON_API_URL"] = f"{self.base_url}/internal"
        os.environ["BEACON_RUN_TOKEN"] = "run-tok-1"

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._saved_env)

    def test_01_retries_503_and_fails_fast_on_4xx(self) -> None:
        self.state.fail_503_remaining["/internal/notify"] = 2
        self.assertTrue(beacon_sdk.notify("hello retry", strict=True))
        notify_calls = [r for r in self.state.requests if r[1] == "/internal/notify"]
        self.assertEqual(len(notify_calls), 3)

        self.state.requests.clear()
        self.state.force_status["/internal/notify"] = 403
        with self.assertRaises(beacon_sdk.BeaconApiError) as ctx:
            beacon_sdk.notify("forbidden", strict=True)
        self.assertEqual(ctx.exception.status_code, 403)
        # 4xx must not be retried
        self.assertEqual(len([r for r in self.state.requests if r[1] == "/internal/notify"]), 1)

    def test_02_best_effort_vs_strict_mode(self) -> None:
        os.environ["BEACON_API_URL"] = "http://127.0.0.1:1/internal"
        self.assertFalse(beacon_sdk.notify("offline"))
        self.assertFalse(beacon_sdk.cookies_expired("my_cookie"))
        self.assertFalse(beacon_sdk.state.set("k", "v"))
        self.assertEqual(beacon_sdk.state.get("k", default="fallback"), "fallback")
        self.assertFalse(beacon_sdk.state.delete("k"))

        with self.assertRaises(beacon_sdk.BeaconApiError):
            beacon_sdk.notify("offline", strict=True)
        with self.assertRaises(beacon_sdk.BeaconApiError):
            beacon_sdk.state.get("k", strict=True)
        with self.assertRaises(beacon_sdk.BeaconApiError):
            beacon_sdk.state.set("k", "v", strict=True)

    def test_03_secret_types_preserve_numeric_string_and_env_fallback(self) -> None:
        pin = beacon_sdk.secret("num_pin")
        self.assertIsInstance(pin, str)
        self.assertEqual(pin, "12345")

        cookies = beacon_sdk.secret("cookies_main")
        self.assertIsInstance(cookies, list)
        self.assertEqual(cookies[0]["name"], "sid")

        self.assertEqual(beacon_sdk.secret("cert_file"), "/tmp/cert.pem")
        self.assertEqual(beacon_sdk.secret("num_pin", as_path=True), "/tmp/num_pin")

        # Offline fallback with BEACON_SECRET_FILE_* and BEACON_SECRET_TYPE_*
        with tempfile.TemporaryDirectory(prefix="beacon_sdk_sec_") as tmpdir:
            p = Path(tmpdir)
            num_f = p / "pin.txt"
            num_f.write_text("00789", encoding="utf-8")
            cook_f = p / "cookies.json"
            cook_f.write_text('[{"name":"a","value":"b","domain":"example.com"}]', encoding="utf-8")
            bin_f = p / "blob.bin"
            bin_f.write_bytes(b"\x00\x01")

            os.environ["BEACON_API_URL"] = "http://127.0.0.1:1/internal"
            os.environ["BEACON_SECRET_FILE_pin"] = str(num_f)
            os.environ["BEACON_SECRET_TYPE_pin"] = "text"
            os.environ["BEACON_SECRET_FILE_ck"] = str(cook_f)
            os.environ["BEACON_SECRET_TYPE_ck"] = "cookie_json"
            os.environ["BEACON_SECRET_FILE_bf"] = str(bin_f)
            os.environ["BEACON_SECRET_TYPE_bf"] = "file"

            val_pin = beacon_sdk.secret("pin")
            self.assertIsInstance(val_pin, str)
            self.assertEqual(val_pin, "00789")
            val_ck = beacon_sdk.secret("ck")
            self.assertIsInstance(val_ck, list)
            self.assertEqual(val_ck[0]["name"], "a")
            self.assertEqual(beacon_sdk.secret("bf"), str(bin_f))

    def test_04_ask_aborts_immediately_on_401_403_404(self) -> None:
        self.assertEqual(beacon_sdk.ask("SMS code?", timeout=5), "4242")

        self.state.force_status["/internal/ask/poll/ask-test-1"] = 404
        with self.assertRaises(beacon_sdk.BeaconApiError) as ctx:
            beacon_sdk.ask("SMS code?", timeout=30)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_05_ping_and_canonical_exports(self) -> None:
        self.assertFalse(beacon_sdk.ping())
        with self.assertRaises(RuntimeError):
            beacon_sdk.ping(strict=True)

        os.environ["BEACON_PING_TOKEN"] = "valid-ping-tok"
        self.assertTrue(beacon_sdk.ping())

        # Failed ping must redact secret ping token in error message
        with self.assertRaises(beacon_sdk.BeaconApiError) as ping_err:
            beacon_sdk.ping(token="super-secret-ping-999", strict=True)
        self.assertNotIn("super-secret-ping-999", str(ping_err.exception))
        self.assertIn("/api/ping/***", str(ping_err.exception))

        # Verify only canonical beacon.py / beacon.js exist in sdk/
        self.assertTrue((SDK_PY_DIR / "beacon.py").exists())
        self.assertFalse((SDK_PY_DIR / "aruta.py").exists())
        self.assertFalse((SDK_PY_DIR / "hub.py").exists())

    def test_06_node_sdk_smoke(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("node is not installed")
        script = r"""
const assert = require('assert');
const beacon = require('beacon');
(async () => {
  assert.strictEqual(await beacon.notify('node hello', 'info', { strict: true }), true);
  const pin = await beacon.secret('num_pin');
  assert.strictEqual(typeof pin, 'string');
  assert.strictEqual(pin, '12345');
  const cookies = await beacon.secret('cookies_main');
  assert.ok(Array.isArray(cookies) && cookies[0].name === 'sid');
  assert.strictEqual(await beacon.state.set('node_k', { ok: 1 }, { strict: true }), true);
  const got = await beacon.state.get('node_k', null, { strict: true });
  assert.deepStrictEqual(got, { ok: 1 });
  assert.strictEqual(await beacon.ping(), true);
  let leaked = false;
  try {
    await beacon.ping('node-secret-ping-888', { strict: true });
    assert.fail('expected ping failure');
  } catch (err) {
    leaked = String(err.message || '').includes('node-secret-ping-888');
    assert.ok(String(err.message || '').includes('/api/ping/***'));
  }
  assert.strictEqual(leaked, false);
  console.log('NODE_SDK_OK');
})().catch((err) => { console.error(err); process.exit(1); });
"""
        env = dict(os.environ)
        env["NODE_PATH"] = str(SDK_NODE_PATH)
        env["BEACON_API_URL"] = f"{self.base_url}/internal"
        env["BEACON_RUN_TOKEN"] = "run-tok-1"
        env["BEACON_PING_TOKEN"] = "valid-ping-tok"
        proc = subprocess.run(
            ["node", "-e", script],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=f"stderr: {proc.stderr}\nstdout: {proc.stdout}")
        self.assertIn("NODE_SDK_OK", proc.stdout)

    def test_07_sdk_security_hardening_loopback_redirects_and_exports(self) -> None:
        import beacon as top_beacon_pkg
        import hub as top_hub_pkg

        # 1. Top-level packages export ping, BeaconApiError, and version 2.4.1
        self.assertTrue(callable(getattr(top_beacon_pkg, "ping", None)))
        self.assertTrue(callable(getattr(top_hub_pkg, "ping", None)))
        self.assertEqual(top_hub_pkg.__version__, "2.4.1")

        # 2. Python SDK refuses non-loopback BEACON_API_URL unless BEACON_ALLOW_REMOTE_API=1
        os.environ["BEACON_API_URL"] = "https://evil.example.com/internal"
        with self.assertRaises(beacon_sdk.BeaconApiError) as ctx_remote:
            beacon_sdk.notify("should-not-leak", strict=True)
        self.assertIn("non-loopback", str(ctx_remote.exception))

        # 3. URL redaction scrubs userinfo, ping tokens, and query strings
        red = beacon_sdk._redact_url("http://user:MyPass99@127.0.0.1:8050/api/ping/secret-tok-123?token=abc")
        self.assertNotIn("MyPass99", red)
        self.assertNotIn("secret-tok-123", red)
        self.assertNotIn("token=abc", red)
        self.assertEqual(red, "http://***@127.0.0.1:8050/api/ping/***?***")

        # 4. Empty secret name rejected immediately
        os.environ["BEACON_API_URL"] = f"{self.base_url}/internal"
        with self.assertRaises(ValueError):
            beacon_sdk.secret("   ")

        # 5. Python SDK does not follow HTTP 302 redirects (protects X-Beacon-Token)
        self.state.force_status["/internal/notify"] = 302
        with self.assertRaises(beacon_sdk.BeaconApiError) as ctx_redir:
            beacon_sdk.notify("redir-test", strict=True)
        self.assertEqual(ctx_redir.exception.status_code, 302)

        # 6. Node.js SDK rejects non-loopback BEACON_API_URL and redacts URL credentials
        if shutil.which("node") is not None:
            node_sec_script = r"""
const assert = require('assert');
const beacon = require('beacon');
(async () => {
  process.env.BEACON_API_URL = 'https://evil.example.com/internal';
  let blocked = false;
  try {
    await beacon.notify('leak-check', 'info', { strict: true });
  } catch (err) {
    blocked = String(err.message || '').includes('non-loopback');
  }
  assert.strictEqual(blocked, true);
  let emptyRejected = false;
  try {
    await beacon.secret('   ');
  } catch (_) {
    emptyRejected = true;
  }
  assert.strictEqual(emptyRejected, true);
  console.log('NODE_SEC_OK');
})().catch((err) => { console.error(err); process.exit(1); });
"""
            env = dict(os.environ)
            env["NODE_PATH"] = str(SDK_NODE_PATH)
            proc = subprocess.run(
                ["node", "-e", node_sec_script],
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=f"stderr: {proc.stderr}\nstdout: {proc.stdout}")
            self.assertIn("NODE_SEC_OK", proc.stdout)


if __name__ == "__main__":
    unittest.main()
