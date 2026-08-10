import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const GUID = '00000000-0000-4000-8000-000000000003';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
            body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
          },
        },
      ],
      sourceDependencies: ['fixture.scene'],
    },
  }),
};

describe('production Pack bundle contract', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('emits the source-package product through the hashed production sink', async () => {
    const root = await mkdtemp('/tmp/forgeax-pack-build-');
    roots.push(root);
    const assets = resolve(root, 'assets');
    const dist = resolve(root, 'dist');
    await mkdir(assets);
    await writeFile(resolve(assets, 'fixture.scene'), 'fixture');
    await writeFile(
      resolve(assets, 'fixture.scene.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'fixture.scene',
        importSettings: {},
        subAssets: [
          { guid: GUID, sourceIndex: 0, sourceKey: 'fixture/main', kind: 'fixture-mesh' },
        ],
      }),
    );
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const emitted: Array<{ fileName?: string; name?: string; source?: string | Uint8Array }> = [];
      const plugin = pluginPack({ roots: [assets], importers: [fixtureImporter] });
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return `assets/${referenceId}-hash`;
        },
      });
      await mkdir(dist, { recursive: true });
      await plugin.writeBundle({ dir: dist });

      const catalog = JSON.parse(
        String(emitted.find((asset) => asset.fileName === 'pack-index.json')?.source),
      ) as Array<{ guid: string; packageUrl: string }>;
      const row = catalog.find((entry) => entry.guid.toLowerCase() === GUID);
      expect(row?.packageUrl).toMatch(/^\/assets\/.*-hash$/);
      expect(await readFile(resolve(dist, 'assets', `${GUID}-body.bin`))).toEqual(
        Buffer.from([4, 5, 6]),
      );
      expect(
        emitted.some((asset) => asset.source?.toString().includes('createDevImportTransport')),
      ).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('keeps the build owner on the semantic producer and outside runtime transport', async () => {
    const source = await readFile(resolve(ROOT, 'src', 'build', 'plugin-build.ts'), 'utf8');
    expect(source).toContain('produceSourcePackage');
    expect(source).not.toMatch(/createDevImportTransport|@forgeax\/engine-runtime/);
  });
});
