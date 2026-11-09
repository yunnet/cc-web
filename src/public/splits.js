/**
 * SplitContainer - Simple VS Code-style split view
 * Manages up to 2 terminal panes side-by-side with independent terminals
 */

// xterm terminal theme, chosen from the active app theme (`data-theme`), which
// is set synchronously in <head> before this script runs. The terminal renders
// its own background via this JS theme (not CSS), so without this the terminal
// stayed dark in light mode. The light palette is tuned to read on white
// (GitHub-Light-style ANSI colors); the dark palette matches the previous one.
//
// The light palette is not decoration: Claude runs under the `light-ansi` theme
// (see ClaudeBridge.themeForUi), which draws its whole chrome in ANSI colours,
// so these sixteen values ARE the contrast of the input box rules, the status
// line and every line of a reply. Three rules keep it readable, all checked by
// test/light-contrast.test.js:
//
//   1. On a light background `bright*` means DARKER than its base, not lighter.
//      The inherited palette had it the dark-terminal way round, which is how
//      brightWhite (#8c959f, 3.04:1) and brightBlue (#218bff, 3.39:1) ended up
//      washing out the parts of a reply Claude draws with them.
//
//   2. ANSI 7 is DOUBLE-BOOKED, and no single value can serve both jobs. Claude
//      rules the input box and the status line with it as a FOREGROUND, and
//      paints the band behind your own echoed message with it as a BACKGROUND,
//      ANSI 0 on top. Those pull opposite ways, and worse, the two ratios are
//      locked together: contrast(7,bg) x contrast(0,7) == contrast(0,bg), a
//      constant. Splitting the difference gives both jobs a mediocre value —
//      that was tried at 4.55:1 and again at 3.73:1, and the rules read as
//      invisible both times. Hairlines need far more contrast than text does.
//
//      `minimumContrastRatio` is the way out, because it works on the RENDERED
//      PAIR rather than on the palette: xterm adjusts a foreground that lands
//      too close to whatever is actually behind it. So ANSI 7 is now set dark
//      enough for the rules (6.39:1), and the band it also paints is rescued at
//      draw time — the ANSI 0 on top of it gets lightened automatically.
//      Verified in the browser, not just in a contrast formula.
//
//   3. Everything else clears 4.5:1 on white, and the greys stay in order
//      (0 darkest, then 8, then 7) so Claude's loud/normal/quiet still reads.
function getTerminalTheme() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
        // GitHub-Light-style palette: solid white bg with dark, high-contrast
        // ANSI colors that read on white. (A transparent bg renders opaque dark
        // under the canvas renderer, so light mode must set a solid background.)
        return {
            background: '#ffffff',
            foreground: '#1f2328',
            cursor: '#0969da',
            cursorAccent: '#ffffff',
            selectionBackground: 'rgba(9, 105, 218, 0.20)',
            selectionForeground: '#ffffff',
            black: '#0d1117', red: '#cf222e', green: '#116329', yellow: '#9a6700',
            blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#57606a',
            brightBlack: '#424a53', brightRed: '#a40e26', brightGreen: '#0a4d20', brightYellow: '#633c01',
            brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#0f6674', brightWhite: '#656d76'
        };
    }
    // Dark palette — identical to the original main-terminal theme (solid bg).
    return {
        background: '#0d1117',
        foreground: '#f0f6fc',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88, 166, 255, 0.35)',
        selectionForeground: '#0d1117',
        black: '#484f58', red: '#ff7b72', green: '#7ee787', yellow: '#ffa657',
        blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#a5f3fc', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#ffdf5d',
        brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#a5f3fc', brightWhite: '#f0f6fc'
    };
}

// Light mode only. Claude double-books ANSI 7 as both a hairline foreground and
// a band background (see rule 2 above), so some pairs can only be fixed where
// the pair is known — at draw time. 4.5 is enough to rescue ANSI 0 on ANSI 7
// (2.96:1 raw) while leaving every other pair in the palette untouched, since
// they all already clear it. Dark stays off: nothing there is short of contrast,
// and switching it on would silently repaint a theme nobody complained about.
const LIGHT_MIN_CONTRAST_RATIO = 4.5;

function getTerminalContrast() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT_MIN_CONTRAST_RATIO : 1;
}

// Always set these two together — the palette assumes the correction is on, so a
// terminal that got one without the other is the bug this function prevents.
function applyTerminalPalette(term) {
    if (!term) return;
    term.options.theme = getTerminalTheme();
    term.options.minimumContrastRatio = getTerminalContrast();
}

// Where a plan file opens: GET /api/plan, scoped to the session whose terminal
// it was clicked in. Shared by the plain-text plan links below and by a plan
// file Claude prints as a hyperlink (app.openTerminalLink).
function planUrl(planPath, sid) {
    return (window.authManager && window.authManager.getPlanUrl)
        ? window.authManager.getPlanUrl(planPath, sid)
        : `/api/plan/-/${sid ? encodeURIComponent(sid) : '-'}/${encodeURIComponent(planPath)}`;
}

