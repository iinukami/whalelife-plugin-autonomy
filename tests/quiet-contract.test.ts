import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostFixture } from './helpers.ts';

test('explicit persisted finish can stop its own full session through the public signal without a final chat reply', async t => {
  const { app, sessionId } = await hostFixture(t, `
    export function apply(ctx) {
      let active;
      ctx.tools.register({name:'probe_finish', description:'明确结束本次判断', schema:{reason:{type:'string'}}, danger:'safe',
        run: async (args, session) => {
          if (!active || session.id !== active.id || session.origin?.plugin !== 'probe') throw Error('Not this round');
          await ctx.memory.recordExperience(session.id, {event_id:'round-1', outcome:'succeeded', text:'自主判断结束：暂不行动。原因：'+args.reason, occurred_at:new Date().toISOString(), origin:{platform:'自主',action:'判断结束'}});
          active.finished = true;
          active.controller.abort(Error('explicit-finish'));
          return {finished:true};
        }});
      ctx.provide('probe', {run: async id => {
        active = {id, controller:new AbortController(), finished:false};
        try { await ctx.sessions.run({sessionId:id,text:'插件触发的自主判断，不是人类发言。',origin:{platform:'自主',action:'唤起'},signal:active.controller.signal}); }
        catch(error) { if(!active.finished || !active.controller.signal.aborted || ctx.signal.aborted) throw error; }
        return {finished:active.finished};
      }});
    }
  `);
  let requests = 0;
  app.llm.chat = async () => {
    requests++;
    return {text:'', toolCalls:[{id:'finish-1',name:'probe_finish',arguments:'{"reason":"目前选择安静一会儿"}'}],usage:{prompt_tokens:10,completion_tokens:5}};
  };
  const result = await app.runtime.services.get('probe').value.run(sessionId);
  assert.deepEqual(result, {finished:true});
  assert.equal(requests, 1);
  const rows = await app.memory.readSession(sessionId);
  assert.equal(rows.filter((r:any)=>r.role==='assistant').length, 0);
  const tool = rows.find((r:any)=>r.type==='tool' && r.name==='probe_finish');
  assert.equal(tool?.ok, true, JSON.stringify(rows));
  assert.ok(rows.some((r:any)=>JSON.stringify(r).includes('目前选择安静一会儿')));
  assert.equal(app.sessions.locks.size, 0);
  const state = await app.memoryEngine.state(sessionId);
  assert.ok(JSON.stringify(state).includes('自主判断结束'));
});
