// asset-registry-scene.test-d - type-level assertion that the 5-element
// AssetUnion exhaustive switch narrows correctly without a default arm
// (feat-20260514-scene-as-world-blueprint w6 / AC-01 / AC-03; merged with
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15 which
// retired the `'instanced-buffer-asset'` variant -> Asset closed-union
// 5 -> 4, then widened to 5 again with the new `'scene'` member).
//
// w3 widens `Asset` to include `SceneAsset` and the runtime `assetBrand`
// switch grows a 'scene' arm. The exhaustive switch below doubles as a
// negative regression: deleting any case produces a `never` flow (TS reports
// `Type 'SceneAsset' is not assignable to type 'never'` at the affected
// arm), so this file fails fast if the union ever drifts.
//
// Charter mapping: proposition 3 (machine-readable union > prose) +
// proposition 4 (explicit failure: closed-union exhaustive switch needs no
// default fallback; tsc strict mode guards completeness).

import type { Asset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

type AssetBrand =
  | 'MeshAsset'
  | 'TextureAsset'
  | 'CubeTextureAsset'
  | 'SamplerAsset'
  | 'MaterialAsset'
  | 'SceneAsset'
  | 'SkeletonAsset'
  | 'SkinAsset'
  | 'AnimationClip'
  | 'AudioClipAsset'
  | 'ShaderAsset'
  | 'FontAsset'
  | 'RenderPipelineAsset'
  | 'TilesetAsset';

function brand(asset: Asset): AssetBrand {
  switch (asset.kind) {
    case 'mesh':
      return 'MeshAsset';
    case 'texture':
      return 'TextureAsset';
    case 'cube-texture':
      return 'CubeTextureAsset';
    case 'sampler':
      return 'SamplerAsset';
    case 'material':
      return 'MaterialAsset';
    case 'scene':
      return 'SceneAsset';
    case 'skeleton':
      return 'SkeletonAsset' as AssetBrand;
    case 'skin':
      return 'SkinAsset' as AssetBrand;
    case 'animation-clip':
      return 'AnimationClip' as AssetBrand;
    case 'audio':
      return 'AudioClipAsset' as AssetBrand;
    case 'shader':
      return 'ShaderAsset' as AssetBrand;
    case 'font':
      return 'FontAsset' as AssetBrand;
    case 'render-pipeline':
      return 'RenderPipelineAsset' as AssetBrand;
    case 'tileset':
      return 'TilesetAsset' as AssetBrand;
  }
}

describe('AssetUnion exhaustive switch covers all 14 members (feat-20260608 M0 baseline rebuild)', () => {
  it('brand(asset) returns the AssetBrand union without a default arm', () => {
    expectTypeOf(brand).returns.toEqualTypeOf<AssetBrand>();
  });
});
