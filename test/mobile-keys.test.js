const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The mobile floating keys are built in JS, so these are static source
// assertions in the style of overlay-stacking.test.js — enough to catch the two
// mistakes that would make the button either absent or actively wrong.
describe('mobile arrow key', function () {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'style.css'), 'utf8');

  // The third floating key was a line break; it is the Right arrow now, for a
  // phone whose soft keyboard's own arrow key is broken.
  it('has a Right arrow as the third key', function () {
    assert.ok(/id="rightBtn"/.test(APP), 'the FAB stack needs the arrow key');
    assert.ok(/getElementById\('rightBtn'\)\.addEventListener\('click'/.test(APP),
      'the button must be wired to a click handler');
    assert.ok(!/newlineBtn|sendNewline/.test(APP), 'the line-break key it replaced is gone');
  });

  it('sends the arrow the way xterm does, per cursor-key mode', function () {
    // ESC O C under application cursor keys (DECCKM), ESC [ C otherwise: a
    // program in the other mode would not read it as an arrow at all.
    const body = /sendRightArrow\(\)\s*\{[\s\S]*?\n    \}/.exec(APP);
    assert.ok(body, 'sendRightArrow() should exist');
    assert.ok(/applicationCursorKeysMode/.test(body[0]), 'must follow the cursor-key mode');
    assert.ok(/'\\x1bOC'/.test(body[0]) && /'\\x1b\[C'/.test(body[0]), 'both forms of the arrow');
  });

  it('styles the third key like the other two', function () {
    // One treatment for the set: same 56px cap, so the stack reads as one group
    // and positionModeSwitcher's measured layout still holds.
    assert.ok(/\.right-btn\s*\{[\s\S]*?width:\s*56px[\s\S]*?height:\s*56px/.test(CSS),
      '.right-btn must match the 56px cap of ESC and MODE');
    assert.ok(/\.right-btn\.pressed/.test(CSS), 'needs the same press feedback');
  });

  it('does not hard-code the stack height anywhere', function () {
    // Three keys make the stack 188px instead of 122px. The drag/clamp geometry
    // measures the element, and must keep doing so — a hard-coded height would
    // park the stack off-screen or refuse to reach the bottom of the viewport.
    assert.ok(!/122px|\b122\b\s*\/\/.*stack/.test(APP),
      'FAB geometry must be measured, not assumed');
  });
});

// The keyboard side of the same idea: xterm sends \r for every Enter chord, so
// each chord that means something else is mapped by hand, in both the main
// terminal and split panes (two handlers, kept alike).
describe('Enter chords in the terminal', function () {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'public', f), 'utf8');

  for (const file of ['app.js', 'splits.js']) {
    it(`${file}: Shift/Alt+Enter is a newline, Ctrl+Enter is "send now"`, function () {
      const src = read(file);
      assert.ok(/e\.key === 'Enter' && \(e\.shiftKey \|\| e\.altKey\) && !e\.ctrlKey[\s\S]*?'\\n'/.test(src),
        'Shift/Alt+Enter must send LF');
      // Ctrl+X Ctrl+S: Claude Code's send-now chord that works without the kitty
      // protocol — measured to interrupt the turn and send the queue (2.1.278).
      assert.ok(/e\.key === 'Enter' && e\.ctrlKey && !e\.shiftKey[\s\S]*?'\\x18\\x13'/.test(src),
        'Ctrl+Enter must send Ctrl+X Ctrl+S');
    });
  }
});
