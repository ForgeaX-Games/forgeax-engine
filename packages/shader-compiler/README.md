# @forgeax/engine-shader-compiler

> **build-time WGSL compilation core with naga_oil 0.22 composition + 7-member error taxonomy + cross-file HMR propagation support.** AI users call a single pure-function entry; errors are machine-readable `Result.err(ShaderError)` with typed `.detail` discriminated union; no `err.message.match()` anywhere downstream (charter proposition 3 + AC-15).

---

## Layer 1 — API surface (what you call)

**Single entry.** `compileShader(source, options)` — pure function, `Promise<Result<CompileResult, ShaderError>>`. Same input produces same output; no mutable global state.

```ts
import { compileShader } from '@forgeax/engine-shader-compiler';

const result = await compileShader(source, {
  id: 'forgeax_pbr::main',
  imports: { 'forgeax_view::common': viewSrc, 'forgeax_pbr::brdf': brdfSrc },
  defines: { LIGHTING_MODEL_PBR: true },
});
if (result.ok) {
  const { wgsl, glsl, bindings, manifestEntry } = result.value;
} else {
  switch (result.error.code) { /* exhaustive 7 */ }
}
```

### 7-member `ShaderErrorCode`

| Code | When raised | `.detail` shape |
|:--|:--|:--|
| `shader-compile-failed` | naga parse/validate/emit rejects WGSL | legacy `{ compilerMessages? }` |
| `compiler-init-failed` | wasm `ensureReady()` throws | legacy `{ reason? }` |
| `manifest-malformed` | `manifestEntry` emit detects shape drift | legacy `{ reason? }` |
| `shader-not-found` | runtime registry miss (consumer side) | legacy `{ reason? }` |
| `shader-import-not-found` | `#import x::y` targets an absent module | `{ code, importPath, fromModuleId, offset? }` |
| `shader-circular-import` | DFS tri-colour cycle detected before naga_oil emit | `{ code, cycle: readonly string[] }` first+last repeated |
| `shader-define-conflict` | same `#define NAME` declared in ≥ 2 modules | `{ code, defineName, sites: { moduleId }[] }` |

### 3 new `.detail` variants — JSON sample

```json
// shader-import-not-found
{ "code": "shader-import-not-found", "importPath": "forgeax_view::common",
  "fromModuleId": "forgeax_pbr::main", "offset": 42 }

// shader-circular-import (cycle visualised first+last repeated)
{ "code": "shader-circular-import", "cycle": ["a", "b", "c", "a"] }

// shader-define-conflict
{ "code": "shader-define-conflict", "defineName": "LIGHTING_MODEL",
  "sites": [{ "moduleId": "forgeax_pbr::main" }, { "moduleId": "forgeax_view::common" }] }
```

`result.error.detail.<field>` narrows under `switch (result.error.code)` with full IDE autocomplete (AI-user review affordance; AC-15).

---

## Layer 2 — Composition + HMR mechanics (how it works)

### naga_oil integration path

`compileShader` runs a deterministic 4-stage pipeline:

1. **`#define` pre-scan** (`define-scan.ts`) — parse `#define NAME` lines in all `imports` + the root source; reject duplicate `NAME` across modules with `shader-define-conflict`. `#define NAME value` (value form) rejected per D-05 OOS-1.
2. **Cycle pre-detection** (`cycle-detect.ts`) — DFS tri-colour over `#import x::y` edges; raise `shader-circular-import` with first+last repeated chain before invoking naga_oil. Catches cycles the naga_oil Composer would otherwise surface as prose-only error text.
3. **naga_oil compose** (wasm `compose_shader`) — `@forgeax/engine-wgpu-wasm` hosts a `naga_oil::compose::Composer`. Each module registered via `add_composable_module` with `as_name = moduleId`; root compiled with `make_naga_module`. Composer flattens `#import` graph, expands `#ifdef` conditionals against the `defines` set, produces a single naga `Module`.
4. **Error mapper** (`error-mapper.ts`) — wasm `JsError` prefixes map to closed-set codes: `IMPORT_NOT_FOUND:` → `shader-import-not-found`; `CIRCULAR:` → `shader-circular-import` (fallback if step 2 missed); anything else → `shader-compile-failed` with raw `compilerMessages`.

### Bevy-style `moduleId` naming

`moduleId` follows Bevy's `namespace::path` convention — `forgeax_view::common`, `forgeax_pbr::brdf`, `forgeax_pbr::main`. The `#define_import_path` directive at each module's head declares its id; consumers `#import moduleId::{Symbol1, Symbol2}` to pull named items. This aligns with naga_oil's upstream convention and lets AI users copy Bevy shader examples unmodified.

### Cross-file HMR propagation (`@forgeax/engine-vite-plugin-shader` T-16)

The plugin builds a `reverseDeps: Map<moduleId, Set<rootEntryId>>` during `transform`. On Vite `handleHotUpdate(ctx)`, the plugin calls `getModulesByFile(ctx.file)` → resolves affected `moduleId`s → reverse-looks up every root that imported them → returns those root modules for HMR. Edit `common.wgsl` and every `pbr.wgsl` / `unlit.wgsl` depending on it reloads.

---

## Layer 3 — Deeper references (when you need internals)

**Sibling packages:**

- [`@forgeax/engine-naga`](../naga/README.md) — TS-only shell exposing `parse` / `validate` / `emit_reflection` + `composeShader` from `@forgeax/engine-wgpu-wasm`. Forbidden in runtime `@forgeax/engine-shader` (three grep gates).
- [`@forgeax/engine-wgpu-wasm`](../wgpu-wasm/README.md) — Rust crate merging wgpu 29 RHI + naga 29 three-stage bindings + naga_oil 0.22 Composer; single wasm artefact (`~1.17 MB gzip`).
- [`@forgeax/engine-vite-plugin-shader`](../vite-plugin-shader/README.md) — thin shell forwarding `compileShader` + HMR.

**Upstream references:**

- naga_oil 0.22 — <https://github.com/bevyengine/naga_oil> / <https://docs.rs/naga_oil/0.22.0>
- Bevy `pbr.wgsl` exemplar — <https://github.com/bevyengine/bevy/blob/main/crates/bevy_pbr/src/render/pbr.wgsl>
- naga upstream (v29) — <https://github.com/gfx-rs/wgpu/tree/trunk/naga>

**Closed-loop decisions:**

- plan-strategy §S-5 / §S-7 / §S-9 — [`feat-20260508-shader-pipeline-mvp/plan-strategy.md`](../../.forgeax-harness/forgeax-loop/feat-20260508-shader-pipeline-mvp/plan-strategy.md)
- M2/M3/M4 decisions — [`feat-20260512-naga-oil-composition-hmr/plan-decisions.md`](../../.forgeax-harness/forgeax-loop/feat-20260512-naga-oil-composition-hmr/plan-decisions.md) — D-04 / D-05 / D-07 / D-08 / D-11 / D-12 (moduleId convention + error taxonomy + anonymous-entry placeholder + offset passthrough)
- charter proposition 3 (machine-readable > prose) + AC-15 (no `err.message.match()`) — [AI User Charter](../../.claude/skills/forgeax-closed-loop/agents/ai-user-charter.md)
- AGENTS.md §Error model — family-level `ShaderErrorCode` + `ShaderErrorDetail` row (T-22 anchored).
