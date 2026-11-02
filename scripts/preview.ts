/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// Temporary, isolated UI preview. No real configuration or model is used.
import { hostFixture, project } from '../tests/helpers.ts';
const cleanup: (() => Promise<void>)[] = [];
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  process.stdin.pause();
})();
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
process.stdin.on('data', data => { if (String(data).trim() === 'stop') void close(); });
// Bound the lifetime even if the preview's caller disappears.
const timer = setTimeout(() => { void close(); }, 10 * 60000);
timer.unref();
try {
  const f = await hostFixture({ after: (fn: () => Promise<void>) => cleanup.push(fn) } as any, undefined, 'autonomy', project);
  console.log(`http://127.0.0.1:${f.app.web.server.address().port}`);
  process.stdin.resume();
} catch (error) {
  await close(); throw error;
}
