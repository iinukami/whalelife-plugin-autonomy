/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context, OptionalService, ToolSession } from 'whalelife';
import { type Intents, type QQDeliveryRef, text } from './storage.ts';

type State = 'in_progress' | 'incomplete' | 'unknown' | 'sent' | 'dismissed';
interface Counts {
  outcome: string; scope: string; totalParts: number | null; sentParts: number | null;
  unknownParts: number | null; notSentParts: number | null;
}
interface Item extends QQDeliveryRef {
  sessionId: string; userId: string; revision: string; state: State;
  createdAt: string; updatedAt: string; canResume: boolean; blockedReason?: string;
  delivery: Counts; parts?: { text: string; state: 'sent' | 'not_sent' | 'unknown' }[];
}
type Key = { sessionId: string; deliveryId: string };
type DraftKey = Key & { accountId: string };
type DraftTarget = DraftKey & { userId: string };
type DraftPart = { index: number; text: string };
type DraftProgress = { total: number | null; sent: number | null; notSent: number | null; unknown: number | null };
type DraftResult = { status: 'unavailable' } | (DraftTarget & { status: 'claimed'; expiresAt: string; parts: DraftPart[] });
type Operation = Key & { expectedRevision: string };
interface Failure { status: 'blocked'; confirmed: false; reason: string }
interface QQStatus { state?: string; binding?: { state?: string; sessionId?: string } }
interface QQ {
  textDeliveryApiVersion: string; textDeliveryResumeSupported: boolean;
  temporaryDraftApiVersion?: string;
  claimTemporaryDraft?(key: DraftKey): Promise<DraftResult>;
  releaseTemporaryDraft?(key: DraftKey): Promise<{ status: 'released' | 'unavailable' }>;
  getSelfId?(): string | null | Promise<string | null>;
  status?(): QQStatus | Promise<QQStatus>;
  listTextDeliveries(input: { sessionId: string; limit: number; cursor?: string }): Promise<Failure | { status: 'ok'; items: Item[]; nextCursor?: string }>;
  textDelivery(input: Key): Promise<Failure | { status: 'ok'; item: Item }>;
  resumeTextDelivery(input: Operation, options: { signal: AbortSignal }): Promise<ActionResult>;
  dismissTextDelivery(input: Operation): Promise<ActionResult>;
}
type ActionResult = Failure | { status: 'sent' | 'dismissed' | 'incomplete'; confirmed: boolean; item?: Item; receiptUnavailable?: boolean };
type Binding = OptionalService<QQ>;
type Args = Record<string, unknown>;
type Candidate = { intentId: string; item: Item; reviewed?: string; attempted?: string };

