# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Web is a web-based interface for the Claude Code CLI, giving it browser-based access with multi-session support and real-time streaming. It renders a real terminal via xterm.js and streams a PTY over WebSocket. Node.js, CommonJS, **no build step**: `src/` runs directly. The frontend is dependency-free — xterm and fonts are vendored under `src/public/vendor/`.

## Common Commands

```bash
# Install dependencies (Node >= 16)
npm install

# Start dev server (extra logging) — dev instance runs on port 32353 by convention
npm run dev -- --port 32353

# Start production/stable server — defaults to port 32352
npm start

# Auth / HTTPS
npm start -- --auth your-token
npm start -- --https --cert cert.pem --key key.pem

# Run the test suite (Mocha + node:assert)
npm test

# Run a single test file
npx mocha test/session-store.test.js

# Run a single test by name
npx mocha test/*.test.js --grep "persistence"
```

Default port is **32352**. Local convention: the **stable** instance runs on **32352** (a live user session — don't edit/restart it) and the **dev** instance on **32353** (edit here). Full flag list lives in `bin/cc-web.js` (`--claude-alias`, `--ngrok-auth-token`/`--ngrok-domain`, `--plans-dir`, `--disable-auth`).

## Architecture

Request flow: browser (`src/public/app.js`) ⇄ WebSocket ⇄ `src/server.js` ⇄ `claude-bridge.js` ⇄ node-pty child process running the Claude CLI. Terminal bytes flow through untouched in both directions; the server multiplexes many browsers onto shared server-side sessions.

### Server (`src/server.js`)
Single `ClaudeCodeWebServer` class. Owns the Express app (REST under `/api/*`), the `ws` WebSocket server, session lifecycle, folder-mode working-directory selection, auth middleware + rate limiting, and image upload (`/api/upload-image`). Sessions persist via `SessionStore` to `~/.claude-code-web/sessions.json` and auto-save every 30s, so they survive server restarts and are reachable from multiple devices simultaneously.

### Agent bridge
`claude-bridge.js` discovers the Claude binary across standard paths (falling back to a bare `claude` on PATH), spawns it under node-pty, and manages start/stop/resize plus an output buffer for reconnect. The WebSocket `start_claude` message launches it. Launch options from the browser are exactly four keys — `model`, `permissionMode`, `effort`, `dangerouslySkipPermissions` — picked by name in `server.startClaude` and placed before the server's own fields (they used to be spread last, which let a client replace `workingDir` or `hookScript`). `ClaudeBridge.launchArgs` turns them into flags against the whitelists `MODELS` / `PERMISSION_MODES` / `EFFORTS`; `test/claude-bridge.test.js` checks those against the installed `claude --help`, so a CLI upgrade that renames a mode fails a test instead of a tab. The tab name is passed as `--name=<name>` (prompt box, terminal title, and the conversation's `custom-title`) **only when a person typed it** — `session.nameIsCustom`, set by a typed name in the new tab dialog (`customName` on `POST /api/sessions/create`) or a rename (`PATCH /api/sessions/:id`), persisted in sessions.json. Measured on 2.1.278: with `--name` set Claude writes no `ai-title`, so passing a derived name (folder name, a conversation's clipped title) would freeze the title at that. A rename takes effect on the next start/resume; a running Claude is not renamed. In the terminal, Ctrl+Enter sends Ctrl+X Ctrl+S — Claude's "send now" (interrupt the turn, send the queued messages; 2.1.275+), which xterm cannot express as Ctrl+Enter since it sends `\r` for every Enter chord. Codex and cursor-agent support was removed in 3.21.0 — this is a Claude-only tool now, so there is no multi-CLI abstraction to keep in sync.

### Client (`src/public/`, plain ES, no framework)
- `app.js` — main controller: terminal setup, WebSocket, input handling
- `session-manager.js` — session tab UI, notifications, multi-session switching
- `splits.js` — split-pane / multi-terminal layout
- `claude-title.js` — reads Claude's terminal title (OSC 0): a leading ◐/◑ means working, ✳ idle, the rest is Claude's topic for the task (2.1.278). Every view's `onTitleChange` — background tabs and split panes included — calls `sessionTabManager.setTabWorking`, which sets `data-working` on the tab (an attribute, because `updateTabStatus` rewrites the dot's className wholesale) and adds the topic to the tooltip; the CSS turns the dot into a spinning half-filled ball. `exit` / `claude_stopped` clear it, since the last title before a stop can still be ◐. Only the visible view still sets `document.title`.
- `file-explorer.js` — read-only file/folder explorer (`window.fileExplorer`), opened by the toolbar folder button (replaced the old Settings gear; Settings stays in the hamburger menu)
- Plan mode approval UI — the modal is driven by structured Claude Code hook events (see below), not by scraping terminal output
- `auth.js` — client-side auth
- `service-worker.js` + `manifest.json` — PWA/offline support
- `icons.js` / `icon-generator.js` — runtime-generated app icons

