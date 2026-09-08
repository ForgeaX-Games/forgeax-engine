import type {
  AnimationClip,
  AnimationGraph,
  AssetGuid,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TextureAsset,
  TilesetAsset,
  VideoAsset,
} from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  ScriptablePackAssetDeclarations,
  ScriptablePackAssetFor,
  ScriptablePackAssetKind,
  ScriptablePackGatewayOperation,
  ScriptablePackOutputs,
} from '../scriptable-pack.js';
import { SCRIPTABLE_PACK_ASSET_KINDS } from '../scriptable-pack.js';

function typeContract(): void {
  const meshGuid = null as unknown as AssetGuid;
  const sceneGuid = null as unknown as AssetGuid;
  const mesh = null as unknown as MeshAsset;
  const scene = null as unknown as SceneAsset;

  const assets = {
    mesh: { guid: meshGuid, kind: 'mesh' },
    scene: { guid: sceneGuid, kind: 'scene' },
  } as const satisfies ScriptablePackAssetDeclarations;

  const valid = { mesh, scene } satisfies ScriptablePackOutputs<typeof assets>;
  void valid;

  // @ts-expect-error mesh descriptor requires MeshAsset
  const wrongKind = { mesh: scene, scene } satisfies ScriptablePackOutputs<typeof assets>;
  void wrongKind;

  const allKinds = SCRIPTABLE_PACK_ASSET_KINDS;
  type ExpectedKinds =
    | MeshAsset
    | MaterialAsset
    | SceneAsset
    | TextureAsset
    | EquirectAsset
    | SamplerAsset
    | FontAsset
    | RenderPipelineAsset
    | TilesetAsset
    | VideoAsset
    | SkeletonAsset
    | SkinAsset
    | AnimationClip
    | AnimationGraph
    | AudioClipAsset
    | ParticleEffectAsset;
  type DiscoveredKinds = ScriptablePackAssetFor<{
    readonly guid: AssetGuid;
    readonly kind: (typeof allKinds)[number];
  }>;
  expectTypeOf<DiscoveredKinds>().toEqualTypeOf<ExpectedKinds>();

  // @ts-expect-error unknown kinds cannot enter the ordinary producer matrix
  const unknownKind: ScriptablePackAssetKind = 'unknown-kind';
  void unknownKind;

  // @ts-expect-error scene output is required
  const missing = { mesh } satisfies ScriptablePackOutputs<typeof assets>;
  void missing;

  // @ts-expect-error plain strings are not AssetGuid values
  const plainStringGuid: AssetGuid = '019ffa97-a5ee-7645-b613-043323952808';
  void plainStringGuid;

  const gatewayOperations = [
    {
      requestId: 'create',
      kind: 'create-scriptable-pack',
      sourcePath: 'new.pack.ts',
      initialOutput: { sourceKey: 'scene', kind: 'scene' },
    },
    {
      requestId: 'add',
      kind: 'add-output',
      sourcePath: 'new.pack.ts',
      sourceKey: 'mesh',
      assetKind: 'mesh',
    },
    {
      requestId: 'external',
      kind: 'add-external-asset',
      sourcePath: 'new.pack.ts',
      alias: 'material',
      guid: meshGuid,
    },
    {
      requestId: 'rename',
      kind: 'rename-display',
      sourcePath: 'new.pack.ts',
      target: { kind: 'output', sourceKey: 'mesh' },
      name: 'Wall',
    },
    { requestId: 'remove', kind: 'remove-output', sourcePath: 'new.pack.ts', sourceKey: 'mesh' },
    {
      requestId: 'clone',
      kind: 'clone-scriptable-pack',
      sourcePath: 'new.pack.ts',
      targetPath: 'clone.pack.ts',
    },
    { requestId: 'preflight', kind: 'preflight', sourcePath: 'new.pack.ts' },
    { requestId: 'inspect', kind: 'inspect-meta', sourcePath: 'new.pack.ts' },
    { requestId: 'rebuild', kind: 'rebuild', sourcePath: 'new.pack.ts' },
    { requestId: 'cold-cook', kind: 'cold-cook', sourcePath: 'new.pack.ts' },
  ] as const satisfies readonly ScriptablePackGatewayOperation[];
  void gatewayOperations;
}

describe('ScriptablePack public type contract', () => {
  it('constrains output payloads, GUID brands, and gateway operations', () => {
    typeContract();
  });
});
