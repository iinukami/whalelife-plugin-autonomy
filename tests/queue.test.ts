import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, thought } from './fake.ts';
import { Autonomy } from '../src/runtime.ts';

test('busy ordinary and manual triggers coalesce; due agreements lead the queue without interrupting the holder', async t => {
  const f = fake(); await f.initialize(); await f.runtime.tick(); f.finishing();
  const holder = f.hold();
  t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  await f.runtime.intents.change('one', { ...thought(), kind: 'agreement', source: 'conversation', dueAt: new Date(f.now + 120000).toISOString() });
  f.now += 60000; await f.runtime.tick();
  const clicks = await Promise.all(Array.from({ length: 8 }, () => f.runtime.manualWake()));
  assert.equal(new Set(clicks.map(r => r.jobId)).size, 1);
  assert.equal(clicks.filter(r => r.merged).length, 7);
  f.now += 60000; await f.runtime.tick(); await f.runtime.tick();
  f.now += 60000; await f.runtime.tick();
  const waiting = await f.runtime.status();
  assert.equal(waiting.running, null);
  assert.equal(waiting.queued.length, 3);
  assert.equal(f.submissions.length, 3);
  assert.equal(f.requests.length, 0);
  assert.equal(f.experiences.size, 0);
  assert.equal(waiting.lastActivityAt, null);
  assert.ok(waiting.runs.every(r => r.phase === 'queued' && r.queuedAt && !r.startedAt));
  holder.release(); await holder.done; await f.runtime.idle();
  assert.deepEqual(f.requests.map(r => r.priority), [0, -10, -20]);
  assert.equal(f.experiences.size, 3);
  assert.equal((await f.runtime.status()).queued.length, 0);
  assert.ok((await f.runtime.status()).runs.every(r => r.phase === 'completed'));
});

test('execution-time checks cancel sleeping or switched-away requests even before the next timer tick', async () => {
  for (const change of ['sleep', 'switch']) {
    const f = fake(); await f.initialize({ sleep: [{ start: '10:02', end: '11:00' }] }); await f.runtime.tick(); f.finishing();
    const holder = f.hold();
    f.now += 60000; await f.runtime.tick();
    assert.equal((await f.runtime.status()).queued.length, 1);
    if (change === 'sleep') f.now += 60000;
    else f.select('two');
    holder.release(); await holder.done; await f.runtime.idle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.experiences.size, 0);
    const state = f.documents.get('one:activity')!.data;
    assert.equal(state.runs[0].phase, 'cancelled');
    assert.equal(state.lastActivityAt, null);
  }
});

test('pausing auto wake cancels only pending auto work; explicit stop also cancels queued manual work', async t => {
  const f = fake(); await f.initialize(); await f.runtime.tick(); f.finishing();
  const holder = f.hold();
  t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  f.now += 60000; await f.runtime.tick(); await f.runtime.manualWake();
  await f.runtime.configure({ ...f.runtime.config, enabled: false }, f.runtime.configRevision);
  await f.flush();
  assert.deepEqual((await f.runtime.status()).queued.map(j => j.trigger), ['manual']);
  await f.runtime.cancelJudgments();
  holder.release(); await holder.done; await f.runtime.idle();
  assert.equal(f.requests.length, 0);
  assert.equal(f.experiences.size, 0);
  assert.ok((await f.runtime.status()).runs.every(r => r.phase === 'cancelled'));
  assert.equal((await f.runtime.status()).lastActivityAt, null);
});

test('a queued agreement is discarded after completion, abandonment or rescheduling', async () => {
  for (const action of ['complete', 'abandon', 'revise']) {
    const f = fake(); await f.initialize({ probability: 0 }); await f.runtime.tick(); f.finishing();
    const holder = f.hold();
    const created: any = await f.runtime.intents.change('one', { ...thought(), kind: 'agreement', source: 'conversation', dueAt: new Date(f.now + 1000).toISOString() });
    f.now += 1000; await f.runtime.tick();
    const args = { action, requestId: 'change', intentId: created.intent.id, version: 1, reason: '已在当前交流处理', evidence: '当前交流中明确处理这项约定' };
    await f.runtime.intents.change('one', action === 'revise'
      ? { ...args, kind: 'agreement', source: 'conversation', text: '稍后提醒', dueAt: new Date(f.now + 60000).toISOString() }
      : args);
    const priorExperiences = f.experiences.size;
    holder.release(); await holder.done; await f.runtime.idle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.experiences.size, priorExperiences);
    assert.equal((await f.runtime.status()).runs[0].phase, 'cancelled');
    assert.equal((await f.runtime.status()).lastActivityAt, null);
  }
});

test('stopping and restoring a queued instance does not record a fictitious action or replay its request', async () => {
  const f = fake(); await f.initialize({ probability: 0 }); await f.runtime.tick(); f.finishing();
  const holder = f.hold();
  await f.runtime.manualWake();
  f.runtime.stop(); await f.runtime.idle(); holder.release(); await holder.done;
  const restarted = new Autonomy(f.ctx, { now: () => f.now, timers: false });
  await restarted.initialize();
  await restarted.configure({ ...f.runtime.config }, restarted.configRevision);
  await restarted.tick();
  assert.equal(f.requests.length, 0);
  assert.equal(f.experiences.size, 0);
  const state = await restarted.status();
  assert.equal(state.runs[0].phase, 'cancelled');
  assert.equal(state.lastActivityAt, null);
  restarted.stop();
});

test('user-message activity does not cancel a waiting opportunity', async t => {
  const f = fake(); await f.initialize(); f.finishing();
  const holder = f.hold();
  t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  await f.runtime.manualWake();
  await f.emit('channel/message', { session: 'one', origin: { plugin: 'qq' }, type: 'message', role: 'user', text: '正在交流' });
  assert.equal((await f.runtime.status()).queued.length, 1);
  assert.equal(f.experiences.size, 0);
  holder.release(); await holder.done; await f.runtime.idle();
  assert.equal(f.requests.length, 1);
  assert.equal((await f.runtime.status()).runs[0].phase, 'completed');
});
