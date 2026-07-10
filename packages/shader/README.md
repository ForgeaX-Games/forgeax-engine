# @forgeax/engine-shader

> **User writes own `.wgsl`, engine provides ShaderModule library.** The engine ships 16 composable `.wgsl` modules (imported via `#define_import_path`, composed by `naga_oil::Composer`) covering PBR BRDF, IBL, lighting, tonemapping, and utility helpers. User-side material shaders consume these as `#import` targets and register at runtime via `ShaderRegistry.registerMaterialShader`. The runtime registry is the single source of truth for wgsl source, param schema, and binding layout.

> **wgsl ShaderModule vs RHI ShaderModule handle -- naming disambiguation.** This package deals with **wgsl ShaderModule**: a reusable `.wgsl` file-level unit imported via `#define_import_path` (e.g. `forgeax_pbr::brdf`), composed by `naga_oil::Composer`, and registered at runtime via `ShaderRegistry.registerMaterialShader`. The RHI layer's `ShaderModule` handle (from `@forgeax/engine-rhi`, created by `rhi.createShaderModule`) is a GPU-side compiled-shader opaque handle, **not** the same concept. Import from `engine-shader` for the wgsl-level module; import from `engine-rhi` for the GPU handle. The two are distinguished by module path only (same unqualified name `ShaderModule`). Precedent: `Buffer` (RHI handle) vs `GPUBuffer` (WebGPU host object) in AGENTS.md RHI form rules Naming.

> **Runtime shader registry (content-addressable manifest lookup -> `rhi.createShaderModule`), instance-per-engine shape (`engine.shader` lazy property), enforces physical isolation of production bundle from Naga wasm.** Dependencies strictly `@forgeax/engine-rhi` + `@forgeax/engine-types` only; **forbidden** to directly or indirectly import `@forgeax/engine-shader-compiler` / `@forgeax/engine-naga` / `@forgeax/engine-wgpu-wasm` (AC-06 triple-grep gate, charter proposition 1 progressive disclosure / proposition 4 explicit failure; feat-20260511-naga-rhi-wgpu-merge M4 replaced the legacy single-shim ban with the merged triple-package ban list).

## ShaderModule catalog

Engine-shipped `.wgsl` modules in `packages/shader/src/`. Each declares a `#define_import_path` stable identifier consumed via `naga_oil::Composer` `#import` directives in user-side or engine-composed shaders.

| Module | `define_import_path` | Purpose |
|:--|:--|:--|
| `default-standard-pbr.wgsl` | N/A (top-level entry) | Engine-shipped standard PBR material shader -- `forgeax::default-standard-pbr` registered at engine boot |
| `brdf.wgsl` | `forgeax_pbr::brdf` | GGX BRDF helpers (`f_schlick`, `f_ggx`, `f_smith`) |
| `common.wgsl` | `forgeax_view::common` | View UBO struct + `pick_channel` helper |
| `tonemap.wgsl` | `forgeax_view::tonemap` | Reinhard tonemap post-process |
| `unlit.wgsl` | N/A (top-level entry) | Unlit material shader (`baseColor x baseColorTexture`) |
| `sprite.wgsl` | N/A (top-level entry) | Sprite material shader (alpha-blend, pivot-and-size) |
| `sprite-lit.wgsl` | N/A (top-level entry) | Sprite shader with **flat 2D per-light forward shading** (`forgeax::sprite-lit`; per-light contribution = `attenuation x cone x colorTimesIntensity x albedo`, Directional drops the `attenuation` factor). No normal map, no shadow, no direction-of-surface term — light direction only feeds SpotLight cone falloff, never a diffuse dot product. Lights work at any position and any direction, including in-plane sweeps (position z = 0, `direction` z-component = 0) a la Godot Light2D / Unity URP 2D. `VsOut` carries `@location(1) worldPos` from the vertex stage; the fragment stage reads it directly (no fragment-side world-position inversion). paramSchema mirrors `sprite.wgsl.meta.json` (5 fields, AC-07 BGL byte-identical). Switch from `forgeax::sprite` is a 1-string change on `passes[0].shader`. OOS-1 follow-up `feat-future-sprite-lit-normal-map` will layer directional-diffuse back in only when a normal map is bound. |
| `tbn.wgsl` | `forgeax_pbr::tbn` | TBN matrix derivation |
| `lighting-directional.wgsl` | `forgeax_pbr::lighting_directional` | Directional light BRDF evaluation |
| `lighting-punctual.wgsl` | `forgeax_pbr::lighting_punctual` | Punctual (point/spot) light BRDF evaluation |
| `ibl-brdf-lut.wgsl` | `forgeax_pbr::ibl_brdf_lut` | IBL BRDF LUT precompute |
| `ibl-equirect-to-cube.wgsl` | `forgeax_pbr::ibl_equirect_to_cube` | Equirectangular to cubemap conversion |
| `ibl-irradiance.wgsl` | `forgeax_pbr::ibl_irradiance` | IBL diffuse irradiance precompute |
| `ibl-prefilter.wgsl` | `forgeax_pbr::ibl_prefilter` | IBL specular prefiltered environment map |
| `ibl-sampling.wgsl` | `forgeax_pbr::ibl_sampling` | IBL sampling helpers |
| `ibl-shared.wgsl` | `forgeax_pbr::ibl_shared` | IBL shared structs (UBO layout) |
| `shadow_caster.wgsl` | N/A (top-level entry) | Shadow map depth-only pass |

