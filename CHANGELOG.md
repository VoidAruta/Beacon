# Changelog

All notable changes to **Beacon** are documented in this file.

## [2.2.0] - 2026-11-04

### Security & Core Supervisor
- **Default Password & Local Network Guard:** Kept `admin` as the initial password (configurable in Settings with a minimum length of 8 characters for any new password). Removed plaintext password files on disk. While `admin` is active, a warning banner is shown, `beacon doctor` reports a warning, login is restricted to loopback and RFC1918 private networks (`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`), and AI access is locked off.
- **Strict Privilege Drop (`_preexec`):** Failures in `getpwnam`/`setgroups`/`setgid`/`setuid` write the error reason to the startup log and exit immediately with code `126`.
- **HTTP Server & Trusted Proxies:** Enforced a 50 MB body size limit (`413`), multipart limit, and connection concurrency limit. `X-Forwarded-For` is trusted only when the direct connection comes from `trusted_proxies`, reading the rightmost non-trusted IP.
- **Security Headers & Single-Use Stream Tickets:** Added `Content-Security-Policy` (local assets only), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `SameSite=Strict` cookies (`beacon_session`). Replaced query-string tokens on SSE streams with single-use short-lived tickets (`POST /api/auth/stream_ticket`). Extended CSRF verification to `POST`, `PUT`, `PATCH`, and `DELETE`. Masked internal `500` errors behind a server-logged `error_id`.
- **ZIP Archive Hardening:** Added streaming ZIP extraction (`safe_extract_zip_bytes`) enforcing archive size, uncompressed total size, file count, and compression ratio limits.

### Built-in AI Access (MCP `/mcp` & REST `/api/v1/`)
- **Streamable HTTP MCP Server (`/mcp`):** Added 17 MCP tools with annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), MCP resources (`beacon://system/overview`, `beacon://projects`, `beacon://project/{id}/status`, `beacon://project/{id}/logs/recent`), and MCP prompts (`diagnose_failing_project`, `safe_deploy_change`, `cleanup_low_disk`, `optimize_ram_for_android`).
- **Scoped AI Tokens & Approval Queue:** Added `ai_tokens` (storing only `SHA-256` hashes), `ai_approvals` (human-in-the-loop approval queue with unified diff), `ai_audit_log`, and a global «Pause AI» kill-switch in the UI header and CLI (`python3 -m beacon ai-pause`).
- **Prompt Injection Defense:** Wrapped log and file outputs for AI in `<untrusted_content>` tags after secret redaction (`[REDACTED]`).

### Supervisor & Platform Capabilities
- Added crash-loop protection (`crash_loop` status), Dead Man's Switch (`GET/POST /api/ping/{project}`), `project.yaml` Config-as-Code sync, project `.zip` export/import, RBAC roles (`viewer`, `operator`, `admin`), project chaining (`on_success_project_id`), launch parameters schema, and Safe Mode (`--safe-mode`).