### WebSocket protocol
Session control: `create_session`, `join_session`, `leave_session`, `close_session`, `stop`. CLI launch: `start_claude`. I/O: `input`, `resize`, `pause`/`resume` (flow control), `ping`. Server→client: `output`, `exit`, `error`, `hook_event`, … See the `switch (data.type)` dispatch in `src/server.js` (~line 746).

### Plan mode via Claude Code hooks
Claude presents a plan by calling the `ExitPlanMode` tool, which fires a `PreToolUse` hook carrying the full plan in `tool_input.plan`. `claude-bridge.js` injects that hook into the spawned CLI via `--settings` (`buildInjectedSettings`), pointing its command at `bin/cc-hook.js`. That relay reads the event JSON on stdin and POSTs it to `POST /api/hooks/:sessionId` (authenticated with a per-session `hookToken`, loopback-only, registered *before* the global auth middleware). The server rebroadcasts it to the session's browsers as a `hook_event`, and `app.js` opens the plan modal. This replaced the old brittle terminal-scraping `plan-detector.js`, which had silently stopped detecting plans on current Claude versions (markdown is rendered to styled ANSI, so the raw `##`/`###` markers no longer appear in the byte stream). The relay is best-effort: any failure exits 0 so a hook never blocks Claude.

## Conventions

- **Style**: 2-space indent, semicolons, single quotes. kebab-case filenames, PascalCase classes, camelCase functions/vars. No linter/formatter configured — match surrounding code and keep diffs minimal.
- **Tests**: Mocha with `node:assert` in `test/*.test.js`. Keep them fast and isolated — mock process spawns, use temp dirs (see `session-store.test.js`), no network or real CLI calls.
- **Commits/releases**: Conventional Commits (`feat:`, `fix:`, `chore(release): vX.Y.Z`). Releases bump the version in `package.json` + `CHANGELOG.md`, tag, and open a PR — see `scripts/release-pr.sh` (`npm run release:pr`) and `.cursor/commands/commit-push.md`.
- **Docs**: `DESIGN.md` (design rationale), `CHANGELOG.md`, `docs/` (terminal-parity upgrade notes). Update README/docs when flags, routes, or defaults change.

## Key implementation details

