import type { PackV2, PackV2Error, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

import { validatePackV2 } from './schema-compiled.js';

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
