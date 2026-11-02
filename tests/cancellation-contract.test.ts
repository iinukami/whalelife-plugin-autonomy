import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { hostFixture } from './helpers.ts';

test('generic public queued-session signal still cancels after host GC', { timeout: 15000, skip: typeof (globalThis as any).gc !== 'function' }, async t => {
  const f = await hostFixture(t, `
    export async function apply(ctx) {
      let controller, task;
      ctx.provide('cancel-probe', {
        async start(sessionId) {
          controller = new AbortController();
          task = ctx.sessions.enqueueTransient({ sessionId, text: 'isolated cancellation contract', signal: controller.signal }).catch(() => {});
        },
        cancel() { controller.abort(Error('explicit isolated cancellation')); return controller.signal.aborted; },
      });
      ctx.effect(() => () => { controller?.abort(); });
    }
  `);
  let entered!: () => void, release!: () => void, hostSignal!: AbortSignal;
  const started = new Promise<void>(resolve => entered = resolve);
  const gate = new Promise<void>(resolve => release = resolve);
  f.close.push(release);
  f.app.llm.chat = async (input: any) => {
    hostSignal = input.signal; entered(); await gate;
    input.signal.throwIfAborted();
    return { text: 'isolated cleanup response', toolCalls: [], usage: {} };
  };
  const service = f.app.runtime.services.get('cancel-probe')!.value;
  await service.start(f.sessionId); await started;
  for (let i = 0; i < 3; i++) { await delay(0); (globalThis as any).gc(); }
  assert.equal(await service.cancel(), true, 'plugin controller aborted');
  for (let i = 0; i < 25 && !hostSignal.aborted; i++) await delay(20);
  assert.equal(hostSignal.aborted, true, 'host model signal lost the public cancellation after garbage collection');
});
