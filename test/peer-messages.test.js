const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PeerThreads, noticeKind, MAX_THREADS } = require('../src/peer-messages');

// Peer threads: one SendMessage hand-off between two sessions, as the
// ccweb-companion mod reports it step by step.
describe('peer threads', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-peer-'));
    store = new PeerThreads(dir);
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const send = (over = {}) => store.beginSend({ fromSessionId: 'A', fromName: 'alpha', toName: 'beta', toSessionId: 'B', text: 'fix PMS', ...over });

  it('walks a hand-off from sent to replied', function () {
    const { thread, isReply } = send();
    assert.strictEqual(isReply, false);
    assert.strictEqual(thread.status, 'sent');
    store.sent(thread.id, { isDelivered: true });
    store.pairMsgId(thread.id, '50737af5-c725-439f-a4e1-bf45db4f1137', true);
    store.received('B', { threadId: thread.id, text: 'fix PMS' });
    store.notice('A', { msgId: '50737af5-c725-439f-a4e1-bf45db4f1137', text: '[Cross-session delivery notice] Your message to another session was held by that session' });
    assert.strictEqual(store.get(thread.id).status, 'held');
    store.processing('B');
    assert.strictEqual(store.get(thread.id).status, 'processing');
    assert.strictEqual(store.stopped('B').length, 1);
    assert.strictEqual(store.get(thread.id).status, 'idle');

    // B answers A: the same thread, not a new one.
    const back = store.beginSend({ fromSessionId: 'B', fromName: 'beta', toName: 'alpha', toSessionId: 'A', text: 'done: 2 files' });
    assert.strictEqual(back.isReply, true);
    assert.strictEqual(back.thread.id, thread.id);
    assert.strictEqual(store.get(thread.id).status, 'replied');
    assert.strictEqual(store.get(thread.id).replies[0].text, 'done: 2 files');
    assert.strictEqual(store.list().length, 1);
  });

  it('never moves a thread backwards, and a final status sticks', function () {
    const { thread } = send();
    store.processing('B'); // nothing delivered yet: not this thread's step
    store.received('B', { threadId: thread.id, text: 'x' });
    store.processing('B');
    store.received('B', { threadId: thread.id, text: 'x' }); // a late duplicate
    assert.strictEqual(store.get(thread.id).status, 'processing');

    const other = send({ text: 'second' }).thread;
    store.pairMsgId(other.id, '11111111-2222-3333-4444-555555555555');
    store.notice('A', { msgId: '11111111-2222-3333-4444-555555555555', text: '[Cross-session delivery notice] Your message to another session was denied by that session' });
    store.notice('A', { msgId: '11111111-2222-3333-4444-555555555555', text: '[Cross-session delivery notice] Your message to another session was held by that session' });
    assert.strictEqual(store.get(other.id).status, 'denied');
  });

  it('matches a reply addressed by the from address the message carried', function () {
    const { thread } = send({ toSessionId: null });
    store.received('B', { threadId: thread.id, text: 'x', fromAddress: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-abc' });
    const back = store.beginSend({ fromSessionId: 'B', toName: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-abc', toSessionId: null, text: 'ok' });
    assert.strictEqual(back.isReply, true);
    assert.strictEqual(back.thread.id, thread.id);
  });

  it('takes a reply that only arrived (sent from another owner\'s session)', function () {
    const { thread } = send();
    store.received('A', { threadId: thread.id, text: 'done over there' });
    assert.strictEqual(store.get(thread.id).status, 'replied');
    assert.deepStrictEqual(store.get(thread.id).replies.map((r) => r.text), ['done over there']);
  });

  it('a send to someone else is a new thread, not a reply', function () {
    const { thread } = send();
    store.received('B', { threadId: thread.id, text: 'x' });
    const fresh = store.beginSend({ fromSessionId: 'B', toName: 'gamma', toSessionId: 'C', text: 'other work' });
    assert.strictEqual(fresh.isReply, false);
    assert.notStrictEqual(fresh.thread.id, thread.id);
  });

  it('pairs a notice that arrived before its msg_id', function () {
    const { thread } = send();
    const id = '22222222-2222-3333-4444-555555555555';
    assert.strictEqual(store.notice('A', { msgId: id, text: '[Cross-session delivery notice] Your message to another session was held by that session' }), null);
    store.pairMsgId(thread.id, id);
    assert.strictEqual(store.get(thread.id).status, 'held');
  });

  it('keeps a message from outside cc-web as a receive-only thread', function () {
    const t = store.received('B', { threadId: null, text: 'hello from a terminal session', fromName: 'term' });
    assert.strictEqual(t.fromSessionId, null);
    assert.strictEqual(t.status, 'delivered');
    assert.deepStrictEqual(store.list('B').map((x) => x.id), [t.id]);
    assert.deepStrictEqual(store.list('A'), []);
  });

  it('persists, and caps the list at the newest threads', function () {
    for (let i = 0; i < MAX_THREADS + 5; i++) send({ text: 'n' + i });
    assert.strictEqual(store.list().length, MAX_THREADS);
    store.saveNow();
    const again = new PeerThreads(dir);
    assert.strictEqual(again.list().length, MAX_THREADS);
  });

  it('reads the notice wording', function () {
    assert.strictEqual(noticeKind('[Cross-session delivery notice] Your message to another session was held by that session'), 'held');
    assert.strictEqual(noticeKind('[Cross-session idle notice] the session is idle'), 'idle');
    assert.strictEqual(noticeKind('[Cross-session idle notice] subscription expired'), 'idle-expired');
    assert.strictEqual(noticeKind('nothing to see'), null);
    // The real held notice (2.1.319) goes on to mention "release, denial or
    // expiry" — only its first sentence decides.
    const held = '[Cross-session delivery notice] Your message to another session was held by that session (recipient: uds:pipe-cc-msg-3961; msg_id: 50737af5-c725-439f-a4e1-bf45db4f1137). NOT delivered: its Claude has not seen it. Do not report it as delivered. The usual cause is that the two sessions run in different permission modes: a terminal session then asks its user to approve, but a Claude Desktop or non-interactive session cannot ask, so there the hold expires undelivered unless the modes come to match. Another notice follows on release, denial or expiry.';
    assert.strictEqual(noticeKind(held), 'held');
    // The real denial (2.1.319), received 2026-11-11.
    assert.strictEqual(noticeKind('[Cross-session delivery notice] Your message to another session was denied by the recipient user (recipient: uds:pipe-cc-msg-3961; msg_id: 50737af5-c725-439f-a4e1-bf45db4f1137). Not delivered to that session\'s Claude. Do not wait for a reply; continue, or choose another approach.'), 'denied');
    assert.strictEqual(noticeKind('[Cross-session idle notice] "mB", which you asked to be notified about, is idle now — it finished a turn at 19:55.'), 'idle');
  });
});
