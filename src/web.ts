/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context } from 'whalelife';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Autonomy } from './runtime.ts';

const base = '/plugins/autonomy/';
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw Error('请使用 JSON 请求');
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.byteLength; if (size > 16384) throw Error('请求过大'); parts.push(part);
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('请求格式无效');
  return value;
}
export function registerWeb(ctx: Context, runtime: Autonomy) {
  ctx.web.page(base + 'settings', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store'); res.end(html);
  }, { title: '自主性', settings: true, navigation: true });
  ctx.web.page(base + 'ui.js', (_req, res) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(script);
  });
  // The public router maps page() to GET and api() to POST.
  ctx.web.page(base + 'state', async (_req, res, { signal }) => {
    try { signal.throwIfAborted(); send(res, 200, await runtime.status()); }
    catch (error) { send(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  ctx.web.api(base + 'state', async (req, res, { signal }) => {
    try {
      signal.throwIfAborted();
      if (req.method !== 'POST') return send(res, 405, { error: '不支持的请求方法' });
      const input = await body(req); signal.throwIfAborted();
      if (input.action === 'configure') {
        await runtime.configure(input.config, input.revision);
        return send(res, 200, await runtime.status());
      }
      const session = await runtime.selected();
      if (!session || session !== input.session) return send(res, 409, { error: '当前会话已经变化，请刷新后再操作' });
      if (input.action === 'cancelSelfWake') {
        await runtime.scheduleSelfWake(session, { action: 'cancel', requestId: input.requestId, version: input.version });
        return send(res, 200, await runtime.status());
      }
      if (input.action === 'wake') return send(res, 202, await runtime.manualWake());
      if (input.action === 'stop') {
        // Respond with a job acknowledgement; shutdown must not occupy an HTTP
        // handler for a possibly slow external tool.
        void runtime.cancelJudgments().catch(error => ctx.logger.warn('手动结束自主判断未完成', { error: String(error) }));
        return send(res, 202, { status: 'stopping' });
      }
      return send(res, 400, { error: '操作无效' });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自主性</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f7;--panel:#fff;--ink:#192a32;--muted:#60717a;--border:#d9e1e4;--brand:#176b72}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,sans-serif}main{max-width:1050px;margin:auto;padding:28px 24px 60px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px}h1{font-size:28px;margin:0 0 5px}h2{font-size:18px;margin:0 0 14px}h3{font-size:15px;margin:0 0 8px}p{margin:6px 0}.muted,small{color:var(--muted)}.grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:18px}.card{background:var(--panel);border:1px solid var(--border);border-radius:15px;padding:22px;margin-bottom:18px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:grid;gap:6px;margin-bottom:14px}input,select,textarea,button{font:inherit}input:not([type=checkbox]),select,textarea{width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--ink)}textarea{resize:vertical;min-height:108px}button{border:1px solid var(--border);border-radius:8px;padding:8px 14px;background:var(--panel);color:var(--ink);cursor:pointer}button.primary{background:var(--brand);border-color:var(--brand);color:white}button:disabled{opacity:.5;cursor:wait}.actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.badge{display:inline-block;border-radius:99px;padding:4px 12px;background:#dcefed;color:#205b59;white-space:nowrap}.wide{grid-column:1/-1}.rule{padding:11px 0;border-bottom:1px solid var(--border)}.rule:last-child{border:0}.intent{padding:12px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.intent:last-child{border:0}.intent p{white-space:pre-wrap}.empty{padding:15px 0;color:var(--muted)}.sleep{display:grid;grid-template-columns:1fr 1fr auto;gap:9px;margin:8px 0}.summary{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stat{padding:12px;border-radius:9px;background:var(--bg)}.stat strong{display:block;font-size:20px}#notice{min-height:25px;color:var(--brand);white-space:pre-wrap}details{margin-top:12px}.warn{border-left:3px solid #bf8742;padding-left:12px;color:var(--muted)}@media(max-width:720px){.grid,.fields{grid-template-columns:1fr}header{display:block}header .badge{margin-top:12px}main{padding:18px 14px}}@media(prefers-color-scheme:dark){:root{--bg:#121b20;--panel:#1b272e;--ink:#e8eff2;--muted:#a0b3bd;--border:#35464e;--brand:#278b91}.badge{background:#254544;color:#b0e1db}}
.sleep-card{--sleep-accent:#5a668e;--sleep-soft:#f1f3f9;border:1px solid var(--border);padding:24px}.sleep-heading{display:flex;align-items:center;gap:13px;margin-bottom:14px}.moon{display:grid;place-items:center;width:44px;height:44px;flex:none;border-radius:14px;background:var(--sleep-soft);color:var(--sleep-accent)}.moon svg{width:23px;height:23px}.sleep-heading h2{margin:0;font-size:20px}.sleep-kicker{font-size:11px;letter-spacing:2px;color:var(--muted)}.sleep-count{margin-left:auto;font-size:12px;white-space:nowrap;color:var(--sleep-accent);background:var(--sleep-soft);border-radius:20px;padding:4px 10px}.sleep-description{color:var(--muted);font-size:13px;margin:0 0 18px}.sleep-timezone{display:flex;align-items:center;gap:16px;padding:12px 0 18px;border-top:1px solid var(--border);font-size:13px}.sleep-timezone span{white-space:nowrap;color:var(--muted)}.sleep-timezone input{min-width:0;font-size:13px;padding:7px 10px!important}.sleep-list{display:grid;gap:12px}.sleep-row{border:1px solid var(--border);border-radius:13px;padding:16px;background:var(--bg);min-width:0}.sleep-row-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:13px}.sleep-title{font-size:14px}.sleep-remove{font-size:12px;border:0;background:transparent;padding:3px 7px;color:var(--muted)}.sleep-remove:hover{color:#b44949;background:#b4494910}.sleep-range{display:grid;grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr);gap:8px;align-items:end;margin-bottom:12px}.sleep-range label{display:grid;gap:5px;min-width:0;font-size:12px;color:var(--muted)}.sleep-range input,.sleep-range select{min-width:0;width:100%;box-sizing:border-box;font-size:14px;color:var(--ink);padding:8px 9px}.sleep-range .to{color:var(--muted);align-self:end;line-height:40px;text-align:center}.sleep-days{display:flex;gap:5px;margin:4px 0 12px}.sleep-day{flex:1;text-align:center;font-size:11px;padding:3px 0;color:var(--muted);border-radius:5px;background:var(--panel)}.sleep-day.selected{background:var(--sleep-accent);color:#fff}.sleep-preview{margin:0;padding-top:10px;border-top:1px solid var(--border);color:var(--sleep-accent);font-size:12px;line-height:1.7}.sleep-empty{border:1px dashed var(--border);border-radius:13px;padding:28px 18px;text-align:center;background:var(--bg)}.sleep-empty strong{display:block;font-size:15px;margin-bottom:5px}.sleep-empty p{font-size:13px;color:var(--muted);margin:0}.sleep-add{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:14px}.sleep-add button{font-size:12px;padding:7px 10px}.sleep-add #addSleep{border-color:var(--sleep-accent);color:var(--sleep-accent)}.sleep-note{margin-top:17px;font-size:12px;color:var(--muted);line-height:1.8}.sleep-note p{margin:6px 0}.sleep-note strong{font-weight:600;color:var(--ink)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #60a2ad70;outline-offset:2px}[hidden]{display:none!important}
@media(max-width:960px){.grid{grid-template-columns:1fr}.sleep-card{padding:20px}.sleep-timezone{max-width:450px}}@media(max-width:420px){main{padding:16px 12px}.sleep-card{padding:16px}.sleep-row{padding:12px}.sleep-count{font-size:11px;padding:4px 8px}.sleep-add button{flex-grow:1}}
@media(prefers-color-scheme:dark){.sleep-card{--sleep-accent:#a5b5e2;--sleep-soft:#2a3447}.sleep-day.selected{color:#172132}}
</style></head><body><main>
<header><div><h1>自主性</h1><p class="muted">给她一次自行决定的机会。行动、暂不行动，都可以成为一次完整的判断。</p></div><span id="badge" class="badge">读取中</span></header>
<div class="grid"><section><form id="form"><div class="card"><h2>唤醒方式</h2>
<label class="field"><span><input id="enabled" type="checkbox"> 启用自动唤醒（含明确时间约定）</span><small>先设置参数再启用；暂停此开关保留意图，已有判断继续。宿主停用插件则撤下全部能力。</small></label>
<div class="fields"><label class="field">概率模式<select id="mode"><option value="fixed">固定概率</option><option value="adaptive">按活动间隔调整</option></select></label><label class="field">平均检查间隔（分钟）<input id="intervalMinutes" type="number" min="1" max="1440" step="0.1" required></label></div>
<p id="timing" class="muted" aria-live="polite"></p><small>每次检查先随机等待，再按概率决定是否唤醒模型；检查不等于一定唤醒。明确时间约定不参与随机延迟。</small><label class="field">基础成功概率（%）<input id="probability" type="number" min="0" max="100" step="0.1" required></label>
<div id="adaptive"><div class="fields"><label class="field">近期活动阈值（分钟）<input id="recentMinutes" type="number" min="0" max="10080"></label><label class="field">近期概率乘数<input id="recentMultiplier" type="number" min="0" max="1" step="0.01"></label><label class="field">长时间未活动阈值（分钟）<input id="distantMinutes" type="number" min="1" max="43200"></label><label class="field">长时间概率乘数<input id="distantMultiplier" type="number" min="1" max="10" step="0.1"></label></div><small>两个阈值之间使用基础概率，最终概率最高100%。每次正常结束的自主判断都会重置活动计时，包括选择不行动。</small></div></div>
<div class="card"><h2>她安排的唤醒</h2><label class="field"><span><input id="allowSelfWake" type="checkbox"> 允许她安排下次唤醒</span><small>开启后，她可在交流或自主判断中设置一次唤醒时间，也可改期、取消。到点不掷骰子，仍由她决定是否行动；普通随机唤醒继续独立运行。</small></label><label class="field"><span><input id="selfWakeDuringSleep" type="checkbox"> 允许自行唤醒突破睡眠时段</span><small>默认关闭。关闭时，设在睡眠时段的请求会失败，工具会告诉她原因。此例外只用于她自己安排的唤醒。</small></label><small>需要同时开启上方“自动唤醒”总开关。每个会话保留一次安排，只唤醒当前会话。</small></div><div class="card sleep-card"><div class="sleep-heading"><span class="moon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 14A8.5 8.5 0 0 1 10 3.6 8.5 8.5 0 1 0 20.4 14Z"/><path d="M17 3v4m-2-2h4"/></svg></span><div><div class="sleep-kicker">每周作息</div><h2>睡眠时段</h2></div><span id="sleepCount" class="sleep-count">不设睡眠</span></div>
<p class="sleep-description">安排每周的休息时间。睡眠期间暂停随机唤醒和 QQ 恢复后的续说判断；不设置，就没有睡眠限制。</p>
<label class="sleep-timezone"><span>作息时区</span><input id="timezone" aria-label="作息时区" placeholder="Asia/Shanghai" required></label>
<div id="sleepEmpty" class="sleep-empty"><strong>还没有睡眠安排</strong><p>全天都可以参与普通唤醒判断。<br>想安排休息时，再添加一段就好。</p></div><div id="sleep" class="sleep-list"></div>
<div class="sleep-add"><button id="addSleep" type="button">＋ 添加时段</button><button id="addWeekdays" type="button">＋ 工作日</button><button id="addWeekend" type="button">＋ 周末</button></div>
<div class="sleep-note"><p><strong>按入睡当天重复。</strong>例如周一至周五 23:00–07:00，周五的睡眠会延续到周六早上；跨周范围也可设置。</p><p>多个时段共同生效。到点约定和手动判断仍可唤醒，已经开始的交流与行动继续。</p></div></div>
<div class="card"><h2>唤醒时的动机</h2><label class="field"><textarea id="motivation" aria-label="唤醒动机" maxlength="1500" required></textarea></label><small>普通意图只是行动方向，不影响唤醒概率；没有意图也可以自行行动。</small></div>
<div class="actions"><button class="primary" type="submit">保存设置</button><button id="reload" type="button">重新读取</button></div><p id="notice" role="status" aria-live="polite"></p></form></section>
<section><div class="card"><h2>当前状态</h2><p id="session" class="muted"></p><div class="summary"><div class="stat"><small>当前普通唤醒概率</small><strong id="chance">—</strong></div><div class="stat"><small>上次活动</small><span id="last">—</span></div></div><p id="next" class="muted"></p><div class="rule"><strong>她的下次安排</strong><p id="selfWakeAt" class="muted">尚未安排</p><p id="selfWakeReason"></p><button id="cancelSelfWake" type="button" hidden>取消这次安排</button></div><div class="actions"><button id="wake" type="button">现在判断一次</button><button id="stop" type="button">结束并取消排队</button></div><small>手动判断跳过概率与时段，忙碌时排队；连续点击合并为一次等待机会。结束判断同时取消等待中的唤醒。</small><p id="configError" class="warn" hidden></p><details><summary>当前接入范围</summary><div id="limitations" class="warn"></div></details></div>
<div class="card"><h2>当前会话的意图</h2><p class="muted">每次自主判断会带入简短清单，由她决定执行、暂缓或放弃。计划时间经过仍未完成；只有明确记录完成或放弃后才移除。</p><div id="intents"></div></div>
<div class="card"><h2>最近判断</h2><div id="runs"></div></div><details class="card"><summary>本地唤醒记录</summary><div id="logs"></div></details></section></div>
</main><script src="${base}ui.js"></script></body></html>`;

const script = `
const $=id=>document.getElementById(id);let state,draftConfig,draftRevision,dirty=false;
const date=v=>v?new Date(v).toLocaleString():'尚无记录';
const node=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e};
async function api(data){const r=await fetch('${base}state',data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{cache:'no-store'});const v=await r.json();if(!r.ok)throw Error(v.error||'请求失败');return v}
const weekdays=['周一','周二','周三','周四','周五','周六','周日'];
function sleepConfig(e){return {startDay:Number(e.querySelector('[data-sleep="startDay"]').value),endDay:Number(e.querySelector('[data-sleep="endDay"]').value),start:e.querySelector('[data-sleep="start"]').value,end:e.querySelector('[data-sleep="end"]').value}}
function sleepCount(){const count=$('sleep').children.length;$('sleepEmpty').hidden=count>0;$('sleepCount').textContent=count?'每周 '+count+' 段':'不设睡眠';for(const id of ['addSleep','addWeekdays','addWeekend'])$(id).disabled=count>=16}
function row(w={startDay:1,endDay:7,start:'23:00',end:'07:00'}){
  const e=node('div','','sleep-row'),top=node('div','','sleep-row-top'),title=node('strong','','sleep-title'),remove=node('button','移除','sleep-remove');remove.type='button';remove.setAttribute('aria-label','移除睡眠时段');remove.onclick=()=>{e.remove();dirty=true;sleepCount()};top.append(title,remove);e.append(top);
  const inputs={};
  for(const fields of [['startDay','endDay'],['start','end']]){
    const group=node('div','','sleep-range');
    for(const [n,key] of fields.entries()){
      if(n)group.append(node('span',fields[0]==='startDay'?'至':'→','to'));
      const label=node('label',({startDay:'从星期',endDay:'至星期',start:'入睡时间',end:'醒来时间'})[key]);
      const input=document.createElement(key.endsWith('Day')?'select':'input');input.dataset.sleep=key;
      if(key.endsWith('Day')){weekdays.forEach((day,i)=>{const option=node('option',day);option.value=String(i+1);input.append(option)});input.value=String(w[key]??(key==='startDay'?1:7))}
      else{input.type='time';input.required=true;input.value=w[key]}
      label.append(input);inputs[key]=input;group.append(label);
    }
    e.append(group);
    if(fields[0]==='startDay')e.append(node('div','','sleep-days'));
  }
  const preview=node('p','','sleep-preview');e.append(preview);
  const update=()=>{
    const c=sleepConfig(e),range=c.startDay===1&&c.endDay===7?'每天':c.startDay===c.endDay?weekdays[c.startDay-1]:weekdays[c.startDay-1]+'至'+weekdays[c.endDay-1];title.textContent=range;
    const days=e.querySelector('.sleep-days');days.replaceChildren();weekdays.forEach((label,i)=>{const d=i+1,selected=c.startDay<=c.endDay?d>=c.startDay&&d<=c.endDay:d>=c.startDay||d<=c.endDay;days.append(node('span',label,'sleep-day'+(selected?' selected':'')))});
    inputs.end.setCustomValidity(c.start&&c.end&&c.start===c.end?'入睡和醒来时间不能相同；不设睡眠请移除此时段':'');
    if(!c.start||!c.end){preview.textContent='请填写入睡和醒来时间';return}
    if(c.start===c.end){preview.textContent='入睡和醒来时间不能相同';return}
    const mins=s=>Number(s.slice(0,2))*60+Number(s.slice(3)),duration=(mins(c.end)-mins(c.start)+1440)%1440;
    preview.textContent=range+'，'+c.start+' → '+(c.end<c.start?'次日 ':'当天 ')+c.end+' · '+(Math.floor(duration/60)?Math.floor(duration/60)+'小时':'')+(duration%60?duration%60+'分钟':'');
  };
  e.oninput=()=>{dirty=true;update()};e.onchange=()=>{dirty=true;update()};$('sleep').append(e);update();sleepCount();return e;
}
function timing(){const n=Number($('intervalMinutes').value);$('timing').textContent=Number.isFinite(n)&&n>=1&&n<=1440?'每次随机等待 '+Number((n*0.5).toFixed(2))+'～'+Number((n*1.5).toFixed(2))+' 分钟，平均 '+n+' 分钟检查一次。':'请设置 1～1440 分钟的平均间隔。'}
function fill(c){for(const key of['mode','intervalMinutes','recentMinutes','recentMultiplier','distantMinutes','distantMultiplier','timezone','motivation'])$(key).value=c[key];$('enabled').checked=c.enabled;$('allowSelfWake').checked=c.allowSelfWake;$('selfWakeDuringSleep').checked=c.selfWakeDuringSleep;$('probability').value=c.probability*100;$('sleep').replaceChildren();c.sleep.forEach(w=>row(w));sleepCount();$('adaptive').hidden=c.mode!=='adaptive';timing()}
const phases={queued:'排队中',cancelled:'已取消，未执行',running:'正在判断',settling:'正在记录结果',completed:'已正常结束',failed:'失败',interrupted:'已中断',uncertain:'结果待核对',busy:'会话忙碌，已跳过'};
function render(v,form=false){state=v;if(form){draftConfig=structuredClone(v.config);draftRevision=v.revision;fill(v.config)}$('badge').textContent=v.running?'正在自主判断':v.queued.some(j=>j.cancelling)?'正在取消排队':v.queued.length?'排队中（'+v.queued.length+'）':!v.config.enabled?'自动唤醒已暂停':v.sleeping?'普通唤醒休息中':'等待唤醒';$('session').textContent=v.session?'当前会话：'+v.session:'尚无会话；不会为轮询自动新建';$('chance').textContent=(v.probability*100).toFixed(1)+'%';$('last').textContent=date(v.lastActivityAt);$('next').textContent=v.config.enabled&&v.nextCheckAt?'本次抽取的检查时间：'+date(v.nextCheckAt):'';$('selfWakeAt').textContent=v.selfWake?date(v.selfWake.at)+(!v.config.enabled||!v.config.allowSelfWake?' · 已暂停':Date.parse(v.selfWake.at)<=Date.parse(v.now)?' · 已到点，等待可执行时机':' · 到点唤醒一次'):'尚未安排';$('selfWakeReason').textContent=v.selfWake?v.selfWake.reason:'';$('cancelSelfWake').hidden=!v.selfWake;$('stop').disabled=!v.running&&!v.queued.length;$('wake').disabled=!v.session;$('configError').hidden=!v.configError;$('configError').textContent=v.configError||'';$('limitations').replaceChildren(...v.limitations.map(s=>node('p',s)));
const intents=$('intents');intents.replaceChildren();for(const i of v.intents){const e=node('div','','intent');e.append(node('small',(i.kind==='agreement'?'约定':'念头')+' · 产生于 '+date(i.createdAt)),node('p',i.text));if(i.dueAt)e.append(node('small','明确时间：'+date(i.dueAt)));if(i.preferredAt)e.append(node('small','计划参考时间：'+date(i.preferredAt)));if(i.state==='settling')e.append(node('p','结束结果正在保存，勿重复执行'));else{const plan=i.dueAt||i.preferredAt;e.append(node('small',!plan?'未设计划时间 · 仍未完成':Date.parse(plan)<=Date.parse(v.now)?'已到计划时间 · 仍未完成':'尚未到计划时间 · 仍未完成'))}intents.append(e)}if(!v.intents.length)intents.append(node('p','暂时没有意图，她仍然可以自主行动。','empty'));
const runs=$('runs');runs.replaceChildren();for(const r of v.runs.slice(0,12)){const e=node('div','','rule');e.append(node('strong',phases[r.phase]||r.phase),node('small',' · '+({self:'自行安排',random:'随机唤醒',qq_resume:'QQ 续说判断',manual:'手动判断',agreement:'到点约定'}[r.trigger]||r.trigger)+' · '+date(r.endedAt||r.startedAt||r.queuedAt)));if(r.reason)e.append(node('p',r.reason));runs.append(e)}if(!v.runs.length)runs.append(node('p','尚未进行自主判断。','empty'));
$('logs').replaceChildren(...v.logs.slice(0,25).map(l=>node('p',date(l.at)+' · '+l.status+' · '+l.detail)));}
async function refresh(form=false){try{render(await api(),form)}catch(e){$('notice').textContent=e.message}}
$('intervalMinutes').oninput=timing;$('form').oninput=()=>dirty=true;$('mode').onchange=()=>{$('adaptive').hidden=$('mode').value!=='adaptive';dirty=true};for(const [id,startDay,endDay] of [['addSleep',1,7],['addWeekdays',1,5],['addWeekend',6,7]])$(id).onclick=()=>{if($('sleep').children.length>=16)return;const e=row({startDay,endDay,start:'23:00',end:'07:00'});dirty=true;e.querySelector('select').focus()};$('reload').onclick=()=>{if(dirty&&!confirm('放弃尚未保存的改动？'))return;dirty=false;refresh(true)};
$('form').onsubmit=async e=>{e.preventDefault();if(!draftConfig){$('notice').textContent='请先读取设置';return}const config={...draftConfig};for(const key of['intervalMinutes','recentMinutes','recentMultiplier','distantMinutes','distantMultiplier'])config[key]=Number($(key).value);for(const key of['mode','timezone','motivation'])config[key]=$(key).value;config.enabled=$('enabled').checked;config.allowSelfWake=$('allowSelfWake').checked;config.selfWakeDuringSleep=$('selfWakeDuringSleep').checked;config.probability=Number($('probability').value)/100;config.sleep=[...$('sleep').children].map(sleepConfig);try{const v=await api({action:'configure',config,revision:draftRevision});dirty=false;render(v,true);$('notice').textContent='已保存'}catch(e){$('notice').textContent=e.message}};
$('cancelSelfWake').onclick=async()=>{try{const v=await api({action:'cancelSelfWake',session:state.session,version:state.selfWakeVersion,requestId:crypto.randomUUID()});render(v);$('notice').textContent='已取消这次自行唤醒安排'}catch(e){$('notice').textContent=e.message}};
for(const action of['wake','stop'])$(action).onclick=async()=>{try{$(action).disabled=true;const result=await api({action,session:state.session});$('notice').textContent=action==='wake'?(result.merged?'已合并到等待中的自主判断':'自主判断已提交，会话空闲后执行'):'已请求结束并取消排队，正在等待当前请求退出';await refresh()}catch(e){$('notice').textContent=e.message;await refresh()}};
refresh(true);setInterval(()=>{if(!document.hidden)refresh()},5000);
`;
