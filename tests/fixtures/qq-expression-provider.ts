import type { Context } from 'whalelife';

export function apply(ctx: Context) {
  const words = ['测试第一句。', '测试第二句。', '测试第三句。'];
  const accountId = '100001', deliveryId = 'synthetic-interrupted-reply';
  const createdAt = new Date().toISOString();
  let sessionId = '', revision = 1, online = false, updatedAt = createdAt;
  let state: 'incomplete' | 'unknown' | 'sent' | 'dismissed' | undefined;
  let resumeCalls = 0, dismissCalls = 0;
  const submitted: string[] = [], queries: string[] = [];
  const blocked = (reason: string) => ({ status: 'blocked', confirmed: false, reason });
  function notify() {
    ctx.emit('plugin:qq:text-delivery-changed', { accountId, sessionId, deliveryId,
      revision: String(revision), state: state === 'incomplete' ? 'delivery_failed' : state });
  }
  function changed() { revision++; updatedAt = new Date().toISOString(); notify(); }
  type Key = { sessionId: string; deliveryId: string; expectedRevision?: string };
  const matches = (key: Key) => key.sessionId === sessionId && key.deliveryId === deliveryId;
  function snapshot(details = false) {
    const parts = words.map((text, i) => {
      if (i === 0 || state === 'sent') return { text, state: 'sent', messageId: String(8001 + i) };
      return { text, state: state === 'unknown' && i === 1 ? 'unknown' : 'not_sent' };
    });
    const unknown = parts.filter(p => p.state === 'unknown').length;
    const sent = parts.filter(p => p.state === 'sent').length;
    return { accountId, userId: '200002', sessionId, deliveryId, direction: 'in', createdAt, updatedAt,
      revision: String(revision), state, canResume: state === 'incomplete' && online,
      ...(state === 'unknown' ? { blockedReason: 'unknown' } : !online ? { blockedReason: 'offline' } : {}),
      delivery: { outcome: sent === 3 ? 'sent' : 'partial', scope: 'action', totalParts: 3, sentParts: sent,
        unknownParts: unknown, notSentParts: 3 - sent - unknown, unattemptedParts: 3 - sent - unknown,
        readStatus: 'unknown', summary: '测试平台逐段回执' }, ...(details ? { parts } : {}) };
  }
  ctx.provide('qq', {
    textDeliveryApiVersion: '1.0.0', textDeliveryResumeSupported: true,
    listTextDeliveries(input: { sessionId: string }) {
      queries.push(input.sessionId);
      return { status: 'ok', items: input.sessionId === sessionId && (state === 'incomplete' || state === 'unknown') ? [snapshot()] : [] };
    },
    textDelivery(key: Key) { return state && matches(key) ? { status: 'ok', item: snapshot(true) } : blocked('not_found'); },
    resumeTextDelivery(key: Key, options: { signal: AbortSignal }) {
      resumeCalls++;
      options.signal.throwIfAborted();
      if (!matches(key) || String(revision) !== key.expectedRevision || state !== 'incomplete' || !online) return blocked('stale_revision');
      submitted.push(...words.slice(1)); state = 'sent'; changed();
      return { status: 'sent', confirmed: true, receiptUnavailable: true };
    },
    dismissTextDelivery(key: Key) {
      dismissCalls++;
      if (!matches(key) || String(revision) !== key.expectedRevision) return blocked('stale_revision');
      state = 'dismissed'; changed(); return { status: 'dismissed', confirmed: false, item: snapshot(true) };
    },
  });
  ctx.provide('qq-test', {
    outcome: () => ({ submitted, queries, resumeCalls, dismissCalls }),
    disconnect(originalSession: string, unknown: boolean, publish: boolean) {
      sessionId = originalSession; submitted.push(words[0]); state = unknown ? 'unknown' : 'incomplete'; online = false;
      if (publish) { ctx.emit('plugin:qq:connection-changed', { accountId, state: 'offline' }); changed(); notify(); }
    },
    reconnect() {
      online = true;
      ctx.emit('plugin:qq:connection-changed', { accountId, state: 'online' });
      ctx.emit('plugin:qq:connection-changed', { accountId, state: 'online' });
    },
  });
}
