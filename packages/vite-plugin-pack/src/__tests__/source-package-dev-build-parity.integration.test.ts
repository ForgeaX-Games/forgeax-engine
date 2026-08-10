import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const MAIN_GUID = '00000000-0000-4000-8000-000000000001';
const CHILD_GUID = '00000000-0000-4000-8000-000000000002';

interface Response {
  statusCode: number;
  body: string | Uint8Array | undefined;
  headers: Record<string, string>;
}

interface Server {
  middlewares: { use(handler: Handler): void };
  ws: { send(): void };
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

function createServer(): Server {
  const server: Server & { handler?: Handler } = {
    middlewares: {
      use(handler) {
        server.handler = handler;
      },
    },
    ws: { send() {} },
  };
  return server;
}

async function request(server: Server, url: string): Promise<Response> {
  const response: Response = { statusCode: 200, body: undefined, headers: {} };
  if (server.handler === undefined) throw new Error('plugin middleware was not registered');
  await server.handler(
    { url, method: 'GET' },
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
          guid: MAIN_GUID,
          kind: 'fixture-mesh',
          payload: { kind: 'fixture-mesh', vertexCount: 3 },
          refs: [{ guid: CHILD_GUID }],
          artifacts: {
            body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
          },
        },
        {
          guid: CHILD_GUID,
          kind: 'fixture-material',
          payload: { kind: 'fixture-material', label: 'fixture' },
          refs: [],
          artifacts: {},
        },
      ],
      sourceDependencies: ['scene.fixture'],
    },
  }),
};

function meta(): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'fixture',
    source: 'scene.fixture',
    importSettings: {},
    subAssets: [
      { guid: MAIN_GUID, sourceIndex: 0, sourceKey: 'mesh/main', kind: 'fixture-mesh' },
      { guid: CHILD_GUID, sourceIndex: 1, sourceKey: 'material/main', kind: 'fixture-material' },
    ],
  });
}

function semanticPack(pack: {
  assets: readonly {
    guid: string;
    kind: string;
    name?: string;
    payload: unknown;
    refs: readonly string[];
    artifacts?: Readonly<Record<string, Record<string, unknown>>>;
  }[];
}): string {
  return JSON.stringify(
    pack.assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      name: asset.name,
      payload: asset.payload,
      refs: asset.refs,
      artifacts: Object.fromEntries(
        Object.entries(asset.artifacts ?? {}).map(([key, descriptor]) => {
          const { path: _path, ...semanticDescriptor } = descriptor as Record<string, unknown>;
          return [key, semanticDescriptor];
        }),
      ),
    })),
  );
}

describe('source package dev/build parity', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps semantic product facts equal while sink locators differ', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-parity-'));
    roots.push(root);
    const assets = join(root, 'assets');
    const dist = join(root, 'dist');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture source');
    await writeFile(join(assets, 'scene.fixture.meta.json'), meta());
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const dev = pluginPack({ roots: [assets], importers: [fixtureImporter] });
      const server = createServer();
      dev.configureServer(server);
      const binding = createStandaloneRuntimeAssetBinding('pack-parity');
      await dev.rebind(binding, [assets]);
      const catalog = (
        JSON.parse(String((await request(server, binding.catalogUrl)).body)) as {
          entries: Array<{ guid: string; packageUrl: string }>;
        }
      ).entries;
      const devRow = catalog.find((entry) => entry.guid.toLowerCase() === MAIN_GUID);
      expect(devRow).toBeDefined();
      const devPack = JSON.parse(
        String(await request(server, devRow?.packageUrl ?? '').then((result) => result.body)),
      ) as Parameters<typeof semanticPack>[0];

      const emitted: Array<{ fileName?: string; name?: string; source?: string | Uint8Array }> = [];
      const build = pluginPack({ roots: [assets], importers: [fixtureImporter] });
      await build.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return `assets/${referenceId}`;
        },
      });
      await mkdir(dist, { recursive: true });
      await build.writeBundle({ dir: dist });
      const buildPackAsset = emitted.find((asset) =>
        asset.name?.startsWith(`${MAIN_GUID}.pack.json`),
      );
      expect(buildPackAsset).toBeDefined();
      const buildPack = JSON.parse(String(buildPackAsset?.source)) as {
        assets: Parameters<typeof semanticPack>[0]['assets'];
      };

      expect(semanticPack(devPack)).toBe(semanticPack(buildPack));
      expect(devRow?.packageUrl).toContain('/__forgeax-ddc/');
      expect(String(buildPackAsset?.source)).toContain('body.bin');
      expect(await readFile(join(dist, 'assets', `${MAIN_GUID}-body.bin`))).toEqual(
        Buffer.from([1, 2, 3]),
      );
      await dev.closeBundle();
    } finally {
      process.chdir(previousCwd);
    }
  });
});
