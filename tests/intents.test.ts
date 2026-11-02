import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, thought } from './fake.ts';
import { IntentInputError } from '../src/storage.ts';

test('a missing abandonment evidence field is identified without mutating the intention; corrected retry succeeds', async () => {
  const f = fake(), created: any = await f.runtime.intents.change('one', thought());
  const before = structuredClone(f.documents);
  const args = { action: 'abandon', requestId: 'missing-evidence', intentId: created.intent.id, version: 1, reason: '改用口述日记' };
  await assert.rejects(f.runtime.intents.change('one', args), (error: unknown) => {
    assert.ok(error instanceof IntentInputError);
    assert.equal(error.code, 'missing_fields');
    assert.deepEqual(error.fields, ['evidence']);
    assert.match(error.message, /reason 不能代替 evidence/);
    return true;
  });
  assert.deepEqual(f.documents, before);
  assert.equal(f.experiences.size, 0);
  await f.runtime.intents.change('one', { ...args, evidence: '已明确选择口述，不再写这篇日记' });
  assert.equal((await f.runtime.intents.list('one')).length, 0);
  assert.equal(f.experiences.size, 1);
});

test('incomplete revision reports every missing field and excessive evidence identifies the correct field', async () => {
  const f = fake(), created: any = await f.runtime.intents.change('one', thought());
  const before = structuredClone(f.documents);
  await assert.rejects(f.runtime.intents.change('one', { action: 'revise', requestId: 'edit', intentId: created.intent.id, version: 1, text: '已作废', dueAt: null }), (error: unknown) => {
    assert.ok(error instanceof IntentInputError);
    assert.deepEqual(error.fields, ['kind', 'source', 'evidence']);
    return true;
  });
  await assert.rejects(f.runtime.intents.change('one', { action: 'abandon', requestId: 'end', intentId: created.intent.id, version: 1, reason: '改变安排', evidence: '据'.repeat(141) }), (error: unknown) => {
    assert.ok(error instanceof IntentInputError);
    assert.equal(error.code, 'invalid_fields');
    assert.deepEqual(error.fields, ['evidence']);
    assert.match(error.message, /evidence.*140/);
    return true;
  });
  assert.deepEqual(f.documents, before);
  assert.equal(f.experiences.size, 0);
});

test('intents belong to a session; creation uses real clock, requires evidence, and does not record a performed action', async () => {
  const f = fake();
  assert.deepEqual(await f.runtime.intents.list('one'),[]);
  assert.equal(f.documents.size,0);
  const r:any = await f.runtime.intents.change('one',{...thought(),createdAt:'1900-01-01'});
  assert.equal(r.intent.createdAt,new Date(f.now).toISOString());
  assert.equal((await f.runtime.intents.list('two')).length,0);
  assert.equal(f.experiences.size,0);
  await assert.rejects(f.runtime.intents.change('one',{...thought('bad'),dueAt:'2026-11-01T09:00:00+08:00'}),/普通/);
  await assert.rejects(f.runtime.intents.change('one',{...thought('bad2'),kind:'agreement'}),/交流/);
});
test('mutations are idempotent and stale revisions cannot override a newer intention', async () => {
  const f=fake(), args=thought();
  const a:any=await f.runtime.intents.change('one',args), b:any=await f.runtime.intents.change('one',args);
  assert.equal(a.intent.id,b.intent.id);
  await assert.rejects(f.runtime.intents.change('one',{...args,text:'other'}),/不同内容/);
  f.now+=1000;
  const edit={...thought('edit'),action:'revise',intentId:a.intent.id,version:1,text:'后天再写'};
  const changed:any=await f.runtime.intents.change('one',edit);
  assert.equal(changed.intent.createdAt,a.intent.createdAt);
  assert.equal(changed.intent.version,2);
  await assert.rejects(f.runtime.intents.change('one',{...edit,requestId:'stale'}),/已经变更/);
});
test('completion and abandonment remove only the finished intention and retain their real reasons', async () => {
  for(const action of ['complete','abandon']) {
    const f=fake(), created:any=await f.runtime.intents.change('one',thought());
    const args={action,requestId:'end',intentId:created.intent.id,version:1,reason:action==='complete'?'已写好日记':'改为当天口述，放弃写日记',evidence:'这是本次实际结果与决定'};
    const result:any=await f.runtime.intents.change('one',args);
    assert.equal(result.pendingRecord,false);
    assert.deepEqual(await f.runtime.intents.list('one'),[]);
    assert.equal(f.experiences.size,1);
    assert.ok([...f.experiences.values()][0].text.includes(args.reason));
    await f.runtime.intents.change('one',args);
    assert.equal(f.experiences.size,1);
  }
});
test('failed experience writes preserve a settling intention; retry does not duplicate the outcome', async () => {
  const f=fake(), created:any=await f.runtime.intents.change('one',thought());
  const args={action:'abandon',requestId:'end',intentId:created.intent.id,version:1,reason:'调整安排',evidence:'自己明确改变了主意'};
  f.failRecord(true);
  await assert.rejects(f.runtime.intents.change('one',args),/recording failure/);
  assert.equal((await f.runtime.intents.list('one'))[0].state,'settling');
  assert.equal(f.experiences.size,0);
  f.failRecord(false);
  f.failWrite((key,data)=>key==='intents'&&data.items.length===0);
  await assert.rejects(f.runtime.intents.change('one',args),/write failure/);
  assert.equal(f.experiences.size,1);
  assert.equal((await f.runtime.intents.list('one')).length,1);
  f.failWrite(null);
  await f.runtime.intents.change('one',args);
  assert.equal(f.experiences.size,1);
  assert.equal((await f.runtime.intents.list('one')).length,0);
});
test('corrupt/future-version documents are rejected and never reset to an empty list', async () => {
  const f=fake();
  f.documents.set('one:intents',{revision:'old',data:{schema:99,items:[{text:'preserve'}]}});
  await assert.rejects(f.runtime.intents.list('one'),/不受支持/);
  assert.equal(f.documents.get('one:intents')!.data.items[0].text,'preserve');
});

test('capacity rejection preserves existing intentions and reserves enough space to finish one', async () => {
  const f=fake();let full=false;
  for(let n=0;n<200;n++) {
    try { await f.runtime.intents.change('one',{...thought('capacity-'+n),text:'念'.repeat(300),evidence:'据'.repeat(200)}); }
    catch(error) { assert.match(String(error),/容量/);full=true;break; }
  }
  assert.ok(full);
  const before=await f.runtime.intents.list('one'), first=before[0];
  await f.runtime.intents.change('one',{action:'abandon',requestId:'capacity-finish',intentId:first.id,version:first.version,reason:'调整安排',evidence:'明确决定不继续这项打算'});
  assert.equal((await f.runtime.intents.list('one')).length,before.length-1);
  assert.equal(f.experiences.size,1);
});
