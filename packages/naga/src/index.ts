// @forgeax/engine-naga — TS-only thin shell over @forgeax/engine-wgpu-wasm raw naga bindings.
//
// Form invariants (locked by plan-strategy D-P3 / D-P4 + research F-4):
//
// - snake_case three-phase functions byte-for-byte aligned with naga upstream
//   naming (this package replaces the legacy wasm-pack shim archived in
//   feat-20260511-naga-rhi-wgpu-merge M5 — charter proposition 2 industry
//   analogy + proposition 5 consistent abstraction).
// - Each public function awaits ensureReady() from @forgeax/engine-wgpu-wasm before
//   calling the raw wasm-bindgen export — one wasm boundary crossing per page
//   lifecycle, shared with @forgeax/engine-rhi-wgpu (research F-4 ensureReady SSOT).
// - Throws are caught at the wrapper boundary and translated to
//   Result.err(ShaderError) — never throw for expected failures
//   (AGENTS.md "Errors are structured" + charter proposition 4 explicit failure).
// - The opaque handle types ParsedModule / ValidatedModule are re-exported
//   so downstream consumers (@forgeax/engine-shader-compiler) can hold the handle
//   between phases without inspecting the underlying naga IR
//   (plan-strategy §S-1 opaque handle invariant).

import { ensureReady } from '@forgeax/engine-wgpu-wasm';
import { err, ok, type Result, type ShaderError, wrapShaderError } from './errors.js';

export * from './errors.js';

// === Opaque handle types ============================================================

/**
 * Handle for the `parse` output. The underlying type is a wasm-bindgen exported
 * struct: JS can only hold the handle — it cannot inspect naga IR fields
 * directly (charter proposition 4 + opaque handle invariant). Pass through to
 * `validate` to advance to phase 2.
 *
 * Surface type uses `unknown` to keep this layer math-free and opaque-handle
 * pure (no direct dependency on @forgeax/engine-wgpu-wasm/pkg ABI types). Downstream
 * consumers should not inspect the handle.
 */
export type ParsedModule = unknown;

/**
 * Handle for the `validate` output (Module + ModuleInfo); pass through to
 * `emit_reflection` for the reflection JSON emit.
 */
export type ValidatedModule = unknown;

// === Phase 1: parse =================================================================

/**
 * WGSL source -> `ParsedModule`.
 *
 * On failure returns `Result.err(ShaderError code='shader-compile-failed')`
 * whose `lineNum` / `linePos` carry the source position (from the wasm-side
 * `ParseErrorPayload`). The hint defaults to actionable WGSL fix guidance.
 *
 * Wasm boundary: awaits ensureReady() on first call (shared singleton with
 * @forgeax/engine-rhi-wgpu); subsequent calls take the cached path.
 */
export async function parse(source: string): Promise<Result<ParsedModule, ShaderError>> {
  let wasm: Awaited<ReturnType<typeof ensureReady>>;
  try {
    wasm = await ensureReady();
  } catch (e) {
    return err(
      wrapShaderError(
        e,
        'rerun bash packages/wgpu-wasm/build.sh and verify packages/wgpu-wasm/pkg contains a fresh .wasm',
      ),
    );
  }
  try {
    const parsed = wasm.parse(source);
    return ok(parsed as ParsedModule);
  } catch (e) {
    return err(wrapShaderError(e));
  }
}

// === Phase 2: validate ==============================================================

/**
 * `ParsedModule` -> `ValidatedModule` (Module + ModuleInfo).
 *
 * **Ownership transfer** — wasm-bindgen consumes the `parsed` handle. Do not
 * reuse the handle after this call; passing a consumed handle is undefined
 * behaviour on the wasm side (research Finding 6 ownership semantics).
 *
 * On failure returns `Result.err(ShaderError code='shader-compile-failed')`.
 * Validator errors have no source position attached on the wasm side, so
 * `lineNum` / `linePos` remain undefined.
 */
