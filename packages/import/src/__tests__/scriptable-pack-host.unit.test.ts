import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  ImportContext,
  Importer,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ImporterRegistry } from '../importer-registry.js';
import { declaredPackExternalOutputs } from '../scriptable-pack-host.js';

const GUID = '019ffa97-0000-7000-8000-000000000001';

function parseGuid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe('ScriptablePack external Meta staging', () => {
  it('imports ordinary Meta dependencies into the current staged generation', async () => {
    const importer: Importer = {
      key: 'fixture',
      import: async (ctx: ImportContext) => ({
        ok: true,
        value: {
          assets: [
            {
              guid: ctx.subAssets[0]?.guid ?? GUID,
              kind: 'mesh',
              payload: {
                kind: 'mesh',
                vertices: new Float32Array([0, 1, 2]),
                attributes: {},
                submeshes: [],
                materialSlots: [],
              } satisfies Asset,
              refs: [],
              artifacts: {},
            },
          ],
          sourceDependencies: [],
        },
      }),
    };
    const registry = new ImporterRegistry();
    registry.register(importer);
    const declaration = {
      format: 'meta.json',
      sourcePath: '/project/assets/model.bin.meta.json',
      sourceRevision: 'sha256:meta',
      value: {
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'model.bin',
        importSettings: {},
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'mesh' }],
      },
    } satisfies Extract<ScanSourceDeclaration, { readonly format: 'meta.json' }>;

    const outputs = await declaredPackExternalOutputs(
      new Map([[declaration.sourcePath, declaration]]),
      [],
      [parseGuid(GUID)],
      {
        importerRegistry: registry,
        fsForImport: {
          readSource: async () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }),
        },
        assetPaths: {},
      },
    );

    expect(outputs).toHaveLength(1);
    const output = outputs[0];
    expect(output).toBeDefined();
    if (output === undefined) return;
    expect(AssetGuid.format(output.guid)).toBe(GUID);
    expect(output.asset).toMatchObject({ kind: 'mesh' });
    expect(Array.from((output.asset as Asset & { vertices: Float32Array }).vertices)).toEqual([
      0, 1, 2,
    ]);
  });
});
