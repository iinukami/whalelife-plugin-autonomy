import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Intents, Documents } from '../src/storage.ts';
import { fake, thought } from './fake.ts';

const ref = { accountId: 'account-a', deliveryId: 'plan-one' };

test('a QQ interruption becomes one durable ordinary thought per account, delivery and session', async () => {
  const f = fake(), intents = f.runtime.intents;
  const at = new Date(f.now - 60000).toISOString();
  const snapshot = { ...ref, parts: [{ text: '冻结原文只应留在 QQ' }] };
  const [a, b] = await Promise.all([intents.linkQQ('one', snapshot, at), intents.linkQQ('one', snapshot, at)]);
  assert.equal(a.id, b.id);
  assert.equal(a.kind, 'thought');
  assert.equal(a.createdAt, at);
  assert.equal(a.dueAt, null);
  assert.notEqual((await intents.linkQQ('two', ref)).id, a.id);
  assert.notEqual((await intents.linkQQ('one', { ...ref, accountId: 'account-b' })).id, a.id);
  assert.equal((await intents.list('one')).length, 2);
  assert.doesNotMatch(JSON.stringify([...f.documents.values()]), /冻结原文只应留在 QQ/);
  await Promise.all([intents.reviewQQ('one', ref, 'rev-1'), intents.reviewQQ('one', ref, 'rev-1')]);
  const reloaded = new Intents(new Documents(f.ctx.memory));
  const stored = (await reloaded.list('one')).find(i => i.id === a.id)!;
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.qq, { ...ref, reviewedRevision: 'rev-1' });
  await reloaded.reviewQQ('one', ref, 'rev-1', true);
  await reloaded.reviewQQ('one', ref, 'rev-2');
  assert.deepEqual((await intents.list('one'))[0].qq, { ...ref, reviewedRevision: 'rev-2', attemptedRevision: 'rev-1' });
  assert.equal(f.experiences.size, 0);
});

test('ordinary intent mutations cannot revise the original QQ plan or manufacture its outcome', async () => {
  const f = fake(), intents = f.runtime.intents;
  const item = await intents.linkQQ('one', ref);
  for (const action of ['revise', 'complete', 'abandon']) {
    await assert.rejects(intents.change('one', {
      ...thought(), action, intentId: item.id, version: 1, reason: '模型推测已送达',
    }), /QQ 未完成表达/);
  }
  await assert.rejects(intents.closeQQ('one', ref, 'dismissed'), /原因/);
  assert.deepEqual(await intents.list('one'), [item]);
  assert.equal(f.experiences.size, 0);
});

test('abandonment requires a durable reason before closing and settles once across a restart', async () => {
  const f = fake(), intents = f.runtime.intents, reason = '后来已经当面解释，无需再补发';
  await intents.linkQQ('one', ref);
  f.failWrite((key, data) => key === 'intents' && data.items[0]?.qq?.abandonReason);
  await assert.rejects(intents.prepareQQAbandon('one', ref, reason), /write failure/);
  await assert.rejects(intents.closeQQ('one', ref, 'dismissed'), /原因/);
  f.failWrite(null);
  await intents.prepareQQAbandon('one', ref, reason);
  f.failRecord(true);
  await assert.rejects(intents.closeQQ('one', ref, 'dismissed'), /recording failure/);
  assert.equal((await intents.list('one'))[0].state, 'settling');
  f.failRecord(false);
  const reloaded = new Intents(new Documents(f.ctx.memory));
  f.failWrite((key, data) => key === 'intents' && data.items.length === 0);
  await assert.rejects(reloaded.closeQQ('one', ref, 'dismissed'), /write failure/);
  assert.equal(f.experiences.size, 1);
  f.failWrite(null);
  await Promise.all([reloaded.closeQQ('one', ref, 'dismissed'), reloaded.settle('one')]);
  assert.deepEqual(await reloaded.list('one'), []);
  assert.equal(f.experiences.size, 1);
  assert.ok([...f.experiences.values()][0].text.includes(reason));
});

test('a confirmed send supersedes an uncommitted dismissal and removes only its own thought', async () => {
  const f = fake(), intents = f.runtime.intents;
  await intents.linkQQ('one', ref);
  const other = await intents.linkQQ('one', { ...ref, accountId: 'another-account' });
  await intents.prepareQQAbandon('one', ref, '暂时以为无法继续');
  await Promise.all([intents.closeQQ('one', ref, 'sent'), intents.closeQQ('one', ref, 'sent')]);
  await intents.reviewQQ('one', ref, 'late-notice');
  assert.deepEqual(await intents.list('one'), [other]);
  assert.equal(f.experiences.size, 1);
  const [result] = f.experiences.values();
  assert.equal(result.origin?.action, '完成意图');
  assert.match(result.text, /平台的全部发送确认/);
  assert.doesNotMatch(result.text, /已读|暂时以为无法继续/);
});

test('confirmed send without a QQ receipt cannot be rediscovered after reload from a stale provider index', async () => {
  const f = fake(), intents = f.runtime.intents;
  await intents.linkQQ('one', ref);
  f.failRecord(true);
  await assert.rejects(intents.closeQQ('one', ref, 'sent', true), /recording failure/);
  assert.deepEqual(await intents.verifiedQQClosures('one'), [ref]);
  f.failRecord(false);
  const recovered = new Intents(new Documents(f.ctx.memory));
  await recovered.settle('one');
  assert.deepEqual(await recovered.list('one'), []);
  await assert.rejects(recovered.linkQQ('one', ref), /QQ 已确认/);
  await recovered.forgetQQClosures('one', [{ ...ref, accountId: 'another-account' }]);
  assert.deepEqual(await recovered.verifiedQQClosures('one'), [ref]);
  assert.deepEqual(await recovered.verifiedQQClosures('two'), []);
  await recovered.forgetQQClosures('one', [ref]);
  assert.deepEqual(await recovered.verifiedQQClosures('one'), []);
  assert.equal(f.experiences.size, 1);
});
