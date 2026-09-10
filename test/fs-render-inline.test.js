const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// serveFile carries a rendered page's own images inside it. The unit-level
// rules live in inline-assets.test.js; these pin the two things only the route
// can get wrong — that it happens when rendering, and that it never happens to
// the source view.
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(obj) { this.body = obj; return this; },
    send(content) { this.body = content; return this; }
  };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

describe('rendered html carries its own images', function () {
  let server, dir, page;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-render-'));
    fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
    page = path.join(dir, 'check.html');
    fs.writeFileSync(page, '<h1>check</h1><img src="shot.png" alt="a">');
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  // Mint a ticket the way POST /api/fs/ticket does, then spend it on serveFile.
  const render = (target) => {
    const tres = mockRes();
    server.createFileTicket({ body: { path: target } }, tres);
    const res = mockRes();
    server.serveFile({ params: { token: tres.body.ticket, file: target } }, res);
    return res;
  };

  it('inlines the image when the page is rendered', function () {
    const res = render(page);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    const html = res.body.toString('utf8');
    assert.ok(html.includes(`data:image/png;base64,${PNG.toString('base64')}`),
      'the png should be carried in the page');
    assert.ok(!/src="shot\.png"/.test(html), 'the un-fetchable relative link should be gone');
  });

  it('keeps the sandbox exactly as strict as it was', function () {
    // The entire justification for inlining is that it buys the fix without
    // relaxing anything. If a later edit trades CSP for convenience, this fails.
    const res = render(page);
    const csp = res.headers['content-security-policy'];
    assert.ok(/default-src 'none'/.test(csp), csp);
    assert.ok(/img-src data: blob:/.test(csp), `img-src must not have grown a host: ${csp}`);
    assert.ok(/sandbox allow-scripts/.test(csp), csp);
    assert.ok(!/'self'/.test(csp), `no same-origin fetching may be introduced: ${csp}`);
  });

  it('serves the source view byte-for-byte, untouched', function () {
    // Without a ticket the file is source, not a page — and source must be the
    // file on disk, or "view source" quietly lies about what is there.
    const res = mockRes();
    server.serveFile({ params: { token: 'anything', file: page } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.strictEqual(res.body.toString('utf8'), fs.readFileSync(page, 'utf8'));
  });

  it('does not rewrite a rendered svg', function () {
    // An svg renders with no allow-scripts at all; it is served as its own bytes
    // and has no business being rewritten as html.
    const svg = path.join(dir, 'd.svg');
    const body = '<svg xmlns="http://www.w3.org/2000/svg"><image href="shot.png"/></svg>';
    fs.writeFileSync(svg, body);

    const res = render(svg);
    assert.strictEqual(res.headers['content-type'], 'image/svg+xml');
    assert.strictEqual(res.body.toString('utf8'), body);
  });

  it('still serves a page whose image is missing', function () {
    // A broken link must not turn "show me this file" into an error.
    const orphan = path.join(dir, 'orphan.html');
    fs.writeFileSync(orphan, '<img src="gone.png">');

    const res = render(orphan);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.toString('utf8'), '<img src="gone.png">');
  });
});
