import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settings, defaults, sleeping, probability } from '../src/config.ts';

test('fixed and activity-weighted modes have independent, user-controlled probabilities', () => {
  const now = 999999999, last = now - 60000;
  assert.equal(probability(settings({mode:'fixed',probability:.4}), now, last),.4);
  const adaptive = settings({mode:'adaptive',probability:.4,recentMinutes:20,recentMultiplier:.25,distantMinutes:60,distantMultiplier:3});
  assert.equal(probability(adaptive,now,last),.1);
  assert.equal(probability(adaptive,now,now-20*60000),.4);
  assert.equal(probability(adaptive,now,now-60*60000),1);
  assert.equal(probability(adaptive,now,null),.4);
  assert.equal(probability(adaptive,now,now+1),.1);
});
test('sleep windows use their configured zone, include start/exclude end and cross midnight', () => {
  const config = settings({sleep:[{start:'23:00',end:'07:00'}],timezone:'Asia/Shanghai'});
  assert.equal(sleeping(config,Date.parse('2026-10-31T23:00:00+08:00')),true);
  assert.equal(sleeping(config,Date.parse('2026-11-01T06:59:59+08:00')),true);
  assert.equal(sleeping(config,Date.parse('2026-11-01T07:00:00+08:00')),false);
  assert.equal(sleeping(settings({}),Date.now()),false);
});
test('invalid settings never silently enable requests or reinterpret a broken window', () => {
  for (const bad of [{probability:NaN},{probability:1.1},{intervalMinutes:0},{timezone:'wrong-zone'},
    {enabled:'yes'},{schema:2},{distantMinutes:10,recentMinutes:20},{sleep:[{start:'09:00',end:'09:00'}]},
    {sleep:[{start:'24:00',end:'08:00'}]},{motivation:''}]) assert.throws(()=>settings(bad));
  assert.equal(defaults.enabled,false);
});

test('weekly sleep uses the bedtime weekday, including Friday night and Sunday rollover', () => {
  const config = settings({ sleep: [
    { startDay: 1, endDay: 5, start: '23:00', end: '07:00' },
    { startDay: 6, endDay: 7, start: '01:00', end: '09:00' },
  ] });
  for (const [time, expected] of [
    ['2026-11-06T22:59:59+08:00', false], ['2026-11-06T23:00:00+08:00', true],
    ['2026-11-07T00:30:00+08:00', true], ['2026-11-07T08:59:59+08:00', true],
    ['2026-11-07T09:00:00+08:00', false], ['2026-11-07T23:00:00+08:00', false],
    ['2026-11-09T06:00:00+08:00', false], ['2026-11-09T23:00:00+08:00', true],
  ] as const) assert.equal(sleeping(config, Date.parse(time)), expected, time);
  const sunday = settings({ sleep: [{ startDay: 7, endDay: 7, start: '23:00', end: '07:00' }] });
  assert.equal(sleeping(sunday, Date.parse('2026-11-09T06:59:59+08:00')), true);
  assert.equal(sleeping(sunday, Date.parse('2026-11-09T07:00:00+08:00')), false);
  assert.equal(sleeping(sunday, Date.parse('2026-11-08T06:00:00+08:00')), false);
});

test('weekday ranges wrap across the week and use local dates rather than UTC dates', () => {
  const config = settings({ sleep: [{ startDay: 7, endDay: 2, start: '08:00', end: '15:00' }], timezone: 'Pacific/Kiritimati' });
  assert.equal(sleeping(config, Date.parse('2026-11-07T18:00:00Z')), true, 'Sunday 08:00 locally');
  assert.equal(sleeping(config, Date.parse('2026-11-09T18:00:00Z')), true, 'Tuesday included');
  assert.equal(sleeping(config, Date.parse('2026-11-10T18:00:00Z')), false, 'Wednesday excluded');
  assert.equal(sleeping(config, Date.parse('2026-11-07T17:59:59Z')), false);
});

test('legacy daily windows retain their exact format and empty sleep means no sleep on any weekday', () => {
  const legacy = { start: '23:00', end: '07:00' };
  const config = settings({ sleep: [legacy] });
  assert.deepEqual(config.sleep, [legacy]);
  for (let day = 1; day <= 7; day++) {
    const at = Date.parse('2026-11-0' + day + 'T23:00:00+08:00');
    assert.equal(sleeping(config, at), true);
    assert.equal(sleeping(settings({ sleep: [] }), at), false);
  }
});

test('invalid or incomplete weekday ranges are rejected without turning into daily sleep', () => {
  for (const range of [{ startDay: 1 }, { endDay: 7 }, { startDay: 0, endDay: 7 },
    { startDay: 1, endDay: 8 }, { startDay: 1.5, endDay: 5 }, { startDay: '1', endDay: 5 },
    { startDay: null, endDay: null }])
    assert.throws(() => settings({ sleep: [{ start: '23:00', end: '07:00', ...range }] }), /星期/);
});

test('obsolete autonomous permission settings disappear without changing wake configuration', () => {
  const current = settings({ enabled: true, probability: .4, sleep: [{ start: '08:00', end: '18:00' }] });
  for (const permission of ['inherit', 'ask', 'full', null]) {
    assert.deepEqual(settings({ ...current, permission }), current);
  }
  assert.equal('permission' in current, false);
});
