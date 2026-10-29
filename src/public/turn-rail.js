// turn-rail.js — the right-edge anchors of a conversation (DSH's turn rail,
// on a real terminal): a minimap strip of ticks, one per question, and a
// question LIST that opens on hover — the row matching where you are looking
// is highlighted and focused, clicking any row jumps there.
//
// The anchors ARE the terminal: Claude's TUI renders every submitted
// question as a line starting with ❯ (or >), so the buffer is scanned for
// those lines and each becomes an anchor at its own row — no matching against
// a separate list, so nothing can fail to match (a transcript-matching
// version was tried first and returned zero anchors for exactly the sessions
// the rail is FOR: long agentic runs whose early turns had already been
// trimmed out of the replayed output buffer). Redraws reprint the same
// question on new rows; the LAST occurrence of each text wins.
//
// Honest limits, by design: questions whose rendering no longer survives in
// the buffer get no tick; the live turn's own ❯ — the input box — sits below
// the scan ceiling and never anchors. The rail hides when the terminal area
// is 900px wide or less (DSH's rule).

class TurnRail {
    constructor(view, app) {
        this.view = view;
        this.app = app;
        this.marks = [];     // [{i, text, row}] — the buffer's question lines
        this._hideTimer = null;
        // The highlight a click CHOSE. The viewport-derived guess is wrong in
        // exactly the case clicks happen for: the next question less than
        // half a screen below takes the "current" title, and the periodic
        // viewport recompute would flip a click's choice right back. The lock
        // holds until the reader actually scrolls away from it.
        this._currentLock = null;

        this.el = document.createElement('div');
        this.el.className = 'turn-rail';
        this.el.setAttribute('aria-hidden', 'true');
        view.el.appendChild(this.el);
        view.turnRail = this;

        // Hovering the strip opens the question list; the list itself keeps
        // the hover alive (a shared hide timer bridges the gap between the
        // two elements).
        this.el.addEventListener('pointerenter', () => this.openList());
        this.el.addEventListener('pointerleave', () => this.scheduleHide());

        // Follow the reader: while the list is open, scrolling the terminal
        // moves the highlight along (throttled — a wheel gesture fires a lot).
        try {
            this._scrollDisp = view.terminal.onScroll(() => this.onTermScroll());
        } catch (_) { /* a build without onScroll: the interval still follows */ }
    }

    onTermScroll() {
        if (this._scrollThrottle) return;
        this._scrollThrottle = setTimeout(() => {
            this._scrollThrottle = null;
            if (this.listEl && this.listEl.isConnected) this.highlightCurrent();
        }, 120);
    }

    dispose() {
        clearTimeout(this._hideTimer);
        clearTimeout(this._scrollThrottle);
        try { this._scrollDisp?.dispose?.(); } catch (_) {}
        this.closeList();
        this.el.remove();
        if (this.view.turnRail === this) this.view.turnRail = null;
    }

    static normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    // One pass over the buffer below the live input area: every line that
    // starts with the TUI's question marker is an anchor. A question asked
    // verbatim twice keeps one mark (the later row).
    scan(buf, ceiling) {
        const seen = new Map();
        for (let y = 0; y < ceiling; y++) {
            const line = buf.getLine(y);
            if (!line) continue;
            const raw = line.translateToString(true);
            if (raw.length < 2) continue;
            const marker = raw[0];
            if ((marker !== '❯' && marker !== '>') || raw[1] !== ' ') continue;
            const text = TurnRail.normalize(raw.slice(2));
            if (!text) continue;
            seen.set(text, { text: text.slice(0, 160), row: y });
        }
        return [...seen.values()]
            .sort((a, b) => a.row - b.row)
            .map((m, i) => ({ i, text: m.text, row: m.row }));
    }

