const fs = require('fs');
const os = require('os');
const path = require('path');

// Points a server's data dir (sessions, spaces, platform users) at a fresh temp
// directory, so a test never reads or writes the real ~/.cc-web/data. Call it
// right after constructing the server. Returns the directory for cleanup.
function useTempDataDir(server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-auth-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  server.sessionStore.storageDir = dir;
  server.spaceStore.storageDir = dir;
  server.userStore.users = null;
  server.userStore.loginSessions = null;
  server.userStore.invites = null;
  return dir;
}

// A signed-in identity without going through the login page: creates the user
// if needed and returns the Cookie header value for a fresh login session.
async function signIn(server, { username = 'admin', password = 'password-123', role = 'admin' } = {}) {
  const user = server.userStore.findByUsername(username)
    || await server.userStore.createUser({ username, password, role });
  const sid = server.userStore.createLoginSession(user.id, { ua: 'test' });
  return { user, sid, cookie: `${server.cookieName()}=${sid}` };
}

module.exports = { useTempDataDir, signIn };
