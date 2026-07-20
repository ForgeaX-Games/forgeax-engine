// check-extensions.ts - KHR / vendor extension gate.
//
// v1 allowlist contains only EXT_mesh_gpu_instancing
// (feat-20260518-gltf-instancing-and-name-component plan-strategy section
// 2 D-1 / D-3). Any extension listed in `extensionsRequired[]` outside
// this allowlist triggers `gltf-extension-unsupported` (hard fail).
// Extensions listed in `extensionsUsed[]` (but not required and not in
// allowlist) are recorded in `importSettings.diagnostics
// .unsupportedExtensions` so AI users can observe them downstream — and
// nothing else: `extensionsUsed` is purely informational per the glTF spec
// (only `extensionsRequired` is binding), and exporters routinely
// over-declare it (e.g. KHR_materials_unlit listed but referenced by no
// material). A stderr warn for those would be a false positive, so the
// diagnostics list is the single channel (no `console.error`).
//
// Future expansion (KHR_materials_unlit, KHR_texture_transform, ...) extends
// `EXTENSION_ALLOWLIST` in place; each addition lands under its own feat-*
// loop with breaking-change registry entry.

import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';

/** Hard-coded v1 allowlist (plan-strategy decision section 2 D-1 / D-3). */
export const EXTENSION_ALLOWLIST: readonly string[] = ['EXT_mesh_gpu_instancing'];

export interface ExtensionsCheckResult {
  /** Names listed in extensionsUsed but not in the allowlist. */
  readonly unsupportedUsed: readonly string[];
}

export interface GltfExtensionsJson {
  readonly extensionsRequired?: readonly string[];
  readonly extensionsUsed?: readonly string[];
}

/**
 * Validate the glTF JSON's extension declarations against the v1 allowlist.
 *
 * Returns:
 *   - `Result.err(gltf-extension-unsupported)` for the FIRST entry of
 *     `extensionsRequired[]` that is not allowlisted (fail-fast; the
 *     remaining required entries are not surfaced; first wins because the
 *     diagnostic carries one extension name + source slot only).
 *   - `Result.ok({ unsupportedUsed })` otherwise; the `unsupportedUsed`
 *     array names every extensionsUsed entry not in the allowlist (used as
 *     input for `importSettings.diagnostics.unsupportedExtensions`).
 *     extensionsUsed entries never fail parsing and never write to stderr —
 *     they are informational per the glTF spec and routinely over-declared.
 *
 * Pure function: no fs / network / stderr.
 */
export function checkExtensions(
  json: GltfExtensionsJson,
): Result<ExtensionsCheckResult, GltfError> {
  const required = json.extensionsRequired ?? [];
  for (const ext of required) {
    if (!EXTENSION_ALLOWLIST.includes(ext)) {
      return err(
        gltfErr('gltf-extension-unsupported', {
          extension: ext,
          source: 'extensionsRequired',
        }),
      );
    }
  }

  const used = json.extensionsUsed ?? [];
  const unsupportedUsed: string[] = [];
  for (const ext of used) {
    if (!EXTENSION_ALLOWLIST.includes(ext)) {
      unsupportedUsed.push(ext);
    }
  }

  return ok({ unsupportedUsed });
}
