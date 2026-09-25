// Read at most `max` bytes from a file, without caring how big it really is.
//
// Both callers read a header out of a file whose size they do not control: a
// `.git/HEAD` (one short line) and a `SKILL.md` frontmatter block. Reading a
// fixed prefix means a bogus — or hostile — multi-gigabyte file costs the same
// as a real one. Returns null when the file cannot be read at all.

const fs = require('fs');

function readPrefix(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

module.exports = { readPrefix };
