const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Creating a session left the tab blank and unusable: the tab appeared, the
// terminal stayed empty, and no "Start Claude" panel was offered, so the
// session looked like it had failed to be created. Reproduced on :32352 —
// the console showed the two lines back to back:
//
//   [session_joined] New session detected, showing start prompt
//   [hideOverlay] Hiding overlay, current display: flex
//
// showSession() awaits openViewSocket() for a brand-new view; the server's
// session_joined arrives during that await and calls showOverlay('startPrompt'),
// and then showSession's own unconditional hideOverlay() wiped it out. The
// session itself was fine — showing the overlay by hand and clicking Start
// launched Claude normally. bootstrap (the `tabs.size > 0` branch) already had
// this guard; showSession did not.
//
// A static assertion over the source, like session-create-guard.test.js: the
// race cannot be exercised without a DOM and a live socket, but the guard can
// be kept from silently disappearing.
describe('start prompt: showSession must not wipe it', function () {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  const fn = /async showSession\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(APP);

  it('still has the function this guards', function () {
    assert.ok(fn, 'showSession is gone — this guard is measuring nothing');
  });

  it('has a single helper that answers whether the start prompt is up', function () {
    // Two call sites asked the same DOM question in the same way; a third
    // would have copied it again. One helper, so the answer cannot drift.
    assert.ok(/startPromptVisible\s*\(\)\s*\{/.test(APP),
      'startPromptVisible() is missing');
    assert.ok(/getElementById\('startPrompt'\)[\s\S]{0,80}display === 'block'/.test(APP),
      'startPromptVisible() must read the start prompt\'s own display');
  });

  it('never hides the overlay unconditionally', function () {
    const body = fn[1];
    const calls = body.match(/^\s*this\.hideOverlay\(\);/gm) || [];
    assert.strictEqual(calls.length, 0,
      'showSession hides the overlay unconditionally — a start prompt raised ' +
      'during the await is wiped, leaving a blank terminal with no way to start');
  });

  it('hides it only when the start prompt is not up', function () {
    assert.ok(/if \(!this\.startPromptVisible\(\)\) this\.hideOverlay\(\);/.test(fn[1]),
      'the guarded hideOverlay is missing from showSession');
  });

  it('keeps the bootstrap path on the same helper', function () {
    // The `tabs.size > 0` branch guarded this inline before the helper existed.
    // It must not keep its own copy of the check.
    const boot = /await this\.sessionTabManager\.switchToTab\(activeId\);([\s\S]{0,400}?)\n        \}/.exec(APP);
    assert.ok(boot, 'the bootstrap switchToTab branch is gone');
    assert.ok(/if \(!this\.startPromptVisible\(\)\) this\.hideOverlay\(\);/.test(boot[1]),
      'bootstrap must use the shared helper, not an inline copy');
  });
});
