import type { PackV2, PackV2Error, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

import { validatePackV2 } from './schema-compiled.js';

export { validateArtifactPath } from './artifact-path.js';
export { projectPackageCatalog } from './catalog-projection.js';
export { validateFixedPackPublication } from './fixed-publication.js';
export { validatePluginAsset } from './plugin-asset.js';
export {
  linkPackProgram,
  loadPackProgram,
  type PackProgram,
  type PackProgramError,
  type PackProgramHost,
  type PackProgramImport,
  type PackProgramSource,
  packProgramModuleIdentity,
  preparePackProgram,
  verifyPackProgram,
} from './program.js';
export {
  bindRuntimePackScope,
  createRuntimePackPublication,
  type FixedPackExecution,
  type FixedPackPublication,
  type RuntimePackAssetInput,
  type RuntimePackEnvelope,
  type RuntimePackInput,
  type RuntimePackPublication,
  type RuntimePackPublicationInput,
  stripRuntimePackLifecycle,
} from './runtime-publication.js';
export { validateMeta, validatePack, validatePackV2 } from './schema-compiled.js';

/**
 * Parse a Pack v2 envelope without loading the Node-only scanner/evidence
 * barrel. Browser runtime consumers should import this subpath.
 */
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

export { decodePackBlob, encodePackBlob, type PackBlob, validatePackBlob } from './blob.js';

export { copyPackData, packArrayKind, packArrayStorage, packBufferLength } from './data.js';
