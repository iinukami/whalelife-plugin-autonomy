import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { hostFixture, project } from './helpers.ts';

async function fixture(t: Parameters<typeof hostFixture>[0]) {
  const f = await hostFixture(t, undefined, 'autonomy', project);
  const url = `http://127.0.0.1:${f.app.web.server.address().port}`;
  const login = await fetch(url + '/api/login', { method: 'POST', body: '{}' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = async (action: string) => {
    const res = await fetch(url + '/plugins/autonomy/state', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, session: f.sessionId }),
    });
    const value = await res.json(); assert.equal(res.status, 202, JSON.stringify(value)); return value;
  };
  const service = () => f.app.runtime.services.get('autonomy')!.value;
  const completed = async (id: string) => {
    for (let n = 0; n < 300; n++) {
      const state = await service().status();
      const run = state.runs.find((r: any) => r.id === id);
      if (run && !state.running && !state.queued.length) return { state, run };
      await delay(20);
    }
    throw Error('Autonomy did not release its execution slot');
  };
  let mode = 'finish', count = 0, observed: (() => void) | undefined, collectOnFinish = false;
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    count++; observed?.();
    requests.push({ mode, runIds: [...JSON.stringify(body.messages).matchAll(/本轮ID：([a-f0-9-]+)/g)].map(m => m[1]),
      lastTool: body.messages.filter((m: any) => m.role === 'tool').at(-1)?.content });
    if (mode === '429' || mode === '500') {
      res.writeHead(Number(mode), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic isolated provider failure' } })); return;
    }
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    if (mode === 'hold') return;
    if (collectOnFinish) {
      await delay(0);
      (globalThis as any).gc();
      await delay(0);
    }
    const runId = /本轮ID：([a-f0-9-]+)/.exec(JSON.stringify(body.messages))![1];
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'finish-' + count, type: 'function',
      function: { name: 'autonomy_finish', arguments: JSON.stringify({ runId, decision: 'no_action', reason: '故障恢复后独立请求的一轮，当前无须行动' }) } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
  });
  f.close.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const actualChat = Object.getPrototypeOf(f.app.llm).chat.bind(f.app.llm);
  // Actual host HTTP/SSE implementation, pointed only at the owned loopback server.
  f.app.llm.chat = (options: any) => actualChat({ ...options, provider: {
    ...options.provider, base_url: baseUrl, api_key: 'synthetic', proxy: '', timeout_seconds: 1,
  } });
  return { ...f, request, completed, service, requests, collectOnFinish: () => collectOnFinish = true, setMode: (next: string) => mode = next,
    onRequest: (callback: () => void) => observed = callback, get count() { return count; } };
}

test('queued autonomous finish survives host garbage collection without another model request', { timeout: 15000, skip: typeof (globalThis as any).gc !== 'function' }, async t => {
  const f = await fixture(t); f.collectOnFinish();
  const next = await f.request('wake'), after = await f.completed(next.jobId);
  assert.equal(after.run.phase, 'completed');
  assert.equal(f.count, 1, JSON.stringify(f.requests));
});

for (const mode of ['429', '500', 'disconnect', 'hold']) {
  test(`real HTTP ${mode} failure releases the child round, does not retry, and a fresh wake recovers`, { timeout: 20000 }, async t => {
    const f = await fixture(t); f.setMode(mode);
    const first = await f.request('wake'), failed = await f.completed(first.jobId);
    assert.equal(failed.run.phase, 'failed', JSON.stringify(failed.run));
    assert.equal(failed.run.decision, undefined);
    assert.equal(failed.state.lastActivityAt, null);
    assert.equal(f.count, 1);
    assert.equal(f.app.sessions.locks.size, 0);
    await delay(1100); assert.equal(f.count, 1, 'idle recovery must not replay the HTTP call');
    f.setMode('finish');
    const next = await f.request('wake'), recovered = await f.completed(next.jobId);
    assert.equal(recovered.run.phase, 'completed'); assert.equal(recovered.run.decision, 'no_action');
    assert.equal(f.count, 2, JSON.stringify(f.requests));
    assert.equal(f.app.sessions.locks.size, 0);
    const memory = await f.app.memoryEngine.state(f.sessionId);
    assert.equal(memory.records.filter((r: any) => r.text?.startsWith('自主判断结束')).length, 1);
  });
}

test('ten real socket cancellations and child restarts release locks and never replay interrupted requests', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const timings: number[] = [];
  for (let i = 0; i < 10; i++) {
    let entered!: () => void;
    const requestStarted = new Promise<void>(resolve => entered = resolve);
    f.setMode('hold'); f.onRequest(entered);
    const beforeCount = f.count;
    const first = await f.request('wake'); await requestStarted;
    const start = Date.now();
    await f.app.runtime.action('autonomy', 'stop');
    for (let n = 0; n < 100 && f.app.sessions.locks.size; n++) await delay(20);
    assert.equal(f.app.sessions.locks.size, 0);
    await f.app.runtime.action('autonomy', 'start');
    f.setMode('finish');
    const next = await f.request('wake'), after = await f.completed(next.jobId);
    timings.push(Date.now() - start);
    assert.equal(after.run.phase, 'completed');
    assert.equal(after.state.runs.find((r: any) => r.id === first.jobId).phase, 'uncertain');
    assert.equal(f.count, beforeCount + 2, JSON.stringify(f.requests));
    assert.equal(f.app.runtime.records.get('autonomy').status, 'active');
  }
  t.diagnostic('stop/start/recover durations ms: ' + timings.join(', '));
});
