const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./password');

// Platform users and their login sessions, under <dataDir>/platform:
//
//   platform/users/<uid>.json              one user
//   platform/login-sessions/<sha256>.json  one signed-in browser
//   platform/invites/<code>.json           one unused invite code
//
// One file per entity, for the reason session-store.js gives: no shared
// document for two writers to race over, and deletion is always explicit.
//
// A login session is keyed by the SHA-256 of the cookie value, so the files on
// disk are not usable credentials. Everything is cached in memory after the
// first read; the directory is resolved through a function on every access so a
// test that redirects the server's data dir moves this store with it.
//
// `cc-web user ...` edits these files while the server runs. The users directory
// is re-read whenever its mtime moves (an atomic write renames into it), and a
// user's `sessionsValidAfter` voids every login issued before it -- so a reset
// password or a disabled account takes effect without a restart, even though
// the server holds its login sessions in memory.
//
// Synchronous on purpose: the files are tiny and the lookup runs inside the
// auth check of every request, where an await would only add ordering bugs.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// lastSeenAt / expiresAt are only rewritten this often, so an active browser
// does not cost a disk write per request.
const TOUCH_EVERY_MS = 10 * 60 * 1000;

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,31}$/;
const UID = /^u-[0-9a-f]{8}$/;
const SID_HASH = /^[0-9a-f]{64}$/;
const INVITE = /^[A-Za-z0-9_-]{12}$/;
const INVITE_MAX_DAYS = 90;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

// Verified against when the username does not exist, so a miss costs the same
// scrypt as a hit and response time does not reveal which usernames exist.
let dummyHash = null;

// Readable one-time passwords: no 0/O/1/l/I to misread when passing one on.
const TEMP_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function tempPassword(length = 12) {
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length)) {
      // Rejection sampling keeps every character equally likely.
      if (b < 256 - (256 % TEMP_ALPHABET.length) && out.length < length) out += TEMP_ALPHABET[b % TEMP_ALPHABET.length];
    }
  }
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
    throw error;
  }
}

