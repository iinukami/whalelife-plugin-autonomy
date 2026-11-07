import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autonomy } from '../src/runtime.ts';
import { fake } from './fake.ts';
import { settings } from '../src/config.ts';

let request = 0;
const get = (f: ReturnType<typeof fake>, session = 'one') => f.runtime.scheduleSelfWake(session, { action: 'get' });
async function arrange(f: ReturnType<typeof fake>, ms = 60000, session = 'one') {
  const before = await get(f, session);
  const args = { action: 'set', version: before.version, requestId: `test-${++request}`,
    at: new Date(f.now + ms).toISOString(), reason: '稍后再决定要不要继续整理自己的日记' };
  const result = await f.runtime.scheduleSelfWake(session, args);
  return { args, result };
}

test('self scheduling is opt-in and rejects disabled, malformed, past and foreign-session inputs', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize();
  assert.equal(settings({}).allowSelfWake, false); assert.equal(settings({}).selfWakeDuringSleep, false);
  assert.throws(() => settings({ selfWakeDuringSleep: 'true' }), /开关/);
  await assert.rejects(arrange(f), /尚未开启/);
  await f.runtime.configure({ ...f.runtime.config, allowSelfWake: true, enabled: false }, f.runtime.configRevision);
  await assert.rejects(arrange(f), /总开关已关闭/);
  await f.runtime.configure({ ...f.runtime.config, enabled: true }, f.runtime.configRevision);
  for (const at of [new Date(f.now - 1).toISOString(), 'tomorrow', '2030-01-01T00:00:00', null]) {
    await assert.rejects(f.runtime.scheduleSelfWake('one', { action: 'set', requestId: 'invalid', version: 0, at, reason: '稍后判断' }), /时间/);
  }
  await assert.rejects(f.runtime.scheduleSelfWake('one', { action: 'get', session: 'two' }), /会话归属/);
  assert.equal((await get(f)).schedule, null); assert.equal(f.requests.length, 0);
});

test('sleep-time requests fail with an explanation, while the separate user override permits them', async t => {
  const f = fake(); t.after(() => f.runtime.stop());
  await f.initialize({ allowSelfWake: true, probability: 0, sleep: [{ start: '10:00', end: '11:00' }] });
  await assert.rejects(arrange(f), /睡眠时段.*本次未设置/);
  assert.equal((await get(f)).schedule, null);
  await f.runtime.configure({ ...f.runtime.config, selfWakeDuringSleep: true }, f.runtime.configRevision);
  await arrange(f); f.finishing(); await f.runtime.tick();
  f.now += 60000; await f.runtime.tick(); await f.runtime.idle();
  const status = await f.runtime.status();
  assert.equal(status.sleeping, true); assert.equal(status.runs[0].trigger, 'self');
  assert.equal(status.runs[0].phase, 'completed'); assert.equal(status.selfWake, null);
  assert.match(f.requests[0].text, /你自己安排的唤醒时间已到/);
  assert.match(f.requests[0].text, /稍后再决定要不要继续整理自己的日记/);
});

test('a self wake ignores dice, triggers only at its due time and is consumed once', async t => {
  const f = fake(); t.after(() => f.runtime.stop());
  await f.initialize({ allowSelfWake: true, probability: 0, intervalMinutes: 30 }); f.finishing();
  const { args, result } = await arrange(f); await f.runtime.tick();
  f.now += 59999; await f.runtime.tick(); assert.equal(f.requests.length, 0);
  f.now++; await f.runtime.tick(); await f.runtime.idle();
  assert.equal(f.requests.length, 1); assert.equal((await get(f)).schedule, null);
  assert.equal((await f.runtime.status()).runs[0].selfWake?.id, result.schedule!.id);
  for (let i = 0; i < 5; i++) { f.now += 60000; await f.runtime.tick(); }
  const repeated = await f.runtime.scheduleSelfWake('one', args);
  assert.equal(repeated.duplicate, true); assert.equal(repeated.schedule, null);
  await f.runtime.tick(); assert.equal(f.requests.length, 1);
  assert.equal((await f.runtime.status()).lastActivityAt, (await f.runtime.status()).runs[0].endedAt);
});

test('revisions, operation IDs and cancellation prevent stale edits from overwriting a newer arrangement', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize({ allowSelfWake: true });
  const first = await arrange(f), second = await arrange(f, 120000);
  assert.notEqual(first.result.schedule!.id, second.result.schedule!.id);
  await assert.rejects(f.runtime.scheduleSelfWake('one', { ...first.args, requestId: 'stale' }), /已经变化/);
  await assert.rejects(f.runtime.scheduleSelfWake('one', { ...first.args, reason: '不同的内容' }), /同一操作ID/);
  const duplicate = await f.runtime.scheduleSelfWake('one', first.args);
  assert.equal(duplicate.schedule!.id, second.result.schedule!.id);
  const cancel = { action: 'cancel', requestId: 'cancel', version: second.result.version };
  await f.runtime.scheduleSelfWake('one', cancel);
  const third = await arrange(f, 180000);
  assert.equal((await f.runtime.scheduleSelfWake('one', cancel)).schedule!.id, third.result.schedule!.id);
  assert.equal(f.experiences.size, 0, 'a future arrangement is state, not a completed action');
});

