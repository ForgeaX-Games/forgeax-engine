import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createStandaloneRuntimeAssetBinding, ok, type Result } from '@forgeax/engine-types';
import { type ParticleEffectSource, particleEffectPackLoader } from '@forgeax/engine-vfx';
import type { ForgeaXPackPlugin } from '@forgeax/engine-vite-plugin-pack';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { build as viteBuild } from 'vite';
import { describe, expect, it } from 'vitest';
import type { ParticleOperatorDefinition } from '../index.js';
import { ParticleOperatorRegistry, particleEffectImporter } from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const MATERIAL_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

const source: ParticleEffectSource = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'spark',
      capacity: 32,
      space: 'world',
      schedule: { rate: 4, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: {} }],
        initialize: [{ kind: 'set-life', version: 1, params: {} }],
        update: [{ kind: 'gravity', version: 1, params: {} }],
        output: [{ kind: 'billboard', version: 1, params: {} }],
      },
      output: { kind: 'billboard', material: MATERIAL_GUID },
    },
  ],
};

function definition(
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  kind: string,
): ParticleOperatorDefinition {
  return {
    stage,
    kind,
    version: 1,
    parameterSchema: {},
    validateParams: (): Result<void, never> => ok(undefined),
    compile: { cpu: (params) => ({ stage, kind, params }) },
  };
}

function operators(): ParticleOperatorRegistry {
  const registry = new ParticleOperatorRegistry();
  for (const [stage, kind] of [
    ['spawn', 'spawn-rate'],
    ['initialize', 'set-life'],
    ['update', 'gravity'],
    ['output', 'billboard'],
  ] as const) {
    const registered = registry.register(definition(stage, kind));
    if (!registered.ok) throw new Error(registered.error.code);
  }
  return registry;
}

async function createFixture(): Promise<{ root: string; dist: string }> {
  const fixtureBase = resolve(import.meta.dirname, '../../.tmp');
  await mkdir(fixtureBase, { recursive: true });
  const root = await mkdtemp(join(fixtureBase, 'forgeax-vfx-pack-'));
  const assets = join(root, 'assets');
  const dist = join(root, 'dist');
  await mkdir(assets, { recursive: true });
  await writeFile(join(root, 'main.js'), 'export const entry = true;\n');
  await writeFile(join(assets, 'spark.json'), JSON.stringify(source));
  await writeFile(
    join(assets, 'spark.json.meta.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'external-asset-package',
      source: 'spark.json',
      importer: 'particle-effect',
      importSettings: {},
      subAssets: [{ guid: EFFECT_GUID, sourceIndex: 0, kind: 'particle-effect' }],
    }),
  );
  await viteBuild({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: dist,
      emptyOutDir: true,
      rollupOptions: { input: { main: join(root, 'main.js') } },
    },
    plugins: [pluginPack({ roots: [assets], importers: [particleEffectImporter(operators())] })],
  });
  return { root, dist };
}

