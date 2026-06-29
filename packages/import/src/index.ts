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

export {
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
  type DdcPack,
  type ImportRunnerFs,
  type RunImportMeta,
  type RunImportOk,
  type RunImportResult,
  runImport,
  SHADER_RESERVED_IMPORTER_KEY,
} from './import-runner.js';
export { ImporterRegistry } from './importer-registry.js';
export { packMeshBin } from './mesh-bin.js';
