// @forgeax/engine-pack
// Disk schema, GUID tools, and browser-safe asset contracts.
// Node-only catalog/build APIs live under @forgeax/engine-pack/build.

export {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  createMaterialCookIdentity,
  createMaterialProgramSetDigest,
  isStandardMaterialRecord,
  isStandardRootModule,
  type MaterialCookArtifact,
  type MaterialCookIdentity,
  type MaterialCookIdentityExpectation,
  type MaterialCookIdentityInput,
  type MaterialCookProgram,
  type MaterialCookProgramContext,
  type MaterialCookRasterContext,
  type MaterialCookRayContext,
  type MaterialCookReceipt,
  type MaterialCookRecordError,
  type MaterialCookRefs,
  type MaterialCookWasmProvenance,
  materialLayerPlanIdentity,
  materialProgramContextKey,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  serializeMaterialCookReceipt,
  validateCookedMaterialRecord,
  validateMaterialCookProgramContext,
  validateMaterialCookReceipt,
} from './evidence/material-cook.js';
export { buildOfflineAssetEvidence, packageVerification } from './evidence/offline-evidence.js';
export {
  AssetGuid,
  isValidAssetGuidString,
  isValidPackSourceKey,
  PACK_SOURCE_KEY_RE,
  PackageId,
} from './guid.js';
export {
  decodeMeshBinHeader,
  decodeMeshBinMorphs,
  MESH_BIN_DIGEST_BYTES,
  MESH_BIN_HEADER_BYTES,
  MESH_BIN_MORPH_CHANNELS,
  MESH_BIN_PROJECTION_VERSION,
  MESH_BIN_VERSION,
  type MeshBinContractError,
  type MeshBinHeader,
  type MeshBinHeaderResult,
  writeMeshBinHeader,
} from './mesh-bin-contract.js';
export * from './pack-authoring.js';
export { validateProducerContract, validateProducerOutputs } from './producer-contract.js';
export {
  type AssetReader,
  isScriptablePackAssetKind,
  projectScriptablePackSceneComponents,
  SCRIPTABLE_PACK_ASSET_KINDS,
  type ScriptablePackAssetKind,
  type ScriptablePackReadError,
  type ScriptablePackSceneComponent,
  type ScriptablePackSceneComponentInput,
  type ScriptablePackSourceClosureEntry,
} from './scriptable-pack.js';
export { calculateTopologyDiff, diffTopology } from './topology.js';

import { err, ok, type PackV2, type PackV2Error, type Result } from '@forgeax/engine-types';

export type { ArtifactPathContext } from './artifact-path.js';
export { validateArtifactPath } from './artifact-path.js';

import { validatePackV2 } from './schema-compiled.js';

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
export {
  type MaterialArtifactWriteInput,
  type MaterialArtifactWriteResult,
  writeMaterialArtifact,
} from './material/artifact-writer.js';
export {
  projectRuntimePack,
  type RuntimeAssetProjectionInput,
  type RuntimePackProjectionInput,
} from './runtime-projection.js';
export { validateMeta, validatePack, validatePackV2 } from './schema-compiled.js';

export function parsePackV2(value: unknown): Result<PackV2, PackV2Error> {
  if (!validatePackV2(value)) {
    return err({
      code: 'pack-v2-envelope-invalid',
      expected: 'a Pack v2 envelope with unique asset GUIDs and valid descriptors',
      hint: 'validate the pack against packages/pack/schema/pack.schema.json and re-cook it',
      detail: { observed: 'invalid pack', expected: 'schemaVersion 2.0.0' },
    });
  }

  return ok(value);
}
