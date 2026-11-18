import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolSession } from 'whalelife';
import { QqContinuation } from '../src/qq-continuation.ts';
import { fake } from './fake.ts';

function delivery(deliveryId = 'letter') {
  return { deliveryId, accountId: 'bot', sessionId: 'one', userId: 'reader', revision: 'a', state: 'incomplete',
    blockedReason: undefined as string | undefined, canResume: true,
    createdAt: '2031-02-04T09:00:00Z', updatedAt: '2031-02-04T10:00:00Z',
    delivery: { scope: 'action', outcome: 'partial', totalParts: 2, sentParts: 1, notSentParts: 1, unknownParts: 0 },
    parts: [{ state: 'sent', text: 'fixture first sentence' }, { state: 'not_sent', text: 'fixture unfinished sentence' }],
  };
}

function fixture(changes: Record<string, unknown> = {}) {
  const f = fake(), item = delivery(), tools = new Map<string, any>();
  const hooks = new Map<string, () => void>();
  const controller = new AbortController(), cleanups: (() => unknown)[] = [];
  let sends = 0, current: string | null = 'one';
  const service = {
    textDeliveryApiVersion: '1.0.0', textDeliveryResumeSupported: true,
    listTextDeliveries: async (_input: any): Promise<any> => ({ status: 'ok', items: [{ ...item, parts: undefined }] }),
    textDelivery: async (_input: any): Promise<any> => ({ status: 'ok', item: structuredClone(item) }),
    resumeTextDelivery: async (_input: any, _options: any): Promise<any> => { sends++; return { status: 'sent', confirmed: true }; },
    dismissTextDelivery: async (_input: any): Promise<any> => ({ status: 'dismissed', confirmed: false }),
    ...changes,
  };
  const register = (tool: any) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; };
  const ctx = { ...f.ctx, on: (name: string, fn: () => void) => { hooks.set(name, fn); return () => { hooks.delete(name); }; },
    tools: { register, registerTransient: register },
    optional(_name: string, callback: (binding: unknown) => void) {
      callback({ service, signal: controller.signal, effect: (fn: () => () => unknown) => { cleanups.push(fn()); } });
    },
  };
  const reads: ToolSession[] = [];
  const qq = new QqContinuation(ctx as any, f.runtime.intents, async () => current, () => f.now, session => { reads.push(session); });
  qq.start();
  const session: ToolSession = { id: 'one', permission: 'full' };
  async function linked() {
    await qq.check('one');
    return (await f.runtime.intents.list('one'))[0].id;
  }
  return { ...f, item, tools, hooks, service, qq, session, linked, reads, get sends(){ return sends; },
    async change() { hooks.get('plugin:qq:text-delivery-changed')?.(); await qq.check('one'); },
    async act(intentId: string, action = 'resume', options: Record<string, unknown> = {}, trusted = session) {
      return tools.get('autonomy_qq_decide').run({ action, intentId, revision: item.revision, ...options }, trusted);
    },
    async read(args: Record<string, string>, trusted = session) {
      return (await tools.get('autonomy_qq_expression').run(args, trusted)).content;
    },
    selectCurrent(id: string) { current = id; },
    close() { controller.abort(); for (const cleanup of cleanups.reverse()) cleanup(); },
  };
}

test('续发只允许当前可信会话、原 QQ 好友、完全权限和模型看到的版本', async t => {
  const f = fixture(); t.after(f.close);
  const id = await f.linked();
  assert.equal((await f.act(id, 'resume', {}, { ...f.session, permission: 'ask' })).reason, 'permission');
  assert.equal((await f.act(id, 'resume', { revision: 'previous' })).reason, 'stale_revision');
  const otherFriend = { ...f.session, channel: 'qq', account: 'bot', peer: 'direct:stranger' };
  assert.equal((await f.read({ action: 'list' }, otherFriend)).items.length, 0);
  assert.equal((await f.read({ action: 'detail', intentId: id }, otherFriend)).reason, 'not_found');
  assert.equal((await f.act(id, 'resume', {}, otherFriend)).reason, 'not_found');
  f.selectCurrent('two');
  assert.equal((await f.act(id)).reason, 'session_changed');
  f.selectCurrent('one');
  f.item.accountId = 'another-bot';
  assert.equal((await f.act(id)).reason, 'not_found');
  assert.equal(f.sends, 0);
});

