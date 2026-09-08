// @forgeax/engine-import — build-time asset import runner + ImporterRegistry.
//
// The build-time half of the engine's import/load split (the runtime half is
// the LoaderRegistry in @forgeax/engine-runtime). An Importer turns an external
// source (.gltf / .png / .ttf) plus its *.meta.json GUID declarations into
// in-memory ImportedAsset[] PODs; the import runner enforces the GUID
// import-stable iron law and writes the DDC (.pack.json / .bin).
//
// This package is build-time only. It MUST NOT enter the player runtime bundle
// (AC-06): @forgeax/engine-runtime / @forgeax/engine-app never depend on it.
//
// The import contract (Importer / ImportContext / ImportedAsset / ImportError /
// ImportErrorCode / ImportTransport) lives in @forgeax/engine-types (the
// math-free SSOT) and is re-exported here so build tooling has a single
// import surface.

export type {
  AnimationClip,
  AnimationGraph,
  Asset,
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
export {
  type CookProduct,
  IMPORT_ERROR_HINTS,
  type ImportContext,
  ImportError,
  type ImportErrorCode,
  type ImportErrorDetail,
  type ImportedAsset,
  type Importer,
  type ImportSubAsset,
  type ImportTransport,
} from '@forgeax/engine-types';
export {
  type BuildProductionFailure,
  type BuildProductionFile,
  type BuildProductionOptions,
  type BuildProductionSink,
  produceBuildAssets,
  type ScriptableBuildPackage,
} from './build-production.js';
export {
  type CatalogImporterDisposition,
  type CatalogImporterPolicy,
  catalogImporterPolicy,
  DEFAULT_CATALOG_IMPORTER_KEYS,
} from './catalog-importer-policy.js';
export { buildCatalogResult } from './catalog-inventory.js';
export {
  createImportProduct,
  finalizeImportProducts,
  type ImportAssetProduct,
  type ImportProductContractError,
  type TerminalImportProduct,
} from './import-product.js';
export {
  type DdcPack,
  type ImportRunnerFs,
  normaliseForPack,
  type RunImportMeta,
  type RunImportOk,
  type RunImportProductResult,
  type RunImportResult,
  runImport,
  SHADER_RESERVED_IMPORTER_KEY,
} from './import-runner.js';
export { ImporterRegistry } from './importer-registry.js';
export {
  type MeshBinEncodeError,
  packMeshBinV4,
} from './mesh-bin.js';
export { projectImportProductForBuild } from './pack-projection.js';
export {
  type AssetOutputInput,
  type AssetOutputPayload,
  type AssetOutputProducer,
  AssetOutputProducerRegistry,
  type AssetOutputProduct,
  type BuildScriptablePackOptions,
  buildScriptablePack,
  type ScriptablePackAssetSnapshot,
  type ScriptablePackAssetSnapshotSource,
  type ScriptablePackBuildBridgeResult,
  type ScriptablePackBuildProduct,
  type ScriptablePackDomainError,
  type ScriptablePackExternalEvidence,
  type ScriptablePackExternalUsage,
  type ScriptablePackSourceClosureEntry,
  type ScriptablePackStagedOutput,
} from './scriptable-pack.js';
export {
  type AuthoredPackTransport,
  type CookedAuthoredPack,
  canonicalScriptableSourcePath,
  declaredPackExternalOutputs,
  materializePreparedScriptablePack,
  type PreparedScriptablePack,
  prepareAuthoredPackTransport,
  produceScriptablePackProducts,
  projectScriptablePackPublication,
  readCookedAuthoredPack,
  type ScriptablePackExternalImportOptions,
  type ScriptablePackInput,
  type ScriptablePackPublicationFacts,
  type ScriptablePackTransportPaths,
  type ScriptablePackTransportPolicy,
  type ScriptablePackTransportSink,
  scriptablePackInputs,
} from './scriptable-pack-host.js';
export {
  createSceneAssetOutputProducer,
  createStandardAssetOutputProducerRegistry,
  materialAssetOutputProducer,
  meshAssetOutputProducer,
} from './scriptable-pack-output-producers.js';
export {
  createScriptablePackStagedAssetSnapshotSource,
  type ScriptablePackSnapshotError,
  type ScriptablePackStagedOwner,
  type ScriptablePackStagedSnapshotOptions,
} from './scriptable-pack-staged-snapshot.js';
export {
  produceScriptableSourcePackage,
  type ScriptableSourcePackageProduct,
  type ScriptableSourcePackageResult,
} from './scriptable-source-package.js';
export {
  finalizeSourcePackage,
  type ProducerReadiness,
  type ProducerReadinessError,
  type ProducerReadinessResult,
  parseProducerReadiness,
  produceSourcePackage,
  type SourcePackageClosureDetail,
  type SourcePackageClosureError,
  type SourcePackageProducerInput,
  type SourcePackageProducerResult,
  type SourcePackageProduct,
  sourcePackageAssetsByGuid,
} from './source-package.js';
export {
  normalizeSourcePackageError,
  type SourcePackageError,
  type SourcePackageErrorCode,
  type SourcePackageErrorContext,
  type SourcePackageErrorDetail,
  type SourcePackageErrorStage,
  sourcePackageError,
} from './source-package-errors.js';
export {
  commitImportPublication,
  discardImportPublication,
  type ImportPublicationError,
  type ImportPublicationInput,
  type ImportPublicationResult,
  publishImportPublication,
  restoreImportPublication,
  type StagedImportPublication,
  type StagedImportPublicationResult,
  stageImportPublication,
} from './source-package-publication.js';
