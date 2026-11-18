import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostFixture, project } from './helpers.ts';

const words = ['测试第一句。', '测试第二句。', '测试第三句。'];
const runIdPattern = /本轮ID：([a-f0-9-]+)/;

async function until(check: () => boolean | Promise<boolean>, description: string) {
  const end = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < end, description);
    await delay(25);
  }
}

function tool(name: string, args: Record<string, unknown>, id: string) {
  return { text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

async function fixture(t: TestContext) {
  const f = await hostFixture(t, undefined, 'autonomy', process.env.AUTONOMY_TEST_PACKAGE || project);
  const service = () => f.app.runtime.services.get('autonomy').value;
  const status = () => service().status();
  const doc = async (session = f.sessionId) =>
    (await f.app.memoryEngine.plugin('autonomy', () => {}).readDocument(session, 'intents')).data;
  const url = 'http://127.0.0.1:' + f.app.web.server.address().port;
  const login = await fetch(url + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const post = async (body: object) => fetch(url + '/plugins/autonomy/state', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const state = await status();
  assert.equal((await post({ action: 'configure', config: { ...state.config, enabled: true, allowSelfWake: true, probability: 0 }, revision: state.revision })).status, 200);

  const dir = join(f.root, 'plugins/qq');
  await mkdir(dir);
  await copyFile(join(project, 'tests/fixtures/qq-expression-provider.ts'), join(dir, 'index.ts'));
  await writeFile(join(dir, 'plugin.yaml'), 'id: qq\nname: Synthetic QQ\nversion: 0.21.0\ndescription: Synthetic text delivery provider\napiVersion: "1"\n');
  const provider = await f.app.runtime.loadPath('qq');
  assert.equal(provider.status, 'active', provider.error);
  const control = f.app.runtime.services.get('qq-test').value;
  await until(async () => (await control.outcome()).queries.includes(f.sessionId), 'the optional binding scans the active session');
  return { ...f, doc, status, outcome: () => control.outcome(), reconnect: () => control.reconnect(),
    disconnect: (unknown = false, publish = true) => control.disconnect(f.sessionId, unknown, publish) };
}

for (const choice of ['resume', 'defer'] as const) {
  test('QQ recovery lets the model choose ' + choice + ' using the unfinished thought from the original session', { timeout: 30000 }, async t => {
    const f = await fixture(t);
    if (choice === 'defer') {
      await f.app.runtime.action('autonomy', 'stop');
      await f.disconnect(false, false);
      await f.app.runtime.action('autonomy', 'start');
    } else {
      await f.disconnect();
    }
    await until(async () => (await f.doc())?.items.length === 1, 'one persisted thought after disconnect or loss of all notifications');
    const initial = (await f.doc()).items[0];
    assert.equal(initial.kind, 'thought'); assert.equal(initial.dueAt, null);
    assert.ok(!JSON.stringify(await f.doc()).includes(words[1]));
    const other = await f.app.sessions.create('synthetic second session');
    assert.equal((await f.doc(other))?.items?.length ?? 0, 0);
    if (choice === 'resume') {
      await f.app.runtime.action('autonomy', 'reload');
      assert.equal((await f.doc()).items[0].id, initial.id);
      await f.app.sessions.current({ id: other });
    } else {
      f.app.llm.chat = async () => ({ text: '知道了，稍后再说。', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      await f.app.channels.web(f.sessionId, '先忙手头的事，稍后再谈青柠。', () => {});
    }
    const seen: string[] = [];
    let callbacks = 0, revision: string, decisionResult: any, scriptError: unknown;
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    f.close.push(() => release());
    f.app.llm.chat = async (input: any) => {
      try {
        const messages = JSON.stringify(input.messages), runId = runIdPattern.exec(messages)?.[1];
        assert.ok(runId, 'the model receives a real autonomous judgment'); callbacks++;
        const previous = input.messages.filter((m: any) => m.role === 'tool').at(-1);
        if (callbacks === 1) {
          await gate;
          assert.ok(messages.includes(initial.id), 'the judgment can discover its linked thought');
          if (choice === 'defer') assert.match(messages, /稍后再谈青柠/);
          return tool('autonomy_qq_expression', { action: 'detail', intentId: initial.id }, 'read-' + runId);
        }
        const reply = JSON.parse(previous.content);
        assert.equal(reply.ok, true, JSON.stringify(reply));
        if (callbacks === 2) {
          assert.equal(reply.result.status, 'ok', JSON.stringify(reply));
          const item = reply.result.item;
          seen.push(...item.parts.map((p: any) => p.text));
          revision = item.revision;
          if (choice === 'defer') {
            return tool('autonomy_intents', { action: 'remember', kind: 'thought', source: 'self',
              requestId: 'unsafe-thought', text: seen[1], evidence: '刚读到原话' }, 'generic-write');
          }
        }
        if (choice === 'defer' && callbacks === 3) {
          assert.equal(reply.result.ok, false, 'quoting temporary text cannot create another thought');
          return tool('autonomy_schedule', { action: 'set', requestId: 'unsafe-schedule', version: 0,
            at: new Date(Date.now() + 3600000).toISOString(), reason: seen[1] }, 'schedule-write');
        }
        if (choice === 'defer' && callbacks === 4) assert.equal(reply.result.ok, false, 'a wake reason cannot persist the temporary text');
        if (callbacks === (choice === 'resume' ? 2 : 4)) {
          return tool('autonomy_qq_decide', { action: choice, intentId: initial.id, revision }, 'decide-' + runId);
        }
        assert.equal(callbacks, choice === 'resume' ? 3 : 5);
        decisionResult = reply.result;
        return tool('autonomy_finish', { runId, decision: choice === 'resume' ? 'acted' : 'no_action',
          reason: '本轮判断依据包含原话：' + seen[1] }, 'finish-' + runId);
      } catch (error) { scriptError = error; throw error; }
    };
    await f.reconnect();
    if (choice === 'resume') {
      await delay(1300);
      assert.equal(callbacks, 0, 'an online notice must not wake a different session');
      assert.deepEqual((await f.outcome()).submitted, words.slice(0, 1));
      await f.app.sessions.current({ id: f.sessionId });
    }
    await until(() => callbacks > 0, 'reconnection queues one autonomous judgment');
    assert.deepEqual((await f.outcome()).submitted, words.slice(0, 1), 'before the judgment, reconnect alone delivers nothing');
    release();
    await until(async () => {
      if (scriptError) throw scriptError;
      return (await f.status()).runs.some((r: any) => r.trigger === 'qq_resume' && r.phase === 'completed');
    }, 'judgment finishes silently');
    assert.deepEqual(seen, words);
    assert.equal(decisionResult.status, choice === 'resume' ? 'sent' : 'deferred');
    assert.deepEqual((await f.outcome()).submitted, choice === 'resume' ? words : words.slice(0, 1));
    assert.equal((await f.outcome()).resumeCalls, choice === 'resume' ? 1 : 0);
    assert.equal((await f.doc()).items.length, choice === 'resume' ? 0 : 1);
    await f.reconnect();
    await delay(1300);
    assert.equal((await f.status()).runs.filter((r: any) => r.trigger === 'qq_resume').length, 1);
    assert.equal(callbacks, choice === 'resume' ? 3 : 5, 'duplicate online events do not force a second decision');
    assert.ok(!JSON.stringify(await f.doc()).includes(words[1]));
    const memory = await f.app.memoryEngine.state(f.sessionId);
    assert.ok(memory.records.some((r: any) => r.text?.includes('自主判断结束')));
    for (const persisted of [memory, await f.app.memory.readSession(f.sessionId), await f.status()]) {
      assert.ok(!JSON.stringify(persisted).includes(words[1]), 'QQ original text must not leak through a persistent tool or finish reason');
    }
  });
}

test('an unknown QQ segment stays pending; only an explicit reasoned abandonment closes it', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.disconnect(true);
  await until(async () => (await f.doc())?.items.length === 1, 'an unknown delivery is remembered');
  const [thought] = (await f.doc()).items;
  const session = { id: f.sessionId, permission: 'full' };
  const call = async (name: string, args: object) => (await f.app.tools.call(name, args, session)).result;
  const detail = await call('autonomy_qq_expression', { action: 'detail', intentId: thought.id });
  assert.equal(detail.item.state, 'unknown');
  const args = { intentId: thought.id, revision: detail.item.revision };
  assert.equal((await call('autonomy_qq_decide', { ...args, action: 'resume' })).status, 'blocked');
  assert.equal((await f.outcome()).resumeCalls, 0);
  const attempt = await call('autonomy_intents', { action: 'complete', requestId: 'synthetic-complete', intentId: thought.id,
    version: thought.version, reason: '测试错误确认', evidence: '尚无完整回执' });
  assert.equal(attempt.ok, false);
  assert.equal((await f.doc()).items.length, 1);
  const missing = await call('autonomy_qq_decide', { ...args, action: 'abandon' });
  assert.notEqual(missing.status, 'dismissed'); assert.equal((await f.outcome()).dismissCalls, 0);
  const abandoned = await call('autonomy_qq_decide', { ...args, action: 'abandon', reason: '这个话题已经结束，我决定不再补充。' });
  assert.equal(abandoned.status, 'dismissed', JSON.stringify(abandoned));
  assert.equal((await f.outcome()).dismissCalls, 1);
  assert.equal((await f.doc()).items.length, 0);
  assert.deepEqual((await f.outcome()).submitted, words.slice(0, 1));
  assert.match(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /话题已经结束/);
});
