import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const SECOND_GUID = '019e3969-1d48-7c3b-ac24-6d68f4570660';

interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

interface Server {
  middlewares: { use(handler: Handler): void };
  ws: { send(payload: { type: string } & Record<string, unknown>): void };
  handler?: Handler;
}

type Handler = (
  req: {
    url?: string;
    method?: string;
    headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  },
  res: Response & {
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

function server(): Server {
  const result = {
    middlewares: {
      use(handler: Handler) {
        result.handler = handler;
      },
    },
    ws: { send() {} },
  } as Server;
  return result;
}

async function request(
  target: Server,
  url: string,
  method = 'GET',
  headers?: Readonly<Record<string, string>>,
): Promise<Response> {
  const response: Response = { statusCode: 200, headers: {}, body: undefined };
  if (target.handler === undefined) throw new Error('plugin middleware was not registered');
  await target.handler(
    { url, method, ...(headers === undefined ? {} : { headers }) },
    {
      headers: response.headers,
      get body() {
        return response.body;
      },
      get statusCode() {
        return response.statusCode;
      },
      set statusCode(value: number) {
        response.statusCode = value;
      },
      setHeader(name, value) {
        response.headers[name] = value;
      },
      end(body) {
        response.body = body;
      },
    },
    () => {},
  );
  return response;
}

const fixtureImporter: Importer = {
  key: 'fixture',
  import: async () => ({
    ok: true,
    value: {
      assets: [
        {
          guid: GUID,
          kind: 'fixture-mesh',
          payload: { kind: 'fixture-mesh', vertexCount: 3 },
          refs: [],
          artifacts: {
            body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
          },
        },
      ],
      sourceDependencies: [],
    },
  }),
};

describe('producer readiness in the Vite serve lifecycle', () => {
  const roots: string[] = [];
  const originalCwd = process.cwd();

  afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('settles the source package before the first catalog read and package GET', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );

    const target = server();
    const plugin = pluginPack({
      roots: [assets],
      importers: [fixtureImporter],
      producerReadiness: 'before-consume',
    });
    plugin.configureServer(target);
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness');
    await plugin.rebind(binding, [assets]);
    const index = JSON.parse(String((await request(target, binding.catalogUrl)).body)) as {
      entries: Array<{
        guid: string;
        lifecycle?: string;
        packageUrl: string;
      }>;
    };
    const row = index.entries.find((entry) => entry.guid.toLowerCase() === GUID);

    expect(row?.lifecycle).toBe('current');
    expect(row?.packageUrl).toBe(
      `/__pack/scopes/producer-readiness/1/asset/__forgeax-ddc/${GUID}.pack.json`,
    );
    const packageResponse = await request(target, row?.packageUrl ?? '');
    expect(packageResponse.statusCode).toBe(200);
    expect(JSON.parse(String(packageResponse.body)).assets).toHaveLength(1);

    const packDdcPath = resolve(
      root,
      'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-1',
      `${GUID}.pack.json`,
    );
    expect(JSON.parse(await readFile(packDdcPath, 'utf8')).assets).toHaveLength(1);
    await expect(
      readFile(
        resolve(
          root,
          'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-1',
          `${GUID}.meta.pack.bin`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await plugin.closeBundle();
  });

  it('waits for before-consume startup before a scoped import request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-route-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    const delayedGuid = '019e3969-1d48-7c3b-ac24-6d68f4570650';
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-delayed',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: delayedGuid, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );

    let signalImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      signalImportStarted = resolve;
    });
    let releaseImport!: () => void;
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const delayedImporter: Importer = {
      key: 'fixture-delayed',
      import: async () => {
        signalImportStarted();
        await importRelease;
        return {
          ok: true,
          value: {
            assets: [
              {
                guid: delayedGuid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3 },
                refs: [],
                artifacts: {
                  body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-route');
    const target = server();
    const plugin = pluginPack({
      roots: [assets],
      importers: [delayedImporter],
      producerReadiness: 'before-consume',
      runtimeBinding: binding,
    });
    plugin.configureServer(target);

    await importStarted;
    const pending = request(target, `${binding.importUrlBase}/${delayedGuid}`, 'POST');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseImport();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual(
      expect.arrayContaining([expect.objectContaining({ guid: delayedGuid })]),
    );
    await plugin.closeBundle();
  });

  it('aborts intake before draining a delayed lazy import on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-close-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const closingGuid = SECOND_GUID;
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-close',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: closingGuid, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );

    let signalImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      signalImportStarted = resolve;
    });
    let releaseImport!: () => void;
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const delayedImporter: Importer = {
      key: 'fixture-close',
      import: async () => {
        signalImportStarted();
        await importRelease;
        return {
          ok: true,
          value: {
            assets: [
              {
                guid: closingGuid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3 },
                refs: [],
                artifacts: {
                  body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-close');
    const target = server();
    const plugin = pluginPack({
      roots: [assets],
      importers: [delayedImporter],
      producerReadiness: 'on-demand',
      runtimeBinding: binding,
    });
    plugin.configureServer(target);
    await plugin.rebind(binding, [assets]);

    const pending = request(target, `${binding.importUrlBase}/${closingGuid}`, 'POST');
    await importStarted;
    let closed = false;
    const closing = plugin.closeBundle().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    releaseImport();
    await closing;
    const closedResponse = await pending;
    expect(closedResponse.statusCode).toBe(410);
  });

  it('publishes multiple startup packages without losing an earlier catalog commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-multiple-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    for (const [name, guid] of [
      ['first', GUID],
      ['second', SECOND_GUID],
    ] as const) {
      await writeFile(join(assets, `${name}.fixture`), name);
      await writeFile(
        join(assets, `${name}.fixture.meta.json`),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'fixture-multiple',
          source: `${name}.fixture`,
          importSettings: {},
          subAssets: [{ guid, sourceIndex: 0, kind: 'fixture-mesh' }],
        }),
      );
    }
    const multipleImporter: Importer = {
      key: 'fixture-multiple',
      import: async (context) => {
        const guid = context.subAssets[0]?.guid;
        if (guid === undefined) throw new Error('fixture meta lacks a guid');
        if (guid === GUID) await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return {
          ok: true,
          value: {
            assets: [
              {
                guid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3 },
                refs: [],
                artifacts: {
                  body: {
                    mediaType: 'application/octet-stream',
                    bytes: new Uint8Array([1, 2, 3]),
                  },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const target = server();
    const plugin = pluginPack({
      roots: [assets],
      importers: [multipleImporter],
      producerReadiness: 'before-consume',
    });
    plugin.configureServer(target);
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-multiple');
    await plugin.rebind(binding, [assets]);
    const index = JSON.parse(String((await request(target, binding.catalogUrl)).body)) as {
      entries: Array<{ guid: string; lifecycle?: string; packageUrl: string }>;
    };
    for (const guid of [GUID, SECOND_GUID]) {
      const row = index.entries.find((entry) => entry.guid.toLowerCase() === guid);
      expect(row?.lifecycle).toBe('current');
      expect((await request(target, row?.packageUrl ?? '')).statusCode).toBe(200);
    }
    await plugin.closeBundle();
  });

  it('keeps the prior Pack body and retries a refused newer DDC write on the same import route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-ddc-retry-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const primarySource = join(assets, 'primary.fixture');
    const siblingSource = join(assets, 'sibling.fixture');
    const primaryMetaPath = join(assets, 'primary.fixture.meta.json');
    await writeFile(primarySource, 'revision-old');
    await writeFile(siblingSource, 'sibling-stable');
    await writeFile(
      primaryMetaPath,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-retry',
        source: 'primary.fixture',
        importSettings: { revision: 'old' },
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );
    const siblingMeta = JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'fixture-retry',
      source: 'sibling.fixture',
      importSettings: {},
      subAssets: [{ guid: SECOND_GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
    });
    await writeFile(join(assets, 'sibling.fixture.meta.json'), siblingMeta);

    const retryImporter: Importer = {
      key: 'fixture-retry',
      import: async (context) => {
        const source = await context.readSource();
        if (!source.ok) throw new Error('fixture source read failed');
        const revision = new TextDecoder().decode(source.value);
        const guid = context.subAssets[0]?.guid;
        if (guid === undefined) throw new Error('fixture meta lacks a guid');
        return {
          ok: true,
          value: {
            assets: [
              {
                guid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3, revision },
                refs: [],
                artifacts: {
                  body: {
                    mediaType: 'application/octet-stream',
                    bytes: new Uint8Array([1, 2, 3]),
                  },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const target = server();
    const plugin = pluginPack({
      roots: [assets],
      importers: [retryImporter],
      producerReadiness: 'before-consume',
    });
    plugin.configureServer(target);
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-ddc-retry');
    await plugin.rebind(binding, [assets]);

    const packDirectory = resolve(
      root,
      'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-ddc-retry-1',
    );
    const primaryPackPath = join(packDirectory, `${GUID}.pack.json`);
    const siblingPackPath = join(packDirectory, `${SECOND_GUID}.pack.json`);
    const oldPrimaryBody = await readFile(primaryPackPath, 'utf8');
    const stableSiblingBody = await readFile(siblingPackPath, 'utf8');
    await writeFile(primarySource, 'revision-new');
    await writeFile(
      primaryMetaPath,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-retry',
        source: 'primary.fixture',
        importSettings: { revision: 'new' },
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );
    const metaBefore = await readFile(primaryMetaPath, 'utf8');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await chmod(packDirectory, 0o555);
    try {
      const refused = await request(target, `${binding.importUrlBase}/${GUID}`, 'POST', {
        'x-forgeax-import-mode': 'rebuild',
      });
      expect(refused.statusCode).toBe(200);
      expect(JSON.parse(String(refused.body))).toEqual(
        expect.arrayContaining([expect.objectContaining({ guid: GUID })]),
      );
      expect(warning).toHaveBeenCalledWith(
        '[forgeax-pack] persist DDC pack failed:',
        expect.objectContaining({
          code: 'source-package-ddc-persistence-failed',
          guid: GUID,
          packageUrl: expect.stringContaining(`${GUID}.pack.json`),
        }),
      );
      expect(await readFile(primaryPackPath, 'utf8')).toBe(oldPrimaryBody);
      expect(JSON.parse(await readFile(primaryPackPath, 'utf8')).assets[0].payload.revision).toBe(
        'revision-old',
      );
      const failedCatalog = JSON.parse(
        String((await request(target, binding.catalogUrl)).body),
      ) as { entries: Array<{ guid: string; packageUrl: string }> };
      const failedRow = failedCatalog.entries.find((entry) => entry.guid === GUID);
      expect(failedRow?.packageUrl).toContain(`${GUID}.pack.json`);
      expect(
        JSON.parse(String((await request(target, failedRow?.packageUrl ?? '')).body)).assets[0]
          .payload.revision,
      ).toBe('revision-new');
      expect(await readFile(siblingPackPath, 'utf8')).toBe(stableSiblingBody);
    } finally {
      warning.mockRestore();
      await chmod(packDirectory, 0o755);
    }

    const retried = await request(target, `${binding.importUrlBase}/${GUID}`, 'POST');
    expect(retried.statusCode).toBe(200);
    const repairedBody = await readFile(primaryPackPath, 'utf8');
    expect(JSON.parse(repairedBody).assets[0].payload.revision).toBe('revision-new');
    expect(await readFile(siblingPackPath, 'utf8')).toBe(stableSiblingBody);
    expect(await readFile(primaryMetaPath, 'utf8')).toBe(metaBefore);
    expect(await readFile(join(assets, 'sibling.fixture.meta.json'), 'utf8')).toBe(siblingMeta);
    expect((await readdir(packDirectory)).some((name) => name.includes('.tmp'))).toBe(false);
    await expect(readFile(join(packDirectory, `${GUID}.meta.pack.bin`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await plugin.closeBundle();
  });
});
