import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, thought } from './fake.ts';
import { Autonomy } from '../src/runtime.ts';

test('missing queue capability fails clearly instead of falling back to a busy-rejecting or persistent input', async () => {
  const f = fake();
  (f.ctx.sessions as any).enqueueTransient = undefined;
  await assert.rejects(f.runtime.initialize(), /enqueueTransient/);
  assert.equal(f.requests.length, 0);
});

test('busy history migration prevents a wake and retries after the conversation is idle', async () => {
  const f = fake(); await f.initialize(); f.finishing();
  const id = 'legacy-run';
  await f.ctx.memory.saveDocument('one', { key: 'activity', revision: null, data: { schema: 1, lastActivityAt: null, claims: {}, runs: [
    { id, phase: 'completed', trigger: 'manual', startedAt: new Date(f.now).toISOString(), agreements: [] },
  ] } });
  f.ctx.memory.readSession = async () => [{ id: 'old-message', type: 'message', role: 'user', channel: 'plugin', account: 'autonomy',
    origin: { plugin: 'autonomy', platform: '自主性', action: '自主唤起' }, text: `【自主插件触发；这是系统记录的触发信息，不是任何人发来的消息】\n本轮ID：${id}\n触发原因：随机唤醒。` }];
  f.ctx.memory.excludeInputs = async () => { throw Error('会话正在处理'); };
  await assert.rejects(f.runtime.manualWake(), /会话正在处理/);
  assert.equal(f.requests.length, 0);
  f.ctx.memory.excludeInputs = async (_session, ids) => { assert.deepEqual(ids, ['old-message']); return { excluded: 1 }; };
  await f.runtime.manualWake(); await f.runtime.idle();
  assert.equal(f.requests.length, 1);
  assert.equal((await f.runtime.status()).runs[0].phase, 'completed');
});

