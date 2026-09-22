// Where a link Claude prints in the terminal should go. With FORCE_HYPERLINK
// Claude wraps URLs and file paths in OSC 8 hyperlinks (measured on 2.1.278:
// without it, none), and xterm hands each click here instead of its default,
// which asks "This link could potentially be dangerous" and refuses file:.
//
// This is the allow-list, so it errs on refusing: only http(s), and file: on
// this machine. javascript:, data:, a file: on another host, anything that does
// not parse — nothing. A plan file keeps going where its plain-text path goes
// (registerPlanLinks → /api/plan), so a plan written as a markdown link opens
// the same way. Pure, like claude-title.js, so the browser loads it and the
// tests require it.

var TerminalLinks = (function () {
  var PLAN = /\.claude\/plans\/[^/]+\.md$/;

  function terminalLinkTarget(uri) {
    var u;
    try { u = new URL(String(uri)); } catch (_) { return null; }
    if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'web', url: u.href };
    if (u.protocol !== 'file:') return null;
    if (u.hostname && u.hostname !== 'localhost') return null;
    var path;
    try { path = decodeURIComponent(u.pathname); } catch (_) { return null; }
    if (!path) return null;
    return { kind: PLAN.test(path) ? 'plan' : 'file', path: path };
  }

  return { terminalLinkTarget: terminalLinkTarget };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TerminalLinks;
