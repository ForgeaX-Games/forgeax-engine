import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const GUID = '01900000-0000-7000-8000-aaaaaaaaaaaa';

describe('DevSession through a real Vite server', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('serves one accepted scope, rejects a failed rebind after restoring it, and closes with 410', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-vite-'));
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'assets', 'effect.pack.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: GUID,
            kind: 'test-effect',
            execution: 'direct',
            payload: { schemaVersion: 1 },
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('vite-session');
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      runtimeBinding: binding,
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();

    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined) throw new Error('Vite did not expose a local URL');
    const catalogUrl = new URL(binding.catalogUrl, baseUrl).href;
    const catalog = await fetch(catalogUrl);
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).entries).toHaveLength(1);

    await mkdir(join(root, 'broken-assets'));
    await writeFile(join(root, 'broken-assets', 'broken.pack.json'), '{broken');
    await expect(
      plugin.rebind({ ...binding, generation: binding.generation + 1 }, [
        join(root, 'broken-assets'),
      ]),
    ).rejects.toMatchObject({ code: 'scan-failed' });
    expect(plugin.runtimeBinding()).toMatchObject({
      gameId: binding.gameId,
      scopeId: binding.scopeId,
      generation: binding.generation,
      status: 'degraded',
    });
    const retained = await fetch(catalogUrl);
    expect(retained.status).toBe(200);

    await plugin.closeBundle();
    const closed = await fetch(catalogUrl);
    expect(closed.status).toBe(410);
  }, 20_000);
});
