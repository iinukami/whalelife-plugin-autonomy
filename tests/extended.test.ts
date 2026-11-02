import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from './fake.ts';
import { settings, sleeping } from '../src/config.ts';

test('100 simultaneous manual clicks share one waiting round behind an occupied session', async t => {
  const f = fake(); await f.initialize({ enabled: false }); f.finishing();
  const holder = f.hold();
  t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  const replies = await Promise.all(Array.from({ length: 100 }, () => f.runtime.manualWake()));
  assert.equal(new Set(replies.map(r => r.jobId)).size, 1);
  assert.equal(f.requests.length, 0); assert.equal((await f.runtime.status()).queued.length, 1);
  holder.release(); await holder.done; await f.runtime.idle();
  assert.equal(f.requests.length, 1); assert.equal(f.experiences.size, 1);
});

test('three simulated days of minute ticks retain only 80 finished rounds and recover between failed requests', { timeout: 30000 }, async () => {
  const f = fake(); await f.initialize(); await f.runtime.tick();
  const count = 3 * 24 * 60;
  for (let i = 0; i < count; i++) {
    const failing = i % 17 === 0;
    if (failing) f.model(async () => { throw Error('simulated intermittent provider failure'); });
    else f.finishing(i % 2 ? 'acted' : 'no_action');
    f.now += 60000; await f.runtime.tick(); await f.runtime.idle();
    if (i % 100 === 0 || i === count - 1) {
      const state = await f.runtime.status();
      assert.equal(state.runs[0].phase, failing ? 'failed' : 'completed');
      assert.equal(state.running, null); assert.equal(state.queued.length, 0);
      assert.ok(state.runs.length <= 80);
    }
  }
  assert.equal(f.requests.length, count); assert.equal(f.experiences.size, count);
});

test('sleep boundaries remain correct through repeated and skipped local DST hours', () => {
  const repeated = settings({ timezone: 'America/New_York', sleep: [{ start: '01:00', end: '02:00' }] });
  assert.equal(sleeping(repeated, Date.parse('2026-11-01T05:30:00Z')), true);
  assert.equal(sleeping(repeated, Date.parse('2026-11-01T06:30:00Z')), true);
  assert.equal(sleeping(repeated, Date.parse('2026-11-01T07:00:00Z')), false);
  const skipped = settings({ timezone: 'America/New_York', sleep: [{ start: '01:30', end: '03:00' }] });
  assert.equal(sleeping(skipped, Date.parse('2026-03-08T06:29:59Z')), false);
  assert.equal(sleeping(skipped, Date.parse('2026-03-08T06:30:00Z')), true);
  assert.equal(sleeping(skipped, Date.parse('2026-03-08T07:00:00Z')), false);
});
