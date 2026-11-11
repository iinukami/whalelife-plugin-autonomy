/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import { intentSnapshot } from '../src/runtime.ts';
import type { Intent } from '../src/storage.ts';
import { registerWeb } from '../src/web.ts';
import { fake, thought } from './fake.ts';
import { hostFixture, project } from './helpers.ts';

const now = Date.parse('2026-11-12T10:00:00+08:00');
const at = (offset = 0) => new Date(now + offset).toISOString();
function item(id: string, overrides: Partial<Intent> = {}): Intent {
  return {
    id, version: 1, kind: 'thought', state: 'open', text: `未完念头 ${id}`,
    createdAt: at(-86400000), updatedAt: at(-86400000), source: 'self', evidence: '隔离测试形成的打算',
    preferredAt: null, dueAt: null, ...overrides,
  };
}
function snapshotRows(text: string): Array<Record<string, any>> {
  return text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line)).filter(row => typeof row.intentId === 'string');
}

test('snapshot handles no intentions and caps visible rows without truncating Unicode intention text', () => {
  const empty = intentSnapshot([], now);
  assert.match(empty, /【未完成意图快照】/);
  assert.ok(empty.includes(at()));
  assert.match(empty, /共\s*0\s*条/);
  assert.deepEqual(snapshotRows(empty), []);

  const unicode = '鲸🐋'.repeat(150);
  const items = Array.from({ length: 10 }, (_, n) => item(`item-${n}`, { text: n === 0 ? unicode : `念头-${n}` }));
  assert.equal(snapshotRows(intentSnapshot(items.slice(0, 8), now)).length, 8);
  const snapshot = intentSnapshot(items, now), rows = snapshotRows(snapshot);
  assert.equal(rows.length, 8);
  assert.equal(rows.find(row => row.intentId === 'item-0')?.text, unicode);
  assert.match(snapshot, /共\s*10\s*条/);
  assert.match(snapshot, /另有\s*2\s*条未展示/);
  assert.match(snapshot, /autonomy_intents[^\n]*list/);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'intentId', 'version', 'kind', 'state', 'text', 'createdAt', 'preferredAt', 'dueAt', 'timeStatus',
  ].sort());
  assert.equal(rows[0].createdAt, items[0].createdAt);
  assert.equal(rows[0].version, items[0].version);
});

test('plan times distinguish past, future and unset while settling is never offered as another action', () => {
  const rows = snapshotRows(intentSnapshot([
    item('past', { preferredAt: at(-1) }),
    item('due-now', { kind: 'agreement', source: 'conversation', dueAt: at() }),
    item('future', { preferredAt: at(60000) }),
    item('unscheduled'),
    item('settling', { state: 'settling', preferredAt: at(-60000) }),
  ], now));
  const statuses = Object.fromEntries(rows.map(row => [row.intentId, row.timeStatus]));
  assert.equal(statuses.past, '已到计划时间，仍未完成');
  assert.equal(statuses['due-now'], '已到计划时间，仍未完成');
  assert.equal(statuses.future, '尚未到计划时间，仍未完成');
  assert.equal(statuses.unscheduled, '未设计划时间，仍未完成');
  assert.equal(statuses.settling, '结束结果正在保存，勿重复执行');
});

test('an elapsed plan stays visible on each wake and neither finish decision clears it', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize();
  const created: any = await f.runtime.intents.change('one', {
    ...thought(), text: '仍想整理测试笔记', preferredAt: new Date(f.now + 60000).toISOString(),
  });
  f.now += 86400000;
  for (const decision of ['no_action', 'acted'] as const) {
    f.finishing(decision);
    await f.runtime.manualWake(); await f.runtime.idle();
    const rows = snapshotRows(f.requests.at(-1)!.text);
    assert.equal(rows.find(row => row.intentId === created.intent.id)?.timeStatus, '已到计划时间，仍未完成');
    assert.equal(rows.find(row => row.intentId === created.intent.id)?.text, created.intent.text);
    assert.deepEqual(await f.runtime.intents.list('one'), [created.intent]);
    assert.equal((await f.runtime.status()).runs[0].phase, 'completed');
  }
  assert.equal(f.requests.length, 2);
  assert.ok([...f.experiences.values()].every(experience => experience.event_id.startsWith('wake:')));
});

