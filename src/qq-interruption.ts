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
}
interface Ledger {
  schema: 1; cursor?: string; lastCommentsAt?: string; byRoute: Record<string, Stored>;
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
  { kind: 'interruption' | 'sent'; route: string; delivery: string; at: string; counts: Counts | null };

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
      !['sent', 'delivery_failed', 'uncertain'].includes(String(row.status)) ||
      typeof row.text !== 'string' || !descriptor.test(row.text) ||
      typeof row.account !== 'string' || !accountId.test(row.account) ||
      typeof row.peer !== 'string' || !direct.test(row.peer) ||
      typeof row.delivery_id !== 'string' || !/^delivery_[0-9a-f]{64}$/.test(row.delivery_id) ||
      typeof row.external_message_id !== 'string' || !row.external_message_id || /^ack:[a-f0-9]{64}$/.test(row.external_message_id)) return null;
  const route = row.conversation as { origin?: { plugin?: string }; account?: string; peer?: string; channel?: string } | undefined;
  if (route?.origin?.plugin !== 'qq' || route.channel !== 'qq' || route.account !== row.account || route.peer !== row.peer) return null;
  return { kind: row.status === 'sent' ? 'sent' : 'interruption', route: digest([row.account, row.peer]),
    delivery: row.delivery_id, at, counts: counts(row.error) };
}

function applyEvidence(data: Ledger, entry: Evidence, runs: RunWindow[]) {
  if (entry.kind === 'comments') { data.lastCommentsAt = entry.at; return; }
  if (entry.kind === 'sent') {
    if (data.byRoute[entry.route]?.delivery === entry.delivery) delete data.byRoute[entry.route];
    return;
  }
  const comment = data.lastCommentsAt ? Date.parse(data.lastCommentsAt) : NaN, attempted = Date.parse(entry.at);
  const viewedComments = comment <= attempted && runs.some(run =>
    run.startedAt && Date.parse(run.startedAt) <= comment &&
    (run.endedAt ? attempted <= Date.parse(run.endedAt) : run.phase === 'running' || run.phase === 'settling'));
  data.byRoute[entry.route] = { delivery: entry.delivery, at: entry.at, counts: entry.counts, viewedComments };
}

function describe(record: Stored): QqInterruption {
  const c = record.counts;
  const progress = c ? `原计划共 ${c.total} 段，平台确认发送 ${c.sent} 段，明确未发送 ${c.notSent} 段，结果未知 ${c.unknown} 段。`
    : '这次投递没有得到完整的发送确认，无法确定各段进度。';
  const topic = record.viewedComments ? '同一次自主判断中，我刚查看过 B 站评论。具体想说什么已经无法核实。' : '';
  return { at: record.at, total: c?.total ?? null, sent: c?.sent ?? null, notSent: c?.notSent ?? null,
    unknown: c?.unknown ?? null, originalAvailable: false,
    description: `${topic}我当时给这位联系人发了一条临时 QQ 私聊。${progress}每一段的原话都未保留，包括确认发送的段。回执只确认发送进度，对方是否已读未知。之前的聊天没有标明哪句属于这些分段，不能据此引用、猜测或补写任何一段。若想接着聊，可以从此刻的新想法说起。` };
}

/** Remember delivery facts through the host's public session archive. No send or wake capability. */
export class QqInterruptions {
  private docs: Documents;
  constructor(docs: Documents) { this.docs = docs; }
  async sync(sessionId: string, runs: RunWindow[]) { await this.refresh(sessionId, runs); }
  async recent(session: ToolSession, runs: RunWindow[]): Promise<QqInterruption | null> {
    session.signal?.throwIfAborted();
    if (!session.id || session.permission === 'off' || session.channel !== 'qq' ||
        !session.account || !accountId.test(session.account) || !session.peer || !direct.test(session.peer) ||
        (session.sender !== undefined && session.sender !== session.peer.slice(7))) return null;
    const data = await this.refresh(session.id, runs, session.signal);
    session.signal?.throwIfAborted();
    const item = data.byRoute[digest([session.account, session.peer])];
    return item ? describe(item) : null;
  }
  private refresh(session: string, runs: RunWindow[], signal?: AbortSignal) {
    return this.docs.serial(session, document, async () => {
      const snapshot = await this.docs.read(session, document, empty);
      let data = snapshot.data;
      if (data.schema !== 1 || !data.byRoute || typeof data.byRoute !== 'object' || Array.isArray(data.byRoute))
        throw Error('临时私聊回执文档结构无效');
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
        if (newest === data.cursor) return data;
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
      if (!newest) return data;
      if (data.cursor && !found) data = empty(); // History replacement invalidated the old cursor.
      for (const page of pages.reverse()) for (const entry of page) applyEvidence(data, entry, runs);
      data.cursor = newest;
      await this.docs.write(session, document, snapshot.revision, data);
      return data;
    });
  }
}
