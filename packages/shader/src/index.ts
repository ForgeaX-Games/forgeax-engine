// @forgeax/engine-shader — runtime shader registry public surface.
//
// Shape rules (plan-strategy §S-10 / D-R10 / OQ-5 close):
// - instance-per-engine — exposed through the lazy `engine.shader:
//   ShaderRegistry` property; module-level singletons / static methods are
//   forbidden (aligned with `Engine.create({ rhi })`'s instance-based style).
// - Physical isolation — this package's deps only contain `@forgeax/engine-rhi` +
//   `@forgeax/engine-types`; importing `@forgeax/engine-shader-compiler` / `@forgeax/engine-naga`
//   / `@forgeax/engine-wgpu-wasm` directly or transitively is **forbidden**
//   (guarded by the AC-06 triple-grep gate; feat-20260511-naga-rhi-wgpu-merge
//   M4 replaced the legacy single-shim ban with the merged ban triple above).
// - Result model — expected failures go through
//   `Result.err(RhiError | ShaderError)` and **never throw** (AGENTS.md
//   "Errors are structured" / charter proposition 4: explicit failure).
//
// Top-level surface (charter proposition 1: progressive disclosure):
// - ShaderRegistry / ShaderRegistryOptions / ShaderRegistryDevice — main class
//   + injection interface
// - ShaderError / ShaderErrorCode / 2 factories — runtime error types
// - Result<T, E> + ok / err — binary result type and constructors
// - ManifestEntry — re-exported from `@forgeax/engine-types` (manifest schema SSOT)

export type { ManifestEntry, ParamSchemaEntry } from '@forgeax/engine-types';
export { MATERIAL_PARAM_TYPES } from '@forgeax/engine-types';
export {
  err,
  manifestMalformed,
  materialShaderNotFound,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
  ShaderError,
  type ShaderErrorCode,
  type ShaderErrorDetail,
  shaderNotFound,
} from './errors.js';
export {
  registerDefaultSpriteLit,
  type SpriteLitCaps,
} from './register-default-sprite-lit.js';
export { registerDefaultStandardPbrSkin } from './register-default-standard-pbr-skin.js';
export {
  FORGEAX_RESERVED_PATH_PREFIX,
  type MaterialShaderEntry,
  ShaderRegistry,
  type ShaderRegistryDevice,
  type ShaderRegistryOptions,
} from './ShaderRegistry.js';
export {
  findVariantByKey,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
} from './types.js';

/** Package-level version number (debug label). */
export const SHADER_PACKAGE_VERSION = '0.0.0';

/**
 * Shared luminance epsilon floor for the extended Reinhard tone-map
 * (feat-20260519-tonemap-reinhard-mvp / D-O3).
 *
 * Both the TS port at `packages/runtime/src/systems/tonemap.ts` and the WGSL
 * fragment stage in `packages/shader/src/tonemap.wgsl` apply
 * `max(Y, TONEMAP_LUMINANCE_EPSILON)` before dividing the luminance ratio.
 * The floor keeps the divisor finite at degenerate inputs (`Y = 0` from black
 * pixels, `Y < 0` from rare numerical artefacts). Single SSOT here so a
 * single `import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader'`
 * keeps TS / WGSL byte-equivalent.
 *
 * Value: `1e-5` — small enough to not perturb any plausible HDR luminance.
 */
export const TONEMAP_LUMINANCE_EPSILON = 1e-5;
