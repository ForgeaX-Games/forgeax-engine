# @forgeax/engine-shader-compiler

## MaterialAsset 唯一成功路径

编译器位于 `paramSchema -> derive -> compile/reflect -> cook/load -> extract/record`
主线的 compile/reflect 阶段：它校验 WGSL producer 与派生 schema，产出可供
cook 使用的 reflection 与 artifact 输入。`coordinateSet`、transform 和
`physicalUvScale` 是 schema/data contract 的字段，不是 app 侧补写的偏移。

> [!CAUTION]
> 失败时按结构化 error `code`、`detail`、`hint` 修复 WGSL 或 schema 输入，
> 然后 recook；不要复制 source-owned error union。

> **build-time WGSL compilation core with naga_oil 0.22 composition + 7-member error taxonomy + cross-file HMR propagation support.** AI users call a single pure-function entry; errors are machine-readable `Result.err(ShaderError)` with typed `.detail` discriminated union; no `err.message.match()` anywhere downstream (charter proposition 3 + AC-15).

---

## Layer 1 — API surface (what you call)

**Single entry.** `compileShader(source, options)` — pure function, `Promise<Result<CompileResult, ShaderError>>`. Same input produces same output; no mutable global state.

For graphics consumers, `renderEntries: { vertex, fragment? }` checks the
selected stages against the validated Naga IR, including fragment input
locations, types, and interpolation. Material cooking supplies its selected
entries; an absent or wrong-stage entry fails before publication. Pack cooking
propagates the structured compiler error without serializing it into a string.

The closed material context derives local-light and ProbeBlend support from
`capability: 'storage-buffer'` for both Forward and Deferred. Custom Standard
Surface programs retain the same lighting modules as built-in Standard before
WGSL publication; runtime binding layouts follow the published program, without
reconstructing a missing lazy variant key. Uniform-buffer contexts disable both
storage-only branches. Standard Surface scene-index programs and their GPU Scene
receipts are also emitted only for storage-buffer contexts; uniform fallback
publishes its direct program without requesting storage-only Mesh metadata.

Material publications use `material-cook/4`: one validated root contract and a
complete program set selected by Pass and compiler context. Pack and Native
cookers share the publication builder. Independent modules retain independent
WGSL; shared modules reuse code while entry choices remain pipeline facts.

The Native Pack cooker derives `skinned` geometry from a resolved Standard skin
root, including inherited roots. Its color, visible-surface and shadow programs
share that context and palette ABI. Readiness alone does not prove selection:
the consumer must find one program for its exact pass, geometry and address.

Sprite materials publish both ordinary mesh and `sprite-instances` geometry
programs. The latter derives `PER_INSTANCE_REGION` from the component-owned
context: storage instances have current/previous matrices plus a UV region
(144 bytes); uniform instances have one matrix plus a region (80 bytes).
The Native Pack cooker publishes the default WebGPU/storage pair for built-in
sprite and sprite-lit roots, including source aliases and inherited passes.
Other backend/capability contexts remain explicit cooker inputs. Re-cook old
material publications to obtain the missing program; runtime never replaces a
published artifact with a legacy shader variant.

| Contract | Compile-time rule |
|:--|:--|
| Root parameter storage | All used UBO members keep the generated offsets and span. |
| Per-Pass resources | Unused bindings may be absent; used resources keep root binding numbers and types. |
| Custom resource names | Names such as `clearcoatTexture` do not enable Standard semantics or relocation. |
| Default shadow coverage | `forgeax::default-shadow-caster` without an explicit Surface slot uses opaque coverage and adds no PBR parameters. Standard helpers explicitly select their shared Surface. |
| Layout failure | The error carries the material, Pass, module, source, context, and actual/expected layout facts where available. |

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

`compileShader` runs a deterministic 5-stage pipeline:

1. **`#define` pre-scan** (`define-scan.ts`) — parse `#define NAME` lines in all `imports` + the root source; reject duplicate `NAME` across modules with `shader-define-conflict`. `#define NAME value` (value form) rejected per D-05 OOS-1.
2. **Cycle pre-detection** (`cycle-detect.ts`) — DFS tri-colour over `#import x::y` edges; raise `shader-circular-import` with first+last repeated chain before invoking naga_oil. Catches cycles the naga_oil Composer would otherwise surface as prose-only error text.
3. **naga_oil compose** (wasm `compose_shader`) — `@forgeax/engine-wgpu-wasm` hosts a `naga_oil::compose::Composer`. Each module registered via `add_composable_module` with `as_name = moduleId`; root compiled with `make_naga_module`. Composer flattens `#import` graph, expands `#ifdef` conditionals against the `defines` set, produces a single naga `Module`.
4. **Portable WGSL canonicalization** (`wgsl-compat.ts`) — one internal `canonicalizePortableWgsl` façade owns post-Naga portability rewrites. The current rule uses a small lexical scan so only the affected numeric token changes; the canonical source then feeds parse, validate, reflection, hashing, and the manifest. Future rules extend this owner rather than adding a nested `normalizeX(normalizeY(...))` call chain in `compileShader`.
5. **Error mapper** (`error-mapper.ts`) — wasm `JsError` prefixes map to closed-set codes: `IMPORT_NOT_FOUND:` → `shader-import-not-found`; `CIRCULAR:` → `shader-circular-import` (fallback if step 2 missed); anything else → `shader-compile-failed` with raw `compilerMessages`.

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
- charter proposition 3 (machine-readable > prose) + AC-15 (no `err.message.match()`) — [AI-first contract](../../AGENTS.md#design-axiom--compression--intelligence)
- AGENTS.md §Error model — family-level `ShaderErrorCode` + `ShaderErrorDetail` row (T-22 anchored).

## Pack compilation lifetime

Each `createMaterialPackCooker()` owns bounded reuse of successful raster
compilations: at most 64 programs and 16 MiB of serialized compiler results.
The key includes the exact source and all compiler options, including imported
bytes, defines, selected entries and output formats. Sources are still read on
every cook; material values, references, generations and receipts are published
anew. Shader bytes stay binary until the Pack transport projection. Failed
compilations are never retained, and returned results cannot mutate
the retained copy. The pure `compileShader()` entry keeps no global cache.

## Standard Surface composition

Build-time composition resolves `program.moduleSlots.surface`, loads the
transitive `#import` closure, validates the Surface ABI, generates the material
parameter module, and reflects one cooked Standard artifact. The player receives
only the content-addressed artifact; compiler and Naga dependencies do not cross
the runtime boundary.

Surface helper imports are hoisted ahead of template declarations. Active group
imports from the same module are combined after conditional specialization, so
a Surface and its template can share normal helpers without replacing each
other's imported symbols. Disabled imports do not add required symbols.

| Stage | Evidence | Failure owner |
|:--|:--|:--|
| Slot resolution | Standard module plus one Surface module | Material contract |
| Source closure | Ordered module IDs and closure digest | Shader source catalog |
| ABI validation | `evaluate_surface(SurfaceInput) -> SurfaceData` | Surface WGSL |
| Reflection/cook | Layout, program, and cook identities | Shader compiler / cooker |

> [!IMPORTANT]
> A valid Surface cannot repair an invalid root contract. Fix authored source
> or the producer, cold-cook the same GUID, and verify publication before
> retrying runtime load.


## Material MRT admission

The cooker validates `passes[].outputs` before publishing the material. For the
selected fragment entry, Naga checks output count, contiguous location coverage,
and scalar class against each declared attachment format. `uint`/`sint` require
unsigned/signed shader outputs; normalized and float formats require float
outputs. A declaration mismatch fails cooking; the existing Pack publication
retains its last-known-good generation. Device limits and format capabilities
remain runtime admission. See [public MRT](../render/README.md#public-material-mrt).

### Shared ray material cook

`cookRayMaterial({ material, table, sources, context })` resolves the existing
MaterialAsset inheritance, lowers the same Standard schema, composes its Surface
slot and compiles either `ray-hit` compute or `raster-probe` diagnostic fragment
WGSL. It returns the resolved asset, source closure and `RaySurfaceProgram`. Value edits retain
program identity; source edits change `sourceClosureDigest`. Contexts own texture
sampling policy, not separate material definitions.

The ordinary Pack cooker publishes the eligible rigid Standard ray-hit derivative
alongside its raster programs in the same receipt and artifact set. Unsupported
materials remain raster publications; a ray consumer must report their admission
failure or missing context, never substitute the raster program. Runtime never
imports the compiler. Texture/MASK and normal maps require their qualified UV
and tangent inputs; unsupported coverage, physical layers and resource profiles
fail admission. Custom Surface code must compile for compute and pass the GPU
geometric-normal/finite-output checks. This delivery path alone does not install
Renderer GI, cards or a hardware query pipeline.
