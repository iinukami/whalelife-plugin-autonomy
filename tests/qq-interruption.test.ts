import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryEvent, ToolSession } from 'whalelife';
import { Documents } from '../src/storage.ts';
import { QqInterruptions } from '../src/qq-interruption.ts';
import { fake } from './fake.ts';

const at = '2032-03-04T07:34:51.220Z';
const session: ToolSession = { id: 'one', permission: 'full', channel: 'qq', account: '100001', peer: 'direct:200002', sender: '200002' };
const runs = [{ phase: 'completed', startedAt: '2032-03-04T07:34:24Z', endedAt: '2032-03-04T07:34:55Z' }];
const raw = 'masked content must never be stored';
const failure = '发送结果可能不确定；重试可能重复投递：QQ 投递部分完成：共 8 段，确认发送 2 段，明确未发送 6 段（其中 5 段未提交），结果未知 0 段。' + raw;
const comments: MemoryEvent = { id: 'comment-call', ts: '2032-03-04T07:34:34Z', session: 'one', type: 'tool',
  channel: 'plugin', account: 'autonomy', name: 'bilibili_comments', origin: { plugin: 'surf/bilibili' },
  ok: true, transient: true, result: { action: 'bilibili_comments', status: 'ok', extra: raw } };
function receipt(id: string, changes: Partial<MemoryEvent> = {}): MemoryEvent {
  return { id, session: 'one', ts: at, type: 'channel_receipt', direction: 'out', channel: 'qq',
    account: session.account, peer: session.peer, conversation: { channel: 'qq', origin: { plugin: 'qq' }, account: session.account, peer: session.peer },
    external_message_id: 'model-action', delivery_id: 'delivery_' + 'd'.repeat(64),
    status: 'delivery_failed', text: '[QQ 临时私聊；正文不留存；指纹 ' + 'e'.repeat(64) + ']', error: failure, ...changes };
}
function fixture(rows: MemoryEvent[]) {
  const { ctx, documents } = fake();
  let pages = 0;
  ctx.memory.readSession = async (sid, limit = 100, before) => {
    pages++;
    const history = rows.filter(row => row.session === sid);
    const end = before ? history.findIndex(row => row.id === before) : history.length;
    assert.ok(end >= 0);
    return history.slice(Math.max(0, end - limit), end);
  };
  const make = () => new QqInterruptions(new Documents(ctx.memory));
  return { facts: make(), make, documents, pages: () => pages };
}

test('a partial transient QQ private message survives reload with only authenticated historical facts', async () => {
  const rows = [comments, receipt('error')], f = fixture(rows);
  await f.facts.sync('one', runs);
  const reloaded = f.make();
  const result = await reloaded.recent(session, runs);
  assert.ok(result);
  assert.equal(result.at, at);
  assert.equal(result.total, 8);
  assert.equal(result.sent, 2);
  assert.equal(result.notSent, 6);
  assert.equal(result.unknown, 0);
  assert.equal(result.originalAvailable, false);
  assert.match(result.description, /包括确认发送的段/);
  assert.match(result.description, /之前的聊天没有标明哪句属于这些分段/);
  assert.match(result.description, /查看过 B 站评论/);
  const stored = JSON.stringify([...f.documents.values()]);
  for (const forbidden of [raw, '指纹', '100001', 'direct:200002', 'QQ 投递部分完成']) assert.ok(!stored.includes(forbidden), forbidden);
  for (const wrong of [{ account: '100009' }, { peer: 'direct:200009', sender: '200009' }, { sender: '200009' }, { id: 'two' },
    { channel: 'web' }, { channel: 'plugin' }, { peer: 'group:200002' }, { permission: 'off' as const }])
    assert.equal(await reloaded.recent({ ...session, ...wrong }, runs), null);
  rows.push(receipt('different-success', { status: 'sent', delivery_id: 'delivery_' + 'b'.repeat(64) }));
  assert.deepEqual(await reloaded.recent(session, runs), result);
  rows.push(receipt('same-success', { status: 'sent' }));
  assert.equal(await reloaded.recent(session, runs), null);
});

test('unknown outcomes and untrusted wording cannot become claims about specific segments or subject', async () => {
  for (const error of ['error ' + failure, failure.replace('6 段', '7 段'), failure.replace('8 段', '80 段'), undefined]) {
    const f = fixture([{ ...comments, origin: { plugin: 'unrelated' } }, receipt('error', { error })]);
    const fact = await f.facts.recent(session, runs);
    assert.ok(fact);
    assert.equal(fact.sent, null); assert.equal(fact.notSent, null);
    assert.doesNotMatch(fact.description, /评论|2 段/); assert.match(fact.description, /无法确定/);
  }
  const unknown = failure.replace('未发送 6 段', '未发送 5 段').replace('未知 0 段', '未知 1 段');
  const result = await fixture([comments, receipt('u', { error: unknown })]).facts.recent(session, []);
  assert.equal(result?.unknown, 1); assert.doesNotMatch(result!.description, /评论/);
  for (const changes of [{ type: 'message', role: 'user' }, { direction: 'in' }, { conversation: { origin: { plugin: 'elsewhere' } } },
    { text: raw }, { status: 'delivering' }, { external_message_id: 'ack:' + 'f'.repeat(64) }]) {
    assert.equal(await fixture([receipt('ignore', changes)]).facts.recent(session, runs), null);
  }
});

test('catchup spans disabled periods, ignores already processed pages and updates only from later receipts', async () => {
  const rows = [comments], f = fixture(rows);
  await f.facts.sync('one', runs);
  rows.push(receipt('failure'));
  for (let i = 0; i < 304; i++) rows.push({ id: 'x' + i, ts: at, session: 'one', type: 'tool' });
  const result = await f.make().recent(session, runs);
  assert.equal(result?.sent, 2);
  assert.match(result!.description, /B 站评论/);
  const count = f.pages();
  await Promise.all([f.facts.sync('one', runs), f.facts.recent(session, runs)]);
  assert.equal(f.pages(), count + 2);
});
