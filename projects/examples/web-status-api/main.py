import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import hub

PORT = int(os.environ.get("PORT", "18081"))
START_TS = time.time()


class StatusHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        hits = int(hub.state.get("http_hits", 0) or 0) + 1
        hub.state.set("http_hits", hits)

        payload = {
            "ok": True,
            "service": "web-status-api",
            "port": PORT,
            "uptime_sec": round(time.time() - START_TS, 1),
            "http_hits": hits,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[web-status-api] {self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"[web-status-api] HTTP сервер запущен на 0.0.0.0:{PORT} (эндпоинт /health)", flush=True)
    server = HTTPServer(("0.0.0.0", PORT), StatusHandler)
    server.serve_forever()
