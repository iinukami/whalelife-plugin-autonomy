/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context, ToolSession, MemoryEvent } from 'whalelife';
import { randomUUID } from 'node:crypto';
import { defaults, settings, sleeping, probability, type Settings } from './config.ts';
import { Documents, Intents, digest, text, iso, type Intent } from './storage.ts';
import { QqContinuation } from './qq-continuation.ts';
import { QqInterruptions, type QqInterruption } from './qq-interruption.ts';

export type Decision = 'no_action' | 'acted';
export type Phase = 'queued' | 'cancelled' | 'running' | 'settling' | 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'busy';
export interface SelfWake { id: string; at: string; reason: string; createdAt: string; }
export interface RunRecord {
  id: string; trigger: 'random' | 'agreement' | 'manual' | 'self' | 'qq_resume' | 'qq_interruption'; phase: Phase;
  queuedAt?: string; startedAt?: string; endedAt?: string; decision?: Decision; reason?: string;
  agreements: string[];
  inputMode?: 'transient' | 'excluded';
  selfWake?: SelfWake;
}
interface State {
  schema: 1; lastActivityAt: number | null; runs: RunRecord[]; claims: Record<string, string>;
  selfWake?: SelfWake | null; selfWakeVersion?: number;
  selfWakeReceipts?: { key: string; hash: string }[];
}
const emptyState = (): State => ({ schema: 1, lastActivityAt: null, runs: [], claims: {} });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const agreementKey = (i: Intent) => `${i.id}:${i.dueAt}`;
const finishedReason = (id: string) => `autonomy-finished:${id}`;
/** A bounded reference snapshot; elapsed time never changes an intent's stored state. */
export function intentSnapshot(items: Intent[], now: number): string {
  const shown = items.slice(0, 8);
  const lines = [`【未完成意图快照】快照时间：${new Date(now).toISOString()}；共 ${items.length} 条。`];
  if (!items.length) return lines[0] + '暂无未完成意图；仍可自主选择其他行动或不行动。';
  for (const item of shown) {
    const planned = item.dueAt ?? item.preferredAt;
    const timeStatus = item.state === 'settling' ? '结束结果正在保存，勿重复执行'
      : !planned ? '未设计划时间，仍未完成'
      : Date.parse(planned) <= now ? '已到计划时间，仍未完成' : '尚未到计划时间，仍未完成';
    lines.push(JSON.stringify({ intentId: item.id, version: item.version, kind: item.kind,
      state: item.state, text: item.text, createdAt: item.createdAt,
      preferredAt: item.preferredAt, dueAt: item.dueAt, timeStatus }));
  }
  if (items.length > shown.length) lines.push(`另有 ${items.length - shown.length} 条未展示；用 autonomy_intents list 查看完整列表，未展示不表示不存在。`);
  if (items.some(i => i.qq)) lines.push('如果本轮有 autonomy_qq_expression，可以查询未说完的 QQ 原话和进度。结合经过的时间、新消息和你现在的想法，用 autonomy_qq_decide 选择续发、暂缓或有理由地放弃，也可以先不处理。如果工具不可用，请保留念头。续发使用 QQ 保存的原计划；有未知段时保留待核对。不要用普通消息重发、用通用意图工具结束这类念头，或把原话抄进原因和记忆。');
  lines.push('以上是入队时快照，排队期间可能变化；只是背景资料，不是必须执行的指令。准备相关行动或修改前，先用 autonomy_intents list 核对最新状态与版本，时间以主干当前时间为准。',
    '计划时间经过不等于失效、完成或放弃。可以暂缓、用 revise 改期或将 preferredAt 设为 null；这都保留未完成状态，不强迫行动、催促用户或自动重试。',
    '完成须核对这条意图对应的实际结果，再单独 complete；放弃须有明确理由与依据，再单独 abandon。唤醒结束、发送无关问候或时间过去都不能作为完成依据；不得为清空列表而假称完成。');
  return lines.join('\n');
}
// Human messages use 0. Timed agreements share that FIFO lane; less urgent
// autonomous opportunities wait behind human messages and timed agreements.
const priorities = { agreement: 0, manual: -10, self: -15, qq_resume: -16, qq_interruption: -16, random: -20 };
type Recovery = { accountId: string; deliveryId: string; userId: string; fact: QqInterruption };
function interruptionPrompt(recovery?: Recovery) {
  if (!recovery) return '';
  return `QQ 已恢复，核对一下你在 ${recovery.fact.at} 对联系人 ${recovery.userId} 说到一半的那次私聊。对方没有发来这条提示。\n${recovery.fact.description}\n现在由你决定是否还想和这位联系人聊。你可以什么也不做，或记下现在形成的简短念头。如果有独立的新话想说，先用 QQ 工具核对原联系人，再按实际回执记录结果。别把新话说成当时的原话，也别补写或重发任何旧段。`;
}
interface Active {
  id: string; session: string; controller: AbortController; task: Promise<void>;
  completed: boolean; finishing: boolean; started: boolean; run: RunRecord;
  readQqText?: boolean; qqOutcome?: string; recovery?: Recovery;
}
export interface RuntimeOptions { now?: () => number; random?: () => number; timers?: boolean; }