export async function validate(
  parsed: ParsedModule,
): Promise<Result<ValidatedModule, ShaderError>> {
  let wasm: Awaited<ReturnType<typeof ensureReady>>;
  try {
    wasm = await ensureReady();
  } catch (e) {
    return err(
      wrapShaderError(
        e,
        'rerun bash packages/wgpu-wasm/build.sh and verify packages/wgpu-wasm/pkg contains a fresh .wasm',
      ),
    );
  }
  try {
    const validated = (wasm.validate as (p: unknown) => unknown)(parsed);
    return ok(validated as ValidatedModule);
  } catch (e) {
    return err(wrapShaderError(e));
  }
}

// === Composer passthrough ===========================================================

/**
 * naga_oil Composer passthrough — `#import` + `#ifdef` composition over WGSL.
 *
 * Thin TS wrap over `@forgeax/engine-wgpu-wasm`'s raw `compose_shader` export
 * (feat-20260512 M1 compose.rs). Three-argument surface:
 *
 * - `entry` — the entry-point WGSL source (may contain `#import` directives
 *   and `#ifdef` guards).
 * - `imports` — `moduleId -> wgslSource` map; each value is a companion
 *   module whose header declares `#define_import_path <moduleId>` so the
 *   upstream composer can register it. The map is JSON.stringified at the
 *   wasm boundary.
 * - `defines` — `name -> boolean` map driving `#ifdef` branch elimination
 *   (plan-strategy D-06: non-boolean values are rejected at the TS layer by
 *   the shader-compiler wrapper; this wrap takes booleans verbatim). Also
 *   JSON.stringified at the boundary.
 *
 * Return: the composed WGSL string (entry + inlined imports, `#ifdef` branches
 * resolved).
 *
 * Errors: the raw wasm export throws `JsError` whose message carries a
 * `shader-import-not-found: ...` or `shader-compile-failed: ...` prefix
 * (feat-20260512 M1 compose.rs convention). This wrap does **not** translate
 * the prefix into a structured `ShaderError`; that splitting happens one layer
 * up at `@forgeax/engine-shader-compiler` (feat-20260512 M3), which is where
 * the three-argument `compileShader(src, { imports, defines, id })` entry lives.
 * Callers of this raw passthrough should `try / catch` the thrown error.
 *
 * Wasm boundary: awaits `ensureReady()` on first call (shared singleton with
 * `@forgeax/engine-rhi-wgpu` + other naga phases); subsequent calls take the
 * cached path.
 */
export async function composeShader(
  entry: string,
  imports: Record<string, string>,
  defines: Record<string, boolean>,
): Promise<string> {
  const wasm = await ensureReady();
  const compose = (wasm as { compose_shader: (e: string, i: string, d: string) => string })
    .compose_shader;
  return compose(entry, JSON.stringify(imports), JSON.stringify(defines));
}

// === Phase 3: emit_reflection =======================================================

/**
 * `ValidatedModule` + options JSON -> `BindGroupLayoutDescriptor[]` JSON string.
 *
 * `options_json` shape: `{ "dynamicOffsets": [{ "group": u32, "binding": u32 }, ...] }`.
 * The naga IR does not express the dynamic-offset dimension (research Finding 2
 * footnote), so it is injected via this JS-side options string. Pass an empty
 * `{}` (or a JSON-encoded object without `dynamicOffsets`) for the no-dynamic-
 * offset path.
 *
 * The validator's borrowed reference is **not** consumed — the same
 * `ValidatedModule` handle can be reused for repeated emits with different
 * options (e.g. for variant generation).
 */
export async function emit_reflection(
  validated: ValidatedModule,
  options_json: string,
): Promise<Result<string, ShaderError>> {
  let wasm: Awaited<ReturnType<typeof ensureReady>>;
  try {
    wasm = await ensureReady();
  } catch (e) {
    return err(
      wrapShaderError(
        e,
        'rerun bash packages/wgpu-wasm/build.sh and verify packages/wgpu-wasm/pkg contains a fresh .wasm',
      ),
    );
  }
  try {
    const reflectionJson = (wasm.emit_reflection as (v: unknown, o: string) => string)(
      validated,
      options_json,
    );
    return ok(reflectionJson);
  } catch (e) {
    return err(wrapShaderError(e));
  }
}