test('临时私聊只认真实重连；缓存可用于排队，执行前重新核对账号与已绑定会话', async t => {
  const account = '100001';
  let reads = 0, state = 'online', bound = 'one';
  const f = fixture({ getSelfId: () => account, status: () => {
    reads++;
    return { state, binding: { state: 'ready', sessionId: bound } };
  } }); t.after(f.close);
  assert.equal(await f.qq.recoveryAccount('one', true), account);
  assert.equal(f.qq.recoveryWindows(account).length, 0);
  await f.qq.recoveryAccount('one');
  assert.equal(reads, 1);
  state = 'disconnected';
  assert.equal(await f.qq.recoveryAccount('one', true), null);
  state = 'online';
  assert.equal(await f.qq.recoveryAccount('one', true), account);
  assert.equal(f.qq.recoveryWindows(account).length, 1);
  assert.equal(await f.qq.recoveryAccount('one', true), account);
  assert.equal(f.qq.recoveryWindows(account).length, 1);
  bound = 'two';
  assert.equal(await f.qq.recoveryAccount('one', true), null);
  f.selectCurrent('two');
  assert.equal(await f.qq.recoveryAccount('one', true), null);
  assert.equal(await f.qq.recoveryAccount('two', true), account);
  assert.equal(f.qq.recoveryWindows('100002').length, 0);
});

