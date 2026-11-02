import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, thought } from './fake.ts';

test('failure to persist the failure status is reconciled after storage recovers without replay', async () => {
  const f = fake(); await f.initialize({ probability: 0 });
  f.model(async () => {
    f.failWrite(key => key === 'activity');
    throw Error('Provider connection was interrupted');
  });
  await f.runtime.manualWake();
  await f.runtime.idle().catch(() => {});
  assert.equal((await f.runtime.status()).runs[0].phase, 'running');
  f.failWrite(null);
  await f.runtime.tick();
  assert.equal((await f.runtime.status()).runs[0].phase, 'uncertain');
  assert.equal(f.requests.length, 1);
  assert.equal(f.experiences.size, 1);
  assert.equal([...f.experiences.values()][0].outcome, 'pending');
  await f.runtime.tick();
  assert.equal(f.experiences.size, 1);
});

test('intent outcome recorded during an already recovered session is settled on idle tick after write recovery', async () => {
  const f = fake(); await f.initialize({ enabled: false });
  await f.runtime.tick();
  const created: any = await f.runtime.intents.change('one', thought('recover-intent'));
  f.failRecord(true);
  await assert.rejects(f.runtime.intents.change('one', {
    action: 'abandon', requestId: 'end-intent', intentId: created.intent.id, version: 1,
    reason: '已经明确调整安排', evidence: '当前交流中的实际放弃决定',
  }), /recording failure/);
  assert.equal((await f.runtime.intents.list('one'))[0].state, 'settling');
  f.failRecord(false);
  await f.runtime.tick();
  assert.equal((await f.runtime.intents.list('one')).length, 0);
  assert.equal(f.experiences.size, 1);
  assert.match([...f.experiences.values()][0].text, /明确调整安排/);
  await f.runtime.tick();
  assert.equal(f.experiences.size, 1);
  assert.equal(f.requests.length, 0);
});

test('failed admission and failure-state writes recover as unexecuted cancellation, with no model or action memory', async () => {
  const f = fake(); await f.initialize({ probability: 0 });
  f.failWrite((key, data) => key === 'activity' && data.runs.some((r: any) => ['running', 'failed'].includes(r.phase)));
  await f.runtime.manualWake(); await f.runtime.idle().catch(() => {});
  assert.equal((await f.runtime.status()).runs[0].phase, 'queued');
  f.failWrite(null); await f.runtime.tick();
  const run = (await f.runtime.status()).runs[0];
  assert.equal(run.phase, 'cancelled'); assert.equal(run.startedAt, undefined);
  assert.equal(f.requests.length, 0); assert.equal(f.experiences.size, 0);
});

test('acknowledged intent experience with failed removal is reconciled on tick exactly once', async () => {
  const f = fake(); await f.initialize({ enabled: false }); await f.runtime.tick();
  const created: any = await f.runtime.intents.change('one', thought('retained-intent'));
  f.failWrite((key, data) => key === 'intents' && data.items.length === 0);
  await assert.rejects(f.runtime.intents.change('one', {
    action: 'complete', requestId: 'finish-retained', intentId: created.intent.id, version: 1,
    reason: '已完成本地测试动作', evidence: '测试动作已实际完成并返回结果',
  }), /write failure/);
  assert.equal(f.experiences.size, 1);
  f.failWrite(null); await f.runtime.tick(); await f.runtime.tick();
  assert.equal((await f.runtime.intents.list('one')).length, 0);
  assert.equal(f.experiences.size, 1); assert.equal(f.requests.length, 0);
});
