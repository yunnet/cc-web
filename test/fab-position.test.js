const assert = require('assert');
const fs = require('fs');
const path = require('path');
const FAB = require('../src/public/fab-position');

// The mobile ESC/MODE buttons became draggable. Two things decide whether that
// is usable or infuriating: the position must survive a rotation and a smaller
// screen without stranding the buttons off-view, and a tap must not be read as
// a drag. The geometry lives in its own file so it can be tested for real
// rather than grepped for.
describe('mobile fab position', function () {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  const phone = { viewportHeight: 844, fabHeight: 122, topInset: 44, bottomInset: 34 };

  describe('clamping', function () {
    it('keeps the stack clear of the tab bar and the bottom safe area', function () {
      assert.strictEqual(FAB.clampTop(-500, phone), 44, 'must not slide under the tab bar');
      assert.strictEqual(FAB.clampTop(99999, phone), 844 - 122 - 34, 'must not slide past the safe area');
      assert.strictEqual(FAB.clampTop(400, phone), 400, 'a legal position is left alone');
    });

    it('degrades to the top edge when the viewport is too short to fit', function () {
      // Landscape on a small phone with the keyboard up: there is no legal
      // range left, and returning something off-screen would lose the buttons.
      const squished = { viewportHeight: 120, fabHeight: 122, topInset: 44, bottomInset: 34 };
      assert.strictEqual(FAB.clampTop(60, squished), 44);
    });
  });

  describe('snapping', function () {
    it('settles against the nearer edge', function () {
      assert.strictEqual(FAB.snapSide(50, 390, 'right'), 'left');
      assert.strictEqual(FAB.snapSide(340, 390, 'left'), 'right');
    });

    it('keeps the current side on an exact tie, so it does not flip on every drag', function () {
      assert.strictEqual(FAB.snapSide(195, 390, 'left'), 'left');
      assert.strictEqual(FAB.snapSide(195, 390, 'right'), 'right');
    });
  });

  describe('stored values', function () {
    it('accepts a well-formed position', function () {
      assert.deepStrictEqual(FAB.normalize({ side: 'left', yRatio: 0.4 }), { side: 'left', yRatio: 0.4 });
    });

    it('rejects anything it cannot use rather than guessing', function () {
      // Older build, hand-edited storage, another device. null means "fall back
      // to the automatic position", which is always safe.
      for (const bad of [null, undefined, 'left', 42, {}, { side: 'up', yRatio: 0.5 },
                         { side: 'left' }, { side: 'left', yRatio: 'x' },
                         { side: 'left', yRatio: NaN }, { side: 'left', yRatio: Infinity }]) {
        assert.strictEqual(FAB.normalize(bad), null, `should reject ${JSON.stringify(bad)}`);
      }
    });

    it('clamps a ratio that is out of range instead of discarding it', function () {
      assert.deepStrictEqual(FAB.normalize({ side: 'right', yRatio: 5 }), { side: 'right', yRatio: 1 });
      assert.deepStrictEqual(FAB.normalize({ side: 'right', yRatio: -2 }), { side: 'right', yRatio: 0 });
    });
  });

  describe('rotation', function () {
    it('lands in the same relative place after a rotate, still on screen', function () {
      const portrait = phone;
      const landscape = { viewportHeight: 390, fabHeight: 122, topInset: 44, bottomInset: 34 };

      const top = 500;                                   // dragged low in portrait
      const ratio = FAB.ratioFromTop(top, portrait);
      const after = FAB.topFromRatio(ratio, landscape);

      // 500px down a 844px screen is past the bottom of a 390px one; the ratio
      // plus the clamp is what keeps it reachable.
      assert.ok(after >= 44 && after <= 390 - 122 - 34, `landed at ${after}, off screen`);
    });

    it('survives a saved position from a taller device', function () {
      const top = FAB.topFromRatio(0.99, phone);
      assert.ok(top <= 844 - 122 - 34, `bottom-most ratio must still clamp, got ${top}`);
    });
  });

  describe('wiring', function () {
    const CSS = read('src', 'public', 'style.css');
    const APP = read('src', 'public', 'app.js');
    const HTML = read('src', 'public', 'index.html');

    it('turns off browser touch panning on the buttons', function () {
      // body is `touch-action: pan-x pan-y`. Without an override here, a drag
      // scrolls the page instead of moving the buttons — the single most likely
      // way for this feature to ship broken.
      const block = /\.mode-switcher\s*\{[^}]*\}/.exec(CSS);
      assert.ok(block, '.mode-switcher rule is gone');
      assert.ok(/touch-action:\s*none/.test(block[0]),
        '.mode-switcher must set touch-action: none');
    });

    it('lets a manual position win, before it does any of the automatic work', function () {
      // The automatic placement runs on viewport change and after output. The
      // bail-out has to come before the buffer scan — both because scanning for
      // a position we are about to discard is wasted work on every keystroke of
      // output, and because anything after it could still move the buttons.
      const fn = /positionModeSwitcher\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(APP);
      assert.ok(fn, 'positionModeSwitcher is gone');
      const body = fn[1];
      const bail = body.indexOf('_fabManual');
      const scan = body.search(/buf\.getLine|term\.rows\s*-\s*1/);
      assert.ok(bail > -1, 'positionModeSwitcher never checks for a manual position');
      assert.ok(scan > -1, 'the buffer scan is gone — this guard is measuring nothing');
      assert.ok(bail < scan, 'the manual bail-out must come before the buffer scan');
    });

    it('loads the geometry module before app.js needs it', function () {
      const fab = HTML.indexOf('fab-position.js');
      const app = HTML.indexOf('app.js"');
      assert.ok(fab > -1, 'fab-position.js is not loaded by index.html');
      assert.ok(fab < app, 'fab-position.js must load before app.js');
    });

    it('offers a way back to the automatic position', function () {
      // Dragging silently costs you the follow-the-input-box behaviour. Without
      // a reset there is no way to ask for it back.
      assert.ok(/resetFabPosition/.test(APP), 'no reset in app.js');
      assert.ok(/fabResetBtn/.test(HTML), 'no reset control in the settings panel');
    });
  });
});

// The floating keys are buttons first and draggable second. Capturing the
// pointer on pointerdown sent the pointerup — and so the click — to the stack
// instead of the button under the pointer, so a plain press of ESC, MODE or
// the line break never reached its handler. Capture starts with the drag.
describe('floating keys: a press reaches the button', function () {
  const fs = require('fs');
  const path = require('path');
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'style.css'), 'utf8');

  it('does not capture the pointer on pointerdown', function () {
    const down = /sw\.addEventListener\('pointerdown', \(e\) => \{([\s\S]*?)\n        \}\);/.exec(APP);
    assert.ok(down, 'the drag pointerdown handler is gone');
    assert.ok(!/setPointerCapture\(/.test(down[1].replace(/\/\/.*$/gm, '')), 'no capture before the drag starts');
    assert.ok(/dragging = true;[\s\S]{0,200}setPointerCapture\(id\)/.test(APP), 'capture once it is a drag');
  });

  it('shows ESC alone on a desktop', function () {
    assert.ok(/@media \(min-width: 769px\) and \(hover: hover\),\s*\(min-width: 1025px\) \{\s*\.mode-switcher \{ display: flex; \}\s*\.mode-switcher \.mode-switcher-btn,\s*\.mode-switcher \.right-btn \{ display: none; \}/.test(CSS));
    assert.ok(!/if \(this\.isMobile\) \{\s*this\.showModeSwitcher\(\);/.test(APP), 'the stack is built on every device now');
  });
});
