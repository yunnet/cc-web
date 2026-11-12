const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Peer threads: one entry per task a session handed to another through
// Claude Code's own cross-session messages (SendMessage), as the
// ccweb-companion mod in each Claude reports them.
//
// A thread is created when a session sends, its id travels inside the message
// as a trailing [ccw:t=<id>] tag (added and stripped by the mod), and a send
// back the other way is recognised as the reply. Status only moves forward,
// so a late or duplicated report cannot make a thread look younger than it is.
//
// One file per owner (<dataDir>/<uid>/peer-threads.json), like spaces.json:
// small, rewritten whole, atomically. A thread between two owners' sessions is
// kept separately by each side with only what that side reported — nothing
// from one user's tenant is shown to the other.

const STATUS_ORDER = ['sent', 'delivered', 'held', 'released', 'processing', 'idle', 'replied'];
// Ends of the road: nothing after these is applied.
const FINAL = new Set(['denied', 'expired', 'failed']);
const MAX_THREADS = 200;
const MAX_TEXT = 20000;
// How far back a send the other way still counts as the reply.
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const THREAD_ID = /^[A-Za-z0-9_-]{6,40}$/;

function newThreadId() {
  return 't' + crypto.randomBytes(6).toString('hex');
}

function clip(text) {
  return String(text == null ? '' : text).slice(0, MAX_TEXT);
}

