---
name: forgeax-engine-rhi
description: >-
  ForgeaX spec-aligned rendering hardware interface. Use when implementing or debugging
  a backend, capability gate, resource lifetime, descriptor, or backend-selection path.
---

# forgeax-engine-rhi

> RHI is the pure interface between engine and GPU. For unexplained rendering failures start with [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.md); material authoring uses [`forgeax-engine-material`](../forgeax-engine-material/SKILL.md), passes/post-processing use [`forgeax-engine-render-pipeline`](../forgeax-engine-render-pipeline/SKILL.md). This skill covers backends, capabilities, descriptors, and resource lifetime. `rhi-webgpu` adapts browsers; `rhi-wgpu` + `wgpu-wasm` provide the compatibility path; explicitly injected `rhi-null` supports structural tests.

For opaque ray-query foundation work, use the [reference verification guide](../../scripts/raytracing/README.md) and [native owner contract](../../packages/rhi-wgpu-native/README.md#opaque-scene-reference-transport). Keep portable compute replay, native scene re-execution, and native AS command capture distinct; only the first two currently exist.

## Color-lighting parity handoff

For backend or native readback failures, start with the [color-lighting parity status index](../../apps/parity/color-lighting/status-index.md), then inspect the [parity README](../../apps/parity/color-lighting/README.md) and the named `CaseReport` evidence. Preserve backend identity, native format, frame, size, and raw hash; capability loss is incomplete evidence, not a fallback pass.

## Mental model

RHI follows four rules (AGENTS.md RHI form rules owns the contract):

- **Spec-aligned**: descriptors match `@webgpu/types` (`^0.1.70`); `'x' in src` distinguishes absent fields from explicit undefined. Follow WebGPU descriptors.
- **Opaque handles**: brand-only `Id<T>` resources reject raw GPU field access at compile time. Module paths distinguish RHI `Buffer` from native `GPUBuffer`.
- **Math-free**: accepts POD and ArrayBuffer/Float32Array without engine-math.
- **Implementations ship together**: rhi-webgpu and rhi-wgpu share releases; createRenderer selects the runtime path using navigator.gpu rather than requiring game authors to select it.

Gate features through `device.caps.X`. Read `RhiCaps` for the field contract rather than duplicating it here.

## Core API quick reference

| Name | Package | Form | Purpose |
|:--|:--|:--|:--|
| `createRenderer(canvas, ...)` | runtime | `async fn` | Engine entry; automatically selects the RHI path through navigator.gpu. |
| `device.caps` | rhi | `RhiCaps` | Capability gates, including backendKind. |
| `RhiCaps.backendKind` | rhi | `'webgpu' \| 'wgpu-native' \| 'wgpu-webgl2' \| 'null'` | Reports the active implementation path. |
| Opaque handles | rhi | Brand-only `Id<T>`, such as Buffer/Texture | Raw GPU field access is a compile error. |
| Descriptors | rhi | `Pick<GPUXxxDescriptor, ...>` + `ExplicitUndefined<>` | Creation arguments aligned with WebGPU types. |
| `RhiErrorCode` | rhi | Closed union; read source | Structured failures; exhaustive switch without default. |

> [!IMPORTANT]
> Full handles, interfaces, and descriptor signatures live in `packages/rhi/README.md`; error members live in `packages/rhi/src/errors.ts`. Do not copy these inventories. Consumer `compilerOptions.types` must include `"@webgpu/types"`.

## Backend selection and dependencies

```mermaid
flowchart TD
  CR["createRenderer(canvas, opts?)"] -->|opts.rhi injection| NULL["rhi-null: headless no-op"]
  CR -->|navigator.gpu present| WG["rhi-webgpu: thin browser adapter"]
  CR -->|otherwise| WP["rhi-wgpu: thin TS shell"]
  WG --> RHI["engine-rhi: interface authority"]
  WP --> WASM["wgpu-wasm: one WASM artifact, wgpu 29 + naga 29"]
  WP --> RHI
  WASM --> NAGA["engine-naga: TS shell, excluded from runtime engine-shader"]
  NULL --> RHI
```

## Usage skeleton

```ts
import { createRenderer } from '@forgeax/engine-runtime';

const created = await createRenderer(canvas);
if (!created.ok) throw created.error;
const renderer = created.value;

// capability-gated: inspect() is the public POD boundary; raw devices stay
// inside the RHI/backend construction seam.
const caps = renderer.inspect().capabilities;
if (caps.backendKind === 'wgpu-native') {
  // native-only path; webgpu / wgpu-webgl2 / null take the portable branch
}
if (caps.rgba16floatRenderable) {
  // HDR render-target path available (IBL cubemap, HDR post-processing)
}
```

> Most game authors stop at createRenderer and use the material/render-pipeline skills. Direct buffer/texture creation is for backend contributions or custom passes.

## RhiNull: headless no-op backend

`@forgeax/engine-rhi-null` has no GPU/DOM dependency and supports command-structure assertions in unit tests. It is explicitly injected through Channel 1, never selected through navigator.gpu:

```ts
import type { RhiNullDevice } from '@forgeax/engine-rhi-null';
import { rhi } from '@forgeax/engine-rhi-null';
import { createRenderer } from '@forgeax/engine-runtime';

// canvas is a required positional param; RhiNull never touches the DOM, so a
// minimal stub suffices in headless CI (no `undefined` — it won't typecheck).
const canvas = { width: 1, height: 1 } as unknown as HTMLCanvasElement;
const created = await createRenderer(canvas, { rhi });
if (!created.ok) throw created.error;
const renderer = created.value;
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
if (!world.update().ok) throw new Error('World update failed');
const frame = renderer.draw({
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
});
if (!frame.ok) throw frame.error; // no-op execution, command stream submitted

// Read structural facts through renderer.inspect(). Detailed RhiNull counters
// belong to owner-local tests using the injected backend pack, not Renderer.
console.log(renderer.inspect().capabilities.backendKind); // 'null'
```

### Key semantics

- **`backendKind: 'null'`** means structural bookkeeping without a real GPU. Graph barrier handling groups it with webgpu/wgpu-webgl2, without inserted barriers.
- **Capabilities**: boolean caps are true except reserved `multiDrawIndirect`, `pushConstants`, and `textureBindingArray`; `maxColorAttachments = 8`. This maximizes structural capability coverage.
- **Shader compilation is skipped**: returns a legal ShaderModule brand. createRenderer publishes a Renderer only on a successful Result.
- **Handle bookkeeping**: each created handle is registered per device. setVertexBuffer/setBindGroup reject cross-device or destroyed handles with existing structured errors, including rhi-not-available and destroy-after-destroy.
- **Mixed-frame counters**: totalDispatchCount/totalDrawCount include direct and indirect commands. Combine with framePassNames to assert compute-before-raster order; these do not prove shader or pixel correctness.
- **No pixels**: getCurrentTexture returns a brand without GPU texture data. RhiNull cannot replace smoke/Dawn pixel readback.
- **Independent instances**: every createRenderer with injected RHI gets its own RhiNullDevice and Bookkeeper.

See `packages/rhi-null/README.md` for API, capabilities, bookkeeping, and differences from Vitest mocks.

## Vertex layout aliases: multi-UV clamp-to-last

> [!IMPORTANT]
> WebGPU allows multiple vertex attributes to share a buffer offset with distinct shaderLocation values. ForgeaX uses this for clamp-to-last: when a mesh has n UV sets and a shader declares m>n, attributes in `[n,m)` point to set n-1's offset on the actual draw path.

### WebGPU behavior

ValidateVertexAttribute has no byte-range overlap check; shared offsets are intentional and legal when shaderLocation values differ. setBindGroup overlap restrictions do not apply to vertex attributes. This supports ForgeaX's D-1 decision.

```ts
// Legal: vertex attributes share a buffer offset.
{
  arrayStride: 80,
  attributes: [
    { shaderLocation: 6, offset: 72, format: 'float32x2' },  // uv1: actual data.
    { shaderLocation: 7, offset: 72, format: 'float32x2' },  // uv2 aliases uv1.
    { shaderLocation: 8, offset: 72, format: 'float32x2' },  // uv3 aliases uv1.
  ]
}
```

> Existing paths use one interleaved stream via `setVertexBuffer(0, ...)`; aliases stay in buffer 0.

### Clamp-to-last bindings from deriveVertexBufferLayout

| Mesh UV sets n | Shader sets m | Binding behavior |
|:--|:--|:--|
| n > 0, m <= n | One-to-one | Shader sets 0..m-1 use actual offsets. |
| n > 0, m > n | Clamp-to-last | Sets 0..n-1 use actual offsets; remaining shader locations share set n-1's offset. |
| n = 0 | Zero buffer | Allocate an 8-byte zero default vec2 buffer; all UV locations use offset 0. |

> All combinations are silent, matching the agreed UE semantics. PSO creation succeeds for mesh n=0..8 and shader m=1..8 without unsupported-vertex-layout errors.

### deriveVertexBufferLayout rules

`deriveVertexBufferLayout(map, { shaderUvSetCount? })` is the single vertex-layout derivation entry:

1. Canonical offset order: position / normal / uv / tangent / skinIndex / skinWeight / uv1 / uv2 / uv3 / uv4 / uv5 / uv6 / uv7.
2. Each key derives format and size from ATTRIBUTE_FORMAT_MAP and ATTRIBUTE_BYTE_STRIDE; CANONICAL_KEYS.indexOf(key) gives shaderLocation.
3. countMeshUvSets(map) scans UV_KEYS to derive the actual set count from defined UV keys.
4. When shaderUvSetCount exceeds meshUvSetCount, emitAliasEntries adds entries for `[n,m)` with the UV key's shaderLocation, the last set's aliasOffset, and the UV format.
5. With no UVs (`fromIndex=0`), append 8 bytes of stride and an empty first UV entry backed by a zero vec2f.

> Existing locations 0..5 keep offsets position=0 / normal=12 / uv=24 / tangent=32 / skinIndex=48 / skinWeight=56. uv1..uv7 follow at 72/80/...; glTF and FBX interleaving use the same canonical order.

### PSO cache keys

cacheKeyOf already hashes sorted vertex-layout keys and byteLength. Added uv1..uv7 keys distinguish UV layouts naturally; do not add another variant axis or explicit uvSetCount cache field (D-5).

### RhiNull interaction

RhiNull setVertexBuffer tracks buffer brands without real stride/attribute validation. deriveVertexBufferLayout still emits aliases; its command ledger supports structural layout assertions.

## Video capability: general and high-performance paths

Video upload has a general copyExternalImageToTexture path and a potential GPUExternalTexture/texture_external path. The engine currently uses the general RHI queue method with matching webgpu/wgpu-native semantics. The high-performance path exposes capability probing only; importExternalTexture is not exposed.

`probeVideoHighPerfUpload` in graphics-extras checks these paths during record using existing RhiCaps.backendKind. It adds no RHI API; upload consumes copyExternalImageToTexture:

```ts
// RhiCaps.backendKind is the capability probe anchor:
//   'webgpu'      -> general copyExternalImageToTexture available (browser)
//   'wgpu-native' -> general copyExternalImageToTexture available (native)
//   'wgpu-webgl2' -> copyExternalImageToTexture MAY be absent (WebGL2 subset)
//
// GPUExternalTexture high-perf path requires BOTH 'webgpu' backend AND an
// importExternalTexture RHI entry is absent; the capability is always false.
```

### Neither capability available: video-upload-unsupported

When neither upload path is available, such as Dawn without a host HTMLVideoElement and without the high-performance path, the real per-frame record path fires VideoUploadUnsupportedError through errorRegistry. Upload and failure use the same renderer.draw path, without a separate video system. Consume the renderer.subscribe error event:

```ts
renderer.subscribe((event) => {
  if (event.kind !== 'error') return;
  const err = event.error;
  // err.code is a member of the closed RuntimeErrorCode union; switch exhaustively.
  if (err.code === 'video-upload-unsupported') {
    //   .code === 'video-upload-unsupported'
    //   .hint  — actionable recovery (static texture / switch backend)
    // Consume via property access, NOT string parsing (charter P3)
  }
});
```

`video-upload-unsupported` is an add-only minor RuntimeErrorCode member in `packages/runtime/src/errors.ts`; consume it through exhaustive switch.

### Capability boundaries

| Boundary | Meaning |
|:--|:--|
| Dawn cannot render video | No HTMLVideoElement/VideoFrame source exists despite copyExternalImageToTexture support; pixel acceptance requires browser e2e. |
| High-performance path is unimplemented | Explicit GPUExternalTexture probing falls back to the general path; no new RHI method, texture_external MaterialParamType, or external-sampling WGSL. |
| General upload matches across backends | webgpu/wgpu-native upload frames as ordinary texture_2d; shaders and material BGL remain unchanged. |
| No audio track handling | RHI does not own video audio; that work is separate. |

## Resource release: destroyBuffer / destroyTexture

RhiDevice.destroyBuffer(buf) and destroyTexture(tex) pair with resource creation and behave symmetrically across backends.

### Normal path

```ts
// GPU handles remain owner-local. Public Renderer exposes capability facts only;
// resource creation belongs to a RenderFeature plan or an owner-local test.
console.log(renderer.inspect().capabilities.backendKind);
```

RhiDevice autocomplete exposes createBuffer/destroyBuffer together, making release discoverable at the same entry (charter F1).

### Signatures and errors

| Method | Signature | Result |
|:--|:--|:--|
| `RhiDevice.destroyBuffer` | `(buf: Buffer) => Result<void, RhiError>` | `ok(undefined)` on success. |
| `RhiDevice.destroyTexture` | `(tex: Texture) => Result<void, RhiError>` | Same. |

Destroying the same resource twice fails immediately:

```ts
const r1 = device.destroyBuffer(buf); // ok
const r2 = device.destroyBuffer(buf);
// r2.ok === false
switch (r2.error.code) {
  case 'destroy-after-destroy':
    // AI user self-detects "I already released this"
    // hint: "object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy"
    break;
}
```

`destroy-after-destroy` is an add-only minor RhiErrorCode member. Both backends use RHI-shim bookkeeping independent of the WASM boundary.

`rhi-descriptor-invalid` is another add-only minor RhiErrorCode member. Classify failures as follows:

- `rhi-descriptor-invalid`: malformed caller descriptor data. Rust wasm_bindgen(catch) returns an error with stable prefix `[wgpu-wasm] failed to parse`; TS wrap() classifies it.
- `webgpu-runtime-error`: a valid descriptor is rejected by runtime conditions, such as binding limits.

`.hint` identifies fields such as fragment.targets[0]; `.code` supports exhaustive handling. Authority: `packages/rhi/src/errors.ts`.

### Runtime GpuResource

Runtime exposes GpuBuffer/GpuTexture and `type GpuResource = GpuBuffer | GpuTexture`. Wrappers expose boolean isDestroyed and `destroy(): Result<void, RhiError>`, forwarding to RHI resource destruction with the same repeat-destroy failure.

Renderer.dispose() releases wrappers through gpuStore.destroyAll, graph.drain, instance-buffer clearing, IBL cache clearing, context.unconfigure, and listener cleanup; repeated dispose is idempotent. App.stop() only stops frame scheduling; App.dispose() also disposes the renderer.

### Chromium adapter pool caveat

> [!CAUTION]
> Do not call device.destroy() on public paths: Chromium may fail to reacquire an adapter after GPUDevice.destroy(). Public APIs expose resource destruction only. Low-level diagnostics can use `_internal_getRawDevice(device)` to reach raw device destruction.

GpuResource uses one destruction owner without refcounts or shared ownership.

## Pitfalls

- **Raw GPU access through handles**: opaque brands reject internal GPU field access at compile time. Use RHI methods.
- **Assuming native features**: capabilities differ by backend; gate through device.caps before use.
- **Missing WebGPU types**: consumer compilerOptions.types must include @webgpu/types for descriptor alignment.
- **Importing naga into runtime shader**: physical-isolation grep gates reject it; naga belongs only to the build-time shader-compiler chain.
- **Repeated resource destruction**: destroy-after-destroy is intentional. Handle it exhaustively or check the runtime wrapper's isDestroyed before calling when idempotence is needed.
- **Destroying the whole device**: public paths avoid Chromium adapter-pool poisoning. Use resource destruction; raw device diagnostics require the internal escape hatch.
- **Silent black output/GPU loss after wgpu-wasm Channel 3 submit**: historically submit returned void without wasm_bindgen(catch), and error-sink validation failures never reached JS. The R5 M4 repair installs device.on_uncaptured_error, stores a per-queue last error, and makes submit return Result. It reads/clears the slot after submission and forwards `[rhi-code:<code>]`; TS queue.ts maps this to existing queueSubmitFailed/webgpuRuntimeError. Submission validation now reports through onError while the instance remains usable for the next frame.

## Deferred membership timing

Render is the sole timing owner. The opaque pass-descriptor
`timestampWrites` -> `resolveQuerySet` -> `mapAsync` seam is used only around
real render/compute work. A backend publishes
`caps.timestampQuery` plus its positive `timestampPeriodNanoseconds` when
trustworthy; RhiNull and the current wgpu WebGL2 backend publish `false` and
`null`. The obsolete command-encoder `writeTimestamp` entry is not part of the
RHI surface because current Dawn rejects it even when the feature is
advertised. Do not synthesize ticks, add a profiler, or move the Render reason
union into RHI. `feature-not-enabled` remains an RHI detail and is translated
to Render's `timestamp-query-unsupported` refusal at that boundary.

The same boundary applies to generic GPU pass timing: RHI supplies only the
capability primitive and opaque handles. Render owns admission, pass identity,
receipt binding, parsing, retention, status, and recovery; benchmark validation
is a separate offline Render concern. `RhiNull` refusal or exact-zero command
evidence cannot be promoted to a real GPU tick or duration, and membership
timing is not generic accepted evidence.

## Further reading

- Handles, interfaces, descriptors, and ExplicitUndefined bridging: `packages/rhi/README.md`.
- Closed RhiErrorCode authority: `packages/rhi/src/errors.ts`.
- Capability layers and RhiCaps fields: `packages/rhi/README.md` and `packages/rhi/src/index.ts`.
- RHI form rules (spec-aligned / opaque / math-free / dual-impl / single-wasm / naming): AGENTS.md §RHI form rules
- Backend/WASM implementations: `packages/rhi-webgpu/src/`, `packages/rhi-wgpu/src/`, `packages/wgpu-wasm/`; build instructions: CONTRIBUTING.md, Rust toolchain.
- RhiNull API, capabilities, bookkeeping, and mock distinction: `packages/rhi-null/README.md`; implementations: `packages/rhi-null/src/`.
- Declarative RHI-pure graph: [`forgeax-engine-render-pipeline`](../forgeax-engine-render-pipeline/SKILL.md); RenderGraphErrorCode: `packages/render-graph/src/errors.ts`.
- createBindGroupLayout accepts variable-length entries. Material group-1 layouts derive from each shader's paramSchema upstream; RHI only creates the assembled descriptor. Sampler-first layout rules: [`forgeax-engine-shader`](../forgeax-engine-shader/SKILL.md).
- Rendering/RHI diagnosis: [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.md), then [`forgeax-engine-debug`](../forgeax-engine-debug/SKILL.md) for owner-specific symptoms.
