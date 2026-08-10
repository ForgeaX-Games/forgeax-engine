import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

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
  req: { url?: string; method?: string },
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

async function request(target: Server, url: string, method = 'GET'): Promise<Response> {
  const response: Response = { statusCode: 200, headers: {}, body: undefined };
  if (target.handler === undefined) throw new Error('plugin middleware was not registered');
  await target.handler(
    { url, method },
    {
      ...response,
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
});