// What a [Cross-session delivery|idle notice] says happened, read from its
// first sentence only: the held notice goes on to explain that "another
// notice follows on release, denial or expiry", which must not count.
// Measured on Claude Code 2.1.319: "... was held by that session (recipient:
// ...; msg_id: ...)"; the idle notice arrives as a prompt of its own
// ("[Cross-session idle notice] "mB", which you asked ... is idle now").
function noticeKind(text) {
  const t = String(text || '');
  const head = t.replace(/^[\s\S]*?\[Cross-session (delivery|idle) notice\]\s*/, '').split(/[.(\n]/)[0];
  if (/\[Cross-session idle notice\]/.test(t)) return /expire/i.test(head) ? 'idle-expired' : 'idle';
  if (!/\[Cross-session delivery notice\]/.test(t)) return null;
  if (/expire/i.test(head)) return 'expired';
  if (/\b(denied|refused|rejected|declined)\b/i.test(head)) return 'denied';
  if (/\bheld\b/i.test(head)) return 'held';
  if (/\b(released|approved|delivered)\b/i.test(head)) return 'released';
  return null;
}

class PeerThreads {
  constructor(storageDir) {
    this.storageDir = storageDir;
    this.threads = null;
    // Notices that arrived before the msg_id they name was paired with a thread.
    this.orphanNotices = new Map();
    this.saveTimer = null;
  }

  get file() {
    return path.join(this.storageDir, 'peer-threads.json');
  }

  load() {
    if (this.threads) return this.threads;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.threads = Array.isArray(parsed.threads) ? parsed.threads.filter((t) => t && THREAD_ID.test(t.id)) : [];
    } catch (_) {
      this.threads = [];
    }
    return this.threads;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 300);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  saveNow() {
    if (!this.threads) return;
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ threads: this.threads }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('Failed to save peer-threads.json:', error.message);
    }
  }

  get(id) {
    return this.load().find((t) => t.id === id) || null;
  }

  // Newest first; only threads that involve sessionId when one is given.
  list(sessionId) {
    const all = this.load();
    const mine = sessionId ? all.filter((t) => t.fromSessionId === sessionId || t.toSessionId === sessionId) : all;
    return mine.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  touch(thread) {
    thread.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return thread;
  }

  // Forward only. A final status sticks; a status behind the current one is
  // ignored (reports can arrive out of order).
  static advance(thread, status) {
    if (FINAL.has(thread.status)) return false;
    if (FINAL.has(status)) { thread.status = status; return true; }
    const from = STATUS_ORDER.indexOf(thread.status);
    const to = STATUS_ORDER.indexOf(status);
    if (to < 0 || to <= from) return false;
    thread.status = status;
    return true;
  }

  add(thread) {
    const list = this.load();
    list.push(thread);
    if (list.length > MAX_THREADS) {
      list.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
      list.splice(0, list.length - MAX_THREADS);
    }
    return this.touch(thread);
  }

  // A session is about to send. Either it answers an open thread that came to
  // it from the target (reply: same id), or it starts a new one.
  // toSessionId is the target as the server resolved it by name, or null.
  beginSend({ fromSessionId, fromName, toName, toSessionId, text, now = Date.now() }) {
    const recent = (t) => now - Date.parse(t.createdAt || 0) < REPLY_WINDOW_MS;
    const open = this.list().filter((t) => t.toSessionId === fromSessionId && !FINAL.has(t.status) && recent(t));
    // A reply names its target by session (resolved by name), by the name, or
    // by the `from` address the incoming message carried — which is what a
    // model copies when it answers.
    const reply = open.find((t) => (toSessionId && t.fromSessionId === toSessionId)
      || (toName && (t.fromName === toName || t.fromAddress === toName)));
    if (reply) {
      reply.replies = reply.replies || [];
      reply.replies.push({ fromSessionId, text: clip(text), at: new Date(now).toISOString() });
      PeerThreads.advance(reply, 'replied');
      this.touch(reply);
      return { thread: reply, isReply: true };
    }
    const at = new Date(now).toISOString();
    const thread = {
      id: newThreadId(),
      fromSessionId, fromName: fromName || null,
      toSessionId: toSessionId || null, toName: toName || null,
      text: clip(text),
      status: 'sent', msgId: null, notifyWhenIdle: false,
      replies: [], notices: [],
      createdAt: at, updatedAt: at,
    };
    this.add(thread);
    return { thread, isReply: false };
  }

  sent(threadId, { isDelivered, reason }) {
    const t = this.get(threadId);
    if (!t) return null;
    if (isDelivered) PeerThreads.advance(t, 'delivered');
    else if (!t.replies.length) { PeerThreads.advance(t, 'failed'); t.failReason = String(reason || '').slice(0, 500); }
    return this.touch(t);
  }

  pairMsgId(threadId, msgId, notifyWhenIdle) {
    const t = this.get(threadId);
    if (!t) return null;
    if (t.replies.length) return t; // a reply's own msg_id is not the thread's
    t.msgId = msgId;
    if (notifyWhenIdle) t.notifyWhenIdle = true;
    const waiting = this.orphanNotices.get(msgId);
    if (waiting) {
      this.orphanNotices.delete(msgId);
      for (const n of waiting) this.applyNotice(t, n.kind, n.text);
    }
    return this.touch(t);
  }

  applyNotice(t, kind, text) {
    t.notices = (t.notices || []).slice(-9);
    t.notices.push({ kind, at: new Date().toISOString() });
    if (kind === 'held') PeerThreads.advance(t, 'held');
    else if (kind === 'released') PeerThreads.advance(t, 'released');
    else if (kind === 'denied') PeerThreads.advance(t, 'denied');
    else if (kind === 'expired') PeerThreads.advance(t, 'expired');
    else if (kind === 'idle') PeerThreads.advance(t, 'idle');
    return this.touch(t);
  }

  // A notice reached the sender. Paired by msg_id; an idle notice may carry
  // none, then it goes to the sender's newest thread that asked for one.
  notice(fromSessionId, { msgId, text }) {
    const kind = noticeKind(text);
    if (!kind) return null;
    const base = kind === 'idle-expired' ? 'idle-expired' : kind;
    let t = msgId ? this.load().find((x) => x.msgId === msgId && x.fromSessionId === fromSessionId) : null;
    if (!t && msgId && base !== 'idle' && base !== 'idle-expired') {
      const list = this.orphanNotices.get(msgId) || [];
      list.push({ kind: base, text });
      this.orphanNotices.set(msgId, list.slice(-5));
      return null;
    }
    if (!t && (base === 'idle' || base === 'idle-expired')) {
      t = this.list(fromSessionId).find((x) => x.fromSessionId === fromSessionId && x.notifyWhenIdle && !FINAL.has(x.status) && x.status !== 'idle' && x.status !== 'replied');
    }
    if (!t) return null;
    return this.applyNotice(t, base === 'idle-expired' ? 'idle-expired' : base, text);
  }

  // A message reached toSessionId. With a known thread id it is either the
  // thread arriving at its recipient, or the reply arriving back home; without
  // one (a sender cc-web does not run) it starts a receive-only thread.
  received(toSessionId, { threadId, text, toName, fromAddress, fromName }) {
    const t = threadId ? this.get(threadId) : null;
    if (t) {
      if (fromAddress && !t.fromAddress && t.fromSessionId !== toSessionId) t.fromAddress = fromAddress;
      if (t.fromSessionId === toSessionId) {
        // The reply arriving home. Recorded by the replier's report when both
        // sessions are this owner's; from another owner's session it was not,
        // so it is taken from what arrived.
        const last = t.replies[t.replies.length - 1];
        if (last && !last.arrived) last.arrived = true;
        else {
          t.replies.push({ fromSessionId: null, text: clip(text), at: new Date().toISOString(), arrived: true });
          PeerThreads.advance(t, 'replied');
        }
        return this.touch(t);
      }
      if (!t.toSessionId) t.toSessionId = toSessionId;
      if (t.toSessionId === toSessionId) PeerThreads.advance(t, 'delivered');
      return this.touch(t);
    }
    const at = new Date().toISOString();
    const thread = {
      id: THREAD_ID.test(threadId || '') ? threadId : newThreadId(),
      fromSessionId: null, fromName: fromName || null, fromAddress: fromAddress || null,
      toSessionId, toName: toName || null,
      text: clip(text),
      status: 'delivered', msgId: null, notifyWhenIdle: false,
      replies: [], notices: [],
      createdAt: at, updatedAt: at,
    };
    return this.add(thread);
  }

  // The recipient's Claude started on a peer message: its newest thread
  // still waiting to be worked on.
  processing(toSessionId) {
    const t = this.list(toSessionId).find((x) => x.toSessionId === toSessionId && ['delivered', 'held', 'released'].includes(x.status));
    if (!t) return null;
    PeerThreads.advance(t, 'processing');
    return this.touch(t);
  }

  // The recipient's turn ended (Stop hook): what it was working on is done.
  stopped(toSessionId) {
    const changed = [];
    for (const t of this.load()) {
      if (t.toSessionId === toSessionId && t.status === 'processing' && PeerThreads.advance(t, 'idle')) {
        changed.push(this.touch(t));
      }
    }
    return changed;
  }
}

module.exports = { PeerThreads, noticeKind, STATUS_ORDER, MAX_THREADS };
