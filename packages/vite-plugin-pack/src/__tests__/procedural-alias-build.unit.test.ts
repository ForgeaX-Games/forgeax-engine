import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build as viteBuild } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const CUBE_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';

const PROCEDURAL_META = JSON.stringify({
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  importer: 'gltf',
  source: 'cube-mesh.stub',
  importSettings: {
    geometry: 'procedural',
  },
  subAssets: [{ guid: CUBE_GUID, sourceIndex: 0, kind: 'mesh' }],
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('procedural source aliases', () => {
  it('builds without an importer and omits the buildless alias from the production catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-procedural-alias-'));
    roots.push(root);
    const assets = join(root, 'assets');
    const dist = join(root, 'dist');
    await mkdir(assets, { recursive: true });
    await writeFile(join(root, 'main.js'), 'console.log("procedural alias");\n');
    await writeFile(join(assets, 'cube-mesh.stub'), '');
    await writeFile(join(assets, 'cube-mesh.stub.meta.json'), PROCEDURAL_META);

    await viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: dist,
        emptyOutDir: true,
        rollupOptions: { input: { main: 'main.js' } },
      },
      plugins: [pluginPack({ roots: [assets] })],
    });

    const catalog = JSON.parse(await readFile(join(dist, 'pack-index.json'), 'utf8')) as Array<{
      guid: string;
    }>;
    expect(catalog.some((entry) => entry.guid.toLowerCase() === CUBE_GUID)).toBe(false);
  });
});
