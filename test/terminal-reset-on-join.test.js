const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Joining a session must put the terminal back into a KNOWN state, not merely
// blank the screen.
//
// The bug this pins: a page attached while Claude was on the fullscreen
// renderer is left in the terminal's ALTERNATE screen buffer when that Claude
// dies without emitting ESC[?1049l — a server restart kills it, so it never
// does. The alternate buffer has no scrollback by design and forwards the wheel
// to the application, so the page is stuck with no history and a dead mouse
// wheel. Reconnecting does not rescue it: terminal.clear() blanks the screen
// but leaves every mode exactly as it was, alternate buffer included.
//
// Measured in a real browser attached to a live session:
//
//   normal buffer                     wheel scrolls   456 -> 453
//   after ESC[?1049h                  wheel dead      0 -> 0
//   after clear() + replay            STILL alternate, wheel dead
//   after ESC[?1049l                  wheel scrolls again, 495 lines intact
//
// reset() is what clears the modes — alternate buffer, scroll regions,
// application cursor keys, mouse tracking, bracketed paste — so the replay
// lands on a terminal in the state the server's bytes assume.
describe('terminal state on session join', function () {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');

  // The session_joined handler, from the case label to the end of the replay.
  const joinHandler = () => {
    const start = APP.indexOf("case 'session_joined'");
    assert.ok(start > 0, "could not find the 'session_joined' handler");
    const end = APP.indexOf("case 'session_left'", start);
    assert.ok(end > start, "could not find the end of the 'session_joined' handler");
    return APP.slice(start, end);
  };

  it('resets the terminal when joining, not just clears it', function () {
    // Written against the terminal that OWNS the message, not `this.terminal`:
    // since each tab keeps its own terminal alive, a join can arrive for a view
    // that is not the one on screen.
    const h = joinHandler();
    assert.ok(/\.reset\(\)/.test(h),
      'joining must reset() the terminal — clear() leaves the alternate buffer active');
    assert.ok(/view && view\.terminal/.test(h),
      'the reset must target the joining view\'s terminal, not whatever is visible');
  });

  it('resets even when the session has nothing to replay', function () {
    // A session with an empty output buffer still has to fix a wedged terminal.
    // Resetting only inside `if (outputBuffer.length)` leaves the one case where
    // the user has no content to look at AND no way to scroll.
    const h = joinHandler();
    const resetAt = h.indexOf('.reset()');
    const guardAt = h.indexOf('message.outputBuffer && message.outputBuffer.length');
    assert.ok(resetAt > 0 && guardAt > 0, 'expected both the reset and the replay guard');
    assert.ok(resetAt < guardAt,
      'the reset must happen before (and outside) the "is there anything to replay" guard');
  });

  it('still replays the server buffer after the reset', function () {
    // reset() wipes the screen, so the replay has to follow it — the other order
    // would show a blank terminal.
    const h = joinHandler();
    assert.ok(/queueTerminalWrite/.test(h), 'the replay must still happen');
    assert.ok(h.indexOf('.reset()') < h.indexOf('queueTerminalWrite'),
      'reset must come before the replay, or it erases what it just wrote');
  });
});
