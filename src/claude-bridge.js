const { spawn } = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const claudeTheme = require('./utils/claude-theme');
const claudeConfig = require('./utils/claude-config');

class ClaudeBridge {
  constructor() {
    this.sessions = new Map();
    this.claudeCommand = this.findClaudeCommand();
  }

  findClaudeCommand() {
    if (process.platform === 'win32') return this.findWindowsClaudeCommand();
    const possibleCommands = [
      '/home/ec2-user/.claude/local/claude',
      'claude',
      'claude-code',
      path.join(process.env.HOME || '/', '.claude', 'local', 'claude'),
      path.join(process.env.HOME || '/', '.local', 'bin', 'claude'),
      // Homebrew on Apple Silicon. Not on the PATH a launchd/GUI-started
      // server inherits, so `which` alone would miss it.
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude'
    ];

    for (const cmd of possibleCommands) {
      try {
        if (fs.existsSync(cmd) || this.commandExists(cmd)) {
          console.log(`Found Claude command at: ${cmd}`);
          return cmd;
        }
      } catch (error) {
        continue;
      }
    }

    console.error('Claude command not found, using default "claude"');
    return 'claude';
  }

  // node-pty on Windows (ConPTY) needs a real executable: a bare `claude`
  // fails with "Cannot create process, error code: 2", and the npm shim
  // `claude.cmd` is a batch file, which would put cmd.exe between us and the
  // PTY. So resolve to claude.exe — the native installer's, the npm global
  // package's, or the package next to whichever npm shim is on PATH.
  findWindowsClaudeCommand() {
    const home = process.env.USERPROFILE || os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const npmPackageExe = (dir) => path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const candidates = [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.exe'),
      npmPackageExe(path.join(appData, 'npm')),
      ...this.whereAll('claude.exe'),
      ...this.whereAll('claude.cmd').map((shim) => npmPackageExe(path.dirname(shim)))
    ];

    for (const cmd of candidates) {
      if (fs.existsSync(cmd)) {
        console.log(`Found Claude command at: ${cmd}`);
        return cmd;
      }
    }

    console.error('Claude command not found, using default "claude.exe"');
    return 'claude.exe';
  }

