const fs = require('fs');
const path = require('path');

// Carry a rendered page's own images inside it, so the sandbox does not have to
// give an inch.
//
// A rendered .html is served into an opaque origin under
// `default-src 'none'; img-src data: blob:` (see renderSandboxCsp in
// src/server.js). A page that references its screenshots by relative path
// therefore shows nothing: measured on a real file, four <img> blocked with
// "violates the following Content Security Policy directive: img-src data:
// blob:" and naturalWidth 0.
//
// Two further breaks sit behind that one, and neither is fixed by relaxing the
// CSP: the render URL keeps the whole absolute path in a SINGLE path segment,
// so a browser resolves `sibling.png` against the ticket rather than the
// directory; and the ticket is single-use, spent by the page's own request.
// Fetching a sibling file simply cannot work in this design.
//
// `img-src data:` is already allowed, though — so the bytes can travel in the
// page and nothing needs fetching. That fixes all three at once and relaxes
// nothing: still an opaque origin, still no network, still one spent ticket.
//
// Scope is deliberately narrow. Only images, only paths that resolve inside the
// page's own directory, only up to a byte budget.

// Base64 inflates by a third, and serveFile refuses to send more than 10 MB at
// all, so the budget has to leave room for the document itself.
const MAX_INLINE_BYTES = 6 * 1024 * 1024;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml'
};

// Anything with a scheme, a protocol-relative host, a root-absolute path or a
// bare fragment belongs to somebody else. Leave it exactly as found.
function isForeign(ref) {
  return !ref || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref) || ref.startsWith('//') ||
    ref.startsWith('/') || ref.startsWith('#');
}

// Resolve a reference against the page's directory and read it — but only if it
// is an image, stays inside that directory, and fits what is left of the budget.
// Returns null for every other case, which means "leave the markup alone".
function readAsset(ref, dir, state) {
  if (isForeign(ref)) return null;

  // Drop a query string or fragment before touching the filesystem: `v.png?x=1`
  // is a real thing in generated html and names the same file.
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(clean);
  } catch (_) {
    decoded = clean; // a stray % is not a reason to fail the whole page
  }

  const mime = MIME[path.extname(decoded).toLowerCase()];
  if (!mime) return null;

  try {
    const target = path.resolve(dir, decoded);
    // realpath both sides, so a symlink cannot be used to reach outside the
    // directory the page was served from.
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(target);
    if (real !== root && !real.startsWith(root + path.sep)) return null;

    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    if (state.used + stat.size > state.budget) return null;

    const buf = fs.readFileSync(real);
    state.used += buf.length;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (_) {
    return null; // missing, unreadable, whatever — the page keeps its link
  }
}

// `src="…"` / `src='…'` on any tag, and CSS `url(…)` in a <style> block or a
// style attribute. Regex rather than a parser because the repo has no html
// dependency and the shapes we rewrite are narrow — and because a miss is
// harmless: an untouched reference is exactly today's behaviour.
const SRC = /(\ssrc\s*=\s*)(["'])([^"']*)\2/gi;
const URL_FN = /(url\(\s*)(["']?)([^"')]+)\2(\s*\))/gi;

function inlineLocalAssets(html, dir, opts = {}) {
  const state = { used: 0, budget: opts.budget || MAX_INLINE_BYTES };
  let inlined = 0;
  let skipped = 0;

  const swap = (ref) => {
    const data = readAsset(ref, dir, state);
    if (data) { inlined++; return data; }
    // Only count a skip for something we would have wanted: a foreign or
    // non-image reference was never a candidate.
    if (!isForeign(ref) && MIME[path.extname(ref.split('#')[0].split('?')[0]).toLowerCase()]) skipped++;
    return null;
  };

  let out = String(html).replace(SRC, (whole, lead, quote, ref) => {
    const data = swap(ref);
    return data ? `${lead}${quote}${data}${quote}` : whole;
  });

  out = out.replace(URL_FN, (whole, lead, quote, ref, tail) => {
    const data = swap(ref);
    // Quote the replacement: a data: URI contains characters that unquoted
    // url() does not allow.
    return data ? `${lead}"${data}"${tail}` : whole;
  });

  return { html: out, inlined, skipped, bytes: state.used };
}

module.exports = { inlineLocalAssets, MAX_INLINE_BYTES };