function readJsonDir(dir, namePattern) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Failed to read ${dir}:`, error.message);
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || !namePattern.test(name.slice(0, -5))) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch (error) {
      console.error(`Skipping unreadable ${name}:`, error.message);
    }
  }
  return out;
}

class UserStore {
  constructor(dirFn) {
    this.dirFn = dirFn;
    this.users = null;        // uid → user record (with passwordHash)
    this.loginSessions = null; // sha256(sid) → login session record
    this.usersMtime = null;    // users dir mtime at the last read
    this.invites = null;       // code → invite record
  }

  get dir() { return this.dirFn(); }
  get usersDir() { return path.join(this.dir, 'users'); }
  get sessionsDir() { return path.join(this.dir, 'login-sessions'); }
  get invitesDir() { return path.join(this.dir, 'invites'); }

  static publicUser(user) {
    return user
      ? { id: user.id, username: user.username, role: user.role, mustChangePassword: !!user.mustChangePassword }
      : null;
  }

  // What the admin page shows: everything but the hash.
  static adminUser(user) {
    if (!user) return null;
    const { passwordHash, ...rest } = user;
    return { ...rest, rootDirs: Array.isArray(user.rootDirs) ? user.rootDirs : [], disabled: !!user.disabled };
  }

  static tempPassword() {
    return tempPassword();
  }

  static validateUsername(username) {
    if (typeof username !== 'string' || !USERNAME.test(username)) {
      return 'Username must be 2-32 characters: letters, digits, _ . -, starting with a letter or digit';
    }
    return null;
  }

  static validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return `Password must be at least ${MIN_PASSWORD} characters`;
    }
    if (password.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters`;
    return null;
  }

  usersDirMtime() {
    try { return fs.statSync(this.usersDir).mtimeMs; } catch (_) { return 0; }
  }

  loadUsers() {
    const mtime = this.usersDirMtime();
    if (this.users && mtime === this.usersMtime) return this.users;
    this.usersMtime = mtime;
    this.users = new Map();
    for (const u of readJsonDir(this.usersDir, UID)) {
      if (u && UID.test(String(u.id)) && typeof u.username === 'string') this.users.set(u.id, u);
    }
    return this.users;
  }

  hasUsers() {
    return this.loadUsers().size > 0;
  }

  listUsers() {
    return [...this.loadUsers().values()];
  }

  getUser(id) {
    return this.loadUsers().get(id) || null;
  }

  findByUsername(username) {
    if (typeof username !== 'string') return null;
    const want = username.toLowerCase();
    for (const u of this.loadUsers().values()) {
      if (u.username.toLowerCase() === want) return u;
    }
    return null;
  }

  // The user the legacy shared token stands for: the first admin, by creation.
  firstAdmin() {
    return this.listUsers()
      .filter((u) => u.role === 'admin' && !u.disabled)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
  }

  // onlyIfNoUsers: the first-admin path. Checked again after the hash, since
  // two setups for DIFFERENT names would otherwise both pass the name check.
  async createUser({ username, password, role = 'user', onlyIfNoUsers = false, mustChangePassword = false }) {
    if (onlyIfNoUsers && this.hasUsers()) {
      throw Object.assign(new Error('An administrator already exists'), { status: 409 });
    }
    const nameError = UserStore.validateUsername(username);
    if (nameError) throw Object.assign(new Error(nameError), { status: 400 });
    const pwError = UserStore.validatePassword(password);
    if (pwError) throw Object.assign(new Error(pwError), { status: 400 });
    if (this.findByUsername(username)) {
      throw Object.assign(new Error('Username already exists'), { status: 409 });
    }
    let id;
    do { id = `u-${crypto.randomBytes(4).toString('hex')}`; } while (this.loadUsers().has(id));
    const user = {
      id,
      username,
      passwordHash: await hashPassword(password),
      role: role === 'admin' ? 'admin' : 'user',
      rootDirs: [],
      claudeConfigDir: null,
      disabled: false,
      mustChangePassword: !!mustChangePassword,
      createdAt: new Date().toISOString(),
    };
    // The scrypt above yields, so re-check: two setups racing must not both win.
    if (onlyIfNoUsers && this.hasUsers()) {
      throw Object.assign(new Error('An administrator already exists'), { status: 409 });
    }
    if (this.findByUsername(username)) {
      throw Object.assign(new Error('Username already exists'), { status: 409 });
    }
    this.writeUser(user);
    return user;
  }

  writeUser(user) {
    writeJsonAtomic(path.join(this.usersDir, `${user.id}.json`), user);
    this.loadUsers().set(user.id, user);
    return user;
  }

  // Role, disabled, rootDirs -- whatever the caller already validated.
  // Disabling voids the user's logins (see sessionsValidAfter).
  updateUser(id, patch) {
    const user = this.getUser(id);
    if (!user) return null;
    const next = { ...user, ...patch };
    if (patch.disabled === true && !user.disabled) next.sessionsValidAfter = new Date().toISOString();
    return this.writeUser(next);
  }

  // A new password. `revokeAll` (an admin reset, the CLI) voids every login of
  // this user; otherwise (the user changing their own) only those other than
  // `keepLoginId` are removed and the browser that asked stays signed in.
  async setPassword(id, password, { mustChangePassword = false, revokeAll = false, keepLoginId = null } = {}) {
    const pwError = UserStore.validatePassword(password);
    if (pwError) throw Object.assign(new Error(pwError), { status: 400 });
    if (!this.getUser(id)) throw Object.assign(new Error('No such user'), { status: 404 });
    const passwordHash = await hashPassword(password);
    // Re-read after the hash: the record may have changed while it ran.
    const current = this.getUser(id);
    if (!current) throw Object.assign(new Error('No such user'), { status: 404 });
    const next = { ...current, passwordHash, mustChangePassword: !!mustChangePassword };
    if (revokeAll) next.sessionsValidAfter = new Date().toISOString();
    this.writeUser(next);
    return this.revokeUserSessions(id, { except: revokeAll ? null : keepLoginId });
  }

  deleteUser(id) {
    if (!this.getUser(id)) return false;
    this.revokeUserSessions(id);
    try { fs.unlinkSync(path.join(this.usersDir, `${id}.json`)); } catch (_) { /* already gone */ }
    this.loadUsers().delete(id);
    return true;
  }

  // The user on a correct username + password, else null. Disabled users fail
  // the same way a wrong password does.
  async verifyLogin(username, password) {
    const user = this.findByUsername(username);
    if (!user) {
      if (!dummyHash) dummyHash = await hashPassword('ccw-dummy-password');
      await verifyPassword(String(password || ''), dummyHash);
      return null;
    }
    const ok = await verifyPassword(String(password || ''), user.passwordHash);
    if (!ok) return null;
    // The hash took a while; answer from the record as it is now.
    const current = this.getUser(user.id);
    return current && !current.disabled ? current : null;
  }

  loadLoginSessions() {
    if (this.loginSessions) return this.loginSessions;
    this.loginSessions = new Map();
    const now = Date.now();
    for (const s of readJsonDir(this.sessionsDir, SID_HASH)) {
      if (!s || !SID_HASH.test(String(s.id))) continue;
      if (Date.parse(s.expiresAt) <= now) { this.removeSessionFile(s.id); continue; }
      this.loginSessions.set(s.id, s);
    }
    return this.loginSessions;
  }

  // Abandoned sessions are never presented again, so they would otherwise sit
  // in memory and on disk until a restart. Runs on every new sign-in.
  sweepExpired(now = Date.now()) {
    for (const [hash, record] of this.loadLoginSessions()) {
      if (Date.parse(record.expiresAt) <= now) {
        this.loginSessions.delete(hash);
        this.removeSessionFile(hash);
      }
    }
  }

  removeSessionFile(hash) {
    try { fs.unlinkSync(path.join(this.sessionsDir, `${hash}.json`)); } catch (_) { /* already gone */ }
  }

  // Returns the raw session id: the cookie value. Only its hash is kept.
  createLoginSession(userId, { ua = '', ip = '' } = {}) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sweepExpired(now);
    const record = {
      id: sha256(sid),
      userId,
      ua: String(ua).slice(0, 300),
      ip: String(ip).slice(0, 64),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    writeJsonAtomic(path.join(this.sessionsDir, `${record.id}.json`), record);
    this.loadLoginSessions().set(record.id, record);
    return sid;
  }

  // { session, user, refreshed } for a live cookie value, else null. Slides
  // the expiry forward, writing at most once per TOUCH_EVERY_MS; `refreshed`
  // tells the caller to re-send the cookie so the browser's copy slides too.
  getLoginSession(sid) {
    if (typeof sid !== 'string' || !sid || sid.length > 128) return null;
    const hash = sha256(sid);
    const sessions = this.loadLoginSessions();
    const record = sessions.get(hash);
    if (!record) return null;
    const now = Date.now();
    if (Date.parse(record.expiresAt) <= now) {
      sessions.delete(hash);
      this.removeSessionFile(hash);
      return null;
    }
    const user = this.getUser(record.userId);
    if (!user || user.disabled) return null;
    // Issued before an admin reset, a disable, or the CLI: void.
    if (user.sessionsValidAfter && record.createdAt < user.sessionsValidAfter) {
      sessions.delete(hash);
      this.removeSessionFile(hash);
      return null;
    }
    let refreshed = false;
    if (now - Date.parse(record.lastSeenAt) > TOUCH_EVERY_MS) {
      refreshed = true;
      record.lastSeenAt = new Date(now).toISOString();
      record.expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
      try {
        writeJsonAtomic(path.join(this.sessionsDir, `${hash}.json`), record);
      } catch (error) {
        console.error('Failed to refresh login session:', error.message);
      }
    }
    return { session: record, user, refreshed };
  }

  // This user's live logins, most recently used first. `id` is the hash -- not
  // usable as a cookie, so it is safe to hand to the browser as a handle.
  listLoginSessions(userId) {
    const user = this.getUser(userId);
    const now = Date.now();
    return [...this.loadLoginSessions().values()]
      .filter((s) => s.userId === userId && Date.parse(s.expiresAt) > now)
      .filter((s) => !(user && user.sessionsValidAfter && s.createdAt < user.sessionsValidAfter))
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  }

  // Is the login with this id (the hash) still good? Same rules as
  // getLoginSession, without sliding the expiry.
  isLoginLive(hash) {
    const record = this.loadLoginSessions().get(hash);
    if (!record || Date.parse(record.expiresAt) <= Date.now()) return false;
    const user = this.getUser(record.userId);
    if (!user || user.disabled) return false;
    return !(user.sessionsValidAfter && record.createdAt < user.sessionsValidAfter);
  }

  // Removes this user's logins (all, or all but `except`); returns their ids.
  revokeUserSessions(userId, { except = null } = {}) {
    const removed = [];
    for (const [hash, record] of this.loadLoginSessions()) {
      if (record.userId !== userId || hash === except) continue;
      this.loginSessions.delete(hash);
      this.removeSessionFile(hash);
      removed.push(hash);
    }
    return removed;
  }

  // One login by its id (the hash), only if it belongs to `userId`.
  deleteLoginSessionById(userId, hash) {
    const record = SID_HASH.test(String(hash || '')) ? this.loadLoginSessions().get(hash) : null;
    if (!record || record.userId !== userId) return false;
    this.loginSessions.delete(hash);
    this.removeSessionFile(hash);
    return true;
  }

  // --- Invite codes ---------------------------------------------------------
  // One use each, then gone. Expired ones are dropped whenever the list is read.

  loadInvites() {
    if (this.invites) return this.invites;
    this.invites = new Map();
    for (const inv of readJsonDir(this.invitesDir, INVITE)) {
      if (inv && INVITE.test(String(inv.code))) this.invites.set(inv.code, inv);
    }
    return this.invites;
  }

  removeInviteFile(code) {
    try { fs.unlinkSync(path.join(this.invitesDir, `${code}.json`)); } catch (_) { /* already gone */ }
  }

  listInvites(now = Date.now()) {
    const out = [];
    for (const [code, inv] of this.loadInvites()) {
      if (Date.parse(inv.expiresAt) <= now) {
        this.invites.delete(code);
        this.removeInviteFile(code);
        continue;
      }
      out.push(inv);
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  createInvite({ role = 'user', days = 7, createdBy = null } = {}) {
    const d = Math.min(INVITE_MAX_DAYS, Math.max(1, Math.floor(Number(days)) || 7));
    let code;
    do { code = crypto.randomBytes(9).toString('base64url'); } while (this.loadInvites().has(code));
    const now = Date.now();
    const invite = {
      code,
      role: role === 'admin' ? 'admin' : 'user',
      createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + d * 24 * 60 * 60 * 1000).toISOString(),
    };
    writeJsonAtomic(path.join(this.invitesDir, `${code}.json`), invite);
    this.loadInvites().set(code, invite);
    return invite;
  }

  deleteInvite(code) {
    if (!INVITE.test(String(code || ''))) return false;
    const existed = this.loadInvites().delete(code);
    this.removeInviteFile(code);
    return existed;
  }

  // Sign up with an invite: the code is taken BEFORE the (slow) account
  // creation so two sign-ups cannot share it, and put back if creation fails.
  async registerWithInvite(code, { username, password }) {
    const invite = INVITE.test(String(code || '')) ? this.listInvites().find((i) => i.code === code) : null;
    if (!invite) throw Object.assign(new Error('Invite code is invalid or has expired'), { status: 400 });
    this.invites.delete(code);
    this.removeInviteFile(code);
    try {
      return await this.createUser({ username, password, role: invite.role });
    } catch (error) {
      writeJsonAtomic(path.join(this.invitesDir, `${code}.json`), invite);
      this.loadInvites().set(code, invite);
      throw error;
    }
  }

  // Returns the deleted session's id (the hash), or null.
  deleteLoginSession(sid) {
    if (typeof sid !== 'string' || !sid) return null;
    const hash = sha256(sid);
    const existed = this.loadLoginSessions().delete(hash);
    this.removeSessionFile(hash);
    return existed ? hash : null;
  }
}

module.exports = UserStore;
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;
module.exports.TOUCH_EVERY_MS = TOUCH_EVERY_MS;
