// @perf-budget-skip: intentional real Vite server integration gate.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
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

  it('repairs startup, imports the same derived GUID, and preserves sibling packages', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-startup-repair-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const source = join(assets, 'effect.pack.json');
    await writeFile(source, '{broken');
    await writeFile(
      join(assets, 'sibling.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-bbbbbbbbbbbb',
        assets: { 'effect/sibling': { kind: 'test-effect', payload: { value: 2 }, refs: [] } },
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('startup-repair');
    const plugin = pluginPack({ roots: [assets], runtimeBinding: binding });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const catalogUrl = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]).href;
    expect((await fetch(catalogUrl)).status).toBe(500);
    await writeFile(source, '{still broken');
    expect((await fetch(catalogUrl)).status).toBe(500);
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: GUID,
        assets: { 'effect/main': { kind: 'test-effect', payload: { value: 1 }, refs: [] } },
      }),
    );
    await expect.poll(async () => (await fetch(catalogUrl)).status, { timeout: 5000 }).toBe(200);
    const catalog = await (await fetch(catalogUrl)).json();
    expect(catalog.entries).toHaveLength(2);
    const packageId = PackageId.parse(GUID);
    if (!packageId.ok) throw packageId.error;
    const expectedGuid = AssetGuid.format(AssetGuid.derive(packageId.value, 'effect/main'));
    const target = catalog.entries.find((entry: { guid: string }) => entry.guid === expectedGuid);
    expect(target).toBeDefined();
    const importUrl = new URL(`${binding.importUrlBase}/${target.guid}`, catalogUrl);
    const imported = await fetch(importUrl, { method: 'POST' });
    expect(imported.status).toBe(200);
    const rows = await imported.json();
    const body = await fetch(new URL(rows[0].packageUrl, catalogUrl));
    expect(body.status).toBe(200);
    expect((await body.json()).assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guid: target.guid, payload: { kind: 'test-effect', value: 1 } }),
      ]),
    );
    const rebuilt = await fetch(importUrl, {
      method: 'POST',
      headers: { 'x-forgeax-import-mode': 'rebuild' },
    });
    expect(rebuilt.status).toBe(200);
    const after = await (await fetch(catalogUrl)).json();
    expect(after.entries.map((entry: { guid: string }) => entry.guid).sort()).toEqual(
      catalog.entries.map((entry: { guid: string }) => entry.guid).sort(),
    );
    expect(plugin.runtimeBinding()).toMatchObject({ status: 'ready', diagnostics: [] });
  }, 20_000);

  it('retains both lazy publications after concurrent HTTP imports', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-concurrent-import-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const guids = [GUID, '01900000-0000-7000-8000-bbbbbbbbbbbb'];
    for (const [index, guid] of guids.entries()) {
      await writeFile(join(assets, `${index}.blob`), String(index));
      await writeFile(
        join(assets, `${index}.blob.meta.json`),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'test-blob',
          source: `${index}.blob`,
          importSettings: {},
          subAssets: [{ guid, sourceIndex: 0, kind: 'test-blob' }],
        }),
      );
    }
    const importer: Importer = {
      key: 'test-blob',
      async import(ctx) {
        const source = await ctx.readSource();
        if (!source.ok) throw new Error('unreadable source');
        const index = new TextDecoder().decode(source.value);
        const guid = guids[Number(index)];
        if (guid === undefined) throw new Error('unknown fixture source');
        return {
          ok: true,
          value: {
            assets: [
              {
                guid,
                kind: 'test-blob',
                payload: { index } as never,
                refs: [],
                artifacts: {
                  blob: { bytes: source.value, mediaType: 'application/octet-stream' },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('concurrent-import');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      importers: [importer],
      producerReadiness: 'on-demand',
      ddc: { projectDdcRoot: join(root, 'ddc') },
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
    expect((await fetch(catalogUrl)).status).toBe(200);
    const responses = await Promise.all(
      guids.map((guid) =>
        fetch(new URL(`${binding.importUrlBase}/${guid}`, catalogUrl), { method: 'POST' }),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const catalog = await (await fetch(catalogUrl)).json();
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries.every((row: { lifecycle: string }) => row.lifecycle === 'current')).toBe(
      true,
    );
    for (const row of catalog.entries) {
      const response = await fetch(new URL(row.packageUrl, catalogUrl));
      expect(response.status).toBe(200);
      const body = await response.json();
      const asset = body.assets[0];
      expect(asset.guid).toBe(row.guid);
      const artifact = await fetch(new URL(asset.artifacts.blob.path, response.url));
      expect(artifact.status).toBe(200);
      expect(await artifact.text()).toBe(asset.payload.index);
    }
  }, 20_000);

  it('keeps invalid producer configuration failed after a source change', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-invalid-readiness-'));
    const source = join(root, 'effect.pack.json');
    const pack = JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: GUID,
      assets: { 'effect/main': { kind: 'test-effect', payload: {}, refs: [] } },
    });
    await writeFile(source, pack);
    const binding = createStandaloneRuntimeAssetBinding('invalid-readiness');
    const plugin = pluginPack({
      roots: [root],
      runtimeBinding: binding,
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
    const url = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]);
    expect((await fetch(url)).status).toBe(500);
    await writeFile(source, `${pack}\n`);
    const retried = await fetch(url);
    expect(retried.status).toBe(500);
    expect(JSON.stringify(await retried.json())).toContain('producer-readiness-invalid');
  });

  it('serves one accepted scope, preserves it across failed rebind, and closes with 410', async () => {
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
    const failed = await plugin.rebind({ ...binding, generation: binding.generation + 1 }, [
      join(root, 'broken-assets'),
    ]);
    expect(failed.status).toBe('degraded');
    const retained = await fetch(catalogUrl);
    expect(retained.status).toBe(200);

    await plugin.closeBundle();
    const closed = await fetch(catalogUrl);
    expect(closed.status).toBe(410);
  }, 20_000);

  it.each([
    'json',
    'module',
  ] as const)('reloads every consumer after verified %s recovery without dropping the failed page', async (mode) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-watcher-recovery-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const source = join(assets, 'effect.pack.json');
    const valid = JSON.stringify({
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
    await writeFile(source, valid);
    const binding = createStandaloneRuntimeAssetBinding('watcher-recovery');
    const plugin = pluginPack({ roots: [assets], runtimeBinding: binding, refresh: () => {} });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const catalogUrl = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]).href;
    const acceptedCatalog = await (await fetch(catalogUrl)).json();
    expect(acceptedCatalog.entries).toHaveLength(1);
    const packageUrl = new URL(acceptedCatalog.entries[0].packageUrl, catalogUrl);
    const acceptedBody = await (await fetch(packageUrl)).text();
    const send = vi.spyOn(server.ws, 'send');
    const second = vi.fn();
    plugin.configureServer({ middlewares: { use() {} }, ws: { send: second } });
    const brokenModule = join(assets, 'broken.pack.ts');
    if (mode === 'module')
      await writeFile(brokenModule, "throw new Error('module-repair-marker');");
    else await writeFile(source, '{broken');
    await expect.poll(() => plugin.runtimeBinding()?.status, { timeout: 5000 }).toBe('degraded');
    expect(
      send.mock.calls.some(
        ([message]) =>
          typeof (message as unknown) === 'object' &&
          (message as unknown as { type?: string }).type === 'full-reload',
      ),
    ).toBe(false);
    const degradedCatalog = await (await fetch(catalogUrl)).json();
    expect(degradedCatalog.authority).toBe('degraded');
    expect(degradedCatalog.entries).toEqual(acceptedCatalog.entries);
    expect(degradedCatalog.diagnostics).not.toEqual([]);
    const retainedPackage = await fetch(packageUrl);
    expect(retainedPackage.status).toBe(200);
    expect(await retainedPackage.text()).toBe(acceptedBody);
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'custom',
        data: expect.objectContaining({
          authority: 'degraded',
          added: [],
          changed: [],
          removed: [],
        }),
      }),
    );
    expect(JSON.stringify(plugin.runtimeBinding()?.diagnostics)).toContain(
      mode === 'module' ? 'module-repair-marker' : 'effect.pack.json',
    );
    if (mode === 'module') await rm(brokenModule);
    await writeFile(source, valid);
    await expect.poll(() => plugin.runtimeBinding()?.status, { timeout: 5000 }).toBe('ready');
    expect(plugin.runtimeBinding()?.diagnostics).toEqual([]);
    expect((await fetch(catalogUrl)).status).toBe(200);
    await expect
      .poll(() => second.mock.calls.some(([message]) => message.type === 'full-reload'))
      .toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
  }, 15000);

  it('reopens the same plugin after Vite closes a sequential server', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-vite-reopen-'));
    await mkdir(join(root, 'assets'));
    const binding = createStandaloneRuntimeAssetBinding('vite-session-reopen');
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      runtimeBinding: binding,
    });
    let first: Awaited<ReturnType<typeof createServer>> | undefined;
    let second: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      first = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await first.listen();
      const firstUrl = first.resolvedUrls?.local[0];
      if (firstUrl === undefined) throw new Error('first Vite server did not expose a local URL');
      expect((await fetch(new URL(binding.catalogUrl, firstUrl))).status).toBe(200);
      await first.close();
      first = undefined;

      second = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await second.listen();
      const secondUrl = second.resolvedUrls?.local[0];
      if (secondUrl === undefined) throw new Error('second Vite server did not expose a local URL');
      expect((await fetch(new URL(binding.catalogUrl, secondUrl))).status).toBe(200);
    } finally {
      await second?.close();
      await first?.close();
    }
  }, 20_000);
});
