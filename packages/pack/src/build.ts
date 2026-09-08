// @forgeax/engine-pack/build
// Node-only catalog, source scanning, package finalization, and build evidence.

export type {
  AnimationClip,
  AnimationGraph,
  Asset,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
  MeshAsset,
  PackV2,
  PackV2Error,
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
export type { ArtifactPathContext } from './artifact-path.js';
export { validateArtifactPath } from './artifact-path.js';
export {
  buildCatalogProjection,
  type CatalogAuthority,
  type CatalogBuildError,
  type CatalogBuildErrorCode,
  type CatalogBuildProjectionOptions,
  type CatalogBuildResult,
  type CatalogImporterPolicy,
  type CatalogProducerVisibility,
  metaPathForGuid,
} from './catalog-builder.js';
export { calculateCatalogDelta } from './catalog-delta.js';
export {
  type CatalogOutputDeclaration,
  type CatalogProducerMeta,
  type CookedPackageProjection,
  catalogProjectionFor,
  currentProjectionFor,
  findReservedAssetKindConflict,
  type PackageCatalogInput,
  projectCookedPackageEntry,
  projectExternalCatalogEntries,
  projectPackageCatalog,
  projectRuntimeCatalogRow,
  type RuntimeCatalogRowInput,
} from './catalog-projection.js';
export { type LoadAssetConfigResult, loadAssetConfig } from './config.js';
export {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  type MaterialCookArtifact,
  type MaterialCookIdentityExpectation,
  type MaterialCookReceipt,
  type MaterialCookRecordError,
  type MaterialCookRefs,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  serializeMaterialCookReceipt,
  validateCookedMaterialRecord,
  validateMaterialCookReceipt,
} from './evidence/material-cook.js';
export { buildOfflineAssetEvidence, packageVerification } from './evidence/offline-evidence.js';
export {
  decodeMeshBinHeader,
  MESH_BIN_DIGEST_BYTES,
  MESH_BIN_HEADER_V4_BYTES,
  MESH_BIN_PROJECTION_VERSION,
  MESH_BIN_VERSION,
  type MeshBinContractError,
  type MeshBinHeaderResult,
  type MeshBinHeaderV4,
  writeMeshBinHeader,
} from './mesh-bin-contract.js';
export {
  type AuthoredPackAssetInput,
  type AuthoredPackInput,
  type FinalizedPackageProduct,
  finalizePackageProduct,
  finalizePackageTransportSource,
  type PackageArtifactBody,
  type PackageFinalizePolicy,
  type PackageFinalizeResult,
  type PackageFinalizerError,
  type PackageProduct,
  type PackageProductAsset,
  packageTransportRevision,
  upgradeLegacyAuthoredPack,
} from './package-finalizer.js';
export { validateProducerContract, validateProducerOutputs } from './producer-contract.js';
export { resolveAssetSource } from './resolve-asset-source.js';
export { parsePackV2, validateMeta, validatePack, validatePackV2 } from './runtime.js';
export {
  createRuntimePackPublication,
  type RuntimePackAssetInput,
  type RuntimePackEnvelope,
  type RuntimePackInput,
  type RuntimePackPublication,
  type RuntimePackPublicationInput,
} from './runtime-publication.js';
export {
  type InventoryDeclaration,
  type ScanInventory,
  type ScanOptions,
  type ScriptablePackInventoryDeclaration,
  type ScriptablePackScanOptions,
  STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
  scanInventory,
} from './scanner.js';
export {
  type AssetReader,
  isScriptablePackAssetKind,
  projectScriptablePackMeta,
  projectScriptablePackSceneComponents,
  SCRIPTABLE_PACK_ASSET_KINDS,
  SCRIPTABLE_PACK_CAPABILITY_MANIFEST,
  type ScriptablePackAssetDeclaration,
  type ScriptablePackAssetDeclarations,
  type ScriptablePackAssetFor,
  type ScriptablePackAssetKind,
  type ScriptablePackDefinition,
  type ScriptablePackError,
  type ScriptablePackExternalAssets,
  type ScriptablePackMetaJson,
  type ScriptablePackOutputs,
  type ScriptablePackPublicationEnvelope,
  type ScriptablePackReadError,
  type ScriptablePackSceneComponent,
  type ScriptablePackSceneComponentInput,
  type ScriptablePackSourceClosureEntry,
  validateScriptablePackDefinition,
} from './scriptable-pack.js';
export { calculateTopologyDiff, diffTopology } from './topology.js';