test('zero intentions can wake; a deliberate no-action decision records its reason and resets activity', async () => {
  const f=fake();await f.initialize();f.finishing();
  await f.runtime.tick();assert.equal(f.requests.length,0);
  f.now+=60000;await f.runtime.tick();await f.runtime.idle();
  assert.equal(f.requests.length,1);
  const status=await f.runtime.status();
  assert.equal(status.runs[0].phase,'completed');
  assert.equal(status.lastActivityAt,new Date(f.now).toISOString());
  assert.equal(f.experiences.size,1);
  assert.match([...f.experiences.values()][0].text,/暂不行动/);
  assert.equal(status.intents.length,0);
});
test('ordinary intentions never change dice probability or force their preferred time', async () => {
  const f=fake();await f.initialize({probability:0});f.finishing();await f.runtime.tick();
  await f.runtime.intents.change('one',{...thought(),preferredAt:new Date(f.now+60000).toISOString()});
  f.now+=60000;await f.runtime.tick();
  assert.equal(f.requests.length,0);assert.equal((await f.runtime.status()).lastActivityAt,null);
});
test('a current-session explicit timed agreement bypasses dice and sleep only once', async () => {
  const f=fake();await f.initialize({probability:0,sleep:[{start:'09:00',end:'18:00'}]});f.finishing();await f.runtime.tick();
  await f.runtime.intents.change('one',{...thought(),kind:'agreement',source:'conversation',evidence:'对方明确说两分钟后提醒',dueAt:new Date(f.now+120000).toISOString()});
  f.now+=60000;await f.runtime.tick();assert.equal(f.requests.length,0);
  f.now+=60000;await f.runtime.tick();await f.runtime.idle();assert.equal(f.requests.length,1);
  f.now+=60000;await f.runtime.tick();assert.equal(f.requests.length,1);
  assert.equal((await f.runtime.status()).runs[0].trigger,'agreement');
});
test('sleep boundaries stop new ordinary opportunities without aborting an already running round', async () => {
  const f=fake();await f.initialize({sleep:[{start:'10:02',end:'11:00'}]});f.waiting();await f.runtime.tick();
  f.now+=60000;await f.runtime.tick();await f.flush();assert.equal(f.requests.length,1);
  f.now+=60000;await f.runtime.tick();assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].signal!.aborted,false);
  await f.runtime.yieldToUser();
  f.now+=60000;await f.runtime.tick();assert.equal(f.requests.length,1);
  assert.equal((await f.runtime.status()).lastActivityAt,null);
});
test('host admission rejection never becomes a no-action success or an automatic replay', async () => {
  const f=fake();await f.initialize();f.model(async()=>{throw Error('该会话正在回复，请稍候')});await f.runtime.tick();
  f.now+=60000;await f.runtime.tick();await f.runtime.idle();
  assert.equal((await f.runtime.status()).runs[0].phase,'busy');
  assert.equal(f.experiences.size,0);
  await f.runtime.tick();assert.equal(f.requests.length,1);
});
test('genuine errors, empty output and externally canceled work cannot masquerade as quiet completion', async () => {
  for(const mode of ['error','empty','cancel']) {
    const f=fake();await f.initialize();
    if(mode==='error')f.model(async()=>{throw Error('Model failed')});
    else if(mode==='empty')f.model(async()=> '');else f.waiting();
    await f.runtime.manualWake();await f.flush();
    if(mode==='cancel')await f.runtime.yieldToUser();else await f.runtime.idle();
    assert.notEqual((await f.runtime.status()).runs[0].phase,'completed');
    assert.equal((await f.runtime.status()).lastActivityAt,null);
    assert.ok([...f.experiences.values()].every(x=>x.outcome!=='succeeded'));
  }
});
test('switching sessions cancels own old run and never moves its records to the new session', async () => {
  const f=fake();await f.initialize();f.waiting();await f.runtime.manualWake();await f.flush();
  f.select('two');await f.runtime.tick();await f.runtime.idle();
  assert.equal(f.requests[0].signal!.aborted,true);
  assert.equal((await f.runtime.status()).runs.length,0);
  assert.ok([...f.experiences.keys()].every(key=>key.startsWith('one:')));
});
test('polling without an existing session does not create one', async () => {
  const f=fake();await f.initialize();f.select(null);await f.runtime.tick();await f.runtime.status();
  assert.equal(f.currentCalls,0);assert.equal(f.requests.length,0);
});
test('stop cancels the instance and prevents new jobs and writes', async () => {
  const f=fake();await f.initialize();f.waiting();await f.runtime.manualWake();await f.flush();
  f.controller.abort(Error('plugin disabled'));await f.runtime.idle();
  assert.equal(f.requests[0].signal!.aborted,true);
  await assert.rejects(f.runtime.manualWake(),/停止/);
  await f.runtime.tick();assert.equal(f.requests.length,1);
});
test('missed agreements from an inactive session are left for the next ordinary judgment', async () => {
  const f=fake();await f.initialize({probability:0});f.finishing();
  await f.runtime.intents.change('one',{...thought(),kind:'agreement',source:'conversation',evidence:'过去约定',dueAt:new Date(f.now-1000).toISOString()});
  await f.runtime.tick();f.now+=60000;await f.runtime.tick();assert.equal(f.requests.length,0);
  assert.equal((await f.runtime.intents.list('one')).length,1);
});
test('weekly sleep gates ordinary scheduling by bedtime day and keeps timed agreements available', async () => {
  const f=fake();f.now=Date.parse('2026-11-06T22:59:00+08:00');
  await f.initialize({sleep:[{startDay:1,endDay:5,start:'23:00',end:'07:00'}]});f.finishing();await f.runtime.tick();
  f.now+=60000;await f.runtime.tick();await f.runtime.idle();assert.equal(f.requests.length,0);
  f.now=Date.parse('2026-11-07T06:00:00+08:00');await f.runtime.tick();assert.equal(f.requests.length,0);
  await f.runtime.intents.change('one',{...thought(),kind:'agreement',source:'conversation',evidence:'周五入睡后跨午夜的明确约定',dueAt:new Date(f.now+60000).toISOString()});
  f.now+=60000;await f.runtime.tick();await f.runtime.idle();assert.equal(f.requests.length,1);
  f.now=Date.parse('2026-11-07T07:00:00+08:00');await f.runtime.tick();await f.runtime.idle();assert.equal(f.requests.length,2);
  f.now=Date.parse('2026-11-07T23:00:00+08:00');await f.runtime.tick();await f.runtime.idle();assert.equal(f.requests.length,3);
  f.runtime.stop();
});

