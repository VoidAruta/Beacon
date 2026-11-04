# Changelog

All notable changes to **Aruta (Hub ControlPanel)** are documented in this file.

## [2.2.0] - 2026-11-04

### Phase A — Critical Security Hardening & Renaming (`aruta` + `hub` Compatibility)
- **Default Password Policy:** Kept `admin` as the initial default password (configurable in Settings with a unified minimum length of 8 characters for any new password). Removed `data/initial_password` and all plaintext password disk writes. Removed `initial_password_file` from `/api/auth/me`. While default password `admin` is active, a persistent yellow banner is displayed, `doctor` reports a warning, login is restricted to loopback and RFC1918 private networks (`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`), and AI access is locked off.
- **Privilege Drop Hardening (`_preexec`):** Failures in `setgroups`/`setgid`/`setuid` no longer fail silently; child processes now write the error reason to the startup log and exit immediately with code `126`. Defaults `run_as_user` to `hub-runner` when that user exists on the system.
- **HTTP Server & Proxy Spoofing Protection:** Added 50 MB body size limit (`413`), multipart limit, and connection concurrency limit. `X-Forwarded-For` is now trusted only when the direct connection comes from `trusted_proxies`, reading the rightmost non-trusted IP.
- **Security Headers & Single-Use Stream Tickets:** Added `Content-Security-Policy` (local fonts only), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `SameSite=Strict` cookies (`aruta_session` / `hub_session`). Replaced `?session_token=` query param on SSE streams with single-use short-lived tickets (`POST /api/auth/stream_ticket`). Extended CSRF verification to `POST`, `PUT`, `PATCH`, and `DELETE`. Masked internal `500` errors behind a server-logged `error_id`.
- **ZIP Bomb & Path Traversal Defense:** Added streaming ZIP extraction (`safe_extract_zip_bytes`) enforcing archive size, uncompressed total size, file count, and compression ratio limits.
- **Default Subnets & Configurable Ports:** Removed `100.64.0.0/10` from default `ALLOWED_SUBNETS` and added an explicit `allow_tailscale` setting toggle. Replaced hardcoded `FORBIDDEN_PORTS` and default proxy URL with configurable `reserved_ports` and empty default proxy.
- **Brand & CLI Alias (`aruta` / `hub`):** Added `python -m aruta` (`doctor`, `ai-pause`, `migrate`, `systemd`), `import aruta` SDK (with `import hub` alias emitting `DeprecationWarning`), `ARUTA_*` env vars (with `HUB_*` fallback), and `aruta_session` cookie.

### Phase B — Built-in AI Access (MCP `/mcp` & REST `/api/v1/`)
- **Streamable HTTP MCP Server (`/mcp`):** Added 17 MCP tools with `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`), MCP resources (`project://{name}/manifest`, `project://{name}/readme`, `aruta://docs/sdk`, `aruta://system/health`), and MCP prompts (`diagnose_failed_run`, `create_bot_project`, `review_project_code`).
- **Scoped AI Tokens & Approval Queue:** Added `ai_tokens` (storing only `SHA-256` hashes), `ai_approvals` (human-in-the-loop approval queue with unified diff for `write_file`), `ai_audit_log`, and a global «Pause AI» kill-switch in the UI header, Telegram bot (`/ai_pause`), and CLI (`aruta ai-pause`).
- **Prompt Injection Defense:** Wrapped log outputs for AI in `<untrusted_content>` tags after secret redaction (`[REDACTED]`), blocked secret values from ever being read by AI tokens, and excluded any arbitrary `exec` tool.
- **Auto-Generated `AGENTS.md`:** Automatically generated `AGENTS.md` inside project directories and documented MCP/REST integration in `docs/AI-ACCESS.md`.

### Phase C — Repository Cleanup & Portability
- Removed AI Studio artifact files (`.env.example`, `server.ts`, `hub/static/assets/aistudio/*`, legacy `hub/static/app.js` and `hub/static/style.css`) and unused Node dependencies (`express`, `dotenv`).
- Replaced external Google Fonts with local/system font stacks so the UI operates 100% offline in LAN/air-gapped environments.
- Hardened `scripts/aruta.service` / `scripts/hub.service`, `Dockerfile` (multi-stage build), `docker-compose.yml`, and `.github/workflows/ci.yml`.

### Phase D — Competitive Supervisor Features
- Added crash-loop protection (`min_uptime_sec`, `max_restarts`, `restart_delay_sec`, `cron_restart`, `crash_loop` status), Dead Man's Switch (`GET/POST /api/ping/{project}` & `outbound_heartbeat_url`), `project.yaml` Config-as-Code sync, project `.zip` export/import (without secret values), RBAC roles (`viewer`, `operator`, `admin`), project chaining (`on_success_project_id`), and Safe Mode (`--safe-mode`).