    refresh() {
        const term = this.view.terminal;
        if (!term || !this.el.isConnected) return;

        // DSH's rule: no rail on a narrow transcript (the viewport width, not
        // the browser window's).
        this.el.classList.toggle('rail-hidden', this.view.el.clientWidth <= 900);

        const buf = term.buffer.active;
        // The live screen's bottom rows are the input box and its frame —
        // anchors live above them; completed conversation content may still be
        // inside the live region (rendered text, not the spinner).
        const ceiling = Math.max(0, buf.baseY + term.rows - 6);
        this.marks = this.scan(buf, ceiling);

        this.el.innerHTML = '';
        const total = Math.max(1, buf.length);
        for (const m of this.marks) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'turn-mark';
            btn.style.top = `${(m.row / total) * 100}%`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.jump(m.row);
            });
            this.el.appendChild(btn);
        }
        if (this.listEl && this.listEl.isConnected) this.renderList();
    }

    // Cheap pass between full scans: scrollback rows never move, so the ticks
    // only need their heights re-derived against the current buffer length —
    // and an open list re-derives which question the viewport is on.
    reposition() {
        const term = this.view.terminal;
        if (!term || !this.el.isConnected) return;
        const buf = term.buffer.active;
        const total = Math.max(1, buf.length);
        const buttons = this.el.querySelectorAll('.turn-mark');
        this.marks.forEach((m, i) => {
            const btn = buttons[i];
            if (btn) btn.style.top = `${(m.row / total) * 100}%`;
        });
        if (this.listEl && this.listEl.isConnected) this.highlightCurrent();
    }

    // ---- the question list -------------------------------------------------

    // Which question the reader is on: a click's own choice while its target
    // is still what the viewport shows (within a screen of the lock), else
    // the last anchor at or above the viewport's middle. Above the first
    // anchor, the first question is current (that is where reading began).
    currentMark() {
        if (!this.marks.length) return null;
        const term = this.view.terminal;
        const buf = term.buffer.active;
        if (this._currentLock) {
            if (Math.abs(buf.viewportY - this._currentLock.row) <= term.rows) return this._currentLock;
            this._currentLock = null; // the reader moved on
        }
        const center = buf.viewportY + Math.floor(term.rows / 2);
        let current = this.marks[0];
        for (const m of this.marks) {
            if (m.row <= center) current = m;
            else break;
        }
        return current;
    }

    openList() {
        clearTimeout(this._hideTimer);
        if (!this.listEl || !this.listEl.isConnected) {
            const list = document.createElement('div');
            list.className = 'turn-rail-list';
            list.setAttribute('aria-hidden', 'true');
            list.addEventListener('pointerenter', () => clearTimeout(this._hideTimer));
            list.addEventListener('pointerleave', () => this.scheduleHide());
            this.view.el.appendChild(list);
            this.listEl = list;
            this.renderList();
        }
    }

    scheduleHide() {
        clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => this.closeList(), 250);
    }

    closeList() {
        if (this.listEl) {
            this.listEl.remove();
            this.listEl = null;
        }
    }

    renderList() {
        const list = this.listEl;
        if (!list) return;
        list.innerHTML = '';
        if (!this.marks.length) {
            list.innerHTML = '<div class="turn-rail-list-empty">这个会话里还没有留下提问</div>';
            return;
        }
        const current = this.currentMark();
        for (const m of this.marks) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'turn-rail-row' + (current && m.i === current.i ? ' current' : '');
            row.textContent = m.text;
            row.title = m.text;
            row.dataset.markIndex = String(m.i);
            row.addEventListener('click', () => {
                // The highlight is the click's own choice, applied THIS tick —
                // not something the viewport gets to re-derive a beat later.
                this._currentLock = m;
                this.highlightCurrent();
                this.jump(m.row);
            });
            list.appendChild(row);
        }
        // Focus the current question: the list opens already scrolled to
        // where the reader is.
        const cur = list.querySelector('.turn-rail-row.current');
        if (cur) cur.scrollIntoView({ block: 'center' });
    }

    highlightCurrent() {
        const list = this.listEl;
        if (!list || !list.isConnected) return;
        const current = this.currentMark();
        const rows = list.querySelectorAll('.turn-rail-row');
        rows.forEach(r => r.classList.toggle('current', current ? Number(r.dataset.markIndex) === current.i : false));
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
