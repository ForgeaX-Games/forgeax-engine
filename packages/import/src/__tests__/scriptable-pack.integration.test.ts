import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  ScriptablePackAssetDeclarations,
  ScriptablePackDefinition,
} from '@forgeax/engine-pack/source';
import type { Asset, AssetGuid as AssetGuidType, MeshAsset } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type AssetOutputPayload,
  AssetOutputProducerRegistry,
  buildScriptablePack,
  type ScriptablePackAssetSnapshotSource,
} from '../scriptable-pack.js';

function fixturePayload(asset: Asset): AssetOutputPayload {
  switch (asset.kind) {
    case 'material':
      return { kind: 'material', values: {} };
    case 'scene':
      return { kind: 'scene', entities: [] };
    case 'font':
      return {
        kind: 'font',
        glyphs: asset.glyphs,
        common: asset.common,
        atlasGuid: AssetGuid.format(asset.atlas),
        samplerGuid: AssetGuid.format(asset.sampler),
      };
    case 'tileset':
      return { ...asset, atlases: asset.atlases.map((_atlas, index) => index) };
    case 'animation-graph':
      return {
        kind: 'animation-graph',
        root: asset.root,
        nodes: asset.nodes.map((node) => (node.type === 'clip' ? { ...node, clip: 0 } : node)),
      };
    default:
      return asset;
  }
}

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const REFERENCE = guid('019ffa97-0000-7000-8000-000000000001');
const CONTENT = guid('019ffa97-0000-7000-8000-000000000002');
const BOTH = guid('019ffa97-0000-7000-8000-000000000003');
const UNUSED = guid('019ffa97-0000-7000-8000-000000000004');
const ASSETS = {
  mesh: { guid: guid('019ffa97-1000-7000-8000-000000000001'), kind: 'mesh' },
  material: { guid: guid('019ffa97-1000-7000-8000-000000000002'), kind: 'material' },
  scene: { guid: guid('019ffa97-1000-7000-8000-000000000003'), kind: 'scene' },
} as const satisfies ScriptablePackAssetDeclarations;