const blocked = (reason: string): Failure => ({ status: 'blocked', confirmed: false, reason });
const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\x00-\x1f\x7f]/u.test(s);
const refKey = (ref: QQDeliveryRef) => JSON.stringify([ref.accountId, ref.deliveryId]);
const qqAccount = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
const validDraftKey = (key: DraftKey) => id(key.sessionId) && qqAccount(key.accountId) && /^delivery_[a-f0-9]{64}$/.test(key.deliveryId);
function draftProgressKnown(p: DraftProgress): p is { total: number; sent: number; notSent: number; unknown: 0 } {
  return p.total !== null && Number.isSafeInteger(p.total) && p.total <= 64 && p.sent !== null && Number.isSafeInteger(p.sent) &&
    p.sent >= 0 && p.notSent !== null && Number.isSafeInteger(p.notSent) && p.notSent > 0 && p.unknown === 0 && p.total === p.sent + p.notSent;
}
function draftCaller(session: ToolSession, target: DraftTarget) {
  if (session.channel === 'qq') return session.origin?.plugin === 'qq' && session.account === target.accountId &&
    session.peer === 'direct:' + target.userId && session.sender === target.userId;
  return session.channel === 'plugin' && session.account === 'autonomy' && session.peer === target.sessionId &&
    session.origin?.plugin === 'autonomy' && session.origin.action === '自主唤起';
}
type RecoveryWindow = { offlineAt: number; onlineAt: number };
const sameRef = (a: QQDeliveryRef, b: QQDeliveryRef) => a.accountId === b.accountId && a.deliveryId === b.deliveryId;
const abandonReasons = {
  topic_changed: '对方已经转到新话题，继续原话会打断现在的交流。',
  already_addressed: '原来想说的事已经在后续交流中说清楚了。',
  no_longer_relevant: '时间或情况已经变化，原先的话不再合适。',
  user_requested_stop: '对方已经表示不希望继续这段话。',
  reconsidered: '我重新考虑了原来的表达，决定不再继续说。',
};
function valid(item: Item, session: string) {
  return item && item.sessionId === session && id(item.accountId) && id(item.deliveryId) &&
    id(item.userId) && id(item.revision) && Number.isFinite(Date.parse(item.createdAt)) &&
    ['in_progress','incomplete','unknown','sent','dismissed'].includes(item.state);
}
function resumable(item: Item) {
  return item.state === 'incomplete' && item.canResume === true && item.delivery?.unknownParts === 0 &&
    typeof item.delivery.notSentParts === 'number' && item.delivery.notSentParts > 0;
}
function visible(item: Item, session: ToolSession) {
  return session.channel !== 'qq' || (session.account === item.accountId && session.peer === 'direct:' + item.userId);
}
function confirmedSnapshot(item: Item) {
  const { state, delivery } = item;
  return state === 'sent' && delivery?.scope === 'action' && delivery.outcome === 'sent' &&
    delivery.unknownParts === 0 && delivery.totalParts !== null && delivery.totalParts > 0 && delivery.sentParts === delivery.totalParts;
}
function summary(item: Item, supported: boolean) {
  return { state: item.state, revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt,
    canResume: supported && resumable(item), blockedReason: item.blockedReason ?? (!supported ? 'host_blocked' : undefined),
    userId: item.userId, delivery: item.delivery };
}

export class QqContinuation {
  private ctx: Context;
  private intents: Intents;
  private selected: () => Promise<string | null>;
  private now: () => number;
  private onRead?: (session: ToolSession, safeOutcome?: string) => void;
  private binding?: Binding;
  private supportsResume = false;
  private offline = new Set<string>();
  private recovered = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private snapshot?: { session: string; generation: number; next: number; candidates: Candidate[] };
  private generation = 0;
  private link?: { account: string; offlineAt: number | null; windows: RecoveryWindow[] };
  private connection?: { session: string; account: string | null; next: number };
  private refreshPosted = false;
  private lastWarning = -Infinity;
  private pendingClosures = new Map<string, { session: string; ref: QQDeliveryRef; outcome: 'sent' | 'dismissed'; keepConfirmation: boolean }>();

