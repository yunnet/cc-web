const fs = require('fs');
const path = require('path');

// Which cc-web account a Claude conversation belongs to. Everyone's Claude
// runs on the shared ~/.claude (user 2026-11-06), and a transcript records no
// account, so the 总览 can only split usage by account through what cc-web
// itself saw: a session (owned by one user) starting Claude under a
// conversation id. Recorded at every start and on every conversation switch
// (/clear), kept in <dataDir>/platform/conversation-owners.json so it outlives
// the tab — a deleted tab's conversation still counts for its account.
// The first owner recorded keeps it.
class ConversationOwners {
  constructor(fileFn) {
    this.fileFn = fileFn;
    this.map = null;
  }

  load() {
    if (this.map) return this.map;
    this.map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.fileFn(), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, owner] of Object.entries(raw)) {
          if (typeof owner === 'string' && owner) this.map.set(id, owner);
        }
      }
    } catch (_) { /* none yet, or unreadable: start empty */ }
    return this.map;
  }

  get(id) {
    return this.load().get(id) || null;
  }

  record(id, ownerId) {
    if (!id || !ownerId) return false;
    const map = this.load();
    if (map.has(id)) return false;
    map.set(id, ownerId);
    const file = this.fileFn();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_e) { /* nothing to clean up */ }
    }
    return true;
  }
}

module.exports = { ConversationOwners };
