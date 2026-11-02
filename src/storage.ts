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
export interface Intent {
  id: string; version: number; kind: 'thought' | 'agreement'; text: string;
  createdAt: string; updatedAt: string; source: 'self' | 'conversation'; evidence: string;
  preferredAt: string | null; dueAt: string | null;
  state: 'open' | 'settling';
}
interface Pending { intentId: string; experience: ExperienceInput; }
interface IntentDocument {
  schema: 1; items: Intent[]; pending: Pending[];
  receipts: { key: string; hash: string; result: unknown }[];
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
function validate(d: IntentDocument) {
  if (d.schema !== 1 || !Array.isArray(d.items) || !Array.isArray(d.pending) || !Array.isArray(d.receipts)) throw Error('意图文档版本或结构不受支持；原数据保留');
  for (const i of d.items) {
    if (!i.id || !Number.isSafeInteger(i.version) || !['thought','agreement'].includes(i.kind) || !['open','settling'].includes(i.state)) throw Error('意图文档损坏；原数据保留');
    text(i.text, '意图'); iso(i.createdAt); iso(i.updatedAt); iso(i.preferredAt); iso(i.dueAt);
    if (i.kind === 'thought' && i.dueAt) throw Error('普通念头不能带强制唤起时间');
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
      if ((action === 'remember' || action === 'revise') && Buffer.byteLength(JSON.stringify(data), 'utf8') > 200000) {
        throw Error('意图文档接近容量上限，已预留完成和放弃的记录空间；请先处理已有事项');
      }
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
    if (args.version !== item.version) throw Error('意图已经变更，请重新读取后再决定');
    return item;
  }
}