test('断线通知废弃在途缓存；迟到的在线结果不能覆盖断线', async t => {
  let release!: (status: unknown) => void;
  const f = fixture({ getSelfId: () => '100001', status: () => new Promise(resolve => { release = resolve; }) }); t.after(f.close);
  assert.equal(await f.qq.recoveryAccount('one'), null);
  // The ordinary tick can proceed while the provider is slow.
  assert.equal(await f.qq.recoveryAccount('one'), null);
  const changed = f.hooks.get('plugin:qq:connection-changed') as ((value: unknown) => void);
  changed({ accountId: '100001', state: 'disconnected' });
  release({ state: 'online', binding: { state: 'ready', sessionId: 'one' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.qq.recoveryWindows('100001').length, 0);
  changed({ accountId: '100001', state: 'online' });
  changed({ accountId: '100001', state: 'online' });
  assert.equal(f.qq.recoveryWindows('100001').length, 1);
});

test('不支持续发的兼容提供者可读，缺少契约的提供者只关闭这项能力', async t => {
  const old = fixture({ textDeliveryResumeSupported: false }); t.after(old.close);
  const id = await old.linked();
  assert.equal((await old.read({ action: 'detail', intentId: id })).status, 'ok');
  assert.equal(await old.qq.ready('one'), false);
  assert.equal((await old.act(id)).status, 'blocked');
  const missing = fixture({ resumeTextDelivery: undefined }); t.after(missing.close);
  await missing.qq.check('one');
  assert.equal(missing.tools.size, 0);
  assert.equal((await missing.runtime.intents.list('one')).length, 0);
});

const draftKey = { sessionId: 'one', accountId: '100001', deliveryId: 'delivery_' + 'a'.repeat(64) };
const target = { ...draftKey, userId: '200002' };
const progress = { total: 8, sent: 2, notSent: 6, unknown: 0 };
const asker: ToolSession = { id: 'one', channel: 'qq', account: target.accountId, peer: 'direct:' + target.userId,
  sender: target.userId, permission: 'full', origin: { plugin: 'qq' }, transientContext: true };
const reviewing: ToolSession = { id: 'one', channel: 'plugin', account: 'autonomy', peer: 'one', permission: 'full',
  origin: { plugin: 'autonomy', action: '自主唤起' }, transientContext: true };
const parts = Array.from({ length: 6 }, (_, i) => ({ index: i + 3, text: 'synthetic remaining part ' + (i + 3) }));

function draftFixture(change?: Record<string, unknown>) {
  const claims: unknown[] = [], releases: unknown[] = [];
  const result = { status: 'claimed', ...target, expiresAt: '2035-02-01T00:00:00Z', parts, ...change };
  const f = fixture({ temporaryDraftApiVersion: '1.0.0', getSelfId: () => target.accountId,
    claimTemporaryDraft: async (key: unknown) => { claims.push(key); return claims.length === 1 ? result : { status: 'unavailable' }; },
    releaseTemporaryDraft: async (key: unknown) => { releases.push(key); return { status: 'released' }; },
  });
  return { ...f, claims, releases };
}

test('an ordinary QQ follow-up or an autonomous review can read only this delivery’s unsent tail', async t => {
  for (const session of [asker, reviewing]) {
    const f = draftFixture(); t.after(f.close);
    assert.equal(f.qq.supportsTemporaryDraft(), true);
    assert.deepEqual(await f.qq.readTemporaryDraft(session, target, progress), parts);
    assert.deepEqual(f.claims, [draftKey]); assert.deepEqual(f.releases, [draftKey]);
    assert.deepEqual(f.reads, [session]);
    assert.equal(await f.qq.readTemporaryDraft(session, target, progress), null);
    assert.deepEqual(f.reads, [session]); assert.equal(f.sends, 0);
    assert.ok(!JSON.stringify([...f.documents.values()]).includes(parts[0].text));
  }
});

test('an unrelated turn or an uncertain receipt cannot consume or release a draft', async t => {
  const f = draftFixture(); t.after(f.close);
  for (const session of [{ ...asker, permission: 'off' as const }, { ...asker, channel: 'web' }, { ...asker, account: '100003' },
    { ...asker, sender: '200003' }, { ...asker, peer: 'direct:200003' }, { ...asker, id: 'two' },
    { ...asker, transientContext: false }, { ...reviewing, origin: { plugin: 'qq' } }, { ...reviewing, peer: 'two' }]) {
    assert.equal(await f.qq.readTemporaryDraft(session, target, progress), null);
  }
  f.selectCurrent('two');
  assert.equal(await f.qq.readTemporaryDraft(asker, target, progress), null);
  f.selectCurrent('one');
  for (const counts of [{ ...progress, unknown: 1 }, { ...progress, notSent: null }, { ...progress, sent: 1 }])
    assert.equal(await f.qq.readTemporaryDraft(asker, target, counts), null);
  assert.deepEqual(f.claims, []); assert.deepEqual(f.releases, []);
  const legacy = fixture(); t.after(legacy.close);
  assert.equal(legacy.qq.supportsTemporaryDraft(), false);
  assert.equal(await legacy.qq.readTemporaryDraft(asker, target, progress), null);
});

test('a mismatched or expired draft is discarded without disclosing provider data', async t => {
  for (const change of [{ sessionId: 'two' }, { accountId: '100004' }, { userId: '200003' }, { deliveryId: 'another' },
    { expiresAt: '2002-01-01T00:00:00Z' }, { parts: parts.slice(1) },
    { parts: parts.map((p,i) => i === 0 ? { index: 2, text: 'already delivered' } : p) }]) {
    const f = draftFixture(change); t.after(f.close);
    assert.equal(await f.qq.readTemporaryDraft(asker, target, progress), null);
    assert.deepEqual(f.releases, [draftKey]); assert.equal(f.reads.length, 0);
  }
});

test('loss of a draft reply and cancellation during the claim both leave only progress', async t => {
  for (const outcome of ['lost', 'cancelled', 'switched']) {
    const controller = new AbortController(), releases: unknown[] = [];
    const f = fixture({ temporaryDraftApiVersion: '1.0.0', getSelfId: () => target.accountId,
      claimTemporaryDraft: async () => {
        if (outcome === 'lost') throw Error('private synthetic raw body');
        if (outcome === 'cancelled') controller.abort(); else f.selectCurrent('two');
        return { status: 'claimed', ...target, expiresAt: '2035-02-01T00:00:00Z', parts };
      },
      releaseTemporaryDraft: async (key: unknown) => { releases.push(key); return { status: 'released' }; },
    });
    t.after(f.close);
    assert.equal(await f.qq.readTemporaryDraft({ ...asker, signal: controller.signal }, target, progress), null);
    assert.deepEqual(releases, [draftKey]); assert.equal(f.reads.length, 0);
  }
});

test('分页边界失效从第一页补读，重复行只建一条，尚在发送的原话不建念头', async t => {
  const a = delivery('a'), b = delivery('b'), stillSending = { ...delivery('pending'), state: 'in_progress' };
  let stale = true, firstPages = 0;
  const f = fixture({ listTextDeliveries: async (input: any) => {
    if (!input.cursor) { firstPages++; return { status: 'ok', items: [a], nextCursor: 'second' }; }
    if (stale) { stale = false; return { status: 'blocked', reason: 'stale_revision' }; }
    return { status: 'ok', items: [a, b, stillSending] };
  } }); t.after(f.close);
  await f.qq.check('one');
  assert.equal(firstPages, 2);
  const ids = (await f.runtime.intents.list('one')).map(i => i.qq?.deliveryId);
  assert.deepEqual(ids, ['a','b']);
  assert.equal(await f.qq.claim('one'), true);
  assert.equal(await f.qq.claim('one'), false);
});

test('不确定分段、投递失败后的新版本与丢失回执不触发盲目重试', async t => {
  const f = fixture(); t.after(f.close);
  const id = await f.linked();
  let attempts = 0;
  f.item.parts[1].state = 'unknown';
  assert.equal((await f.act(id)).status, 'blocked');
  f.item.parts[1].state = 'not_sent';
  f.service.resumeTextDelivery = async () => {
    attempts++;
    throw Error('receipt lost');
  };
  assert.equal((await f.act(id)).reason, 'unavailable');
  assert.equal((await f.act(id)).reason, 'already_attempted');
  f.item.revision = 'b';
  await f.change();
  assert.equal(await f.qq.ready('one'), false);
  f.item.canResume = false; f.item.blockedReason = 'offline';
  await f.change();
  f.item.canResume = true; f.item.blockedReason = undefined;
  await f.change();
  assert.equal(await f.qq.claim('one'), true);
  assert.equal(await f.qq.claim('one'), false);
  assert.equal(attempts, 1);
});

test('仅全部确认才关闭念头；请求送达确认与本地补记失败分别返回', async t => {
  const f = fixture(); t.after(f.close);
  const id = await f.linked();
  f.service.resumeTextDelivery = async () => ({ status: 'sent', confirmed: false });
  assert.equal((await f.act(id)).status, 'incomplete');
  assert.equal((await f.runtime.intents.list('one')).length, 1);
  f.item.revision = 'fresh';
  f.failRecord(true);
  f.service.resumeTextDelivery = async () => ({ status: 'sent', confirmed: true, receiptUnavailable: true });
  const result = await f.act(id);
  assert.equal(result.confirmed, true);
  assert.equal(result.memoryPending, true);
  f.failRecord(false);
  await f.change(); // Reconcile the outbox while QQ still lists the stale incomplete row.
  assert.equal((await f.runtime.intents.list('one')).length, 0);
  assert.equal(await f.qq.ready('one'), false);
  assert.equal((await f.read({ action: 'list' })).items.length, 0);
  assert.equal((await f.act(id)).reason, 'not_found');
});

test('临时轮放弃只能持久化固定原因，绑定撤销或会话取消会中断在途续发', async t => {
  for (const cancel of ['binding','session']) {
    const f = fixture(); t.after(f.close);
    const id = await f.linked();
    const sessionController = new AbortController();
    const session = { ...f.session, transientContext: true, signal: sessionController.signal };
    assert.equal((await f.act(id, 'abandon', { reason: 'fixture unfinished sentence' }, session)).reason, 'invalid_reason');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.service.resumeTextDelivery = async (_input, { signal }) => {
      entered(); assert.ok(signal instanceof AbortSignal);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'blocked', confirmed: false, reason: 'cancelled' };
    };
    const task = f.act(id, 'resume', {}, session);
    await started;
    if (cancel === 'binding') f.close(); else sessionController.abort();
    assert.equal((await task).confirmed, false);
    assert.equal((await f.runtime.intents.list('one')).length, 1);
  }
});
