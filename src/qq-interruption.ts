/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { MemoryEvent, ToolSession } from 'whalelife';
import { Documents, digest } from './storage.ts';

type Counts = { total: number; sent: number; notSent: number; unknown: number };
export interface RunWindow { startedAt?: string; endedAt?: string; phase: string }
interface Stored {
  delivery: string; at: string; counts: Counts | null; viewedComments: boolean;
  startedAt?: string;
}
interface Recovery { route: string; userId: string; startedAt: string; ready?: true; item: Stored }
interface Ledger {
  schema: 1; cursor?: string; lastCommentsAt?: string; byRoute: Record<string, Stored>;
  recoverySince?: string;
  generating?: Record<string, { route: string; at: string }>;
  opportunities?: Record<string, Recovery>;
}
export interface QqInterruption {
  at: string; description: string; total: number | null; sent: number | null; notSent: number | null; unknown: number | null;
  originalAvailable: false;
}
const document = 'qq-interruptions';
const empty = (): Ledger => ({ schema: 1, byRoute: {} });
const batch = 100; // Public memory.readSession limit.
const direct = /^direct:[1-9]\d{4,19}$/;
const accountId = /^[1-9]\d{4,19}$/;
const descriptor = /^\[QQ 临时私聊；正文不留存；指纹 [a-f0-9]{64}\]$/;
// Extract only the bounded counters from the QQ adapter's fixed receipt, never
// its error suffix, an incoming message, a model's report, or an external body.
const receiptCounts = /^(?:发送结果可能不确定；重试可能重复投递：)?QQ 投递(部分完成|明确未发出|结果未知)：共 (\d{1,2}) 段，确认发送 (\d{1,2}) 段，明确未发送 (\d{1,2}) 段（其中 (\d{1,2}) 段未提交），结果未知 (\d{1,2}) 段。/;
function counts(error: unknown): Counts | null {
  if (typeof error !== 'string') return null;
  const match = receiptCounts.exec(error);
  if (!match) return null;
  const [total, sent, notSent, unattempted, unknown] = match.slice(2).map(Number);
  if (total < 1 || total > 64 || total !== sent + notSent + unknown || sent === total || unattempted > notSent) return null;
  if (match[1] !== (sent ? '部分完成' : unknown ? '结果未知' : '明确未发出')) return null;
  return { total, sent, notSent, unknown };
}
type Evidence = { kind: 'comments'; at: string } |
  { kind: 'generated' | 'interruption' | 'sent'; route: string; delivery: string; at: string; userId: string; counts: Counts | null; failed: boolean };

function evidence(row: MemoryEvent, session: string): Evidence | null {
  if (row.session !== session || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts))) return null;
  const at = new Date(row.ts).toISOString();
  if (row.type === 'tool' && row.channel === 'plugin' && row.account === 'autonomy' && row.ok === true &&
      row.transient === true && row.name === 'bilibili_comments' &&
      ['surf/bilibili', 'bilibili'].includes(row.origin?.plugin ?? '')) {
    const result = row.result as Record<string, unknown> | null;
    if (result?.action === 'bilibili_comments' && result.status === 'ok') return { kind: 'comments', at };
  }
  if (row.type !== 'channel_receipt' || row.channel !== 'qq' || row.direction !== 'out' ||
      !['generated', 'sent', 'delivery_failed', 'uncertain'].includes(String(row.status)) ||
      typeof row.text !== 'string' || !descriptor.test(row.text) ||
      typeof row.account !== 'string' || !accountId.test(row.account) ||
      typeof row.peer !== 'string' || !direct.test(row.peer) ||
      typeof row.delivery_id !== 'string' || !/^delivery_[0-9a-f]{64}$/.test(row.delivery_id) ||
      typeof row.external_message_id !== 'string' || !row.external_message_id || /^ack:[a-f0-9]{64}$/.test(row.external_message_id)) return null;
  const route = row.conversation as { origin?: { plugin?: string }; account?: string; peer?: string; channel?: string } | undefined;
  if (route?.origin?.plugin !== 'qq' || route.channel !== 'qq' || route.account !== row.account || route.peer !== row.peer) return null;
  return { kind: row.status === 'sent' ? 'sent' : row.status === 'generated' ? 'generated' : 'interruption',
    route: digest([row.account, row.peer]), userId: row.peer.slice(7), delivery: row.delivery_id, at,
    counts: counts(row.error), failed: row.status === 'delivery_failed' };
}

