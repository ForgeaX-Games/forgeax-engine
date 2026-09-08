import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { produceScriptablePackProducts } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScriptablePackDefinition } from '@forgeax/engine-pack/source';
import { inventoryScriptablePackSource } from '@forgeax/engine-pack/source-node';
import type { AssetGuid as AssetGuidType, MeshAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function mesh(seed: number): MeshAsset {
  const vertices = new Float32Array([
    seed,
    0.7,
    0,
    0,
    0,
    1,
    0.5,
    1,
    0,
    0,
    0,
    1,
    -0.7,
    -0.6,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    1,
    0.7,
    -0.6,
    0,
    0,
    0,
    1,
    1,
    0,
    0,
    0,
    0,
    1,
  ]);
  return {
    kind: 'mesh',
    vertices,
    indices: new Uint16Array([0, 1, 2]),
    attributes: { position: vertices },
    aabb: new Float32Array([-0.7, -0.6, 0, 0.7, 0.7, 0]),
    submeshes: [
      {
        topology: 'triangle-list',
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

describe('ScriptablePack production generation host', () => {
  it('builds a ScriptablePack content dependency from the same clean staged generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-generation-'));
    const dependencyGuid = guid('019ffa97-4000-7000-8000-000000000001');
    const derivedGuid = guid('019ffa97-4000-7000-8000-000000000002');
    const dependencyPath = join(root, 'dependency.pack.ts');
    const derivedPath = join(root, 'derived.pack.ts');
    try {
      await writeFile(dependencyPath, '// dependency source closure\n');
      await writeFile(derivedPath, '// derived source closure\n');
      const dependencyClosure = await inventoryScriptablePackSource(dependencyPath);
      const derivedClosure = await inventoryScriptablePackSource(derivedPath);
      const definitions = new Map<string, ScriptablePackDefinition>([
        [
          dependencyPath,
          {
            schemaVersion: '1.0.0',
            packageId: guid('019ffa97-4000-7000-8000-000000000011'),
            assets: { mesh: { guid: dependencyGuid, kind: 'mesh' } },
            externalAssets: {},
            build: () => ok({ mesh: mesh(2) }),
          },
        ],
        [
          derivedPath,
          {
            schemaVersion: '1.0.0',
            packageId: guid('019ffa97-4000-7000-8000-000000000012'),
            assets: { derived: { guid: derivedGuid, kind: 'mesh' } },
            externalAssets: { dependency: dependencyGuid },
            async build(reader) {
              const dependency = await reader.readByGuid<MeshAsset>(dependencyGuid);
              if (!dependency.ok) return dependency;
              return ok({ derived: mesh(dependency.value.vertices[0] ?? 0) });
            },
          },
        ],
      ]);
      const products = await produceScriptablePackProducts([
        {
          sourcePath: dependencyPath,
          displaySourcePath: 'dependency.pack.ts',
          definition: definitions.get(dependencyPath) as ScriptablePackDefinition,
          sourceClosure: dependencyClosure,
          publicationGeneration: 1,
          policy: {
            base: '/',
            packagePath: 'assets/dependency.pack.json',
            artifactPath: (guid, key) => `${guid}/${key}.bin`,
          },
        },
        {
          sourcePath: derivedPath,
          displaySourcePath: 'derived.pack.ts',
          definition: definitions.get(derivedPath) as ScriptablePackDefinition,
          sourceClosure: derivedClosure,
          publicationGeneration: 1,
          policy: {
            base: '/',
            packagePath: 'assets/derived.pack.json',
            artifactPath: (guid, key) => `${guid}/${key}.bin`,
          },
        },
      ]);
      expect(products.ok).toBe(true);
      if (!products.ok) return;
      const derived = products.value.get('derived.pack.ts');
      expect(derived).toBeDefined();
      expect(derived).toMatchObject({
        product: {
          externalEvidence: [
            {
              guid: AssetGuid.format(dependencyGuid),
              usage: 'content',
              generation: expect.any(Number),
            },
          ],
        },
      });
      const dependency = products.value.get('dependency.pack.ts');
      expect(dependency).toBeDefined();
      if (dependency === undefined) return;
      expect(dependency.product.declaredGuids).toEqual([AssetGuid.format(dependencyGuid)]);
      expect(dependency.product.product.assets.map((asset) => asset.guid)).toEqual([
        AssetGuid.format(dependencyGuid),
      ]);
      expect(dependency.product.product.assets[0]?.refs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
