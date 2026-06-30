// biome-ignore-all assist/source/organizeImports: the Children export must
// precede ChildOf so the mirror component is defined before the relationship
// holder under ESM evaluation order (feat-20260602 M2 define-time mirror
// validation); alphabetical sorting would reorder them and crash the package
// import.
//
// @forgeax/engine-runtime/components - 5 component schemas (re-export hub).
//
// Single import surface for the M1 5-component set
// (charter proposition 1 progressive disclosure / plan-strategy 7.4
// discoverability single-import contract):
//
//   import {
//     Transform, MeshFilter, MeshRenderer,
//     Camera, DirectionalLight,
//   } from '@forgeax/engine-runtime';
//
// Pair these with `HANDLE_CUBE` / `HANDLE_TRIANGLE` (from
// `@forgeax/engine-runtime/asset-registry`) to spawn entities the engine RenderSystem
// can iterate.
//
// feat-20260517-merge-mesh-renderer-material-renderer M2 / w7: the legacy
// dual material-binding component + its data-shape re-export are
// physically deleted; material asset binding is now carried by the
// merged `MeshRenderer` component (`{ material: 'shared<MaterialAsset>' }`
// schema; see `./mesh-renderer.ts` JSDoc for the migration rationale +
// AGENTS.md §Breaking changes 2026-05-17 row).

export { AnimationPlayer } from './animation-player';
export {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  type Antialias,
  antialiasFromF32,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  type BloomEnabled,
  bloomEnabledFromF32,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  type CameraProjection,
  cameraProjectionFromF32,
  orthographic,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD_EXTENDED,
  type Tonemap,
  tonemapFromF32,
} from './camera';
// Children (the mirror component) is exported before ChildOf (the holder) so
// that under ESM evaluation order `defineComponent('Children', ...)` runs
// before `defineComponent('ChildOf', { relationship: { mirror: 'Children' }})`.
// feat-20260602 M2 moved relationship-mirror validation into `defineComponent`
// itself (define-time fail-fast); a holder defined before its mirror would
// throw RelationshipMirrorComponentNotRegisteredError during module
// evaluation. Do not reorder these two lines.
export { Children } from './children';
export { ChildOf } from './child-of';
export { DirectionalLight } from './directional-light';
export { Instances, type InstancesData } from './instances';
export { Layer } from './layer';
export { MeshFilter } from './mesh-filter';
export { MeshRenderer } from './mesh-renderer';
export { Name } from './name';
export { PointLight } from './point-light';
export { PointLightShadow } from './point-light-shadow';
export { PostProcessParams } from './post-process-params';
export {
  SceneInstance,
  type SceneInstanceOverrideRecord,
  type SceneInstanceState,
} from './scene-instance';
export { Skin } from './skin';
export {
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  type SkyboxMode,
  skyboxModeFromF32,
} from './skybox-background';
export { Skylight } from './skylight';
export { SortKey } from './sort-key';
export { SpotLight } from './spot-light';
export { SpriteAnimation } from './sprite-animation';
export {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  type SpritePlaybackMode,
  spritePlaybackModeFromU32,
} from './sprite-playback-mode';
export { SpriteRegionOverride } from './sprite-region-override';
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10 —
// SpriteInstances component routed through the components barrel so
// render-system-extract can list it as an optional in `createQueryState`
// (peer to Instances). The runtime `@forgeax/engine-runtime` public re-export
// stays via packages/runtime/src/index.ts (D-7 + D-8: barrel surface is the
// public seam; module-level re-export from `./components` is the internal seam).
export { SpriteInstances, type SpriteInstancesData } from './sprite-instances';
// feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild
export {
  decodeSortScope,
  encodeSortScope,
  markTileLayerDirty,
  type SortScope,
  TileLayer,
  type TileLayerData,
} from './tile-layer';
export { Tilemap } from './tilemap';
export { Transform } from './transform';
