// What Claude Code's terminal title says about it. It sets the title (OSC 0)
// as it goes — measured on 2.1.278:
//
//   idle       "✳ Claude Code", then "✳ <topic>"
//   working    "◐ <topic>" and "◑ <topic>", alternating about once a second
//
// That leading half-filled circle is the "spinning ball" a terminal like Warp
// shows on its tab. Pure, like fab-position.js, so the browser loads it and the
// tests require it.

var ClaudeTitle = (function () {
  // All four quarter-turns, not just the two seen, so a Claude that starts
  // using the others still reads as working.
  var WORKING = /^\s*[◐◑◒◓]/;

  function claudeTitleState(title) {
    var t = typeof title === 'string' ? title : '';
    return {
      working: WORKING.test(t),
      // The words after the decoration: Claude's own short name for the task.
      topic: t.replace(/^[\s\p{S}]+/u, '').trim()
    };
  }

  // Waiting for a permission answer also turns the title to ✳, and the
  // permission_prompt Notification hook (and its BEL) follows about 6s later —
  // measured on 2.1.278. Hold "finished" a little longer than that.
  var DONE_GRACE_MS = 8000;

  return { claudeTitleState: claudeTitleState, DONE_GRACE_MS: DONE_GRACE_MS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ClaudeTitle;