function applyEvidence(data: Ledger, entry: Evidence, runs: RunWindow[], allowRecovery: boolean) {
  if (entry.kind === 'comments') { data.lastCommentsAt = entry.at; return; }
  if (entry.kind === 'generated') {
    // The host reserves an action ID and generates it only once. A duplicate
    // or a retry cannot mint another opportunity from a later failure receipt.
    if (allowRecovery && entry.at >= data.recoverySince!) {
      (data.generating ??= {})[entry.delivery] = { route: entry.route, at: entry.at };
    }
    return;
  }
  const previous = data.byRoute[entry.route];
  const start = data.generating?.[entry.delivery];
  const fresh = start?.route === entry.route;
  if (fresh) delete data.generating![entry.delivery];
  const open = data.opportunities?.[entry.delivery];
  if (open && open.route !== entry.route) return;
  if (entry.kind === 'sent') {
    if (open) delete data.opportunities![entry.delivery];
    if (previous?.delivery === entry.delivery) {
      delete data.byRoute[entry.route];
      const pending = Object.values(data.opportunities ?? {}).filter(o => o.route === entry.route)
        .sort((a,b) => b.startedAt.localeCompare(a.startedAt));
      if (pending[0]) data.byRoute[entry.route] = pending[0].item;
    }
    return;
  }
  const comment = data.lastCommentsAt ? Date.parse(data.lastCommentsAt) : NaN, attempted = Date.parse(entry.at);
  const viewedComments = comment <= attempted && runs.some(run =>
    run.startedAt && Date.parse(run.startedAt) <= comment &&
    (run.endedAt ? attempted <= Date.parse(run.endedAt) : run.phase === 'running' || run.phase === 'settling'));
  const same = previous?.delivery === entry.delivery;
  const startedAt = fresh ? start.at : open?.startedAt ?? (same ? previous.startedAt : undefined);
  const record: Stored = { delivery: entry.delivery, at: entry.at, counts: entry.counts, startedAt,
    viewedComments: viewedComments || !!open?.item.viewedComments || (same && previous.viewedComments) };
  if (entry.failed && entry.counts && entry.counts.notSent > 0 && entry.counts.unknown === 0) {
    if (fresh && start.at <= entry.at) {
      (data.opportunities ??= {})[entry.delivery] = { route: entry.route, userId: entry.userId, startedAt: start.at, item: record };
    } else if (open) open.item = record;
  } else if (open) delete data.opportunities![entry.delivery];
  // Corrections on an older send do not become the latest conversation event.
  // An already-consumed delivery has no recipient data or opportunity to reopen.
  if (!previous || same || (startedAt ? !previous.startedAt || startedAt > previous.startedAt ||
      (startedAt === previous.startedAt && fresh) : !previous.startedAt && record.at >= previous.at))
    data.byRoute[entry.route] = record;
}

function describe(record: Stored): QqInterruption {
  const c = record.counts;
  const progress = c ? `原计划共 ${c.total} 段，平台确认发送 ${c.sent} 段，明确未发送 ${c.notSent} 段，结果未知 ${c.unknown} 段。`
    : '这次投递没有得到完整的发送确认，无法确定各段进度。';
  const topic = record.viewedComments ? '同一次自主判断中，我刚查看过 B 站评论。' : '';
  return { at: record.at, total: c?.total ?? null, sent: c?.sent ?? null, notSent: c?.notSent ?? null,
    unknown: c?.unknown ?? null, originalAvailable: false,
    description: `${topic}我当时给这位联系人发了一条临时 QQ 私聊。${progress}回执没有记录分段原话，包括确认发送的段。对方是否已读未知。之前的聊天没有标明哪句属于这些分段，不能据此猜测原文。` };
}