## paramSchema v2 — single SSOT, 14 WGSL types, derive() drives BGL / UBO / loader

> [!IMPORTANT]
> **A single `paramSchema: ParamSchemaEntry[]` declaration is the SSOT. The pure function `derive(schema)` projects it into the BGL entries, the std140 UBO byte layout, and the loader's texture-field index — three downstream surfaces, one declaration. AI users never hand-author `bindingLayout` / `MATERIAL_UBO_BYTES` / `MATERIAL_PARAM_TEXTURE_FIELDS` because they no longer exist.** (feat-20260613-material-paramschema-driven-binding §3.1).

The 14-literal `MaterialParamType` closed union (SSOT: [`@forgeax/engine-types`](../types/src/index.ts)) exhausts every type used by the 5 built-in shaders + every type any user shader may declare in v2:

| Family | Literal | WGSL projection | Notes |
|:--|:--|:--|:--|
| numeric | `f32` / `i32` / `u32` | `f32` / `i32` / `u32` | size 4 / align 4; consecutive numeric entries run-merge into one std140 UBO at one binding slot |
| numeric | `vec2` | `vec2<f32>` | size 8 / align 8 |
| numeric | `vec3` | `vec3<f32>` | size 12 / align 16 (std140 padding) |
| numeric | `vec4` | `vec4<f32>` | size 16 / align 16 |
| numeric | `color` | `vec3<f32>` (rgba alias) | size 16 / align 16; semantic-distinct from `vec3` (validated as 3- or 4-tuple at register time) |
| texture | `texture2d` | `texture_2d<f32>` | auto-pairs a filtering `sampler` (sampler emitted FIRST, then texture; same name + `_sampler`) |
| texture | `texture_cube` | `texture_cube<f32>` | auto-pairs a filtering `sampler` |
| texture | `texture_depth_2d` | `texture_depth_2d` | depth view; auto-pairs the **filtering** `sampler` (callers needing a `comparison` sampler declare `sampler_comparison` explicitly) |
| texture | `texture_cube_array` | `texture_cube_array<f32>` | auto-pairs a filtering `sampler` |
| sampler | `sampler` | `sampler` (filtering) | user-declared; consumed alongside an adjacent `texture*` entry |
| sampler | `sampler_comparison` | `sampler_comparison` | user-declared; for shadow-map compare-sampling |
| storage | `storage_buffer` | `array<T>` storage | independent binding; numeric run terminates here |

**std140 packing walkthrough** (consumed by `derive(schema).uboLayout`):

