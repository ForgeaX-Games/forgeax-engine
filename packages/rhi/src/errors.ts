// @forgeax/engine-rhi/src/errors - RhiError + closed RhiErrorCode union + Result<T, E>.
//
// Shape:
// - RhiErrorCode = closed union 20 members (charter proposition 4: closed-union
//   exhaustive switch needs no default fallback; tsc strict mode guards
//   completeness). Extended from 6 to 10 in feat-20260508-rhi-surface-completion
//   w7 (D-S3): added 'command-encoder-finished' / 'render-pass-not-ended' /
//   'queue-submit-failed' / 'queue-write-buffer-out-of-bounds'.
//   Extended from 10 to 14 in feat-20260509-ecs-render-bridge-mvp w6 (D-S7):
//   added 'render-system-no-camera' / 'render-system-multi-camera' /
//   'render-system-multi-light' / 'asset-not-registered'.
//   Extended from 14 to 17 in feat-20260511-rhi-spec-realign-aggressive w6
//   (D-P4 + R-02 §2.1 W3C spec 22.2 subtypes): added 'device-lost' / 'oom' /
//   'internal-error' so the onError fan-out can disambiguate spec error
//   subclasses without falling back to the bucket 'webgpu-runtime-error'.
//   Extended from 17 to 18 in feat-20260511-asset-system-v1 w4
//   (D-P2 + requirements §9 row 8 + AC-04 + AC-21): added
//   'hierarchy-broken' for `propagateTransforms` stale ChildOf ref fail-fast
//   (ChildOf component references a destroyed entity); same
//   render-system / schedule semantic domain as
//   'render-system-multi-camera' / 'render-system-no-camera'. Minor add-only
//   per AGENTS.md evolution contract (no reorder / rename / deprecate).
//   Extended from 18 to 19 in feat-20260612-rhi-destroy-renderer-dispose-gpu-
//   lifecycle M1 (D-6 + D-7 + AC-02 / AC-03): added 'destroy-after-destroy'
//   for second `destroyBuffer` / `destroyTexture` on the same handle. The
//   shim layer (rhi-webgpu + rhi-wgpu) tracks per-handle `destroyed: boolean`
//   in WeakMap-backed meta and fail-fasts the second call rather than
//   forwarding it to the underlying GPU (research F-1 wgpu wasm `destroy()`
//   is idempotent void; F-8 WebGPU spec is also idempotent void; D-7 prefers
//   fail-fast over silent idempotency because double-destroy is almost always
//   a lifecycle bug). Minor add-only per AGENTS.md evolution contract.
//   Extended from 19 to 20 in feat-20260619-wasm-fault-isolation M3 w7:
//   added 'rhi-descriptor-invalid' for `createRenderPipeline` (and other
//   create* entries) descriptor parse failures surfaced through the wgpu-wasm
//   backend (Rust `#[wasm_bindgen(catch)]` Err). The prefix-based
//   classification (D-1 / D-2) routes wasm exceptions with the stable marker
//   `[wgpu-wasm] failed to parse` to this code; exceptions without the prefix
//   remain in 'webgpu-runtime-error'. Semantics: descriptor parse failure =
//   caller bug (malformed descriptor data passed from TS), distinct from
//   'webgpu-runtime-error' = runtime condition (valid descriptor rejected by
//   wgpu backend). Minor add-only per AGENTS.md evolution contract.
// - RhiError class has readonly .code / .expected / .hint three-field surface
//   (AGENTS.md "Errors are structured" / D-5); the 'shader-compile-failed' path
//   exposes .detail = RhiShaderCompileDetail (compilerMessages array);
//   the 'asset-not-registered' path exposes .detail = RhiAssetNotRegisteredDetail
//   ({ assetHandle: number }, D-S6); the 'webgpu-runtime-error' path optionally
//   exposes .detail = RhiWebgpuRuntimeDetail ({ error: RhiError | fallback }, D-S8) for
//   RenderSystem internal exception fan-out; the 'limit-exceeded' path
//   exposes .detail = LimitExceededDetail ({ maxStorageBufferBindingSize,
//   requestedBytes }, feat-20260513-instanced-mesh M5 reshape from legacy
//   { renderableCount, limit }); the other 15 paths leave
//   .detail = undefined per charter proposition 4 baseline.
// - Result<T, E> = binary tag union ('ok' / 'err'), per AGENTS.md "Errors are
//   structured" convention.
//
// Related: requirements AC AC-10 + MVP-1.7 + AC-RSC-07 + hard-constraint 8 +
//          AI User Affordances; plan-strategy 2 S-6 (types/rhi single source) +
//          7.3 error-info table; plan-decisions OQ-P2 (forward all 6 fields of
//          GPUCompilationMessage); D-S3 (4 command/queue members) + D-S6 / D-S7
//          / D-S8 (4 RenderSystem / AssetRegistry members + .detail structure).