/** Remember delivery facts through the host's public session archive. No send or wake capability. */
export class QqInterruptions {
  private docs: Documents;
  private activatedAt: string;
  private cached?: { session: string; data: Ledger };
  constructor(docs: Documents, activatedAt = Date.now()) { this.docs = docs; this.activatedAt = new Date(activatedAt).toISOString(); }
  async sync(sessionId: string, runs: RunWindow[]) { await this.refresh(sessionId, runs); }
  async recent(session: ToolSession, runs: RunWindow[]) {
    session.signal?.throwIfAborted();
    if (!session.id || session.permission === 'off' || session.channel !== 'qq' ||
        !session.account || !accountId.test(session.account) || !session.peer || !direct.test(session.peer) ||
        (session.sender !== undefined && session.sender !== session.peer.slice(7))) return null;
    const route = digest([session.account, session.peer]);
    // A lookup on an actual incoming QQ turn gives the character a decision
    // opportunity. It is not evidence that she replied or the peer read it.
    const noticed = session.origin?.plugin === 'qq' && session.sender === session.peer.slice(7) ? route : undefined;
    const data = await this.refresh(session.id, runs, session.signal, noticed);
    session.signal?.throwIfAborted();
    const item = data.byRoute[route];
    return item ? { ...describe(item), deliveryId: item.delivery } : null;
  }
  private async save(session: string, revision: string | null, data: Ledger) {
    await this.docs.write(session, document, revision, data);
    this.cached = { session, data };
  }
  private async read(session: string) {
    if (this.cached?.session === session) return this.cached.data;
    const { data } = await this.docs.read(session, document, empty);
    this.cached = { session, data };
    return data;
  }
  private candidates(data: Ledger, account: string) {
    return Object.values(data.opportunities ?? {}).filter(o => o.route === digest([account, 'direct:' + o.userId]));
  }
  async observeRecovery(session: string, account: string, windows: readonly { offlineAt: number; onlineAt: number }[]) {
    if (!session || !accountId.test(account) || !windows.length) return;
    const completed = windows.filter(w => Number.isFinite(w.offlineAt) && Number.isFinite(w.onlineAt) && w.offlineAt <= w.onlineAt);
    if (!completed.length) return;
    const latestDisconnect = Math.max(...completed.map(w => w.offlineAt));
    function transition(opportunity: Recovery) {
      if (opportunity.ready) return;
      const started = Date.parse(opportunity.startedAt), ended = Date.parse(opportunity.item.at);
      if (completed.some(w => started <= w.onlineAt && w.offlineAt <= ended)) return 'ready';
      // Later disconnects cannot explain a send that had already finished.
      if (latestDisconnect > ended) return 'expire';
    }
    await this.docs.serial(session, document, async () => {
      if (!this.candidates(await this.read(session), account).some(transition)) return;
      const snapshot = await this.docs.read(session, document, empty);
      let changed = false;
      for (const opportunity of this.candidates(snapshot.data, account)) {
        const next = transition(opportunity);
        if (!next) continue;
        if (next === 'ready') opportunity.ready = true;
        else delete snapshot.data.opportunities![opportunity.item.delivery];
        changed = true;
      }
      if (changed) await this.save(session, snapshot.revision, snapshot.data);
      else this.cached = { session, data: snapshot.data };
    });
  }
  private ready(data: Ledger, account: string, delivery?: string) {
    return this.candidates(data, account).filter(o => o.ready && (!delivery || o.item.delivery === delivery))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.item.delivery.localeCompare(b.item.delivery))[0];
  }
  async peekRecovery(session: string, account: string) {
    if (!session || !accountId.test(account)) return null;
    return this.docs.serial(session, document, async () => {
      const o = this.ready(await this.read(session), account);
      return o ? { deliveryId: o.item.delivery, userId: o.userId, fact: describe(o.item) } : null;
    });
  }
  async claimRecovery(session: string, account: string, deliveryId?: string, expectedFact?: QqInterruption) {
    if (!session || !accountId.test(account)) return null;
    return this.docs.serial(session, document, async () => {
      const snapshot = await this.docs.read(session, document, empty);
      const o = this.ready(snapshot.data, account, deliveryId);
      const fact = o && describe(o.item);
      if (!o || !fact || (expectedFact && (expectedFact.at !== fact.at || expectedFact.description !== fact.description))) {
        this.cached = { session, data: snapshot.data };
        return null;
      }
      const result = { deliveryId: o.item.delivery, userId: o.userId, fact };
      delete snapshot.data.opportunities![o.item.delivery];
      await this.save(session, snapshot.revision, snapshot.data);
      return result;
    });
  }
  private refresh(session: string, runs: RunWindow[], signal?: AbortSignal, noticed?: string) {
    return this.docs.serial(session, document, async () => {
      const snapshot = await this.docs.read(session, document, empty);
      let data = snapshot.data;
      if (data.schema !== 1 || !data.byRoute || typeof data.byRoute !== 'object' || Array.isArray(data.byRoute))
        throw Error('临时私聊回执文档结构无效');
      const migrating = !data.recoverySince;
      data.recoverySince ??= this.activatedAt;
      let before: string | undefined, newest: string | undefined, found = false;
      const pages: Evidence[][] = [];
      // Bootstrap the recent conversation. Once a cursor exists, catch up the
      // entire subsequent gap, even if the plugin was disabled for many turns.
      do {
        signal?.throwIfAborted();
        const rows = await this.docs.memory.readSession(session, batch, before);
        const last = rows.at(-1)?.id;
        if (!last) break;
        newest ??= last;
        if (newest === data.cursor) { found = true; break; }
        const boundary = data.cursor ? rows.findIndex(row => row.id === data.cursor) : -1;
        found = boundary >= 0;
        const projected: Evidence[] = [];
        for (const row of rows.slice(boundary + 1)) {
          const e = evidence(row, session);
          if (e) projected.push(e);
        }
        pages.push(projected);
        if (found || rows.length < batch || (!data.cursor && pages.length >= 2)) break;
        const first = rows[0].id;
        if (!first || first === before) throw Error('临时私聊回执分页未前进');
        before = first;
      } while (true);
      signal?.throwIfAborted();
      const advanced = !!newest && newest !== data.cursor;
      if (advanced) {
        const replaced = !!data.cursor && !found;
        if (replaced) data = { ...empty(), recoverySince: this.activatedAt };
        for (const page of pages.reverse()) for (const entry of page) applyEvidence(data, entry, runs, !replaced);
        data.cursor = newest;
      }
      const seen = noticed && data.byRoute[noticed];
      const consume = seen && data.opportunities?.[seen.delivery]?.route === noticed;
      if (consume) delete data.opportunities![seen.delivery];
      if (advanced || migrating || consume) await this.save(session, snapshot.revision, data);
      else this.cached = { session, data };
      return data;
    });
  }
}
