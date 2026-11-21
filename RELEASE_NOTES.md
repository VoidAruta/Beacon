# Beacon v2.4.1 — Release Notes

## Overview

**Beacon v2.4.1** is a focused performance, stability, and security hardening release driven by full end-to-end stress testing against a live Beacon instance, its built-in Streamable HTTP MCP server (`/mcp`), and a real Chromium browser under sustained high-throughput workloads.

This release eliminates panel RAM inflation and SQLite file descriptor leaks under authentication and background workloads, unblocks the asyncio event loop during `.venv` creation and cross-project log search, hardens secret redaction and prompt-injection escaping across logs and MCP, prevents browser main-thread freezes during extreme console log floods (`5,500+ lines/s`), and tightens supervisor OOM and boot autostart behavior — while preserving all core architectural invariants (`PGID` isolation, direct `buffering=0` log FDs without `SIGPIPE`, orphan re-attach, PGID RSS accounting without `RLIMIT_AS`, and `< 80 MB` idle panel RAM).

---

## ⚡ Memory, SQLite WAL & Event-Loop Performance

- **Dedicated Single-Thread `scrypt` Executor + `malloc_trim(0)` (`hub/executors.py`, `hub/api/routes_ui.py`):**
  - Unified all password hashing and verification calls (`verify_password`, `hash_password`, and constant-time `verify_dummy_password` for nonexistent usernames) onto a single-threaded `ThreadPoolExecutor(max_workers=1)` with `libc.malloc_trim(0)` on Linux.
  - Added `MALLOC_ARENA_MAX=2` defaults to `scripts/zstart_line.sh` and `scripts/beacon.service.template`, preventing glibc per-thread arena retention after authentication bursts and keeping panel RSS comfortably around `38–48 MB`.
- **Bounded IO Executor for `.venv` Creation, Log Search & Disk Maintenance (`hub/executors.py`, `hub/api/routes_ui.py`, `hub/api/routes_ai.py`, `hub/disk_guard.py`):**
  - Offloaded project template / `.venv` bootstrapping (both Web UI and MCP `create_project_from_template`), `/api/logs/search` disk scanning, and `disk_guard` maintenance onto an explicit `ThreadPoolExecutor(max_workers=2)` via `loop.run_in_executor`.
  - Eliminated the `N+1` database query in `/api/logs/search` by replacing per-project run lookups with a single SQL `JOIN`.
- **Zero Worker-Thread SQLite FD Leaks & Faster WAL Truncation (`hub/db.py`, `hub/api/routes_internal.py`):**
  - `db_session()` now closes worker-thread SQLite connections upon exiting the outermost transaction while keeping the main-thread persistent connection intact, eliminating leaked `hub.db` / `hub.db-wal` file descriptor pairs.
  - Lowered automatic `checkpoint_wal(TRUNCATE)` threshold from `4.0 MB` to `2.0 MB`.
  - Consolidated `beacon.state.set()` (`PUT /internal/kv/{key}`) existence checks, 1,000-key quota enforcement, and `UPSERT` into a single atomic SQLite transaction.

---

## 🖥️ Console SSE Streaming & Web UI Reliability

- **Flood-Resilient SSE Log Streaming (`hub/api/routes_ui.py`, `src/components/ProjectsWorkspace.tsx`, `src/utils/hubLogic.ts`):**
  - Capped server-side SSE log reads to `64 KB` per tick, added backlog skipping when unread output exceeds `512 KB` (jumping to the latest `256 KB` with a clear marker), offloaded redaction of chunks `>= 16 KB` to the IO executor, and emitted an explicit `"eof": true` marker on terminal run status events.
  - Added `100 ms` SSE chunk batching, `requestAnimationFrame`-coalesced scrolling, single-pass `useMemo` log-level filtering, and bounded console buffering (`trimConsoleBuffer`: `2,500` lines / `384 KB`) so sustained `5,500+ lines/s` floods no longer freeze the browser tab.
  - Closed `EventSource` cleanly on terminal status / `eof` without triggering infinite fallback `GET /api/runs/{id}/log` polling.
- **Race-Free Project Switching in Code Editor (`src/components/ProjectsWorkspace.tsx`):**
  - Guarded file loads with `activeProjectIdRef` and a monotonic `fileLoadSeqRef`, clearing stale file state immediately on project switch so rapid switching never renders a previous project's code.
- **Non-Overlapping Toast Placement (`src/App.tsx`):**
  - Moved the global Toast notification to top-center (`data-testid="global-toast"`) so it no longer covers action buttons in `ProjectsWorkspace` or `DashboardView`.

---

## 🛡️ Supervisor, OOM Handling & Boot Autostart

- **Non-Blocking OOM Enforcement & Accurate Exit Codes (`hub/process_mgr.py`):**
  - Dispatched OOM kills asynchronously via tracked background tasks (`grace_sec=1.0`, guarded against duplicate stops) so the process watcher loop stays responsive across the entire fleet.
  - Recorded the real `-9` exit code when `SIGTERM` escalates to `SIGKILL`, and set `desired_state = 'stopped'` on `killed_oom` when `restart_policy == 'no'`.