/// <reference types="@webgpu/types" />

/**
 * Closed RhiErrorCode union. `switch` exhaustive checks need no default
 * fallback - tsc strict mode guards union completeness (charter proposition 4
 * + proposition 3: machine-readable union > prose).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'adapter-unavailable'` | `navigator.gpu.requestAdapter()` returned null (research F-5 single null channel). |
 * | `'feature-not-enabled'` | the caller used a feature absent from `device.features`. |
 * | `'limit-exceeded'` | input value exceeded `device.limits.<name>`. |
 * | `'shader-compile-failed'` | WGSL / SPIR-V compile failed; details on `RhiError.detail.compilerMessages`. |
 * | `'rhi-not-available'` | placeholder for unimplemented entry points (e.g. future `RhiDevice.destroy`, `executeBundles` / `beginOcclusionQuery` / `endOcclusionQuery` placeholder methods); also reserved as device.lost reason='destroyed' / real-adapter null sub-classification (R1 fallback / R10). AI users read `.code === 'rhi-not-available'` to detect "not implemented in this closure" and follow `.expected` / `.hint`. |
 * | `'webgpu-runtime-error'` | feat-20260508-verify-gpu-smoke-gate K-9 sixth member: silent-skip fix fan-out across two channels surfaces WebGPU runtime exceptions (`context.configure` / `getCurrentTexture` / `queue.submit` catch sites). AI users subscribe via `Renderer.onError(cb)` - `.code === 'webgpu-runtime-error'` signals a backend-internal exception (charter proposition 4 explicit failure: no more silent skip). |
 * | `'command-encoder-finished'` | `encoder.beginRenderPass(...)` / `encoder.copyXxx(...)` / `encoder.finish(...)` after a prior `finish()`. spec anchor: W3C WebGPU 22 GPUCommandEncoder lifecycle / [MDN GPUCommandEncoder](https://developer.mozilla.org/docs/Web/API/GPUCommandEncoder). `.expected` / `.hint` template: `expected: 'command encoder must not be finished before recording new commands'` / `hint: 'create a new command encoder via device.createCommandEncoder() for each frame; do not reuse a finished encoder'` (plan-strategy 2 D-S3). |
 * | `'render-pass-not-ended'` | a second `encoder.beginRenderPass(...)` while the previous pass is unfinished, or `encoder.finish()` while an active pass is still recording. spec anchor: W3C WebGPU 22.7 Render pass / [MDN beginRenderPass](https://developer.mozilla.org/docs/Web/API/GPUCommandEncoder/beginRenderPass). `.expected` / `.hint` template: `expected: 'previous render pass must be ended before beginning a new pass or finishing the encoder'` / `hint: 'call pass.end() before beginRenderPass() or encoder.finish()'` (plan-strategy 2 D-S3). |
 * | `'queue-submit-failed'` | `queue.submit([buf])` real-GPU submission failed (destroyed buffer/pipeline; validation error forwarded via GPUValidationError); explicit disambiguation against `'rhi-not-available'` (device.lost sub-class). spec anchor: W3C WebGPU 23 Queue / [MDN GPUQueue.submit](https://developer.mozilla.org/docs/Web/API/GPUQueue/submit). `.expected` / `.hint` template: `expected: 'command buffer references must be valid at submit time (not destroyed; not from a different device)'` / `hint: 'check if any referenced buffer / pipeline / texture has been destroyed before submit'` (plan-strategy 2 D-S3). |
 * | `'queue-write-buffer-out-of-bounds'` | `writeBuffer(buf, offset, data)` offset/size out of bounds (explicit disambiguation against `'limit-exceeded'`: the latter is static device.limits, this one is dynamic per-buffer bounds). spec anchor: W3C WebGPU 23.2 writeBuffer / [MDN GPUQueue.writeBuffer](https://developer.mozilla.org/docs/Web/API/GPUQueue/writeBuffer). `.expected` / `.hint` template: `expected: 'writeBuffer offset + data.byteLength must be <= buffer.size; offset must be 4-byte aligned'` / `hint: 'verify offset alignment and bounds: offset (got X) + data.byteLength (got Y) must be <= buffer.size (got Z)'` (plan-strategy 2 D-S3). |
 * | `'render-system-no-camera'` | RenderSystem (engine internal phase) found 0 entity matching `(Transform + Camera)` archetype. The frame is skipped (no GPU commands recorded). Distinct from `'rhi-not-available'` because the RHI surface itself is functional - it is the ECS world that does not yet have a Camera entity. `.expected` / `.hint` template: `expected: 'world has at least one entity with Transform + Camera'` / `hint: 'world.spawn({ component: Transform, data: { posX, posY, posZ, quatX, quatY, quatZ, quatW, scaleX, scaleY, scaleZ } }, { component: Camera, data: { fov, aspect, near, far } }) before renderer.draw(world)'` (plan-strategy 2 D-S7). |
 * | `'render-system-multi-camera'` | RenderSystem found N>1 entities matching `(Transform + Camera)`. The first archetype iteration hit is rendered; subsequent Cameras are ignored. AI users add this case to their `switch (err.code)` recovery to deduplicate Camera entities ahead of the next frame. `.expected` / `.hint` template: `expected: 'world has exactly one entity with Transform + Camera'` / `hint: 'remove duplicate Camera entities or wait for feat-future-multi-viewport'` (plan-strategy 2 D-S7). |
 * | `'render-system-multi-light'` | RenderSystem found cap-exceeding light entities. `'render-system-multi-light'` covers DirectionalLight N>1 + PointLight/SpotLight N>4 first-slice-cap exceedance (feat-20260519 minor reword). Like multi-camera the first iteration hit wins per bucket; surplus entities are ignored. `.expected` / `.hint` template: `expected: 'DirectionalLight: at most 1 entity; PointLight / SpotLight: at most 4 entities each (first-slice cap)'` / `hint: 'remove duplicate entities, or wait for todo-125 feat-future-multi-light-pack which introduces cluster (tile/slot/index) for N>4'`. `.detail = { type: 'directional' | 'point' | 'spot', got: number }` discriminates the offending bucket (feat-20260519 D-S3 b). |
 * | `'asset-not-registered'` | A `MeshFilter.assetHandle` is not in `engine.assets` (`AssetRegistry.get(handle)` returned undefined). The single entity is skipped (other entities continue rendering; charter proposition 9 graceful degradation). `.detail = { assetHandle: number }` carries the offending handle so AI users can locate the misconfigured `MeshFilter`. `.expected` / `.hint` template: `expected: 'MeshFilter.assetHandle in AssetRegistry'` / `hint: 'use HANDLE_CUBE / HANDLE_TRIANGLE imports; custom mesh register path: feat-future-asset-system'` (plan-strategy 2 D-S7). |
 * | `'device-lost'` | The underlying `GPUDevice.lost` Promise resolved (spec 22.1 device lost flow). The browser irrecoverably released the device (driver crash / power saver / extension swap). `.expected` / `.hint` template: `expected: 'GPUDevice.lost Promise must remain unsettled while the forgeax renderer is active'` / `hint: 'reload the page or rebuild the Renderer via createRenderer({...}); subscribe via renderer.onError to react before this event surfaces'` (@spec-anchor [W3C WebGPU §22.1 device lost](https://www.w3.org/TR/webgpu/#device-lost) / plan-strategy D-P4). |
 * | `'oom'` | spec §22.2 GPUOutOfMemoryError subtype — `device.createBuffer({ size: hugeSize })` or texture allocations exceeded available GPU memory; the operation's resource is invalid. `.expected` / `.hint` template: `expected: 'requested allocation must fit within remaining GPU memory budget'` / `hint: 'release prior buffers/textures (.destroy()), shrink the descriptor size, or split work across submissions; check device.limits.maxBufferSize'` (@spec-anchor [W3C WebGPU §22.2 GPUOutOfMemoryError](https://www.w3.org/TR/webgpu/#gpu-out-of-memory-error) / plan-strategy D-P4). |
 * | `'internal-error'` | spec §22.2 GPUInternalError subtype — driver bug / unrecoverable internal failure that is neither validation nor OOM. `.expected` / `.hint` template: `expected: 'no driver-internal failure during operation dispatch'` / `hint: 'reproduce with a stable adapter; file an issue with @forgeax/engine-runtime + the underlying GPU.message; if the adapter is persistently unstable, display an unsupported-environment message'` (@spec-anchor [W3C WebGPU §22.2 GPUInternalError](https://www.w3.org/TR/webgpu/#gpu-internal-error) / plan-strategy D-P4). |
 * | `'hierarchy-broken'` | `propagateTransforms` system (ECS `'pre-render'` schedule) encountered a `ChildOf` component whose referenced parent entity no longer exists (entity destroyed or ref never registered). The single entity's subtree is skipped (other entities continue; charter proposition 9 graceful degradation + architecture-principles #5 Fail Fast). `.expected` / `.hint` template: `expected: 'ChildOf component references a live entity in the world'` / `hint: 'remove the stale ChildOf via world.removeComponent(entity, ChildOf) before destroying the referenced ancestor, or call engine.assets.inspect() to audit hierarchy'` (feat-20260511-asset-system-v1 D-P2 + requirements §9 row 8). Minor add-only per AGENTS.md evolution contract; `'render-system-*'` / `'hierarchy-*'` share the render-system / schedule semantic domain. |
 * | `'destroy-after-destroy'` | A `RhiDevice.destroyBuffer(buf)` / `RhiDevice.destroyTexture(tex)` call observed the same handle had already been destroyed (per-handle `destroyed: boolean` bookkeeping in the shim layer). The forgeax form prefers fail-fast over the spec idempotent-void path (W3C WebGPU §22 / wgpu wasm both treat double-destroy as a no-op): double-destroy is almost always a lifecycle bug — caching a stale handle, a forgotten registry slot, a race between dispose paths — and surfacing it is more useful than swallowing it (plan-strategy D-7). `.expected` / `.hint` template: `expected: 'GPU buffer/texture handle has not been destroyed yet'` / `hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy'` (feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle D-6 + D-7). Minor add-only per AGENTS.md evolution contract. |
 * | `'rhi-descriptor-invalid'` | A `createRenderPipeline` (or other create* entry) descriptor failed to parse in the wgpu-wasm backend (Rust `#[wasm_bindgen(catch)]` Err with the stable prefix `[wgpu-wasm] failed to parse`). The descriptor data shape passed from TS was malformed — this is a caller bug (the caller passed descriptor data that the wasm deserializer rejected), not a runtime condition. Differs from `'webgpu-runtime-error'`: the latter is a valid descriptor rejected by the wgpu runtime (e.g. binding count exceeds limits); this code means the descriptor never reached the runtime because its shape was unparseable. `.hint` carries the parse-error message including the failing field index (e.g. `fragment.targets[0]`) for human triage. `.expected` / `.hint` template: `expected: 'caller passed well-formed descriptor data matching the wgpu-wasm serialization contract'` / `hint: 'check the descriptor field named in the error message for type mismatch or missing required fields'` (feat-20260619-wasm-fault-isolation D-1/D-2/D-8). Minor add-only per AGENTS.md evolution contract. |
 *
 * @example AI-user exhaustive switch on the 4 command/queue members (no default fallback)
 * ```ts
 * import type { RhiError, RhiErrorCode } from '@forgeax/engine-rhi';
 *
 * function recover(code: RhiErrorCode): string {
 *   switch (code) {
 *     // ... 6 baseline members elided ...
 *     case 'command-encoder-finished':       return 'recreate encoder via device.createCommandEncoder()';
 *     case 'render-pass-not-ended':          return 'call pass.end() before next beginRenderPass()';
 *     case 'queue-submit-failed':            return 'audit buffer/pipeline lifetimes before submit';
 *     case 'queue-write-buffer-out-of-bounds': return 'realign offset and re-check buffer.size';
 *     default:                               return 'baseline path';
 *   }
 * }
 * ```
 */