- Claude CLI discovery tries multiple paths including `~/.claude/local/claude`, falling back to a bare `claude` on PATH.
- Output buffer keeps the last ~1000 lines per session for reconnection replay.
- Terminal is `xterm-256color` with full ANSI + WebGL/canvas rendering addons.
- Folder browser restricts access to the base directory and its subdirectories only (path-traversal guarded); auth is on by default with per-IP rate limiting. REST routes authenticate via the `Authorization` header only (no query token — it would leak into logs/history); the WebSocket still authenticates with a query token because browsers can't set headers on a WS.
- `GET /api/plan` serves a development-plan markdown file so the terminal's plan links (`registerPlanLinks` in `splits.js`) can open it in a new tab. It's the same browser-navigation exception as the WebSocket, so it authenticates with a token in the URL (not a header). Two URL forms hit the same `servePlanFile`:
  - **Session-scoped path form** (what the client builds): `/api/plan/<token>/<sessionId>/<percent-encoded-path>` — the plan path is one segment (slashes as `%2F`) so the URL *ends in `.md`* with no query string. Browser Markdown extensions (Markdown Reader etc.) trigger on URLs ending in `.md`, so this makes them render the plan. `-` is a placeholder for token (no-auth) or session (none).
  - **2-segment path form** (backward-compatible): `/api/plan/<token>/<path>` — no session, falls back to all active sessions' roots.
  - **Query form** (backward-compatible): `/api/plan?path=&token=`.

  The response is `Content-Type: text/plain` (not `text/markdown`: Chrome has no native markdown viewer and would *download* `text/markdown` instead of rendering a page the extension can transform). The resolved real path is strictly allow-listed and always realpath'd (so symlinks/`..` can't escape) and capped at 2 MB `.md`. The allow-list is the **union** of:
  - **Auto roots** (always on): a `.md` under a `.claude/plans/` directory inside the base folder or the request's session working dir (or every active session, for the session-less forms) — so the current project's plans open automatically.
  - **Global plan dirs** (shared base for all sessions): any `.md` under a directory seeded from `--plans-dir <paths>` (comma-separated) / env `CCW_PLANS_DIR` (persisted to `<dataDir>/plan-dirs.json`, which wins over the flag seed at startup). The `.claude/plans/` segment isn't required.
  - **Per-session plan dirs**: `session.planDirs` — extra dirs registered for *that session only*, edited live from Settings via `GET /api/plan-dirs?sessionId=` / `POST /api/plan-dirs {sessionId, dirs}` (header auth; POST validates each is a real directory, dedupes, and persists with the session in `sessions.json`). `POST` only registers directories to the allow-list; reads still go through `servePlanFile`'s realpath check.

  Non-ASCII (e.g. Chinese) plan names use an RFC 5987 `filename*` header — a raw non-latin1 header value throws.