test('a busy conversation queues one self wake; replacing it prevents the old one from executing', async t => {
  const f = fake(); await f.initialize({ allowSelfWake: true, probability: 0 }); f.finishing();
  const holder = f.hold(); t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  await arrange(f); await f.runtime.tick(); f.now += 60000;
  for (let i = 0; i < 5; i++) await f.runtime.tick();
  assert.equal((await f.runtime.status()).queued.length, 1); assert.equal(f.requests.length, 0);
  const next = await arrange(f, 120000);
  holder.release(); await holder.done; await f.runtime.idle();
  assert.equal(f.requests.length, 0); assert.equal((await get(f)).schedule!.id, next.result.schedule!.id);
  f.now += 120000; await f.runtime.tick(); await f.runtime.idle(); assert.equal(f.requests.length, 1);
});

test('user stop cancels a queued self wake instead of immediately submitting it again', async t => {
  const f = fake(); await f.initialize({ allowSelfWake: true, probability: 0 }); f.finishing();
  const holder = f.hold(); t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  await arrange(f); await f.runtime.tick(); f.now += 60000; await f.runtime.tick();
  assert.equal((await f.runtime.status()).queued.length, 1);
  await f.runtime.cancelJudgments(); await f.runtime.tick();
  assert.equal((await get(f)).schedule, null); assert.equal((await f.runtime.status()).queued.length, 0);
  holder.release(); await holder.done; assert.equal(f.requests.length, 0);
});

test('sleep entered while waiting cancels admission and preserves the arrangement until waking hours', async t => {
  const f = fake(); await f.initialize({ allowSelfWake: true, probability: 0, sleep: [{ start: '10:02', end: '11:00' }] }); f.finishing();
  const holder = f.hold(); t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  await arrange(f); await f.runtime.tick(); f.now += 60000; await f.runtime.tick();
  f.now += 60000; await f.runtime.tick(); await f.runtime.idle();
  holder.release(); await holder.done;
  assert.equal(f.requests.length, 0); assert.ok((await get(f)).schedule);
  f.now = Date.parse('2026-10-31T11:00:00+08:00'); await f.runtime.tick(); await f.runtime.idle();
  assert.equal(f.requests.length, 1); assert.equal((await get(f)).schedule, null);
});

test('turning off the sleep exception or self-wake switch invalidates already queued work', async t => {
  for (const field of ['selfWakeDuringSleep', 'allowSelfWake'] as const) {
    const f = fake(); await f.initialize({ allowSelfWake: true, selfWakeDuringSleep: true, probability: 0, sleep: [{ start: '10:00', end: '11:00' }] }); f.finishing();
    const holder = f.hold(); t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
    await arrange(f); await f.runtime.tick(); f.now += 60000; await f.runtime.tick();
    await f.runtime.configure({ ...f.runtime.config, [field]: false }, f.runtime.configRevision);
    await f.runtime.idle(); holder.release(); await holder.done;
    assert.equal(f.requests.length, 0); assert.ok((await get(f)).schedule);
  }
});

test('only the current conversation wakes and an unstarted arrangement survives an instance restart', async t => {
  const f = fake(); await f.initialize({ allowSelfWake: true, probability: 0 }); f.finishing();
  await arrange(f); f.select('two'); await f.runtime.tick(); f.now += 60000; await f.runtime.tick();
  assert.equal(f.requests.length, 0); assert.ok((await get(f)).schedule);
  f.runtime.stop();
  const restarted = new Autonomy(f.ctx, { now: () => f.now, timers: false });
  t.after(async () => { restarted.stop(); await restarted.idle(); });
  await restarted.initialize(); await restarted.configure(f.runtime.config, restarted.configRevision);
  f.model(async input => {
    await restarted.finish({ runId: /本轮ID：([^\n]+)/.exec(input.text)![1], decision: 'no_action', reason: '醒来后选择不行动' },
      { id: input.sessionId!, permission: 'full', origin: { plugin: 'autonomy', action: '自主唤起' }, signal: input.signal });
    input.signal!.throwIfAborted(); return '';
  });
  await restarted.tick(); assert.equal(f.requests.length, 0);
  f.select('one'); await restarted.tick(); await restarted.idle();
  assert.equal(f.requests.length, 1); assert.equal((await restarted.status()).selfWake, null);
});

test('a failed model does not rearm a consumed self wake, including after restart', async t => {
  const f = fake(); await f.initialize({ allowSelfWake: true, probability: 0 });
  await arrange(f); await f.runtime.tick(); f.now += 60000; await f.runtime.tick(); await f.runtime.idle();
  assert.equal((await f.runtime.status()).runs[0].phase, 'failed');
  assert.equal((await get(f)).schedule, null); f.runtime.stop();
  const restarted = new Autonomy(f.ctx, { now: () => f.now, timers: false }); t.after(() => restarted.stop());
  await restarted.initialize(); await restarted.configure(f.runtime.config, restarted.configRevision);
  await restarted.tick(); f.now += 60000; await restarted.tick(); assert.equal(f.requests.length, 1);
});

test('failed durable admission leaves the arrangement available without calling the model', async t => {
  const f = fake(); t.after(() => f.runtime.stop()); await f.initialize({ allowSelfWake: true, probability: 0 }); f.finishing();
  await arrange(f); await f.runtime.tick();
  f.failWrite((key, data) => key === 'activity' && data.runs.some((r: any) => r.phase === 'running'));
  f.now += 60000; await f.runtime.tick(); await f.runtime.idle();
  assert.equal(f.requests.length, 0); assert.ok((await get(f)).schedule);
  f.failWrite(null); await f.runtime.tick(); await f.runtime.idle(); assert.equal(f.requests.length, 1);
});