// Make development-plan paths (…/.claude/plans/*.md) in terminal output clickable.
// Clicking opens the plan markdown in a new browser tab via GET /api/plan, so the
// user can review it (e.g. with a browser markdown extension). Shared by the main
// terminal (app.js) and split terminals. Read-only: it inspects buffer text to
// place links and never writes to the PTY stream.
function registerPlanLinks(term, getSessionId) {
    if (!term || typeof term.registerLinkProvider !== 'function') return;
    // Paths containing `.claude/plans/` and ending in `.md` (relative or absolute).
    // The leading segment is restricted to path-legal ASCII so a label glued to
    // the path (e.g. `path:/…/plans/x.md`, including non-ASCII labels) doesn't
    // get swallowed into the match; the tail stays permissive so non-ASCII plan
    // filenames still match.
    const RE = /[A-Za-z0-9._~/-]*\.claude\/plans\/[^\s"'`()]+\.md/g;
    term.registerLinkProvider({
        provideLinks(lineNumber, callback) {
            const line = term.buffer.active.getLine(lineNumber - 1);
            if (!line) { callback(undefined); return; }
            // Build the text cell by cell, recording each UTF-16 unit's column:
            // wide (CJK) glyphs span 2 cells and surrogate pairs are 2 units in
            // 1 cell, so string index != column and the underline would drift.
            let text = '';
            const col = [];
            const cell = line.getCell(0);
            for (let x = 0; x < line.length; x++) {
                line.getCell(x, cell);
                if (cell.getWidth() === 0) continue; // trailing half of a wide glyph
                const ch = cell.getChars() || ' ';
                for (let k = 0; k < ch.length; k++) col.push(x);
                text += ch;
            }
            const links = [];
            let m;
            RE.lastIndex = 0;
            while ((m = RE.exec(text)) !== null) {
                const matched = m[0];
                const last = m.index + matched.length - 1;
                // xterm columns are 1-based; end covers the last glyph's full width.
                const startX = col[m.index] + 1;
                line.getCell(col[last], cell);
                const endX = col[last] + cell.getWidth();
                links.push({
                    range: {
                        start: { x: startX, y: lineNumber },
                        end: { x: endX, y: lineNumber }
                    },
                    text: matched,
                    activate() {
                        try {
                            const sid = (typeof getSessionId === 'function') ? getSessionId() : null;
                            window.open(planUrl(matched, sid), '_blank', 'noopener');
                        } catch (_) { /* ignore */ }
                    }
                });
            }
            callback(links.length ? links : undefined);
        }
    });
}

class Split {
    constructor(container, index, app) {
        this.container = container;
        this.index = index;
        this.app = app;
        this.sessionId = null;
        this.isActive = false;
        
        // Create independent terminal instance for this split
        this.terminal = null;
        this.fitAddon = null;
        this.webLinksAddon = null;
        this.socket = null;
        // The server hibernated this pane's Claude; focusing the pane resumes it.
        this.hibernated = false;

        this.createTerminal();
    }

    createTerminal() {
        // Create terminal wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'split-terminal-wrapper';
        
        const terminalDiv = document.createElement('div');
        terminalDiv.id = `split-terminal-${this.index}`;
        wrapper.appendChild(terminalDiv);
        
        this.container.appendChild(wrapper);
        
        // Initialize xterm.js terminal
        this.terminal = new Terminal({
            fontFamily: this.app?.terminal?.options?.fontFamily || 'JetBrains Mono, monospace',
            fontSize: this.app?.terminal?.options?.fontSize || 14,
            cursorBlink: true,
            convertEol: true,
            allowProposedApi: true,
            // Match the main terminal: Option/Alt as Meta for Claude Code shortcuts.
            macOptionIsMeta: true,
            // Match the main terminal's scrollback (default is only 1000).
            scrollback: 50000,
            // Match the main terminal's scroll feel (user-configurable via
            // Settings; instant on mobile). Falls back to 100 if unavailable.
            smoothScrollDuration: (this.app && this.app.isMobile)
                ? 0
                : (this.app?.loadSettings?.().smoothScrollDuration ?? 100),
            fastScrollModifier: 'shift',
            fastScrollSensitivity: 5,
            theme: this.app?.terminal?.options?.theme || getTerminalTheme(),
            minimumContrastRatio: getTerminalContrast(),
            // Links Claude prints (OSC 8) — the same handler as the main terminal.
            linkHandler: {
                allowNonHttpProtocols: true,
                activate: (e, uri) => this.app && this.app.openTerminalLink(uri, this.sessionId)
            }
        });
        
        this.fitAddon = new FitAddon.FitAddon();
        this.webLinksAddon = new WebLinksAddon.WebLinksAddon();
        
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.webLinksAddon);

        // Unicode v11 widths so emoji / box-drawing align (matches main terminal).
        try {
            if (window.Unicode11Addon) {
                this.terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
                this.terminal.unicode.activeVersion = '11';
            }
        } catch (e) {
            console.warn('Unicode11 addon unavailable (split):', e);
        }

        // This pane's own jump-to-latest button (TERM-33), in the pane's own
        // corner. There used to be one page-wide button that answered for the
        // focused pane only: scrolling the other pane up (a wheel does not move
        // focus) showed nothing, and when it did show it sat in the right
        // pane's corner while acting on the left one.
        this.jumpBtn = document.createElement('button');
        this.jumpBtn.type = 'button';
        this.jumpBtn.className = 'scroll-bottom-btn pane-jump-btn';
        this.jumpBtn.title = 'Jump to latest';
        this.jumpBtn.setAttribute('aria-label', 'Jump to latest');
        this.jumpBtn.hidden = true;
        this.jumpBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="4" x2="12" y2="17"></line><polyline points="6 11 12 17 18 11"></polyline></svg>';
        this.jumpBtn.addEventListener('click', () => this.scrollToLatest());
        this.container.appendChild(this.jumpBtn);
        this.terminal.onScroll(() => this.updateJump());
        this.terminal.onRender(() => this.updateJump());

        this.terminal.open(terminalDiv);

        // Split panes need the same touch scrolling the main terminal gets —
        // it was only ever wired to #terminal, so swiping a pane did nothing.
        if (this.app && this.app.isMobile && typeof this.app.setupMobileTouchScroll === 'function') {
            this.app.setupMobileTouchScroll(terminalDiv, this.terminal);
        }

        // Make plan-file paths in output clickable (open the .md in a new tab).
        registerPlanLinks(this.terminal, () => this.sessionId);

        // Canvas renderer (match main terminal), with DOM fallback.
        try {
            if (window.CanvasAddon) {
                this.terminal.loadAddon(new CanvasAddon.CanvasAddon());
            }
        } catch (e) {
            console.warn('Canvas renderer unavailable (split), using DOM:', e);
        }

        // Copy selection with Ctrl/Cmd+C (falls through to SIGINT when nothing
        // is selected). Reuses the app's clipboard helper, with a local fallback.
        this.terminal.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;

            // Shift+Enter / Option(Alt)+Enter → newline (not submit). See app.js
            // for the full rationale: xterm can't distinguish these from Enter, so
            // we send LF (\n == Ctrl+J), which Claude Code treats as a newline.
            if (e.key === 'Enter' && (e.shiftKey || e.altKey) && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'input', data: '\n' }));
                }
                return false;
            }
            // Ctrl+Enter → "send now" as Ctrl+X Ctrl+S. See app.js.
            if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'input', data: '\x18\x13' }));
                }
                return false;
            }

            const key = (e.key || '').toLowerCase();
            if (key === 'c' && (e.ctrlKey || e.metaKey)) {
                const selection = this.terminal.getSelection();
                if (selection) {
                    if (this.app && typeof this.app.copyToClipboard === 'function') {
                        this.app.copyToClipboard(selection);
                    } else if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(selection).catch(() => {});
                    }
                    this.terminal.clearSelection();
                    return false;
                }
            }
            return true;
        });

        // OSC 52 clipboard writes from programs in the terminal (e.g. Claude Code).
        this.terminal.parser.registerOscHandler(52, (payload) => {
            if (this.app && typeof this.app.handleOsc52 === 'function') {
                return this.app.handleOsc52(payload);
            }
            return true;
        });

        // Setup terminal input handler
        this.terminal.onData((data) => {
            // Drop xterm's focus reports (ESC[I / ESC[O), as the main view does:
            // a killed Claude can leave focus tracking on, and every click on
            // the other pane would otherwise reach the server as input — which,
            // to a stopped session, means "start it" (see 'info').
            const filtered = data.replace(/\x1b\[\[?[IO]/g, '');
            if (filtered && this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'input', data: filtered }));
            }
        });
        
        // Claude working in this pane shows on its session's tab, as it does for
        // the main terminal (app.js, claude-title.js).
        this.terminal.onTitleChange((title) => {
            const stm = this.app && this.app.sessionTabManager;
            if (!this.sessionId || !stm) return;
            const { working, topic } = ClaudeTitle.claudeTitleState(title);
            stm.setTabWorking(this.sessionId, working, topic);
        });

        // Setup resize handler
        this.terminal.onResize(({ cols, rows }) => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        });
        
        this.fit();
    }

    async setSession(sessionId) {
        if (this.sessionId === sessionId) return;
        
        // Disconnect from old session
        if (this.socket) {
            this.disconnect();
        }
        
        this.sessionId = sessionId;
        this.hibernated = false;

        // Connect to new session
        if (sessionId) {
            await this.connect(sessionId);
        }
        
        // Update active state
        this.updateActiveState();
    }

    async connect(sessionId) {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${location.host}?sessionId=${encodeURIComponent(sessionId)}`;
        
        // Add auth token if needed
        if (window.authManager) {
            wsUrl = window.authManager.getWebSocketUrl(wsUrl);
        }
        
        this.socket = new WebSocket(wsUrl);
        
        this.socket.onopen = () => {
            console.log(`[Split ${this.index}] Connected to session ${sessionId}`);
            // Send initial resize
            const { cols, rows } = this.terminal;
            this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
        };
        
        this.socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.handleMessage(msg);
            } catch (error) {
                console.error(`[Split ${this.index}] Error handling message:`, error);
            }
        };
        
        this.socket.onclose = () => {
            console.log(`[Split ${this.index}] Disconnected from session ${sessionId}`);
        };
        
        this.socket.onerror = (error) => {
            console.error(`[Split ${this.index}] WebSocket error:`, error);
        };
    }

    handleMessage(msg) {
        switch (msg.type) {
            case 'output':
                this.terminal.write(msg.data);
                break;
                
            case 'session_joined':
                if (msg.liveUsage && this.app && this.app.sessionTabManager) {
                    this.app.sessionTabManager.setTabUsage(this.sessionId, msg.liveUsage);
                }
                // Replay output buffer
                if (msg.outputBuffer && msg.outputBuffer.length > 0) {
                    const joined = msg.outputBuffer.join('');
                    this.terminal.write(joined);
                }
                // Not running: the same rule as the main view (2026-10-28) -
                // start it, with the options the new task dialog chose for
                // this very session, else the remembered defaults. A pane used
                // to sit on a stopped session with no way to start it, which is
                // what a task created while split looked like.
                // A session that already has a view in this page was stopped
                // where you could see it (or hibernated): its own state rules —
                // splitting must not restart a Claude you just stopped. A
                // hibernated one resumes when this pane is focused.
                if (!msg.active) {
                    const app = this.app;
                    const pending = app && app.pendingStart;
                    const view = app && app.views && app.views.get(this.sessionId);
                    if (pending && pending.sessionId === this.sessionId) {
                        app.pendingStart = null;
                        this.startClaude(pending.options);
                    } else if (view) {
                        this.hibernated = !!view.hibernated;
                    } else {
                        this.terminal.write(`\r\n\x1b[33m${this.alias()} is not running, starting with default options…\x1b[0m\r\n`);
                        this.startClaude(this.defaultStartOptions());
                    }
                }
                break;

            case 'claude_started':
                this.hibernated = false;
                if (this.sessionId && this.app && this.app.sessionTabManager) {
                    this.app.sessionTabManager.updateTabStatus(this.sessionId, 'active');
                }
                break;

            case 'claude_stopped':
                if (this.sessionId && this.app && this.app.sessionTabManager) {
                    this.app.sessionTabManager.setTabWorking(this.sessionId, false);
                }
                this.terminal.write(`\r\n\x1b[33m${this.alias()} stopped\x1b[0m\r\n`);
                break;

            case 'claude_hibernated': {
                // Same notice as the main view. Focusing the pane resumes it.
                this.hibernated = true;
                const stm = this.app && this.app.sessionTabManager;
                if (stm && this.sessionId) {
                    stm.setTabWorking(this.sessionId, false);
                    stm.updateTabStatus(this.sessionId, 'idle');
                }
                const why = msg.reason === 'cap'
                    ? `too many ${this.alias()} instances running at once`
                    : `idle for ${msg.idleMinutes} min`;
                this.terminal.write(`\r\n\x1b[2m[Hibernated] ${why}, so ${this.alias()} was stopped to save memory. The conversation resumes when you focus this pane.\x1b[0m\r\n`);
                if (this.isActive && document.visibilityState === 'visible') this.resumeIfHibernated();
                break;
            }

            case 'info':
                // "Claude is not running" after a keystroke: start it, as the
                // main view does for the view on screen — here, the focused
                // pane. A hibernated pane is resumed by focusing it instead.
                if (msg.message && msg.message.includes('not running') && this.isActive && !this.hibernated) {
                    this.startClaude(this.defaultStartOptions());
                }
                break;

            case 'session_deleted': {
                // Deleted in another window. If this pane is the only place the
                // page shows it, nothing else will close its tab.
                const id = msg.sessionId || this.sessionId;
                const stm = this.app && this.app.sessionTabManager;
                if (id && stm && stm.tabs.has(id)) {
                    stm.closeSession(id, { skipServerRequest: true });
                    if (this.app.showToast) this.app.showToast('This session was deleted in another window; its tab was closed', true, 5000);
                }
                break;
            }

            case 'exit':
                this.terminal.write('\r\n[Process exited]\r\n');
                if (this.sessionId && this.app && this.app.sessionTabManager) {
                    this.app.sessionTabManager.setTabWorking(this.sessionId, false);
                }
                break;
                
            case 'hook_event': {
                // The same handler as the main view (app.handleHookEvent). When
                // the session also has a connected view (a tab opened before the
                // split), that view handles it — twice doubled the notifications
                // and the plan dialog. A view whose socket died hears nothing,
                // so then the pane does.
                const app = this.app;
                if (!app || typeof app.handleHookEvent !== 'function') break;
                const view = app.views && app.views.get(this.sessionId);
                if (view && view.socket && view.socket.readyState === WebSocket.OPEN) break;
                app.handleHookEvent(msg, this.sessionId);
                break;
            }

            case 'error':
                this.terminal.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
                break;
        }
    }

    disconnect() {
        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) {
                // Ignore errors
            }
            this.socket = null;
        }
    }

    alias() {
        return (this.app && this.app.getAlias) ? this.app.getAlias() : 'Claude';
    }

    // Show this pane's jump button while it is scrolled up, hide it at the
    // bottom. Runs on every render, so it touches the DOM only when the answer
    // changes; placing it clear of the floating buttons happens only then.
    updateJump() {
        const btn = this.jumpBtn;
        if (!btn || !this.terminal) return;
        const buf = this.terminal.buffer && this.terminal.buffer.active;
        const away = !!buf && buf.baseY - buf.viewportY > 0;
        if (away === !btn.hasAttribute('hidden')) return;
        btn.toggleAttribute('hidden', !away);
        if (away && this.app && typeof this.app.keepPaneJumpClear === 'function') {
            this.app.keepPaneJumpClear(btn, this.container);
        }
    }

    // Back to this pane's newest screen, and give it the keyboard. The click
    // also reaches the pane, which focuses it.
    scrollToLatest() {
        try { this.terminal.scrollToBottom(); } catch (_) { /* disposed */ }
        try { this.terminal.focus(); } catch (_) {}
        this.updateJump();
    }

    defaultStartOptions() {
        return (this.app && this.app.startDefaultsOptions) ? this.app.startDefaultsOptions() : {};
    }

    // Start Claude on this pane's own socket, at this pane's size. The server
    // ignores a second start while one is in flight (server.startClaude).
    startClaude(options) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        const uiTheme = (this.app && this.app.currentUiTheme) ? this.app.currentUiTheme() : undefined;
        this.socket.send(JSON.stringify({
            type: 'start_claude', options: options || {}, uiTheme,
            cols: this.terminal.cols, rows: this.terminal.rows
        }));
    }

    resumeIfHibernated() {
        if (!this.hibernated) return;
        this.hibernated = false;
        const stm = this.app && this.app.sessionTabManager;
        const known = stm && stm.activeSessions.get(this.sessionId);
        if (known && known.status === 'active') return; // resumed elsewhere
        this.terminal.write(`\x1b[33mResuming ${this.alias()} conversation…\x1b[0m\r\n`);
        this.startClaude(this.defaultStartOptions());
    }

    fit() {
        try {
            if (this.fitAddon) {
                this.fitAddon.fit();
            }
        } catch (error) {
            // Ignore fit errors
        }
    }

    // Fit to the current cell size AND push the new dimensions to the PTY, so the
    // CLI (a full-screen TUI) reflows to fill the pane after a split/resize. fit()
    // alone only resizes the local xterm; without this the PTY keeps its old size
    // (often the default 80x24 from being opened while the pane was hidden) and the
    // CLI never redraws to the pane width.
    syncSize() {
        this.fit();
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const { cols, rows } = this.terminal;
            this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
    }

    updateActiveState() {
        if (this.container) {
            if (this.isActive) {
                this.container.classList.add('split-active');
            } else {
                this.container.classList.remove('split-active');
            }
        }
    }

    clear() {
        this.disconnect();
        this.sessionId = null;
        this.hibernated = false;
        this.isActive = false;
        if (this.terminal) {
            this.terminal.clear();
        }
        this.updateJump();
        this.updateActiveState();
    }

    destroy() {
        this.disconnect();
        if (this.terminal) {
            this.terminal.dispose();
        }
    }
}

class SplitContainer {
    constructor(app) {
        this.app = app;
        this.enabled = false;
        this.splits = [];
        this.activeSplitIndex = 0;
        this.dividerPosition = 50; // percentage (shared by both orientations)
        this.orientation = 'horizontal'; // 'horizontal' = left/right, 'vertical' = top/bottom
        
        // Create split container elements
        this.createSplitElements();
        
        // Restore state from localStorage
        this.restoreState();
        
        // Setup keyboard shortcuts
        this.setupKeyboardShortcuts();

        // Splitting is a width question, not a device question: a tablet in
        // landscape can carry two panes, a phone cannot. Re-evaluate on resize
        // and rotation, and fold an open split away if the window gets too narrow
        // (otherwise a rotation leaves two unusable slivers).
        this.syncSplitAvailability();
        window.addEventListener('resize', () => this.syncSplitAvailability());
        window.addEventListener('orientationchange', () => this.syncSplitAvailability());
    }

    // Two panes each need enough columns to be worth reading — about 40 at the
    // default cell width, so roughly 700px once the divider is counted. Below
    // that a split produces two unreadable slivers, so the feature steps aside.
    static get MIN_SPLIT_WIDTH() { return 700; }

    canSplit() {
        return window.innerWidth >= SplitContainer.MIN_SPLIT_WIDTH;
    }

    // Hide the entry point when it can't lead anywhere, and retreat to one pane
    // if the window has shrunk under an existing split.
    syncSplitAvailability() {
        const ok = this.canSplit();
        const btn = document.getElementById('layoutBtn');
        if (btn) btn.hidden = !ok;
        if (!ok && this.enabled) this.closeSplit();
    }

    createSplitElements() {
        const main = document.querySelector('.main');
        if (!main) return;

        // Create split container (initially hidden)
        this.splitContainerEl = document.createElement('div');
        this.splitContainerEl.className = 'split-container';
        this.splitContainerEl.style.display = 'none';

        // Refit the panes whenever the container changes size — the window,
        // the browser's side panel, full screen. Nothing did: the panes kept the
        // size they were split at, so shrinking the window left each xterm
        // hundreds of pixels wider and taller than its pane (measured: 776x846
        // drawn in a 497x605 pane) and Claude still laying out for the old
        // size — the status line and the bottom rows cut off at the pane edge.
        // A hidden container reports 0x0 and is skipped by the pane fit anyway.
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => this.scheduleRefit()).observe(this.splitContainerEl);
        }

        // Create left split
        const leftSplit = document.createElement('div');
        leftSplit.className = 'split-pane split-left';
        leftSplit.dataset.splitIndex = '0';

        // Create divider
        this.divider = document.createElement('div');
        this.divider.className = 'split-divider';
        this.setupDividerDrag();

        // Create right split
        const rightSplit = document.createElement('div');
        rightSplit.className = 'split-pane split-right';
        rightSplit.dataset.splitIndex = '1';

        // Add close button to right split
        const closeBtn = document.createElement('button');
        closeBtn.className = 'split-close';
        closeBtn.title = 'Close Split (Ctrl+\\)';
        closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>`;
        closeBtn.addEventListener('click', () => this.closeSplit());
        rightSplit.appendChild(closeBtn);

        this.splitContainerEl.appendChild(leftSplit);
        this.splitContainerEl.appendChild(this.divider);
        this.splitContainerEl.appendChild(rightSplit);

        main.appendChild(this.splitContainerEl);

        // Paste / drop an image into a pane: uploaded for that pane's session.
        if (this.app && typeof this.app.wireImageInput === 'function') {
            // undefined: not in a pane (current session); null: an empty pane,
            // which has no session to take it — not the other pane's.
            this.app.wireImageInput(this.splitContainerEl, this.splitContainerEl, (target) => {
                const el = target && target.closest ? target.closest('.split-pane') : null;
                const pane = el && this.splits.find(s => s.container === el);
                return pane ? (pane.sessionId || null) : undefined;
            });
        }

        // Apply the initial grid layout (columns vs rows) for the current orientation
        this.applyLayout();

        // Create Split instances with their own terminals
        this.splits.push(new Split(leftSplit, 0, this.app));
        this.splits.push(new Split(rightSplit, 1, this.app));
        
        // Mark left as active by default
        this.splits[0].isActive = true;
        this.splits[0].updateActiveState();

        // Click handlers to focus splits
        leftSplit.addEventListener('click', () => this.focusSplit(0));
        rightSplit.addEventListener('click', () => this.focusSplit(1));
    }

    setupDividerDrag() {
        let isDragging = false;
        let startCoord = 0;
        let startPosition = 50;

        this.divider.addEventListener('mousedown', (e) => {
            isDragging = true;
            const vertical = this.orientation === 'vertical';
            startCoord = vertical ? e.clientY : e.clientX;
            startPosition = this.dividerPosition;
            document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const vertical = this.orientation === 'vertical';
            const container = this.splitContainerEl.getBoundingClientRect();
            const delta = vertical ? (e.clientY - startCoord) : (e.clientX - startCoord);
            const extent = vertical ? container.height : container.width;
            const deltaPercent = (delta / extent) * 100;

            this.dividerPosition = Math.max(20, Math.min(80, startPosition + deltaPercent));
            this.updateDividerPosition();
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = '';
                this.saveState();
            }
        });
    }

    applyLayout() {
        if (!this.splitContainerEl) return;
        const a = this.dividerPosition;
        const b = 100 - this.dividerPosition;
        const paneTracks = `minmax(0, ${a}fr) 6px minmax(0, ${b}fr)`;
        if (this.orientation === 'vertical') {
            this.splitContainerEl.classList.add('vertical');
            this.splitContainerEl.style.gridTemplateColumns = 'minmax(0, 1fr)';
            this.splitContainerEl.style.gridTemplateRows = paneTracks;
        } else {
            this.splitContainerEl.classList.remove('vertical');
            this.splitContainerEl.style.gridTemplateRows = 'minmax(0, 1fr)';
            this.splitContainerEl.style.gridTemplateColumns = paneTracks;
        }
    }

    // Re-fit + resize each pane's PTY after the grid layout and renderer settle.
    scheduleRefit() {
        // Coalesced: a window drag fires the observer on every frame.
        if (this._refitPending) return;
        this._refitPending = true;
        const run = () => {
            this._refitPending = false;
            this.splits.forEach(s => s.syncSize());
            // Sizes changed (window, divider, orientation, swap): the panes'
            // jump buttons may now sit under the floating buttons.
            if (this.app && typeof this.app.reclearPaneJumps === 'function') this.app.reclearPaneJumps();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(run));
        } else {
            setTimeout(run, 50);
        }
    }

    updateDividerPosition() {
        this.applyLayout();
        this.scheduleRefit();
    }

    setOrientation(orientation) {
        if (orientation !== 'horizontal' && orientation !== 'vertical') return;
        if (this.orientation === orientation) return;
        this.orientation = orientation;
        this.applyLayout();
        this.scheduleRefit();
        this.saveState();
    }

    async applyPreset(orientation) {
        if (!this.canSplit()) return;
        if (this.enabled) {
            this.setOrientation(orientation);
            return;
        }
        let second = null;
        const stm = this.app && this.app.sessionTabManager;
        if (stm && typeof stm.getOrderedTabIds === 'function') {
            const ids = stm.getOrderedTabIds();
            second = ids.find(id => id !== this.app.currentClaudeSessionId) || null;
        }
        await this.createSplit(second, orientation);
    }

    openLayoutMenu(anchorEl) {
        if (!this.canSplit()) return;
        document.querySelectorAll('.pane-session-menu').forEach(m => m.remove());
        const menu = document.createElement('div');
        menu.className = 'pane-session-menu';
        const addItem = (label, fn, active) => {
            const el = document.createElement('div');
            el.className = 'pane-session-item' + (active ? ' used' : '');
            el.textContent = (active ? '\u2713 ' : '') + label;
            el.onclick = () => { try { fn(); } finally { menu.remove(); } };
            menu.appendChild(el);
        };
        addItem('Single', () => this.closeSplit(), !this.enabled);
        addItem('Split left / right', () => this.applyPreset('horizontal'), this.enabled && this.orientation === 'horizontal');
        addItem('Split top / bottom', () => this.applyPreset('vertical'), this.enabled && this.orientation === 'vertical');
        document.body.appendChild(menu);
        const rect = anchorEl ? anchorEl.getBoundingClientRect() : { bottom: 60, left: 60 };
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${Math.max(8, rect.left - 80)}px`;
        const close = (ev) => {
            if (!menu.contains(ev.target) && ev.target !== anchorEl) {
                menu.remove();
                document.removeEventListener('mousedown', close, true);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    }

    // Swap the two panes' sides (left<->right, or top<->bottom) by reordering
    // their DOM nodes. The terminals + sockets move with their elements (no
    // reconnect), the divider position is preserved, and the splits array /
    // click handlers stay index-correct because they map by element, not side.
    swapPanes() {
        if (!this.enabled || !this.splitContainerEl) return;
        const panes = [...this.splitContainerEl.querySelectorAll('.split-pane')];
        if (panes.length < 2) return;
        const [first, second] = panes;
        // Reorder to [second, divider, first].
        this.splitContainerEl.insertBefore(second, first);
        this.splitContainerEl.insertBefore(this.divider, first);
        this.applyLayout();
        this.scheduleRefit();
        this.saveState();
    }

    // Make the panes' left/right (or top/bottom) order follow the tab bar order.
    // Called after the user drags a tab to reorder it: if the two paned sessions'
    // relative order in the tab bar flipped, swap the panes to match.
    syncPaneOrderToTabs(tabOrder) {
        if (!this.enabled || !Array.isArray(tabOrder) || !this.splitContainerEl) return;
        const paneSessions = this.orderedSplits().map(s => s.sessionId);
        if (paneSessions.length < 2 || !paneSessions[0] || !paneSessions[1]) return;
        const iFirst = tabOrder.indexOf(paneSessions[0]);
        const iSecond = tabOrder.indexOf(paneSessions[1]);
        if (iFirst === -1 || iSecond === -1) return;
        if (iFirst > iSecond) this.swapPanes();
    }

    async createSplit(sessionId, orientation) {
        if (this.enabled) return; // Already split
        if (!this.canSplit()) return; // too narrow to be usable — see canSplit()

        this.enabled = true;
        if (orientation === 'horizontal' || orientation === 'vertical') {
            this.orientation = orientation;
        }
        // The page-wide jump button belongs to the single view: hide it now
        // (focusSplit, which also refreshes it, can return early).
        if (this.app && typeof this.app.refreshScrollBottom === 'function') this.app.refreshScrollBottom();

        // Hide single terminal container
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) {
            terminalContainer.style.display = 'none';
        }

        // Show split container (grid layout; applyLayout sets the tracks)
        this.splitContainerEl.style.display = 'grid';
        this.applyLayout();

        // Update divider position
        this.updateDividerPosition();

        // Set sessions - left gets current session, right gets the dragged session
        const currentSessionId = this.app.currentClaudeSessionId;
        // The main view steps back to an ordinary background view: it withdraws
        // its size vote (so it cannot pin the pty to its size while the pane
        // shows the session) but stays joined, keeping its scrollback for when
        // the split closes. It used to leaveSession(), which cleared that
        // terminal and, through session_left, nulled currentClaudeSessionId
        // just after the split had set it.
        if (typeof this.app.parkActiveView === 'function') {
            this.app.parkActiveView();
        }
        await this.splits[0].setSession(currentSessionId);
        await this.splits[1].setSession(sessionId);

        // Push correct pane dimensions to both PTYs once layout + sockets settle.
        this.scheduleRefit();

        // Keep the panes' left/right order consistent with the tab bar order, so
        // the tab labels always match the pane on that side (createSplit puts the
        // *current* session on the left, which may be the 2nd tab).
        const stm = this.app && this.app.sessionTabManager;
        if (stm && typeof stm.getOrderedTabIds === 'function') {
            this.syncPaneOrderToTabs(stm.getOrderedTabIds());
        }

        // Focus right split (newly created) - the left one when the right is empty.
        this.focusSplit(sessionId ? 1 : 0);
        // focusSplit returns early when that pane already had focus, so say
        // which session is current here rather than rely on it.
        const focused = this.splits[this.activeSplitIndex];
        this.app.currentClaudeSessionId = (focused && focused.sessionId) || currentSessionId;

        // Save state
        this.saveState();

        console.log(`[SplitContainer] Created split with sessions: ${currentSessionId} | ${sessionId}`);
    }

    // NOTE: closeSplit hands the screen back to the main terminal, so the jump
    // button has to ask it where it is (see the end of this method).
    // target: the session to show afterwards (default: the focused pane's).
    // rejoin:false leaves the choice to the caller (a tab close that switches
    // on its own).
    closeSplit({ target = null, rejoin = true } = {}) {
        if (!this.enabled) return;

        this.enabled = false;

        // Capture which session to show BEFORE we clear the panes' sessionIds:
        // the focused pane's, which is what the user was looking at.
        const activePane = this.splits[this.activeSplitIndex];
        const rejoinId = target
            || (activePane && activePane.sessionId)
            || this.app.currentClaudeSessionId
            || (this.splits[0] && this.splits[0].sessionId)
            || null;

        // Disconnect both splits
        this.splits.forEach(split => split.disconnect());

        // Show single terminal container
        const terminalContainer = document.getElementById('terminalContainer');
        if (terminalContainer) {
            terminalContainer.style.display = 'flex';
        }

        // Hide split container
        this.splitContainerEl.style.display = 'none';

        // Clear splits but don't destroy terminals (we'll reuse them)
        this.splits.forEach((split, i) => {
            split.sessionId = null;
            split.hibernated = false;
            split.isActive = (i === 0);
            split.updateActiveState();
            if (split.terminal) {
                split.terminal.clear();
            }
            if (split.updateJump) split.updateJump();
        });

        this.activeSplitIndex = 0;

        // Show that session's own view, the way a tab switch does: a view that
        // already exists (the one parked on entering) comes back with its
        // scrollback and re-asserts its size; one that does not is built and
        // joined. This used to joinSession() on whatever socket was current,
        // which, with the other pane focused, put tab A's terminal on session B.
        if (rejoin && rejoinId) {
            const stm = this.app.sessionTabManager;
            if (stm && stm.tabs.has(rejoinId)) {
                stm.switchToTab(rejoinId);
            } else if (typeof this.app.showSession === 'function') {
                this.app.showSession(rejoinId);
            }
        }

        // Save state
        this.saveState();

        console.log('[SplitContainer] Closed split, back to single pane');
        if (this.app && this.app.refreshScrollBottom) this.app.refreshScrollBottom();
    }

    // Panes in DOM order (left→right / top→bottom). swapPanes only moves the DOM
    // nodes, so this is the only order that matches what the user sees.
    orderedSplits() {
        if (!this.splitContainerEl) return [...this.splits];
        return [...this.splitContainerEl.querySelectorAll('.split-pane')]
            .map(el => this.splits.find(s => s.container === el))
            .filter(Boolean);
    }

    // Focus the pane at a visual position, whatever its splits[] index is.
    focusPaneAt(position) {
        const split = this.orderedSplits()[position];
        if (!split) return;
        const index = this.splits.indexOf(split);
        if (index !== -1) this.focusSplit(index);
    }

    focusSplit(index) {
        if (index < 0 || index >= this.splits.length) return;
        if (this.activeSplitIndex === index) return;

        // Update active state
        this.splits.forEach((split, i) => {
            split.isActive = (i === index);
            split.updateActiveState();
        });

        this.activeSplitIndex = index;
        // The jump-to-latest button now answers for this pane.
        if (this.app && this.app.refreshScrollBottom) this.app.refreshScrollBottom();

        // Focus the terminal in this split
        const split = this.splits[index];
        if (split.terminal) {
            split.terminal.focus();
        }
        split.resumeIfHibernated();

        // Update app's current session to match this split
        if (split.sessionId && this.app) {
            this.app.currentClaudeSessionId = split.sessionId;
            
            // Update tab selection
            if (this.app.sessionTabManager) {
                const tab = this.app.sessionTabManager.tabs.get(split.sessionId);
                if (tab) {
                    // Update visual state of tabs
                    this.app.sessionTabManager.tabs.forEach((t, id) => {
                        if (id === split.sessionId) {
                            t.classList.add('active');
                        } else {
                            t.classList.remove('active');
                        }
                    });
                    this.app.sessionTabManager.activeTabId = split.sessionId;
                }
            }
        }

        console.log(`[SplitContainer] Focused split ${index}, session: ${split.sessionId}`);
    }

    // Called when a tab is switched - update the active split's session
    async onTabSwitch(sessionId) {
        if (!this.enabled) return;

        // If the session is already shown in a pane, just focus that pane —
        // don't load it a second time (that would double-attach the same PTY).
        const existing = this.splits.findIndex(s => s.sessionId === sessionId);
        if (existing !== -1) {
            if (existing !== this.activeSplitIndex) {
                this.focusSplit(existing);
            } else if (this.app) {
                this.app.currentClaudeSessionId = sessionId;
                this.splits[existing].resumeIfHibernated();
            }
            return;
        }

        // Otherwise load it into the active pane.
        const activeSplit = this.splits[this.activeSplitIndex];
        if (activeSplit) {
            await activeSplit.setSession(sessionId);
            if (this.app) this.app.currentClaudeSessionId = sessionId;
            this.scheduleRefit();
            this.saveState();
        }
    }

    // A tab was closed (here, or deleted in another window). If a pane shows
    // it, fold the split away onto the other pane's session; that switch sets
    // activeTabId before its first await, so the closing tab manager does not
    // also switch to a fallback of its own. With no other session, leave the
    // switch to the tab manager.
    onSessionClosed(sessionId) {
        if (!this.enabled || !sessionId) return;
        const pane = this.splits.find(s => s.sessionId === sessionId);
        if (!pane) return;
        const other = this.splits.find(s => s !== pane && s.sessionId);
        this.closeSplit(other ? { target: other.sessionId } : { rejoin: false });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Cmd/Ctrl + \ to toggle split
            if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
                e.preventDefault();
                if (this.enabled) {
                    this.closeSplit();
                } else if (this.canSplit()) {
                    this.applyPreset('horizontal');
                }
            }
            
            // Cmd/Ctrl + 1/2 to focus the first/second pane. By POSITION, not by
            // splits[] index: swapPanes reorders the DOM without touching the
            // array, so after a swap splits[0] is the pane on the right.
            if ((e.metaKey || e.ctrlKey) && this.enabled) {
                if (e.key === '1') {
                    e.preventDefault();
                    this.focusPaneAt(0);
                } else if (e.key === '2') {
                    e.preventDefault();
                    this.focusPaneAt(1);
                }
            }
        });
    }

    saveState() {
        try {
            const state = {
                enabled: this.enabled,
                orientation: this.orientation,
                dividerPosition: this.dividerPosition,
                activeSplitIndex: this.activeSplitIndex,
                // DOM order, so a swapPanes() is actually reflected in what we save.
                sessions: this.orderedSplits().map(s => s.sessionId)
            };
            localStorage.setItem('cc-web-splits', JSON.stringify(state));
        } catch (error) {
            console.error('Failed to save split state:', error);
        }
    }

    restoreState() {
        try {
            const saved = localStorage.getItem('cc-web-splits');
            if (!saved) return;

            const state = JSON.parse(saved);
            
            // Restore divider position + orientation preference
            if (state.dividerPosition) {
                this.dividerPosition = state.dividerPosition;
            }
            if (state.orientation === 'horizontal' || state.orientation === 'vertical') {
                this.orientation = state.orientation;
            }

            // Note: Don't auto-restore enabled state on page load
            // User needs to manually create splits
            // This prevents issues with stale session IDs
        } catch (error) {
            console.error('Failed to restore split state:', error);
        }
    }

    // Setup drop zones for drag-to-split. Right edge -> left/right split,
    // bottom edge -> top/bottom split.
    setupDropZones() {
        const terminalContainer = document.getElementById('terminalContainer');
        if (!terminalContainer) return;

        const dropZone = document.createElement('div');
        dropZone.className = 'split-drop-zone';
        dropZone.style.display = 'none';
        terminalContainer.appendChild(dropZone);

        const edgeAt = (e, rect) => {
            const distRight = rect.right - e.clientX;
            const distBottom = rect.bottom - e.clientY;
            const nearRight = distRight < 120;
            const nearBottom = distBottom < 120;
            if (nearBottom && (!nearRight || distBottom <= distRight)) return 'vertical';
            if (nearRight) return 'horizontal';
            return null;
        };

        const isSessionDrag = (e) =>
            !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('application/x-session-id');

        terminalContainer.addEventListener('dragover', (e) => {
            if (!this.canSplit()) return; // no drop hint for a split we'd refuse
            if (this.enabled || !isSessionDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = terminalContainer.getBoundingClientRect();
            const edge = edgeAt(e, rect);
            if (edge) {
                dropZone.classList.toggle('bottom', edge === 'vertical');
                dropZone.style.display = 'block';
            } else {
                dropZone.style.display = 'none';
            }
        });

        terminalContainer.addEventListener('dragleave', () => { dropZone.style.display = 'none'; });

        terminalContainer.addEventListener('drop', async (e) => {
            dropZone.style.display = 'none';
            const sessionId = e.dataTransfer && e.dataTransfer.getData('application/x-session-id');
            if (!sessionId || this.enabled) return;
            if (sessionId === this.app.currentClaudeSessionId) return;
            const rect = terminalContainer.getBoundingClientRect();
            const edge = edgeAt(e, rect);
            if (edge) {
                e.preventDefault();
                await this.createSplit(sessionId, edge);
            }
        });
    }

}

// Export for use in app.js
window.SplitContainer = SplitContainer;
