> 🌐 **Language / Язык:** **English** | [Русский (README.ru.md)](README.ru.md)

# Beacon — Containerless PaaS, Process Supervisor & MCP Server (`< 80 MB RAM`)

[![License: MIT](https://img.shields.io/badge/License-MIT-indigo.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![Platform: Linux / Raspberry Pi / Android chroot](https://img.shields.io/badge/Platform-Linux%20%7C%20RPi%20%7C%20Android%20chroot-emerald.svg)](#quick-start-1-command-install)
[![MCP: Streamable HTTP](https://img.shields.io/badge/MCP-Streamable%20HTTP%20%2Fmcp-purple.svg)](#ai-agent-access-mcp--rest-api)

**Beacon** is a self-hosted, ultra-lightweight **containerless PaaS and process supervisor** (`< 80 MB RAM` idle) built to run 24/7 Telegram/Discord bots (`service`), HTTP APIs & websites (`web`), and scheduled cron/webhook jobs (`job`) on Linux VPS, Raspberry Pi (`x86_64` / `aarch64`), and Android (`chroot` / Termux) **without Docker**. Unlike heavy container stacks or basic process managers (`PM2`, `supervisord`, raw `systemd`), Beacon writes logs directly to disk file descriptors (`buffering=0`, zero `SIGPIPE` when Beacon restarts), isolates process trees via `os.setsid`/`os.killpg`, and ships with a zero-install Python/Node.js SDK (`import beacon`), encrypted-at-rest `0600` secrets & `Cookie-Editor` sessions, 2-click server migration via `.zip` backup restore, and a built-in **Streamable HTTP MCP server (`/mcp`)** for AI coding agents.

![Beacon Control Panel Overview](docs/assets/beacon-overview.svg)

> 📸 *Screenshots and architecture diagrams live in [`docs/assets/`](docs/assets/). The web interface supports instant `RU | EN` language switching in the top bar.*

---

## Table of Contents

- [Why Beacon?](#why-beacon)
- [Quick Start (1-Command Install)](#quick-start-1-command-install)
- [Basic Usage Scenario](#basic-usage-scenario)
- [2-Click Self-Update & Server Migration (Backup / Restore)](#2-click-self-update--server-migration-backup--restore)
- [Supervisor Architecture Invariants](#supervisor-architecture-invariants)
- [Built-in SDK (`import beacon` / `require('beacon')`)](#built-in-sdk-import-beacon--requirebeacon)
- [AI Agent Access (MCP `/mcp` & REST `/api/v1/`)](#ai-agent-access-mcp-mcp--rest-apiv1)
- [CLI Reference](#cli-reference)
- [Environment Variables](#environment-variables)
- [Security & Documentation](#security--documentation)
- [License](#license)

---

## Why Beacon?

| Capability | Docker / Coolify / CapRover | PM2 / supervisord | **Beacon** |
|---|---|---|---|
| **Idle RAM Footprint** | `300–1200+ MB` | `45–120 MB` | **`< 80 MB`** (runs even in Python stdlib fallback mode) |
| **Works in Android `chroot` / Termux (no `systemd` / cgroups)** | ❌ | ⚠️ Partial | **✅ Native (`aid_inet` 3003 / `aid_net_raw` 3004 preserved)** |
| **Child Survival on Supervisor Restart (`No SIGPIPE`)** | ❌ Container restarts | ⚠️ Log pipe risk | **✅ Direct FD logs (`buffering=0`) + PID/create_time re-attach** |
| **Built-in SDK (Alerts, Secrets, 2FA Prompts, KV State)** | ❌ | ❌ | **✅ `import beacon` / `require('beacon')` out of the box** |
| **Built-in MCP Server (`/mcp`) with Human Diff Approval** | ❌ | ❌ | **✅ 18 MCP tools, unified diff queue, secret redaction** |
| **2-Click Backup Upload/Restore & Git Self-Update** | ⚠️ External | ❌ | **✅ Built into the Web UI** |

---

## Quick Start (1-Command Install)

### Option 1: 1-Command Automated Install (Ubuntu / Debian / Raspberry Pi / Android Chroot)

```bash
curl -fsSL https://raw.githubusercontent.com/VoidAruta/Beacon/main/scripts/install.sh | sudo bash
```

The installer is idempotent: it clones Beacon into `/opt/beacon` (if not already inside a checkout), creates the unprivileged `beacon-runner` user, sets up `.venv`, initializes the SQLite WAL database, runs `python3 -m beacon doctor`, and starts `beacon.service` via `systemd` (or background daemon in `chroot`/containers without `systemd`).

### Option 2: Manual Run from Source

```bash
git clone https://github.com/VoidAruta/Beacon.git beacon
cd beacon
pip install -r requirements.txt
python3 -m beacon --port 8050
```

> **Note:** Pre-built frontend assets are already bundled in `hub/static/`, so Node.js is **not** required on your production server. If you modify `src/`, run `npm install && npm run build`.

### Option 3: Docker Compose (Optional)

```bash
docker compose up -d --build
```

### First Login
1. Open **`http://127.0.0.1:8050`** (or your server's LAN/Tailscale IP).
2. Sign in with the initial password: **`admin`**.
3. Open **Settings (`5. Settings, Backup & RBAC`)** and set a new password (minimum 8 characters).
   - *Security Guard:* While the password remains `admin`, Beacon displays a prominent warning banner, restricts login to loopback and RFC1918 private subnets (`127.0.0.0/8`, `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`), and locks AI/MCP access off.

---

## Basic Usage Scenario

1. **Create or Import a Project:**
   - Go to **2. Projects & Console** → click **`+ New Project`** (or import a `.zip` archive / Git repository).
   - Choose one of the three workload classes:
     - **`service`** — 24/7 Telegram/Discord bots & workers with automatic crash-loop backoff (`restart_policy`, `min_uptime_sec`, `max_restarts`).
     - **`web`** — HTTP/REST API servers with automatic `$PORT` injection, pre-launch port conflict check, and active HTTP `/health` or TCP probes.
     - **`job`** — Scheduled tasks (`interval`, `cron`, `daily HH:MM`), HMAC-SHA256 webhook triggers (`/api/webhook/{token}`), Dead Man's Switch (`/api/ping/{token}`), and job chaining (`on_success_project_id`).
2. **Bind Secrets & Cookies:**
   - Go to **3. Web Sessions & Secrets** to store API tokens (`text`), `Cookie-Editor` exports (`cookie_json`), or `.session`/`.pem` files (`file`) with `0600` permissions. Secrets are never leaked into `/proc/<pid>/environ` and are automatically redacted (`***SECRET:<name>***`) in logs.
3. **Launch & Monitor:**
   - Click **Start** (`Run Now` for jobs, `Start HTTP` for web apps, or `Start Service` for daemons). Stream live logs via SSE, send interactive commands to `stdin`, or inspect persistent SQLite state in the **KV State** tab.

---

## 2-Click Self-Update & Server Migration (Backup / Restore)

### Updating Beacon in 2 Clicks
1. Click **`v2.2 / Update`** in the top navigation bar.
2. Click **Check Git Updates** to inspect incoming commits on `origin/main`, then click **Update Panel (with Auto-Backup)**. Beacon snapshots `data/backups/`, runs `git pull --ff-only`, migrates SQLite, and restarts the panel without interrupting running child projects.

### Migrating to a New Server in 2 Clicks
1. **On the old server:** Open **5. Settings → Backup & Systemd** and click **Download `.zip` Backup** (contains `data/hub.db`, `data/secrets/*`, and all `projects/*` while excluding machine-specific `session.secret` and `internal.token`).
2. **On the new server:** Install Beacon, open **5. Settings → Backup & Systemd → Upload & Restore Backup**, select your `.zip` archive, and click **Restore Backup**. Beacon automatically creates a pre-restore safety snapshot (`beacon_pre_restore_<ts>.zip`), verifies SQLite `PRAGMA integrity_check`, restores all projects and `0600` secrets, and reloads the registry.

---

## Supervisor Architecture Invariants

1. **Process Group Isolation (`os.setsid` / `os.killpg`):** Every child process runs in its own session and process group (`PGID`). Stopping a project sends `SIGTERM` → waits up to 5s → sends `SIGKILL` to the entire `PGID`, leaving zero zombie browsers or orphan sub-workers.
2. **Direct File-Descriptor Logging (`buffering=0`, no `subprocess.PIPE`):** Child `stdout` and `stderr` write directly to an open log file descriptor on disk. Restarting or updating Beacon never triggers `SIGPIPE` in running 24/7 bots.
3. **Survivor Re-Attachment (`recover_running_processes`):** On startup, Beacon matches stored `pid` and `abs(psutil.Process(pid).create_time() - proc_create_time) < 0.5` in an `ECHILD`-safe loop.
4. **PGID RSS Memory Enforcement (no `RLIMIT_AS`):** Beacon sums physical RSS across all processes in the `PGID` every 2 seconds instead of setting `RLIMIT_AS` (which breaks Node.js/V8 and multi-threaded Python on `aarch64`).
5. **Storage & RAM Hygiene:** SQLite runs in `WAL` mode (`synchronous=NORMAL`), log tailing uses `O(1)` `os.SEEK_END`, and Beacon's own idle footprint stays under **80 MB RAM**.

---

## Built-in SDK (`import beacon` / `require('beacon')`)

Every project started by Beacon automatically has `PYTHONPATH` and `NODE_PATH` configured for the built-in SDK — no `pip install` or `npm install` needed.

### Python (`import beacon`)

```python
import beacon

# 1. Send notification to Telegram / ntfy / Webhook ("info" | "warn" | "error")
beacon.notify("Scraper started", level="info")

# 2. Read bound secret (string, parsed Cookie-Editor list, or 0600 file path)
api_key = beacon.secret("OPENWEATHER_KEY")
cookies = beacon.secret("my-parser_cookies")
key_path = beacon.secret("SSH_PRIVATE_KEY", as_path=True)

# 3. Request interactive 2FA / SMS / Captcha code from owner via Web UI or Telegram
code = beacon.ask("Enter 6-digit verification code:", timeout=300)

# 4. Flag expired cookies (triggers red alert banner in UI + Telegram alert)
beacon.cookies_expired("my-parser_cookies", note="HTTP 403 on /api/profile")

# 5. Send Dead Man's Switch heartbeat
beacon.ping()

# 6. Persistent SQLite Key-Value state per project
cursor = beacon.state.get("last_id", default=0)
beacon.state.set("last_id", cursor + 1)
beacon.state.delete("temp_lock")
```

### Node.js (`const beacon = require('beacon')`)

```javascript
const beacon = require('beacon');

async function main() {
  await beacon.notify('Worker started', 'info');
  const token = await beacon.secret('API_TOKEN');
  const cursor = await beacon.state.get('cursor', 0);
  await beacon.state.set('cursor', cursor + 10);
  await beacon.ping();
}

main();
```

---

## AI Agent Access (MCP `/mcp` & REST `/api/v1/`)

Beacon includes a built-in **Streamable HTTP Model Context Protocol (MCP) server** at `/mcp` and a versioned REST API at `/api/v1/` (with OpenAPI 3.1 schema at `/api/v1/openapi.json`).

```bash
# Connect Claude Code to Beacon MCP
claude mcp add --transport http beacon http://<SERVER-IP>:8050/mcp \
  --header "Authorization: Bearer beacon_ai_YOUR_TOKEN"
```

- **18 MCP Tools:** `list_projects`, `get_project`, `get_run_status`, `tail_logs`, `list_runs`, `list_schedules`, `get_device_health`, `run_doctor`, `list_files`, `read_file`, `write_file`, `start_project`, `stop_project`, `restart_project`, `install_dependencies`, `update_schedule`, `create_project_from_template`, `answer_ask`.
- **Human-in-the-Loop Approval Queue:** File writes, schedule edits, and template creations generate a visual `unified diff` approval request unless the project is explicitly listed in `auto_approve_projects`.
- **Prompt Injection Defense & Kill-Switch:** Log and file outputs are scrubbed for secrets and wrapped in `<untrusted_content>`, and the header **Pause AI** button (`python3 -m beacon ai-pause`) blocks all AI tokens immediately.
- See [`docs/AI-ACCESS.md`](docs/AI-ACCESS.md) and [`docs/AI-CODER-GUIDE.md`](docs/AI-CODER-GUIDE.md) for full details.

---

## CLI Reference

```bash
python3 -m beacon --host 0.0.0.0 --port 8050   # Start Beacon server
python3 -m beacon --safe-mode --port 8050      # Start without auto-starting projects
python3 -m beacon doctor                       # Run environment & security diagnostics
python3 -m beacon migrate                      # Apply SQLite migrations & legacy migration
python3 -m beacon backup                       # Create full .zip backup in data/backups/
python3 -m beacon restore <path/to/backup.zip> # Restore database, 0600 secrets & projects
python3 -m beacon reset-password               # Reset admin password & revoke sessions
python3 -m beacon systemd                      # Generate data/generated/beacon.service
python3 -m beacon ai-pause / ai-resume         # Toggle emergency AI Kill-Switch
```

---

## Environment Variables

See [`.env.example`](.env.example) for the complete template:

| Variable | Default | Description |
|---|---|---|
| `BEACON_DIR` | `/opt/beacon` (or repo root) | Base directory for `data/`, `projects/`, and logs |
| `BEACON_HOST` | `0.0.0.0` | HTTP server bind address |
| `BEACON_PORT` | `8050` | HTTP server port |
| `BEACON_ADMIN_PASSWORD` | `admin` | Initial admin password on first database bootstrap |
| `BEACON_ALLOWED_SUBNETS` | RFC1918 + loopback | Allowed client CIDRs for the Web UI & API |
| `BEACON_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | Trusted reverse proxy CIDRs for `X-Forwarded-For` |
| `BEACON_SAFE_MODE` | `0` | Set to `1` to disable project auto-start on boot |

---

## Security & Documentation

- **Security Policy:** [`SECURITY.md`](SECURITY.md)
- **Contributing Guide:** [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Changelog:** [`CHANGELOG.md`](CHANGELOG.md)
- **AI & MCP Integration Guide:** [`docs/AI-ACCESS.md`](docs/AI-ACCESS.md)
- **Developer & AI Coder Guide:** [`docs/AI-CODER-GUIDE.md`](docs/AI-CODER-GUIDE.md)

### Running Tests

```bash
python3 -m unittest discover -s tests -v
npx tsx --test src/utils/hubLogic.test.ts
```

---

## License

Released under the [MIT License](LICENSE).