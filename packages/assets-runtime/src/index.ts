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

export type {
  AnimationClip,
  AnimationGraph,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
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
export { defineAssetKind } from './asset-kind.js';
// ─── AssetRegistry + Asset / MeshAsset type aliases ─────────────────────────
export type {
  Asset,
  CatalogReconcileError,
  CatalogReconcileResult,
  MeshAsset,
} from './asset-registry';
export { AssetRegistry } from './asset-registry';
// ─── Process-static builtin payload registry + vertex-layout SSOT ───────────
export {
  BUILTIN_BASE,
  BUILTIN_CUBE,
  BUILTIN_CYLINDER,
  BUILTIN_NINESLICE_QUAD,
  BUILTIN_QUAD,
  BUILTIN_SPHERE,
  BUILTIN_TRIANGLE,
  BuiltinAssetRegistry,
} from './builtin-asset-registry';
export { type CatalogListener, type CatalogSource, createCatalogSource } from './catalog-source';
// ─── Runtime image byte decoder (tweak-20260714 M1) ──────────────────────────
export { decodeImageBytes } from './decode-image-bytes';
// ─── Dynamic per-frame texture store ────────────────────────────────────────
export {
  adaptDynamicTextureDevice,
  type DynamicTextureDevice,
  DynamicTextureStore,
} from './dynamic-texture-store';
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
  MeshBinAssetError,
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from './errors/asset';
// ─── Builtin mesh handles (re-exported by asset-registry from ./handles) ─────
export {
  builtinMeshGuid,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './handles';
// The five-action runtime registry is distinct from the legacy authoring
// AssetRegistry class above. Keep its resolver on the public package boundary
// so render/VFX hosts never reach through `/internal` to inspect loaded assets.
export {
  type AssetRegistry as RuntimeAssetRegistry,
  type AssetRegistryResolver,
  createAssetRegistry,
  getAssetRegistryResolver,
} from './internal/load-asset.js';
// ─── Loader-injection surface ───────────────────────────────────────────────
export { LoaderRegistry } from './loader-registry';
// ─── Default loader tables + individual loaders (pre-w14 consumer face) ──────
export {
  animationClipLoader,
  animationGraphLoader,
  audioLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  particleEffectLoader,
  renderPipelineLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
  tilesetLoader,
} from './loaders/inline-pack';
// ─── Mesh binary container decode ───────────────────────────────────────────
export {
  type UnpackedMeshBin,
  unpackMeshBinV4,
} from './loaders/mesh-bin';
export {
  equirectLoader,
  fontLoader,
  PACK_ARTIFACT_LOADERS,
  renderPipelineLoader as renderPipelineArtifactLoader,
  textureLoader,
  tilesetLoader as tilesetArtifactLoader,
} from './loaders/pack-artifact';
export { MaterialGenerationCache } from './material/generation-cache';
export { inspectMaterialRuntime, type MaterialRuntimeInfo } from './material/inspection';
export {
  createMaterialLoader,
  type MaterialLoadError,
  type MaterialLoadErrorCode,
  type MaterialLoadErrorDetail,
  type MaterialLoaderOptions,
  type MaterialLoadRequest,
  type MaterialPublication,
  type MaterialReady,
} from './material/loader';
export {
  installMaterialReadyShaders,
  materialParametersToParamSchema,
  runtimeMaterialShaderId,
} from './material/runtime-shader';
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
export { assetLoaderPlugin, assetsPlugin, packLoaderPlugin } from './plugin';
export {
  createRuntimeAssetEvidenceAdapter,
  type RuntimeEvidenceSource,
} from './registry/asset-evidence';
export { CatalogReplica, type CatalogReplicaSnapshot } from './registry/catalog-state';
export type { PostSpawnHook, SkinJointResolver } from './registry/instantiate';
// ─── Scene instantiate collaboration contract types (D-1 injected hook) ─────
export { buildSceneChildContext } from './registry/instantiate';
export { loadMaterialReadyByGuid } from './registry/load-by-guid';
export {
  compareScenePublicationFences,
  createScenePublicationFence,
  observeScenePublication,
  parseScenePublicationFence,
  SCENE_PUBLICATION_FENCE_SCHEMA,
  SCENE_PUBLICATION_RECOVERY_ACTIONS,
  type ScenePublicationFence,
  type ScenePublicationFenceError,
  type ScenePublicationFencePhase,
  type ScenePublicationObservation,
  scenePublicationFenceFromCatalog,
} from './registry/scene-publication-fence';
// ─── Handle-to-payload resolution ───────────────────────────────────────────
export { resolveAssetHandle, walkMaterialPassesOverSharedRefs } from './resolve-asset-handle';
export {
  type ResolvedTilesetRuntime,
  resolveTilesetRuntime,
  type TilesetAtlasLookup,
  type TilesetRuntimeError,
  type TilesetRuntimeErrorCode,
} from './resolve-tileset-runtime';
// Public scene-pack boundary: editor/play hosts reuse the engine's canonical
// refs-index -> SceneAsset reconstruction when refreshing a saved SceneAsset.
export { parseScenePayload } from './scene-payload';
export { createDefaultLoaderRegistry, wireDefaultLoaders } from './wire-default-loaders';
