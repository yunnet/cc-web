const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { terminalLinkTarget } = require('../src/public/terminal-links');

// The allow-list for links Claude prints in the terminal (OSC 8). What it lets
// through gets opened; everything else must come back null.
describe('terminal links: where a clicked link may go', function () {
  it('opens web pages', function () {
    assert.deepStrictEqual(terminalLinkTarget('https://example.com/docs?a=1'), { kind: 'web', url: 'https://example.com/docs?a=1' });
    assert.deepStrictEqual(terminalLinkTarget('HTTP://Example.com'), { kind: 'web', url: 'http://example.com/' });
  });

  it('opens files on this machine, decoded', function () {
    assert.deepStrictEqual(terminalLinkTarget('file:///tmp/a%20b.md'), { kind: 'file', path: '/tmp/a b.md' });
    assert.deepStrictEqual(terminalLinkTarget('file://localhost/srv/x.js'), { kind: 'file', path: '/srv/x.js' });
    assert.deepStrictEqual(terminalLinkTarget('file:///w/%E8%AE%A1%E5%88%92.txt'), { kind: 'file', path: '/w/计划.txt' });
  });

  it('sends a plan file where its plain-text path goes', function () {
    assert.deepStrictEqual(terminalLinkTarget('file:///data/ts/.claude/plans/2026-x.md'),
      { kind: 'plan', path: '/data/ts/.claude/plans/2026-x.md' });
    assert.strictEqual(terminalLinkTarget('file:///data/ts/.claude/plans/sub/x.txt').kind, 'file');
  });

  it('refuses everything else', function () {
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>', 'file://evil.example/etc/passwd', 'vbscript:x',
      'ftp://example.com/x', 'not a url', 'file:///bad%E0%A4%A', '', null, undefined]) {
      assert.strictEqual(terminalLinkTarget(bad), null, String(bad));
    }
  });

  it('is what both terminals hand their clicks to', function () {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'public', f), 'utf8');
    const app = read('app.js');
    assert.ok(/linkHandler: \{\s*allowNonHttpProtocols: true,\s*activate: \(e, uri\) => this\.openTerminalLink\(uri/.test(app), 'main terminal');
    assert.ok(/linkHandler: \{\s*allowNonHttpProtocols: true,\s*activate: \(e, uri\) => this\.app && this\.app\.openTerminalLink\(uri, this\.sessionId\)/.test(read('splits.js')), 'split pane');
    assert.ok(/openTerminalLink\(uri, sessionId\) \{[\s\S]*?TerminalLinks\.terminalLinkTarget\(uri\)[\s\S]*?if \(!target\) return;/.test(app), 'gated by the allow-list');
    const html = read('index.html');
    assert.ok(html.indexOf('terminal-links.js') > -1 && html.indexOf('terminal-links.js') < html.indexOf('src="app.js"'));
  });
});