```text
schema:        [ f32 a,  f32 b,  vec3 c ]
offsets:       [    0,      4,     16   ]   // c jumps to 16 because vec3 align=16
totalBytes:    32                          // round-up to 16-byte boundary

schema:        [ vec3 a, f32 b ]
offsets:       [   0,      12  ]            // f32 fits in vec3's tail pad
totalBytes:    16

schema:        [ f32 a,  f32 b,  f32 c,  f32 d,  vec4 e ]
offsets:       [    0,      4,      8,    12,     16   ]   // 4 f32 occupy one 16-B slot
totalBytes:    32
```

### `derive(schema)` — function signature

```ts
import { derive, MATERIAL_PARAM_TYPES, type ParamSchemaEntry } from '@forgeax/engine-types';

export interface DeriveOutput {
  readonly bglEntries: readonly BindGroupLayoutEntry[];   // RHI BGL projection
  readonly uboLayout: {                                   // std140 byte layout
    readonly entries: readonly { name: string; offset: number; size: number; type: NumericParamType }[];
    readonly totalBytes: number;
  };
  readonly textureFieldNames: ReadonlySet<string>;        // loader / extract texture field index
  readonly samplerForTexture: ReadonlyMap<string, string>;// auto-paired sampler name lookup
  readonly userRegionBindingEnd: number;                  // engine-injection start binding (D-6)
}

export function derive(schema: readonly ParamSchemaEntry[]): DeriveOutput;
```

The function is **pure** (no side effects, no I/O). It throws on schema-author errors:

- empty `name`
- duplicate `name`
- type literal not in the 14-member `MATERIAL_PARAM_TYPES` tuple
- user-declared `name` collides with an auto-paired `<tex>_sampler`

### `appendInjection(bgl, kind)` — engine-side BGL extension API

Engine-injected resources (shadow maps, IBL skylight, lightmap emissive/AO) attach **after** the user paramSchema region. The starting binding is `bgl.length` -- never a hardcoded constant -- so any user-region size flows through to the injection start without a coupled edit:

```ts
import { appendInjection, type InjectionKind } from '@forgeax/engine-runtime';

// userBgl = derive(schema).bglEntries
const merged = [...userBgl, ...appendInjection(userBgl, 'ibl')];
device.createBindGroupLayout({ entries: merged });
```

Closed `InjectionKind` union (3 members, lengths locked):

| `kind` | length | Layout (in declaration order) |
|:--|:--|:--|
| `'shadow'` | 2 | `sampler_comparison` + `texture_depth_2d` (per-material shadow override seam; shadow bindings in the engine-shipped PBR shader still live in the view BGL group(0) today) |
| `'ibl'` | 7 | irradiance cube + sampler + prefilter cube + sampler + brdfLut 2d + sampler + intensity uniform |
| `'lightmap'` | 4 | emissive sampler + texture + occlusion sampler + texture |

### Build-time validation (`vite-plugin-shader`)

The vite-plugin-shader build pipeline runs `naga_oil` compose -> `naga reflect` -> `compareParamSchemaWithBgl(actualBgl, derive(schema).bglEntries)` and fails the build with `material-shader-binding-mismatch` (added in feat-20260613) when the WGSL `@binding` reflection is **not** a superset of the derived BGL. The mismatch error carries `.expected` (the derived BGL list), `.actual` (WGSL reflection), and `.hint` (a paste-ready binding rebase recipe). Multiple WGSL bindings beyond the derive output are tolerated by design -- this is the seam for `appendInjection` engine-injected resources at register time.

### Built-in shader paramSchema reference

The 5 engine-shipped shaders sidecar `paramSchema` declarations after w18-w21 (M4 of feat-20260613):

| Shader | `paramSchema` entries | `userRegionBindingEnd` |
|:--|:--|:--|
| `default-standard-pbr` | UBO numeric run (`baseColor` color + `metallic` f32 + `roughness` f32) + `baseColorTexture` + `metallicRoughnessTexture` + `normalTexture` (each auto-pairs a sampler) | 7 |
| `default-standard-pbr-skin` | Same as standard-pbr (skin palette is `storage_buffer` injected separately at build time) | 7 |
| `unlit` | UBO numeric run (`tint` color) + `mainTex` texture2d (auto-pairs sampler) | 3 |
| `sprite` | UBO numeric run (`mainColor` color + sprite uniforms) + `mainTex` texture2d (auto-pairs sampler) | 3 |
| `sprite-lit` | Same shape as `sprite` (paramSchema is field-set byte-identical: 4 vec4 + 1 texture2d; auto-paired sampler). AC-07: BGL JSON byte-identical to `sprite`. | 3 |
| `shadow_caster` | empty (depth-only pass; `bglEntries=[]`, `totalBytes=0`, `userRegionBindingEnd=0`) | 0 |

