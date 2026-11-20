# Changelog

All notable changes to **Beacon** are documented in this file.

## [2.4.0] - 2026-11-20

### Security Audit & Hardening (5-Phase Review)
- **IPv4-Mapped IPv6 SSRF & Webhook Protection:** Blocked `::ffff:127.0.0.1`, `::ffff:169.254.169.254`, and loopback/link-local IPv6 destinations across outbound webhooks, Telegram/Discord/Slack/ntfy notifications, and heartbeat checks.
- **Credential & Token Redaction Across All Surfaces:**
  - Always mask proxy credentials (`user:pass@`) in `/api/dashboard`, `beacon doctor`, `RECENT_NOTIFICATIONS`, and Dashboard UI badges.
  - Redact Discord/Slack webhook tokens in notification history and Healthchecks.io UUIDs / Uptime Kuma push tokens / query params in outbound heartbeat logs.
- **Filesystem, Symlink & ZIP-Bomb Safeguards:**
  - Atomic `0600` private file writes (`write_private_file_atomic`) rejecting symlinks for secrets and cookies.
  - Symlink-safe log rotation in `disk_guard` (never truncates symlink targets outside `data/logs/`).
  - Backup restore enforces total uncompressed size limits (ZIP-bomb defense) and supports both canonical `data/beacon.db` and legacy `data/hub.db` archives.
- **Internal SDK & Rate-Limit Hardening (`sdk/python/beacon.py`, `sdk/node/beacon.js`):**
  - Restrict SDK `X-Beacon-Token` requests to loopback hosts by default (`BEACON_ALLOW_REMOTE_API=1` opt-in), disable HTTP `3xx` redirects in Python SDK, bound response/error payload sizes (16 MB / 4 KB), validate `ask()` timeouts (`1..3600s`), and export `ping` & `BeaconApiError` from top-level `beacon`/`hub` packages.
  - Added per-run rate limits on internal SDK notify/ask endpoints.
- **Install / Update / Docker Hardening:**
  - Validated numeric `BEACON_PORT` (`1..65535`) across `install.sh`, `update.sh`, and `zstart_line.sh`; added `--` separator to `git clone`, `chmod 0644` for systemd unit, `/proc/<pid>/cmdline` verification before `SIGTERM`/`SIGKILL`, strict symlink & `600`/`400` permission checks on `data/start.cmd`, root-safe `systemctl` handling, and stop-before-start on rollback.
  - Updated `Dockerfile` healthcheck to use `${BEACON_PORT:-8050}` and enabled `no-new-privileges:true` in `docker-compose.yml`.

### Reliability, UX & Documentation
- **Auto-Switch Console Logs on Restart:** Added a persisted toggle in the project console so restarting a project automatically opens the new run's live log without manually picking it from the dropdown.
- **2-Step Batch Confirmation on Dashboard:** Batch **Stop** and **Restart** for groups of 2+ projects now require inline confirmation (`Confirm / Cancel`) to prevent accidental fleet stops.
- **Clearer Secrets & Cookies UI:** Removed raw Unix octal `(0600)` jargon from navigation labels and status badges in favor of clear human-readable protection descriptions, and fixed legacy `:8765` fallback port display and row action `aria-label` accessibility.
- **Scheduler Memory Hygiene:** Pruned deleted project IDs from in-memory backoff, retry, cron-restart, and heartbeat-alert caches on every tick to preserve the `< 80 MB` idle RAM budget.
- **Unified Version (`2.4.0`) & Documentation Overhaul:** Synchronized version strings across backend, MCP/OpenAPI, CLI, and Web UI; fixed webhook URL/header and AI scope docs in the in-app Documentation tab, `README.md`, `README.ru.md`, `SECURITY.md`, `AGENTS.md`, `docs/AI-ACCESS.md`, and `docs/AI-CODER-GUIDE.md`.

## [2.3.0] - 2026-11-19

### Operations, Deployment & Code Versioning
- **Git Auto-Deploy & 1-Click Rollback:** Added `GET /api/projects/{id}/git_info`, `POST /api/projects/{id}/git_pull` (`git pull --ff-only` with optional restart and `AUTO_GIT_PULL` flag), and `POST /api/projects/{id}/git_rollback` to safely roll back to recent commits.
- **Local File Version History (No Git Required):** Automatic snapshots (up to 12 per file) before editor saves via `GET /api/projects/{id}/files/snapshots` and `POST /api/projects/{id}/files/restore_snapshot`.
- **Cascading Service Dependencies (`DEPENDS_ON`) & Peak RSS Telemetry:** Automatic dependency startup with cycle protection, plus `peak_rss_mb` tracking per active run.
- **Batch Fleet Actions, Project Group Tags & Production Mode:** Added `POST /api/projects/batch_action`, editable `PROJECT_GROUP` tags with presets for dashboard filtering, and a clean Production mode toggle.
- **Multi-Channel Alerts, Maintenance Mute & Webhooks Inspector:** Added Discord and Slack webhook delivery, `POST /api/settings/maintenance` alert muting, webhook payload forwarding (`BEACON_WEBHOOK_PAYLOAD`), recent webhook call history (`GET /api/projects/{id}/webhooks`), and 1-click webhook test trigger.
- **Logs & Scheduling UX:** Added log level filter (`All / WARN+ERROR / ERROR`) preserving stack traces, `.env` bulk paste with automatic secret vault migration hints, AI token permission presets, schedule presets, and live next-run preview.

