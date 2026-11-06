const crypto = require('crypto');
const { promisify } = require('util');

// Password hashing for platform users. scrypt is in node:crypto, so this needs
// no dependency; the parameters are stored with each hash so they can be raised
// later without invalidating existing passwords.
//
//   scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>

const scrypt = promisify(crypto.scrypt);

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

// Resolves false for anything malformed rather than throwing: a corrupt user
// file must read as "wrong password", not as a 500.
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return expected.length > 0 && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

// Constant-time string comparison for secrets of any length: both sides are
// hashed first, so neither the content nor the length leaks through timing.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { hashPassword, verifyPassword, safeEqual };