export type RhiErrorCode =
  | 'adapter-unavailable'
  | 'feature-not-enabled'
  | 'limit-exceeded'
  | 'shader-compile-failed'
  | 'rhi-not-available'
  | 'webgpu-runtime-error'
  | 'command-encoder-finished'
  | 'render-pass-not-ended'
  | 'queue-submit-failed'
  | 'queue-write-buffer-out-of-bounds'
  | 'render-system-no-camera'
  | 'render-system-multi-camera'
  | 'render-system-multi-light'
  | 'asset-not-registered'
  | 'device-lost'
  | 'oom'
  | 'internal-error'
  | 'hierarchy-broken'
  | 'destroy-after-destroy'
  | 'rhi-descriptor-invalid';

/**
 * Detail structure exclusive to the `shader-compile-failed` path.
 *
 * `compilerMessages` directly forwards the 6 standardized fields of
 * `GPUCompilationMessage` from `@webgpu/types` v0.1.69 (`message` / `type` /
 * `lineNum` / `linePos` / `offset` / `length`); research F-3 finding;
 * plan-decisions OQ-P2 locks full-field forwarding.
 *
 * @see {@link GPUCompilationMessage}
 */
export interface RhiShaderCompileDetail {
  readonly compilerMessages: readonly GPUCompilationMessage[];
}

