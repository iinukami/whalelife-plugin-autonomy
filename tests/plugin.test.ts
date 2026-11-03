import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { hostFixture, project } from './helpers.ts';

async function fixture(t: Parameters<typeof hostFixture>[0]) {
  const f = await hostFixture(t, undefined, 'autonomy', process.env.AUTONOMY_TEST_PACKAGE || project);
  assert.equal(f.app.runtime.records.get('autonomy')?.status, 'active');
  const url = `http://127.0.0.1:${f.app.web.server.address().port}`;
  const login = await fetch(url + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = (path = 'state', body?: unknown) => fetch(url + '/plugins/autonomy/' + path, {
    method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const service = () => f.app.runtime.services.get('autonomy')!.value;
  const completed = async () => {
    for (let i=0;i<150;i++) {
      const state = await service().status();
      if (!state.running && !state.queued.length) return state;
      await delay(20);
    }
    throw Error('Timed out waiting for isolated autonomy round');
  };
  return { ...f, url, request, service, completed };
}
const response = (name: string, args: unknown) => ({ text: '', toolCalls: [{ id: 'test-call', name, arguments: JSON.stringify(args) }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const final = { text: '记下这个打算了。', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };

test('real child coalesces manual wake behind Web work, respects queued user messages, then sees their fresh history', async t => {
  const f = await fixture(t);
  let release!: () => void, enter!: () => void, queued!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => enter = resolve);
  const queuedUser = new Promise<void>(resolve => queued = resolve);
  f.close.push(() => release());
  const order: string[] = [];
  f.app.llm.chat = async (input: any) => {
    const messages = JSON.stringify(input.messages), run = /本轮ID：([a-f0-9-]+)/.exec(messages);
    if (run) {
      order.push('autonomy');
      assert.match(messages, /第二次交流刚完成的青柠结果/);
      return response('autonomy_finish', { runId: run[1], decision: 'no_action', reason: '刚完成的交流已解决问题，现在不再行动' });
    }
    order.push(order.length === 0 ? 'first-user' : 'second-user');
    if (order.length === 1) { enter(); await gate; return final; }
    return { ...final, text: '第二次交流刚完成的青柠结果' };
  };
  const first = f.app.channels.web(f.sessionId, '正在进行的交流', () => {});
  await entered;
  const clicks = await Promise.all([f.request('state', { action: 'wake', session: f.sessionId }), f.request('state', { action: 'wake', session: f.sessionId })]);
  assert.ok(clicks.every(r => r.status === 202));
  const acks = await Promise.all(clicks.map(r => r.json()));
  assert.equal(acks[0].jobId, acks[1].jobId);
  const waiting = await f.service().status();
  assert.equal(waiting.running, null);
  assert.equal(waiting.queued.length, 1);
  assert.equal(waiting.runs[0].phase, 'queued');
  assert.equal(waiting.runs[0].startedAt, undefined);
  assert.doesNotMatch(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /自主判断结束|自主判断失败|自主判断中断/);
  const second = f.app.channels.web(f.sessionId, '接下来这条消息也要处理', () => {}, (context: any) => { if (context.queued) queued(); });
  await queuedUser;
  release(); await Promise.all([first, second]);
  const state = await f.completed();
  assert.deepEqual(order, ['first-user', 'second-user', 'autonomy']);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].phase, 'completed');
  assert.equal(f.app.sessions.locks.size, 0);
  const rows = await f.app.memory.readSession(f.sessionId);
  assert.equal(rows.filter((r: any) => r.role === 'user').length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /自主插件触发|本轮ID：/);
});

test('real pending cancellation and execution-time session switch never run a model or write an autonomy experience', async t => {
  const f = await fixture(t);
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => enter = resolve);
  f.close.push(() => release());
  let calls = 0;
  f.app.llm.chat = async () => { assert.equal(++calls, 1); enter(); await gate; return final; };
  const human = f.app.channels.web(f.sessionId, '先等当前交流', () => {}); await entered;
  assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
  assert.equal((await f.request('state', { action: 'stop', session: f.sessionId })).status, 202);
  const cancelled = await f.completed();
  assert.equal(cancelled.runs[0].phase, 'cancelled');
  assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
  const other = await f.app.sessions.create('另一会话');
  await f.app.sessions.current({ id: other });
  release(); await human; await f.completed();
  assert.equal(calls, 1);
  const doc = await f.app.memoryEngine.plugin('autonomy', () => {}).readDocument(f.sessionId, 'activity');
  assert.equal(doc.data.runs.length, 2);
  assert.ok(doc.data.runs.every((r: any) => r.phase === 'cancelled'));
  assert.doesNotMatch(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /自主判断结束|自主判断失败|自主判断中断/);
  assert.equal(f.app.sessions.locks.size, 0);
});

test('real plugin reload removes waiting work without replay or an uncertain-action memory', async t => {
  const f = await fixture(t);
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => enter = resolve);
  f.close.push(() => release());
  let calls = 0;
  f.app.llm.chat = async () => { assert.equal(++calls, 1); enter(); await gate; return final; };
  const human = f.app.channels.web(f.sessionId, '让排队停留一会儿', () => {}); await entered;
  assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
  await f.app.runtime.action('autonomy', 'reload');
  release(); await human;
  let state = await f.service().status();
  for (let n = 0; n < 100 && state.runs[0].phase !== 'cancelled'; n++) { await delay(20); state = await f.service().status(); }
  assert.equal(state.runs[0].phase, 'cancelled');
  assert.equal(state.queued.length, 0);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /自主判断结束|自主判断失败|自主判断中断|未收到明确的结束结果/);
  assert.equal(f.app.sessions.locks.size, 0);
});

