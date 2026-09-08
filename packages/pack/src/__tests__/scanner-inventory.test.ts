import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanInventory } from '../scanner.js';

describe('AssetInventory', () => {
  const guid = '00000000-0000-0000-0000-000000000002';
  let root: string | undefined;
  let sourcePath: string | undefined;
  let result: Awaited<ReturnType<typeof scanInventory>> | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scanner-inventory-'));
    sourcePath = join(root, 'generated.pack.ts');
    await writeFile(
      sourcePath,
      [
        'const packageId = new Uint8Array(16);',
        'packageId[15] = 1;',
        'const meshGuid = new Uint8Array(16);',
        'meshGuid[15] = 2;',
        'export default {',
        "schemaVersion: '1.0.0', packageId,",
        "assets: { mesh: { guid: meshGuid, kind: 'mesh' } }, externalAssets: {},",
        "build: () => ({ ok: true, value: { mesh: { kind: 'mesh' } } }),",
        '};',
      ].join('\n'),
    );
    result = await scanInventory([root]);
  });

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const getFixture = () => {
    if (result === undefined || sourcePath === undefined) {
      throw new Error('scanner fixture was not initialized');
    }
    if (!result.ok) throw new Error('scanner fixture failed');
    return { inventory: result.value, sourcePath };
  };

  it('projects the ScriptablePack declaration and owner outputs', () => {
    const { inventory, sourcePath } = getFixture();
    const declaration = inventory.declarations.get(sourcePath);
    expect(declaration).toMatchObject({
      format: 'pack.ts',
      sourcePath,
      meta: {
        importer: 'pack-ts',
        subAssets: [{ guid, sourceKey: 'mesh', kind: 'mesh' }],
      },
    });
  });

  it('projects source closure evidence', async () => {
    const { inventory, sourcePath } = getFixture();
    const declaration = inventory.declarations.get(sourcePath);
    expect(
      declaration?.format === 'pack.ts'
        ? declaration.sourceClosure.map((entry) => entry.path)
        : undefined,
    ).toEqual([await realpath(sourcePath)]);
  });

  it('indexes the ScriptablePack declaration without a second metadata registry', () => {
    const { inventory, sourcePath } = getFixture();
    const declaration = inventory.declarations.get(sourcePath);
    expect(inventory.inventory).toEqual([]);
    expect(declaration?.format === 'pack.ts' ? declaration.meta.subAssets : undefined).toEqual([
      { guid, sourceIndex: 0, sourceKey: 'mesh', kind: 'mesh' },
    ]);
  });
});