### Observability, Analytics & Infrastructure
- **Cross-Project Log Search (`GET /api/logs/search`):** Tail-bounded (256 KB/file) search across all projects with secret redaction, level filter, and 1-click jump to matching project.
- **Project SLA & Reliability Analytics (`GET /api/analytics/summary`):** 24h / 7d / 30d fleet SLA %, failure/OOM counters, average duration, peak RSS, and 10-bar visual run strip.
- **Prometheus / OpenMetrics Export (`GET /api/metrics`):** Authenticated via session (`viewer+`) or read-only AI Bearer token, plus live metrics preview and copyable `prometheus.yml` snippet in Settings.
- **Audit Log Export (`GET /api/system/audit/export`):** Admin-only CSV (with CSV Formula Injection protection) and JSON export.
- **Host Port Map (`GET /api/system/ports`):** Scans listening TCP sockets (`psutil` + `/proc/net/tcp{,6}` fallback), identifies Beacon/project/external owners, flags port conflicts, and suggests the next free port.
- **Live PGID Process Tree Inspector (`GET /api/projects/{id}/processes`):** Inspects all child processes/workers inside an active project's PGID with root badge, PPID, RSS, and redacted command line.
- **Reverse Proxy Config Generator:** Built-in Nginx (HTTP/WS/SSE), Caddy (Auto-TLS), and Cloudflare Tunnel (`cloudflared`) config generator inside Web/API project settings.

## [2.2.0] - 2026-11-04

### Security & Core Supervisor
- **Default Password & Local Network Guard:** Kept `admin` as the initial password (configurable in Settings with a minimum length of 8 characters for any new password). Removed plaintext password files on disk. While `admin` is active, a warning banner is shown, `beacon doctor` reports a warning, login is restricted to loopback and RFC1918 private networks (`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`), and AI access is locked off.
- **Strict Privilege Drop (`_preexec`):** Failures in `getpwnam`/`setgroups`/`setgid`/`setuid` write the error reason to the startup log and exit immediately with code `126`.
- **HTTP Server & Trusted Proxies:** Enforced a 50 MB body size limit (`413`), multipart limit, and connection concurrency limit. `X-Forwarded-For` is trusted only when the direct connection comes from `trusted_proxies`, reading the rightmost non-trusted IP.
- **Security Headers & Single-Use Stream Tickets:** Added `Content-Security-Policy` (local assets only), `X-Frame-Options: DENY` (disabled only in `BEACON_PREVIEW_MODE=1`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `SameSite=Lax` cookies (`beacon_session`; `SameSite=None; Secure` when `BEACON_PREVIEW_MODE=1` over HTTPS). Replaced query-string tokens on SSE streams with single-use short-lived tickets (`POST /api/auth/stream_ticket`). Extended CSRF verification to `POST`, `PUT`, `PATCH`, and `DELETE`. Masked internal `500` errors behind a server-logged `error_id`.
- **ZIP Archive Hardening:** Added streaming ZIP extraction (`safe_extract_zip_file`) enforcing archive size, uncompressed total size, file count, and compression ratio limits.

### Built-in AI Access (MCP `/mcp` & REST `/api/v1/`)
- **Streamable HTTP MCP Server (`/mcp`):** Added 18 MCP tools with annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), MCP resources (`project://{name}/logs/latest`, `project://{name}/files/AGENTS.md`), and MCP prompts (`debug_failed_project`, `create_telegram_bot`, `optimize_memory_limits`).
- **Scoped AI Tokens & Approval Queue:** Added `ai_tokens` (storing only `SHA-256` hashes), `ai_approvals` (human-in-the-loop approval queue with unified diff), `ai_audit_log`, and a global «Pause AI» kill-switch in the UI header and CLI (`python3 -m beacon ai-pause`).
- **Prompt Injection Defense:** Wrapped log and file outputs for AI in `<untrusted_content>` tags after secret redaction (`***SECRET:<name>***` and regex token scrubbers).

### Supervisor & Platform Capabilities
- Added crash-loop protection (`crash_loop` status), Dead Man's Switch (`GET/POST /api/ping/{project}`), `project.yaml` Config-as-Code sync, project `.zip` export/import, RBAC roles (`viewer`, `operator`, `admin`), project chaining (`on_success_project_id`), launch parameters schema, and Safe Mode (`--safe-mode`).
- **2-Click Backup Upload & Restore (Server Migration):** Added `GET /api/system/backups_list` and `POST /api/system/restore_backup` endpoints + Web UI in Settings so users can upload a `.zip` backup or restore from `data/backups/` with automatic pre-restore safety snapshot (`beacon_pre_restore_<ts>.zip`) and SQLite `PRAGMA integrity_check`.
- **In-Panel Self-Update:** Added `GET /api/system/update_status` and `POST /api/system/update_run` + header update modal to check `origin/main` and run `scripts/update.sh` with automatic rollback on healthcheck failure.
- **Full Bilingual Localization (EN / RU):** Added instant `RU | EN` language switcher covering the entire interface, plus bilingual `README.md` (English) and `README.ru.md` (Russian).
- **Canonical Naming & Automatic Migration:** Removed legacy wrappers (`aruta`, `hub` SDK shims) and added automatic one-time migration (`migrate_legacy_installation`) on `python3 -m beacon migrate`.

