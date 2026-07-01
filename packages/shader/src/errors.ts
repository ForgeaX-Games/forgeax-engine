// @forgeax/engine-shader/errors — ShaderError + factories (physically isolated from the
// same-named class in @forgeax/engine-shader-compiler, but shape-aligned 1:1 / charter
// proposition 5: consistent abstraction).
//
// Shape rules (plan-strategy §S-7 / D-R7 / OQ-2 close):
// - ShaderError extends Error, with the 5-field top-level projection
//   {code, lineNum, linePos, message, hint} (MVP-2.3) + 3 internal fields
//   {expected, detail, name}.
// - ShaderErrorCode is a closed 4-member union imported from @forgeax/engine-types
//   (SSOT single-source policy).
//
// Physical isolation — this file does **not** import from
// @forgeax/engine-shader-compiler; the type / factories are 1:1 mirrored but
// independently implemented (guarded by the AC-06 triple-grep gate; charter
// proposition 1: progressive disclosure).

import type { ShaderErrorCode } from '@forgeax/engine-types';

export type { ShaderErrorCode };

/**
 * Path-specific `detail` shape for `manifest-malformed` / `shader-not-found`.
 * `reason` is supplemental prose (it does not replace `hint`).
 */
export interface ShaderErrorDetail {
  readonly reason?: string | undefined;
  /**
   * Machine-consumable list of currently-registered material-shader identifiers.
   * Populated by `materialShaderNotFound()` factory so AI users can enumerate
   * available shaders via `err.detail.registeredShaderIds` for autocomplete /
   * fuzzy-match recovery without parsing the human-formatted `err.expected`
   * string (charter P3 structured failure). `err.expected` still carries the
   * pre-formatted `"ShaderRegistry has registered identifiers: [...]"` message
   * for human-readable log output — the two channels are complementary.
   */
  readonly registeredShaderIds?: readonly string[] | undefined;
}

interface ShaderErrorInit {
  readonly code: ShaderErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly message: string;
  readonly lineNum?: number | undefined;
  readonly linePos?: number | undefined;
  readonly detail?: ShaderErrorDetail | undefined;
}

/**
 * Structured shader error (runtime path, aligned with build-time
 * `@forgeax/engine-shader-compiler.ShaderError`).
 *
 * **5 surface fields** (MVP-2.3 top-level projection, AI-user consumption path):
 * - `.code` — member of the closed `ShaderErrorCode` union (4 variants)
 * - `.message` — display text (`Error` base-class field, populated at construction)
 * - `.hint` — actionable recovery guidance (charter proposition 3:
 *   machine-readable hint > prose)
 * - `.lineNum` / `.linePos` — error source location (undefined on the runtime
 *   path; only populated by the build-time compile-failed path; the field is
 *   retained here for shape alignment).
 *
 * **3 internal fields**:
 * - `.name` = `'ShaderError'` (debug label)
 * - `.expected` — expected-state description (symmetric with RhiError)
 * - `.detail` — path-specific extras (`reason` prose)
 *
 * **Do not `new` this directly** — construct via the 2 factory helpers
 * (`manifestMalformed` / `shaderNotFound`); the runtime path of this loop does
 * not trigger compile-failed / init-failed (those two paths belong to the
 * build-time `ShaderError` shape in `@forgeax/engine-shader-compiler`).
 */
export class ShaderError extends Error {
  override readonly name: 'ShaderError' = 'ShaderError';
  readonly code: ShaderErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly lineNum: number | undefined;
  readonly linePos: number | undefined;
  readonly detail: ShaderErrorDetail | undefined;

  constructor(init: ShaderErrorInit) {
    super(init.message);
    this.code = init.code;
    this.expected = init.expected;
    this.hint = init.hint;
    this.lineNum = init.lineNum;
    this.linePos = init.linePos;
    this.detail = init.detail;
  }
}

// === factory helpers (2 variants for the runtime path) ============================

/** `manifest-malformed`: manifest.json schema validation failed (4 fields missing or JSON unparseable). */
export function manifestMalformed(args: {
  readonly message: string;
  readonly hint: string;
  readonly reason?: string | undefined;
}): ShaderError {
  return new ShaderError({
    code: 'manifest-malformed',
    expected: 'manifest.json parses + every entry has {hash, wgsl, glsl, bindings}',
    message: args.message,
    hint: args.hint,
    ...(args.reason !== undefined ? { detail: { reason: args.reason } } : {}),
  });
}

/** `shader-not-found`: ShaderRegistry.get(hash) hash miss. */
export function shaderNotFound(args: {
  readonly hash: string;
  readonly hint: string;
}): ShaderError {
  return new ShaderError({
    code: 'shader-not-found',
    expected: `manifest.entries contains entry with hash '${args.hash}'`,
    message: `ShaderRegistry: hash '${args.hash}' not present in manifest`,
    hint: args.hint,
  });
}

/**
 * `material-shader-not-found`: `ShaderRegistry.lookupMaterialShader(identifier)`
 * miss. Returned by the runtime path when a `MaterialAsset.payload.materialShader`
 * `::`-routed identifier (or any registered identifier) has no matching entry
 * in the registry. AI-user recovery: the `.hint` cites the
 * `forgeax::default-standard-pbr` reservation + the
 * `registerMaterialShader(...)` API path so the caller can register the missing
 * shader at engine boot (feat-20260523-shader-template-instance-split M5 / T05).
 *
 * feat-20260528-material-shader-registration-unification M3 / w12 +
 * feat-20260624-sprite-lit F-P1 fix: dual-channel exposure of the registered
 * identifier set. `.expected` carries the pre-formatted string
 * `"ShaderRegistry has registered identifiers: [id1, id2, ...]"` for human /
 * log output; `.detail.registeredShaderIds` carries the raw `readonly string[]`
 * for AI users to enumerate via property access without regex-parsing the
 * message (charter P3 structured failure).
 */
export function materialShaderNotFound(args: {
  readonly identifier: string;
  readonly hint: string;
  readonly expected: string[];
}): ShaderError {
  return new ShaderError({
    code: 'material-shader-not-found',
    expected: `ShaderRegistry has registered identifiers: [${args.expected.join(', ')}]`,
    message: `ShaderRegistry: material shader identifier '${args.identifier}' not registered`,
    hint: args.hint,
    detail: { reason: `identifier=${args.identifier}`, registeredShaderIds: args.expected },
  });
}

// === Result<T, E> ====================================================================
//
// Round 3 fix-up F-P0-1: Result is re-exported from @forgeax/engine-rhi so the
// `.unwrap()` / `.unwrapOr()` method-chain surface (AGENTS.md §Adapter /
// Device IDE-friendly template + 50+ JSDoc @example anchors) is identical
// across the @forgeax/engine-rhi + @forgeax/engine-shader public surfaces (charter
// proposition 5: consistent abstraction). The previous local duplicate
// (plain field-only Result) caused TS structural-mismatch when ShaderRegistry
// values flowed into RHI-typed signatures.

export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-rhi';
