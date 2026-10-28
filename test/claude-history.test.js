const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../src/utils/claude-history');

// A transcript head shaped like Claude Code writes one: machinery first, then
// the prompt the user actually typed.
function transcript(lines) {
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

const META = [
  { type: 'mode', mode: 'normal', sessionId: 'x' },
  { type: 'bridge-session', sessionId: 'x' },
  { type: 'user', isMeta: true, message: { content: 'meta noise' } },
  { type: 'user', message: { content: '<local-command-caveat>Caveat: …</local-command-caveat>' } },
  { type: 'user', message: { content: '<command-name>/clear</command-name>' } }
];

describe('claude-history', function() {
  describe('projectDirName', function() {
    it('flattens a working directory the way Claude Code does', function() {
      assert.strictEqual(
        history.projectDirName('/data/work/gongxinyun/ts/cc-web'),
        '-data-work-gongxinyun-ts-cc-web'
      );
      assert.strictEqual(history.projectDirName('/home/me/.config/app_v2'), '-home-me--config-app-v2');
    });
  });

  describe('extractTitle', function() {
    it('takes the first real prompt, skipping meta and command echoes', function() {
      const head = transcript([...META, { type: 'user', message: { content: '  修复浅色主题对比度  ' } }]);
      assert.strictEqual(history.extractTitle(head), '修复浅色主题对比度');
    });

    it("prefers Claude's own title, and its latest one", function() {
      // 2.1.278 writes ai-title records and rewrites them as the chat moves on.
      const head = transcript([
        ...META,
        { type: 'user', message: { content: 'a long first prompt that makes a poor title' } },
        { type: 'ai-title', aiTitle: 'First guess', sessionId: 'x' },
        { type: 'summary', summary: 'older format' },
        { type: 'ai-title', aiTitle: 'Fix plan-link underline', sessionId: 'x' }
      ]);
      assert.strictEqual(history.extractTitle(head), 'Fix plan-link underline');
    });

    it('lets a title a person gave (/rename, --name) beat Claude\'s own', function() {
      const head = transcript([
        { type: 'user', message: { content: 'first prompt' } },
        { type: 'ai-title', aiTitle: 'Claude title', sessionId: 'x' },
        { type: 'custom-title', customTitle: '发布前检查', sessionId: 'x' },
        { type: 'ai-title', aiTitle: 'Later Claude title', sessionId: 'x' }
      ]);
      assert.strictEqual(history.extractTitle(head), '发布前检查');
    });

    it('prefers a summary line over the first prompt', function() {
      const head = transcript([
        { type: 'summary', summary: 'Plan mode via hooks' },
        ...META,
        { type: 'user', message: { content: 'something else' } }
      ]);
      assert.strictEqual(history.extractTitle(head), 'Plan mode via hooks');
    });

    it('ignores tool results (array content) and sidechains', function() {
      const head = transcript([
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'ls output' }] }, toolUseResult: {} },
        { type: 'user', isSidechain: true, message: { content: 'subagent prompt' } },
        { type: 'user', message: { content: 'the real one' } }
      ]);
      assert.strictEqual(history.extractTitle(head), 'the real one');
    });

    it('collapses whitespace and clips long prompts', function() {
      const head = transcript([{ type: 'user', message: { content: 'a\nb ' + 'x'.repeat(200) } }]);
      const title = history.extractTitle(head);
      assert.ok(title.length <= 80, `title too long: ${title.length}`);
      assert.ok(title.startsWith('a b xxx'));
      assert.ok(title.endsWith('…'));
    });

    it('survives a truncated last line and returns null when there is no prompt', function() {
      const head = transcript(META) + '{"type":"user","message":{"content":"cut off her';
      assert.strictEqual(history.extractTitle(head), null);
    });
  });

  describe('listConversations / hasConversation', function() {
    let root;
    const dir = '/data/work/demo';
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';

    beforeEach(function() {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-projects-'));
      const proj = path.join(root, history.projectDirName(dir));
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, `${A}.jsonl`), transcript([...META, { type: 'user', message: { content: 'older chat' } }]));
      fs.writeFileSync(path.join(proj, `${B}.jsonl`), transcript([{ type: 'user', message: { content: 'newer chat' } }]));
      // Newest first is by mtime, so make the order unambiguous.
      const past = new Date(Date.now() - 3600_000);
      fs.utimesSync(path.join(proj, `${A}.jsonl`), past, past);
      // Files that are not conversations must not show up.
      fs.writeFileSync(path.join(proj, 'notes.md'), '# not a transcript');
      fs.writeFileSync(path.join(proj, 'nope.jsonl'), '{}');
      fs.mkdirSync(path.join(proj, 'memory'));
    });

    afterEach(function() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    });

    it('lists uuid transcripts newest first, with titles', async function() {
      const list = await history.listConversations(dir, { root });
      assert.deepStrictEqual(list.map(c => c.id), [B, A]);
      assert.deepStrictEqual(list.map(c => c.title), ['newer chat', 'older chat']);
      assert.ok(list[0].sizeBytes > 0);
      assert.ok(!Number.isNaN(Date.parse(list[0].updatedAt)));
    });

    it("reads the latest ai-title from the tail of a transcript too big for one window", async function() {
      // The head window alone would only see the first prompt; the newest
      // title is written near the end.
      const proj = path.join(root, history.projectDirName(dir));
      const filler = { type: 'attachment', data: 'x'.repeat(1000) };
      fs.writeFileSync(path.join(proj, `${B}.jsonl`), transcript([
        { type: 'user', message: { content: 'first prompt' } },
        { type: 'ai-title', aiTitle: 'Early title', sessionId: B },
        ...Array(300).fill(filler),
        { type: 'ai-title', aiTitle: 'Late title', sessionId: B },
        { type: 'last-prompt', sessionId: B }
      ]));
      assert.ok(fs.statSync(path.join(proj, `${B}.jsonl`)).size > 128 * 1024, 'fixture must exceed the head window');
      const list = await history.listConversations(dir, { root });
      assert.strictEqual(list.find(c => c.id === B).title, 'Late title');
    });

    it('lets a name from the head beat a newer Claude title in the tail', async function () {
      // /rename or --name early on, then Claude titles later: the person's
      // name must still win, wherever in the file each one sits.
      const proj = path.join(root, history.projectDirName(dir));
      const filler = { type: 'attachment', data: 'x'.repeat(1000) };
      fs.writeFileSync(path.join(proj, `${B}.jsonl`), transcript([
        { type: 'user', message: { content: 'first prompt' } },
        { type: 'custom-title', customTitle: '发布前检查', sessionId: B },
        ...Array(300).fill(filler),
        { type: 'ai-title', aiTitle: 'Claude later title', sessionId: B }
      ]));
      assert.ok(fs.statSync(path.join(proj, `${B}.jsonl`)).size > 128 * 1024, 'fixture must exceed the head window');
      const list = await history.listConversations(dir, { root });
      assert.strictEqual(list.find(c => c.id === B).title, '发布前检查');
    });

    it('keeps a prompt holding U+2028/U+2029 line separators', async function() {
      // Upstream 2.1.296 fixed transcript GC dropping records whose text held
      // these; our regression is that the parser never treats a separator
      // inside a JSON string as a record boundary.
      const proj = path.join(root, history.projectDirName(dir));
      const title = 'before after end';
      fs.writeFileSync(path.join(proj, `${B}.jsonl`), transcript([
        { type: 'user', message: { content: title } }
      ]));
      const list = await history.listConversations(dir, { root });
      // The record survives and the title renders with the separators
      // normalized to spaces — dropped would be list without B, null title.
      assert.strictEqual(list.find(c => c.id === B).title, 'before after end');
    });

    it('honours the limit and returns [] for a directory Claude has never seen', async function() {
      assert.strictEqual((await history.listConversations(dir, { root, limit: 1 })).length, 1);
      assert.deepStrictEqual(await history.listConversations('/data/work/unknown', { root }), []);
    });

    it('finds the project directory by recorded cwd when the name encoding misses', async function() {
      const odd = path.join(root, 'oddly-named-project');
      fs.mkdirSync(odd);
      fs.writeFileSync(
        path.join(odd, `${A}.jsonl`),
        transcript([{ type: 'user', cwd: '/data/work/moved', message: { content: 'relocated chat' } }])
      );
      const list = await history.listConversations('/data/work/moved', { root });
      assert.deepStrictEqual(list.map(c => c.title), ['relocated chat']);
    });

    it('hasConversation gates on the directory, the id shape and the file', async function() {
      assert.strictEqual(await history.hasConversation(dir, A, { root }), true);
      assert.strictEqual(await history.hasConversation(dir, 'not-a-uuid', { root }), false);
      assert.strictEqual(await history.hasConversation('/data/work/unknown', A, { root }), false);
      assert.strictEqual(
        await history.hasConversation(dir, '33333333-3333-4333-8333-333333333333', { root }),
        false
      );
    });
  });

  describe('listUserPrompts', function() {
    let root;
    const dir = '/data/work/demo';
    const A = '44444444-4444-4444-8444-444444444444';

    beforeEach(function() {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-prompts-'));
      fs.mkdirSync(path.join(root, history.projectDirName(dir)), { recursive: true });
    });
    afterEach(function() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    });
    const fileOf = () => path.join(root, history.projectDirName(dir), `${A}.jsonl`);

    it('returns the typed questions in order, skipping machinery and tool results', async function() {
      fs.writeFileSync(fileOf(), transcript([
        ...META,
        { type: 'user', message: { content: '第一问' }, timestamp: '2026-10-29T10:00:00Z' },
        { type: 'assistant', message: { content: [{ type: 'text', text: '答' }] } },
        { type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } },
        { type: 'user', isSidechain: true, message: { content: '子代理内部话' } },
        { type: 'user', message: { content: '  第二问\n换行也\n算一问  ' } },
      ]));
      const { prompts, truncated } = await history.listUserPrompts(dir, A, { root });
      assert.strictEqual(truncated, false);
      assert.deepStrictEqual(prompts.map(p => p.text), ['第一问', '第二问 换行也 算一问']);
      assert.deepStrictEqual(prompts.map(p => p.i), [0, 1]);
      assert.strictEqual(prompts[0].ts, '2026-10-29T10:00:00Z');
    });

    it('clips each prompt to 200 chars on one line', async function() {
      fs.writeFileSync(fileOf(), transcript([
        { type: 'user', message: { content: '长'.repeat(300) } },
      ]));
      const { prompts } = await history.listUserPrompts(dir, A, { root });
      assert.strictEqual(prompts[0].text.length, 200);
      assert.ok(prompts[0].text.endsWith('…'));
    });

    it('empty for a missing transcript, a bad id, or an unknown dir — never a throw', async function() {
      fs.writeFileSync(fileOf(), transcript([{ type: 'user', message: { content: '有转录' } }]));
      assert.deepStrictEqual(await history.listUserPrompts(dir, A, { root }), { prompts: [{ i: 0, text: '有转录', ts: null }], truncated: false });
      assert.deepStrictEqual((await history.listUserPrompts(dir, '55555555-5555-4555-8555-555555555555', { root })).prompts, []);
      assert.deepStrictEqual((await history.listUserPrompts(dir, 'not-a-uuid', { root })).prompts, []);
      assert.deepStrictEqual((await history.listUserPrompts('/data/work/nowhere', A, { root })).prompts, []);
    });

    it('parses incrementally: a growing transcript appends only the new turn', async function() {
      fs.writeFileSync(fileOf(), transcript([
        { type: 'user', message: { content: '第一问' } },
        { type: 'assistant', message: { content: '答' } },
      ]));
      const first = await history.listUserPrompts(dir, A, { root });
      assert.deepStrictEqual(first.prompts.map(p => p.text), ['第一问']);

      // A long agentic tail lands between the two questions — exactly the
      // shape that defeated a fixed tail window (measured live: a 4.7MB
      // transcript whose last 256KB were all tool results).
      const pad = { type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } };
      fs.appendFileSync(fileOf(), transcript(Array(50).fill(pad)));
      fs.appendFileSync(fileOf(), transcript([{ type: 'user', message: { content: '第二问' } }]).trimEnd() + '\n');
      const second = await history.listUserPrompts(dir, A, { root });
      assert.deepStrictEqual(second.prompts.map(p => p.text), ['第一问', '第二问']);
      assert.strictEqual(second.truncated, false);
    });

    it('resumes across a mid-line write boundary (partial line held back)', async function() {
      fs.writeFileSync(fileOf(), transcript([{ type: 'user', message: { content: '第一问' } }]));
      // A record cut mid-line, as while Claude is writing it.
      fs.appendFileSync(fileOf(), '{"type":"user","message":{"role":"user","content":"第');
      const mid = await history.listUserPrompts(dir, A, { root });
      assert.deepStrictEqual(mid.prompts.map(p => p.text), ['第一问']);
      // The rest of the line lands: the next call must join it correctly.
      fs.appendFileSync(fileOf(), '二问"} }\n');
      const done = await history.listUserPrompts(dir, A, { root });
      assert.deepStrictEqual(done.prompts.map(p => p.text), ['第一问', '第二问']);
    });

    it('follows a symlinked working dir to its realpath', async function() {
      // Claude records transcripts under the REAL path (macOS /tmp →
      // /private/tmp); asking through the symlink must still find them.
      // Measured live: without this, a /tmp project's prompts came back [].
      // Mirror production exactly: a REAL existing dir, its transcript under
      // the encoding of its realpath, queried through a symlink to it.
      const realWork = path.join(root, 'w', 'real');
      fs.mkdirSync(realWork, { recursive: true });
      const proj = path.join(root, history.projectDirName(fs.realpathSync(realWork)));
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, `${A}.jsonl`),
        transcript([{ type: 'user', message: { content: '通过符号链接问的问题' } }]));
      const link = path.join(root, 'w', 'link');
      fs.symlinkSync(realWork, link);
      const { prompts } = await history.listUserPrompts(link, A, { root });
      assert.deepStrictEqual(prompts.map(p => p.text), ['通过符号链接问的问题']);
    });
  });
});
