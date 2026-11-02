import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const compiler = resolve(root, '../../whalelife/node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [compiler, '--noEmit', '-p', root], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
