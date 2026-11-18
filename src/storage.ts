/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { MemoryAPI, ExperienceInput } from 'whalelife';
import { createHash, randomUUID } from 'node:crypto';

export function text(value: unknown, name: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw Error(`${name}须为1–${max}字`);
  return value.trim();
}
export function iso(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error('时间必须是带时区的 ISO 日期时间');
  return new Date(value).toISOString();
}
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const requiredFields: Record<string, string[]> = {
  list: [],
  remember: ['requestId', 'kind', 'text', 'source', 'evidence'],
  revise: ['requestId', 'intentId', 'version', 'kind', 'text', 'source', 'evidence'],
  complete: ['requestId', 'intentId', 'version', 'reason', 'evidence'],
  abandon: ['requestId', 'intentId', 'version', 'reason', 'evidence'],
};
export class IntentInputError extends Error {
  code: 'missing_fields' | 'invalid_fields';
  fields: string[];
  requiredFields: string[];
  constructor(action: string, fields: string[], message: string, missing = false) {
    super(message);
    this.code = missing ? 'missing_fields' : 'invalid_fields';
    this.fields = fields;
    this.requiredFields = ['action', ...(requiredFields[action] ?? [])];
  }
}
function validateArguments(args: Record<string, unknown>) {
  const action = String(args.action);
  if (!Object.hasOwn(requiredFields, action)) throw new IntentInputError(action, ['action'], 'action 必须为 list / remember / revise / complete / abandon');
  const missing = requiredFields[action].filter(key => args[key] === undefined || args[key] === null || (typeof args[key] === 'string' && !args[key].trim()));
  if (missing.length) throw new IntentInputError(action, missing,
    `${action} 缺少必填参数：${missing.join(', ')}。${missing.includes('evidence') ? 'evidence 是独立的依据字段，填写实际发生的情况；reason 不能代替 evidence。' : ''}补齐缺失字段后再调用；本次操作未写入。`, true);
  const ending = action === 'complete' || action === 'abandon';
  for (const [key, max] of Object.entries({ requestId: 100, intentId: 100, text: 300, evidence: ending ? 140 : 200, reason: 140 })) {
    if (!requiredFields[action].includes(key)) continue;
    try { text(args[key], key, max); }
    catch { throw new IntentInputError(action, [key], `${key} 必须是 1–${max} 字的非空字符串；请修改 ${key} 字段。`); }
  }
  if (requiredFields[action].includes('version') && (!Number.isSafeInteger(args.version) || Number(args.version) < 1)) {
    throw new IntentInputError(action, ['version'], 'version 必须是 list 返回的正整数版本号');
  }
  if (action === 'remember' || action === 'revise') {
    if (!['thought', 'agreement'].includes(String(args.kind))) throw new IntentInputError(action, ['kind'], 'kind 必须为 thought 或 agreement');
    if (!['self', 'conversation'].includes(String(args.source))) throw new IntentInputError(action, ['source'], 'source 必须为 self 或 conversation');
  }
  return action;
}
export interface QQDeliveryRef { accountId: string; deliveryId: string }
export interface Intent {
  id: string; version: number; kind: 'thought' | 'agreement'; text: string;
  createdAt: string; updatedAt: string; source: 'self' | 'conversation'; evidence: string;
  preferredAt: string | null; dueAt: string | null;
  state: 'open' | 'settling';
  qq?: QQDeliveryRef & { reviewedRevision?: string; attemptedRevision?: string; abandonReason?: string };
}
interface Pending { intentId: string; experience: ExperienceInput; }
interface IntentDocument {
  schema: 1; items: Intent[]; pending: Pending[];
  receipts: { key: string; hash: string; result: unknown }[];
  // An acknowledged send can outlive a failure in QQ's own receipt storage.
  qqConfirmed?: QQDeliveryRef[];
}
export class Documents {
  memory: MemoryAPI;
  private queues = new Map<string, Promise<unknown>>();
  constructor(memory: MemoryAPI) { this.memory = memory; }
  serial<T>(session: string, key: string, work: () => Promise<T>): Promise<T> {
    const id = `${session}:${key}`, previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => {});
    return next;
  }
  async read<T>(session: string, key: string, initial: () => T) {
    const snapshot = await this.memory.readDocument<T>(session, key);
    return { revision: snapshot.revision, data: structuredClone(snapshot.data ?? initial()) };
  }
  async write<T>(session: string, key: string, revision: string | null, data: T) {
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 245000) throw Error('会话文档接近容量上限，请先处理已有意图；原数据已保留');
    return this.memory.saveDocument<T>(session, { key, revision, data });
  }
  async update<T>(session: string, key: string, initial: () => T, change: (data: T) => void) {
    return this.serial(session, key, async () => {
      const snapshot = await this.read(session, key, initial);
      change(snapshot.data);
      return this.write(session, key, snapshot.revision, snapshot.data);
    });
  }
}
export const emptyIntents = (): IntentDocument => ({ schema: 1, items: [], pending: [], receipts: [] });
function qqIdentifier(value: string) {
  // QQ identifiers and revisions are opaque. Do not trim or normalize them.
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Error('QQ 投递标识无效');
  }
  return value;
}
function qqIntentId(session: string, ref: QQDeliveryRef) {
  return 'qq-' + digest([session, qqIdentifier(ref.accountId), qqIdentifier(ref.deliveryId)]);
}
function reserveOutcomeSpace(data: IntentDocument) {
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 200000) {
    throw Error('意图文档接近容量上限，已预留完成和放弃的记录空间；请先处理已有事项');
  }
}
function validate(d: IntentDocument) {
  if (d.schema !== 1 || !Array.isArray(d.items) || !Array.isArray(d.pending) || !Array.isArray(d.receipts)) throw Error('意图文档版本或结构不受支持；原数据保留');
  if (d.qqConfirmed !== undefined) {
    if (!Array.isArray(d.qqConfirmed)) throw Error('QQ 续发确认记录无效');
    for (const ref of d.qqConfirmed) { qqIdentifier(ref.accountId); qqIdentifier(ref.deliveryId); }
  }
  for (const i of d.items) {
    if (!i.id || !Number.isSafeInteger(i.version) || !['thought','agreement'].includes(i.kind) || !['open','settling'].includes(i.state)) throw Error('意图文档损坏；原数据保留');
    text(i.text, '意图'); iso(i.createdAt); iso(i.updatedAt); iso(i.preferredAt); iso(i.dueAt);
    if (i.kind === 'thought' && i.dueAt) throw Error('普通念头不能带强制唤起时间');
    if (i.qq !== undefined) {
      if (!i.qq || i.kind !== 'thought') throw Error('QQ 未完成表达的念头结构无效');
      qqIdentifier(i.qq.accountId);
      qqIdentifier(i.qq.deliveryId);
      if (i.qq.reviewedRevision !== undefined) qqIdentifier(i.qq.reviewedRevision);
      if (i.qq.attemptedRevision !== undefined) qqIdentifier(i.qq.attemptedRevision);
      if (i.qq.abandonReason !== undefined) text(i.qq.abandonReason, '放弃原因', 140);
    }
  }
  return d;
}
export class Intents {
  docs: Documents; now: () => number;
  constructor(docs: Documents, now = Date.now) { this.docs = docs; this.now = now; }
  async list(session: string) {
    const { data } = await this.docs.read(session, 'intents', emptyIntents);
    return structuredClone(validate(data).items);
  }
  async linkQQ(session: string, ref: QQDeliveryRef, createdAt?: string): Promise<Intent> {
    const id = qqIntentId(session, ref);
    return this.docs.serial(session, 'intents', async () => {
      const { data, revision } = await this.docs.read(session, 'intents', emptyIntents);
      const existing = validate(data).items.find(item => item.id === id);
      if (existing) return existing;
      if (data.qqConfirmed?.some(r => r.accountId === ref.accountId && r.deliveryId === ref.deliveryId)) {
        throw Error('QQ 已确认原文字全部发送，无需再建立未完成念头');
      }
      const now = new Date(this.now()).toISOString();
      const item: Intent = {
        id, version: 1, kind: 'thought', state: 'open', source: 'conversation',
        text: '我在 QQ 有话没说完，想等能联系时看看是否还要接着说。',
        evidence: 'QQ 的原文字投递记录仍未完成。',
        createdAt: iso(createdAt) ?? now, updatedAt: now, dueAt: null, preferredAt: null,
        qq: { accountId: ref.accountId, deliveryId: ref.deliveryId },
      };
      data.items.push(item);
      reserveOutcomeSpace(data);
      await this.docs.write(session, 'intents', revision, data);
      return item;
    });
  }
  private async updateQQ(session: string, ref: QQDeliveryRef, change: (item: Intent, data: IntentDocument) => boolean, required = false) {
    const id = qqIntentId(session, ref);
    await this.docs.serial(session, 'intents', async () => {
      const { data, revision } = await this.docs.read(session, 'intents', emptyIntents);
      const item = validate(data).items.find(i => i.id === id);
      if (!item?.qq || item.state !== 'open') {
        if (required) throw Error('未找到可处理的 QQ 未完成表达');
        return;
      }
      if (!change(item, data)) return;
      item.version++;
      item.updatedAt = new Date(this.now()).toISOString();
      await this.docs.write(session, 'intents', revision, data);
    });
  }
  async reviewQQ(session: string, ref: QQDeliveryRef, revision: string, attempted = false) {
    qqIdentifier(revision);
    await this.updateQQ(session, ref, item => {
      if (item.qq!.reviewedRevision === revision && (!attempted || item.qq!.attemptedRevision === revision)) return false;
      item.qq!.reviewedRevision = revision;
      if (attempted) item.qq!.attemptedRevision = revision;
      return true;
    });
  }
  async prepareQQAbandon(session: string, ref: QQDeliveryRef, reason: string) {
    const explanation = text(reason, '放弃原因', 140);
    await this.updateQQ(session, ref, item => {
      if (item.qq!.abandonReason === explanation) return false;
      item.qq!.abandonReason = explanation;
      return true;
    }, true);
  }
  async verifiedQQClosures(session: string): Promise<QQDeliveryRef[]> {
    const { data } = await this.docs.read(session, 'intents', emptyIntents);
    return validate(data).qqConfirmed ?? [];
  }
  async forgetQQClosures(session: string, refs: QQDeliveryRef[]) {
    if (!refs.length) return;
    const ids = new Set(refs.map(ref => qqIntentId(session, ref)));
    await this.docs.serial(session, 'intents', async () => {
      const { data, revision } = await this.docs.read(session, 'intents', emptyIntents);
      const before = validate(data).qqConfirmed ?? [];
      const remaining = before.filter(ref => !ids.has(qqIntentId(session, ref)));
      if (remaining.length === before.length) return;
      if (remaining.length) data.qqConfirmed = remaining;
      else delete data.qqConfirmed;
      await this.docs.write(session, 'intents', revision, data);
    });
  }
  async closeQQ(session: string, ref: QQDeliveryRef, outcome: 'sent' | 'dismissed', receiptUnavailable = false) {
    await this.updateQQ(session, ref, (item, data) => {
      const sent = outcome === 'sent';
      if (!sent && !item.qq!.abandonReason) throw Error('缺少此前明确放弃 QQ 续发的原因，保留念头供核对');
      const label = sent ? '完成意图' : '明确放弃意图';
      item.state = 'settling';
      if (sent && receiptUnavailable) {
        (data.qqConfirmed ??= []).push({ accountId: ref.accountId, deliveryId: ref.deliveryId });
      }
      data.pending.push({ intentId: item.id, experience: {
        event_id: `intent:${item.id}:${outcome}`, outcome: 'succeeded',
        text: sent ? '我在 QQ 没说完的那段话，现已得到平台的全部发送确认。'
          : `我决定不再接着发送先前没说完的 QQ 原话。原因：${item.qq!.abandonReason}`,
        occurred_at: new Date(this.now()).toISOString(), origin: { platform: '自主性', action: label },
      } });
      return true;
    });
    // QQ has already settled this plan. Retrying this outbox never performs a send.
    await this.settle(session);
  }
  async settle(session: string) {
    return this.docs.serial(session, 'intents', async () => {
      let snapshot = await this.docs.read(session, 'intents', emptyIntents);
      validate(snapshot.data);
      // Durable outbox: record first, remove the intent only after acknowledgement.
      // A retry uses the same event_id and cannot duplicate an experience.
      while (snapshot.data.pending.length) {
        const pending = snapshot.data.pending[0];
        await this.docs.memory.recordExperience(session, pending.experience);
        snapshot.data.items = snapshot.data.items.filter(i => i.id !== pending.intentId);
        snapshot.data.pending.shift();
        const saved = await this.docs.write(session, 'intents', snapshot.revision, snapshot.data);
        snapshot = { revision: saved.revision, data: snapshot.data };
      }
    });
  }
  async change(session: string, args: Record<string, unknown>) {
    const action = validateArguments(args);
    if (action === 'list') return { items: await this.list(session) };
    const key = text(args.requestId, '本次操作ID', 100), hash = digest(args);
    // Finish an existing memory outbox before accepting another mutation. This
    // prevents storage failures from accumulating unbounded pending decisions.
    await this.settle(session);
    const result = await this.docs.serial(session, 'intents', async () => {
      const snapshot = await this.docs.read(session, 'intents', emptyIntents), data = validate(snapshot.data);
      const receipt = data.receipts.find(r => r.key === key);
      if (receipt) {
        if (receipt.hash !== hash) throw Error('同一操作ID不能用于不同内容');
        return receipt.result;
      }
      const at = new Date(this.now()).toISOString();
      let result: unknown;
      if (action === 'remember' || action === 'revise') {
        const kind = args.kind;
        if (kind !== 'thought' && kind !== 'agreement') throw Error('意图类型须为 thought 或 agreement');
        const source = args.source;
        if (source !== 'self' && source !== 'conversation') throw Error('请注明意图来自自身还是交流');
        const evidence = text(args.evidence, '形成依据', 200);
        if (kind === 'agreement' && source !== 'conversation') throw Error('与他人的约定须有交流依据，普通念头不能自动变成约定');
        const dueAt = iso(args.dueAt), preferredAt = iso(args.preferredAt);
        if (dueAt && kind !== 'agreement') throw Error('只有明确时间约定才能设置强制唤起时间，普通打算请用 preferredAt');
        const content = text(args.text, '意图');
        let item: Intent;
        if (action === 'remember') {
          item = { id: randomUUID(), version: 1, createdAt: at, updatedAt: at, state: 'open', text: content, kind, source, evidence, preferredAt, dueAt };
          data.items.push(item);
        } else {
          item = this.find(data, args);
          Object.assign(item, { text: content, kind, source, evidence, preferredAt, dueAt, version: item.version + 1, updatedAt: at });
        }
        result = { intent: structuredClone(item) };
      } else if (action === 'complete' || action === 'abandon') {
        const item = this.find(data, args), reason = text(args.reason, '结果及原因', 140);
        const evidence = text(args.evidence, action === 'complete' ? '实际结果依据' : '放弃依据', 140);
        item.state = 'settling'; item.updatedAt = at; item.version++;
        const label = action === 'complete' ? '完成意图' : '明确放弃意图';
        const summary = `${label}：${item.text}\n结果及原因：${reason}\n依据：${evidence}`;
        data.pending.push({ intentId: item.id, experience: {
          event_id: `intent:${item.id}:${key}`, outcome: 'succeeded',
          text: [...summary].slice(0, 500).join(''), occurred_at: at,
          origin: { platform: '自主性', action: label },
        } });
        result = { id: item.id, result: action, pendingRecord: true,
          ...(item.kind === 'agreement' && action === 'abandon' ? { informCounterparty: '还须通过实际交流向对方解释原因；记录此决定不代表已经告知。' } : {}) };
      } else throw Error('意图操作无效');
      data.receipts.push({ key, hash, result });
      if (data.receipts.length > 200) data.receipts.splice(0, data.receipts.length - 200);
      if (action === 'remember' || action === 'revise') reserveOutcomeSpace(data);
      await this.docs.write(session, 'intents', snapshot.revision, data);
      return result;
    });
    await this.settle(session);
    return result && typeof result === 'object' && 'pendingRecord' in result
      ? { ...result, pendingRecord: false } : result;
  }
  private find(data: IntentDocument, args: Record<string, unknown>) {
    const item = data.items.find(i => i.id === args.intentId);
    if (!item || item.state !== 'open') throw Error('意图不存在或正在记录结束结果，请重新读取');
    if (item.qq) throw Error('请使用 QQ 未完成表达工具核对原投递，在那里选择继续、暂缓或说明原因后放弃');
    if (args.version !== item.version) throw Error('意图已经变更，请重新读取后再决定');
    return item;
  }
}