## Material shader error codes

`ShaderErrorCode` closed union (SSOT: `packages/types/src/index.ts`). AI users `switch (err.code)` exhaustively without default; TS guards completeness.

| Code | Added in | Detail interface |
|:--|:--|:--|
| `shader-compile-failed` | MVP | `ShaderCompileFailedDetail` -- lineNum/linePos from WGSL compiler |
| `compiler-init-failed` | MVP | `ShaderInitFailedDetail` -- build-time only |
| `manifest-malformed` | MVP | `ShaderManifestMalformedDetail` -- manifest.json schema violation |
| `shader-not-found` | MVP | N/A (prose detail) -- hash miss in manifest |
| `shader-import-not-found` | MVP | `ShaderImportNotFoundDetail` -- naga_oil unresolved `#import` |
| `shader-circular-import` | MVP | `ShaderCircularImportDetail` -- cycle first/last repetition |
| `shader-define-conflict` | MVP | `ShaderDefineConflictDetail` -- duplicate `#define` override |
| `material-schema-mismatch` | feat-20260523 | `MaterialSchemaMismatchDetail` -- paramSchema vs BGL mismatch |
| `material-shader-not-found` | feat-20260523 | `MaterialShaderNotFoundDetail` -- identifier miss |
| `material-param-type-mismatch` | feat-20260523 | `MaterialParamTypeMismatchDetail` -- paramValues type error |
| `material-param-unknown` | feat-20260523 | `MaterialParamUnknownDetail` -- paramValues extra key |
| `material-param-missing-required` | feat-20260523 | `MaterialParamMissingRequiredDetail` -- paramValues missing key |
| `material-shader-binding-mismatch` | feat-20260613 | `MaterialShaderBindingMismatchDetail` -- WGSL `@binding` reflection is not a superset of `derive(schema).bglEntries`; carries `.expected` / `.actual` / `.hint` |

## Constraints / invariant enforcement

- **Physical isolation of production bundle from Naga wasm** -- `@forgeax/engine-shader/package.json` deps/peerDeps/devDeps all exclude `@forgeax/engine-shader-compiler` / `@forgeax/engine-naga` / `@forgeax/engine-wgpu-wasm`; `src/**/*.ts` excludes corresponding import statements (AC-06 (b) dependency graph static check + (c) source grep).
- **instance-per-engine** -- exposed via `engine.shader: ShaderRegistry` lazy property; module-level singletons / static methods forbidden (plan-strategy S-10 / D-R10 / OQ-5 close).
- **Result model** -- `registry.get(hash)` returns `Result<ShaderModule, RhiError | ShaderError>`; hash miss -> `ShaderError.shader-not-found`; manifest corruption -> `ShaderError.manifest-malformed`; underlying `rhi.createShaderModule` failure -> `RhiError` pass-through (charter proposition 4 explicit failure / 12 error union, AGENTS.md "RHI / Shader / error model contract").
- **manifest schema SSOT** -- `ManifestEntry` 4 fields (hash / wgsl / glsl / bindings) from [`@forgeax/engine-types`](../types/src/index.ts) (AC-04 / MVP-2.6).

## API index

| Entry | Shape | Description |
|:--|:--|:--|
| `ShaderRegistry` | `class` | Main class (w17 landed); `new ShaderRegistry({ device, manifestUrl })` |
| `ShaderRegistry.loadManifest()` | `() => Promise<Result<void, ShaderError>>` | Load and validate manifest.json schema |
| `ShaderRegistry.get(hash)` | `(string) => Result<ShaderModule, RhiError \| ShaderError>` | Hash lookup -> `device.createShaderModule` pass-through |
| `ShaderRegistry.registerMaterialShader(id, entry)` | `(string, MaterialShaderEntry) => void` | Register a material shader by identifier; throws on duplicate |
| `ShaderRegistry.lookupMaterialShader(id)` | `(string) => Result<MaterialShaderEntry, ShaderError>` | Lookup a previously registered material shader entry |
| `ShaderRegistry.materialShaderIdentifiers()` | `() => IterableIterator<string>` | Iterate every registered material shader identifier |

