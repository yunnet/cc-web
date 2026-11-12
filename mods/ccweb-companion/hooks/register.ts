import type { Register } from 'claude-code'

// ccweb-companion: tells the cc-web page that started this Claude about its
// cross-session messages, so the page can show one thread per task handed
// over — sent, delivered, held, being worked on, idle, answered.
//
// It observes and tags; it never approves, refuses or holds anything. Every
// report is best effort: if cc-web cannot be reached the message goes exactly
// as it would without this mod.
//
// Threads: the sender's text gets a trailing `[ccw:t=<id>]`, which the
// receiver's copy of this mod strips before its model reads it. cc-web hands
// the id out (and reuses it when a send is a reply), so both ends of a task
// land on one thread.

// Not anchored to the end: the delivered text may still sit inside the
// engine's <cross-session-message> wrapper.
const TAG = /\s*\[ccw:t=([A-Za-z0-9_-]{6,40})\]/
const MSG_ID = /msg_id["':\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const REPORT_TIMEOUT_MS = 2000

type Conf = { url: string; token: string } | null

let conf: Conf | undefined
// The thread of the send in flight, read by the SendMessage tool.call hook
// around it to pair the tool's msg_id with the thread.
let sending: string | undefined

async function config($: any): Promise<Conf> {
  if (conf !== undefined) return conf
  const port = await $.env.get('CCWEB_HOOK_PORT')
  const token = await $.env.get('CCWEB_HOOK_TOKEN')
  const sid = await $.env.get('CCWEB_SESSION_ID')
  conf = port && token && sid
    ? { url: `http://127.0.0.1:${port}/api/hooks/${encodeURIComponent(sid)}`, token }
    : null
  return conf
}

// POST one event; resolves the JSON answer, or null on any failure.
async function report($: any, name: string, body: Record<string, unknown>): Promise<any> {
  try {
    const c = await config($)
    if (!c) return null
    const post = $.http.fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ hook_event_name: name, ...body }),
    }).then((r: any) => (r.ok ? JSON.parse(r.text || 'null') : null))
    const late = $.clock.sleep(REPORT_TIMEOUT_MS).then(() => null)
    return await Promise.race([post, late])
  } catch {
    return null
  }
}

export const register: Register = on => {
  on('session.send', async ($, e, next) => {
    let threadId: string | undefined
    try {
      const answer = await report($, 'ccweb_peer_send', { to: e.to, text: e.text })
      if (answer && typeof answer.threadId === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(answer.threadId)) {
        threadId = answer.threadId
      }
    } catch { /* untagged then */ }
    sending = threadId
    const result = await next(threadId ? { ...e, text: `${e.text}\n[ccw:t=${threadId}]` } : e)
    if (threadId) {
      void report($, 'ccweb_peer_sent', {
        threadId,
        isDelivered: result.isDelivered === true,
        reason: result.isDelivered ? undefined : result.reason,
      })
    }
    return result
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    sending = undefined
    const ran = await next(e)
    try {
      const threadId = sending
      const m = typeof ran.text === 'string' ? ran.text.match(MSG_ID) : null
      if (threadId && m) {
        void report($, 'ccweb_peer_msgid', {
          threadId,
          msgId: m[1].toLowerCase(),
          notifyWhenIdle: (e as any).notify_when_idle === true,
        })
      }
    } catch { /* nothing to pair */ }
    return ran
  })

  on('session.receive', async ($, e, next) => {
    try {
      const kind = e.origin && e.origin.kind
      const text = typeof e.text === 'string' ? e.text : ''
      if (/\[Cross-session (delivery|idle) notice\]/.test(text)) {
        const m = text.match(MSG_ID)
        void report($, 'ccweb_peer_notice', { origin: kind, msgId: m ? m[1].toLowerCase() : null, text: text.slice(0, 2000) })
      } else if (kind === 'peer' || kind === 'peer-send-message') {
        const tag = text.match(TAG)
        const clean = tag ? text.replace(TAG, '') : text
        void report($, 'ccweb_peer_receive', { origin: kind, threadId: tag ? tag[1] : null, text: clean.slice(0, 20000) })
        if (tag) return next({ ...e, text: clean })
      }
    } catch { /* pass it on untouched */ }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const kind = e.origin && e.origin.kind
      const text = typeof e.text === 'string' ? e.text : ''
      // The harness's own notices arrive here as prompts of their own (origin
      // `unclassified`, measured on 2.1.319), not through session.receive.
      if (kind !== 'composer' && /^\s*\[Cross-session (delivery|idle) notice\]/.test(text)) {
        const m = text.match(MSG_ID)
        void report($, 'ccweb_peer_notice', { origin: kind, msgId: m ? m[1].toLowerCase() : null, text: text.slice(0, 2000) })
      } else if (kind === 'peer' || kind === 'peer-send-message') {
        void report($, 'ccweb_peer_processing', { origin: kind })
      }
    } catch { /* not ours to stop */ }
    return next(e)
  })
}
