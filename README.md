# Claude Code Web Interface

A web-based interface for the Claude Code CLI that can be accessed from any browser.
It runs the real CLI in a PTY and streams it to xterm.js over a WebSocket, so what
you get in the browser is the terminal, not a reimplementation of it.

Repository: <https://github.com/yunnet/cc-web>

> **This is not the package published on npm.** `npm i claude-code-web` installs
> [vultuk/claude-code-web](https://github.com/vultuk/claude-code-web) (3.x), the
> upstream this fork came from. Install this one from source — see
> [Installation](#installation).

## Requirements

- Node.js >= 16
- Claude Code CLI installed and available on `PATH` (Codex and cursor-agent support
  was removed in 3.21.0 — this is a Claude-only tool now)
- Modern browser with WebSocket support

## Authentication is on by default

The server generates a random token at startup and prints it. Nothing is reachable
without it:

```bash
npm start
# Look for: "Generated random authentication token: Xr9kM2nQ7w"
# Then open: http://localhost:32352/?token=Xr9kM2nQ7w
```

Use `--disable-auth` to turn it off (local development only).

## Features

- 🌐 **Web-based terminal** — the Claude Code CLI in any browser, bytes passed through untouched
- 🔄 **Multi-session** — one persistent session per tab, each with its own working directory
- 💾 **Session persistence** — sessions survive browser disconnects and server restarts; reconnecting replays the recent output
- 🌍 **Multi-browser** — the same session from several browsers/devices at once
- 🔀 **Split view** — drag a tab to open two or three terminals side by side
- ▶️ **Resume a conversation** — a new tab can pick up any conversation Claude has already recorded for that folder
- 🔔 **Background tab marks** — spinning ball while Claude works, ✓ when a turn ends, amber 待批准 when it wants permission, plus desktop notifications (driven by Claude Code hooks, not by scraping the terminal)
- 📋 **Plan approval modal** — Claude's plan arrives through the `ExitPlanMode` hook and is approved from a dialog
- 🔗 **Clickable links** — Claude runs with `FORCE_HYPERLINK=1`; URLs open in a new tab, plan files and other local files open through the server
- 📂 **File explorer** — browse, open, upload and delete files from the toolbar
- 🌿 **Git branch panel** — current branch per repository, with a fast-forward-only pull button
- 📱 **Mobile support** — responsive layout, ESC/MODE/→ helper bar, PWA install, on-screen tab overflow menu
- 🎛️ **Per-session settings** — font size, theme, scroll animation and plan directories are scoped to the session
- 📜 **Scrollback** — kept in bytes (2 MB default, up to 16 MB), configurable in Settings

The exhaustive, ID-by-ID inventory lives in [`FEATURES.md`](FEATURES.md); the tests in
`test/features.test.js` check it against the code in both directions, so a feature
cannot quietly disappear.

## Installation

### From source (the way to run this fork)

```bash
git clone https://github.com/yunnet/cc-web.git
cd cc-web
npm install
npm start              # or: npm run dev   (extra logging)
```

### As a global command

```bash
cd cc-web
npm install -g .       # installs the `cc-web` binary
cc-web --port 32352
```

## Usage

```bash
# Default settings (port 32352, auto-generated auth token)
npm start

# Custom port
node bin/cc-web.js --port 8080

# Do not open a browser
node bin/cc-web.js --no-open

# Dev mode (verbose logs)
npm run dev
```

### Authentication options

```bash
# Default: a random 10-character token, printed at startup (recommended)
node bin/cc-web.js

# Token from a file (preferred when you want a fixed one)
echo "your-secret-token" > ~/.ccweb-token && chmod 600 ~/.ccweb-token
node bin/cc-web.js --auth-file ~/.ccweb-token

# …or from the environment
CCWEB_AUTH=your-secret-token node bin/cc-web.js

# …or on the command line. This still works, but on a machine with other
# users it is the weakest of the three: /proc/<pid>/cmdline is world-readable,
# so anyone who can log in can read the token out of the running process.
node bin/cc-web.js --auth your-secret-token

# Disable authentication entirely (NOT recommended)
node bin/cc-web.js --disable-auth

# Access with the token in the URL: http://localhost:32352/?token=your-token
```

### HTTPS

```bash
node bin/cc-web.js --https --cert /path/to/cert.pem --key /path/to/key.pem
```

### Public tunnel (ngrok)

Both flags are required; giving only one is an error.

```bash
node bin/cc-web.js --ngrok-auth-token <token> --ngrok-domain <your-domain>
```

### Assistant alias

Changes how the assistant is labelled in the UI (display only — it does not change
which CLI is launched).

```bash
node bin/cc-web.js --claude-alias Alice
# or
CLAUDE_ALIAS=Alice node bin/cc-web.js
```

## Command line options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <number>` | Server port | `32352` |
| `--no-open` | Don't automatically open a browser | opens |
| `--auth <token>` | Custom authentication token — **visible to other users via `/proc`** | auto-generated |
| `--auth-file <path>` | Read the token from a file (first line) — keeps it out of the process image | none |
| `--disable-auth` | Disable authentication (not recommended) | false |
| `--https` | Enable HTTPS (requires cert files) | false |
| `--cert <path>` | SSL certificate file path | none |
| `--key <path>` | SSL private key file path | none |
| `--dev` | Development mode with extra logging | false |
| `--claude-alias <name>` | Display alias for Claude | env `CLAUDE_ALIAS`, else `Claude` |
| `--ngrok-auth-token <token>` | ngrok auth token to open a public tunnel | none |
| `--ngrok-domain <domain>` | ngrok reserved domain for the tunnel | none |
| `--plans-dir <paths>` | Comma-separated extra plan directories served by `/api/plan`, **in addition to** the automatic `.claude/plans` discovery under the base folder and each session's working directory | none |

## Environment variables

| Variable | Description |
|----------|-------------|
| `CCWEB_AUTH` | Authentication token. Beats `--auth`, loses to `--auth-file`. `/proc/<pid>/environ` is readable only by the owner, unlike `cmdline`. |
| `CCW_DATA_DIR` | Where sessions, plan dirs and the instance registry live. Defaults to `~/.claude-code-web`. Point a second instance at another directory to isolate it. |
| `CCW_PLANS_DIR` | Same as `--plans-dir`. If `<data dir>/plan-dirs.json` exists, it wins over the flag at startup — the file is only ever read, never written (`GAP-22`). |
| `CLAUDE_ALIAS` | Same as `--claude-alias`. |

## Sessions

### Creating and managing

- **New tab** — the `+` in the tab bar opens one dialog (folder, name, model, permission
  mode), prefilled from the active tab and your last choices. Every "new session" entry
  point goes through it.
- **Continue a conversation** — the same dialog lists the conversations Claude has already
  recorded for the chosen folder; picking one makes the tab resume it (`--resume`). One
  conversation can only be open in one tab.
- **Sessions panel** — the toolbar's conversation button lists every session on the server
  (click to switch, or to open it as a tab here) followed by the conversations in the
  current folder that no session holds.
- **Leave** disconnects without stopping Claude; **close** stops it and deletes the session.
  Closing a tab never deletes Claude's transcript, so the conversation can be picked up later.

### Persistence

- Sessions stay alive after every browser disconnects, and are restored across server restarts.
- Recent output is replayed on reconnect — by **bytes**, not lines: 2 MB by default,
  256 KB minimum, 16 MB maximum, set in Settings (`GET`/`POST /api/settings/scrollback`).
  The same number drives persistence, replay and the in-memory buffer.
- Several browsers can be attached to one session at the same time.

### Where sessions are kept

One file per session, under the data directory:

```
<data dir>/sessions/<session-id>.json
```

Not a single `sessions.json` — that file was rewritten in full every thirty
seconds, so two servers sharing a data directory would overwrite each other's
sessions with no error. One writer per file removes the shared document, and a
corrupt file now costs one session instead of the whole list.

An existing `sessions.json` is split into per-session files on first run and
then left in place, unmodified.

Closing a session deletes its file. Sessions untouched for more than 7 days are
dropped on load, judged per session.

**Two servers cannot share a data directory.** The second one to start refuses,
naming the instance already there. Give each its own with `CCW_DATA_DIR`.

### Instance registry

Each running server writes `<data dir>/instances/<port>.lock` — the filename is the
port, so listing the directory tells you what is running without opening anything:

```json
{
  "port": 32353,
  "pid": 12345,
  "sourceDir": "/path/to/checkout",
  "dataDir": "/home/you/.claude-code-web-dev",
  "version": "4.3.0",
  "buildId": "f3b4ceee",
  "https": false,
  "startedAt": "2026-09-03T...",
  "authToken": "..."
}
```

The file is created `0600` inside a `0700` directory, because it holds the token.
It is removed on a clean shutdown, and a record left behind by `kill -9` is pruned
by the next instance to start. Writing it is best-effort: if it fails the server
still starts, it just says so.

## Pulling from the branch panel

Each repository in the branch panel has a pull button. It runs
`git pull --ff-only`, so it either moves cleanly forward or does nothing and
says why — a plain pull would build a merge commit when the local branch has
its own work, and real merges belong in a terminal where someone can answer the
questions.

It refuses outright over uncommitted changes, without touching the working tree.
Reasons you may see: `uncommitted changes`, `no upstream`, `needs a merge`,
`timed out`.

`POST /api/git/pull { path, name }` — header auth, and the target must be a git
repository, not merely a readable path, since this is the panel's only write.
The timeout is 60s: eleven real repositories fetch in ~1.6s, but one took over
120s with an identical remote and a 3.5 MB `.git`, and slow is not broken.
On timeout the whole process tree is killed — `git pull` forks `git fetch`,
which forks `git remote-http`, and signalling only the wrapper leaves both
children running.

## How it works

1. **Claude bridge** — `claude-bridge.js` finds the Claude binary, spawns it under
   `node-pty`, and handles start/stop/resize plus the reconnect buffer.
2. **WebSocket** — `server.js` multiplexes many browsers onto shared server-side sessions;
   terminal bytes pass through untouched in both directions.
3. **Terminal** — xterm.js (vendored, no build step) with ANSI, WebGL/canvas renderers,
   OSC 52 clipboard and OSC 8 hyperlinks.
4. **Hooks** — the CLI is launched with an injected `--settings` file whose hooks
   (`PreToolUse`/`ExitPlanMode`, `Notification`, `Stop`, `SessionStart`) POST to
   `/api/hooks/:sessionId` through `bin/cc-hook.js`. That is what drives the plan modal
   and the tab marks; nothing parses terminal output any more.
5. **Persistence** — one file per session, autosaved every 30s.

## API

REST routes authenticate with the `Authorization: Bearer <token>` header. The two
browser-navigation routes (`/api/plan/...`, `/api/fs/file/...`) carry the token in the
URL path instead, because a tab opened by the browser cannot send a header; the
WebSocket authenticates with a query token for the same reason.

### REST

| Route | Purpose |
|-------|---------|
| `GET /` | Web interface |
| `GET /auth-status`, `POST /auth-verify` | Login state and token check |
| `GET /api/health` | Server health |
| `GET /api/config` | Server configuration |
| `GET /api/version` | Installed Claude CLI version vs what npm publishes (display only) |
| `GET /api/sessions/list` | All sessions |
| `GET /api/sessions/persistence` | Persistence info |
| `POST /api/sessions/create` | Create a session (`resumeId` continues a recorded conversation) |
| `GET /api/sessions/:id` | Session details |
| `PATCH /api/sessions/:id` | Rename a session |
| `DELETE /api/sessions/:id` | Delete a session |
| `GET /api/claude-sessions?dir=` | Conversations Claude has recorded for a folder |
| `POST /api/close-session` | Close a session |
| `GET /api/folders`, `POST /api/folders/select` | Folder browser |
| `POST /api/create-folder`, `POST /api/set-working-dir` | Create / choose the working directory |
| `GET /api/fs/list`, `GET /api/fs/file/:token/:file` | File explorer listing and file bytes |
| `POST /api/fs/ticket` | Single-use ticket that renders an `.html`/`.svg` instead of showing its source |
| `POST /api/fs/upload`, `POST /api/fs/delete` | Upload / delete a file |
| `POST /api/upload-image` | Paste or drop an image into the terminal |
| `GET /api/git/branches`, `POST /api/git/pull` | Branch panel |
| `GET /api/plan`, `GET /api/plan/:token/:file`, `GET /api/plan/:token/:session/:file` | Serve a plan markdown file for terminal plan links |
| `GET /api/plan-dirs`, `POST /api/plan-dirs` | Per-session plan directories |
| `GET /api/settings/scrollback`, `POST /api/settings/scrollback` | Scrollback budget in bytes |
| `POST /api/hooks/:sessionId` | Claude Code hook relay — loopback only, per-session token |

### WebSocket

Browser → server: `create_session`, `join_session`, `leave_session`, `close_session`,
`start_claude`, `input`, `resize`, `detach_size`, `pause`, `resume`, `stop`, `ping`.

Server → browser: `connected`, `session_created`, `session_joined`, `session_left`,
`session_deleted`, `claude_started`, `claude_stopped`, `output`, `exit`, `hook_event`,
`info`, `error`, `pong`.

## Security

- **Authentication is on by default.** A random token is generated at startup unless you
  supply one; clients send it as `Authorization: Bearer <token>`, or open the page with
  `?token=…` and let the login form store it.
- **Prefer `--auth-file` or `CCWEB_AUTH` over `--auth`** on a shared machine:
  `/proc/<pid>/cmdline` is world-readable.
- **HTTPS** with `--https --cert --key`, or terminate TLS in front of it.
- **Path handling**: plan and file routes realpath every target and allow-list it, so
  symlinks and `..` cannot escape; served files are capped (2 MB for plans, 10 MB for
  explorer files) and sent with `nosniff` + `Referrer-Policy: no-referrer`, so the in-URL
  token never leaks through `Referer`.
- **Rendered files are sandboxed**: `.html`/`.svg` are served as `text/plain` source
  unless the URL carries a single-use ticket, and a rendered page gets an opaque origin
  with `default-src 'none'`.
- **No rate limiting is in effect.** `src/utils/auth.js` contains a per-IP limiter, but
  nothing wires it up (tracked as `GAP-01` in `FEATURES.md`). Treat this as a local,
  single-user tool: bind it to a machine you trust, and put a proxy in front of it if it
  has to face the network.

## Development

```bash
npm install
npm run dev -- --port 32353   # dev instance, by convention on 32353
npm test                      # Mocha + node:assert
npx mocha test/session-store.test.js
npx mocha test/*.test.js --grep "persistence"
```

There is **no build step** — `src/` runs directly, and the frontend is dependency-free
(xterm and the fonts are vendored under `src/public/vendor/`).

Before changing a file, check what hangs on it:

```bash
node scripts/feature-surfaces.js --file src/public/app.js
```

`test/features.test.js` compares `FEATURES.md` with the code in both directions: a new
entry point has to be listed in the same commit, and a listed one that disappears fails
with "this removes a feature". `test/SMOKE.md` holds the quantified browser checks that
are run on a throwaway instance.

### File structure

```
cc-web/
├── bin/
│   ├── cc-web.js            # CLI entry point
│   └── cc-hook.js           # Claude Code hook relay (stdin JSON → POST /api/hooks)
├── src/
│   ├── server.js            # Express + WebSocket server, sessions, REST API
│   ├── claude-bridge.js     # Claude CLI process management (node-pty)
│   ├── git-branches.js      # Branch panel backend
│   ├── instance-lock.js     # <data dir>/instances/<port>.lock
│   ├── utils/
│   │   ├── auth.js          # Token helpers + an unused rate limiter (GAP-01)
│   │   ├── claude-history.js# Reading Claude's recorded conversations
│   │   ├── claude-theme.js  # Terminal theme
│   │   ├── inline-assets.js # Inline file responses
│   │   └── session-store.js # Per-session persistence
│   └── public/              # Frontend (plain ES, no framework, no build)
│       ├── index.html       ├── app.js           ├── session-manager.js
│       ├── splits.js        ├── conversations.js ├── file-explorer.js
│       ├── git-branches.js  ├── claude-title.js  ├── terminal-links.js
│       ├── viewport-mode.js ├── fab-position.js  ├── icons.js
│       ├── auth.js          ├── service-worker.js├── style.css
│       └── vendor/          # xterm + fonts
├── test/                    # Mocha tests + SMOKE.md
├── scripts/                 # feature-surfaces.js, release helpers
├── FEATURES.md              # Every user-visible feature, with guard tests
├── CLAUDE.md                # Architecture notes for Claude Code
└── DESIGN.md                # Design rationale
```

## Testing

- Framework: Mocha with Node's `assert`
- Location: `test/*.test.js`
- Run: `npm test`
- Guidelines: fast, isolated unit tests; temp dirs, no network, no real CLI calls —
  mock process spawns.

## Browser compatibility

- Chrome/Chromium 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Troubleshooting

### Claude Code not found

```bash
which claude
claude --version
```

The bridge also tries `~/.claude/local/claude` and a few other standard paths before
falling back to a bare `claude` on `PATH`.

### The port is refused on startup

Another instance is already using that data directory. Either stop it or give this one
its own: `CCW_DATA_DIR=~/.claude-code-web-dev node bin/cc-web.js --port 32353`.

### Connection issues

- Check firewall settings for the port
- Run with `--dev` for detailed logs
- Make sure the token in the URL matches the one printed at startup

## License

MIT — see the [LICENSE](LICENSE) file.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for development, testing and pull request guidelines.
