import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const GUID = '01900000-0000-7000-8000-aaaaaaaaaaaa';

describe('DevSession through a real Vite server', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('retains the actual ScriptablePack definition failure in public runtime diagnostics', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-definition-diagnostic-'));
    const source = join(root, 'scene.pack.ts');
    await writeFile(
      source,
      `
      const guid = (n) => { const value = new Uint8Array(16); value[15] = n; return value; };
      export default {
        schemaVersion: '1.0.0', packageId: guid(1),
        assets: { scene: { guid: guid(2), kind: 'scene' } },
        externalAssets: { harborTreeMesh: undefined },
        build: () => ({ ok: true, value: {} }),
      };
    `,
    );
    const failure = {
      code: 'pack-source-definition-invalid',
      expected: 'a 16-byte AssetGuid',
      hint: 'repair the default exported ScriptablePack definition, then inspect Meta again',
      detail: {
        sourcePath: source,
        propertyPath: '$.externalAssets["harborTreeMesh"]',
        actual: 'undefined',
      },
    };
    expect(await loadScriptablePack(source, { metadataOnly: true })).toMatchObject({
      ok: false,
      error: failure,
    });
    const binding = createStandaloneRuntimeAssetBinding('vite-definition-diagnostic');
    const plugin = pluginPack({ roots: [root], runtimeBinding: binding });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const catalogUrl = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]).href;
    const response = await fetch(catalogUrl);
    expect(response.status).toBe(503);
    const publicFailure = await response.json();
    expect(publicFailure.cause).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'catalog-scan-failed',
          cause: expect.objectContaining({ code: 'pack-malformed-meta', cause: failure }),
        }),
      ]),
    );
    const runtime = JSON.parse(JSON.stringify(plugin.runtimeBinding()));
    expect(JSON.stringify(runtime.diagnostics)).toContain(
      JSON.stringify(failure.detail.propertyPath),
    );
    expect(JSON.stringify(publicFailure)).not.toContain('"stack"');
    expect(runtime).toMatchObject({ status: 'degraded', authority: 'degraded' });
  }, 15_000);

  it('does not bypass invalid producer configuration on a source change', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-config-'));
    const source = join(root, 'effect.pack.json');
    const pack = JSON.stringify({
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
    });
    await writeFile(source, pack);
    const binding = createStandaloneRuntimeAssetBinding('vite-invalid-config');
    const refresh = vi.fn();
    const plugin = pluginPack({
      roots: [root],
      runtimeBinding: binding,
      refresh,
      producerReadiness: 'invalid' as never,
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const catalogUrl = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]).href;
    const initial = await fetch(catalogUrl);
    expect(initial.status).toBe(503);
    expect((await initial.json()).error).toBe('config-failed');
    await writeFile(source, `${pack}\n`);
    await expect.poll(() => refresh.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
    const retried = await fetch(catalogUrl);
    expect(retried.status).toBe(503);
    expect((await retried.json()).error).toBe('config-failed');
  });

  it('recovers a failed initial catalog after the user repairs the source', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-recovery-'));
    await mkdir(join(root, 'assets'));
    const source = join(root, 'assets', 'effect.pack.json');
    await writeFile(source, '{broken');
    const binding = createStandaloneRuntimeAssetBinding('vite-recovery');
    const refresh = vi.fn();
    const plugin = pluginPack({ roots: [join(root, 'assets')], runtimeBinding: binding, refresh });
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
    const failed = await fetch(catalogUrl);
    expect(failed.status).toBe(503);
    expect((await failed.json()).cause).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.any(String), path: expect.any(String) }),
      ]),
    );
    expect(plugin.runtimeBinding()).toMatchObject({ status: 'degraded', authority: 'degraded' });
    await writeFile(source, '{still broken');
    await expect.poll(() => refresh.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
    const stillFailed = await fetch(catalogUrl);
    expect(stillFailed.status).toBe(503);
    expect((await stillFailed.json()).cause).toEqual(expect.any(Array));
    await writeFile(
      source,
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
    await expect.poll(async () => (await fetch(catalogUrl)).status, { timeout: 5000 }).toBe(200);
    expect((await (await fetch(catalogUrl)).json()).entries).toHaveLength(1);
    expect(plugin.runtimeBinding()).toMatchObject({
      scopeId: binding.scopeId,
      generation: binding.generation,
      status: 'ready',
      authority: 'authoritative',
      diagnostics: [],
    });
  }, 15_000);

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
