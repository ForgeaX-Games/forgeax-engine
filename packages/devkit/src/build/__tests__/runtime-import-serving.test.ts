import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../execution-workers.js';

it('serves admitted lazy native modules from an installed package outside the project root', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'runtime-import-serving-'));
  const root = join(temporary, 'game');
  const engine = join(temporary, 'installed-engine');
  const entry = join(engine, 'dist/geometry.mjs');
  const helper = join(engine, 'dist/helper.mjs');
  const unrelated = join(engine, 'dist/private.mjs');
  let server: ViteDevServer | undefined;
  try {
    await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(join(engine, 'dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1.0.0',
        type: 'module',
        exports: { './package.json': './package.json', './geometry': './dist/geometry.mjs' },
      }),
    );
    await writeFile(entry, "export { value } from './helper.mjs';");
    await writeFile(helper, 'export const value = 42;');
    await writeFile(unrelated, 'export const privateValue = 99;');
    await symlink(engine, join(root, 'node_modules/@forgeax/engine'), 'dir');
    server = await createServer({
      root,
      base: '/game/',
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, hmr: false, ws: false, fs: { allow: [root] } },
      plugins: [executionWorkerEntries(['@forgeax/engine/geometry'])],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('missing Vite listener');
    const origin = `http://127.0.0.1:${address.port}/game/`;
    expect((await fetch(`${origin}@fs${entry}`)).status).toBe(403);
    const table = await fetch(`${origin}@id/__x00__virtual:forgeax/pack-program-imports`);
    expect(table.status).toBe(200);
    expect(await table.text()).toContain('@forgeax/engine/geometry');
    const loaded = await fetch(`${origin}@fs${entry}`);
    expect(loaded.status).toBe(200);
    expect(await loaded.text()).toContain('helper.mjs');
    expect((await fetch(`${origin}@fs${helper}`)).status).toBe(200);
    expect((await fetch(`${origin}@fs${unrelated}`)).status).toBe(403);
    expect(server.config.server.fs.allow).not.toContain(engine);
    expect(server.config.server.fs.allow).not.toContain(temporary);
  } finally {
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