## Out of scope (v1)

These three features are explicitly out of scope for the current shader pipeline (per requirements 4.5 OOS table). They are documented here so AI users know what not to attempt:

| Tag | Feature | Reason OOS |
|:--|:--|:--|
| OOS-1 | Boolean compile-time defines (`#define FOO 1`) | Requires a preprocessor pass before naga_oil composition; the current pipeline composes wgsl modules as-is. Boolean defines would need a new ShaderCompiler `defines` parameter + manifest entry variant tracking the set of applied defines per hash. |
| OOS-2 | WGSL `override` keyword (pipeline-level specialization constants) | `override` values are set per `createRenderPipeline` call, not per material asset. Supporting them needs a separate registry layer mapping material-level param names to pipeline override IDs, plus a build-time reflection path that enumerates `override` declarations. |
| OOS-3 | Host-side string patching (regex replace in WGSL source) | Deprecated by the schema-driven param approach. String patching is fragile (no type safety, no validation) and breaks content-addressed hashing (different patch strings = different hash = different manifest entry). Use `paramSchema` + `paramValues` instead. |

## Onboarding: write a MaterialShader and ship a schema-driven MaterialAsset

> AI user writes a new `.wgsl` material shader and renders it via the schema-driven path. Two consumer surfaces: (a) `ShaderRegistry.registerMaterialShader(id, entry)` registers the wgsl source + paramSchema under a path identifier (`forgeax::*` reserved for engine builtins; user shaders use sidecar GUID); (b) `assets.registerMaterialAsset({ materialShader, paramSchema, paramValues })` registers the material asset whose `materialShader` field references the shader by identifier. The runtime per-MaterialShader pipeline cache lazily builds the pipeline on first reference.

> [!NOTE]
> **`bindingLayout` is gone (feat-20260613-material-paramschema-driven-binding M3 / w13).** `MaterialShaderEntry` no longer carries a separate `bindingLayout` field — `derive(paramSchema)` is the single source for BGL entries. Existing `registerMaterialShader` callers that previously passed a hand-rolled `bindingLayout` array drop the field outright; the runtime calls `derive` once and feeds the result into both BGL build and per-entity UBO write.

```ts
// 1. Author the shader source — typically authored as `.wgsl` and #imported via `?raw`.
import pulseShader from './shaders/pulse-material.wgsl?raw'; // wgsl source

// 2. Register the MaterialShader. `id` is the path identifier the asset will reference.
//    Engine builtins (e.g. 'forgeax::default-standard-pbr') are auto-registered at boot.
engine.shader?.registerMaterialShader('my-app::pulse-material', {
  source: pulseShader,
  paramSchema: [
    { name: 'baseColor', type: 'color', default: [1, 0.5, 0.2] },
    { name: 'time', type: 'f32', default: 0 },
    { name: 'speed', type: 'f32', default: 1 },
    { name: 'mainTex', type: 'texture2d' }, // auto-pairs a filtering sampler at the next binding
  ],
  // No bindingLayout field: derive(paramSchema) inside registerMaterialShader produces
  // BGL entries + UBO offsets + texture-field index in one pass.
});

// 3. Register a MaterialAsset that references the MaterialShader.
const handle = engine.assets.registerMaterialAsset({
  materialShader: 'my-app::pulse-material',
  paramSchema: [
    { name: 'baseColor', type: 'color', default: [1, 0.5, 0.2] },
    { name: 'time', type: 'f32', default: 0 },
    { name: 'speed', type: 'f32', default: 1 },
  ],
  paramValues: { baseColor: [1, 0.5, 0.2], time: 0, speed: 1 },
});
if (!handle.ok) {
  // exhaustive switch — runtime AssetRegistry validates paramValues against paramSchema (M4-T03 3-tier).
  switch (handle.error.code) {
    case 'material-param-type-mismatch':     break; // paramValues type does not match paramSchema entry
    case 'material-param-missing-required':  break; // paramValues missing a paramSchema entry without default
    case 'material-param-unknown':           break; // paramValues has key not declared in paramSchema
    case 'material-shader-ref-broken':       break; // materialShader id not found in ShaderRegistry
    case 'asset-invalid-value':              break; // generic validator catch
  }
  return;
}

// 4. Spawn an entity with the MaterialAsset handle; per-frame mutate paramValues via assets.update().
world.spawn({ MeshFilter: { mesh }, MeshRenderer: { material: handle.value }, Transform });
function frame(t: number) {
  engine.assets.update(handle.value, { time: t / 1000 });
  engine.draw(world);
}
```

