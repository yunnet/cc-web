const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Rows the pointer SWEEPS — folder rows in the browser and the explorer, the
// session list, the tab strip — must light up under the cursor, not behind it.
// A colour transition on those rows is a delay you feel as drag: measured on
// .folder-item's `transition: ... 0.08s`, the highlight was still at the base
// colour one frame after the pointer entered and only reached full accent at
// 83ms. Sweeping a list, that is one row of lag the whole way down.
//
// .conv-row already documents this conclusion and carries no transition; these
// assertions hold the rest of the swept rows to the same rule, statically, so
// nobody reintroduces a fade without reading why it was removed.
describe('hover latency', function () {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'style.css'), 'utf8');

  // Every declaration block written for exactly this selector (a rule listing
  // it among others, or a descendant of it, is a different rule and not ours).
  function blocksFor(selector) {
    const out = [];
    for (const m of CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selectors = m[1].split(',').map(s => s.trim().split(/\s+/).pop().split(':')[0]);
      if (selectors.includes(selector)) out.push(m[2]);
    }
    return out;
  }

  // The transition value in a block, if it declares one.
  function transitionsIn(block) {
    const code = block.replace(/\/\*[\s\S]*?\*\//g, ''); // a comment explaining one doesn't declare one
    return [...code.matchAll(/transition:\s*([^;]+)/g)].map(m => m[1].trim());
  }

  // Properties whose change IS the hover feedback. A transition on any of them
  // (or on `all`) is the highlight arriving late.
  const FEEDBACK = /\b(all|background|background-color|border-color|color|font-weight)\b/;

  // Rows a pointer moves across to choose one.
  const SWEPT_ROWS = ['.folder-item', '.session-item', '.session-tab', '.conv-row'];

  for (const selector of SWEPT_ROWS) {
    it(`${selector} highlights with no delay`, function () {
      const blocks = blocksFor(selector);
      assert.ok(blocks.length, `${selector} has no rule in style.css — did it get renamed?`);
      for (const block of blocks) {
        for (const value of transitionsIn(block)) {
          assert.ok(
            !FEEDBACK.test(value) || /\bnone\b/.test(value),
            `${selector} delays its hover highlight: transition: ${value}`
          );
        }
      }
    });
  }

  it('puts no backdrop blur behind anything the pointer sweeps', function () {
    // The other half of hover lag: a backdrop-filter re-blurs the whole
    // viewport on every composited frame. Measured sweeping the Sessions panel
    // (a .session-modal): 24-36 fps with blur(4px) behind it, 58-60 fps with a
    // plain scrim. It came back once after the folder browser dropped it, on
    // the modals that were never checked — so check all of them.
    const blurs = [...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(m => /(^|[;\s])(-webkit-)?backdrop-filter\s*:\s*(?!none)/.test(m[2]))
      .map(m => m[1].trim());
    assert.deepStrictEqual(blurs, [], `backdrop-filter is back on: ${blurs.join(' | ')}`);
  });
});
