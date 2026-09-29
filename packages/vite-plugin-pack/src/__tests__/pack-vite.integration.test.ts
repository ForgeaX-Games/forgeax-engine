import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const ROOT_PACKAGE_ID = '019a0000-0000-7000-8000-000000000001';
const INSTANCE_PACKAGE_ID = '019a0000-0000-7000-8000-000000000002';

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  if (!accept(value)) throw new Error('timed out waiting for ScriptablePack rebuild');
  return value;
}

describe('ScriptablePack and Pack development publication', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('retains direct plugin publications beside ScriptablePacks after Vite buildStart', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-mixed-plugin-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(root, 'package.json'), '{"name":"mixed-plugin","type":"module"}');
    await writeFile(join(assets, 'plugin.ts'), 'export default { apply() {} };');
    await writeFile(
      join(assets, 'plugin.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: ROOT_PACKAGE_ID,
        assets: {
          root: {
            kind: 'plugin',
            payload: { module: { specifier: './plugin.ts' }, config: { speed: 3 } },
          },
        },
      }),
    );
    await writeFile(
      join(assets, 'sampler.pack.ts'),
      `
      import { definePack, definePackageId } from '@forgeax/engine-pack/source';
      import { ok } from '@forgeax/engine-types';
      export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${INSTANCE_PACKAGE_ID}'),
        build() { return ok({ sampler: { kind: 'sampler', magFilter: 'linear' } }); } });
    `,
    );
    const binding = createStandaloneRuntimeAssetBinding('mixed-plugin');
    const plugin = pluginPack({
      roots: [assets],
      watch: false,
      runtimeBinding: binding,
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await plugin.ready();
    const accepted = plugin.catalogSnapshot().find((row) => row.kind === 'plugin');
    expect(accepted?.publication).toBeDefined();
    await server.listen();
    expect(plugin.catalogSnapshot().find((row) => row.kind === 'plugin')).toEqual(accepted);
    const definitions = await plugin.readPluginDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.definition.asset.config).toEqual({ speed: 3 });
  });

  it('publishes a root and a v3 instance through the dynamic Catalog path', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(
      join(assets, 'filter.pack.ts'),
      `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${ROOT_PACKAGE_ID}'),
  parameters: [{ name: 'filter', type: 'enum', values: ['linear', 'nearest'], default: 'linear' }],
  build({ values }) {
    return ok({
      'sampler/main': { kind: 'sampler', magFilter: values.filter },
    });
  },
});
`,
    );
    await writeFile(
      join(assets, 'nearest.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: INSTANCE_PACKAGE_ID,
        parent: ROOT_PACKAGE_ID,
        values: { filter: 'nearest' },
      }),
    );

    const binding = createStandaloneRuntimeAssetBinding('scriptable-pack-vite');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
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
    const catalogResponse = await fetch(new URL(binding.catalogUrl, baseUrl));
    const catalogBody = await catalogResponse.text();
    expect(catalogResponse.status, catalogBody).toBe(200);
    const catalog = JSON.parse(catalogBody) as {
      entries: Array<{ packageId?: string; packageUrl: string; sourceKey?: string }>;
    };
    expect(catalog.entries).toHaveLength(2);
    const rootEntry = catalog.entries.find((entry) => entry.packageId === ROOT_PACKAGE_ID);
    const instanceEntry = catalog.entries.find((entry) => entry.packageId === INSTANCE_PACKAGE_ID);
    expect(rootEntry).toBeDefined();
    expect(instanceEntry).toBeDefined();
    if (rootEntry === undefined || instanceEntry === undefined) {
      throw new Error('expected root and instance Catalog rows');
    }
    expect(rootEntry.sourceKey).toBe('sampler/main');
    expect(instanceEntry.sourceKey).toBe('sampler/main');
    expect(instanceEntry.packageUrl).not.toBe(rootEntry.packageUrl);

    const rootPackage = await fetch(new URL(rootEntry.packageUrl, baseUrl));
    const instancePackage = await fetch(new URL(instanceEntry.packageUrl, baseUrl));
    expect(rootPackage.status).toBe(200);
    const instanceBody = await instancePackage.text();
    expect(instancePackage.status, instanceBody).toBe(200);
    expect((await rootPackage.json()).assets[0].payload.magFilter).toBe('linear');
    expect(JSON.parse(instanceBody).assets[0].payload.magFilter).toBe('nearest');

    await writeFile(
      join(assets, 'nearest.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: INSTANCE_PACKAGE_ID,
        parent: ROOT_PACKAGE_ID,
        values: { filter: 'linear' },
      }),
    );
    const refreshed = await waitFor(
      async () => {
        const response = await fetch(new URL(binding.catalogUrl, baseUrl));
        return (await response.json()) as typeof catalog;
      },
      (next) =>
        next.entries.find((entry) => entry.packageId === INSTANCE_PACKAGE_ID)?.packageUrl !==
        instanceEntry.packageUrl,
    );
    const refreshedEntry = refreshed.entries.find(
      (entry) => entry.packageId === INSTANCE_PACKAGE_ID,
    );
    if (refreshedEntry === undefined) throw new Error('expected the refreshed instance row');
    const refreshedPackage = await fetch(new URL(refreshedEntry.packageUrl, baseUrl));
    expect(refreshedPackage.status).toBe(200);
    expect((await refreshedPackage.json()).assets[0].payload.magFilter).toBe('linear');
  }, 60_000);

  it('publishes a direct producer-backed Pack through the dev cooked transport', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-direct-pack-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const packageId = '019a0000-0000-7000-8000-000000000014';
    const parsedPackageId = PackageId.parse(packageId);
    if (!parsedPackageId.ok) throw parsedPackageId.error;
    const guid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'vfx/main'));
    await writeFile(
      join(assets, 'direct.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: {
          'vfx/main': {
            kind: 'particle-effect',
            payload: {
              schemaVersion: 3,
              emitters: [{ id: 'main', program: { module: 'main.vfx.wgsl' }, renderers: [] }],
            },
            refs: [],
          },
        },
      }),
    );
    const cooker: NativeCooker = {
      key: 'particle-effect',
      cook: ({ guid: inputGuid }) => ({
        guid: inputGuid,
        payload: {
          kind: 'particle-effect',
          schemaVersion: 3,
          programFingerprint: 'sha256:dev-cooked',
          emitters: [],
          program: {
            format: 'forgeax-vfx-program-4',
            fingerprint: 'sha256:dev-cooked',
            emitters: [],
          },
        },
        refs: [],
        artifacts: {
          program: {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode('{"program":"dev-cooked"}'),
          },
        },
        inputFingerprint: 'sha256:dev-cooked',
      }),
    };

    const binding = createStandaloneRuntimeAssetBinding('direct-pack-vite');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      cookers: [cooker],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
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
    const catalogResponse = await fetch(new URL(binding.catalogUrl, baseUrl));
    const catalogBody = await catalogResponse.text();
    expect(catalogResponse.status, catalogBody).toBe(200);
    const catalog = (await JSON.parse(catalogBody)) as {
      entries: Array<{
        guid: string;
        kind: string;
        packageUrl: string;
        execution?: string;
      }>;
    };
    const entry = catalog.entries.find((candidate) => candidate.guid === guid);
    expect(entry).toMatchObject({ guid, kind: 'particle-effect', execution: 'cooked' });
    if (entry === undefined) throw new Error('expected the direct cooked Catalog row');
    const packageResponse = await fetch(new URL(entry.packageUrl, baseUrl));
    const packageBody = await packageResponse.text();
    expect(packageResponse.status, packageBody).toBe(200);
    const pack = JSON.parse(packageBody) as {
      assets: Array<{
        guid: string;
        payload: { programFingerprint?: string };
        artifacts: Record<string, { path: string }>;
      }>;
    };
    const asset = pack.assets.find((candidate) => candidate.guid === guid);
    expect(asset).toMatchObject({
      payload: { programFingerprint: 'sha256:dev-cooked' },
      artifacts: { program: { path: expect.any(String) } },
    });
    if (asset === undefined) throw new Error('expected the direct cooked Pack asset');
    const artifactPath = asset.artifacts.program?.path;
    if (artifactPath === undefined) throw new Error('expected the direct cooked artifact');
    const artifactResponse = await fetch(new URL(artifactPath, new URL(entry.packageUrl, baseUrl)));
    const artifactBody = await artifactResponse.text();
    expect(artifactResponse.status, artifactBody).toBe(200);
    expect(artifactBody).toBe('{"program":"dev-cooked"}');
  }, 60_000);

  it('accepts direct Pack refs to a separately declared Meta asset', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-direct-pack-meta-ref-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const packageId = '019a0000-0000-7000-8000-000000000015';
    const parsedPackageId = PackageId.parse(packageId);
    if (!parsedPackageId.ok) throw parsedPackageId.error;
    const sceneGuid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'scene/main'));
    const externalGuid = '019a0000-0000-7000-8000-000000000016';
    const imageImporter: Importer = {
      key: 'image',
      import: async () => ({
        ok: true,
        value: {
          assets: [
            {
              guid: externalGuid,
              kind: 'equirect',
              payload: {
                kind: 'equirect',
                width: 1,
                height: 1,
                format: 'rgba16float',
                data: new Uint8Array(8),
                colorSpace: 'linear',
              },
              refs: [],
              artifacts: {},
            },
          ],
          sourceDependencies: [],
        },
      }),
    };
    await writeFile(join(assets, 'sky.hdr'), 'fixture');
    await writeFile(
      join(assets, 'sky.hdr.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: 'sky.hdr',
        importSettings: {},
        subAssets: [{ guid: externalGuid, sourceIndex: 0, kind: 'equirect' }],
      }),
    );
    await writeFile(
      join(assets, 'scene.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: {
          'scene/main': {
            kind: 'scene',
            payload: { kind: 'scene', entities: {} },
            refs: [externalGuid],
          },
        },
      }),
    );

    const binding = createStandaloneRuntimeAssetBinding('direct-pack-meta-ref-vite');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      importers: [imageImporter],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
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
    const catalogResponse = await fetch(new URL(binding.catalogUrl, baseUrl));
    const catalogBody = await catalogResponse.text();
    expect(catalogResponse.status, catalogBody).toBe(200);
    const catalog = JSON.parse(catalogBody) as {
      entries: Array<{ guid: string; packageUrl: string; refs?: readonly string[] }>;
    };
    const scene = catalog.entries.find((entry) => entry.guid === sceneGuid);
    const external = catalog.entries.find((entry) => entry.guid === externalGuid);
    expect(scene).toMatchObject({ guid: sceneGuid, refs: [externalGuid] });
    expect(external).toMatchObject({ guid: externalGuid });
    if (scene === undefined) throw new Error('expected the direct scene Catalog row');
    const packageResponse = await fetch(new URL(scene.packageUrl, baseUrl));
    const packageBody = await packageResponse.text();
    expect(packageResponse.status, packageBody).toBe(200);
    expect(JSON.parse(packageBody).assets[0].refs).toEqual([externalGuid]);
  }, 60_000);
});