**Key facts**:
- `materialShader` reference is a string identifier — `forgeax::*` for engine builtins (path), GUID otherwise (user MaterialShaders via `*.wgsl.meta.json` sidecar `subAssets[].kind='material-shader'`); the runtime `parseAssetPayload` `'material'` arm two-way dispatches on `::`.
- `paramSchema` types must come from `MATERIAL_PARAM_TYPES` (14-literal closed union; see "paramSchema v2" above). `boolean` / `mat3` / `mat4` / array<T,N> stay OOS for v2 (feat-20260613 §4 OOS-3). The pre-feat `MATERIAL_PARAM_TYPES_V1` constant is still exported for legacy fixtures and remains a strict subset of the v2 set.
- Build-time validation: `vite-plugin-shader` runs `naga_oil` compose -> `naga reflect` -> `compare-param-schema(actualBgl, derive(schema).bglEntries)` (single-direction superset). Mismatch -> `ShaderError { code: 'material-shader-binding-mismatch' }` with `detail.expected` / `.actual` / `.hint` (paste-ready binding rebase recipe). The legacy `material-schema-mismatch` / `material-shader-extra-key` / `material-shader-type-mismatch` / `material-shader-missing-required` codes still fire on the runtime register-time path (3-tier `registerMaterialAsset` validator).
- Runtime per-MaterialShader pipeline cache (M9): first reference to `materialShaderId` triggers `ShaderRegistry.lookupMaterialShader(id)` -> `buildPipelineForMaterialShader` -> `Map<string, RhiPipeline>.set`; subsequent references reuse the cached pipeline.
- `.pack.json` payload shape for schema-driven materials: `{ materialShader: string, paramSchema: ParamSchemaEntry[], paramValues: Record<string, unknown> }`. Legacy unlit/sprite payloads still use closed `{ shadingModel: 'unlit' | 'sprite', ... }` — the scanner step-7 schema check skips legacy shapes (AC-08 + OOS-4).

**Engine internal hash-pipeline path** (legacy MVP for non-material engine entries — `unlit.wgsl` / `tonemap.wgsl` / `shadow_caster.wgsl` / `sprite.wgsl` / IBL precomputes): still uses `ShaderRegistry.loadManifest()` + `engine.shader?.get(hash)` per the original feat-20260511 design; not exposed to AI user authoring schema-driven materials.

## End-to-end worked example: a custom `pulse-material` shader

The 14-type `paramSchema` declaration drives the WGSL `@binding` layout, the std140 UBO, and the loader's texture-field index. A minimal worked example walks the whole chain:

**1. Author `pulse-material.wgsl.meta.json` (the SSOT):**

```json
{
  "schemaVersion": "1.0.0",
  "kind": "external-asset-package",
  "importer": "shader",
  "source": "pulse-material.wgsl",
  "importSettings": { "materialShaderIdentifier": "my-game::pulse-material" },
  "subAssets": [{ "guid": "01935b00-7d8c-7c4e-9f12-345678abcd01", "sourceIndex": 0, "kind": "material-shader" }],
  "paramSchema": [
    { "name": "baseColor",  "type": "color", "default": [1.0, 0.5, 0.2] },
    { "name": "time",       "type": "f32",   "default": 0 },
    { "name": "speed",      "type": "f32",   "default": 1 },
    { "name": "mainTex",    "type": "texture2d" }
  ]
}
```