test('unconfirmed prior instance is recorded as uncertain and never replayed automatically', async () => {
  const f=fake();await f.initialize({probability:0});f.waiting();await f.runtime.manualWake();await f.flush();
  f.runtime.stop();await f.runtime.idle();
  const restarted=new Autonomy(f.ctx,{now:()=>f.now,random:()=>0.5,timers:false});await restarted.initialize();
  await restarted.configure({...f.runtime.config,enabled:true,probability:0},restarted.configRevision);
  await restarted.tick();
  assert.equal(f.requests.length,1);
  assert.equal((await restarted.status()).runs[0].phase,'uncertain');
  assert.ok([...f.experiences.values()].some(x=>x.outcome==='pending'));
  restarted.stop();
});
test('unknown finish IDs and foreign sessions cannot complete a pending job', async () => {
  const f=fake();await f.initialize();f.waiting();const job=await f.runtime.manualWake();await f.flush();
  await assert.rejects(f.runtime.finish({runId:job.jobId,decision:'no_action',reason:'wrong'},{id:'two',permission:'full',origin:{plugin:'autonomy',action:'自主唤起'}}),/只用于/);
  assert.equal(f.experiences.size,0);await f.runtime.yieldToUser();
});
test('intentional no-action resets dynamic probability; missed dice does not keep postponing the clock', async () => {
  const f=fake();await f.initialize({mode:'adaptive',probability:1,recentMultiplier:0,distantMinutes:60});f.finishing();
  await f.runtime.manualWake();await f.runtime.idle();
  const at=(await f.runtime.status()).lastActivityAt;
  assert.equal((await f.runtime.status()).probability,0);
  await f.runtime.tick();f.now+=60000;await f.runtime.tick();
  assert.equal(f.requests.length,1);assert.equal((await f.runtime.status()).lastActivityAt,at);
});

test('a due agreement queues without interrupting the running judgment and executes after it releases', async () => {
  const f=fake();await f.initialize({probability:0});await f.runtime.tick();f.waiting();
  await f.runtime.intents.change('one',{...thought(),kind:'agreement',source:'conversation',evidence:'明确的两分钟提醒',dueAt:new Date(f.now+120000).toISOString()});
  await f.runtime.manualWake();await f.flush();f.now+=120000;await f.runtime.tick();await f.flush();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].signal!.aborted,false);
  assert.equal((await f.runtime.status()).queued.length,1);
  f.finishing();await f.runtime.yieldToUser();await f.runtime.idle();
  assert.equal(f.requests.length,2);assert.equal((await f.runtime.status()).runs[0].trigger,'agreement');
});

test('an acknowledged decision with failed final state write recovers once without rerunning the model', async () => {
  const f=fake();await f.initialize({probability:0});f.finishing();
  f.failWrite((key,data)=>key==='activity'&&data.runs.some((r:any)=>r.phase==='completed'));
  await f.runtime.manualWake();await f.runtime.idle();
  assert.equal((await f.runtime.status()).runs[0].phase,'settling');
  assert.equal(f.requests[0].signal!.aborted,true,'pending result persistence must stop further actions');
  assert.equal(f.experiences.size,1);
  f.failWrite(null);await f.runtime.tick();
  assert.equal((await f.runtime.status()).runs[0].phase,'completed');
  assert.equal(f.requests.length,1);assert.equal(f.experiences.size,1);
});

test('a user cancellation during durable finish does not overwrite the actual decision with failure', async () => {
  const f=fake();await f.initialize();f.finishing();
  const original=f.ctx.memory.recordExperience;
  let entered!:()=>void, release!:()=>void;
  const reached=new Promise<void>(resolve=>entered=resolve);
  const gate=new Promise<void>(resolve=>release=resolve);
  f.ctx.memory.recordExperience=async (session,input)=>{entered();await gate;return original(session,input)};
  await f.runtime.manualWake();await reached;
  const stopping=f.runtime.yieldToUser();release();await stopping;
  assert.equal((await f.runtime.status()).runs[0].phase,'completed');
  assert.equal(f.experiences.size,1);
  assert.equal([...f.experiences.values()][0].outcome,'succeeded');
});