test('actual child returns actionable missing evidence and a single corrected retry records abandonment once', async t => {
  const f = await fixture(t);
  const created = await f.app.tools.call('autonomy_intents', { action: 'remember', requestId: 'create', kind: 'thought', source: 'self', text: '写一篇日记', evidence: '形成写日记的打算' }, { id: f.sessionId, permission: 'full' });
  assert.equal(created.result.ok, true);
  const item = created.result.intent;
  const args = { action: 'abandon', requestId: 'abandon', intentId: item.id, version: item.version, reason: '决定改为口述' };
  let calls = 0;
  f.app.llm.chat = async (input: any) => {
    calls++;
    if (calls === 1) return response('autonomy_intents', args);
    const result = JSON.parse(input.messages.filter((m: any) => m.role === 'tool').at(-1).content).result;
    if (calls === 2) {
      assert.equal(result.ok, false);
      assert.deepEqual(result.missingFields, ['evidence']);
      assert.ok(result.requiredFields.includes('reason'));
      assert.equal((await f.service().status()).intents[0].version, item.version);
      return response('autonomy_intents', { ...args, evidence: '现在明确选择口述，放弃这次书写' });
    }
    assert.equal(calls, 3);
    assert.equal(result.ok, true);
    return final;
  };
  await f.app.sessions.chat(f.sessionId, '这次改成口述，不写了。', () => {});
  assert.equal(calls, 3);
  assert.equal((await f.service().status()).intents.length, 0);
  const memory = await f.app.memoryEngine.state(f.sessionId);
  assert.equal(memory.records.filter((r: any) => r.text?.startsWith('明确放弃意图：')).length, 1);
});

test('autonomy directly uses enabled tools despite persona ask and obsolete settings; host tool denials still apply', async t => {
  const f = await fixture(t);
  f.app.config.personas.a.permission = 'ask';
  assert.equal(f.app.config.channels.web.permission, 'full');
  let sent = 0;
  f.app.tools.register({ name: 'test_send', danger: 'ask', description: '仅隔离测试的发送替身', schema: { type: 'object', properties: {} }, run: async () => ({ messageId: `synthetic-${++sent}` }) });
  const created = await f.app.tools.call('autonomy_intents', { action: 'remember', requestId: 'promise', kind: 'agreement', source: 'conversation', text: '测试提醒约定', evidence: '模拟用户约定稍后提醒' }, { id: f.sessionId, permission: 'full' });
  assert.equal(created.result.ok, true);
  for (const mode of ['default', 'inherit', 'ask', 'full', 'tool-denied']) {
    const before = await f.service().status();
    if (mode !== 'default') {
      assert.equal((await f.request('state', { action: 'configure', config: { ...before.config, permission: mode === 'tool-denied' ? 'full' : mode }, revision: before.revision })).status, 200);
    }
    assert.equal('permission' in (await f.service().status()).config, false);
    if (mode === 'tool-denied') f.app.tools.overrides.test_send = 'off';
    const allowed = mode !== 'tool-denied', previousSent = sent;
    let calls = 0;
    f.app.llm.chat = async (input: any) => {
      if (++calls === 1) return response('test_send', {});
      assert.equal(calls, 2);
      const receipt = JSON.parse(input.messages.filter((m: any) => m.role === 'tool').at(-1).content);
      assert.equal(receipt.ok, allowed, mode);
      if (!allowed) assert.match(receipt.result, /审批|关闭/);
      const runId = /本轮ID：([a-f0-9-]+)/.exec(JSON.stringify(input.messages))![1];
      return response('autonomy_finish', { runId, decision: allowed ? 'acted' : 'no_action', reason: allowed ? '模拟发送已返回回执' : '发送受权限限制，保留约定，结束本轮判断' });
    };
    assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
    const after = await f.completed();
    assert.equal(after.runs[0].phase, 'completed');
    assert.equal(calls, 2);
    assert.equal(sent, previousSent + Number(allowed));
    assert.deepEqual(after.intents, before.intents);
  }
  assert.equal(sent, 4);
  assert.equal(f.app.config.personas.a.permission, 'ask');
  assert.equal(f.app.config.channels.web.permission, 'full');
});