- **Orphan-Aware Boot Autostart (`hub/scheduler.py`):**
  - `autostart_services_on_boot()` now skips already-running recovered orphans before waiting on `autostart_stagger_sec` and re-queries the project row after each stagger delay so projects deleted or stopped mid-boot are never mistakenly restarted.
- **Canonical Database Path Documentation (`AGENTS.md`):**
  - Aligned the documented SQLite database path with the runtime path `data/hub.db`.

---

## 🔐 Secret Redaction, Anti-Oracle Log Search & MCP Security

- **Expanded Secret & Credential Redaction (`hub/secrets_mgr.py`):**
  - Redacts URL userinfo credentials (`scheme://user:pass@host`), sensitive CLI flags (`--password`, `--api-key`, `--token`, etc.), small UTF-8 `file`-type secret contents (`<= 64 KB`, including `.env` key-value RHS entries), and `SECRETS_DIR` filesystem paths (`***SECRETS_DIR***`).
- **Anti-Oracle Cross-Project Log Search (`hub/api/routes_ui.py`):**
  - `/api/logs/search` strictly applies `redact_log_text()` to each `256 KB` log chunk **before** performing substring/regex matching inside the IO worker thread, ensuring raw secret queries return `0` matches and cannot be used to probe for secret presence.
- **Hardened MCP `<untrusted_content>` Escaping (`hub/api/routes_ai.py`):**
  - Tightened closing-tag escaping to block whitespace-bypass variants such as `< /untrusted_content>`.

---

## 📊 Benchmarks: Before vs. After (Live Stand + Real Chromium)

Measured on an isolated Beacon stand (`MALLOC_ARENA_MAX=2`) under concurrent MCP `.venv` creation, 5 concurrent `beacon.state` KV workers (`3,000+` operations), parallel `/api/metrics`, `/api/analytics/summary`, and `/api/logs/search` traffic, and a live `5,500 lines/s × 15s` console flood in headless Chromium:

| Metric | Beacon v2.4.0 (Before) | Beacon v2.4.1 (After) |
|---|---|---|
| Panel RSS after 10 logins (incl. dummy-password & password change) | ~107.6 MB | **38.1 MB** (`-65%`) |
| Panel RSS after full stress (MCP `.venv`, 5 KV workers, 15s SSE flood) | >105 MB | **47.5 MB** (`< 80 MB` budget) |
| Open FDs / `hub.db*` handles after background tasks | Growing per-thread FD leaks | **11–14 FDs / 4–5 `hub.db*`** (stable) |
| MCP `list_projects` latency during 6 concurrent Python `.venv` creates | 1,428 ms peak stall | **4.6 ms p50 / 8.0 ms max** |
| `/api/metrics` & `/api/analytics/summary` p50 under 5 KV workers + log search | ~315 ms | **25.4 ms / 27.1 ms** (`0` SQLite/HTTP errors) |
| `hub.db-wal` auto-truncation after 3,000+ KV ops | Unbounded growth between runs | **Truncated automatically (`4.0 MB → 8.1 KB`)** |
| Browser console flood (`5,500 lines/s × 15s`) frame time (`p50` / `max` / `>500ms`) | ~3,100+ ms tab freeze | **16.7 ms p50 (60 FPS) / 166.7 ms max / 0 freezes** |
| Peak `<pre>` DOM size during flood | >6 MB unbounded | **2,501 lines / 193 KB** (capped) |
| Post-completion fallback `GET /api/runs/{id}/log` polls (6s window) | Infinite polling loop | **0 requests** |
| Global Toast overlap with `ProjectsWorkspace` buttons | Overlapped bottom-right controls | **0 overlaps** (top-center) |

---

## ✅ Verification & Quality Assurance

- **Python Test Suite (`python3 -m unittest discover -s tests -v`):** `62 / 62` passing (including new regression tests for extended secret redaction, `< /untrusted_content>` escaping, `/api/logs/search` anti-oracle behavior, and orphan-aware boot autostart).
- **TypeScript Unit Tests (`npx tsx --test src/utils/hubLogic.test.ts`):** `22 / 22` passing (including `trimConsoleBuffer` and `isTerminalRunStatus`).
- **Build, Typecheck & Shell Lint:** `tsc --noEmit`, `vite build`, and `bash -n scripts/install.sh scripts/update.sh scripts/zstart_line.sh` — all clean with `0` errors.
- **Live E2E & Browser Verification:** Validated end-to-end on an isolated Beacon instance and real Chromium (Playwright) with `0` runtime console errors.

---

## 🚀 Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/VoidAruta/Beacon/main/scripts/install.sh | bash
```

Or run manually from a cloned repository:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
MALLOC_ARENA_MAX=2 python3 -m beacon --port 8050
```

---

## 🔄 How to Update

From the Web UI: click **`v2.4`** in the sidebar → **Check for Updates** → **Update Panel**.

Or from the terminal:

```bash
bash scripts/update.sh
```
