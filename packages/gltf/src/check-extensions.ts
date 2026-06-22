// check-extensions.ts - KHR / vendor extension gate.
//
// v1 allowlist contains only EXT_mesh_gpu_instancing
// (feat-20260518-gltf-instancing-and-name-component plan-strategy section
// 2 D-1 / D-3). Any extension listed in `extensionsRequired[]` outside
// this allowlist triggers `gltf-extension-unsupported` (hard fail).
// Extensions listed in `extensionsUsed[]` (but not required and not in
// allowlist) emit a stderr warn line and are recorded in
// `importSettings.diagnostics.unsupportedExtensions` so AI users can
// observe them downstream (plan-strategy decision section 2.6 / OQ-1
// double-channel: stderr + diagnostics).
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
  /** Stderr warn lines emitted for each unsupportedUsed extension. */
  readonly warnings: readonly string[];
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
 *   - `Result.ok({ unsupportedUsed, warnings })` otherwise; the
 *     `unsupportedUsed` array names every extensionsUsed entry not in the
 *     allowlist (used as input for `importSettings.diagnostics
 *     .unsupportedExtensions`).
 *
 * Pure function: no fs / network. Stderr writes go through
 * `console.error` so vitest can spy on them.
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
  const warnings: string[] = [];
  for (const ext of used) {
    if (!EXTENSION_ALLOWLIST.includes(ext)) {
      unsupportedUsed.push(ext);
      const message = `[warn] gltf extension '${ext}' used but not in v1 allowlist [${EXTENSION_ALLOWLIST.join(', ')}]; see feat-future-gltf-extensions-allowlist`;
      console.error(message);
      warnings.push(message);
    }
  }

  return ok({ unsupportedUsed, warnings });
}