/**
 * Detail structure exclusive to the `asset-not-registered` path (D-S6).
 *
 * `assetHandle` carries the offending u32 handle the caller passed via
 * `MeshFilter.assetHandle`; AI users access it through property access
 * (`err.detail.assetHandle`) rather than parsing the message string
 * (charter proposition 4 + F-3 contract surface).
 */
export interface RhiAssetNotRegisteredDetail {
  readonly assetHandle: number;
}

/**
 * Detail structure exclusive to the `webgpu-runtime-error` path (D-S8).
 *
 * `error` carries the underlying exception object so AI users can inspect the
 * root cause (`.code` / `.expected` / `.hint` for `RhiError` paths, or
 * `.code` + `.message` for non-RhiError falls) without parsing the
 * RhiError.message field. Optional: the K-9 silent-skip fan-out root path
 * may emit `webgpu-runtime-error` without `.detail` when the underlying
 * exception is unavailable.
 *
 * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M4 / T-M4-02:
 * `error` field type widened from `string` to `RhiError | { code: string;
 * message: string }` so downstream `switch (err.code)` handlers can narrow
 * the inner error (`.code` / `.expected` / `.hint`) without an `as` cast.
 */
export interface RhiWebgpuRuntimeDetail {
  readonly error: RhiError | { code: string; message: string; name?: string };
}

