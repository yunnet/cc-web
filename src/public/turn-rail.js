// turn-rail.js — the right-edge anchors of a conversation: one mark per
// question, hover previews it, click jumps the terminal there. (DSH's turn
// rail, on a real terminal.)
//
// The marks ARE the terminal: Claude's TUI renders every submitted question
// as a line starting with ❯ (or >), so the buffer is scanned for those lines
// and each becomes an anchor at its own row — no matching against a separate
// list, so nothing can fail to match (a transcript-matching version was
// tried first and returned zero anchors for exactly the sessions the rail is
// FOR: long agentic runs whose early turns had already been trimmed out of
// the replayed output buffer). Redraws reprint the same question on new rows;
// the LAST occurrence of each text wins, so repeats collapse to one mark.
//
// Honest limits, by design: questions whose rendering no longer survives in
// the buffer (older than the replayed tail after a reload) get no mark, and
// the live turn's own ❯ — the input box — sits below the scan ceiling and
// never anchors. The rail hides when the terminal area is 900px wide or less
// (DSH's rule).

class TurnRail {
    constructor(view, app) {
        this.view = view;
        this.app = app;
        this.marks = [];     // [{i, text, row}] — the buffer's question lines
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
            btn.addEventListener('mouseenter', (e) => this.showTooltip(m.text, e.clientX, e.clientY));
            btn.addEventListener('mousemove', (e) => this.showTooltip(m.text, e.clientX, e.clientY));
            btn.addEventListener('mouseleave', () => this.hideTooltip());
            this.el.appendChild(btn);
        }
    }

    // Cheap pass between full scans: scrollback rows never move, so the ticks
    // only need their heights re-derived against the current buffer length.
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