async function loadFromFiles(
  registry: AssetRegistry,
  dist: string,
  indexUrl: string,
): Promise<Awaited<ReturnType<AssetRegistry['loadByGuid']>>> {
  const index = JSON.parse(await readFile(join(dist, 'pack-index.json'), 'utf8')) as readonly {
    guid: string;
    packageUrl: string;
    kind: string;
    sourcePath: string;
  }[];
  const effectPackage = index[0]?.packageUrl;
  if (effectPackage === undefined) throw new Error('built Pack v2 index has no effect package');
  const catalog = [
    ...index,
    {
      guid: MATERIAL_GUID,
      packageUrl: effectPackage,
      kind: 'fixture-dependency',
      sourcePath: 'fixture-material.json',
    },
  ];
  const files = new Map<string, Uint8Array>();
  files.set('/pack-index.json', new TextEncoder().encode(JSON.stringify(catalog)));
  for (const row of catalog) {
    const packagePath = row.packageUrl.replace(/^\/+/, '');
    const packageBytes = await readFile(join(dist, packagePath));
    files.set(`/${packagePath}`, packageBytes);
    const pack = JSON.parse(new TextDecoder().decode(packageBytes)) as {
      assets: Array<{
        guid: string;
        kind: string;
        payload: Record<string, unknown>;
        refs: readonly string[];
        artifacts?: Readonly<Record<string, { path: string }>>;
      }>;
    };
    if (!pack.assets.some((asset) => asset.guid === MATERIAL_GUID)) {
      pack.assets.push({
        guid: MATERIAL_GUID,
        kind: 'fixture-dependency',
        payload: { kind: 'fixture-dependency', value: true },
        refs: [],
        artifacts: {},
      });
      const updatedPackageBytes = new TextEncoder().encode(JSON.stringify(pack));
      files.set(`/${packagePath}`, updatedPackageBytes);
    }
    const packageDir = packagePath.slice(0, packagePath.lastIndexOf('/') + 1);
    for (const asset of pack.assets) {
      for (const descriptor of Object.values(asset.artifacts ?? {})) {
        const artifactPath = descriptor.path.replace(/^\/+/, '');
        const publishedPath = `${packageDir}${artifactPath}`;
        files.set(`/${publishedPath}`, await readFile(join(dist, publishedPath)));
      }
    }
  }
  registry.configurePackIndex(indexUrl);
  registry.loaders.registerPackLoader({
    kind: 'fixture-dependency',
    load: () => ({ kind: 'fixture-dependency', value: true }),
  });
  registry.loaders.registerPackLoader(particleEffectPackLoader);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    const path = new URL(url.toString(), 'http://forgeax.local').pathname;
    const bytes = files.get(posix.normalize(path));
    return bytes === undefined
      ? new Response('not found', { status: 404 })
      : new Response(bytes as unknown as BodyInit);
  };
  try {
    return await registry.loadByGuid(registry.parseGuid(EFFECT_GUID));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

type PackMiddleware = Parameters<
  Parameters<ForgeaXPackPlugin['configureServer']>[0]['middlewares']['use']
>[0];

function middlewareFetcher(
  plugin: ForgeaXPackPlugin,
): (url: string, method?: string) => Promise<Response> {
  const handlers: PackMiddleware[] = [];
  plugin.configureServer({
    middlewares: {
      use(handler) {
        handlers.push(handler);
      },
    },
    ws: { send() {} },
  });
  return async (url: string, method = 'GET') => {
    const handler = handlers[0];
    if (handler === undefined) return new Response('missing middleware', { status: 500 });
    return new Promise((resolve) => {
      let settled = false;
      const response = {
        statusCode: 200,
        setHeader() {},
        end(body: string | Uint8Array) {
          if (settled) return;
          settled = true;
          resolve(new Response(body as unknown as BodyInit, { status: response.statusCode }));
        },
      };
      void handler(
        { url, method } as unknown as Parameters<PackMiddleware>[0],
        response as unknown as Parameters<PackMiddleware>[1],
        () => {
          if (!settled) {
            settled = true;
            resolve(new Response('not found', { status: 404 }));
          }
        },
      );
    });
  };
}

describe('VFX asset-cook v2 dev/build chain', () => {
  it('loads the same ParticleEffectAsset from a built Pack v2 package', async () => {
    const fixture = await createFixture();
    try {
      const result = await loadFromFiles(
        new AssetRegistry({} as never),
        fixture.dist,
        '/pack-index.json',
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({
          kind: 'particle-effect',
          schemaVersion: 1,
          emitters: [{ id: 'spark', capacity: 32 }],
        });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('serves a dev package locator without relying on a binary or source suffix', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.root, 'assets', 'fixture-material.pack.json'),
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: MATERIAL_GUID,
              kind: 'fixture-dependency',
              payload: { kind: 'fixture-dependency', value: true },
              refs: [],
              artifacts: {},
            },
          ],
        }),
      );
      const plugin = pluginPack({
        runtimeBinding: createStandaloneRuntimeAssetBinding('vfx-fixture'),
        roots: [join(fixture.root, 'assets')],
        importers: [particleEffectImporter(operators())],
      });
      const fetchFromDev = middlewareFetcher(plugin);
      const runtimeBinding = createStandaloneRuntimeAssetBinding('vfx-fixture');
      // The initial scoped catalog request is the readiness barrier for the
      // plugin's async startup scan. Import requests issued while the realm is
      // still transitioning are intentionally rejected with 503.
      const initialCatalog = await fetchFromDev(runtimeBinding.catalogUrl);
      expect(initialCatalog.ok).toBe(true);
      const imported = await fetchFromDev(`${runtimeBinding.importUrlBase}/${EFFECT_GUID}`, 'POST');
      expect(imported.ok).toBe(true);
      const devIndex = await fetchFromDev(runtimeBinding.catalogUrl);
      expect(devIndex.ok).toBe(true);
      const snapshot = (await devIndex.json()) as {
        readonly scopeId: string;
        readonly generation: number;
        readonly entries: readonly { guid: string; packageUrl: string }[];
      };
      expect(snapshot.scopeId).toBe(runtimeBinding.scopeId);
      expect(snapshot.generation).toBe(runtimeBinding.generation);
      const entries = snapshot.entries;
      const row = entries.find((entry) => entry.guid === EFFECT_GUID);
      expect(row?.packageUrl).toContain('/__forgeax-ddc/');
      expect(row?.packageUrl.endsWith('.bin')).toBe(false);
      expect(row?.packageUrl.endsWith('.json')).toBe(true);

      const registry = new AssetRegistry({} as never);
      registry.configureRuntimeBinding(runtimeBinding);
      registry.loaders.registerPackLoader({
        kind: 'fixture-dependency',
        load: () => ({ kind: 'fixture-dependency', value: true }),
      });
      registry.loaders.registerPackLoader(particleEffectPackLoader);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' || input instanceof URL ? input : input.url;
        const path = new URL(url.toString(), 'http://forgeax.local').pathname;
        return fetchFromDev(path, init?.method ?? 'GET');
      };
      try {
        const loaded = await registry.loadByGuid(registry.parseGuid(EFFECT_GUID));
        expect(loaded.ok).toBe(true);
        if (loaded.ok) {
          expect(loaded.value).toMatchObject({
            kind: 'particle-effect',
            schemaVersion: 1,
            emitters: [{ id: 'spark', capacity: 32 }],
          });
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
