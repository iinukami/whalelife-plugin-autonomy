/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export interface SleepWindow {
  start: string;
  end: string;
  // ISO weekdays, Monday=1 through Sunday=7. Omitted means every day (legacy).
  // Both ends are inclusive; a reversed range wraps across Sunday.
  startDay?: number;
  endDay?: number;
}
export interface Settings {
  schema: 1;
  enabled: boolean;
  allowSelfWake: boolean;
  selfWakeDuringSleep: boolean;
  mode: 'fixed' | 'adaptive';
  intervalMinutes: number;
  probability: number;
  recentMinutes: number;
  recentMultiplier: number;
  distantMinutes: number;
  distantMultiplier: number;
  timezone: string;
  sleep: SleepWindow[];
  motivation: string;
}
export const defaults: Settings = {
  schema: 1, enabled: false, allowSelfWake: false, selfWakeDuringSleep: false,
  mode: 'fixed', intervalMinutes: 30, probability: 0.2,
  recentMinutes: 20, recentMultiplier: 0.15, distantMinutes: 360, distantMultiplier: 1.5,
  timezone: 'Asia/Shanghai', sleep: [],
  motivation: '我现在要不要做点什么？结合当前情况、人格和记忆，自行决定。已有意图只是可选方向，没有意图也可以行动，也可以选择暂不行动。',
};
const bounded = (v: unknown, lo: number, hi: number, name: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw Error(`${name}应在 ${lo}–${hi} 之间`);
  return v;
};
export function settings(input: unknown): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('配置必须是对象');
  // 0.1.2 briefly exposed a separate permission selector. It no longer controls
  // autonomous calls; discard the obsolete field while retaining other settings.
  const stored = { ...input } as Record<string, unknown>;
  delete stored.permission;
  const x = { ...defaults, ...stored } as Settings;
  if (x.schema !== 1) throw Error('不支持的配置版本');
  if (typeof x.enabled !== 'boolean' || !['fixed', 'adaptive'].includes(x.mode)) throw Error('唤醒开关或模式无效');
  if (typeof x.allowSelfWake !== 'boolean' || typeof x.selfWakeDuringSleep !== 'boolean') throw Error('自行安排唤醒和睡眠例外必须是开关');
  bounded(x.intervalMinutes, 1, 1440, '平均检查间隔（分钟）');
  bounded(x.probability, 0, 1, '基础概率');
  bounded(x.recentMinutes, 0, 10080, '近期阈值');
  bounded(x.distantMinutes, 1, 43200, '长时间阈值');
  if (x.distantMinutes <= x.recentMinutes) throw Error('长时间阈值必须大于近期阈值');
  bounded(x.recentMultiplier, 0, 1, '近期概率系数');
  bounded(x.distantMultiplier, 1, 10, '长时间概率系数');
  if (typeof x.timezone !== 'string' || x.timezone.length > 100) throw Error('时区无效');
  try { new Intl.DateTimeFormat('en', { timeZone: x.timezone }).format(0); } catch { throw Error('时区无效'); }
  if (!Array.isArray(x.sleep) || x.sleep.length > 16) throw Error('睡眠时段最多16组');
  x.sleep = x.sleep.map(w => {
    if (!w || typeof w !== 'object' || typeof w.start !== 'string' || typeof w.end !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)) throw Error('睡眠时间请填写 HH:mm');
    if (w.start === w.end) throw Error('入睡和醒来时间不能相同；不设睡眠请移除此时段');
    if (w.startDay === undefined && w.endDay === undefined) return { start: w.start, end: w.end };
    if (!Number.isInteger(w.startDay) || !Number.isInteger(w.endDay) || w.startDay! < 1 || w.startDay! > 7 || w.endDay! < 1 || w.endDay! > 7)
      throw Error('星期范围需同时选择开始和结束星期（周一至周日）');
    return { start: w.start, end: w.end, startDay: w.startDay, endDay: w.endDay };
  });
  if (typeof x.motivation !== 'string' || !x.motivation.trim() || [...x.motivation].length > 1500) throw Error('动机文案须为1–1500字');
  return structuredClone(x);
}
export function sleeping(config: Settings, at: number) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const minute = value('hour') * 60 + value('minute');
  const day = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(parts.find(p => p.type === 'weekday')!.value) + 1;
  const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return config.sleep.some(w => {
    const a = minutes(w.start), b = minutes(w.end);
    // Early hours belong to the previous evening, not today's weekly rule.
    const sleepDay = a > b && minute < b ? (day === 1 ? 7 : day - 1) : day;
    const from = w.startDay ?? 1, to = w.endDay ?? 7;
    const inDays = from <= to ? sleepDay >= from && sleepDay <= to : sleepDay >= from || sleepDay <= to;
    return inDays && (a < b ? minute >= a && minute < b : minute >= a || minute < b);
  });
}
export function probability(config: Settings, at: number, lastActivity: number | null) {
  if (config.mode === 'fixed' || lastActivity === null) return config.probability;
  const age = Math.max(0, at - lastActivity) / 60000;
  const multiplier = age < config.recentMinutes ? config.recentMultiplier : age >= config.distantMinutes ? config.distantMultiplier : 1;
  return Math.min(1, config.probability * multiplier);
}
