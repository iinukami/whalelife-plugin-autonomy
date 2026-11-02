/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const compiler = resolve(root, '../../whalelife/node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [compiler, '--noEmit', '-p', root], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
