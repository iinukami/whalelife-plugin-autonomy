import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryEvent } from 'whalelife';
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

test('a private follow-up can claim the same interruption while the reconnect judgment is queued', async t => {
  const f = fake(), account = '100001', peer = 'direct:200002', session = 'one';
  await f.initialize({ probability: 0 });
  const at = (offset: number) => new Date(f.now + offset).toISOString();
  const rows: MemoryEvent[] = [{ id: 'older', ts: at(0), session, type: 'tool' }];
  f.ctx.memory.readSession = async () => rows.slice();
  const holder = f.hold(session);
  t.after(async () => { holder.release(); f.runtime.stop(); await f.runtime.idle(); });
  await f.runtime.tick();
  await f.flush();
  const base: MemoryEvent = { id: 'gen', ts: at(20), session, type: 'channel_receipt', direction: 'out',
    account, channel: 'qq', peer, conversation: { channel: 'qq', origin: { plugin: 'qq' }, account, peer },
    status: 'generated', text: '[QQ 临时私聊；正文不留存；指纹 ' + 'a'.repeat(64) + ']',
    external_message_id: 'test-action', delivery_id: 'delivery_' + 'c'.repeat(64) };
  rows.push(base, { ...base, id: 'failure', ts: at(80), status: 'delivery_failed',
    error: 'QQ 投递部分完成：共 8 段，确认发送 2 段，明确未发送 6 段（其中 5 段未提交），结果未知 0 段。' });
  const start = f.now;
  f.now += 100;
  f.runtime.qq.recoveryAccount = async () => account;
  f.runtime.qq.recoveryWindows = () => [{ offlineAt: start + 50, onlineAt: start + 95 }];
  // The tool notification was missed. Reconnection rereads the public archive.
  for (let i = 0; i < 5 && !f.submissions.length; i++) { await f.runtime.tick(); await f.flush(); }
  assert.equal((await f.runtime.status()).queued[0]?.trigger, 'qq_interruption');
  const query = () => f.runtime.recentInterruption({ id: session, permission: 'full', channel: 'qq', account, peer,
    sender: '200002', origin: { plugin: 'qq' } });
  assert.equal((await query()).items[0]?.sent, 2);
  holder.release();
  await holder.done;
  await f.runtime.idle();
  assert.equal(f.requests.length, 0);
  assert.equal((await f.runtime.status()).runs[0].phase, 'cancelled');
  assert.equal((await query()).items[0]?.notSent, 6);
});
