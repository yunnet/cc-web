// turn-rail.js — the right-edge anchors of a conversation: one mark per
// question the user asked, hover previews it, click jumps the terminal there.
// (DSH's turn rail; here the conversation is a real terminal, so the anchor
// list comes from the transcript — GET /api/sessions/:id/prompts, reusing
// claude-history's parsing — and each prompt is located in the xterm buffer
// by normalized-prefix matching. Marks are proportional over the whole
// buffer, minimap-style.)
//
// Honest limits, by design: a prompt that cannot be matched (rendering
// variance, or it predates the rebuilt buffer after a reload) simply gets no
// mark — nothing is fabricated; and the rail hides when the terminal area is
// 900px wide or less (DSH's rule).

class TurnRail {
    constructor(view, app) {
        this.view = view;
        this.app = app;
        this.prompts = [];   // [{i, text, ts}] from the API
        this.marks = [];     // [{i, text, row}] — the matched subset, in order
        this._lastFetch = 0;
        this._fetching = false;

        this.el = document.createElement('div');
        this.el.className = 'turn-rail';
        this.el.setAttribute('aria-hidden', 'true');
        view.el.appendChild(this.el);
        view.turnRail = this;
    }

    dispose() {
        this.hideTooltip();
        this.el.remove();
        if (this.view.turnRail === this) this.view.turnRail = null;
    }

    // The shared tooltip: one element for every rail (it follows the pointer).
    static tooltipEl() {
        let el = document.getElementById('turnRailTip');
        if (!el) {
            el = document.createElement('div');
            el.id = 'turnRailTip';
            el.className = 'turn-rail-tip';
            el.hidden = true;
            document.body.appendChild(el);
        }
        return el;
    }

    showTooltip(text, x, y) {
        const tip = TurnRail.tooltipEl();
        tip.textContent = text;
        tip.hidden = false;
        tip.style.left = `${Math.max(8, x - tip.offsetWidth - 18)}px`;
        tip.style.top = `${Math.min(window.innerHeight - tip.offsetHeight - 8, Math.max(8, y - 14))}px`;
    }

    hideTooltip() {
        const tip = document.getElementById('turnRailTip');
        if (tip) tip.hidden = true;
    }

    // The anchor list. Throttled — it rides along with output activity, so a
    // 5s floor keeps a chatty session from hammering the transcript read.
    async maybeFetch(force = false) {
        const sid = this.view.sessionId;
        if (!sid || this._fetching) return;
        const now = Date.now();
        if (!force && now - this._lastFetch < 5000) return;
        this._fetching = true;
        this._lastFetch = now;
        try {
            const res = await this.app.authFetch(`/api/sessions/${encodeURIComponent(sid)}/prompts`);
            if (!res || !res.ok) return;
            const data = await res.json();
            this.prompts = Array.isArray(data.prompts) ? data.prompts : [];
            this.refresh();
        } catch (_) { /* offline: keep the marks we have */ } finally {
            this._fetching = false;
        }
    }

    // Prompt text → buffer row. One line of the TUI holds `> ` plus the first
    // wrapped segment of the question, so the needle is the question's first
    // 20 visible chars, whitespace-collapsed; the pair (line, line+1) covers
    // a needle unlucky enough to straddle a wrap. Newest prompt first, each
    // search starting above the previous hit — rows come out monotonic.
    static normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').replace(/^>\s*/, '').trim();
    }

    findRow(buf, text, searchFrom) {
        const needle = TurnRail.normalize(text).slice(0, 20);
        if (!needle) return -1;
        for (let y = searchFrom; y >= 0; y--) {
            const line = buf.getLine(y);
            if (!line) continue;
            const one = TurnRail.normalize(line.translateToString(true));
            if (one.includes(needle)) return y;
            const next = y + 1 <= searchFrom ? buf.getLine(y + 1) : null;
            if (next && TurnRail.normalize(one + ' ' + next.translateToString(true)).includes(needle)) return y;
        }
        return -1;
    }

    refresh() {
        const term = this.view.terminal;
        if (!term || !this.el.isConnected) return;

        // DSH's rule: no rail on a narrow transcript (the viewport width, not
        // the browser window's).
        this.el.classList.toggle('rail-hidden', this.view.el.clientWidth <= 900);

        const buf = term.buffer.active;
        // The live screen's bottom rows are the input box and its frame —
        // anchors live above them. Completed conversation content may still be
        // inside the live region; it is rendered text, not the spinner, and
        // the throttled refresh keeps it honest while it redraws.
        const ceiling = Math.max(0, buf.baseY + term.rows - 6);
        const marks = [];
        let searchFrom = ceiling;
        for (let p = this.prompts.length - 1; p >= 0 && searchFrom >= 0; p--) {
            const row = this.findRow(buf, this.prompts[p].text, searchFrom);
            if (row < 0) continue;
            marks.unshift({ i: this.prompts[p].i, text: this.prompts[p].text, row });
            searchFrom = row - 1;
        }
        this.marks = marks;

        this.el.innerHTML = '';
        const total = Math.max(1, buf.length);
        for (const m of marks) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'turn-mark';
            btn.style.top = `${(m.row / total) * 100}%`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.jump(m.row);
            });
            btn.addEventListener('mouseenter', (e) => this.showTooltip(m.text, e.clientX, e.clientY));
            btn.addEventListener('mousemove', (e) => this.showTooltip(m.text, e.clientX, e.clientY));
            btn.addEventListener('mouseleave', () => this.hideTooltip());
            this.el.appendChild(btn);
        }
    }

    // Cheap pass between fetches: scrollback rows never move, so the ticks
    // only need their heights re-derived against the current buffer length.
    // (A full re-match runs when a fetch lands, or on demand.)
    reposition() {
        const term = this.view.terminal;
        if (!term || !this.el.isConnected) return;
        const total = Math.max(1, term.buffer.active.length);
        const buttons = this.el.querySelectorAll('.turn-mark');
        this.marks.forEach((m, i) => {
            const btn = buttons[i];
            if (btn) btn.style.top = `${(m.row / total) * 100}%`;
        });
    }

    jump(row) {
        const term = this.view.terminal;
        if (!term) return;
        const buf = term.buffer.active;
        try {
            // scrollToLine is the natural API; scrollLines covers a build that
            // lacks it (target row minus the viewport's top row = lines to go).
            if (typeof term.scrollToLine === 'function') term.scrollToLine(row);
            else term.scrollLines(row - buf.viewportY);
        } catch (_) { /* disposed mid-jump */ }
        if (this.app.updateScrollBottom) this.app.updateScrollBottom(term);
    }
}

window.TurnRail = TurnRail;