/**
 * Detail structure exclusive to the `limit-exceeded` path.
 *
 * `maxStorageBufferBindingSize` carries the device-reported storage cap
 * (`device.limits.maxStorageBufferBindingSize`); `requestedBytes`
 * carries the byte count the caller attempted to allocate. AI users
 * access these through typed property access (`err.detail.maxStorageBufferBindingSize`
 * / `err.detail.requestedBytes`) rather than parsing the message string
 * — charter proposition 4 structured-error consumption path; `err.hint`
 * is for human eyeballs only.
 *
 * Single live emit point: the RenderSystem record stage per-entity
 * instance buffer upload path
 * (`packages/runtime/src/render-system-record.ts`). The 18-member
 * `RhiErrorCode` union is unchanged (`'limit-exceeded'` discriminant
 * preserved); evolution major rename + replace of the discriminated
 * `detail` shape per AGENTS.md Change stance + plan-strategy D-3.
 *
 * Migration history:
 *   - feat-20260513-instanced-mesh M5: detail reshape from
 *     `{ renderableCount, limit }` to `{ maxStorageBufferBindingSize,
 *     requestedBytes }`. Emit point at the time was
 *     `AssetRegistry.createInstancedBuffer`.
 *   - feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15:
 *     `AssetRegistry.createInstancedBuffer` deleted alongside the
 *     `InstancedBufferAsset` POD; emit point migrated to the record
 *     stage upload path (`requestedBytes` now equals
 *     `Instances.transforms.byteLength` per Instances-bearing entity).
 */
export interface LimitExceededDetail {
  readonly maxStorageBufferBindingSize: number;
  readonly requestedBytes: number;
}

