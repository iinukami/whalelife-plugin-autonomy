import type { TestContext } from 'node:test';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const host = resolve(project, '../whalelife');
export async function temporary(t: TestContext) {
  const base = join(project, '.artifacts/tests'), root = join(base, randomUUID());
  const close: (() => Promise<unknown> | unknown)[] = [];
  t.after(async () => {
    for (const dispose of close.reverse()) await dispose();
    if (dirname(resolve(root)) !== resolve(base)) throw Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });
  return { root, close };
}
export async function hostFixture(t: TestContext, pluginSource?: string, pluginId = 'probe', pluginDirectory?: string) {
  const f = await temporary(t);
  let app: any;
  f.close.push(async () => { await app?.close(); });
  await mkdir(join(f.root, 'config'));
  const pluginRoot = join(f.root, 'plugins', pluginId);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(f.root, 'persona.md'), '测试人格：沿用测试会话记忆，只调用模拟工具。');
  await writeFile(join(f.root, 'config/config.json'), JSON.stringify({
    log: { level: 'error' }, web: { port: 0 },
    providers: [{ id: 'test', base_url: 'https://unused.invalid/v1', api_key: 'synthetic' }],
    models: [{ id: 'chat', name: 'Test', provider: 'test', model: 'test', type: 'chat', enabled: true, context_window: 32000 }],
    model_bindings: { chat: 'chat' }, personas: { a: { name: 'A', file: 'persona.md', permission: 'full' } },
    channels: { web: { persona: 'a', permission: 'full' } }, memory: { root: 'memory', budget_tokens: 6000 },
  }));
  if (pluginSource) {
    await writeFile(join(pluginRoot, 'plugin.yaml'), `id: ${pluginId}\nname: Probe\nversion: 1.0.0\ndescription: Isolated test\napiVersion: "1"\n`);
    await writeFile(join(pluginRoot, 'index.ts'), pluginSource);
  } else if (pluginDirectory) {
    for (const name of ['index.ts','plugin.yaml','package.json','src']) await cp(join(pluginDirectory,name),join(pluginRoot,name),{recursive:true});
  }
  const { boot } = await import(pathToFileURL(join(host, 'core/index.ts')).href);
  app = await boot(f.root);
  // No real model request may leave the fixture, including accidental extra calls.
  app.llm.chat = async () => { throw Error('Unexpected model call'); };
  return { ...f, app, sessionId: await app.sessions.current() };
}
