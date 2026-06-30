# @forgeax/engine-types

> **Single source of truth for pure literal types and enums shared across RHI / shader / future render packages.** POD types / zero runtime constants / single-source strategy -- `export type` only, never redefine `@webgpu/types` runtime constant values (decision S-6 / research F-2 option (b)).

> **Material types: `ParamSchemaEntry` + `MaterialAsset`.** feat-20260527-material-registration-unification unified material registration to a single `register<MaterialAsset>` entry point. `MaterialAsset` carries `passes[]` (array of `MaterialPassDescriptor` with per-pass `shader` routing) + `paramValues` (flat parameter record validated at register-time against the union of per-pass `ShaderRegistry` paramSchema entries). See the MaterialAsset section below for full field details; see [`packages/shader/README.md`](../shader/README.md) for the ShaderRegistry catalog and param type reference; see [`packages/pack/README.md`](../pack/README.md) for the .pack.json MaterialAsset shape.

> [!CAUTION]
> **shadingModel proposition (feat-20260518-pbr-direct-lighting-mvp / AC-17)** -- legacy `MaterialAsset.shadingModel:'standard'` routes through GGX direct lighting, **0 DirectionalLight produces physically-correct black output**; `'unlit'` is the "ignore lights" entry point (`baseColor x baseColorTexture` direct output). New demos choosing `'standard'` must spawn a `DirectionalLight` in sync. See [`packages/runtime/README.md` Common pitfalls](../runtime/README.md#common-pitfalls) + [AGENTS.md Breaking changes](../../AGENTS.md#breaking-changes) 2026-05-18 row. For pass-based materials (feat-20260527+), use `register<MaterialAsset>` with `passes[]` / `paramValues` — see `AssetRegistry.register` in [`packages/runtime/README.md`](../runtime/README.md).

## Shape invariants

- **POD types** -- only `type` declarations (numeric aliases / unions / pass-through alias), no `class` / `function` / `const` literal values.
- **`AssetErrorCode` 19-member closed union** -- SSOT at [`src/index.ts:993-1017`](./src/index.ts). Three codes added in feat-20260608-mesh-multi-section-primitive-multi-material-slot: `'mesh-renderer-material-count-mismatch'` (materials.length != submeshes.length), `'mesh-asset-submeshes-empty'` (submeshes array is empty), `'mesh-submesh-index-range-out-of-bounds'` (submesh index range exceeds parent index buffer). Each carries a structured `.detail` narrowed per code via the `AssetErrorDetail` discriminated union. See [AGENTS.md](../../AGENTS.md) Error model table for the full 19-member roster.
- **Zero runtime constants** -- never redefine `BufferUsage.MAP_READ` etc.; upstream callers directly consume `@webgpu/types` injected global `GPUBufferUsage.MAP_READ`.
- **Single-source strategy** -- fields exported by `@webgpu/types` (e.g. `GPUTextureFormat`) are pass-through aliased in this package, never redefined. `RhiErrorCode` and other forgeax-owned closed unions are closed within their owning packages (zero cyclic dependency with this package).

## Entry points

| Entry | Surface | Browser-safe? |
|:--|:--|:--|
| `@forgeax/engine-types` (main) | POD types + closed-union aliases (math-free, zero `ws`) | yes |
| `@forgeax/engine-types/inspector-client` | `defaultConnect` / `InspectorClient` — JSON-RPC 2.0 WS client | **Node-only** (`exports['./inspector-client']` carries `node` condition + `default: null`; `ws` is a `peerDependencies` + `peerDependenciesMeta.ws.optional=true` — consumers must install `ws` themselves to use this sub-export) |

## API index

`export type` only on the main entry, zero runtime constants. Full main-entry export list at [`src/index.ts`](./src/index.ts).

| Category | Exports | Description |
|:--|:--|:--|
| GPUFlagsConstant alias | `BufferUsageFlags` / `TextureUsageFlags` / `MapModeFlags` / `ShaderStageFlags` / `ColorWriteFlags` | TS side collapses to `number`; runtime values provided by `@webgpu/types` injected globals |
| Enum alias pass-through | `TextureFormat` / `AddressMode` / `FilterMode` / `CompareFunction` / `PrimitiveTopology` / others | `@webgpu/types` namespace literal union pass-through |
| Pass-based material types | `ParamSchemaEntry` / `MaterialAsset` / `MaterialPassDescriptor` | ParamSchema entry shape + MaterialAsset with passes[] + pass descriptor; see MaterialAsset section below |
| Asset register contracts | `register<MaterialAsset>()` / `registerWithGuid<MaterialAsset>()` / `lookupMaterialShader()` | Runtime factory functions + validation; detail in `packages/runtime/README.md` |
| Remote error model | `RemoteErrorCode` / `RemoteError` | 4-member closed union (script-syntax-error / script-runtime-error / server-startup-failed / server-not-running) + structural interface; runtime class lives in `@forgeax/engine-remote/errors` (`implements RemoteError`); see [`@forgeax/engine-remote` README](../remote/README.md) for the full error model |

## Handle

> Cross-package `Handle<T,M>` single physical SSOT (feat-20260517-handle-type-unify). This section is the AI user's mid-level detail reference; top proposition at [`AGENTS.md` Breaking changes](../../AGENTS.md#breaking-changes) 2026-05-18 row; bottom-level fallback at [`src/handle.ts`](./src/handle.ts) IDE hover JSDoc.

### Brand shape

`Handle<T,M>` is a dual-axis phantom-branded `number`, zero runtime overhead (`__handle` field only exists at the type level), TS compile-time brand enforces cross-target / cross-mode non-assignability (charter P3 explicit failure + P4 consistent abstraction):

```ts
export type Handle<T extends string, M extends 'managed' | 'unmanaged'> = number & {
  readonly __handle: { readonly target: T; readonly mode: M };
};
```

- **`T extends string`** -- asset target tag (e.g. `'MeshAsset'` / `'TextureAsset'`); cross-tag `Handle<'MeshAsset',M>` and `Handle<'TextureAsset',M>` are mutually non-assignable.
- **`M extends 'managed' | 'unmanaged'`** -- release responsibility: `'managed'` tracked by ECS via `ManagedRefStore`; `'unmanaged'` held by external owner (e.g. `AssetRegistry`); cross-mode non-assignability is a TS compile-time redline, preventing misuse of ECS managed handles with self-releasing registries.

Convenience aliases:

| Alias | Shape | Where used |
|:--|:--|:--|
| `ManagedHandle<T>` | `Handle<T, 'managed'>` | ECS internal consumption (`managed-ref-store.ts` column slot reads etc.); **`@forgeax/engine-ecs` barrel no longer re-exports this alias** (AC-15 grep gate, narrow AI user-facing surface); external callers write `Handle<T, 'managed'>` literal |
| `UnmanagedHandle<T>` | `Handle<T, 'unmanaged'>` | `AssetRegistry.register<T>` return signature / `MeshFilter.assetHandle` column type; `@forgeax/engine-ecs` barrel re-exports alongside `Handle` |

### `AssetTagMap` 5-member table

`AssetTagMap` is the closed mapping SSOT from `Asset.kind` literal to brand `target` tag string literal (D-1 path (a)); adding a new Asset variant only requires adding one row to this table + one line to `Asset` union for `register<NewVariant>(asset)` to correctly return `Handle<'XxxAsset','unmanaged'>` (charter F1 single-indexable):

| `kind` literal | `target` tag |
|:--|:--|
| `'mesh'` | `'MeshAsset'` |
| `'texture'` | `'TextureAsset'` |
| `'sampler'` | `'SamplerAsset'` |
| `'material'` | `'MaterialAsset'` |
| `'scene'` | `'SceneAsset'` |

`MaterialAsset` is a 3-variant sub-union (`UnlitMaterialAsset | SchemaDrivenMaterialAsset | SpriteMaterialAsset`), all branches `kind: 'material'`, so `TagOf<MaterialAsset>` distributive evaluation collapses all three branches to `'MaterialAsset'` (research Finding 2).

Adding a 6th `Asset` closed-union member without syncing this table -> `TagOf<NewAsset>` resolves to `never`, downstream `register<NewAsset>` static failure surfaces the missing entry (charter P3 explicit failure).

### `TagOf<T>` mapping

Distributive conditional resolves an Asset variant TS type to the corresponding brand `target` tag literal:

```ts
export type TagOf<T extends Asset> = T extends { kind: infer K }
  ? K extends keyof AssetTagMap
    ? AssetTagMap[K]
    : never
  : never;
```

`AssetRegistry.register<T extends Asset>(asset: T): Handle<TagOf<T>, 'unmanaged'>` is the primary consumer of this mapping -- AI users write `register(meshAsset)` and get `Handle<'MeshAsset', 'unmanaged'>` without explicit generic parameter at the call site.

### Three helper signatures

```ts
export function toManaged<T extends string>(raw: number): Handle<T, 'managed'>;
export function toUnmanaged<T extends string>(raw: number): Handle<T, 'unmanaged'>;
export function unwrapHandle<T extends string, M extends 'managed' | 'unmanaged'>(
  h: Handle<T, M>,
): number;
```

- **`toManaged<T>(raw)`** -- brand-creation factory, `as Handle<T, 'managed'>` literal is the AC-01 exemption "only" brand creation point (D-7); consumed internally by `ManagedRefStore.alloc<T>(value)`.
- **`toUnmanaged<T>(raw)`** -- brand-creation factory, external owner side; consumed internally by `AssetRegistry.register<T>` + `BUILTIN_HANDLE_*` u32 constant branding (replaces call-site `as unknown as Handle<...>` literals, AC-05).
- **`unwrapHandle(h)`** -- brand removal helper, runtime identity; exists to converge all "brand -> raw u32" conversion points into one function, AC-01 grep gate sweeps scattered `as unknown as number` literals (D-7 / D-8 cast collapse plan). AI users at spawn-site / register-site typically do not need to call this directly (charter P1 progressive disclosure).

Usage example:

```ts
import {
  type Handle,
  type UnmanagedHandle,
  toUnmanaged,
  unwrapHandle,
} from '@forgeax/engine-types';
import { Engine } from '@forgeax/engine-runtime';

const engine = await Engine.create({ canvas });

// register returns Handle<TagOf<T>, 'unmanaged'> - generic inferred from asset.kind literal
const meshHandle = engine.assets.register(myMeshAsset);
//    ^? Handle<'MeshAsset', 'unmanaged'>

// builtin handle u32 -> branded handle
const HANDLE_FOO: UnmanagedHandle<'MeshAsset'> = toUnmanaged<'MeshAsset'>(0xdead);

// brand removal (only when interacting with underlying Map<number, ...> / data structure keys)
const raw: number = unwrapHandle(meshHandle);
```

### Cross-package re-export pattern

Same precedent as `LocalEntityId` / `SceneInstanceId`:

- Physical SSOT is one file (`packages/types/src/handle.ts`); package barrel `index.ts` pass-through via `export * from './handle'`.
- `@forgeax/engine-ecs` barrel re-exports a **narrowed subset**: `export type { Handle, UnmanagedHandle } from '@forgeax/engine-types'` + `export { toManaged, toUnmanaged } from '@forgeax/engine-types'`, for existing `import { Handle } from '@forgeax/engine-ecs'` consumers to continue working; `TagOf` / `unwrapHandle` / `ManagedHandle` are not in the ecs barrel (AC-15 narrow AI user-facing surface, get these directly `from '@forgeax/engine-types'`).
- Under `verbatimModuleSyntax: true`, `export type` and `export { runtime }` are strictly separate.
- `ManagedHandle<T>` alias + internal `'String'` tag not in ECS barrel (AC-15 grep gate; narrow AI user-facing surface).

### Internal conventions

- **`'String'` tag not public** -- `Handle<'String','managed'>` is the internal representation of schema vocab `'string'` (feat-20260515-string-managed-collapse), only appearing inside `world.ts` / `managed-ref-store.ts` as `toManaged<'String'>()`; external callers face JS `string` value type.
- **`AC-01` exemption single point** -- only the 3 helpers in `packages/types/src/handle.ts` may contain `as Handle<T, M>` / `as Handle<T, 'managed'>` / `as Handle<T, 'unmanaged'>` literals; brand creation elsewhere must route through helpers. `rg -n 'as unknown as Handle<' packages apps` should hit 0.
- **`unwrapHandle` is the sole channel for eliminating `as unknown as number`** -- `rg -n 'as unknown as number' packages apps` expected 0 hits (feat-20260517 M2-M4 sweep consequence).

## MaterialAsset

> feat-20260527-material-registration-unification -- `MaterialAsset` is a single pass-based shape: `kind: 'material'` + `passes[]` array of `MaterialPassDescriptor` (each with `shader` identifier for per-pass ShaderRegistry routing) + `paramValues` (validated at register-time against the union of all pass-shader paramSchema entries). Full field definitions at [`src/index.ts`](./src/index.ts).

### Pass-based variant

The single path (feat-20260527-material-registration-unification M3): carries `passes[]` + `paramValues`.

```ts
interface MaterialAsset {
  readonly kind: 'material';
  readonly passes?: readonly MaterialPassDescriptor[];
  readonly parent?: Handle<'MaterialAsset', 'unmanaged'>;
  readonly paramValues?: Readonly<Record<string, unknown>>;
}
```

| Field | Type | Description |
|:--|:--|:--|
| `passes` | `readonly MaterialPassDescriptor[]` | Array of pass descriptors; each `pass.shader` routes to `ShaderRegistry.lookupMaterialShader` for paramSchema validation at register-time. |
| `paramValues` | `Readonly<Record<string, unknown>>` | Instantiated parameter values; validated at register-time via `_validateMaterialPasses` (union paramSchema, extra-key ignore, missing-required error). |
| `parent` | `Handle<'MaterialAsset', 'unmanaged'>` | Inheritance chain parent for lazy-resolve merging. |

`ParamSchemaEntry` shape (from `@forgeax/engine-types`):

```ts
interface ParamSchemaEntry {
  readonly name: string;
  readonly type: string;   // must be in MATERIAL_PARAM_TYPES_V1
  readonly default?: unknown;
}
```

Registered via `assets.register<MaterialAsset>(asset)` or `assets.registerWithGuid<MaterialAsset>(guid, asset)` -- the unified entry point.

### MaterialPassDescriptor fields

Each entry in `MaterialAsset.passes[]` is a `MaterialPassDescriptor` (all optional except `name` + `shader`).

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `name` | `string` | required | Pass identifier for by-name inheritance override |
| `shader` | `string` | required | Shader registry entry id (e.g. `'forgeax::default-standard-pbr'`) |
| `vertexEntry` | `string` | `'vs_main'` | Vertex shader entry-point function name |
| `fragmentEntry` | `string` | `'fs_main'` | Fragment shader entry-point function name |
| `defines` | `Record<string, string>` | `{}` | Per-pass preprocessor defines |
| `tags` | `Record<string, string>` | `{}` | Free key-value tags for `PassSelector` routing |
| `renderState` | `MaterialRenderState` | engine defaults | Per-pass GPU pipeline render state overrides |
| `queue` | `number` | `2000` (`RenderQueue.Geometry`) | Sort key for the single dispatch list |
| `stencilReference` | `number` | `0` | Stencil reference value set via `setStencilReference` per draw (draw-call dynamic state) |

### MaterialRenderState fields

`MaterialRenderState` is the optional per-pass pipeline overrides. All fields are optional -- engine defaults apply when omitted.

> [!NOTE]
> mask fields (`stencilReadMask` / `stencilWriteMask`) live at the `GPUDepthStencilState` top level, NOT inside `stencilFront` / `stencilBack`. `frontFace` lives in `GPUPrimitiveState`.

| Field | Type | Default | Description |
|:--|:--|:--|:--|
| `depthWriteEnabled` | `boolean` | `true` | Whether depth writes are enabled |
| `depthCompare` | `string` | `'less'` | Depth comparison function |
| `stencilReadMask` | `number` | `0xFFFFFFFF` (WebGPU default) | Stencil read mask, top-level `GPUDepthStencilState` |
| `stencilWriteMask` | `number` | `0xFFFFFFFF` (WebGPU default) | Stencil write mask, top-level `GPUDepthStencilState` |
| `frontFace` | `'ccw' \| 'cw'` | `'ccw'` | Triangle front-face winding order |
| `cullMode` | `string` | `'back'` | Face culling mode |
| `blend` | `MaterialBlendState` | opaque | Blend state for alpha blending |
| `stencil` | `MaterialStencilState` | no-op | Stencil test state (`StencilFaceState` per-face) |

`MaterialStencilState` (for the `stencil` field): `compare` / `failOp` / `depthFailOp` / `passOp` apply per-face (`stencilFront` / `stencilBack`). The mask fields are NOT on `StencilFaceState` -- they are top-level on `MaterialRenderState`.

Full interface source (SSOT): [`src/index.ts`](./src/index.ts) `MaterialRenderState` + `MaterialPassDescriptor`.

### Legacy `channelMap` field (StandardMaterialAsset -- pre-feat-20260523)

`metallicRoughnessTexture` unpack four-channel index SSOT. **TS call surface** (form AI users write) is a string literal union object:

```ts
channelMap?: {
  metallic: 'r' | 'g' | 'b' | 'a';
  roughness: 'r' | 'g' | 'b' | 'a';
  occlusion?: 'r' | 'g' | 'b' | 'a';
}
```

| Field | Semantics | Default (glTF 2.0) | Shader consumption point |
|:--|:--|:--|:--|
| `channelMap.metallic` | metallic channel selection (`'r'|'g'|'b'|'a'`) | `'b'` (B channel) | `pbr.wgsl` `pick_channel(mrSample, material.channelMap.x)` |
| `channelMap.roughness` | roughness channel selection | `'g'` (G channel) | `pbr.wgsl` `pick_channel(mrSample, material.channelMap.y)` |
| `channelMap.occlusion?` | occlusion channel selection (OOS-3 reserved) | `'r'` (R channel) | Reserved OOS-3 occlusion path |

**Default behavior**: `MaterialAsset.channelMap === undefined` auto-fills glTF 2.0 default `{ metallic: 'b', roughness: 'g', occlusion: 'r' }` at `AssetRegistry.register` (feat-20260518 M3 / w16); explicit override path = caller passes `channelMap: { metallic: 'r', roughness: 'b', ... }` literal object at register.

**Validation**: `AssetRegistry.register` fail-fast rejects any value outside `'r'|'g'|'b'|'a'` -> `Result.err({ code: 'asset-invalid-value', detail: { field: 'channelMap.<key>', got: ... } })` (feat-20260518 AC-02).

> [!NOTE]
> Internal implementation note: host `AssetRegistry` maps `'r'/'g'/'b'/'a'` literals to 0/1/2/3 indices and packs into `vec4<u32>` UBO row (plan-strategy D-4); this is the host->shader UBO packing layer, **not the AI user call surface**. Shader only consumes packed scalar indices, no string vocab leaks to GPU side.

### `DirectionalLight.direction` field semantics

> feat-20260518-pbr-direct-lighting-mvp / w17.5 -- `DirectionalLight.direction` (`directionX/Y/Z`) is the **outgoing direction**: light from source pointing toward the illuminated point in world space; shader fragment internally `normalize(-view.lightDir)` reverses to get the BRDF L vector. Host (`render-system-record.ts`) verbatim uploads the host-provided `direction` components to the view UBO, shader holds the reverse semantic unilaterally (single SSOT, no double-negation risk).

| Default | Meaning |
|:--|:--|
| `directionX = -0.5, directionY = -1, directionZ = -0.3` | Sun-like from upper-right-behind shining down onto forward-facing objects (M0 spike-report locked value; shared across multiple demos in `populateDemoWorld`) |
| `colorR = 1, colorG = 1, colorB = 1, intensity = 1` | White light unit intensity (GGX direct light SSOT default case) |

**Validation**: `AssetRegistry.register` does not validate `direction` magnitude; BRDF internally `nDotL = max(dot(n, l), 0.0)` naturally clamps back-face -> 0; `intensity = 0` is a legal case (feat-20260518 case C 0 light physically-correct black screen).

## Relationship with `@webgpu/types`

- **Dependency**: `@webgpu/types ^0.1.69` (version lock strategy detailed in repo root `AGENTS.md`).
- **Shape alignment**: All numeric aliases (`BufferUsageFlags` etc.) strictly correspond to `GPUFlagsConstant` namespace -- TS side collapses to `number`, runtime values defined by W3C CR 3.6.
- **No redefinition**: This package never writes `export const BufferUsage = { MAP_READ: 0x0001, ... }`.
- **Intentional differences**: None (this package only alias pass-through, zero shape divergence).

## Related packages

- [`@forgeax/engine-rhi`](../rhi) -- pure interface package, consumes POD types exported by this package.
- [`@forgeax/engine-rhi-webgpu`](../rhi-webgpu) -- WebGPU thin shim implementation (M2 introduced).
- [`@forgeax/engine-runtime`](../engine) -- async factory entry (M3 consumes this package indirectly via `@forgeax/engine-rhi-webgpu` injection).

### Name disambiguation (three layers)

The unqualified word "name" appears at three different semantic layers. Confusing them leads to silent bugs -- each layer has a distinct storage location, resolution rule, and consumer.

| Layer | What it is | Where it lives | How to read it | When to use it |
|:--|:--|:--|:--|:--|
| **Asset identity `name`** | The human-readable segment in `<packagePath>.<name>` -- a derived identity from the `Package` the asset belongs to, never stored on the POD | `AssetRegistry.resolveName(guid)` calls `deriveAssetName` pure function; the XOR rule (single-asset package -> basename(path), multi-asset -> `.pack.json assets[].name`, no-package -> empty string or stored self-name) is SSOT | `reg.resolveName(guid)` | Inspector display, error messages, debug logs -- anywhere a human (or AI) needs to identify an asset |
| **Entity `Name` component** | An ECS component (`{ value: string }`) attached to spawned entities | ECS world storage (`world.get(entity, Name)`) | `world.get(e, Name).value` | Scene-graph debugging, joint-path resolution in skinning -- anything keyed off an entity's glTF node name. Unchanged by this feat (OOS-5) |
| **`ShaderAsset.name`** | Registration identifier of a material shader (e.g. `'forgeax::default-standard-pbr'`) | `ShaderAsset.name` field on the POD -- the only `name` field on any Asset POD that is NOT OOS-2 | `(asset as ShaderAsset).name` in ShaderRegistry code paths; not exposed through `resolveName` | `MaterialPassDescriptor.shader` routing, `ShaderRegistry.lookupMaterialShader` -- the shader-authoring contract between material and pipeline |

> [!TIP]
> **How to choose**: when displaying an asset to a human, use `resolveName(guid)` (layer 1). When reading a spawned entity's original node name from glTF/FBX, use the `Name` ECS component (layer 2). When registering a custom material shader and binding it to a `MaterialPassDescriptor`, use `ShaderAsset.name` (layer 3). The three layers coexist and do not conflict -- an asset's entity may carry a `Name` component that differs from the asset's resolved identity name.

**Example**: A `Hero.glb` file imports as a single-asset package (path `'hero.glb'`, 1 mesh asset). `resolveName(meshGuid)` returns `'hero.glb'` (basename of the package path; the extension is kept). Entity `Name` components on nodes inside the scene read `'Helmet'`, `'Sword'`, etc. from the glTF node hierarchy. A custom PBR shader registered as `ShaderAsset { name: 'forgeax::custom-stylized-pbr' }` routes through `shader` lookup, not through `resolveName`.

**Identity types** (new in feat-20260618): `Package` (`{ path, assetGuids, assetCount }`), `PackIndexEntry.name?` (add-only optional, build-time resolved), `InspectEntry.name` (non-optional string, runtime resolved). All discoverable via `@forgeax/engine-types` IDE autocomplete. See [`skills/forgeax-engine-assets/SKILL.md`](../../skills/forgeax-engine-assets/SKILL.md) for the full identity model.

### ShaderModule naming disambiguation

The unqualified name `ShaderModule` collides across two layers -- see [`packages/shader/README.md`](../shader/README.md) for the canonical disambiguation. In short: **wgsl ShaderModule** (from `engine-shader`, importable `.wgsl` file-level unit with `#define_import_path`) is distinct from the **RHI ShaderModule handle** (from `engine-rhi`, GPU-side compiled-shader opaque handle created by `rhi.createShaderModule`). The two are distinguished by module path only.

## FAQ

**Q: Why not directly `import type { GPUTextureFormat } from '@webgpu/types'`?**

A: Single-source strategy -- forgeax callers uniformly source from `@forgeax/engine-types`, making future spec version switches (`@webgpu/types v0.2.x` may introduce breaking changes) require adaptation only in this package.

**Q: Why not export runtime enum values (`BufferUsage.MAP_READ` etc.)?**

A: Decision S-6 / research F-2 option (b): spec at W3C CR 3.6 already defines `GPUBufferUsage.MAP_READ === 0x0001`; redefining would introduce dual-source silent breakage risk (charter proposition 4 explicit failure principle).

## Upgrade path

`@webgpu/types` upstream patches follow `.github/dependabot.yml` auto-PR + monthly human review fallback (decision S-4). v0.2.x major version switch requires a new closed loop (remove `ExplicitUndefined` mapped type and other migration steps).