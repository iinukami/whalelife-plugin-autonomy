/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context, ToolSession, MemoryEvent } from 'whalelife';
import { randomUUID } from 'node:crypto';
import { defaults, settings, sleeping, probability, type Settings } from './config.ts';
import { Documents, Intents, digest, text, type Intent } from './storage.ts';

export type Decision = 'no_action' | 'acted';
export type Phase = 'queued' | 'cancelled' | 'running' | 'settling' | 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'busy';
export interface RunRecord {
  id: string; trigger: 'random' | 'agreement' | 'manual'; phase: Phase;
  queuedAt?: string; startedAt?: string; endedAt?: string; decision?: Decision; reason?: string;
  agreements: string[];
  inputMode?: 'transient' | 'excluded';
}
interface State { schema: 1; lastActivityAt: number | null; runs: RunRecord[]; claims: Record<string, string>; }
const emptyState = (): State => ({ schema: 1, lastActivityAt: null, runs: [], claims: {} });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const agreementKey = (i: Intent) => `${i.id}:${i.dueAt}`;
const finishedReason = (id: string) => `autonomy-finished:${id}`;
// Human messages use 0. Timed agreements share that FIFO lane; less urgent
// autonomous opportunities wait behind human messages and timed agreements.
const priorities = { agreement: 0, manual: -10, random: -20 };
interface Active {
  id: string; session: string; controller: AbortController; task: Promise<void>;
  completed: boolean; finishing: boolean; started: boolean; run: RunRecord;
}
export interface RuntimeOptions { now?: () => number; random?: () => number; timers?: boolean; }