  constructor(ctx: Context, intents: Intents, selected: () => Promise<string | null>, now = Date.now,
    onRead?: (session: ToolSession, safeOutcome?: string) => void) {
    this.ctx = ctx; this.intents = intents; this.selected = selected; this.now = now; this.onRead = onRead;
  }
  private serial<T>(fn: () => Promise<T>) {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  start() {
    if (typeof this.ctx.optional !== 'function' || typeof this.ctx.tools.registerTransient !== 'function') return;
    this.ctx.optional<QQ>('qq', binding => {
      if (!binding) return;
      try {
        const service = binding.service;
        if (service.textDeliveryApiVersion !== '1.0.0' || typeof service.textDeliveryResumeSupported !== 'boolean' ||
            !(['listTextDeliveries','textDelivery','resumeTextDelivery','dismissTextDelivery'] as const)
              .every(key => typeof service[key] === 'function')) return;
        this.register(binding);
        binding.effect(() => this.ctx.on<{ accountId?: string; state?: string }>('plugin:qq:connection-changed', event => {
          if (this.binding !== binding || binding.signal.aborted) return;
          this.connection = undefined;
          this.observeConnection(event?.accountId, event?.state);
          this.invalidate();
        }));
        binding.effect(() => this.ctx.on('plugin:qq:text-delivery-changed', () => this.invalidate()));
        const supportsResume = service.textDeliveryResumeSupported;
        binding.effect(() => {
          this.binding = binding; this.supportsResume = supportsResume; this.invalidate();
          return () => { if (this.binding === binding) {
            this.binding = undefined; this.snapshot = undefined; this.supportsResume = false;
            this.link = undefined; this.connection = undefined;
            this.offline.clear(); this.recovered.clear();
          } };
        });
      } catch { this.ctx.logger.warn('QQ 文字续发接口未接入，其他自主行为继续。'); }
    });
  }
  // Event callbacks only post a read. QQ may still hold its delivery lock when emitting.
  private invalidate() {
    this.generation++;
    if (this.refreshPosted || !this.binding) return;
    this.refreshPosted = true;
    setImmediate(() => {
      this.refreshPosted = false;
      const binding = this.binding;
      if (!binding || binding.signal.aborted) return;
      void this.selected().then(session => { if (session) return this.check(session); }).catch(() => {});
    });
  }
  private warn() {
    if (this.now() - this.lastWarning < 60_000) return;
    this.lastWarning = this.now();
    this.ctx.logger.warn('未能核对或保存部分 QQ 续发进度，将在后续检查时补读。');
  }
  private async pages(service: QQ, session: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const items = new Map<string, Item>();
      let cursor: string | undefined;
      for (let page = 0; page < 11; page++) { // QQ retains at most 512 pending IDs.
        signal.throwIfAborted();
        const result = await service.listTextDeliveries({ sessionId: session, limit: 50, ...(cursor ? { cursor } : {}) });
        if (result.status !== 'ok') {
          if (result.reason === 'stale_revision' && cursor) break;
          return;
        }
        for (const item of result.items) {
          if (!valid(item, session)) throw Error('QQ 投递记录格式不符');
          items.set(refKey(item), item);
        }
        if (!result.nextCursor) return items;
        cursor = result.nextCursor;
      }
    }
  }
  private async scan(session: string, binding: Binding, force = false) {
    binding.signal.throwIfAborted();
    const generation = this.generation, previous = this.snapshot;
    if (!force && previous?.session === session && previous.generation === generation && previous.next > this.now()) return;
    if (previous && previous.session !== session) { this.offline.clear(); this.recovered.clear(); }
    this.snapshot = { session, generation, next: this.now() + 30_000, candidates: [] };
    if (await this.selected() !== session) return;
    // A real QQ result can arrive during a local disk failure. Flush only its
    // bookkeeping, never the external operation, when storage becomes writable.
    for (const [intentId, closure] of this.pendingClosures) {
      if (closure.session !== session) continue;
      await this.intents.closeQQ(session, closure.ref, closure.outcome, closure.keepConfirmation);
      this.pendingClosures.delete(intentId);
    }
    const items = await this.pages(binding.service, session, binding.signal);
    if (!items || await this.selected() !== session) return;
    const thoughts = (await this.intents.list(session)).filter(i => i.qq);
    if (thoughts.some(i => i.state === 'settling')) await this.intents.settle(session);
    const linked = new Map(thoughts.filter(i => i.state === 'open').map(i => [refKey(i.qq!), i]));
    const confirmed = new Map((await this.intents.verifiedQQClosures(session)).map(ref => [refKey(ref), ref]));
    const candidates: Candidate[] = [];
    let canAdd = true;
    for (const [key, item] of items) {
      binding.signal.throwIfAborted();
      if (confirmed.has(key) || (item.state !== 'unknown' && item.state !== 'incomplete')) continue;
      let intent = linked.get(key);
      if (!intent) {
        if (!canAdd) continue;
        try { intent = await this.intents.linkQQ(session, item, item.createdAt); }
        catch { this.warn(); canAdd = false; continue; }
      }
      if (intent.state !== 'open') continue;
      // An unsuccessful attempt can advance QQ's revision. A new revision by
      // itself is not a new reason to wake; observe actual offline → usable.
      if (item.blockedReason === 'offline') {
        this.offline.add(intent.id); this.recovered.delete(intent.id);
      } else if (resumable(item) && this.offline.delete(intent.id)) this.recovered.add(intent.id);
      candidates.push({ intentId: intent.id, item, reviewed: intent.qq?.reviewedRevision, attempted: intent.qq?.attemptedRevision });
    }
    // A terminal item disappears from the index. Absence alone proves nothing.
    const missing = new Map([...linked].map(([key, intent]) => [key, intent.qq!]));
    for (const [key, ref] of confirmed) if (!missing.has(key)) missing.set(key, ref);
    const removable: QQDeliveryRef[] = [];
    for (const [key, ref] of missing) {
      binding.signal.throwIfAborted();
      if (items.has(key)) continue;
      const detail = await binding.service.textDelivery({ sessionId: session, deliveryId: ref.deliveryId });
      if (detail.status !== 'ok' || !valid(detail.item, session) || !sameRef(ref, detail.item)) continue;
      if (confirmedSnapshot(detail.item)) {
        if (confirmed.has(key)) removable.push(ref);
        else await this.intents.closeQQ(session, ref, 'sent');
      }
      if (detail.item.state === 'dismissed' && linked.get(key)?.qq?.abandonReason) await this.intents.closeQQ(session, ref, 'dismissed');
    }
    if (removable.length) await this.intents.forgetQQClosures(session, removable);
    binding.signal.throwIfAborted();
    const active = new Set(candidates.map(c => c.intentId));
    for (const key of this.offline) if (!active.has(key)) this.offline.delete(key);
    for (const key of this.recovered) if (!active.has(key)) this.recovered.delete(key);
    this.snapshot = { session, generation, next: this.now() + 30_000, candidates };
  }
  async check(session: string) {
    const binding = this.binding;
    if (!binding || binding.signal.aborted) return;
    if (this.connection && this.connection.session !== session) this.connection = undefined;
    await this.serial(() => this.scan(session, binding)).catch(() => {
      if (this.binding === binding && !binding.signal.aborted) {
        this.warn(); this.snapshot = { session, generation: this.generation, next: this.now() + 30_000, candidates: [] };
      }
    });
  }
  private observeConnection(account: unknown, state: unknown) {
    if (!qqAccount(account) || !['online', 'disconnected', 'connecting', 'offline'].includes(String(state))) return;
    if (this.link?.account !== account) this.link = { account, offlineAt: null, windows: [] };
    const link = this.link;
    if (state !== 'online') { link.offlineAt ??= this.now(); return; }
    if (link.offlineAt === null) return;
    link.windows.push({ offlineAt: link.offlineAt, onlineAt: this.now() });
    if (link.windows.length > 64) link.windows.shift();
    link.offlineAt = null;
  }
  recoveryWindows(account: string): readonly RecoveryWindow[] {
    return this.link?.account === account ? this.link.windows : [];
  }
  private draftBinding() {
    const b = this.binding;
    if (b && !b.signal.aborted && b.service.temporaryDraftApiVersion === '1.0.0' &&
        typeof b.service.claimTemporaryDraft === 'function' && typeof b.service.releaseTemporaryDraft === 'function' &&
        typeof b.service.getSelfId === 'function') return b;
  }
  supportsTemporaryDraft(): boolean { return Boolean(this.draftBinding()); }
  async readTemporaryDraft(session: ToolSession, target: DraftTarget, expected: DraftProgress): Promise<DraftPart[] | null> {
    try {
      const binding = this.draftBinding();
      if (!binding || session.permission === 'off' || !session.transientContext || session.id !== target.sessionId || !validDraftKey(target) ||
          !qqAccount(target.userId) || !draftCaller(session, target) || !draftProgressKnown(expected)) return null;
      const service = binding.service;
      const current = async () => await service.getSelfId!() === target.accountId &&
        await this.sessionId(session, binding) === target.sessionId && this.binding === binding &&
        !binding.signal.aborted && !session.signal?.aborted;
      if (!await current()) return null;
      const { sessionId, accountId, deliveryId } = target;
      const key = { sessionId, accountId, deliveryId };
      let result: DraftResult;
      try { result = await service.claimTemporaryDraft!(key); }
      finally {
        // QQ drops the text during claim. Clear its remaining marker even if
        // the response was lost; the transient tool owns the only returned copy.
        if (!binding.signal.aborted) {
          try { await service.releaseTemporaryDraft!(key); } catch { /* Marker expires at the provider. */ }
        }
      }
      if (!result || result.status !== 'claimed' || result.sessionId !== sessionId || result.accountId !== accountId ||
          result.deliveryId !== deliveryId || result.userId !== target.userId || typeof result.expiresAt !== 'string' ||
          !Array.isArray(result.parts) || result.parts.length !== expected.notSent || !await current() ||
          !(Date.parse(result.expiresAt) > this.now())) return null;
      // The QQ sender processes the original plan in order and stops at the
      // first failure. Accept precisely the unsent suffix, never confirmed text.
      const parts: DraftPart[] = [];
      for (const [i, part] of result.parts.entries()) {
        if (!part || part.index !== expected.sent + i + 1 || typeof part.text !== 'string' || !part.text.length) return null;
        parts.push({ index: part.index, text: part.text });
      }
      this.onRead?.(session);
      return parts;
    } catch { return null; }
  }
  async recoveryAccount(session: string, verify = false): Promise<string | null> {
    const binding = this.binding;
    if (!binding || binding.signal.aborted || !this.supportsResume) return null;
    if (await this.selected() !== session) {
      if (this.connection?.session === session) this.connection = undefined;
      return null;
    }
    if (this.binding !== binding || binding.signal.aborted) return null;
    const service = binding.service;
    if (typeof service.getSelfId !== 'function' || typeof service.status !== 'function') return null;
    if (!verify && this.connection?.session === session && this.connection.next > this.now()) return this.connection.account;
    const probe = this.connection = { session, account: null as string | null, next: Infinity };
    const read = async () => {
      try {
        const [account, status] = await Promise.all([service.getSelfId?.(), service.status?.()]);
        if (await this.selected() !== session || this.connection !== probe || binding.signal.aborted || !qqAccount(account)) return null;
        this.observeConnection(account, status?.state);
        if (status?.state === 'online' && status.binding?.state === 'ready' && status.binding.sessionId === session) probe.account = account;
        return probe.account;
      } catch { return null; }
      finally { probe.next = this.now() + (probe.account ? 30_000 : 5_000); }
    };
    // The scheduler only consumes the cache. Before starting a queued judgment
    // obtain a fresh connection and binding, irrespective of the previous read.
    const result = read();
    if (!verify) return null;
    return result;
  }
  private opportunities(session: string) {
    return this.snapshot?.session === session && this.supportsResume
      ? this.snapshot.candidates.filter(c => resumable(c.item) && c.reviewed !== c.item.revision &&
        (!c.attempted || this.recovered.has(c.intentId))) : [];
  }
  async ready(session: string) {
    return !!this.binding && !this.binding.signal.aborted && this.opportunities(session).length > 0;
  }
  async claim(session: string) {
    return this.serial(async () => {
      const binding = this.binding;
      if (!binding || binding.signal.aborted) return false;
      await this.scan(session, binding, true);
      const candidates = this.opportunities(session);
      for (const c of candidates) {
        binding.signal.throwIfAborted();
        await this.intents.reviewQQ(session, c.item, c.item.revision);
        this.recovered.delete(c.intentId);
        c.reviewed = c.item.revision;
      }
      return candidates.length > 0;
    }).catch(() => false);
  }
  private async sessionId(session: ToolSession, binding: Binding) {
    binding.signal.throwIfAborted();
    session.signal?.throwIfAborted();
    if (session.permission === 'off' || !id(session.id) || session.id !== await this.selected()) return;
    return session.id;
  }
  private async detail(sessionId: string, intentId: unknown, session: ToolSession, binding: Binding) {
    const intent = (await this.intents.list(sessionId)).find(i => i.id === intentId && i.state === 'open');
    if (!intent?.qq) return blocked('not_found');
    const result = await binding.service.textDelivery({ sessionId, deliveryId: intent.qq.deliveryId });
    if (result.status !== 'ok') return result;
    if (!valid(result.item, sessionId) || !sameRef(intent.qq, result.item) || !visible(result.item, session)) return blocked('not_found');
    return { ...result, attempted: intent.qq.attemptedRevision };
  }
  private register(binding: Binding) {
    const ctx = this.ctx;
    binding.effect(() => ctx.tools.registerTransient({
      name: 'autonomy_qq_expression', danger: 'safe', origin: { platform: '自主性', action: '查看未说完的 QQ 表达' },
      description: 'list 查看当前会话里还没说完的普通 QQ 文字。detail 用 intentId 查看原话、逐段回执和最新 revision，原话仅供当轮参考。根据新来信、过去时间和真实进度自主判断。送达确认不代表已读，断线不能推断对方态度。',
      schema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['list','detail'] }, intentId: { type: 'string' },
      } },
      run: async (args: Args, session) => {
        try {
          const content = await this.serial(async () => {
            const sessionId = await this.sessionId(session, binding);
            if (!sessionId) return blocked('session_changed');
            if (args.action === 'list') {
              await this.scan(sessionId, binding, true);
              return { status: 'ok', items: (this.snapshot?.candidates ?? []).filter(c => visible(c.item, session))
                .map(c => ({ intentId: c.intentId, ...summary(c.item, this.supportsResume) })) };
            }
            if (args.action !== 'detail' || !id(args.intentId)) return blocked('invalid_input');
            const detail = await this.detail(sessionId, args.intentId, session, binding);
            if (detail.status !== 'ok') return detail;
            if (await this.sessionId(session, binding) !== sessionId) return blocked('session_changed');
            if (detail.item.parts?.length) this.onRead?.(session);
            return { status: 'ok', item: { ...summary(detail.item, this.supportsResume), parts: detail.item.parts?.map(p => ({ state: p.state, text: p.text })) } };
          });
          return { content, receipt: null };
        } catch { return { content: blocked('unavailable'), receipt: null }; }
      },
    }));
    binding.effect(() => ctx.tools.register({
      name: 'autonomy_qq_decide', danger: 'full', origin: { platform: '自主性', action: '处理未说完的 QQ 表达' },
      description: '用当前会话念头的 intentId 和最新 revision 明确决定。resume 只续原话中确认未发的段；defer 保留念头；abandon 明确放弃，reason 填下列原因代码：topic_changed、already_addressed、no_longer_relevant、user_requested_stop 或 reconsidered。回执未知或续发受阻时保留念头，不改写重发，不循环尝试。只有 sent 且 confirmed=true 是全段确认发送。',
      schema: { type: 'object', additionalProperties: false, required: ['action','intentId','revision'], properties: {
        action: { type: 'string', enum: ['resume','defer','abandon'] }, intentId: { type: 'string' }, revision: { type: 'string' },
        reason: { type: 'string', maxLength: 140 },
      } },
      run: async (args: Args, session) => {
        try { return await this.serial(() => this.decide(args, session, binding)); }
        catch { return blocked('unavailable'); }
      },
    }));
  }
  private async decide(args: Args, session: ToolSession, binding: Binding) {
    if (session.permission !== 'full') return blocked('permission');
    const sessionId = await this.sessionId(session, binding);
    if (!sessionId) return blocked('session_changed');
    if (!['resume','defer','abandon'].includes(String(args.action)) || !id(args.intentId) || !id(args.revision)) return blocked('invalid_input');
    const pending = this.pendingClosures.get(args.intentId);
    if (pending?.session === sessionId) return blocked('settling');
    const detail = await this.detail(sessionId, args.intentId, session, binding);
    if (detail.status !== 'ok') return detail;
    const item = detail.item;
    if (item.revision !== args.revision) return blocked('stale_revision');
    const input = { sessionId, deliveryId: item.deliveryId, expectedRevision: item.revision };
    const signal = session.signal ? AbortSignal.any([binding.signal, session.signal]) : binding.signal;
    if (await this.sessionId(session, binding) !== sessionId) return blocked('session_changed');
    if (item.state !== 'incomplete' && item.state !== 'unknown') return blocked(item.state);
    if (args.action === 'defer') {
      await this.intents.reviewQQ(sessionId, item, item.revision);
      this.recovered.delete(args.intentId);
      this.invalidate(); this.onRead?.(session, '我决定暂缓续说，保留了这个念头。');
      return { status: 'deferred', confirmed: false };
    }
    let reason: string | undefined;
    if (args.action === 'abandon') {
      reason = typeof args.reason === 'string' && Object.hasOwn(abandonReasons, args.reason)
        ? abandonReasons[args.reason as keyof typeof abandonReasons] : undefined;
      if (!reason && !session.transientContext) {
        try { reason = text(args.reason, '放弃原因', 140); } catch { return blocked('invalid_reason'); }
      }
      if (!reason) return blocked('invalid_reason');
      await this.intents.prepareQQAbandon(sessionId, item, reason);
    } else if (item.revision === detail.attempted) {
      return blocked('already_attempted');
    } else if (!this.supportsResume) {
      return blocked('host_blocked');
    } else if (!resumable(item) || !item.parts?.length ||
        item.parts.some(part => part.state !== 'sent' && part.state !== 'not_sent')) {
      return blocked(item.blockedReason ?? 'not_resumable');
    }
    // Claim this particular opportunity before dispatch. A failed RPC can have
    // reached QQ; it must never turn into an automatic replay on reconnect.
    await this.intents.reviewQQ(sessionId, item, item.revision, true);
    this.recovered.delete(args.intentId);
    if (await this.sessionId(session, binding) !== sessionId) return blocked('session_changed');
    signal.throwIfAborted();
    let result: ActionResult;
    try {
      result = args.action === 'abandon' ? await binding.service.dismissTextDelivery(input)
        : await binding.service.resumeTextDelivery(input, { signal });
    } finally { this.invalidate(); }
    const terminal = result.status === 'sent' && result.confirmed === true ? 'sent'
      : result.status === 'dismissed' && args.action === 'abandon' ? 'dismissed' : undefined;
    if (terminal) {
      const note = terminal === 'sent' ? 'QQ 已确认原来没说完的话全部发送。' : '我明确放弃了继续这段 QQ 表达。' + reason;
      this.onRead?.(session, note);
      const keepConfirmation = result.status === 'sent' && (result.receiptUnavailable === true || !result.item);
      try { await this.intents.closeQQ(sessionId, item, terminal, keepConfirmation); }
      catch {
        this.pendingClosures.set(args.intentId, { session: sessionId, ref: { accountId: item.accountId, deliveryId: item.deliveryId },
          outcome: terminal, keepConfirmation });
        return { status: terminal, confirmed: terminal === 'sent', memoryPending: true };
      }
      return { status: terminal, confirmed: terminal === 'sent' };
    }
    this.onRead?.(session, '这次未取得全部发送确认，保留了未说完的念头。');
    return { status: result.status === 'blocked' ? 'blocked' : 'incomplete', confirmed: false,
      ...(result.status === 'blocked' ? { reason: result.reason } : {}) };
  }
}
