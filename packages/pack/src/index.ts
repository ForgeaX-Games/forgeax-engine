// @forgeax/engine-pack
// Disk schema, GUID tools, scanner, fail-fast error chain, and CLI bin.
// Entry subpaths: . / schema / guid / errors / bridge / scanner

export {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  type MaterialCookArtifact,
  type MaterialCookReceipt,
  type MaterialCookRecordError,
  type MaterialCookRefs,
  projectCookedMaterialRecord,
  serializeCookedMaterialRecord,
  serializeMaterialCookReceipt,
  validateCookedMaterialRecord,
} from './evidence/material-cook.js';
export { buildOfflineAssetEvidence, packageVerification } from './evidence/offline-evidence.js';
export { validateProducerContract, validateProducerOutputs } from './producer-contract.js';
export { calculateTopologyDiff, diffTopology } from './topology.js';

import { err, ok, type PackV2, type PackV2Error, type Result } from '@forgeax/engine-types';

export type { ArtifactPathContext } from './artifact-path.js';
export { validateArtifactPath } from './artifact-path.js';

import { validatePackV2 } from './schema-compiled.js';

export type { PackV2, PackV2Error } from '@forgeax/engine-types';
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
