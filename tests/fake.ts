import type { Context, MemoryAPI, SessionQueuedRun, ExperienceInput } from 'whalelife';
import { setImmediate } from 'node:timers/promises';
import { SessionQueue } from '../../whalelife/core/session-queue.ts';
import { Autonomy } from '../src/runtime.ts';
import { defaults } from '../src/config.ts';

export function fake() {
  let now = Date.parse('2026-10-31T10:00:00+08:00'), revision = 0;
  const documents = new Map<string, { revision: string; data: any }>();
  const experiences = new Map<string, ExperienceInput>();
  const events = new Map<string, ((x: any) => unknown)[]>();
  const controller = new AbortController();
  let selected: string | null = 'one', currentCalls = 0;
  let model: (input: SessionQueuedRun) => Promise<string> = async () => { throw Error('No fake model configured'); };
  let recordingFailure = false;
  let writeFailure: ((key: string, data: any) => boolean) | null = null;
  const requests: SessionQueuedRun[] = [], submissions: SessionQueuedRun[] = [];
  const queue = new SessionQueue(new Set());
  const scope = {};
  const memory = {
    readSession: async () => [],
    excludeInputs: async () => ({ excluded: 0 }),
    readDocument: async (session: string, key: string) => structuredClone(documents.get(`${session}:${key}`) ?? { revision: null, data: null }),
    saveDocument: async (session: string, input: any) => {
      controller.signal.throwIfAborted();
      const id = `${session}:${input.key}`, existing = documents.get(id);
      if (input.revision !== (existing?.revision ?? null)) throw Error('文档已变更');
      if (writeFailure?.(input.key, input.data)) throw Error('Injected write failure');
      const value = { revision: String(++revision), data: structuredClone(input.data) };
      documents.set(id, value); return structuredClone(value);
    },
    recordExperience: async (session: string, input: ExperienceInput) => {
      controller.signal.throwIfAborted();
      if (recordingFailure) throw Error('Injected recording failure');
      const key = `${session}:${input.event_id}:${input.outcome}`;
      if (!experiences.has(key)) experiences.set(key, structuredClone(input));
      return { id: key, kind: 'episode', ...input, source: 'autonomy', ts: new Date(now).toISOString() };
    },
  } as unknown as MemoryAPI;
  const ctx = {
    memory, signal: controller.signal,
    logger: { info(){},warn(){},error(){},debug(){},log(){} },
    config: { read: async () => ({}), save: async () => {} },
    effect: (f: () => unknown) => f(),
    on: (name: string, f: (x: any) => unknown) => { const list = events.get(name) ?? []; list.push(f); events.set(name,list); return () => {}; },
    sessions: {
      list: async () => selected ? [{ id: selected, name: selected }] : [],
      current: async () => { currentCalls++; if (!selected) throw Error('Must not create session'); return selected; },
      run: async () => { throw Error('Persistent input must never be used for autonomy'); },
      runTransient: async () => { throw Error('Busy-rejecting input must never be used for autonomy'); },
      enqueueTransient: async (input: SessionQueuedRun) => {
        submissions.push(input);
        return queue.submit(input.sessionId!, AbortSignal.any([controller.signal, input.signal!]), async () => {
          requests.push(input); return model(input);
        }, { wait: true, scope, key: input.key, priority: input.priority, beforeRun: input.beforeRun });
      },
    },
  } as unknown as Context;
  const runtime = new Autonomy(ctx, { now: () => now, random: () => 0.1, timers: false });
  return {
    ctx, runtime, documents, experiences, requests, submissions, controller,
    flush: () => setImmediate(),
    hold(session = 'one') {
      let release!: () => void;
      const gate = new Promise<void>(resolve => release = resolve);
      const done = queue.submit(session, controller.signal, () => gate, { wait: true });
      return { release, done };
    },
    get now() { return now; }, set now(value: number) { now = value; },
    select(id: string | null) { selected = id; }, get currentCalls() { return currentCalls; },
    model(fn: typeof model) { model = fn; },
    failRecord(value: boolean) { recordingFailure = value; }, failWrite(fn: typeof writeFailure) { writeFailure = fn; },
    async emit(name: string, event: unknown) { for (const f of events.get(name) ?? []) await f(event); },
    async initialize(overrides: Record<string, unknown> = {}) {
      await runtime.initialize();
      await runtime.configure({ ...defaults, enabled: true, intervalMinutes: 1, probability: 1, ...overrides }, runtime.configRevision);
    },
    finishing(decision: 'no_action'|'acted' = 'no_action') {
      model = async input => {
        const runId = /本轮ID：([^\n]+)/.exec(input.text)![1];
        await runtime.finish({ runId, decision, reason: '本次选择安静，暂不做其他事情' }, {
          id: input.sessionId, permission: 'full', signal: input.signal,
          origin: { plugin: 'autonomy', platform: '自主性', action: '自主唤起' },
        });
        input.signal!.throwIfAborted(); return '';
      };
    },
    waiting() {
      model = input => new Promise((_, reject) => {
        if(input.signal!.aborted) reject(input.signal!.reason);
        else input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
      });
    },
  };
}
export const thought = (requestId = 'create-1') => ({ action: 'remember', requestId, kind: 'thought', text: '明天想写日记', source: 'self', evidence: '自己形成的打算，不是对别人的约定' });