  // Every match `where` finds on PATH, or [] when there is none.
  whereAll(command) {
    try {
      return require('child_process').execFileSync('where', [command], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  commandExists(command) {
    if (process.platform === 'win32') return this.whereAll(command).length > 0;
    try {
      require('child_process').execFileSync('which', [command], { stdio: 'ignore' });
      return true;
    } catch (error) {
      return false;
    }
  }

  async startSession(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const {
      workingDir = process.cwd(),
      uiTheme = '',
      dangerouslySkipPermissions = false,
      resume = false,
      // Whether a failed --resume may relaunch fresh under the same id. True for
      // cc-web's own recovery (the id was ours and the conversation may simply
      // not exist yet); false for a conversation the user picked from the
      // history list, where a fresh launch would silently discard what they
      // asked to continue.
      allowFreshFallback = true,
      model = '',
      permissionMode = '',
      effort = '',
      name = '',
      onOutput = () => {},
      onExit = () => {},
      onError = () => {},
      cols = 80,
      rows = 24,
      // Hook relay wiring (from the server). When all three are present we
      // register a Claude Code PreToolUse(ExitPlanMode) hook so plan mode is
      // detected via a structured event instead of scraping the terminal.
      hookScript = '',
      hookPort = 0,
      hookToken = '',
      // The statusLine relay (bin/cc-statusline.js): the tab's context ring.
      // Rides the same port and token as the hook relay.
      statusLineScript = '',
      // Which Claude conversation `--resume` re-attaches to. Defaults to the
      // cc-web session id because that is what `--session-id` bound on the first
      // start — but Claude can move itself to a new transcript (`/clear`), and
      // the server tracks where it went. See server.resumeIdFor.
      resumeId = '',
      // The session owner's own Claude directory (CLAUDE_CONFIG_DIR) and the
      // platform credential to run it with: the shared subscription token, or
      // the platform key. All empty for the unowned tenant, which keeps using
      // ~/.claude and whatever login it holds. See utils/claude-config.js.
      claudeConfigDir = null,
      apiKey = '',
      oauthToken = ''
    } = options;

    // Args shared by a fresh launch and a resume.
    const baseArgs = ClaudeBridge.launchArgs({ dangerouslySkipPermissions, model, permissionMode, effort, name });
    // Route Claude's notification events (task finished / needs input /
    // permission prompt) to the terminal bell — the BEL travels PTY→WS→xterm and
    // the client's onBell turns it into a beep + notification. Injected via
    // --settings so the user's own settings.json is untouched.
    // The user's own statusLine, which ours replaces and then runs for them.
    const userStatusLine = statusLineScript ? ClaudeBridge.userStatusLine(workingDir, claudeConfigDir) : null;
    baseArgs.push('--settings', JSON.stringify(
      this.buildInjectedSettings(sessionId, { hookScript, hookPort, hookToken, uiTheme, claudeConfigDir, statusLineScript, userStatusLine })
    ));


    // Spawn Claude bound to our stable session id. `--session-id <uuid>` starts a
    // brand-new conversation under that id; `--resume <uuid>` re-attaches to it
    // later (after a server restart or a dead PTY) so the conversation is NOT
    // lost. The id is the cc-web session's own uuid.
    const spawnClaude = (mode) => {
      // Only the RESUME target may differ from our own id: a fresh launch still
      // binds the cc-web id via --session-id, which is what makes the two the
      // same in the first place.
      const idArgs = mode === 'resume'
        ? ['--resume', resumeId || sessionId]
        : ['--session-id', sessionId];
      console.log(`Starting Claude session ${sessionId} [${mode}] cwd=${workingDir} size=${cols}x${rows}`);
      if (dangerouslySkipPermissions) {
        console.log(`⚠️ WARNING: Skipping permissions with --dangerously-skip-permissions flag`);
      }
      // Make every spawned Claude a clean TOP-LEVEL session. If cc-web itself was
      // launched from inside a Claude session, the inherited CLAUDE_CODE_CHILD_SESSION
      // marker turns OFF transcript saving — which would make --resume find nothing
      // ("No conversation found") and silently break session recovery. Drop that
      // marker and force session persistence so conversations are always saved and
      // resumable, regardless of how cc-web was started.
      const childEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
        // Force synchronized output (DEC mode 2026): xterm 6.0 supports it, so
        // Claude wraps each frame in BSU/ESU and repaints atomically — no
        // stream flicker/tearing over the WebSocket. Orthogonal to the renderer
        // choice below: this is about how a frame is delivered, not where it is
        // drawn.
        CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1',
        // Force the CLASSIC renderer. Claude's default is the fullscreen one,
        // which draws on the terminal's ALTERNATE screen buffer the way vim
        // does — and the alternate buffer has no scrollback by design. In a
        // browser terminal that is fatal: there is nothing above the screen to
        // scroll to, so history simply does not exist. Measured on a real
        // claude process: the default emits zero newlines and enters the
        // alternate buffer; with this set it stays in the main buffer and emits
        // lines that land in scrollback. Anthropic's own docs put it plainly —
        // "the classic renderer keeps the conversation in your terminal's
        // native scrollback".
        //
        // The trade is more flicker and memory that grows with the
        // conversation. Both are worth it here: scrolling back is the whole
        // point of a terminal you read on a phone, and the client already
        // coalesces writes per frame.
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
        // Persist transcripts so --resume can restore the conversation.
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
        // Print links as OSC 8 hyperlinks. Measured on 2.1.278: without this
        // Claude emits none in a PTY; with it, file paths and URLs Claude
        // links become clickable (file:///… and https://…), handled by
        // app.openTerminalLink. The trade, agreed by the user 2026-09-22: a
        // markdown link then shows only its text, not "text (url)".
        FORCE_HYPERLINK: '1'
      };
      // Hook relay token: inherited by the ExitPlanMode hook (cc-hook.js) via the
      // environment instead of argv, so it doesn't leak through /proc/<pid>/cmdline.
      if (hookToken) childEnv.CCWEB_HOOK_TOKEN = hookToken;
      // Read by the ccweb-companion mod ($.env.get) to reach the relay: the port
      // is not secret but env beats another argv surface.
      if (hookToken && hookPort) childEnv.CCWEB_HOOK_PORT = String(hookPort);
      // Run by cc-statusline.js so the user keeps the status line they had.
      if (userStatusLine) childEnv.CCWEB_USER_STATUSLINE = userStatusLine.command;
      delete childEnv.CLAUDE_CODE_CHILD_SESSION;
      ClaudeBridge.applyOwnerEnv(childEnv, { claudeConfigDir, apiKey, oauthToken });
      return spawn(this.claudeCommand, [...idArgs, ...baseArgs], {
        cwd: workingDir,
        env: childEnv,
        cols,
        rows,
        // 256-color terminfo to match TERM above.
        name: 'xterm-256color'
      });
    };

    try {
      let mode = resume ? 'resume' : 'fresh';
      let launchedAt = Date.now();
      let fellBack = false;
      let trustPromptHandled = false;
      let inUseNoted = false;
      let phantomRecovered = false;
      let dataBuffer = '';

      const session = {
        process: null,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null
      };
      this.sessions.set(sessionId, session);

      // Wire the PTY's data/exit/error handlers. Extracted so we can re-wire a
      // replacement process when a failed --resume falls back to a fresh launch.
      // Each handler ignores events from a stale process (one we've already
      // replaced), so the fallback swap can't corrupt session state.
      const wire = (proc) => {
        proc.onData((data) => {
          if (proc !== session.process) return; // stale process — ignore
          if (process.env.DEBUG) {
            console.log(`Session ${sessionId} output:`, data);
          }
          dataBuffer += data;
          // Resume fallback (interactive): Claude prints "No conversation found"
          // WITHOUT exiting when the id is unknown. Detect it and relaunch fresh
          // once, bound to the same id, so the session recovers instead of
          // sitting on an error. (Belt-and-suspenders with the exit check below.)
          if (mode === 'resume' && !fellBack && dataBuffer.includes('No conversation found')) {
            if (!allowFreshFallback) {
              // Not swallowed: there is no replacement process to take over, so
              // the CLI's own message belongs on screen under our explanation.
              reportResumeFailure('no conversation found');
              onOutput(data);
              return;
            }
            triggerFallback('no conversation found');
            return; // swallow the failed-resume output; fresh process takes over
          }
          // Fresh launch collided with a still-registered session id (a phantom
          // left by an interrupted start). Explain it once; the circuit breaker
          // on the server side stops the retry loop.
          if (mode === 'fresh' && !inUseNoted && dataBuffer.toLowerCase().includes('already in use')) {
            inUseNoted = true;
            onOutput('\r\n\x1b[33mThis session id is already in use (a stuck/phantom session). If it keeps failing, create a new session.\x1b[0m\r\n');
          }
          if (!trustPromptHandled && ClaudeBridge.looksLikeTrustPrompt(dataBuffer)) {
            trustPromptHandled = true;
            console.log(`Trust prompt detected for session ${sessionId}`);
            setTimeout(() => {
              // Read the SETTLED buffer, not the fragment that tripped the
              // match: the prompt is still being painted when the first chunk
              // arrives, and only the finished frame says which option the
              // cursor is on.
              const delta = ClaudeBridge.trustPromptCursorDelta(dataBuffer);
              if (delta === null) {
                console.log(`Trust prompt for ${sessionId}: accept option not found; leaving the choice on screen`);
                return;
              }
              const arrow = delta >= 0 ? '\x1b[B' : '\x1b[A';
              try {
                for (let i = 0; i < Math.abs(delta); i++) session.process.write(arrow);
                // Let the TUI repaint the new selection before confirming it.
                setTimeout(() => { try { session.process.write('\r'); } catch (_) {} }, 120);
              } catch (_) {}
              console.log(`Accepting trust prompt for session ${sessionId} (cursor ${delta} row(s) from the accept option)`);
            }, 500);
          }
          if (dataBuffer.length > 10000) {
            dataBuffer = dataBuffer.slice(-5000);
          }
          onOutput(data);
        });

        proc.onExit((exitCode, signal) => {
          if (proc !== session.process) return; // stale process — ignore
          // node-pty may report exit as (code, signal) or a single
          // {exitCode, signal} object depending on version — normalise it.
          const code = (exitCode && typeof exitCode === 'object') ? exitCode.exitCode : exitCode;
          const sig = (exitCode && typeof exitCode === 'object') ? exitCode.signal : signal;

          // Resume fallback: re-attach failed fast (e.g. bad session state) —
          // relaunch fresh once.
          if (mode === 'resume' && !fellBack && code !== 0 && (Date.now() - launchedAt) < 8000) {
            if (!allowFreshFallback) {
              reportResumeFailure(`exit code ${code}`);
              // fall through: the session ends, the tab shows why
            } else {
              triggerFallback(`quick exit code ${code}`);
              return; // swallow the failed-resume exit; fresh process takes over
            }
          }

          // Phantom self-heal: a fresh launch that dies fast on "already in use"
          // means the id is registered but empty (an interrupted start left only a
          // bridge-session line — resume found no conversation, fresh can't claim
          // it). Delete that empty transcript and retry fresh once so the session
          // just works instead of getting stuck.
          const looksInUse = inUseNoted || dataBuffer.toLowerCase().includes('already in use');
          if (mode === 'fresh' && !phantomRecovered && code !== 0 && (Date.now() - launchedAt) < 8000 && looksInUse) {
            phantomRecovered = true;
            if (this.clearEmptyTranscript(sessionId, claudeConfigDir)) {
              // We are inside a PTY event handler — the enclosing try/catch has
              // long since returned, so a spawn failure here would surface as an
              // uncaughtException and take the server down. Fall through to the
              // normal exit path instead. (No kill of the old process: it is the
              // one that just exited.)
              try {
                launchedAt = Date.now();
                inUseNoted = false;
                dataBuffer = '';
                console.log(`Cleared empty phantom transcript for ${sessionId}; retrying fresh`);
                session.process = spawnClaude('fresh');
                wire(session.process);
                return; // swallow this exit; the retried process takes over
              } catch (err) {
                console.error(`Phantom retry failed to spawn for ${sessionId}:`, err);
              }
            }
          }

          console.log(`Claude session ${sessionId} exited with code ${code}, signal ${sig}`);
          if (session.killTimeout) {
            clearTimeout(session.killTimeout);
            session.killTimeout = null;
          }
          session.active = false;
          this.sessions.delete(sessionId);
          onExit(exitCode, signal);
        });

        proc.on('error', (error) => {
          if (proc !== session.process) return; // stale process — ignore
          console.error(`Claude session ${sessionId} error:`, error);
          if (session.killTimeout) {
            clearTimeout(session.killTimeout);
            session.killTimeout = null;
          }
          session.active = false;
          this.sessions.delete(sessionId);
          onError(error);
        });
      };

      // A resume the user asked for that we are NOT allowed to paper over. Say
      // so in the terminal instead of starting an empty conversation under the
      // same id, which would look identical to a successful resume.
      let resumeFailureNoted = false;
      const reportResumeFailure = (reason) => {
        if (resumeFailureNoted) return;
        resumeFailureNoted = true;
        console.log(`Resume failed for ${sessionId} (${reason}); no fresh fallback for a picked conversation`);
        onOutput(`\r\n\x1b[31mCould not continue this conversation (${reason}).\x1b[0m\r\n` +
          `\x1b[33mIt may have been deleted, or it is open elsewhere. Create a new session to start fresh.\x1b[0m\r\n`);
      };

      // Swap the current (failed-resume) process for a fresh one bound to the
      // same id. Only ever runs once (guarded by `fellBack`).
      const triggerFallback = (reason) => {
        fellBack = true;
        mode = 'fresh';
        launchedAt = Date.now();
        trustPromptHandled = false;
        dataBuffer = '';
        const old = session.process;
        console.log(`Resume fallback for ${sessionId} (${reason}); starting a fresh session`);
        // Guarded for the same reason as the phantom retry below: this runs from
        // a PTY data handler, outside the enclosing try/catch.
        try {
          session.process = spawnClaude('fresh'); // becomes the new current process
          wire(session.process);
          if (old && old !== session.process) { try { old.kill(); } catch (_) {} }
        } catch (err) {
          console.error(`Resume fallback failed to spawn for ${sessionId}:`, err);
        }
      };

      session.process = spawnClaude(mode);
      wire(session.process);

      console.log(`Claude session ${sessionId} started successfully [${mode}]`);
      return session;

    } catch (error) {
      console.error(`Failed to start Claude session ${sessionId}:`, error);
      throw new Error(`Failed to start Claude Code: ${error.message}`);
    }
  }

  // Build the settings object injected via `claude --settings`. Always routes
  // notifications to the terminal bell; when hook-relay params are present it
  // also registers a PreToolUse(ExitPlanMode) hook whose command relays the plan
  // event to the server via bin/cc-hook.js. Claude presents a plan by calling
  // the ExitPlanMode tool, so PreToolUse fires with the full plan in
  // tool_input.plan. argv strings are single-quote escaped; token/session are
  // uuids so there is no shell-injection risk. Extracted so it is unit-testable
  // without spawning a PTY.
  // Delete an EMPTY Claude transcript for this session id (only a bridge-session
  // metadata line, no user/assistant turns) so a stuck "already in use" id can be
  // reclaimed with --session-id. Safe: it only removes a tiny file with no real
  // conversation. Globs across project dirs so we don't depend on the dir-encoding.
  // Also drops the id's session-env dir, which is dead once the transcript is.
  clearEmptyTranscript(sessionId, claudeConfigDir = null) {
    // The id is interpolated into paths we then delete — one of them recursively,
    // inside the user's home. Ids are server-minted uuids, but they also round-trip
    // through sessions.json, so re-check the shape rather than trust the caller.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId || ''))) {
      return false;
    }
    try {
      const home = claudeConfig.claudeHome(claudeConfigDir);
      const root = claudeConfig.projectsDir(claudeConfigDir);
      if (!fs.existsSync(root)) return false;
      for (const proj of fs.readdirSync(root)) {
        const f = path.join(root, proj, `${sessionId}.jsonl`);
        if (!fs.existsSync(f)) continue;
        const st = fs.statSync(f);
        if (st.size >= 4096) continue; // real conversations are far bigger
        const content = fs.readFileSync(f, 'utf8');
        if (/"type"\s*:\s*"(user|assistant)"/.test(content)) continue; // has real turns
        fs.unlinkSync(f);
        try { fs.rmSync(path.join(home, 'session-env', sessionId), { recursive: true, force: true }); } catch (_) {}
        return true;
      }
    } catch (_) { /* best-effort */ }
    return false;
  }

  // Is Claude asking whether this folder is trusted?
  //
  // Matching the sentence as written does not work, for two reasons found by
  // capturing the real PTY stream (2026-09-07, v2.1.247):
  //
  //   1. The TUI positions EVERY WORD with a cursor-column escape, so the bytes
  //      read `Quick\x1b[8Gsafety\x1b[15Gcheck:` — strip the escapes and the
  //      words run together with no spaces at all. This is why the original
  //      check ("Do you trust the files in this folder?") silently stopped
  //      firing: not a rewording, a rendering change.
  //   2. The wording did also change — v2.1.247 asks "Quick safety check: Is
  //      this a project you created or one you trust?".
  //
  // So: drop the escapes, drop ALL whitespace, lowercase, and look for the
  // fragments that survive that — including the accept option itself. Missing
  // this leaves a new session parked on the prompt until someone presses Enter
  // by hand.
  static looksLikeTrustPrompt(text) {
    const dense = String(text || '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
    return /doyoutrustthefilesinthisfolder|quicksafetycheck|yes,?itrustthisfolder/.test(dense);
  }

  // How far the selection cursor sits from "Yes, I trust this folder", counted
  // in option rows: 0 when it is already there, positive when the accept line
  // is below it. null when the screen cannot be read that way.
  //
  // This exists because a bare Enter is NOT safe. WHICH option starts
  // highlighted is Claude's choice and it has changed: the old prompt opened on
  // "1. Yes, I trust this folder", today's opens on "No, exit". The blind Enter
  // this replaced therefore quit for the user — a second into every session in
  // a folder Claude had not seen before, the PTY died and the tab fell back to
  // the start screen with no explanation. Measure, then move, then confirm.
  static trustPromptCursorDelta(text) {
    // Same de-escaping as looksLikeTrustPrompt, but per line: Claude gives every
    // word its own cursor-column escape, so a row only reads as text once the
    // escapes and the spaces they stand in for are gone. Blank rows drop out so
    // "one row down" means one OPTION down, which is what the arrow key moves.
    //
    // A row can also end without a newline at all: 2.1.304 places every row
    // of the prompt with an absolute cursor move (`ESC[14;2H❯ No, exit` then
    // `ESC[15;4HYes, I trust this folder`, measured 2026-11-05 in a fresh
    // CLAUDE_CONFIG_DIR). Strip those like the rest and the whole prompt
    // collapses into one row with no cursor to find — so a move to a row, or
    // down a row, counts as a line break first.
    const rows = String(text || '')
      .replace(/\x1b\[[0-9]*(?:;[0-9]*)?[Hf]|\x1b\[[0-9]*[BE]/g, '\n')
      .replace(/\x1b\[[0-9;?<>=!]*[a-zA-Z]/g, '')
      .replace(/\r\n|\r/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+/g, '').toLowerCase())
      .filter((line) => line.length > 0);

    // Last frame wins: Claude repaints the whole prompt on every resize, and the
    // buffer holds all of those repaints.
    let accept = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (/yes,?itrustthisfolder/.test(rows[i])) { accept = i; break; }
    }
    if (accept < 0) return null;

    // The options are consecutive rows and the cursor is on one of them. Only
    // look at that neighbourhood, so a "❯" from elsewhere on screen (Claude's
    // own input box draws one) cannot be mistaken for the selection.
    let cursor = -1;
    for (let i = Math.max(0, accept - 3); i <= Math.min(rows.length - 1, accept + 3); i++) {
      if (rows[i].startsWith('❯')) cursor = i;
    }
    if (cursor < 0) return null;
    return accept - cursor;
  }

  // Claude's theme has to match the background WE paint, because the browser
  // terminal is the background. On light we ask for `light-ansi` rather than
  // `light`: the truecolor `light` theme rules its input box in #999999, which
  // is 2.85:1 on our white canvas — effectively invisible, and nothing on our
  // side can lift it (white is already the highest-contrast light background for
  // that grey). The `-ansi` variant draws the same chrome in ANSI colours, which
  // come from OUR palette, so contrast is ours to guarantee — see the light
  // palette in src/public/splits.js, where ANSI 7 (the input box rules) is held
  // at 6.39:1. Dark needs no such help, so it keeps the richer truecolor theme.
  // Now delegated: cc-web ships its own theme files so the lines above can be
  // named directly (`promptBorder`, `subtle`) instead of being reached at
  // through an ANSI slot that Claude also uses for something else. Falls back to
  // exactly the two built-ins described above when the files could not be
  // written — see src/utils/claude-theme.js.
  // Launch options chosen in the UI, as CLI args. Whitelisted so a bad value
  // can't reach the CLI (spawn uses an argv array, so there is no shell
  // injection risk either); anything unknown is dropped, not an error.
  // --dangerously-skip-permissions wins over an explicit permission mode, and
  // `bypassPermissions` is left out on purpose: it is that same switch, and one
  // road to it is enough. `default` is `manual` under its old name (2.1.278
  // still takes it, just no longer lists it). Checked against `claude --help`
  // in test/claude-bridge.test.js.
  //
  // `name` becomes `--name`: shown on the prompt box, set as the terminal
  // title, and recorded as the conversation's custom-title (what /resume
  // lists). Measured on 2.1.278: with it set Claude writes no ai-title, so the
  // server passes only names a person typed — see session.nameIsCustom. One
  // `--name=value` argument, so a name starting with "-" is still a value.
  static launchArgs({ dangerouslySkipPermissions = false, model = '', permissionMode = '', effort = '', name = '' } = {}) {
    const args = dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : [];
    if (ClaudeBridge.MODELS.includes(model)) args.push('--model', model);
    // 'default' means "no --permission-mode at all": it stays in PERMISSION_MODES
    // because old sessions.json records carry it, but the CLI has no such choice
    // (measured on 2.1.296) and would reject the flag.
    if (!dangerouslySkipPermissions && permissionMode !== 'default'
        && ClaudeBridge.PERMISSION_MODES.includes(permissionMode)) {
      args.push('--permission-mode', permissionMode);
    }
    if (ClaudeBridge.EFFORTS.includes(effort)) args.push('--effort', effort);
    const cleanName = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80);
    if (cleanName) args.push(`--name=${cleanName}`);
    return args;
  }

  // A platform user's Claude runs on their own directory (CLAUDE_CONFIG_DIR),
  // and on the platform's credential or nothing: the shared subscription token
  // when one is configured, else the platform key. Credentials the server
  // inherited are not theirs to use. Without a directory (the unowned tenant)
  // the env is left exactly as it was. The same rule as claudeConfig.applyEnv,
  // spelled out here because this is the spawn env FEATURES.md accounts for.
  static applyOwnerEnv(childEnv, { claudeConfigDir = null, apiKey = '', oauthToken = '' } = {}) {
    if (!claudeConfigDir) return childEnv;
    for (const name of claudeConfig.CREDENTIAL_ENV) delete childEnv[name];
    childEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
    if (oauthToken) childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    else if (apiKey) childEnv.ANTHROPIC_API_KEY = apiKey;
    return childEnv;
  }

  static themeForUi(uiTheme, claudeConfigDir) {
    return claudeTheme.themeForUi(uiTheme, claudeConfigDir);
  }

  // The statusLine Claude would have used without ours: the most specific
  // settings file that sets one wins (project local, project, then the user's
  // own Claude directory). --settings outranks all three, so injecting ours
  // hides theirs — cc-statusline.js runs it and prints its output instead.
  static userStatusLine(workingDir, claudeConfigDir = null) {
    const userDir = claudeConfigDir || path.join(os.homedir(), '.claude');
    const files = [
      path.join(workingDir || '', '.claude', 'settings.local.json'),
      path.join(workingDir || '', '.claude', 'settings.json'),
      path.join(userDir, 'settings.json')
    ];
    for (const file of files) {
      let settings;
      try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
      const line = settings && settings.statusLine;
      if (!line || typeof line !== 'object') continue;
      // Ours, left behind somewhere: running it would relay twice.
      if (typeof line.command !== 'string' || !line.command.trim() || line.command.includes('cc-statusline.js')) return null;
      return { command: line.command, padding: Number.isFinite(line.padding) ? line.padding : undefined };
    }
    return null;
  }

  buildInjectedSettings(sessionId, { hookScript = '', hookPort = 0, hookToken = '', uiTheme = '', claudeConfigDir = null, statusLineScript = '', userStatusLine = null } = {}) {
    // `tui` is Claude's own renderer setting — the one `/tui` writes. Values are
    // exactly ["default","fullscreen"]; "default" IS the classic renderer, and
    // it is the only way to name it (there is no "classic" value). Injecting it
    // here is the supported route: it goes through the same code path as a user
    // who ran `/tui default`, it overrides a global `"tui": "fullscreen"` in
    // ~/.claude/settings.json (measured), and because a choice is on record
    // Claude stops offering to switch to fullscreen. The fullscreen renderer
    // draws on the alternate screen buffer, which has no scrollback — fatal for
    // a terminal you read in a browser. See CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
    // in the spawn env, which stays as the backstop: the setting alone loses to
    // a `/tui fullscreen` typed inside a cc-web tab, the env var does not
    // (measured: env var beats an explicit `"tui": "fullscreen"`).
    const settings = { preferredNotifChannel: 'terminal_bell', tui: 'default' };
    if (uiTheme === 'light' || uiTheme === 'dark') {
      settings.theme = ClaudeBridge.themeForUi(uiTheme, claudeConfigDir);
    }
    if (hookScript && hookPort && hookToken) {
      // The token is passed to cc-hook.js via the CCWEB_HOOK_TOKEN env var (set
      // on the spawned Claude, inherited by its hooks), NOT on the command line:
      // argv is world-readable via /proc/<pid>/cmdline, whereas /proc/<pid>/environ
      // is owner-only. port/session are non-secret and stay as argv.
      let relay;
      if (process.platform === 'win32') {
        // Claude on Windows runs a shell-form hook through Git Bash, or through
        // PowerShell when there is none — and PowerShell refuses the POSIX line
        // below (a quoted path followed by arguments is a parse error; measured
        // on 2.1.304: "SessionStart:startup hook error"). The exec form
        // (`command` + `args`) is spawned with no shell at all, so there is no
        // quoting left to get wrong.
        const args = [hookScript, '--port', String(Number(hookPort)), '--session', String(sessionId)];
        relay = { type: 'command', command: process.execPath, args };
      } else {
        const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        const command = `${q(process.execPath)} ${q(hookScript)} --port ${Number(hookPort)} --session ${q(sessionId)}`;
        relay = { type: 'command', command };
      }
      settings.hooks = {
        PreToolUse: [
          { matcher: 'ExitPlanMode', hooks: [relay] }
        ],
        // Claude's conversation id is not ours to assume. We bind ours with
        // --session-id, but `/clear` starts a NEW transcript inside the same
        // process: measured on Claude Code 2.1.266 driving a real PTY,
        // SessionStart fires again with source "clear" and a fresh uuid. Resume
        // our own id after that and the user gets the conversation from BEFORE
        // the clear, with everything since silently gone. This hook is how we
        // hear about the move. (`/compact` does not fork on this version — the
        // summary is appended to the same file.)
        SessionStart: [
          { matcher: '*', hooks: [relay] }
        ],
        // Claude is waiting for a permission answer, so a tab nobody is looking
        // at can say so. The matcher is the notification type: only
        // permission_prompt, not idle_prompt (a minute after every answer).
        // Measured on 2.1.278: it arrives about 6s after the title turns ✳,
        // together with the bell, as {message: "Claude needs your permission",
        // notification_type: "permission_prompt"}.
        Notification: [
          { matcher: 'permission_prompt', hooks: [relay] }
        ],
        // The turn is over — Claude finished answering. Measured on 2.1.278: it
        // fires the moment the title turns ✳ on a real answer, and NOT while
        // waiting for a permission, a question (AskUserQuestion) or a plan
        // approval (those send permission_prompt instead). So unlike the title,
        // it tells "finished" from "waiting" without a grace period. It carries
        // `last_assistant_message`, Claude's final reply.
        Stop: [
          { hooks: [relay] }
        ]
      };
    }
    if (statusLineScript && hookPort && hookToken) {
      // Measured on 2.1.304 (Windows, real PTY): statusLine is NOT the hooks'
      // shape. The exec form (`command` + `args`) is never run at all, and
      // the command string goes through PowerShell 5.1 even with Git Bash
      // installed — so a quoted path followed by arguments is a parse error,
      // silently. PowerShell's call operator `&` makes the same line valid.
      // PowerShell's single quotes are literal (no $ expansion), ' doubled.
      const q = process.platform === 'win32'
        ? (s) => `'${String(s).replace(/'/g, "''")}'`
        : (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const line = `${q(process.execPath)} ${q(statusLineScript)} --port ${Number(hookPort)} --session ${q(sessionId)}`;
      settings.statusLine = { type: 'command', command: process.platform === 'win32' ? `& ${line}` : line };
      if (userStatusLine && userStatusLine.padding !== undefined) settings.statusLine.padding = userStatusLine.padding;
    }
    return settings;
  }

  async sendInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.write(data);
    } catch (error) {
      throw new Error(`Failed to send input to session ${sessionId}: ${error.message}`);
    }
  }

  async resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.resize(cols, rows);
    } catch (error) {
      console.warn(`Failed to resize session ${sessionId}:`, error.message);
    }
  }

  // Flow control: stop/resume reading from the PTY. When paused, node-pty stops
  // draining the pty master, so the child (Claude) blocks once the OS buffer
  // fills — backpressure that lets a slow browser catch up instead of the
  // server buffering output unboundedly.
  pause(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.process) {
      try { session.process.pause(); } catch (_) { /* pty may not support */ }
    }
  }

  resume(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.process) {
      try { session.process.resume(); } catch (_) { /* pty may not support */ }
    }
  }

  async stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      // Clear any existing kill timeout
      if (session.killTimeout) {
        clearTimeout(session.killTimeout);
        session.killTimeout = null;
      }

      if (session.active && session.process) {
        // Windows node-pty takes no signal: kill('SIGTERM') THROWS "Signals not
        // supported on windows", the catch below swallowed it, and the session
        // was forgotten with its Claude still running — every Stop (and every
        // hibernation) on Windows left an orphaned claude.exe and its MCP
        // servers behind (measured 2026-11-07). A plain kill() closes the
        // pseudo console, which ends the process.
        const proc = session.process;
        const kill = (signal) => (process.platform === 'win32' ? proc.kill() : proc.kill(signal));
        kill('SIGTERM');

        session.killTimeout = setTimeout(() => {
          if (session.active && session.process) {
            try { kill('SIGKILL'); } catch (_) { /* already gone */ }
          }
        }, 5000);
      }
    } catch (error) {
      console.warn(`Error stopping session ${sessionId}:`, error.message);
    }

    session.active = false;
    this.sessions.delete(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      workingDir: session.workingDir,
      created: session.created,
      active: session.active
    }));
  }

  async cleanup() {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }
  }

}

ClaudeBridge.MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
ClaudeBridge.PERMISSION_MODES = ['plan', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'default'];
ClaudeBridge.EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

module.exports = ClaudeBridge;