function source(
  generation = 4,
  contentDigest = 'sha256:content',
  bothDigest = 'sha256:both',
): ScriptablePackAssetSnapshotSource & { readonly original: MeshAsset } {
  const original = {
    kind: 'mesh',
    vertices: new Float32Array([1, 2, 3]),
    attributes: {},
    submeshes: [
      {
        topology: 'triangle-list',
        indexOffset: 0,
        indexCount: 0,
        vertexCount: 3,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  } satisfies MeshAsset;
  const entries = new Map([
    [AssetGuid.format(CONTENT), { asset: original as Asset, generation, digest: contentDigest }],
    [
      AssetGuid.format(BOTH),
      { asset: original as Asset, generation: generation + 3, digest: bothDigest },
    ],
  ]);
  return {
    original,
    async readByGuid(requested) {
      const entry = entries.get(AssetGuid.format(requested));
      if (entry === undefined) throw new Error('unexpected test GUID');
      return ok(entry);
    },
  };
}

function fixture(): ScriptablePackDefinition<typeof ASSETS> {
  return {
    schemaVersion: '1.0.0',
    packageId: guid('019ffa97-1000-7000-8000-000000000000'),
    assets: ASSETS,
    externalAssets: { reference: REFERENCE, content: CONTENT, both: BOTH },
    async build(reader) {
      const content = await reader.readByGuid<MeshAsset>(CONTENT);
      if (!content.ok) return content;
      content.value.vertices[0] = 99;
      const both = await reader.readByGuid<MeshAsset>(BOTH);
      if (!both.ok) return both;
      return ok({
        mesh: {
          kind: 'mesh',
          vertices: new Float32Array([0, 0, 0]),
          attributes: {},
          submeshes: [
            {
              topology: 'triangle-list',
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 3,
              materialSlot: 0,
            },
          ],
          materialSlots: [{ slotName: 'Default' }],
        },
        material: { kind: 'material', values: {} },
        scene: { kind: 'scene', entities: [] },
      });
    },
  };
}

function outputs(version = '1'): AssetOutputProducerRegistry {
  const registry = new AssetOutputProducerRegistry();
  for (const kind of ['mesh', 'material', 'scene']) {
    registry.register({
      kind,
      version: `fixture/${version}`,
      produce(input) {
        const refs =
          input.sourceKey === 'mesh'
            ? [{ guid: AssetGuid.format(REFERENCE) }]
            : input.sourceKey === 'scene'
              ? [{ guid: AssetGuid.format(BOTH), sourceField: { fieldName: 'template' } }]
              : [];
        return ok({ payload: fixturePayload(input.asset), refs, artifacts: {} });
      },
    });
  }
  return registry;
}

describe('ScriptablePack build bridge', () => {
  it('does not require an Asset snapshot source when build performs no content reads', async () => {
    const definition: ScriptablePackDefinition = {
      schemaVersion: '1.0.0',
      packageId: guid('019ffa97-1000-7000-8000-000000000010'),
      assets: {
        material: {
          guid: guid('019ffa97-1000-7000-8000-000000000011'),
          kind: 'material',
        },
      },
      externalAssets: {},
      build: () => ok({ material: { kind: 'material', values: {} } }),
    };
    const registry = new AssetOutputProducerRegistry();
    registry.register({
      kind: 'material',
      version: 'fixture/1',
      produce: (input) => ok({ payload: fixturePayload(input.asset), refs: [], artifacts: {} }),
    });

    const result = await buildScriptablePack({
      definition,
      sourcePath: 'material.pack.ts',
      outputs: registry,
      sourceClosure: [],
      authoringContractVersion: 'fixture/1',
    });

    expect(result.ok).toBe(true);
  });

  it('derives reference/content/both, protects input snapshots, and is deterministic', async () => {
    const assetSource = source();
    const options = {
      definition: fixture(),
      sourcePath: 'house.pack.ts',
      assetSource,
      outputs: outputs(),
      sourceClosure: [{ path: 'house.pack.ts', digest: 'sha256:source' }],
      authoringContractVersion: 'geometry/1',
    } as const;
    const first = await buildScriptablePack(options);
    const second = await buildScriptablePack(options);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.externalEvidence).toEqual([
      { guid: AssetGuid.format(REFERENCE), usage: 'reference' },
      {
        guid: AssetGuid.format(CONTENT),
        usage: 'content',
        generation: 4,
        digest: 'sha256:content',
      },
      {
        guid: AssetGuid.format(BOTH),
        usage: 'both',
        generation: 7,
        digest: 'sha256:both',
      },
    ]);
    expect(assetSource.original.vertices[0]).toBe(1);
    expect(first.value.inputFingerprint).toBe(second.value.inputFingerprint);
    expect(first.value.product.assets.find((asset) => asset.kind === 'scene')?.refs).toEqual([
      { guid: AssetGuid.format(BOTH), sourceField: { fieldName: 'template' } },
    ]);
  });

  it('keeps the source fingerprint stable when dependency generations advance', async () => {
    const base = {
      definition: fixture(),
      outputs: outputs(),
      sourcePath: 'assets/house.pack.ts',
      sourceClosure: [{ path: 'house.pack.ts', digest: 'sha256:source' }],
      authoringContractVersion: 'geometry/1',
    } as const;
    const first = await buildScriptablePack({ ...base, assetSource: source(4) });
    const second = await buildScriptablePack({ ...base, assetSource: source(104) });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(
      first.value.externalEvidence.find((entry) => entry.guid === AssetGuid.format(CONTENT))
        ?.generation,
    ).toBe(4);
    expect(
      second.value.externalEvidence.find((entry) => entry.guid === AssetGuid.format(CONTENT))
        ?.generation,
    ).toBe(104);
    expect(first.value.inputFingerprint).toBe(second.value.inputFingerprint);
  });

  it('keeps the build fingerprint stable across host-specific source roots', async () => {
    const base = {
      definition: fixture(),
      assetSource: source(),
      outputs: outputs(),
      authoringContractVersion: 'geometry/1',
    } as const;
    const editor = await buildScriptablePack({
      ...base,
      sourcePath: 'assets/house.pack.ts',
      sourceClosure: [
        { path: '/tmp/e2e/sample/assets/house.pack.ts', digest: 'sha256:source' },
        { path: '/tmp/e2e/sample/assets/house.pack-lib.ts', digest: 'sha256:lib' },
      ],
    });
    const carrier = await buildScriptablePack({
      ...base,
      sourcePath: 'assets/house.pack.ts',
      sourceClosure: [
        {
          path: '/workspace/play-runtime/host-games/sample/assets/house.pack.ts',
          digest: 'sha256:source',
        },
        {
          path: '/workspace/play-runtime/host-games/sample/assets/house.pack-lib.ts',
          digest: 'sha256:lib',
        },
      ],
    });
    expect(editor.ok).toBe(true);
    expect(carrier.ok).toBe(true);
    if (!editor.ok || !carrier.ok) return;
    expect(editor.value.inputFingerprint).toBe(carrier.value.inputFingerprint);
  });

  it('invalidates the input fingerprint when closure, evidence, or producer versions change', async () => {
    const definition = fixture();
    const base = {
      definition,
      sourcePath: 'house.pack.ts',
      assetSource: source(4, 'sha256:content-a', 'sha256:both-a'),
      outputs: outputs('1'),
      sourceClosure: [{ path: 'house.pack.ts', digest: 'sha256:source-a' }],
      authoringContractVersion: 'geometry/1',
    } as const;
    const stable = await buildScriptablePack(base);
    const closureChanged = await buildScriptablePack({
      ...base,
      sourceClosure: [{ path: 'house.pack.ts', digest: 'sha256:source-b' }],
    });
    const evidenceChanged = await buildScriptablePack({
      ...base,
      assetSource: source(5, 'sha256:content-b', 'sha256:both-b'),
    });
    const producerChanged = await buildScriptablePack({ ...base, outputs: outputs('2') });

    expect(stable.ok && closureChanged.ok).toBe(true);
    expect(stable.ok && evidenceChanged.ok).toBe(true);
    expect(stable.ok && producerChanged.ok).toBe(true);
    if (!stable.ok || !closureChanged.ok || !evidenceChanged.ok || !producerChanged.ok) return;
    expect(closureChanged.value.inputFingerprint).not.toBe(stable.value.inputFingerprint);
    expect(evidenceChanged.value.inputFingerprint).not.toBe(stable.value.inputFingerprint);
    expect(producerChanged.value.inputFingerprint).not.toBe(stable.value.inputFingerprint);
  });

  it('fails when an external declaration is unused', async () => {
    const definition = fixture();
    const result = await buildScriptablePack({
      definition: {
        ...definition,
        externalAssets: { ...definition.externalAssets, unused: UNUSED },
      },
      sourcePath: 'unused.pack.ts',
      assetSource: source(),
      outputs: outputs(),
      sourceClosure: [],
      authoringContractVersion: 'geometry/1',
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-external-closure-mismatch',
        detail: { unusedDeclaredGuids: [AssetGuid.format(UNUSED)] },
      },
    });
  });

  it('fails when an output reference is not declared in the external closure', async () => {
    const definition = fixture();
    const result = await buildScriptablePack({
      definition: {
        ...definition,
        externalAssets: { content: CONTENT, both: BOTH },
      },
      sourcePath: 'undeclared-reference.pack.ts',
      assetSource: source(),
      outputs: outputs(),
      sourceClosure: [],
      authoringContractVersion: 'geometry/1',
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-external-closure-mismatch',
        detail: { undeclaredReferencedGuids: [AssetGuid.format(REFERENCE)] },
      },
    });
  });

  it('rejects malformed producer refs before publication', async () => {
    const invalidOutputs = outputs();
    invalidOutputs.register({
      kind: 'mesh',
      version: 'fixture/invalid-ref',
      produce: (input) =>
        ok({
          payload: fixturePayload(input.asset),
          refs: [{ guid: 'not-a-guid' }],
          artifacts: {},
        }),
    });
    const result = await buildScriptablePack({
      definition: fixture(),
      sourcePath: 'invalid-ref.pack.ts',
      assetSource: source(),
      outputs: invalidOutputs,
      sourceClosure: [],
      authoringContractVersion: 'geometry/1',
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-output-invalid',
        detail: { kindMismatches: [{ actual: 'not-a-guid' }] },
      },
    });
  });

  it('returns a structured missing-dependency error before producing outputs', async () => {
    const missing = guid('019ffa97-0000-7000-8000-000000000005');
    const definition: ScriptablePackDefinition = {
      schemaVersion: '1.0.0',
      packageId: guid('019ffa97-1000-7000-8000-000000000010'),
      assets: {
        mesh: {
          guid: guid('019ffa97-1000-7000-8000-000000000011'),
          kind: 'mesh',
        },
      },
      externalAssets: { missing },
      async build(reader) {
        const result = await reader.readByGuid<MeshAsset>(missing);
        if (!result.ok) return result;
        return ok({ mesh: result.value });
      },
    };
    const registry = new AssetOutputProducerRegistry();
    registry.register({
      kind: 'mesh',
      version: 'fixture/1',
      produce: (input) => ok({ payload: fixturePayload(input.asset), refs: [], artifacts: {} }),
    });

    const result = await buildScriptablePack({
      definition,
      sourcePath: 'missing.pack.ts',
      assetSource: {
        async readByGuid() {
          return err(
            new AssetError({
              code: 'asset-not-imported',
              expected: 'the declared external asset to be available',
              hint: 'publish the dependency before rebuilding the source package',
            }),
          );
        },
      },
      outputs: registry,
      sourceClosure: [],
      authoringContractVersion: 'fixture/1',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-not-imported',
        expected: 'the declared external asset to be available',
        hint: 'publish the dependency before rebuilding the source package',
      },
    });
  });
});