- **Continuing an existing Claude conversation.** A new tab can either start empty or pick up one of the conversations Claude has already recorded for the chosen folder. `GET /api/claude-sessions?dir=` (header auth) lists them from `~/.claude/projects/<encoded-dir>/<uuid>.jsonl` — newest first, capped at 50, title taken from a `custom-title` record (`customTitle` — written by `/rename` and by `claude --name`) else Claude's own `ai-title` record (`aiTitle`; rewritten as the conversation goes, so the LAST one in the file's final 128 KB wins; Claude stopped writing `summary` records by 2.1.278), else a `summary` line or the first real user prompt in the file's first 128 KB (`src/utils/claude-history.js`; the directory-name encoding is "every non-alphanumeric becomes `-`", with a fallback that matches the `cwd` recorded inside a transcript). `POST /api/sessions/create` accepts `resumeId`: the new session takes **that uuid as its own id**, because the cc-web session id *is* the Claude conversation id (`--session-id` on the first start, `--resume` after). It is created with `claudeStarted` already true, so the first start resumes it and every later one — a server restart included — resumes it again. Two guards: one conversation may only be open in one tab (the list greys the others out, the server answers 409 with the id to switch to), and a session flagged `resumedConversation` passes `allowFreshFallback: false` to the bridge, so a failed `--resume` reports the failure in the terminal instead of silently becoming a new empty conversation under that id. Deleting a tab never deletes the transcript, so a closed conversation can be picked up again later. UI: `src/public/conversations.js` owns **one** panel — *Sessions* (every cc-web session: click to switch, or to open it as a tab if this browser has none; trash deletes it) followed by *Conversations in this folder* (the transcripts no session holds). Both the toolbar button (`#historyBtn` → `#conversationsModal`) and the menu's Sessions modal (`#mobileSessionList`) render it, so the two lists cannot disagree — they used to be separate renderers, and a session that had never started Claude was missing from one while a closed conversation was missing from the other. The new tab dialog's "继续之前的对话" picker is the same rows via `renderPicker` (history only, click = select).
- **New tab dialog** (`#newTabModal`, `openNewTabDialog` / `createNewSession` in `app.js`). Every "new" entry point — the tab bar's `+`, Ctrl+T, the Sessions panel and mobile menu's New Session, the restore dialog, first run, `ensureProjectFolder` — opens this one dialog, which replaced a chain of three (folder browser → Create New Session → the Start Claude prompt). It arrives prefilled: the folder is the active tab's (else the most recent usable one from open tabs + `localStorage` `cc-web-recent-dirs`), the name follows the folder or the picked conversation unless typed, and model / permission mode come from `cc-web-last-start-options` (skipping permissions is never remembered). The folder controls kept their old ids, so `loadFolders` / `renderFolders` / `createFolder` drive the dialog's tree unchanged. 启动 refuses a non-project folder (`nonProjectDirReason`) inline, creates the session via `requestSession`, and sets `pendingStart` **before** `attachSessionTab`, so `session_joined` starts Claude instead of raising the Start prompt. `#startPrompt` remains for restarting a stopped session and is what a cancelled dialog leaves up when no tab exists. Guards are pinned in `test/new-tab-dialog.test.js`.
- **Per-session config.** Config is scoped to the active session (tab). *Visual* settings (font size, theme, scroll animation) live client-side in `localStorage` keyed by sessionId (`cc-web-session-settings`), so each session/device has its own; a new session inherits the global default `cc-web-settings` (updated to the latest saved settings). `applySessionVisuals(sessionId)` re-applies them live on session activation — theme switches **without a page reload** (`applyTheme` flips `data-theme` and re-themes every xterm; the old reload-on-theme-change is gone). *Plan dirs* are server-side per session (`session.planDirs`, above). Known limit: with splits, visual settings follow the active session (theme is app-wide CSS chrome, not per-pane).
- **File explorer** (`file-explorer.js` + `GET /api/fs/list` / `GET /api/fs/file`). `listDirectory` (`/api/fs/list?path=&hidden=`) returns files *and* folders (folders first, with size) for a read-only Explorer-style browser; normal header auth. It caps the listing at 2000 entries (`truncated: true` when clipped) and stats size only for that capped slice, so a huge directory can't freeze the shared single-threaded server with 10k+ sync stat calls. `serveFile` (`/api/fs/file/:token/:file`) serves a file's bytes so the explorer can open it in a new tab — a browser-nav token exception like `/api/plan`, registered before the global auth middleware, path form so the URL ends in the real extension. Content-Type is picked by extension (`contentTypeForFile`). **`.svg`/`.html` are served as `text/plain` source by default**, and render as their real type *only* when the URL carries a single-use ticket instead of the auth token — because the whole credential sits in the URL path and a rendered page can read its own `location`. `POST /api/fs/ticket {path}` (header auth) mints one: bound to a single realpath, 30s TTL, consumed on first read, so what the page finds in its URL is already spent. A rendered file also gets `renderSandboxCsp`: an opaque origin (`sandbox`, never `allow-same-origin`) *plus* `default-src 'none'` and no `allow-popups`, so its scripts have nowhere to send anything. HTML keeps `allow-scripts` so inlined diagram/chart code still draws (external CDN subresources will not load); SVG gets no `allow-scripts` at all. The ticket rule applies in `--disable-auth` mode too — one rule per mode beats "renders on my box, shows source in production". Files must be a regular file ≤ 10 MB; the realpath is resolved so symlinks are followed to their target. Both plan/file responses go through `sendInlineFile` (nosniff + `Referrer-Policy: no-referrer` so the in-URL token never leaks via Referer + `Cache-Control: no-cache` + RFC 5987 filename). Scope matches the folder browser (`isPathWithinBase` allows any resolvable path — this is a local single-user tool), not a base-subtree jail.
