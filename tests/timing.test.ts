import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, thought } from './fake.ts';

test('ordinary deadlines vary, remain stable during polling, and are distinct from the wake dice', async t => {
  let roll = 0.25, draws = 0;
  const f = fake(() => { draws++; return roll; });
  t.after(() => f.runtime.stop());
  await f.initialize({ intervalMinutes: 30 }); f.finishing(); await f.runtime.tick();
  const first = (await f.runtime.status()).nextCheckAt!;
  assert.equal(Date.parse(first) - f.now, 22.5 * 60000);
  const sampled = draws;
  for (let i = 0; i < 20; i++) {
    f.now += 60000; await f.runtime.tick();
    assert.equal((await f.runtime.status()).nextCheckAt, first);
  }
  assert.equal(draws, sampled, 'idle polling must not continually postpone the check');
  assert.equal(f.requests.length, 0);
  roll = 0.9; f.now = Date.parse(first);
  await f.runtime.tick(); await f.runtime.idle();
  assert.equal(draws, sampled + 2, 'the next deadline and the wake dice get independent draws');
  assert.equal(f.requests.length, 1);
  const second = (await f.runtime.status()).nextCheckAt!;
  assert.equal(Date.parse(second) - f.now, 42 * 60000);
  roll = 0.1; f.now = Date.parse(second);
  await f.runtime.tick(); await f.runtime.idle();
  assert.equal(f.requests.length, 2);
  assert.equal(Date.parse((await f.runtime.status()).nextCheckAt!) - f.now, 18 * 60000);
});

test('failed dice resample the interval without resetting activity or inflating average check frequency', async t => {
  let roll = 0.5;
  const f = fake(() => roll); t.after(() => f.runtime.stop());
  await f.initialize({ intervalMinutes: 30, probability: 0 }); await f.runtime.tick();
  const delays: number[] = [];
  for (let i = 0; i < 100; i++) {
    f.now = Date.parse((await f.runtime.status()).nextCheckAt!);
    roll = (i + 0.5) / 100;
    await f.runtime.tick();
    delays.push(Date.parse((await f.runtime.status()).nextCheckAt!) - f.now);
  }
  assert.ok(delays.every(ms => ms >= 15 * 60000 && ms <= 45 * 60000));
  assert.equal(new Set(delays).size, 100);
  assert.equal(delays.reduce((a, b) => a + b) / delays.length, 30 * 60000);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.runtime.status()).lastActivityAt, null);
});

test('late ticks do not replay missed checks and sleep still suppresses random opportunities', async t => {
  const f = fake(() => 0.5); t.after(() => f.runtime.stop());
  await f.initialize({ intervalMinutes: 30, sleep: [{ start: '10:00', end: '11:00' }] });
  f.finishing(); await f.runtime.tick();
  f.now += 30 * 60000; await f.runtime.tick();
  assert.equal(f.requests.length, 0);
  f.now += 6 * 60 * 60000; await f.runtime.tick(); await f.runtime.idle();
  assert.equal(f.requests.length, 1);
  for (let i = 0; i < 5; i++) await f.runtime.tick();
  assert.equal(f.requests.length, 1);
  assert.equal(Date.parse((await f.runtime.status()).nextCheckAt!) - f.now, 30 * 60000);
});

test('timed agreements and manual judgments do not wait for a random deadline', async t => {
  const f = fake(() => 0.99); t.after(() => f.runtime.stop());
  await f.initialize({ intervalMinutes: 30, probability: 0, sleep: [{ start: '09:00', end: '18:00' }] });
  f.finishing(); await f.runtime.tick();
  const next = (await f.runtime.status()).nextCheckAt;
  await f.runtime.intents.change('one', { ...thought(), kind: 'agreement', source: 'conversation',
    evidence: '两分钟后的明确约定', dueAt: new Date(f.now + 120000).toISOString() });
  f.now += 119999; await f.runtime.tick(); assert.equal(f.requests.length, 0);
  f.now++; await f.runtime.tick(); await f.runtime.idle();
  assert.equal((await f.runtime.status()).runs[0].trigger, 'agreement');
  await f.runtime.manualWake(); await f.runtime.idle();
  assert.equal(f.requests.length, 2);
  assert.equal((await f.runtime.status()).nextCheckAt, next);
});

test('configuration and session changes replace deadlines without carrying over old opportunities', async t => {
  const f = fake(() => 0.8); t.after(() => f.runtime.stop());
  await f.initialize({ intervalMinutes: 30 }); f.finishing(); await f.runtime.tick();
  f.now += 20 * 60000;
  await f.runtime.configure({ ...f.runtime.config, intervalMinutes: 10 }, f.runtime.configRevision);
  assert.equal(Date.parse((await f.runtime.status()).nextCheckAt!) - f.now, 13 * 60000);
  f.now += 10 * 60000; f.select('two'); await f.runtime.tick();
  assert.equal(Date.parse((await f.runtime.status()).nextCheckAt!) - f.now, 13 * 60000);
  assert.equal(f.requests.length, 0);
  await f.runtime.configure({ ...f.runtime.config, enabled: false }, f.runtime.configRevision);
  f.now += 24 * 60 * 60000; await f.runtime.tick();
  assert.equal(f.requests.length, 0);
});
