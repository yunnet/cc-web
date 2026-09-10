const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inlineLocalAssets, MAX_INLINE_BYTES } = require('../src/utils/inline-assets');

// A rendered .html runs in an opaque origin under `default-src 'none'; img-src
// data: blob:`, so a page that references its images by relative path shows
// nothing: measured on a real file, four <img> blocked with
// "violates ... img-src data: blob:" and naturalWidth 0. Relaxing the CSP is not
// the answer — `img-src data:` is ALREADY allowed, so the bytes can simply be
// carried in the page. That is what this does, and it is why the sandbox does
// not have to give an inch.
//
// It also fixes a second, independent break: the render URL keeps the whole
// absolute path in ONE segment, so a browser resolves a sibling file against
// the ticket rather than the directory — and the ticket is spent anyway. Neither
// matters once nothing has to be fetched.
describe('inlineLocalAssets', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-inline-'));
  });

  afterEach(function () {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  // A one-pixel PNG, so the bytes are real and the mime is worth checking.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const write = (name, buf) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return p;
  };

  it('inlines a same-directory image as a data: URI', function () {
    write('shot.png', PNG);
    const out = inlineLocalAssets('<img src="shot.png" alt="x">', dir);

    assert.strictEqual(out.inlined, 1);
    assert.ok(out.html.includes(`data:image/png;base64,${PNG.toString('base64')}`),
      `expected the png bytes inline, got: ${out.html}`);
    // Everything else about the tag survives.
    assert.ok(/alt="x"/.test(out.html));
  });

  it('leaves anything it cannot vouch for exactly as it found it', function () {
    // Absolute URLs, other schemes, protocol-relative, root-absolute paths and
    // fragments are all somebody else's business.
    const srcs = [
      'https://example.com/a.png', 'http://example.com/a.png', '//example.com/a.png',
      'data:image/png;base64,AAAA', 'blob:whatever', '/etc/passwd.png', '#anchor', ''
    ];
    const html = srcs.map((s) => `<img src="${s}">`).join('\n');
    const out = inlineLocalAssets(html, dir);

    assert.strictEqual(out.inlined, 0);
    assert.strictEqual(out.html, html, 'untouchable sources must come back byte-identical');
  });

  it('refuses to climb out of the directory', function () {
    // The whole point of resolving inside the html's own directory: a page must
    // not be able to name ../../ anything and have the server read it for it.
    write('shot.png', PNG);
    const outside = path.join(dir, '..', `escape-${process.pid}.png`);
    fs.writeFileSync(outside, PNG);
    try {
      const html = `<img src="../escape-${process.pid}.png">`;
      const out = inlineLocalAssets(html, dir);
      assert.strictEqual(out.inlined, 0);
      assert.strictEqual(out.html, html);
    } finally {
      try { fs.unlinkSync(outside); } catch (_) {}
    }
  });

  it('follows a subdirectory below the page', function () {
    write(path.join('img', 'nested.png'), PNG);
    const out = inlineLocalAssets('<img src="img/nested.png">', dir);
    assert.strictEqual(out.inlined, 1);
    assert.ok(out.html.includes('data:image/png;base64,'));
  });

  it('handles single quotes, percent-encoding and a query string', function () {
    write('a b.png', PNG);
    write('v.png', PNG);
    const out = inlineLocalAssets(
      `<img src='a%20b.png'><img src="v.png?cachebust=2#frag">`, dir);
    assert.strictEqual(out.inlined, 2, 'both forms should resolve');
    assert.ok(!/a%20b\.png/.test(out.html));
    assert.ok(!/cachebust/.test(out.html));
  });

  it('inlines CSS url() in a style block and in a style attribute', function () {
    // Same CSP directive governs background images, so a template that switches
    // from <img> to background-image must not silently break again.
    write('bg.png', PNG);
    const out = inlineLocalAssets(
      `<style>.a{background:url(bg.png) no-repeat}</style><div style="background-image:url('bg.png')"></div>`,
      dir);
    assert.strictEqual(out.inlined, 2);
    assert.ok(!/url\(['"]?bg\.png/.test(out.html), `bg.png should be gone: ${out.html}`);
  });

  it('leaves a missing file alone instead of throwing', function () {
    const html = '<img src="not-here.png">';
    const out = inlineLocalAssets(html, dir);
    assert.strictEqual(out.inlined, 0);
    assert.strictEqual(out.html, html);
    assert.strictEqual(out.skipped, 1);
  });

  it('ignores things that are not images', function () {
    // src on a <script> resolves the same way; inlining executable code into a
    // page is not this function's job.
    write('app.js', Buffer.from('alert(1)'));
    const html = '<script src="app.js"></script>';
    const out = inlineLocalAssets(html, dir);
    assert.strictEqual(out.inlined, 0);
    assert.strictEqual(out.html, html);
  });

  it('stops at the byte budget and leaves the rest as links', function () {
    // Four screenshots of a page are ~500 KB; base64 inflates by a third. A
    // budget is what keeps "show me this file" from painting a hundred MB.
    const big = Buffer.alloc(600 * 1024, 7);
    write('a.png', big);
    write('b.png', big);
    const out = inlineLocalAssets('<img src="a.png"><img src="b.png">', dir, { budget: 700 * 1024 });

    assert.strictEqual(out.inlined, 1, 'the first fits, the second does not');
    assert.strictEqual(out.skipped, 1);
    assert.ok(/<img src="b\.png">/.test(out.html), 'the one over budget keeps its original src');
  });

  it('has a default budget that is smaller than the file cap', function () {
    // serveFile refuses files over 10 MB; inlining must not be able to push the
    // response past that on its own.
    assert.ok(MAX_INLINE_BYTES > 0 && MAX_INLINE_BYTES <= 8 * 1024 * 1024,
      `budget ${MAX_INLINE_BYTES} should be a sane fraction of the 10 MB file cap`);
  });

  it('returns the html untouched when there is nothing to do', function () {
    const html = '<h1>hello</h1><p>no assets here</p>';
    const out = inlineLocalAssets(html, dir);
    assert.strictEqual(out.html, html);
    assert.strictEqual(out.inlined, 0);
  });

  it('inlines an svg as its own type, not as a png', function () {
    write('d.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const out = inlineLocalAssets('<img src="d.svg">', dir);
    assert.strictEqual(out.inlined, 1);
    assert.ok(out.html.includes('data:image/svg+xml;base64,'), out.html);
  });
});