test('only explicit completion or abandonment removes an intention from subsequent wake snapshots', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize(); f.finishing();
  const retained: any = await f.runtime.intents.change('one', { ...thought('retain'), text: '仍要保留的念头' });
  for (const action of ['complete', 'abandon']) {
    const created: any = await f.runtime.intents.change('one', { ...thought(`create-${action}`), text: `${action} 的测试念头` });
    await f.runtime.manualWake(); await f.runtime.idle();
    assert.ok(snapshotRows(f.requests.at(-1)!.text).some(row => row.intentId === created.intent.id));
    await f.runtime.intents.change('one', {
      action, requestId: `end-${action}`, intentId: created.intent.id, version: created.intent.version,
      reason: action === 'complete' ? '模拟结果已确认' : '已明确决定放弃', evidence: '本次隔离测试的明确结果',
    });
    await f.runtime.manualWake(); await f.runtime.idle();
    assert.deepEqual(snapshotRows(f.requests.at(-1)!.text).map(row => row.intentId), [retained.intent.id]);
  }
  assert.equal([...f.experiences.values()].filter(experience => experience.event_id.startsWith('intent:')).length, 2);
});

test('deferring by clearing the planned time preserves an open intention and shows it without a schedule', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize(); f.finishing();
  const created: any = await f.runtime.intents.change('one', {
    ...thought(), preferredAt: new Date(f.now - 60000).toISOString(),
  });
  const revised: any = await f.runtime.intents.change('one', {
    ...thought('defer'), action: 'revise', intentId: created.intent.id, version: created.intent.version,
    text: '以后想继续写测试日记', preferredAt: null,
  });
  await f.runtime.manualWake(); await f.runtime.idle();
  const row = snapshotRows(f.requests.at(-1)!.text).find(row => row.intentId === created.intent.id)!;
  assert.equal(row.state, 'open');
  assert.equal(row.preferredAt, null);
  assert.equal(row.timeStatus, '未设计划时间，仍未完成');
  assert.equal(row.version, revised.intent.version);
  assert.equal(row.text, revised.intent.text);
  assert.deepEqual(await f.runtime.intents.list('one'), [revised.intent]);
});

test('queued snapshots disclose possible changes and stale versions cannot finish a revised intention', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize(); f.finishing();
  const created: any = await f.runtime.intents.change('one', { ...thought(), text: '入队时的旧打算' });
  const holder = f.hold();
  t.after(async () => { holder.release(); await holder.done; await f.runtime.idle(); });
  await f.runtime.manualWake(); await f.flush();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.requests.length, 0);
  const revised: any = await f.runtime.intents.change('one', {
    ...thought('revise-in-queue'), action: 'revise', intentId: created.intent.id, version: created.intent.version,
    text: '等待期间的新打算', preferredAt: null,
  });
  holder.release(); await holder.done; await f.runtime.idle();
  const prompt = f.requests[0].text;
  assert.equal(snapshotRows(prompt).find(row => row.intentId === created.intent.id)?.version, created.intent.version);
  assert.match(prompt, /入队[^\n]*快照|快照[^\n]*入队/);
  assert.match(prompt, /可能[^\n]*变化/);
  assert.match(prompt, /autonomy_intents[^\n]*list/);
  assert.match(prompt, /最新状态/);
  await assert.rejects(f.runtime.intents.change('one', {
    action: 'complete', requestId: 'stale-finish', intentId: created.intent.id, version: created.intent.version,
    reason: '按旧快照结束', evidence: '只有旧版本信息',
  }), /已经变更/);
  assert.deepEqual(await f.runtime.intents.list('one'), [revised.intent]);
  assert.ok([...f.experiences.values()].every(experience => !experience.event_id.startsWith('intent:')));
});

test('each session receives only its own unfinished intentions', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize(); f.finishing();
  const first: any = await f.runtime.intents.change('one', { ...thought('first'), text: '第一会话的独立念头' });
  const second: any = await f.runtime.intents.change('two', { ...thought('second'), text: '第二会话的独立念头' });
  await f.runtime.manualWake(); await f.runtime.idle();
  assert.deepEqual(snapshotRows(f.requests.at(-1)!.text).map(row => row.intentId), [first.intent.id]);
  f.select('two');
  await f.runtime.manualWake(); await f.runtime.idle();
  assert.equal(f.requests.at(-1)!.sessionId, 'two');
  assert.deepEqual(snapshotRows(f.requests.at(-1)!.text).map(row => row.intentId), [second.intent.id]);
});