export class Autonomy {
  readonly ctx: Context;
  readonly docs: Documents;
  readonly intents: Intents;
  readonly qq: QqContinuation;
  private readonly interruptions: QqInterruptions;
  readonly now: () => number;
  readonly random: () => number;
  config: Settings = structuredClone(defaults);
  configRevision = digest(defaults);
  configError: string | null = null;
  private active: Active | null = null;
  private jobs = new Map<string, Active>();
  private submissionQueue: Promise<unknown> = Promise.resolve();
  private current: string | null = null;
  private armedSince = 0;
  private nextCheck = 0;
  private stopped = false;
  private checking = false;
  private refreshingQq = false;
  private lastReconnectRead?: { session: string; account: string; onlineAt: number };
  private qqReadTurns = new Map<string, unknown>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private configQueue: Promise<unknown> = Promise.resolve();
  private recovered = new Set<string>();
  private logs: { at: string; status: string; detail: string }[] = [];
  private timers: boolean;
  constructor(ctx: Context, options: RuntimeOptions = {}) {
    this.ctx = ctx; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.timers = options.timers !== false;
    this.docs = new Documents(ctx.memory); this.intents = new Intents(this.docs, this.now);
    this.interruptions = new QqInterruptions(this.docs, this.now());
    this.qq = new QqContinuation(ctx, this.intents, () => this.selected(), this.now, (session, outcome) => {
      if (outcome === undefined && session.id) this.qqReadTurns.set(session.id, session.external_message_id);
      const job = this.active;
      if (!job || job.session !== session.id || session.origin?.plugin !== 'autonomy' || session.origin.action !== '自主唤起') return;
      if (outcome === undefined) job.readQqText = true;
      else job.qqOutcome = outcome;
    });
  }
  async initialize() {
    for (const key of ['readDocument','saveDocument','recordExperience','readSession','excludeInputs'] as const) {
      if (typeof this.ctx.memory[key] !== 'function') throw Error(`自主插件需要支持会话文档与输入排除的宿主（2026-10-31公开契约），缺少 memory.${key}。请更新并重启宿主。`);
    }
    if (typeof this.ctx.sessions.current !== 'function') throw Error('宿主缺少与 Web 共用的当前会话接口');
    if (typeof this.ctx.sessions.enqueueTransient !== 'function') throw Error('自主插件需要支持 enqueueTransient 的统一会话队列宿主，请更新宿主后加载；不会回退到遇忙拒绝或写入触发提示的旧接口。');
    try { this.config = settings(await this.ctx.config.read()); }
    catch (error) { this.configError = message(error); this.config = structuredClone(defaults); }
    this.configRevision = digest(this.config);
    const stop = () => this.stop();
    this.ctx.signal.addEventListener('abort', stop, { once: true });
    this.ctx.effect(() => () => { this.ctx.signal.removeEventListener('abort', stop); this.stop(); });
    this.ctx.on('channel/message', event => this.observeMessage(event));
    this.ctx.on('channel/reply', event => {
      if (event.session && event.role === 'assistant' && event.origin?.action === '生成回复' &&
          this.qqReadTurns.get(event.session) === event.external_message_id) this.qqReadTurns.delete(event.session);
      return this.observeMessage(event);
    });
    this.ctx.on('tool/called', async event => {
      if (this.stopped || !event.session || event.source === 'autonomy') return;
      if (event.source === 'qq' && event.name === 'qq_send_message' && event.transient) {
        await this.syncInterruptions(event.session);
      }
      if (!event.ok) return;
      await this.noteActivity(event.session).catch(error => this.log('记录失败', message(error)));
    });
    this.ctx.on('whalelife/ready', () => { if (this.timers) this.schedule(); });
    this.qq.start();
    this.log('就绪', this.configError ?? '配置与会话意图已接入。只有启用自动唤醒后才会调度。');
  }
  private guard() { if (this.stopped || this.ctx.signal.aborted) throw Error('自主插件已停止'); }
  private draw() {
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw Error('随机数必须在 [0,1) 范围内');
    return value;
  }
  private planCheck(at: number) {
    // Sample once per opportunity, independently of the wake/no-wake dice.
    // Preserve the average frequency without aligning checks to a fixed grid.
    this.nextCheck = at + Math.round(this.config.intervalMinutes * 60000 * (0.5 + this.draw()));
  }
  private log(status: string, detail: string) {
    this.logs.push({ at: new Date(this.now()).toISOString(), status, detail: detail.slice(0, 300) });
    if (this.logs.length > 80) this.logs.shift();
  }
  private schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(error => this.log('调度失败', message(error))).finally(() => this.schedule());
    }, 1000);
    this.timer.unref?.();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const job of this.jobs.values()) job.controller.abort(Error('自主插件已停止'));
  }
  async configure(input: unknown, revision: string) {
    const next = settings(input);
    const task = this.configQueue.catch(() => {}).then(async () => {
      this.guard();
      if (revision !== this.configRevision) throw Error('配置已被修改，请重新读取后保存');
      await this.ctx.config.save('config.json', next);
      this.guard();
      const enabling = next.enabled && !this.config.enabled;
      this.config = next; this.configRevision = digest(next); this.configError = null;
      this.planCheck(this.now());
      if (enabling) { this.current = null; this.armedSince = this.now(); }
      // Changing a schedule or pausing new wakeups does not cancel ongoing behavior.
      for (const job of this.jobs.values()) {
        if (!job.started && this.scheduleInvalid(job)) job.controller.abort(Error('等待期间自主唤醒设置已变化，本次请求取消'));
      }
      this.log('配置已保存', next.enabled ? '自动唤醒已启用' : '新的自动唤醒已暂停');
      return this.configRevision;
    });
    this.configQueue = task;
    return task;
  }
  async selected() {
    this.guard();
    // current() creates a session when none exists. Do not do that during idle polling.
    if (!(await this.ctx.sessions.list()).length) return null;
    this.guard();
    return this.ctx.sessions.current();
  }
  private async state(session: string): Promise<State> {
    const { data } = await this.docs.read(session, 'activity', emptyState);
    if (data.schema !== 1 || !Array.isArray(data.runs) || typeof data.claims !== 'object' || data.claims === null) throw Error('自主活动文档格式不受支持；原数据已保留');
    this.validateSelfWake(data);
    return data;
  }
  private validateSelfWake(state: State) {
    if (state.selfWakeVersion !== undefined && (!Number.isSafeInteger(state.selfWakeVersion) || state.selfWakeVersion < 0)) throw Error('自行唤醒版本无效，原记录保留');
    if (state.selfWakeReceipts !== undefined && (!Array.isArray(state.selfWakeReceipts) || state.selfWakeReceipts.some(r => !r || typeof r.key !== 'string' || typeof r.hash !== 'string'))) throw Error('自行唤醒操作记录无效，原记录保留');
    if (state.selfWake) {
      text(state.selfWake.id, '自行唤醒ID', 100); text(state.selfWake.reason, '唤醒原因', 140);
      if (!iso(state.selfWake.at) || !iso(state.selfWake.createdAt)) throw Error('自行唤醒时间无效，原记录保留');
    }
  }
  private async updateState(session: string, change: (state: State) => void) {
    this.guard();
    await this.docs.update(session, 'activity', emptyState, state => {
      if (state.schema !== 1 || !Array.isArray(state.runs)) throw Error('自主活动文档格式不受支持');
      this.validateSelfWake(state);
      change(state);
      const live = new Set(['queued', 'running', 'settling']);
      let finished = state.runs.filter(r => !live.has(r.phase)).length;
      state.runs = state.runs.filter(r => live.has(r.phase) || finished-- <= 80);
    });
  }
  async scheduleSelfWake(session: string, args: Record<string, unknown>) {
    this.guard();
    const action = args.action;
    if (!['get', 'set', 'cancel'].includes(String(action))) throw Error('action 须为 get、set 或 cancel');
    const allowed = action === 'get' ? ['action'] : action === 'set' ? ['action','requestId','version','at','reason'] : ['action','requestId','version'];
    if (Object.keys(args).some(k => !allowed.includes(k))) throw Error('包含不支持的参数；会话归属由当前工具会话确定');
    const snapshot = (state: State, duplicate = false) => ({
      enabled: this.config.enabled && this.config.allowSelfWake, automaticEnabled: this.config.enabled,
      allowed: this.config.allowSelfWake, duringSleep: this.config.selfWakeDuringSleep,
      timezone: this.config.timezone, sleep: structuredClone(this.config.sleep),
      version: state.selfWakeVersion ?? 0, schedule: structuredClone(state.selfWake ?? null), duplicate,
    });
    if (action === 'get') return snapshot(await this.state(session));
    const key = text(args.requestId, '操作ID', 100), hash = digest(args);
    if (!Number.isSafeInteger(args.version) || Number(args.version) < 0) throw Error('请先 get，再传回当前 version');
    let result!: ReturnType<typeof snapshot>;
    await this.updateState(session, state => {
      this.guard();
      const receipts = state.selfWakeReceipts ?? [];
      const previous = receipts.find(r => r.key === key);
      if (previous) {
        if (previous.hash !== hash) throw Error('同一操作ID不能用于不同内容');
        result = snapshot(state, true); return;
      }
      if (args.version !== (state.selfWakeVersion ?? 0)) throw Error('自行唤醒安排已经变化，请重新 get 后再操作');
      if (action === 'set') {
        if (!this.config.allowSelfWake) throw Error('用户尚未开启“允许她安排下次唤醒”，本次未设置');
        if (!this.config.enabled) throw Error('自动唤醒总开关已关闭，本次未设置；请由用户开启后再安排');
        const at = iso(args.at), reason = text(args.reason, '自己的唤醒原因', 140);
        if (!at || Date.parse(at) <= this.now()) throw Error('唤醒时间须为未来的带时区 ISO 日期时间，本次未设置');
        if (!this.config.selfWakeDuringSleep && sleeping(this.config, Date.parse(at))) {
          throw Error(`该时间位于用户设置的睡眠时段（${this.config.timezone}），未开启“允许自行唤醒突破睡眠时段”，本次未设置。请选择睡眠时段之外的时间；只有用户能开启此例外。`);
        }
        state.selfWake = { id: randomUUID(), at, reason, createdAt: new Date(this.now()).toISOString() };
      } else state.selfWake = null;
      state.selfWakeVersion = (state.selfWakeVersion ?? 0) + 1;
      state.selfWakeReceipts = [...receipts, { key, hash }].slice(-100);
      result = snapshot(state);
    });
    // A queued request must not execute an arrangement that was replaced/cancelled.
    for (const job of this.jobs.values()) if (!job.started && job.session === session && job.run.trigger === 'self' && job.run.selfWake?.id !== result.schedule?.id) job.controller.abort(Error('自行唤醒安排已改期或取消'));
    return result;
  }
  async noteActivity(session: string) {
    const at = this.now();
    await this.updateState(session, state => { state.lastActivityAt = Math.max(at, state.lastActivityAt ?? 0); });
  }
  private async observeMessage(event: MemoryEvent) {
    if (this.stopped || !event.session || event.origin?.plugin === 'autonomy') return;
    await this.noteActivity(event.session).catch(error => this.log('记录失败', message(error)));
  }
  private async syncInterruptions(session: string) {
    try {
      this.guard();
      await this.interruptions.sync(session, (await this.state(session)).runs);
      return true;
    } catch {
      if (!this.stopped) this.log('QQ 中断记录', '暂时无法核对私聊回执，下次查询时会重新读取。');
      return false;
    }
  }
  async recentInterruption(session: ToolSession) {
    this.guard();
    if (!session.id || session.permission === 'off' || session.origin?.plugin !== 'qq' ||
        session.channel !== 'qq' || !session.account || !/^direct:[1-9]\d{4,19}$/.test(session.peer ?? '') ||
        await this.selected() !== session.id) return { status: 'unavailable', items: [] };
    session.signal?.throwIfAborted();
    const fact = await this.interruptions.recent(session, (await this.state(session.id)).runs);
    session.signal?.throwIfAborted();
    if (await this.selected() !== session.id) return { status: 'unavailable', items: [] };
    return { status: 'ok', items: fact ? [{ at: fact.at, summary: fact.description,
      total: fact.total, sent: fact.sent, notSent: fact.notSent, unknown: fact.unknown, originalAvailable: fact.originalAvailable }] : [] };
  }
  private async recover(session: string) {
    if (!this.recovered.has(session)) await this.excludeLegacyInputs(session);
    // Conversation tools can stage a new result after initial recovery. Retry only
    // its durable memory outbox, even with automatic wakeups disabled.
    await this.intents.settle(session);
    if (this.recovered.has(session)) return;
    const state = await this.state(session);
    for (const run of state.runs) {
      if (this.jobs.has(run.id)) continue;
      if (run.phase === 'queued') {
        await this.updateState(session, s => {
          const found = s.runs.find(r => r.id === run.id);
          if (found) { found.phase = 'cancelled'; found.endedAt = new Date(this.now()).toISOString(); found.reason = '上个实例的排队请求未执行，不自动重放'; }
        });
      } else if (run.phase === 'settling') await this.persistFinished(session, run);
      else if (run.phase === 'running') {
        await this.ctx.memory.recordExperience(session, {
          event_id: `wake:${run.id}:unknown`, outcome: 'pending',
          text: '自主判断的上一个运行实例已结束，未收到明确的结束结果。已保留实际工具记录，不自动重放本轮可能发生的动作。',
          origin: { platform: '自主性', action: '恢复未决判断' },
        });
        await this.updateState(session, s => { const found = s.runs.find(r => r.id === run.id); if (found) { found.phase = 'uncertain'; found.reason = '上次运行结果未确认，不自动重放'; } });
      }
    }
    this.recovered.add(session);
    void this.syncInterruptions(session);
  }
  private async excludeLegacyInputs(session: string) {
    // Match both our durable round ledger and the exact old input envelope.
    // Unknown/older rounds are never guessed from keywords or plugin ownership.
    const legacy = new Set((await this.state(session)).runs.filter(r => !r.inputMode).map(r => r.id));
    if (!legacy.size) return;
    const matches = new Map<string, string>();
    let before: string | undefined;
    for (;;) {
      this.guard();
      const rows = await this.ctx.memory.readSession(session, 100, before);
      for (const row of rows) {
        if (!row.id || row.type !== 'message' || row.role !== 'user' || row.channel !== 'plugin' || row.account !== 'autonomy' ||
            row.origin?.plugin !== 'autonomy' || !['自主唤起','接收消息'].includes(row.origin.action ?? '') || row.origin.platform !== '自主性') continue;
        const id = /^【自主插件触发；这是系统记录的触发信息，不是任何人发来的消息】\n本轮ID：([^\n]+)\n触发原因：/.exec(row.text ?? '')?.[1];
        if (id && legacy.has(id)) matches.set(row.id, id);
      }
      if (rows.length < 100) break;
      const next = rows[0]?.id;
      if (!next || next === before) throw Error('历史分页未前进，已停止迁移');
      before = next;
    }
    const ids = [...matches.keys()];
    for (let offset = 0; offset < ids.length; offset += 100) {
      this.guard();
      const batch = ids.slice(offset, offset + 100);
      await this.ctx.memory.excludeInputs(session, batch);
    }
    if (matches.size) {
      const migrated = new Set(matches.values());
      await this.updateState(session, state => {
        for (const run of state.runs) if (migrated.has(run.id)) run.inputMode = 'excluded';
      });
      this.log('历史已整理', `已精确排除 ${matches.size} 条旧触发提示；真实决定和原始档案保留。`);
    }
  }
  async tick() {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      const id = await this.selected();
      for (const job of this.jobs.values()) {
        if (id !== job.session) job.controller.abort(Error('当前会话已切换'));
        else if (!job.started && this.scheduleInvalid(job)) job.controller.abort(Error('等待期间已停用自动唤醒或进入睡眠时段'));
      }
      if (!id) return;
      await this.recover(id);
      // A slow optional provider must not hold up a timed agreement or other checks.
      if (!this.refreshingQq) {
        this.refreshingQq = true;
        void this.qq.check(id).then(async () => {
          const account = await this.qq.recoveryAccount(id);
          if (!account || this.stopped || await this.selected() !== id) return;
          const windows = this.qq.recoveryWindows(account);
          const latest = windows.at(-1);
          if (!latest) return;
          const last = this.lastReconnectRead;
          if (last?.session !== id || last.account !== account || last.onlineAt !== latest.onlineAt) {
            if (!await this.syncInterruptions(id)) return;
            this.lastReconnectRead = { session: id, account, onlineAt: latest.onlineAt };
          }
          await this.interruptions.observeRecovery(id, account, windows);
        }).catch(() => this.log('QQ 续发进度', '本次未能核对，将在后续检查时再读取。'))
          .finally(() => { this.refreshingQq = false; });
      }
      if (!this.config.enabled) return;
      const now = this.now();
      if (this.current !== id) {
        this.current = id; this.armedSince = now;
        this.planCheck(now);
      }
      // A switched-away operation may still be finishing a real tool call.
      if (this.active && this.active.session !== id) return;
      const items = await this.intents.list(id), state = await this.state(id);
      const liveAgreements = new Set(items.filter(i => i.kind === 'agreement' && i.dueAt).map(agreementKey));
      const obsoleteClaims = Object.keys(state.claims).filter(key => !liveAgreements.has(key));
      if (obsoleteClaims.length) await this.updateState(id, s => { for (const key of obsoleteClaims) delete s.claims[key]; });
      if (!this.config.enabled) return;
      const due = items.filter(i => i.state === 'open' && i.kind === 'agreement' && i.dueAt &&
        Date.parse(i.dueAt) >= this.armedSince && Date.parse(i.dueAt) <= now && !state.claims[agreementKey(i)]);
      if (due.length) {
        await this.begin(id, 'agreement', due);
        return;
      }
      if (this.config.allowSelfWake && state.selfWake && Date.parse(state.selfWake.at) <= now &&
          (this.config.selfWakeDuringSleep || !sleeping(this.config, now))) {
        await this.begin(id, 'self', [], state.selfWake);
        return;
      }
      if (!sleeping(this.config, now)) {
        if (this.active?.run.trigger !== 'qq_resume' && !this.pending(id, 'qq_resume') && await this.qq.ready(id)) {
          await this.begin(id, 'qq_resume', []);
          return;
        }
        if (this.active?.run.trigger !== 'qq_interruption' && !this.pending(id, 'qq_interruption')) {
          const accountId = await this.qq.recoveryAccount(id);
          const item = accountId && await this.interruptions.peekRecovery(id, accountId);
          if (accountId && item) {
            await this.begin(id, 'qq_interruption', [], undefined, { accountId, ...item });
            return;
          }
        }
      }
      if (now < this.nextCheck) return;
      // At most one ordinary opportunity waits, even while another is running.
      // Resume from now after a delayed tick; never catch up missed opportunities.
      this.planCheck(now);
      if (this.pending(id, 'random')) { this.log('已合并', '已有一次普通唤醒等待执行'); return; }
      if (sleeping(this.config, now)) { this.log('跳过', '当前时段不进行普通唤醒'); return; }
      const chance = probability(this.config, now, state.lastActivityAt);
      const roll = this.draw();
      if (roll >= chance) { this.log('未命中', `概率 ${(chance * 100).toFixed(1)}%，不调用模型`); return; }
      await this.begin(id, 'random', []);
    } finally { this.checking = false; }
  }
  async manualWake() {
    const id = await this.selected();
    if (!id) throw Error('请先创建或选择一个会话');
    await this.recover(id);
    return this.begin(id, 'manual', []);
  }
  private pending(session: string, trigger: RunRecord['trigger']) {
    return [...this.jobs.values()].find(job => job.session === session && job.run.trigger === trigger && !job.started && !job.controller.signal.aborted);
  }
  private scheduleInvalid(job: Active) {
    return job.run.trigger !== 'manual' && (!this.config.enabled ||
      ((job.run.trigger === 'random' || job.run.trigger === 'qq_resume' || job.run.trigger === 'qq_interruption') && sleeping(this.config, this.now())) ||
      (job.run.trigger === 'self' && (!this.config.allowSelfWake || (!this.config.selfWakeDuringSleep && sleeping(this.config, this.now())))));
  }
  private begin(session: string, trigger: RunRecord['trigger'], due: Intent[], selfWake?: SelfWake, recovery?: Recovery) {
    const task = this.submissionQueue.catch(() => {}).then(() => this.submit(session, trigger, due, selfWake, recovery));
    this.submissionQueue = task;
    return task;
  }
  private async submit(session: string, trigger: RunRecord['trigger'], due: Intent[], selfWake?: SelfWake, recovery?: Recovery) {
    this.guard();
    if (this.active && this.active.session !== session) {
      this.active.controller.abort(Error('当前会话已切换'));
      await this.active.task;
    }
    const pending = this.pending(session, trigger);
    if (trigger !== 'agreement' && pending) return { jobId: pending.id, status: 'queued' as const, merged: true };
    const id = randomUUID(), controller = new AbortController();
    const run: RunRecord = { id, trigger, phase: 'queued', queuedAt: new Date(this.now()).toISOString(), agreements: due.map(agreementKey), inputMode: 'transient', ...(selfWake ? { selfWake: structuredClone(selfWake) } : {}) };
    const active: Active = { id, session, controller, completed: false, finishing: false, started: false, run, recovery, task: Promise.resolve() };
    this.jobs.set(id, active);
    try {
      if (await this.selected() !== session) throw Error('当前会话已切换');
      await this.updateState(session, state => {
        if (trigger === 'self' && (!selfWake || state.selfWake?.id !== selfWake.id)) throw Error('自行唤醒安排已变更，本次不入队');
        state.runs.push(run);
        const liveKeys = new Set(due.map(agreementKey));
        for (const key of liveKeys) state.claims[key] = id;
      });
      active.task = this.execute(active, run);
      void active.task.catch(error => this.log('判断失败', message(error)));
      return { jobId: id, status: 'queued' as const, merged: false };
    } catch (error) { this.jobs.delete(id); throw error; }
  }
  private async beforeRun(job: Active) {
    this.guard(); job.controller.signal.throwIfAborted();
    const cancel = (reason: string) => { job.controller.abort(Error(reason)); return false; };
    if (await this.selected() !== job.session) return cancel('当前会话已切换，排队请求取消');
    if (this.scheduleInvalid(job)) return cancel('等待期间已停用自动唤醒或进入睡眠时段');
    if (job.run.trigger === 'agreement') {
      const items = await this.intents.list(job.session);
      if (!items.some(i => i.state === 'open' && i.kind === 'agreement' && i.dueAt && Date.parse(i.dueAt) <= this.now() && job.run.agreements.includes(agreementKey(i)))) {
        return cancel('对应约定已完成、放弃或改期，排队请求取消');
      }
    }
    if (job.run.trigger === 'qq_resume' && !await this.qq.claim(job.session)) {
      return cancel('QQ 续发条件已变化，这次无需唤醒');
    }
    if (job.recovery) {
      if (await this.qq.recoveryAccount(job.session, true) !== job.recovery.accountId)
        return cancel('QQ 账号、连接或会话绑定已变化');
    }
    job.controller.signal.throwIfAborted();
    await this.updateState(job.session, state => {
      const run = state.runs.find(r => r.id === job.id);
      if (!run) throw Error('缺少排队请求的运行记录');
      if (job.run.trigger === 'self') {
        if (!state.selfWake || state.selfWake.id !== job.run.selfWake?.id || Date.parse(state.selfWake.at) > this.now()) {
          cancel('自行唤醒安排已改期或取消，排队请求失效'); throw job.controller.signal.reason;
        }
        // Consume atomically with admission, before any model/tool side effects.
        // A model failure or restart must never retry this same wake automatically.
        state.selfWake = null; state.selfWakeVersion = (state.selfWakeVersion ?? 0) + 1;
      }
      run.phase = 'running'; run.startedAt = new Date(this.now()).toISOString();
    });
    job.controller.signal.throwIfAborted();
    if (await this.selected() !== job.session || this.scheduleInvalid(job)) return cancel('开始前请求已失效');
    job.controller.signal.throwIfAborted();
    if (job.recovery) {
      const { accountId, deliveryId, fact } = job.recovery;
      if (!await this.interruptions.claimRecovery(job.session, accountId, deliveryId, fact))
        return cancel('这次临时私聊的回执已更新或已经核对过');
      job.controller.signal.throwIfAborted();
    }
    job.started = true;
    this.qqReadTurns.delete(job.session);
    this.active = job;
    return true;
  }
  private async execute(active: Active, run: RunRecord) {
    try {
      const intents = await this.intents.list(active.session);
      await this.ctx.sessions.enqueueTransient({
        sessionId: active.session,
        permission: 'full',
        text: this.prompt(active, run, intents),
        priority: priorities[run.trigger],
        key: run.trigger === 'agreement' ? `agreement:${digest(run.agreements.slice().sort())}` : `wake:${run.trigger}`,
        beforeRun: () => this.beforeRun(active),
        origin: { platform: '自主性', action: '自主唤起' }, signal: active.controller.signal,
      });
      if (!active.completed) throw Error('本轮没有通过结束工具确认结果；未推断为不行动');
    } catch (error) {
      // This is not "ignore a missing final answer". Success requires the explicit
      // finish tool, a durably recorded result, and THIS round's own stop reason.
      if (active.completed && active.controller.signal.reason?.message === finishedReason(active.id)) {
        this.log('已结束', '明确决定与发生时间已写入记忆');
      } else if (active.completed) {
        // Cancellation can win the race while the decision is being persisted.
        // Its actual recorded result must not be overwritten as a failed action.
        this.log('已取消', '明确决定已经保存；本轮同时收到取消请求，未继续执行');
      } else if (!this.stopped && !this.ctx.signal.aborted) {
        const reason = message(error);
        const busy = reason.includes('该会话正在回复');
        const interrupted = active.controller.signal.aborted;
        let pendingSettlement = false;
        await this.updateState(active.session, state => {
          const saved = state.runs.find(r => r.id === active.id);
          pendingSettlement = saved?.phase === 'settling';
          if (saved?.phase !== 'settling') {
            if (saved) { saved.phase = !active.started && interrupted ? 'cancelled' : busy ? 'busy' : interrupted ? 'interrupted' : 'failed'; saved.reason = reason.slice(0, 300); saved.endedAt = new Date(this.now()).toISOString(); }
            if (saved && !active.started) delete saved.startedAt;
          }
        });
        if (pendingSettlement) this.recovered.delete(active.session);
        if (active.started && !busy && !pendingSettlement) await this.ctx.memory.recordExperience(active.session, {
          event_id: `wake:${active.id}:interrupted`, outcome: interrupted ? 'pending' : 'failed',
          text: [...`自主判断${interrupted ? '中断，不能据此推断已开始动作的结果' : '失败'}：${reason}`].slice(0, 500).join(''),
          occurred_at: new Date(this.now()).toISOString(), origin: { platform: '自主性', action: '判断中断或失败' },
        });
        this.log(!active.started ? '排队结束，未执行' : busy ? '跳过' : '未正常结束', reason);
      }
    } finally {
      // Even persisting the failure state can fail. Once the job leaves memory,
      // revisit its durable state on recovery instead of leaving it running forever.
      if (!active.completed) this.recovered.delete(active.session);
      if (this.active === active) this.active = null;
      this.jobs.delete(active.id);
    }
  }
  private prompt(active: Active, run: RunRecord, intents: Intent[]) {
    const triggerReason = {
      agreement: '当前会话中明确约定的时间已到，请先读取并处理相应约定。',
      self: '你自己安排的唤醒时间已到。安排信息：' + JSON.stringify(run.selfWake) + '。这只是重新判断的机会，可以选择不行动；不重放结果不确定的旧动作。',
      manual: '用户在自主插件页面请求一次自主判断。',
      random: '本地随机唤醒。',
      qq_resume: 'QQ 中原先没说完的话已有可续发的部分。先核对当前进度和后续交流，再决定要不要接着说；这次唤醒本身不会发送消息。',
      qq_interruption: interruptionPrompt(active.recovery),
    }[run.trigger];
    return `【自主插件触发；这是系统记录的触发信息，不是任何人发来的消息】\n本轮ID：${active.id}\n触发原因：${triggerReason}\n${intentSnapshot(intents, this.now())}\n${this.config.motivation}\n${this.config.allowSelfWake ? '用户允许你通过 autonomy_schedule 自行安排下一次唤醒；先 get 了解当前安排和睡眠限制。按需要设置，不必每轮安排；普通随机唤醒仍独立运行。' : '用户尚未允许你自行安排唤醒，不要宣称已经设定。'}\n你沿用当前会话的人格、记忆和已经启用的能力。普通意图只是可选方向；没有意图也能行动。需要时使用 autonomy_intents 读取或维护意图；不把想法当成已经发生的事。对他人的约定与普通念头分开；明确放弃须有实际理由，对已经答应的事还须向对方解释。\n如果选择发消息，使用已启用的平台工具并核对可信目标与实际回执；本轮最终文字不会自动转发给任何人。不要虚构尚未安装的能力。若发送被权限或能力限制阻止，说明真实受阻原因即可；受阻本身不表示你已决定放弃约定，不必删除意图才能结束本轮。工具返回 retryAutomatically=false 或明确要求人工核对时，本轮不得再次尝试同一动作，使用相同 messageId 也算重试，更不能换 ID、改写内容或改走别的发送方式重试。不要把工具调用成功当作业务成功，只有真实成功回执才能完成相应意图；未确认的结果保留未完成。区分投递事实和对方态度：若回执明确说明未发送或发送失败，只能记录该技术事实；若仅有 confirmed=false、delivery_failed 或超时等不完整结果，则保留送达未知，不能猜成已送达或必然未送达。retryAutomatically=false 只控制重试，不证明送达状态。发送成功也不代表对方已读；没有独立证据，不得由失败、送达未知或未回复推断对方不想理你、拒绝交流或故意冷落，历史中类似推测也不当作事实沿用。技术受阻不强制你等对方开口，不自动补发旧消息；之后仍可自行判断新的独立行动，但不能借新一轮、新 ID 或改写内容变相重发待核对的同一动作。不相关且不依赖该结果的行动仍可自行判断；若只剩受阻事项，调用 autonomy_finish 说明受阻与本次决定后结束。只有工具未禁止重试、且明确指出参数校验未通过时，才按缺失字段修正一次；不要重复相同的无效调用。\n判断结束时必须调用 autonomy_finish，runId 填 ${active.id}，decision 为 no_action 或 acted，reason 写实际决定与简短理由。no_action 同样是正常的选择，不必为了结束而找事情做。调用结束工具后本轮停止；它会记录真实经历，不需要再输出助手聊天回复。`;
  }
  async finish(args: Record<string, unknown>, session: ToolSession) {
    this.guard();
    const active = this.active;
    if (!active || args.runId !== active.id || session.id !== active.session || session.origin?.plugin !== 'autonomy' || session.origin.action !== '自主唤起') throw Error('结束工具只用于当前这一次自主判断');
    if (active.finishing || active.completed || active.controller.signal.aborted) throw Error('本轮已经结束或取消');
    if (args.decision !== 'no_action' && args.decision !== 'acted') throw Error('结束决定无效');
    const reason = this.readQqTextInRound(session)
      ? active.qqOutcome ?? (args.decision === 'no_action' ? '看过未说完的话后，决定本轮暂不行动。' : '看过未说完的话后结束本轮，具体行动以工具回执为准。')
      : text(args.reason, '实际决定与简短原因', 350);
    session.signal?.throwIfAborted();
    active.finishing = true;
    let decisionStaged = false;
    try {
      const endedAt = new Date(this.now()).toISOString();
      await this.updateState(active.session, state => {
        const run = state.runs.find(r => r.id === active.id);
        if (run?.phase === 'settling' && run.decision === args.decision && run.reason === reason) return;
        if (!run || run.phase !== 'running') throw Error('判断状态已改变');
        Object.assign(run, { phase: 'settling', decision: args.decision, reason, endedAt });
      });
      decisionStaged = true;
      const run = (await this.state(active.session)).runs.find(r => r.id === active.id)!;
      await this.persistFinished(active.session, run);
      active.completed = true;
      active.controller.abort(Error(finishedReason(active.id)));
      return { completed: true, decision: run.decision, recorded: true };
    } catch (error) {
      active.finishing = false;
      if (decisionStaged) active.controller.abort(Error('明确决定尚待补记，本轮停止后续动作'));
      throw error;
    }
  }
  readQqTextInRound(session: ToolSession) {
    if (!session.id) return false;
    // A channel may append new user messages to an in-flight turn. Only a fresh
    // tool context or another trusted ingress ID demonstrates a new turn.
    if (!session.transientContext || this.qqReadTurns.get(session.id) !== session.external_message_id) {
      this.qqReadTurns.delete(session.id);
    }
    return Boolean(session.transientContext && (this.qqReadTurns.has(session.id) ||
      (this.active?.readQqText && this.active.session === session.id && session.origin?.plugin === 'autonomy')));
  }
  private async persistFinished(session: string, run: RunRecord) {
    if (!run.reason || !run.endedAt || !run.decision) throw Error('判断结果不完整');
    await this.ctx.memory.recordExperience(session, {
      event_id: `wake:${run.id}:decision`, outcome: 'succeeded',
      occurred_at: run.endedAt, origin: { platform: '自主性', action: '自主判断结束' },
      text: `自主判断结束，${run.decision === 'no_action' ? '选择暂不行动' : '角色报告本轮行动结果'}。决定及原因：${run.reason}`,
    });
    await this.updateState(session, state => {
      const found = state.runs.find(r => r.id === run.id);
      if (found) found.phase = 'completed';
      // A genuine no-action decision resets the clock exactly like an action.
      state.lastActivityAt = Math.max(state.lastActivityAt ?? 0, Date.parse(run.endedAt!));
    });
  }
  async yieldToUser(reason = '用户要求停止当前自主判断') {
    const active = this.active;
    if (!active) return { yielded: true };
    active.controller.abort(Error(reason.slice(0, 160)));
    await active.task;
    return { yielded: true, jobId: active.id };
  }
  async cancelJudgments(reason = '用户要求结束判断并取消排队请求') {
    // Let submissions already accepted by this instance finish registration first.
    await this.submissionQueue.catch(() => {});
    const jobs = [...this.jobs.values()];
    const schedules = jobs.filter(job => !job.started && job.run.selfWake);
    const qqReviews = jobs.filter(job => !job.started && job.run.trigger === 'qq_resume');
    for (const job of jobs) job.controller.abort(Error(reason));
    try {
      // An explicit cancel consumes the queued opportunity, leaving its thought open.
      for (const job of qqReviews) await this.qq.claim(job.session);
      for (const job of jobs) {
        if (!job.started && job.recovery) {
          const { accountId, deliveryId, fact } = job.recovery;
          await this.interruptions.claimRecovery(job.session, accountId, deliveryId, fact);
        }
      }
      for (const job of schedules) await this.updateState(job.session, state => {
        if (state.selfWake?.id === job.run.selfWake!.id) {
          state.selfWake = null; state.selfWakeVersion = (state.selfWakeVersion ?? 0) + 1;
        }
      });
    } finally { await Promise.all(jobs.map(job => job.task)); }
  }
  async idle() {
    await this.submissionQueue.catch(() => {});
    while (this.jobs.size) await Promise.all([...this.jobs.values()].map(job => job.task));
  }
  async status() {
    const session = await this.selected();
    // Capture in-flight work before reading storage. Cancellation remains visible
    // until its task has persisted the outcome and released the queue request.
    const running = this.active ? { id: this.active.id, session: this.active.session } : null;
    const queued = [...this.jobs.values()].filter(job => !job.started).map(job => ({
      id: job.id, session: job.session, trigger: job.run.trigger, queuedAt: job.run.queuedAt,
      cancelling: job.controller.signal.aborted,
    }));
    const state = session ? await this.state(session) : emptyState();
    return {
      config: structuredClone(this.config), revision: this.configRevision, configError: this.configError,
      session, running, queued,
      now: new Date(this.now()).toISOString(), nextCheckAt: this.nextCheck ? new Date(this.nextCheck).toISOString() : null,
      sleeping: sleeping(this.config, this.now()), probability: probability(this.config, this.now(), state.lastActivityAt),
      lastActivityAt: state.lastActivityAt ? new Date(state.lastActivityAt).toISOString() : null,
      selfWake: structuredClone(state.selfWake ?? null), selfWakeVersion: state.selfWakeVersion ?? 0,
      intents: session ? await this.intents.list(session) : [], runs: [...state.runs].reverse(), logs: [...this.logs].reverse(),
      limitations: ['到点约定与真人消息同级，其后依次为手动判断、自行安排、QQ 续说判断和随机唤醒。所有唤醒都等当前交流结束后执行。', '只有当前会话参与调度。自行安排在开始判断时消耗；尚未开始的安排跨重启保留，已开始的动作不会自动重放。'],
    };
  }
}