**2. `derive(schema)` projects this paramSchema to:**

```text
bglEntries:           [
                        { binding: 0, buffer:  { type: 'uniform' } },               // baseColor + time + speed run-merged
                        { binding: 1, sampler: { type: 'filtering' } },             // auto-paired sampler for mainTex
                        { binding: 2, texture: { sampleType: 'float', viewDimension: '2d' } },  // mainTex
                      ]
uboLayout:            { entries: [
                        { name: 'baseColor', offset:  0, size: 16, type: 'color' },
                        { name: 'time',      offset: 16, size:  4, type: 'f32' },
                        { name: 'speed',     offset: 20, size:  4, type: 'f32' },
                      ], totalBytes: 32 }
textureFieldNames:    Set<{ 'mainTex' }>
samplerForTexture:    Map<{ 'mainTex' -> 'mainTex_sampler' }>
userRegionBindingEnd: 3                                                            // engine-injection (shadow / IBL / lightmap) starts here
```

**3. Author `pulse-material.wgsl` to match the derived BGL exactly:**

```wgsl
#define_import_path my_game::pulse_material
#import forgeax_view::common::{view, meshes}

struct PulseUniforms {
  baseColor : vec4<f32>,   // offset  0, size 16 (color = vec4 std140)
  time      : f32,         // offset 16
  speed     : f32,         // offset 20
};

@group(1) @binding(0) var<uniform>      pulse           : PulseUniforms;
@group(1) @binding(1) var                mainTexSampler : sampler;
@group(1) @binding(2) var                mainTex        : texture_2d<f32>;

// vs_main / fs_main bodies omitted for brevity
```

**4. Build + register:**

```ts
// vite-plugin-shader at build time:
//   1. Parses the sidecar `paramSchema`.
//   2. Composes pulse-material.wgsl via naga_oil + reflects via naga.
//   3. Calls `compare-param-schema(actualBgl, derive(schema).bglEntries)`.
//      Mismatch -> build fails with `material-shader-binding-mismatch`.
//
// At runtime:
import pulseShader from './pulse-material.wgsl?raw';
engine.shader?.registerMaterialShader('my-game::pulse-material', {
  source: pulseShader,
  paramSchema: [
    { name: 'baseColor', type: 'color', default: [1, 0.5, 0.2] },
    { name: 'time',      type: 'f32',   default: 0 },
    { name: 'speed',     type: 'f32',   default: 1 },
    { name: 'mainTex',   type: 'texture2d' },
  ],
});

// Register a MaterialAsset that references the shader.
const tex = await engine.assets.loadByGuid<TextureAsset>('...');
const handle = engine.assets.registerMaterialAsset({
  materialShader: 'my-game::pulse-material',
  paramSchema:    /* same array as above */,
  paramValues:    { baseColor: [1, 0.5, 0.2], time: 0, speed: 1, mainTex: tex.unwrap() },
});
```

If WGSL declares a `@binding` not present in the derived BGL (e.g. typo `@binding(2)` instead of `@binding(1)` for the sampler), the build fails before the engine ever sees it; if WGSL declares **extra** bindings beyond the derived BGL (e.g. an engine-side IBL injection at binding 3..9), those are tolerated by design — `appendInjection` consumes that suffix.

## References

- Decision plan-strategy [S-10 instance-per-engine](../../.forgeax-harness/forgeax-loop/feat-20260508-shader-pipeline-mvp/plan-strategy.md) / S-2 AC-06 triple-grep gate.
- 12 error union evolution contract in repo root [AGENTS.md "RHI / Shader / error model contract"](../../AGENTS.md).
- Upstream [`@forgeax/engine-rhi`](../rhi/README.md) provides `RhiDevice.createShaderModule` entry + `RhiError` closed union.
- Upstream [`@forgeax/engine-types`](../types/src/index.ts) provides `ManifestEntry` / `ShaderErrorCode` SSOT.
- Integration [`@forgeax/engine-runtime`](../engine/README.md) injects via `Renderer.shader` lazy property (w18 landed).