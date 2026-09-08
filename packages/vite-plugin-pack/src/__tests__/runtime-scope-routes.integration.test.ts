import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPluginPackInternal,
  createPluginPackInternal as pluginPack,
} from '../plugin-pack.js';

const GUID = '01900000-0000-7000-8000-aaaaaaaaaaaa';
const IMAGE_GUID = '01900000-0000-7000-8000-bbbbbbbbbbbb';
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function projectDdcForTest(root: string) {
  return {
    buildCacheRoot: join(root, '.forgeax', 'ddc', 'build-cache'),
    projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2'),
  } as const;
}

describe('runtime-scoped pack routes', () => {
  let root: string | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('rejects asset identity routes before any runtime scope is bound', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-unbound-'));
    const plugin = pluginPack({ roots: [root] });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });
    expect(plugin.runtimeBinding()).toBeUndefined();

    expect((await request(middlewares, '/__pack/index')).statusCode).toBe(404);
    expect((await request(middlewares, '/pack-index.json')).statusCode).toBe(404);
    expect((await request(middlewares, `/__import/${GUID}`, 'POST')).statusCode).toBe(404);
    expect((await request(middlewares, `/__forgeax-ddc/${GUID}.pack.json`)).statusCode).toBe(404);
    expect((await request(middlewares, '/__pack/scopes/active/1/catalog.json')).statusCode).toBe(
      404,
    );
  });

  it('binds one game, ignores a malformed sibling, and disables global routes', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-'));
    const active = join(root, 'active');
    const brokenSibling = join(root, 'broken-sibling');
    await mkdir(active, { recursive: true });
    await mkdir(brokenSibling, { recursive: true });
    await writeFile(
      join(active, 'effect.pack.json'),
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
    await writeFile(join(brokenSibling, 'broken.pack.json'), '{not-json');

    const plugin = pluginPack({ roots: [active, brokenSibling] });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    const bound = await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 7,
        status: 'unbound',
        catalogUrl: '/__pack/scopes/active/7/catalog.json',
        importUrlBase: '/__pack/scopes/active/7/import',
        packageUrlBase: '/__pack/scopes/active/7/asset',
      },
      [active],
    );
    expect(bound.status).toBe('ready');
    expect(bound.authority).toBe('authoritative');
    expect(plugin.runtimeBinding()).toMatchObject({
      scopeId: 'active',
      generation: 7,
      status: 'ready',
    });

    const catalog = await request(middlewares, '/__pack/scopes/active/7/catalog.json');
    expect(catalog.statusCode).toBe(200);
    const snapshot = JSON.parse(catalog.body) as {
      authority: string;
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    expect(snapshot.authority).toBe('authoritative');
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ guid: GUID });
    expect(snapshot.entries[0]?.packageUrl).toBe(
      `/__pack/scopes/active/7/asset/__forgeax-ddc/${GUID}.pack.json`,
    );

    const packageResponse = await request(middlewares, snapshot.entries[0]?.packageUrl ?? '');
    expect(packageResponse.statusCode).toBe(200);
    expect(JSON.parse(packageResponse.body).assets[0].guid).toBe(GUID);

    expect((await request(middlewares, '/__pack/index')).statusCode).toBe(404);
    expect((await request(middlewares, '/pack-index.json')).statusCode).toBe(404);
    expect((await request(middlewares, `/__import/${GUID}`, 'POST')).statusCode).toBe(404);
    expect((await request(middlewares, `/__forgeax-ddc/${GUID}.pack.json`)).statusCode).toBe(404);
    expect((await request(middlewares, '/__pack/scopes/active/6/catalog.json')).statusCode).toBe(
      410,
    );
    expect((await request(middlewares, '/__pack/scopes/other/7/catalog.json')).statusCode).toBe(
      404,
    );
  });

  it('does not duplicate the Vite host base in scoped package URLs', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-base-'));
    const active = join(root, 'active');
    await mkdir(active, { recursive: true });
    await writeFile(
      join(active, 'effect.pack.json'),
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

    const plugin = createPluginPackInternal({ roots: [active] }, { transportBase: '/preview/' });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 7,
        status: 'unbound',
        catalogUrl: '/preview/__pack/scopes/active/7/catalog.json',
        importUrlBase: '/preview/__pack/scopes/active/7/import',
        packageUrlBase: '/preview/__pack/scopes/active/7/asset',
      },
      [active],
    );

    const catalog = await request(middlewares, '/__pack/scopes/active/7/catalog.json');
    expect(catalog.statusCode).toBe(200);
    const snapshot = JSON.parse(catalog.body) as {
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    expect(snapshot.entries[0]?.packageUrl).toBe(
      `/preview/__pack/scopes/active/7/asset/__forgeax-ddc/${GUID}.pack.json`,
    );
    expect(snapshot.entries[0]?.packageUrl).not.toContain('/asset/preview/');

    const baseCatalog = await request(middlewares, '/preview/__pack/scopes/active/7/catalog.json');
    expect(baseCatalog.statusCode).toBe(200);
    expect(JSON.parse(baseCatalog.body).authority).toBe('authoritative');
  });

  it('publishes a complete runtime tuple for an on-demand image import', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-image-'));
    const active = join(root, 'active');
    await mkdir(active, { recursive: true });
    await writeFile(join(active, 'pixel.png'), ONE_PIXEL_PNG);
    await writeFile(
      join(active, 'pixel.png.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: 'pixel.png',
        importSettings: { colorSpace: 'srgb', mipmap: false },
        subAssets: [{ guid: IMAGE_GUID, sourceIndex: 0, kind: 'texture' }],
      }),
    );

    const plugin = pluginPack({
      roots: [active],
      producerReadiness: 'on-demand',
      importers: [imageImporter],
      ddc: projectDdcForTest(root),
    });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    const bound = await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 9,
        status: 'unbound',
        catalogUrl: '/__pack/scopes/active/9/catalog.json',
        importUrlBase: '/__pack/scopes/active/9/import',
        packageUrlBase: '/__pack/scopes/active/9/asset',
      },
      [active],
    );
    expect(bound.status).toBe('ready');

    const imported = await request(
      middlewares,
      `/__pack/scopes/active/9/import/${IMAGE_GUID}`,
      'POST',
    );
    expect(imported.statusCode).toBe(200);
    const importedRows = JSON.parse(imported.body) as Array<{
      guid: string;
      publication?: { schemaVersion?: string; generation?: number };
    }>;
    expect(importedRows[0]?.publication).toMatchObject({
      schemaVersion: 'asset-publication/1',
    });
    expect(importedRows[0]?.publication?.generation).toBeGreaterThan(0);

    const catalog = await request(middlewares, '/__pack/scopes/active/9/catalog.json');
    const snapshot = JSON.parse(catalog.body) as {
      entries: Array<{
        guid: string;
        publication?: { schemaVersion?: string; generation?: number };
      }>;
    };
    const entry = snapshot.entries.find((candidate) => candidate.guid === IMAGE_GUID);
    expect(entry?.publication).toMatchObject({ schemaVersion: 'asset-publication/1' });
    expect(entry?.publication?.generation).toBeGreaterThan(0);
  });

  it('exposes degraded catalog evidence but fails closed for lazy import', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-degraded-'));
    const active = join(root, 'active');
    const validRoot = join(active, 'valid');
    const brokenRoot = join(active, 'broken');
    await mkdir(validRoot, { recursive: true });
    await mkdir(brokenRoot, { recursive: true });
    // Keep one valid root beside a broken root: one inventory failure is
    // fail-closed, so an initial session has no accepted Catalog generation.
    await writeFile(
      join(validRoot, 'valid.pack.json'),
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
    await writeFile(join(brokenRoot, 'broken.pack.json'), '{not-json');

    const plugin = pluginPack({ roots: [active] });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    const bound = await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 8,
        status: 'unbound',
        catalogUrl: '/__pack/scopes/active/8/catalog.json',
        importUrlBase: '/__pack/scopes/active/8/import',
        packageUrlBase: '/__pack/scopes/active/8/asset',
      },
      [validRoot, brokenRoot],
    );
    expect(bound.status).toBe('degraded');
    expect(bound.authority).toBe('degraded');
    expect(bound.diagnostics?.length).toBeGreaterThan(0);

    const catalog = await request(middlewares, '/__pack/scopes/active/8/catalog.json');
    expect(catalog.statusCode).toBe(503);

    const imported = await request(middlewares, `/__pack/scopes/active/8/import/${GUID}`, 'POST');
    expect(imported.statusCode).toBe(503);
  });
});

interface MockResponse {
  statusCode: number;
  body: string;
  setHeader(name: string, value: string): void;
  end(chunk: string | Uint8Array): void;
}

type Middleware = (
  req: { url?: string; method?: string },
  res: MockResponse,
  next: () => void,
) => unknown;

async function request(
  middlewares: readonly Middleware[],
  url: string,
  method = 'GET',
): Promise<MockResponse> {
  const response: MockResponse = {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(chunk) {
      this.body = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    },
  };
  let index = 0;
  const next = async (): Promise<void> => {
    const middleware = middlewares[index++];
    if (middleware !== undefined) await middleware({ url, method }, response, () => void next());
  };
  await next();
  return response;
}
