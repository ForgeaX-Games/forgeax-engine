// @forgeax/engine-assets-runtime -- public API barrel.
//
// Tier 2.1 package extracted from @forgeax/engine-runtime
// (feat-20260705-runtime-tier2-decomposition M1). The asset registry, loader
// registry, GUID resolution, default-loader wiring, builtin handles, and the
// dynamic-texture / mipmap helpers live here; the runtime package injects the
// post-spawn hook + extra loaders (audio / video) at the createRenderer
// assembly point.
//
// w14 public surface: exports exactly the asset-cluster symbols that the
// runtime package (src + __tests__) consumes plus what the pre-w14 runtime
// barrel re-exported to external consumers. Downstream apps repoint to this
// package in w15 (the runtime barrel no longer re-exports any asset symbol).

// ─── AssetRegistry + Asset / MeshAsset type aliases ─────────────────────────
export type { Asset, MeshAsset } from './asset-registry';
export { AssetRegistry } from './asset-registry';
// ─── Process-static builtin payload registry + vertex-layout SSOT ───────────
export {
  BUILTIN_BASE,
  BUILTIN_CUBE,
  BUILTIN_CYLINDER,
  BUILTIN_FLOATS_PER_VERTEX,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
  BuiltinAssetRegistry,
} from './builtin-asset-registry';
// ─── Runtime image byte decoder (tweak-20260714 M1) ──────────────────────────
export { decodeImageBytes } from './decode-image-bytes';
// ─── Dynamic per-frame texture store ────────────────────────────────────────
export { type DynamicTextureDevice, DynamicTextureStore } from './dynamic-texture-store';
// ─── Asset cluster error model (closed union + classes) ─────────────────────
export type {
  AssetRuntimeError,
  AssetRuntimeErrorCode,
  MaterialResolvedEmptyPassesDetail,
  SceneCollectAssetGuidUnresolvedDetail,
  SceneCollectEntityRefOutOfClosureDetail,
} from './errors/asset';
export {
  MaterialResolvedEmptyPassesError,
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from './errors/asset';
// ─── Builtin mesh handles (re-exported by asset-registry from ./handles) ─────
export {
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './handles';
// ─── Loader-injection surface ───────────────────────────────────────────────
export { LoaderRegistry } from './loader-registry';
// ─── Default loader tables + individual loaders (pre-w14 consumer face) ──────
export {
  animationClipLoader,
  animationGraphLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
} from './loaders/inline-pack';
export {
  equirectLoader,
  fontLoader,
  textureLoader,
  UPSTREAM_ENTRY_LOADERS,
} from './loaders/upstream-entry';
// ─── Mesh binary container decode ───────────────────────────────────────────
export { unpackMeshBin } from './mesh-bin';
// ─── Mipmap generation helpers ──────────────────────────────────────────────
export {
  blitMipmapsSync,
  getOrCreateMipmapPipeline,
  type MipmapBlitDevice,
  type MipmapShaderModuleFactory,
  mipmapCacheSize,
  numMipLevels,
} from './mipmap-generator';
// ─── Register-time payload validation ───────────────────────────────────────
export { type TilesetValidateOptions, validateTilesetPayload } from './payload-validate';
export type { PostSpawnHook, SkinJointResolver } from './registry/instantiate';
// ─── Scene instantiate collaboration contract types (D-1 injected hook) ─────
export { buildSceneChildContext } from './registry/instantiate';
// ─── Handle-to-payload resolution ───────────────────────────────────────────
export { resolveAssetHandle, walkMaterialPassesOverSharedRefs } from './resolve-asset-handle';
export { createDefaultLoaderRegistry, wireDefaultLoaders } from './wire-default-loaders';