test('settings UI renders plan status and keeps settling distinct from open intentions', () => {
  const pages = new Map<string, (request: any, response: any) => void>();
  registerWeb({ web: { page(path: string, handler: any) { pages.set(path, handler); }, api() {} } } as any, {} as any);
  let source = '';
  pages.get('/plugins/autonomy/ui.js')!({}, { setHeader() {}, end(body: string) { source = body; } });
  assert.ok(source);
  const element = (): any => ({
    textContent: '', children: [],
    append(...nodes: any[]) { this.children.push(...nodes); },
    replaceChildren(...nodes: any[]) { this.children = nodes; },
  });
  const elements = new Map<string, any>();
  const testState = {
    now: at(), config: { enabled: false }, session: 'one', running: null, queued: [],
    probability: 0, lastActivityAt: null, selfWake: null, limitations: [], runs: [], logs: [],
    intents: [
      item('past', { preferredAt: at(-1) }),
      item('future', { kind: 'agreement', source: 'conversation', dueAt: at(60000) }),
      item('unscheduled'),
      item('settling', { state: 'settling', preferredAt: at(-60000) }),
    ],
  };
  new Script(source + '\nrender(testState);').runInNewContext({
    document: {
      getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element,
    },
    // Initial refresh stays pending; render receives the fixture directly, with no network or timers.
    fetch: () => new Promise(() => {}), setInterval() {}, testState,
  }, { timeout: 1000 });
  const textOf = (node: any): string => [node.textContent, ...node.children.map(textOf)].join('\n');
  const rendered = elements.get('intents').children.map(textOf);
  assert.equal(rendered.length, 4);
  assert.match(rendered[0], /计划参考时间：[\s\S]*已到计划时间 · 仍未完成/);
  assert.match(rendered[1], /明确时间：[\s\S]*尚未到计划时间 · 仍未完成/);
  assert.match(rendered[2], /未设计划时间 · 仍未完成/);
  assert.match(rendered[3], /结束结果正在保存，勿重复执行/);
  assert.doesNotMatch(rendered[3], /仍未完成/);
});

test('real child passes the snapshot to a mocked model without persisting the technical prompt', { timeout: 15000 }, async t => {
  const f = await hostFixture(t, undefined, 'autonomy', process.env.AUTONOMY_TEST_PACKAGE || project);
  assert.equal(f.app.runtime.records.get('autonomy')?.status, 'active');
  const created = await f.app.tools.call('autonomy_intents', {
    ...thought('real-child'), text: '隔离子进程的未完青柠念头', preferredAt: '2020-01-01T00:00:00Z',
  }, { id: f.sessionId, permission: 'full' });
  assert.equal(created.result.ok, true);
  let calls = 0;
  f.app.llm.chat = async (input: any) => {
    const messages = JSON.stringify(input.messages);
    assert.match(messages, /【未完成意图快照】/);
    assert.match(messages, /隔离子进程的未完青柠念头/);
    assert.match(messages, /已到计划时间，仍未完成/);
    const runId = /本轮ID：([a-f0-9-]+)/.exec(messages)![1];
    const name = ++calls === 1 ? 'autonomy_intents' : 'autonomy_finish';
    assert.ok(calls <= 2, 'a mocked list and explicit finish should end this round');
    const args = calls === 1 ? { action: 'list' } : { runId, decision: 'no_action', reason: '保留这个念头，这次选择暂不行动' };
    return { text: '', toolCalls: [{ id: `snapshot-test-${calls}`, name, arguments: JSON.stringify(args) }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const url = `http://127.0.0.1:${f.app.web.server.address().port}`;
  const login = await fetch(url + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(url + '/plugins/autonomy/state', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'wake', session: f.sessionId }),
  });
  assert.equal(response.status, 202);
  const service = f.app.runtime.services.get('autonomy').value;
  let state = await service.status();
  for (let n = 0; n < 150 && (state.running || state.queued.length); n++) {
    await delay(20); state = await service.status();
  }
  assert.equal(state.running, null);
  assert.equal(state.queued.length, 0);
  assert.equal(state.runs[0].phase, 'completed');
  assert.equal(calls, 2);
  assert.equal(state.intents[0].id, created.result.intent.id);
  assert.equal(state.intents[0].state, 'open');
  assert.doesNotMatch(JSON.stringify(await f.app.memory.readSession(f.sessionId)), /【未完成意图快照】|本轮ID：/);
  assert.doesNotMatch(JSON.stringify(await f.app.memoryEngine.state(f.sessionId)), /【未完成意图快照】|本轮ID：/);
});