test('transient motivation survives tool continuation with existing memory and disappears after the round', async t => {
  const f = await fixture(t); let calls = 0;
  await f.app.memory.appendEvent({ session: f.sessionId, type: 'message', role: 'user', channel: 'web', text: '之前交流的独特标记青柠。' });
  f.app.llm.chat = async (input: any) => {
    calls++;
    const messages = JSON.stringify(input.messages);
    assert.match(messages, /测试人格/);
    assert.match(messages, /区分投递事实和对方态度/);
    assert.match(messages, /发送成功也不代表对方已读/);
    assert.match(messages, /retryAutomatically=false 只控制重试/);
    assert.match(messages, /之前交流的独特标记青柠/);
    const trigger = input.messages.filter((m: any) => JSON.stringify(m).includes('本轮ID：')).at(-1);
    assert.ok(trigger);
    assert.match(JSON.stringify(trigger), /不是任何人发来的消息/);
    const runId = /本轮ID：([a-f0-9-]+)/.exec(JSON.stringify(trigger))![1];
    return calls === 1 ? response('autonomy_intents', { action: 'list' }) : response('autonomy_finish', { runId, decision: 'no_action', reason: '现有交流没有需要立即处理的事项。' });
  };
  assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
  assert.equal((await f.completed()).runs[0].phase, 'completed');
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(await f.app.memory.readSession(f.sessionId)), /本轮ID：|自主插件触发/);
  assert.doesNotMatch(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /本轮ID：|自主插件触发/);
});

test('legacy migration paginates and excludes only ledger-matched technical inputs while retaining original history and decisions', async t => {
  const f = await fixture(t);
  const runId = '46bd5b99-b2f8-4c10-8293-fc18f2899e06';
  const at = new Date().toISOString();
  const memory = f.app.memoryEngine.plugin('autonomy', () => {});
  await memory.saveDocument(f.sessionId, { key: 'activity', revision: null, data: { schema: 1, lastActivityAt: Date.now(), claims: {}, runs: [
    { id: runId, phase: 'completed', trigger: 'manual', startedAt: at, endedAt: at, decision: 'no_action', reason: '先安静休息', agreements: [] },
  ] } });
  const envelope = (id: string) => `【自主插件触发；这是系统记录的触发信息，不是任何人发来的消息】\n本轮ID：${id}\n触发原因：用户请求判断。`;
  // Legacy hosts normalize persisted input actions to 接收消息.
  const old = { session: f.sessionId, type: 'message', role: 'user', channel: 'plugin', account: 'autonomy', origin: { plugin: 'autonomy', platform: '自主性', action: '接收消息' }, text: envelope(runId) };
  await f.app.memory.appendEvent({ ...old, id: 'legacy', text: old.text + '旧触发唯一标记' });
  await f.app.memory.appendEvent({ ...old, id: 'human', channel: 'web', account: 'web', origin: { plugin: 'web' } });
  await f.app.memory.appendEvent({ ...old, id: 'foreign', account: 'another', origin: { ...old.origin, plugin: 'another' } });
  await f.app.memory.appendEvent({ ...old, id: 'unknown', text: envelope('unknown-run') });
  await f.app.memory.appendEvent({ ...old, id: 'other-action', origin: { ...old.origin, action: '其他用途' } });
  await f.app.memory.appendEvent({ ...old, id: 'not-envelope', text: '本轮ID：' + runId });
  for (let i = 0; i < 105; i++) await f.app.memory.appendEvent({ session: f.sessionId, id: `chat-${i}`, type: 'message', role: 'user', channel: 'web', text: `普通交流${i}` });
  await memory.recordExperience(f.sessionId, { event_id: `wake:${runId}:decision`, outcome: 'succeeded', text: '真实决定保留：选择暂不行动，先安静休息。' });
  const original = await f.app.memory.readSession(f.sessionId);
  f.app.llm.chat = async (input: any) => {
    assert.doesNotMatch(JSON.stringify(input.messages), /旧触发唯一标记/);
    const trigger = input.messages.filter((m: any) => JSON.stringify(m).includes('本轮ID：')).at(-1);
    const id = /本轮ID：([a-f0-9-]+)/.exec(JSON.stringify(trigger))![1];
    return response('autonomy_finish', { runId: id, decision: 'no_action', reason: '这次继续休息。' });
  };
  assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
  assert.equal((await f.completed()).runs[0].phase, 'completed');
  const rows = await f.app.memory.readSession(f.sessionId);
  for (const row of original) assert.deepEqual(rows.find((r: any) => r.id === row.id), row);
  const eligible = await f.app.memoryEngine.contextRows(f.sessionId);
  assert.equal(eligible.some((r: any) => r.id === 'legacy'), false);
  for (const id of ['human','foreign','unknown','other-action','not-envelope']) assert.ok(eligible.some((r: any) => r.id === id), id);
  const state = await f.app.memoryEngine.state(f.sessionId);
  assert.ok(state.records.some((r: any) => r.text?.includes('真实决定保留') && !r.context_excluded));
  const excludedAt = state.records.find((r: any) => r.id === 'legacy').excluded_at;
  await f.app.runtime.action('autonomy', 'reload');
  assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
  assert.equal((await f.completed()).runs[0].phase, 'completed');
  assert.equal((await f.app.memoryEngine.state(f.sessionId)).records.find((r: any) => r.id === 'legacy').excluded_at, excludedAt);
});

