import {
  type AssetOutputPayload,
  AssetOutputProducerRegistry,
  produceScriptableSourcePackage,
} from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  ScriptablePackAssetDeclarations,
  ScriptablePackDefinition,
} from '@forgeax/engine-pack/source';
import type { AssetGuid as AssetGuidType } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const MESH_GUID = guid('019ffa97-2000-7000-8000-000000000001');
const ASSETS = {
  mesh: { guid: MESH_GUID, kind: 'mesh', name: 'Mesh' },
} as const satisfies ScriptablePackAssetDeclarations;

function definition(): ScriptablePackDefinition<typeof ASSETS> {
  return {
    schemaVersion: '1.0.0',
    packageId: guid('019ffa97-2000-7000-8000-000000000000'),
    name: 'Published Fixture',
    assets: ASSETS,
    externalAssets: {},
    build: () =>
      ok({
        mesh: {
          kind: 'mesh',
          vertices: new Float32Array([0, 0, 0]),
          attributes: {},
          submeshes: [
            {
              topology: 'triangle-list',
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 1,
              materialSlot: 0,
            },
          ],
          materialSlots: [{ slotName: 'Default' }],
        },
      }),
  };
}

function outputRegistry(): AssetOutputProducerRegistry {
  const registry = new AssetOutputProducerRegistry();
  registry.register({
    kind: 'mesh',
    version: 'fixture/1',
    produce: (input) => ok({ payload: input.asset as AssetOutputPayload, refs: [], artifacts: {} }),
  });
  return registry;
}

describe('ScriptablePack source-package producer', () => {
  it('produces one Pack v2 closure and the authored Meta artifact', async () => {
    const produced = await produceScriptableSourcePackage({
      definition: definition(),
      sourcePath: 'fixture.pack.ts',
      assetSource: { readByGuid: async () => Promise.reject(new Error('unexpected read')) },
      outputs: outputRegistry(),
      sourceClosure: [{ path: 'fixture.pack.ts', digest: 'sha256:fixture' }],
      authoringContractVersion: 'fixture/1',
    });
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    expect(produced.value.product.assets).toHaveLength(1);
    const metaArtifact = produced.value.product.assets[0]?.artifacts['scriptable-pack.meta.json'];
    expect(metaArtifact).toBeDefined();
    if (metaArtifact === undefined) return;
    const meta = JSON.parse(new TextDecoder().decode(metaArtifact.bytes)) as {
      readonly importer: string;
      readonly subAssets: readonly unknown[];
    };
    expect(meta.importer).toBe('pack-ts');
    expect(meta.subAssets).toHaveLength(1);
  });
});
