import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChannelHandle, Context } from 'whalelife';
import { hostFixture, project } from './helpers.ts';

const body = '临时私聊正文蓝石英';
const comment = '临时外部资料绿石英';
const owner = 'direct:200002';
const other = 'direct:200003';
const sum = (v: string) => createHash('sha256').update(v).digest('hex');
const usage = { prompt_tokens: 1, completion_tokens: 1 };
const tool = (name: string, args: object, id: string) =>
  ({ text: '', toolCalls: [{ name, arguments: JSON.stringify(args), id }], usage });

test('reading a temporary comment → partial QQ send → a vague ordinary question gets the facts for its own peer', async t => {
  const f = await hostFixture(t, undefined, 'autonomy', process.env.AUTONOMY_TEST_PACKAGE || project);
  const api = () => f.app.runtime.services.get('autonomy').value;
  let handle!: ChannelHandle;
  const delivered: string[] = [];
  const descriptor = '[QQ 临时私聊；正文不留存；指纹 ' + sum(body) + ']';
  await f.app.runtime.builtin('qq', {}, (ctx: Context) => {
    handle = ctx.channels.register({
      id: 'qq', name: 'QQ 私聊', account: '100001', persona: 'a', permission: 'full',
      async send(message) {
        if (message.replyTo) { delivered.push(message.text); return; }
        assert.equal(message.text, descriptor);
        throw Error('QQ 投递部分完成：共 8 段，确认发送 2 段，明确未发送 6 段（其中 5 段未提交），结果未知 0 段。没有对方已读或不愿回复的证据。不要自动重发或更换动作 ID 重试。');
      },
    });
    ctx.tools.register({
      name: 'qq_send_message', description: '隔离 QQ 发送', schema: {}, danger: 'safe',
      origin: { platform: 'QQ 私聊', action: '发送私聊文字' },
      async run(args, session) {
        assert.equal(session.transientContext, true);
        assert.equal(args.text, body);
        return handle.send({ peer: owner, messageId: 'model:' + sum('test-send'), text: descriptor });
      },
    });
  });
  await handle.bind(owner, f.sessionId);
  await handle.bind(other, f.sessionId);
  await f.app.runtime.builtin('bilibili', {}, (ctx: Context) => {
    ctx.tools.registerTransient({ name: 'bilibili_comments', description: '隔离 B 站评论', schema: {}, danger: 'safe',
      origin: { platform: 'B站', action: '查看评论' }, run: () => ({ content: comment, receipt: { action: 'bilibili_comments', status: 'ok' } }) });
  });
  let step = 0, scriptError: unknown;
  f.app.llm.chat = async (input: any) => {
    try {
      const messages = JSON.stringify(input.messages);
      if (++step === 1) return tool('bilibili_comments', {}, 'read-comments');
      if (step === 2) {
        assert.ok(messages.includes(comment));
        return tool('qq_send_message', { text: body }, 'try-send');
      }
      const runId = /本轮ID：([a-f0-9-]+)/.exec(messages)?.[1];
      assert.ok(runId); assert.equal(step, 3);
      return tool('autonomy_finish', { runId, decision: 'acted', reason: '平台投递中断。' }, 'finish');
    } catch (e) { scriptError = e; throw e; }
  };
  const origin = 'http://127.0.0.1:' + f.app.web.server.address().port;
  const login = await fetch(origin + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const wake = await fetch(origin + '/plugins/autonomy/state', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'wake', session: f.sessionId }),
  });
  assert.equal(wake.status, 202);
  const cutoff = Date.now() + 8000;
  while (!(await api().status()).runs.some((r: any) => r.phase === 'completed')) {
    if (scriptError) throw scriptError;
    assert.ok(Date.now() < cutoff, 'manual fixture wake finishes');
    await delay(20);
  }
  assert.equal(step, 3);
  await f.app.runtime.action('autonomy', 'reload');
  for (const [i, peer] of [other, owner].entries()) {
    let asked = 0;
    const answer = peer === owner ? '刚才我有话没说完，想稍后接着聊。' : '这边没有这件事。';
    f.app.llm.chat = async (input: any) => {
      try {
        const last = input.messages.at(-1);
        if (++asked === 1) {
          assert.match(last.content, /怎么了/);
          const lookup = input.tools.find((entry: any) => entry.function.name === 'autonomy_qq_interruption');
          assert.ok(lookup);
          assert.match(lookup.function.description, /怎么了|刚才想说/);
          assert.doesNotMatch(lookup.function.description, /200002|确认发送 2 段/);
          return tool(lookup.function.name, {}, 'lookup-' + i);
        }
        assert.equal(asked, 2);
        const reply = JSON.parse(last.content);
        assert.equal(reply.ok, true);
        const found = reply.result.items ?? [];
        if (peer === owner) {
          assert.equal(found.length, 1);
          assert.equal(found[0].originalAvailable, false);
          assert.deepEqual([found[0].total, found[0].sent, found[0].notSent, found[0].unknown], [8, 2, 6, 0]);
          assert.match(found[0].summary, /评论/);
          assert.ok(!JSON.stringify(found).includes(body));
        } else assert.equal(found.length, 0);
        return { text: answer, toolCalls: [], usage };
      } catch (e) { scriptError = e; throw e; }
    };
    const result = await handle.receive({ peer, sender: peer.slice(7), messageId: 'ask-' + i, text: '怎么了？' });
    if (scriptError) throw scriptError;
    assert.equal(result.status, 'sent');
    assert.equal(delivered[i], answer);
  }
  assert.equal((await api().status()).runs.length, 1);
  for (const secret of [body, comment]) {
    assert.ok(!JSON.stringify(await f.app.memory.readSession(f.sessionId)).includes(secret));
    assert.ok(!JSON.stringify(await f.app.memoryEngine.state(f.sessionId)).includes(secret));
  }
});
