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
function fixture(rows: MemoryEvent[], activatedAt = Date.parse(at) - 2000) {
  const { ctx, documents } = fake();
  let pages = 0;
  ctx.memory.readSession = async (sid, limit = 100, before) => {
    pages++;
    const history = rows.filter(row => row.session === sid);
    const end = before ? history.findIndex(row => row.id === before) : history.length;
    assert.ok(end >= 0);
    return history.slice(Math.max(0, end - limit), end);
  };
  const make = (start = activatedAt) => new QqInterruptions(new Documents(ctx.memory), start);
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

const clock = Date.parse(at);
const online = [{ offlineAt: clock - 500, onlineAt: clock + 50 }];
const ownerAccount = '100001';
const started = (id: string, changes: Partial<MemoryEvent> = {}) => receipt(id, {
  ts: new Date(clock - 1000).toISOString(), status: 'generated', error: undefined, ...changes,
});

test('the real disconnect window makes a new temporary interruption available once, even after restart', async () => {
  const rows = [comments, started('generated'), receipt('failed')];
  const f = fixture(rows);
  await f.facts.sync('one', runs);
  assert.equal(await f.facts.peekRecovery('one', ownerAccount), null);
  const pages = f.pages();
  await f.facts.observeRecovery('one', ownerAccount, [{ offlineAt: clock - 5000, onlineAt: clock - 3000 }]);
  await f.facts.observeRecovery('one', '100009', online);
  assert.equal(await f.facts.peekRecovery('one', ownerAccount), null);
  await f.facts.observeRecovery('one', ownerAccount, online);
  assert.equal(f.pages(), pages);
  const worker = f.make(clock + 3000);
  assert.equal(await worker.peekRecovery('two', ownerAccount), null);
  assert.equal(await worker.peekRecovery('one', '100009'), null);
  const item = await worker.peekRecovery('one', ownerAccount);
  assert.ok(item);
  assert.equal(item.userId, '200002');
  assert.equal(item.fact.sent, 2);
  assert.equal(item.fact.notSent, 6);
  assert.equal(item.fact.unknown, 0);
  assert.match(item.fact.description, /B 站评论/);
  assert.equal(await worker.claimRecovery('one', '100009', item.deliveryId), null);
  const claims = await Promise.all([worker.claimRecovery('one', ownerAccount, item.deliveryId, item.fact),
    worker.claimRecovery('one', ownerAccount, item.deliveryId, item.fact)]);
  assert.deepEqual(claims.filter(Boolean), [item]);
  await worker.observeRecovery('one', ownerAccount, online);
  assert.equal(await worker.peekRecovery('one', ownerAccount), null);
  assert.equal((await worker.recent(session, runs))?.sent, 2);
  assert.ok(!JSON.stringify([...f.documents.values()]).includes('200002'));
});

test('install and upgrade backfill historical facts without turning them into a fresh recovery', async () => {
  for (const legacy of [false, true]) {
    const rows = [started('old-start'), receipt('old-failure')];
    const f = fixture(rows, clock + 500);
    if (legacy) f.documents.set('one:qq-interruptions', { revision: 'legacy', data: { schema: 1, byRoute: {}, cursor: 'old-start' } });
    await f.facts.sync('one', runs);
    await f.facts.observeRecovery('one', ownerAccount, online);
    assert.equal(await f.facts.peekRecovery('one', ownerAccount), null);
    assert.equal((await f.facts.recent(session, runs))?.sent, 2);
  }
});

test('a later unrelated disconnect releases the temporary contact for an online failure but leaves the facts readable', async () => {
  const rows = [started('generated'), receipt('failure')], f = fixture(rows);
  const later = [{ offlineAt: clock + 1, onlineAt: clock + 1000 }];
  await f.facts.sync('one', runs);
  await f.facts.observeRecovery('one', '100009', later);
  assert.ok(JSON.stringify([...f.documents.values()]).includes('200002'));
  await f.facts.observeRecovery('one', ownerAccount, later);
  assert.ok(!JSON.stringify([...f.documents.values()]).includes('200002'));
  assert.equal(await f.facts.peekRecovery('one', ownerAccount), null);
  assert.equal((await f.facts.recent(session, runs))?.sent, 2);
});

test('a caller in the right direct chat can take the opportunity before the connection comes back', async () => {
  const rows = [started('generated'), receipt('failed')], f = fixture(rows);
  const qq = { ...session, origin: { plugin: 'qq' } };
  await f.facts.sync('one', runs);
  assert.equal(await f.facts.recent({ ...qq, peer: 'direct:200003', sender: '200003' }, runs), null);
  assert.equal(await f.facts.recent({ ...qq, account: '100009' }, runs), null);
  assert.ok(JSON.stringify([...f.documents.values()]).includes('200002'));
  assert.equal((await f.facts.recent(qq, runs))?.sent, 2);
  assert.ok(!JSON.stringify([...f.documents.values()]).includes('200002'));
  await f.facts.observeRecovery('one', ownerAccount, online);
  assert.equal(await f.facts.peekRecovery('one', ownerAccount), null);
  assert.equal((await f.facts.recent(qq, runs))?.notSent, 6);
});

test('a later receipt invalidates the queued snapshot; sent and unknown both cancel eligibility', async () => {
  for (const final of ['sent', 'uncertain']) {
    const rows = [started('generated'), receipt('first')], f = fixture(rows);
    await f.facts.sync('one', runs);
    await f.facts.observeRecovery('one', ownerAccount, online);
    const original = await f.facts.peekRecovery('one', ownerAccount);
    assert.ok(original);
    rows.push(receipt('corrected-progress', { error: failure.replace('确认发送 2', '确认发送 3').replace('未发送 6', '未发送 5') }));
    await f.facts.sync('one', runs);
    assert.equal(await f.facts.claimRecovery('one', ownerAccount, original.deliveryId, original.fact), null);
    assert.equal((await f.facts.peekRecovery('one', ownerAccount))?.fact.sent, 3);
    rows.push(receipt('final', { status: final }));
    await f.facts.sync('one', runs);
    assert.equal(await f.facts.claimRecovery('one', ownerAccount, original.deliveryId), null);
    assert.ok(!JSON.stringify([...f.documents.values()]).includes('200002'));
  }
});

test('an update from a consumed delivery cannot displace or rearm a newer delivery on the same route', async () => {
  const next = 'delivery_' + 'b'.repeat(64);
  const rows = [started('start-A'), receipt('failed-A')], f = fixture(rows);
  await f.facts.sync('one', runs);
  await f.facts.observeRecovery('one', ownerAccount, online);
  const first = await f.facts.claimRecovery('one', ownerAccount);
  assert.ok(first);
  rows.push(started('start-B', { delivery_id: next }), receipt('failed-B', { delivery_id: next }), receipt('late-update-A'));
  await f.facts.sync('one', runs);
  await f.facts.observeRecovery('one', ownerAccount, online);
  assert.equal(await f.facts.claimRecovery('one', ownerAccount, first.deliveryId), null);
  assert.equal((await f.facts.claimRecovery('one', ownerAccount))?.deliveryId, next);
  rows.push(receipt('another-update-A'));
  await f.facts.sync('one', runs);
  await f.facts.observeRecovery('one', ownerAccount, online);
  assert.equal(await f.facts.peekRecovery('one', ownerAccount), null);
});

test('two interrupted sends to one person each have a chance; an incoming lookup deals only with the latest', async () => {
  const second = 'delivery_' + 'b'.repeat(64);
  const earlier = new Date(clock - 700).toISOString();
  const later = new Date(clock - 500).toISOString();
  const threeSent = failure.replace('确认发送 2', '确认发送 3').replace('未发送 6', '未发送 5');
  const rows = [started('start-A'), receipt('fail-A', { ts: earlier }),
    started('start-B', { delivery_id: second, ts: later }), receipt('fail-B', { delivery_id: second, error: threeSent })];
  const f = fixture(rows);
  await f.facts.sync('one', runs);
  await f.facts.observeRecovery('one', ownerAccount, [{ offlineAt: clock - 800, onlineAt: clock + 200 }]);
  const original = await f.facts.peekRecovery('one', ownerAccount);
  assert.ok(original);
  assert.equal(original.fact.sent, 2);
  rows.push(receipt('update-A', { ts: new Date(clock + 100).toISOString() }));
  const latest = await f.facts.recent({ ...session, origin: { plugin: 'qq' } }, runs);
  assert.equal(latest?.sent, 3);
  assert.equal(await f.facts.claimRecovery('one', ownerAccount, second), null);
  assert.equal(await f.facts.claimRecovery('one', ownerAccount, original.deliveryId, original.fact), null);
  const remaining = await f.facts.claimRecovery('one', ownerAccount);
  assert.equal(remaining?.deliveryId, original.deliveryId);
  assert.equal(remaining?.fact.sent, 2);
  assert.equal(await f.facts.peekRecovery('one', ownerAccount), null);
  assert.equal((await f.facts.recent(session, runs))?.sent, 3);
  assert.ok(!JSON.stringify([...f.documents.values()]).includes('200002'));
});

test('a success or unknown result for the newer send leaves the earlier opportunity intact', async () => {
  const second = 'delivery_' + 'b'.repeat(64);
  for (const status of ['sent', 'uncertain']) {
    const rows = [started('start-A'), receipt('fail-A'), started('start-B', { delivery_id: second }),
      receipt('fail-B', { delivery_id: second }), receipt('resolve-B', { delivery_id: second, status })];
    const f = fixture(rows);
    await f.facts.sync('one', runs);
    await f.facts.observeRecovery('one', ownerAccount, online);
    assert.equal(await f.facts.claimRecovery('one', ownerAccount, second), null);
    const first = await f.facts.claimRecovery('one', ownerAccount);
    assert.equal(first?.deliveryId, rows[1].delivery_id);
    assert.equal(await f.facts.claimRecovery('one', ownerAccount), null);
  }
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