test('actual child plugin finishes quietly with real persona, tool success, experience and released session lock', async t => {
  const f = await fixture(t); let calls = 0;
  f.app.llm.chat = async (input: any) => {
    calls++;
    const messages = JSON.stringify(input.messages);
    assert.match(messages, /测试人格/);
    const runId = /本轮ID：([a-f0-9-]+)/.exec(messages)![1];
    return response('autonomy_finish', { runId, decision: 'no_action', reason: '目前没有想做的事情，安静待一会儿' });
  };
  const start = await f.request('state', { action: 'wake', session: f.sessionId });
  assert.equal(start.status, 202);
  const status = await f.completed();
  assert.equal(status.runs[0].phase, 'completed', JSON.stringify(status.runs));
  assert.equal(calls, 1);
  assert.ok(status.lastActivityAt);
  const rows = await f.app.memory.readSession(f.sessionId);
  assert.equal(rows.filter((r: any) => r.role === 'assistant').length, 0);
  assert.equal(rows.some((r: any) => r.role === 'user' && r.origin?.plugin === 'autonomy'), false);
  assert.doesNotMatch(JSON.stringify(rows), /本轮ID：|自主插件触发|触发原因：/);
  assert.ok(rows.some((r: any) => r.type === 'tool' && r.name === 'autonomy_finish' && r.ok && r.result?.recorded));
  assert.match(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /选择暂不行动/);
  assert.equal(f.app.sessions.locks.size, 0);
  assert.equal(f.app.runtime.records.get('autonomy').status, 'active');
  f.app.llm.chat = async (input: any) => {
    assert.doesNotMatch(JSON.stringify(input.messages), /本轮ID：|自主插件触发|触发原因：/);
    return final;
  };
  await f.app.sessions.chat(f.sessionId, '继续正常交流。', () => {});
});

test('ordinary conversations can create intentions; stop and reload retain data; completing removes only after recording', async t => {
  const f = await fixture(t); let step = 0;
  const remember = { action: 'remember', requestId: 'conversation-one', kind: 'thought', source: 'conversation', text: '明天想写日记', evidence: '用户交流时谈到写日记', preferredAt: '2026-11-01T10:00:00+08:00' };
  f.app.llm.chat = async () => ++step === 1 ? response('autonomy_intents', remember) : final;
  await f.app.sessions.chat(f.sessionId, '也许明天可以写一篇日记。', () => {});
  const before = await f.service().status();
  assert.equal(before.intents.length, 1);
  assert.equal(before.intents[0].kind, 'thought');
  assert.equal(before.intents[0].dueAt, null);
  await f.app.runtime.action('autonomy', 'stop');
  assert.equal((await f.request('settings')).status, 404);
  f.app.llm.chat = async () => final;
  await f.app.sessions.chat(f.sessionId, '普通聊天仍能继续。', () => {});
  await f.app.runtime.action('autonomy', 'start');
  const after = await f.service().status();
  assert.deepEqual(after.intents, before.intents);
  const item = after.intents[0]; step = 0;
  f.app.llm.chat = async () => ++step === 1 ? response('autonomy_intents', { action: 'abandon', requestId: 'drop-one', intentId: item.id, version: item.version, reason: '今天已经写过相同主题，暂时没有新内容', evidence: '明确决定放弃这次打算' }) : final;
  await f.app.sessions.chat(f.sessionId, '这次日记不打算写了。', () => {});
  assert.equal((await f.service().status()).intents.length, 0);
  assert.match(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /明确放弃意图/);
});

