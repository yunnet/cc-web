const assert = require('assert');
const fs = require('fs');
const path = require('path');
const VIEWPORT = require('../src/public/viewport-mode');

// A soft keyboard and a real resize demand opposite responses. Re-fitting for a
// keyboard sends the shrunken row count to the pty and Claude re-lays-out its
// whole UI for it — measured on a phone, 38 rows became 21, leaving a 14-row
// content area, so replies scrolled away after a dozen lines and every keyboard
// open/close split the history in two.
describe('soft keyboard vs real viewport change', function () {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const phone = { width: 390, height: 844 };

  describe('detection', function () {
    it('calls a big height drop at unchanged width a keyboard', function () {
      assert.strictEqual(VIEWPORT.isKeyboardOpen(phone, { width: 390, height: 464 }), true);
      assert.strictEqual(VIEWPORT.isKeyboardOpen(phone, { width: 390, height: 380 }), true);
    });

    it('does not call a rotation a keyboard', function () {
      // Width changed: the usable area really is different and the terminal
      // must re-fit, or it would stay frozen at the old geometry.
      assert.strictEqual(VIEWPORT.isKeyboardOpen(phone, { width: 844, height: 390 }), false);
    });

    it('ignores the small shrink from browser chrome', function () {
      // The URL bar sliding in takes a few percent. Treating that as a keyboard
      // would freeze the terminal size during ordinary scrolling.
      assert.strictEqual(VIEWPORT.isKeyboardOpen(phone, { width: 390, height: 800 }), false);
    });

    it('says no when it has nothing to measure', function () {
      for (const [l, v] of [[null, { width: 1, height: 1 }], [phone, null],
                            [phone, { width: 390, height: 0 }],
                            [{ width: 390, height: 0 }, { width: 390, height: 0 }]]) {
        assert.strictEqual(VIEWPORT.isKeyboardOpen(l, v), false);
      }
    });

    it('needs a real fraction of the screen, not a pixel', function () {
      assert.ok(VIEWPORT.KEYBOARD_MIN_SHRINK >= 0.1,
        'too low a threshold turns ordinary chrome into a keyboard');
    });
  });

  describe('wiring', function () {
    const APP = read('src', 'public', 'app.js');
    const CSS = read('src', 'public', 'style.css');
    const HTML = read('src', 'public', 'index.html');

    it('short-circuits before the re-fit, not after', function () {
      // After fitTerminal() the damage is already done — the new row count has
      // gone to the pty and Claude has re-laid-out.
      const fn = /scheduleRefit = \(\) => \{([\s\S]*?)\n        \};/.exec(APP);
      assert.ok(fn, 'scheduleRefit is gone');
      const kb = fn[1].indexOf('applyKeyboardMode');
      const fit = fn[1].indexOf('this.fitTerminal()');
      assert.ok(kb > -1 && fit > -1, 'keyboard branch or fit call is missing');
      assert.ok(kb < fit, 'the keyboard check must come before fitTerminal');
    });

    it('scrolls the frame rather than the terminal', function () {
      // xterm clips instead of scrolling when its own container is too short:
      // its viewport never becomes scrollable and the last rows — where the
      // input box lives — are unreachable. Verified in a browser.
      const rule = /\.terminal-container\.kb-open\s*\{[^}]*\}/.exec(CSS);
      assert.ok(rule, '.terminal-container.kb-open rule is gone');
      assert.ok(/overflow-y:\s*auto/.test(rule[0]), 'the frame must scroll');
      assert.ok(/overscroll-behavior:\s*contain/.test(rule[0]),
        'the frame must not chain its scroll out to the page');
    });

    it('parks the frame at the end so the input box is what shows', function () {
      const fn = /applyKeyboardMode\s*\(\)\s*\{([\s\S]*?)\n    \}/.exec(APP);
      assert.ok(fn, 'applyKeyboardMode is gone');
      assert.ok(/scrollTop = .*scrollHeight/.test(fn[1]),
        'the frame must be scrolled to the bottom while the keyboard is up');
    });

    it('undoes itself when the keyboard closes', function () {
      // Left on, the frame would keep a fixed height and FitAddon would measure
      // the wrong thing for the rest of the session.
      const fn = /applyKeyboardMode\s*\(\)\s*\{([\s\S]*?)\n    \}/.exec(APP);
      assert.ok(/removeProperty\('height'\)/.test(fn[1]), 'the fixed height must be removed');
      assert.ok(/classList\.remove\('kb-open'\)/.test(fn[1]), 'the class must be removed');
    });

    it('is mobile-only', function () {
      const fn = /applyKeyboardMode\s*\(\)\s*\{([\s\S]*?)\n    \}/.exec(APP);
      assert.ok(/this\.isMobile/.test(fn[1]), 'desktop must never enter keyboard mode');
    });

    it('loads the detector before app.js needs it', function () {
      const v = HTML.indexOf('viewport-mode.js');
      const a = HTML.indexOf('app.js"');
      assert.ok(v > -1 && v < a, 'viewport-mode.js must load before app.js');
    });
  });
});
