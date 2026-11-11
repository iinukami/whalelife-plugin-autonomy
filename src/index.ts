/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context, ToolSession } from 'whalelife';
import { Autonomy } from './runtime.ts';
import { registerWeb } from './web.ts';
import { IntentInputError } from './storage.ts';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function apply(ctx: Context) {
  const runtime = new Autonomy(ctx);
  await runtime.initialize();
  const currentToolSession = (session: ToolSession) => {
    if (!session.id) throw Error('工具调用缺少所属会话');
    session.signal?.throwIfAborted();
    return session.id;
  };
  ctx.tools.register({
    name: 'autonomy_schedule', danger: 'safe', origin: { platform: '自主性', action: '安排自行唤醒' },
    description: '查看、设置或取消当前会话的下一次自行唤醒，普通交流和自主轮次都可使用。先 get 获取 version、现有安排、用户开关和睡眠规则；set/cancel 必填 requestId 和 version。set 使用未来带时区 ISO 时间 at 和自己的简短 reason，同一会话只保留一个安排，重新设置会替换原安排。用户须开启自动唤醒及自行安排开关；默认不能设在睡眠时段，只有用户开启睡眠例外才可突破，失败时向用户说明真实原因。到点唤醒不掷骰子，排队等待当前交流结束；这是再次判断的机会，行动仍由你决定，可以不行动，也不必每轮都安排。不是向用户承诺已经执行，不把普通念头伪装为对外约定。一次性安排在开始判断时消耗，之后不会因失败而重放。改期/取消须使用最新 version；同一操作重试保留 requestId。reason 仅写自己的目的，不复制临时外部正文或过期引用。不能用此工具安排盲目重发结果不确定的旧动作。',
    schema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['get','set','cancel'] },
      requestId: { type: 'string', maxLength: 100, description: 'set/cancel 必填，当前操作的稳定ID' },
      version: { type: 'integer', minimum: 0, description: 'set/cancel 必填，get 返回的版本号' },
      at: { type: 'string', description: 'set 必填，未来带时区 ISO 时间，例如 2030-01-02T20:00:00+08:00' },
      reason: { type: 'string', maxLength: 140, description: 'set 必填，自己为什么想在这个时间再醒来判断，不能复制外部资料' },
    } },
    run: async (args: Record<string, unknown>, session) => {
      try { return { ok: true, ...await runtime.scheduleSelfWake(currentToolSession(session), args) }; }
      catch (error) { return { ok: false, error: errorText(error) }; }
    },
  });
  ctx.tools.register({
    name: 'autonomy_intents', danger: 'safe', origin: { platform: '自主性', action: '管理会话意图' },
    description: '读取或管理当前会话的可选意图；普通聊天也可形成意图，意图不是行动前提，也不表示行动已经发生。先 list 获取 intentId 与 version。remember 必填 requestId/kind/text/source/evidence；revise 是完整修订，另必填 intentId/version；complete 和 abandon 必填 requestId/intentId/version/reason/evidence，reason 与 evidence 是两个独立必填字段。只有与他人的明确时间约定可设 dueAt，普通打算使用 preferredAt；产生时间由程序记录。计划时间经过仍未完成，不能推断失效或已做过；暂缓可 revise 改期或将 preferredAt 设为 null，继续保留念头。完成须有真实结果，放弃须有真实原因和依据，对已答应的事还须实际向对方解释。暂时受阻不等于完成或放弃，无需为了结束自主轮次而删除意图。参数错误时按 fields/missingFields 修正，不能只反复缩短 reason。',
    schema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list','remember','revise','complete','abandon'] },
      requestId: { type: 'string', maxLength: 100, description: '变更必填。同一操作重试用同一ID；参数校验未通过时可补齐后沿用，已接受的操作不可用同一ID更改内容' },
      intentId: { type: 'string', description: 'revise/complete/abandon 必填，使用 list 返回的 id' }, version: { type: 'integer', minimum: 1, description: 'revise/complete/abandon 必填，使用 list 返回的 version' },
      kind: { type: 'string', enum: ['thought','agreement'] }, text: { type: 'string', maxLength: 300 },
      source: { type: 'string', enum: ['self','conversation'] },
      evidence: { type: 'string', maxLength: 200, description: '所有变更必填，与 reason 分开填写。remember/revise 为形成依据（1–200字）；complete/abandon 为实际完成/明确放弃的事实依据（1–140字）。不要编造外部成功' },
      preferredAt: { type: ['string','null'], description: '普通打算的计划参考时间，带时区ISO；null取消具体时间并保留念头。不会强制唤醒，超过时间仍未完成' },
      dueAt: { type: ['string','null'], description: '与他人的明确时间约定，带时区ISO；到点唤醒当前会话，不代表约定已经完成' },
      reason: { type: 'string', maxLength: 140, description: 'complete/abandon 必填，实际结果与原因（1–140字）；还须单独填写 evidence' },
    } },
    run: async (args: Record<string, unknown>, session) => {
      try { return { ok: true, ...await runtime.intents.change(currentToolSession(session), args) as object }; }
      catch (error) { return { ok: false, error: errorText(error), ...(error instanceof IntentInputError ? {
        code: error.code, fields: error.fields, requiredFields: error.requiredFields,
        ...(error.code === 'missing_fields' ? { missingFields: error.fields } : {}),
      } : {}) }; }
    },
  });
  ctx.tools.register({
    name: 'autonomy_finish', danger: 'safe', origin: { platform: '自主性', action: '结束自主判断' },
    description: '明确结束当前自主插件唤起的这一轮。可选择 no_action（暂不行动）或 acted（说明真实行动结果）。两者都会记录发生时间与简短原因，并重置活动计时。没有事想做就正常选择 no_action；不要为了结束而制造行动。仅用于自主唤起，不用于正常用户对话。记录成功后停止本轮后续请求。',
    schema: { type: 'object', additionalProperties: false, required: ['runId','decision','reason'], properties: {
      runId: { type: 'string' }, decision: { type: 'string', enum: ['no_action','acted'] },
      reason: { type: 'string', description: '实际决定、投递事实与简短原因；发送失败或送达未知不等于对方不想回复，不把推测写成事实，不输出完整推演过程' },
    } },
    run: async (args: Record<string, unknown>, session) => {
      try { return { ok: true, ...await runtime.finish(args, session) }; }
      catch (error) { return { ok: false, error: errorText(error) }; }
    },
  });
  registerWeb(ctx, runtime);
  ctx.provide('autonomy', {
    apiVersion: '1.0.0',
    status: () => runtime.status(),
    // Cooperative ingress can explicitly request and await yielding. This does
    // not pretend existing Web/QQ ingress already invokes the service.
    yieldToUser: () => runtime.yieldToUser('收到交流请求，优先让路'),
  });
  return runtime;
}