test('legacy direct calls retain busy rejection; cooperative yield releases them without a false no-action result', async t => {
  const f = await fixture(t);
  let started!: () => void;
  const entered = new Promise<void>(resolve => started = resolve);
  f.app.llm.chat = (input: any) => {
    started();
    return new Promise((_, reject) => {
      if (input.signal.aborted) reject(input.signal.reason);
      else input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    });
  };
  assert.equal((await f.request('state', { action: 'wake', session: f.sessionId })).status, 202);
  await entered;
  await assert.rejects(f.app.sessions.chat(f.sessionId, '回应我', () => {}), /正在回复/);
  await f.service().yieldToUser();
  const state = await f.completed();
  assert.equal(state.runs[0].phase, 'interrupted');
  assert.equal(state.lastActivityAt, null);
  assert.equal(f.app.sessions.locks.size, 0);
  f.app.llm.chat = async () => final;
  await f.app.sessions.chat(f.sessionId, '现在正常交流。', () => {});
  assert.equal(f.app.runtime.records.get('autonomy').status, 'active');
});

test('settings are authenticated, reject stale writes, load executable UI and persist across process reload', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/plugins/autonomy/state')).status, 401);
  const page = await f.request('settings');
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /自主会话工具权限|id="permission"/);
  const source = await (await f.request('ui.js')).text();
  assert.doesNotThrow(() => new Script(source));
  const stateResponse = await f.request();
  const state = await stateResponse.json();
  assert.equal(stateResponse.status, 200, JSON.stringify(state));
  assert.equal(state.config.enabled, false);
  const config = { ...state.config, probability: 0.3, mode: 'adaptive', sleep: [
    { start: '23:00', end: '07:00', startDay: 1, endDay: 5 },
    { start: '01:00', end: '09:00', startDay: 6, endDay: 7 },
    { start: '13:00', end: '14:00' },
  ] };
  assert.equal((await f.request('state', { action: 'configure', config, revision: state.revision })).status, 200);
  assert.equal((await f.request('state', { action: 'configure', config: state.config, revision: state.revision })).status, 400);
  assert.equal((await f.request('state', { action: 'wake', session: 'stale-session' })).status, 409);
  await f.app.runtime.action('autonomy', 'reload');
  assert.deepEqual((await f.service().status()).config, config);
});

test('host stop cancels the actual child in flight; reload preserves uncertainty without replaying its work', async t => {
  let phase = 'fixture'; t.after(() => t.diagnostic('last lifecycle phase: ' + phase));
  const f=await fixture(t);
  let entered!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve);
  f.app.llm.chat=(input:any)=>new Promise((_,reject)=>{
    entered();
    if(input.signal.aborted)reject(input.signal.reason);
    else input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});
  });
  phase = 'first wake';
  assert.equal((await f.request('state',{action:'wake',session:f.sessionId})).status,202);
  phase = 'waiting for first model';
  await started;
  phase = 'stopping plugin';
  await f.app.runtime.action('autonomy','stop');
  phase = 'checking stopped route';
  assert.equal((await f.request('settings')).status,404);
  for(let n=0;n<100&&f.app.sessions.locks.size;n++)await delay(20);
  assert.equal(f.app.sessions.locks.size,0);
  f.app.llm.chat=async()=>final;
  phase = 'normal chat while stopped';
  await f.app.sessions.chat(f.sessionId,'停用自主插件后继续交流。',()=>{});
  phase = 'starting plugin';
  await f.app.runtime.action('autonomy','start');
  let calls=0;
  f.app.llm.chat=async(input:any)=>{
    calls++;
    const latest=input.messages.filter((m:any)=>JSON.stringify(m).includes('本轮ID：')).at(-1);
    const runId=/本轮ID：([a-f0-9-]+)/.exec(JSON.stringify(latest))![1];
    return response('autonomy_finish',{runId,decision:'no_action',reason:'这是重新请求的一轮，选择不行动'});
  };
  phase = 'second wake';
  assert.equal((await f.request('state',{action:'wake',session:f.sessionId})).status,202);
  phase = 'waiting for second result';
  const state=await f.completed();
  assert.equal(calls,1);
  assert.equal(state.runs[0].phase,'completed');
  assert.equal(state.runs[1].phase,'uncertain');
  assert.match(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)),/未收到明确的结束结果/);
  phase = 'complete';
});
