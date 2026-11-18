import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from './fake.ts';

test('QQ can discover an unfinished reply while paused or asleep; it waits for an allowed time to ask', async t => {
  const f = fake();
  t.after(() => f.runtime.stop());
  await f.initialize({ enabled: false, probability: 0, sleep: [{ start: '09:00', end: '11:00' }] });
  const ref = { accountId: 'test-account', deliveryId: 'test-delivery' };
  let claimed = false;
  f.runtime.qq.check = async session => { await f.runtime.intents.linkQQ(session, ref); };
  f.runtime.qq.ready = async () => !claimed;
  f.runtime.qq.claim = async () => { claimed = true; return true; };
  f.finishing();
  await f.runtime.tick();
  await f.flush();
  assert.equal((await f.runtime.intents.list('one')).length, 1);
  assert.equal(f.submissions.length, 0);
  await f.runtime.configure({ ...f.runtime.config, enabled: true }, f.runtime.configRevision);
  await f.runtime.tick();
  assert.equal(f.submissions.length, 0);
  f.now = Date.parse('2026-10-31T11:00:00+08:00');
  await f.runtime.tick();
  await f.runtime.idle();
  assert.match(f.requests[0].text, /触发原因：QQ/);
  assert.equal((await f.runtime.status()).runs[0].trigger, 'qq_resume');
  assert.equal((await f.runtime.intents.list('one')).length, 1);
  await f.runtime.tick();
  assert.equal(f.requests.length, 1);
});

test('a queued QQ judgment rechecks eligibility after the human finishes speaking', async t => {
  const f = fake();
  await f.initialize({ probability: 0 });
  const holder = f.hold();
  t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  f.runtime.qq.ready = async () => true;
  f.runtime.qq.claim = async () => false; // The delivery was resolved during the human turn.
  await f.runtime.tick();
  assert.equal((await f.runtime.status()).queued.length, 1);
  holder.release();
  await holder.done;
  await f.runtime.idle();
  assert.equal((await f.runtime.status()).runs[0].phase, 'cancelled');
  assert.equal(f.requests.length, 0);
  assert.equal(f.experiences.size, 0);
});