export class Autonomy {
  readonly ctx: Context;
  readonly docs: Documents;
  readonly intents: Intents;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private configQueue: Promise<unknown> = Promise.resolve();
  private recovered = new Set<string>();
  private logs: { at: string; status: string; detail: string }[] = [];
  private timers: boolean;
  constructor(ctx: Context, options: RuntimeOptions = {}) {
    this.ctx = ctx; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.timers = options.timers !== false;
    this.docs = new Documents(ctx.memory); this.intents = new Intents(this.docs, this.now);
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
    this.ctx.on('channel/reply', event => this.observeMessage(event));
    this.ctx.on('tool/called', async event => {
      if (this.stopped || !event.session || event.source === 'autonomy' || !event.ok) return;
      await this.noteActivity(event.session).catch(error => this.log('记录失败', message(error)));
    });
    this.ctx.on('whalelife/ready', () => { if (this.timers) this.schedule(); });
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
    return data;
  }
  private async updateState(session: string, change: (state: State) => void) {
    this.guard();
    await this.docs.update(session, 'activity', emptyState, state => {
      if (state.schema !== 1 || !Array.isArray(state.runs)) throw Error('自主活动文档格式不受支持');
      change(state);
      const live = new Set(['queued', 'running', 'settling']);
      let finished = state.runs.filter(r => !live.has(r.phase)).length;
      state.runs = state.runs.filter(r => live.has(r.phase) || finished-- <= 80);
    });
  }
  async noteActivity(session: string) {
    const at = this.now();
    await this.updateState(session, state => { state.lastActivityAt = Math.max(at, state.lastActivityAt ?? 0); });
  }
  private async observeMessage(event: MemoryEvent) {
    if (this.stopped || !event.session || event.origin?.plugin === 'autonomy') return;
    await this.noteActivity(event.session).catch(error => this.log('记录失败', message(error)));
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
    return job.run.trigger !== 'manual' && (!this.config.enabled || (job.run.trigger === 'random' && sleeping(this.config, this.now())));
  }
  private begin(session: string, trigger: RunRecord['trigger'], due: Intent[]) {
    const task = this.submissionQueue.catch(() => {}).then(() => this.submit(session, trigger, due));
    this.submissionQueue = task;
    return task;
  }
  private async submit(session: string, trigger: RunRecord['trigger'], due: Intent[]) {
    this.guard();
    if (this.active && this.active.session !== session) {
      this.active.controller.abort(Error('当前会话已切换'));
      await this.active.task;
    }
    const pending = this.pending(session, trigger);
    if (trigger !== 'agreement' && pending) return { jobId: pending.id, status: 'queued' as const, merged: true };
    const id = randomUUID(), controller = new AbortController();
    const run: RunRecord = { id, trigger, phase: 'queued', queuedAt: new Date(this.now()).toISOString(), agreements: due.map(agreementKey), inputMode: 'transient' };
    const active: Active = { id, session, controller, completed: false, finishing: false, started: false, run, task: Promise.resolve() };
    this.jobs.set(id, active);
    try {
      if (await this.selected() !== session) throw Error('当前会话已切换');
      await this.updateState(session, state => {
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
    job.controller.signal.throwIfAborted();
    await this.updateState(job.session, state => {
      const run = state.runs.find(r => r.id === job.id);
      if (!run) throw Error('缺少排队请求的运行记录');
      run.phase = 'running'; run.startedAt = new Date(this.now()).toISOString();
    });
    job.controller.signal.throwIfAborted();
    if (await this.selected() !== job.session || this.scheduleInvalid(job)) return cancel('开始前请求已失效');
    job.controller.signal.throwIfAborted();
    job.started = true;
    this.active = job;
    return true;
  }
  private async execute(active: Active, run: RunRecord) {
    try {
      await this.ctx.sessions.enqueueTransient({
        sessionId: active.session,
        permission: 'full',
        text: this.prompt(active, run),
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
  private prompt(active: Active, run: RunRecord) {
    return `【自主插件触发；这是系统记录的触发信息，不是任何人发来的消息】\n本轮ID：${active.id}\n触发原因：${run.trigger === 'agreement' ? '当前会话中明确约定的时间已到，请先读取并处理相应约定。' : run.trigger === 'manual' ? '用户在自主插件页面请求一次自主判断。' : '本地随机唤醒。'}\n${this.config.motivation}\n你沿用当前会话的人格、记忆和已经启用的能力。普通意图只是可选方向；没有意图也能行动。需要时使用 autonomy_intents 读取或维护意图；不把想法当成已经发生的事。对他人的约定与普通念头分开；明确放弃须有实际理由，对已经答应的事还须向对方解释。\n如果选择发消息，使用已启用的平台工具并核对可信目标与实际回执；本轮最终文字不会自动转发给任何人。不要虚构尚未安装的能力。若发送被权限或能力限制阻止，说明真实受阻原因即可；受阻本身不表示你已决定放弃约定，不必删除意图才能结束本轮。工具返回 retryAutomatically=false 或明确要求人工核对时，本轮不得再次尝试同一动作，使用相同 messageId 也算重试，更不能换 ID、改写内容或改走别的发送方式重试。不要把工具调用成功当作业务成功，只有真实成功回执才能完成相应意图；未确认的结果保留未完成。区分投递事实和对方态度：若回执明确说明未发送或发送失败，只能记录该技术事实；若仅有 confirmed=false、delivery_failed 或超时等不完整结果，则保留送达未知，不能猜成已送达或必然未送达。retryAutomatically=false 只控制重试，不证明送达状态。发送成功也不代表对方已读；没有独立证据，不得由失败、送达未知或未回复推断对方不想理你、拒绝交流或故意冷落，历史中类似推测也不当作事实沿用。技术受阻不强制你等对方开口，不自动补发旧消息；之后仍可自行判断新的独立行动，但不能借新一轮、新 ID 或改写内容变相重发待核对的同一动作。不相关且不依赖该结果的行动仍可自行判断；若只剩受阻事项，调用 autonomy_finish 说明受阻与本次决定后结束。只有工具未禁止重试、且明确指出参数校验未通过时，才按缺失字段修正一次；不要重复相同的无效调用。\n判断结束时必须调用 autonomy_finish，runId 填 ${active.id}，decision 为 no_action 或 acted，reason 写实际决定与简短理由。no_action 同样是正常的选择，不必为了结束而找事情做。调用结束工具后本轮停止；它会记录真实经历，不需要再输出助手聊天回复。`;
  }
  async finish(args: Record<string, unknown>, session: ToolSession) {
    this.guard();
    const active = this.active;
    if (!active || args.runId !== active.id || session.id !== active.session || session.origin?.plugin !== 'autonomy' || session.origin.action !== '自主唤起') throw Error('结束工具只用于当前这一次自主判断');
    if (active.finishing || active.completed || active.controller.signal.aborted) throw Error('本轮已经结束或取消');
    if (args.decision !== 'no_action' && args.decision !== 'acted') throw Error('结束决定无效');
    const reason = text(args.reason, '实际决定与简短原因', 350);
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
    for (const job of jobs) job.controller.abort(Error(reason));
    await Promise.all(jobs.map(job => job.task));
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
      intents: session ? await this.intents.list(session) : [], runs: [...state.runs].reverse(), logs: [...this.logs].reverse(),
      limitations: ['与网页和渠道共用会话队列，不中断正在进行的交流；到点约定与真人消息同级，手动判断其次，普通唤醒最后。', '排队只在当前实例有效；取消、停用和重启不补发旧请求。只有当前会话参与调度。'],
    };
  }
}
