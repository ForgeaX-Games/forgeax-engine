// @forgeax/engine-naga/errors — ShaderError + Result<T, E> + wrapShaderError helper.
//
// Form invariants (plan-strategy §D-P4 / requirements MVP-2.3 + AC-09):
// - ShaderErrorCode (closed 4-member union) is imported from @forgeax/engine-types as
//   the SSOT. This package does **not** redefine the union — +0 breaking points
//   to the error model (AC-09; charter proposition 5 consistent abstraction).
// - The ShaderError class shape + 4 factory helpers + Result<T, E> shape are
//   byte-for-byte equivalent to @forgeax/engine-shader-compiler/src/errors.ts; that
//   package will re-export from here in w7 after the import switch lands
//   (charter proposition 5 + plan-strategy D-P4 byte-for-byte form recovery).
// - wrapShaderError is the JsError -> ShaderError adapter for the parse /
//   validate / emit_reflection wrappers in index.ts: it tries to JSON.parse the
//   wasm-side ParseErrorPayload (message / summary / line_num / line_pos)
//   first, falls back to the prose message for validator / reflection failures.

/// <reference types="@webgpu/types" />

import type { ShaderErrorCode, ShaderErrorDetail } from '@forgeax/engine-types';

export type { ShaderErrorCode, ShaderErrorDetail };

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
 * Structured shader error.
 *
 * **5 surface fields** (MVP-2.3 top-level surface, AI consumer path):
 * - `.code` — member of the closed `ShaderErrorCode` union (4 variants)
 * - `.message` — display text (the base `Error` field, populated by the constructor)
 * - `.hint` — actionable recovery guidance (charter proposition 3: machine-readable hint over prose)
 * - `.lineNum` / `.linePos` — error source location (mandatory for compile-failed; undefined on other paths)
 *
 * **3 internal fields**:
 * - `.name` = `'ShaderError'` (debug tag)
 * - `.expected` — description of the expected state (symmetric with RhiError)
 * - `.detail` — path-specific extra info (e.g. all 6 fields of GPUCompilationMessage[])
 *
 * **Do not new directly** — construct via the 4 factories (compileFailed /
 * initFailed / manifestMalformed / shaderNotFound) to avoid ad-hoc arguments
 * bypassing union narrowing.
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

// === 4 factory helpers (plan-strategy §D-P4 closed union with 4 members) ===========

/** `shader-compile-failed`: naga parse_str or Validator::validate failure. */
export function compileFailed(args: {
  readonly message: string;
  readonly hint: string;
  readonly lineNum?: number | undefined;
  readonly linePos?: number | undefined;
  readonly compilerMessages?: readonly GPUCompilationMessage[] | undefined;
  readonly reason?: string | undefined;
}): ShaderError {
  return new ShaderError({
    code: 'shader-compile-failed',
    expected: 'WGSL source parses + validates against naga IR',
    message: args.message,
    hint: args.hint,
    ...(args.lineNum !== undefined ? { lineNum: args.lineNum } : {}),
    ...(args.linePos !== undefined ? { linePos: args.linePos } : {}),
    ...(args.compilerMessages !== undefined
      ? {
          detail: {
            code: 'shader-compile-failed',
            compilerMessages: args.compilerMessages,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
          },
        }
      : {}),
  });
}

/** `compiler-init-failed`: wasm loading or init() failure (cold start / missing wasm artifact). */
export function initFailed(args: {
  readonly message: string;
  readonly hint: string;
  readonly reason?: string | undefined;
}): ShaderError {
  return new ShaderError({
    code: 'compiler-init-failed',
    expected: '@forgeax/engine-wgpu-wasm ensureReady() resolves with naga raw bindings available',
    message: args.message,
    hint: args.hint,
    detail: {
      code: 'compiler-init-failed',
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
  });
}

/** `manifest-malformed`: manifest.json schema validation failure (a required field is missing or JSON is not parseable). */
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
    detail: {
      code: 'manifest-malformed',
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
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

// === wrapShaderError: JsError -> ShaderError adapter ================================

/**
 * Translate a thrown wasm-bindgen JsError to a structured ShaderError.
 *
 * The Rust side serializes `ParseErrorPayload { message, summary, line_num,
 * line_pos }` to a JSON string and uses it as the JsError message. We attempt
 * JSON.parse first; on success the lineNum/linePos are extracted as top-level
 * surface fields (MVP-2.3). On failure (validator errors, reflection errors,
 * non-JSON messages) we fall back to the prose message — hint is always
 * populated so AI consumers always have an actionable recovery signal
 * (charter proposition 4 explicit failure + proposition 3 machine-readable hint).
 */
export function wrapShaderError(e: unknown, hint?: string): ShaderError {
  if (e instanceof Error) {
    try {
      const payload = JSON.parse(e.message) as {
        message?: string;
        summary?: string;
        line_num?: number | null;
        line_pos?: number | null;
      };
      return compileFailed({
        message: payload.summary ?? payload.message ?? e.message,
        hint:
          hint ??
          'fix the WGSL source at the indicated line/column; see ShaderError.detail.compilerMessages for full diagnostic frame',
        ...(typeof payload.line_num === 'number' ? { lineNum: payload.line_num } : {}),
        ...(typeof payload.line_pos === 'number' ? { linePos: payload.line_pos } : {}),
      });
    } catch {
      return compileFailed({
        message: e.message,
        hint: hint ?? 'check WGSL syntax + validation rules; consult naga error output for details',
      });
    }
  }
  return compileFailed({
    message: String(e),
    hint:
      hint ??
      'unknown error type from @forgeax/engine-wgpu-wasm; report as @forgeax/engine-naga bug',
  });
}

// === Result<T, E> ====================================================================
//
// Result<T, E> + ok / err + ResultOk / ResultErr live in `@forgeax/engine-types`
// (tweak-20260612-result-into-types). They were duplicated here as a lite
// (plain-object, no `unwrap`) variant; consolidated upstream into the same
// shape used by rhi / ecs. The barrel here re-exports them so existing
// `import { err, ok, Result, ResultOk, ResultErr } from '@forgeax/engine-naga'`
// consumers stay unchanged.
export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-types';