/**
 * Detail structure exclusive to the `'render-system-multi-light'` path
 * (feat-20260519-light-casters-point-spot-pbr M3 / w20 + plan-strategy
 * section 8 (3) (b)).
 *
 * Emitted by the RenderSystem record stage when first-slice cap exceedance
 * is detected: `type` discriminates the offending bucket
 * (`'directional'` for N>1 / `'point'` or `'spot'` for N>4); `got`
 * carries the observed entity count so AI users can branch via property
 * access (`err.detail.type === 'point' && err.detail.got > 4`) rather
 * than parsing the message string (charter proposition 4 + F-3 contract
 * surface).
 *
 * Single live emit point: the RenderSystem record stage three-bucket
 * fail-fast (`packages/runtime/src/render-system-record.ts`). Minor
 * additive evolution per AGENTS.md error model evolution contract.
 */
export interface RhiMultiLightDetail {
  readonly type: 'directional' | 'point' | 'spot';
  readonly got: number;
}

/**
 * Tagged union of `.detail` shapes carried by structured errors.
 *
 * Entries:
 *   - `RhiShaderCompileDetail` (carries `compilerMessages`) - emitted on the
 *     `'shader-compile-failed'` path.
 *   - `RhiAssetNotRegisteredDetail` (carries `assetHandle`) - emitted on the
 *     `'asset-not-registered'` path (D-S6).
 *   - `RhiWebgpuRuntimeDetail` (carries `error: RhiError | { code, message }`) - optionally emitted
 *     on the `'webgpu-runtime-error'` path when a captured `Error.message` is
 *     available (D-S8).
 *   - `LimitExceededDetail` (carries `maxStorageBufferBindingSize` +
 *     `requestedBytes`) - emitted on the `'limit-exceeded'` path when
 *     the RenderSystem record stage's per-entity Instances upload
 *     exceeds `device.limits.maxStorageBufferBindingSize`
 *     (feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15;
 *     emit point migrated from the deleted
 *     `AssetRegistry.createInstancedBuffer` factory).
 *
 * The other 15 paths leave `.detail = undefined` (charter proposition 4
 * baseline).
 */
export type RhiErrorDetail =
  | RhiShaderCompileDetail
  | RhiAssetNotRegisteredDetail
  | RhiWebgpuRuntimeDetail
  | LimitExceededDetail
  | RhiMultiLightDetail;

/**
 * Structured RHI error.
 *
 * Three readonly fields aligned with AGENTS.md "Errors are structured":
 * - `.code` - closed union member (L1 key signal).
 * - `.expected` - expected-state description (L2 detail).
 * - `.hint` - actionable recovery guidance (L2 detail; charter proposition 3:
 *   machine-readable hint > prose).
 *
 * `.detail` is populated on four paths:
 *   - `code === 'shader-compile-failed'` -> `RhiShaderCompileDetail`
 *   - `code === 'asset-not-registered'`  -> `RhiAssetNotRegisteredDetail`
 *   - `code === 'webgpu-runtime-error'`  -> `RhiWebgpuRuntimeDetail` (optional)
 *   - `code === 'limit-exceeded'`        -> `LimitExceededDetail`
 *     (feat-20260513-instanced-mesh M5 reshape; carries
 *     `maxStorageBufferBindingSize` + `requestedBytes`)
 *
 * The other 15 paths leave `.detail = undefined` (charter proposition 4
 * baseline).
 *
 * Note: `RhiErrorDetail` is currently a flat tagged union without a
 * `code` discriminant field on each variant; AI users perform typed
 * narrowing via outer `switch (err.code)` then a one-time `as` cast on
 * `err.detail` per the documented variant. Full discriminated-union
 * refactor (each variant carrying its own `code` literal field) is left
 * to `feat-future-rhi-error-detail-discriminant` spinoff.
 */
export class RhiError extends Error {
  readonly code: RhiErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RhiErrorDetail | undefined;

  constructor(args: {
    code: RhiErrorCode;
    expected: string;
    hint: string;
    detail?: RhiErrorDetail | undefined;
  }) {
    super(`[RhiError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'RhiError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

// Result<T, E> + ok / err live in `@forgeax/engine-types` (tweak-20260612-result-
// into-types). They were duplicated here ("byte-for-byte aligned" by prose) and
// in packages/ecs/src/result.ts; SSOT consolidated upstream. The barrel here
// re-exports them so existing `import { err, ok, Result, ResultOk, ResultErr }
// from '@forgeax/engine-rhi'` consumers stay unchanged.
export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-types';
