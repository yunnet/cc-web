const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The mobile floating keys are built in JS, so these are static source
// assertions in the style of overlay-stacking.test.js — enough to catch the two
// mistakes that would make the button either absent or actively wrong.
describe('mobile newline key', function () {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'style.css'), 'utf8');

  it('adds a third key to the floating stack', function () {
    assert.ok(/id="newlineBtn"/.test(APP), 'the FAB stack needs a newline button');
    assert.ok(/getElementById\('newlineBtn'\)\.addEventListener\('click'/.test(APP),
      'the button must be wired to a click handler');
  });

  it('sends LF, not CR', function () {
    // The whole failure mode in one assertion: CR is Enter, so a button labelled
    // "line break" would submit the message instead. Claude Code documents LF
    // (Ctrl+J) as the newline that works in every terminal with no setup.
    const body = /sendNewline\(\)\s*\{[\s\S]*?\n    \}/.exec(APP);
    assert.ok(body, 'sendNewline() should exist');
    assert.ok(/data:\s*'\\n'/.test(body[0]), 'must send LF');
    assert.ok(!/data:\s*'\\r'/.test(body[0]), 'must not send CR — that submits');
  });

  it('styles the third key like the other two', function () {
    // One treatment for the set: same 56px cap, so the stack reads as one group
    // and positionModeSwitcher's measured layout still holds.
    assert.ok(/\.newline-btn\s*\{[\s\S]*?width:\s*56px[\s\S]*?height:\s*56px/.test(CSS),
      '.newline-btn must match the 56px cap of ESC and MODE');
    assert.ok(/\.newline-btn\.pressed/.test(CSS), 'needs the same press feedback');
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
