/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), out = join(root, 'dist/autonomy');
await mkdir(out, { recursive: true });
for (const file of ['index.ts', 'plugin.yaml', 'package.json', 'README.md', 'LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) await cp(join(root,file),join(out,file));
await cp(join(root,'src'),join(out,'src'),{recursive:true});
const files = ['index.ts','plugin.yaml','package.json','README.md','LICENSE','LICENSE-ADDITIONAL','NOTICE.md','THIRD_PARTY_NOTICES.md','src/index.ts','src/config.ts','src/storage.ts','src/runtime.ts','src/qq-continuation.ts','src/web.ts'];
const hashes = {};
for (const file of files) hashes[file] = createHash('sha256').update(await readFile(join(out,file))).digest('hex');
const { version } = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
await writeFile(join(out,'BUILD.json'),JSON.stringify({version,files:hashes},null,2)+'\n');
console.log(out);
