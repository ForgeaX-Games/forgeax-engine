// @forgeax/engine-runtime — Renderer public-surface types + class.
//
// K-4 contract:
//   - `Renderer.backend` is an opaque marker (`'webgpu'`); callers never
//     branch on the underlying backend type, only on this string.
//   - `Renderer.draw([world], { owner: 0 })` runs one frame for the supplied worlds.
//   - `Renderer.onLost(cb)` registers a notify-only listener for device loss.
//   - `Renderer.onError(cb)` registers a listener for RHI creation-time errors.
//   - `Renderer.dispose()` releases GPU resources + detaches all listeners.
//
// AC-15 source-level guarantee: this file does NOT touch `window` or
// `document` at import time; canvas is supplied by the caller.

import type { AssetRegistry, AssetRuntimeError } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import type { Result, RhiDevice, RhiError, RhiInstance } from '@forgeax/engine-rhi';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import type { EngineMetrics } from './engine-metrics';
import type { RecoverError } from './errors/recover';
import type { RenderError } from './errors/render';
import type { SkinError } from './errors/skin';
import type { GpuResourceStore } from './gpu-resource-store';
import type { PipelineError } from './pipeline-errors';
import type { PostProcessError } from './post-process-errors';
import type { RenderPipeline } from './render-pipeline';

/** Backend marker — single-element union preserved for future extensibility (D-2). */
export type RendererBackend = 'webgpu';

/**
 * `renderer.draw(worlds, options)` owner options
 * (feat-20260709-editor-world-partition M1 / w6, plan-strategy §2 D-3).
 *
 * The single `owner` index that previously served BOTH the surfaced cameras
 * and the singleton render resources (skylight / skybox / postProcessParams) is
 * split into two independent indices:
 *   - `cameraOwner`   — the world whose cameras are surfaced.
 *   - `resourceOwner` — the world whose skylight / skybox / postProcessParams
 *                       are surfaced.
 *
 * Two accepted forms:
 *   - `{ owner }`                        — backward-compatible legacy form where
 *     the same world owns both (single-world callers + the app frame-loop; the
 *     hard cutover to the split form lands in M2).
 *   - `{ cameraOwner, resourceOwner }`   — the two-index split form (editor
 *     composite: scene camera + separate editor-overlay resource world).
 */
export type DrawOwnerOptions = { owner: number } | { cameraOwner: number; resourceOwner: number };

/**
 * Normalize {@link DrawOwnerOptions} into the two-index split form. A legacy
 * `{ owner }` maps to `cameraOwner === resourceOwner === owner` (byte-identical
 * single-owner path); the split form passes through. World-free (plain number
 * math) so both the createRenderer draw facade and the internal RenderSystem
 * draw resolve owners through one SSOT helper (charter P5 consistent
 * abstraction).
 */
export function resolveDrawOwners(options: DrawOwnerOptions): {
  cameraOwner: number;
  resourceOwner: number;
} {
  if ('owner' in options) {
    return { cameraOwner: options.owner, resourceOwner: options.owner };
  }
  return { cameraOwner: options.cameraOwner, resourceOwner: options.resourceOwner };
}

/** Information attached to a device-loss notification. */
export interface RendererLostInfo {
  /** Concise machine-readable cause, mapped to a single vocabulary. */
  reason: string;
  /** Free-form description (UA / extension / driver text). */
  message: string;
}

/** Listener registered through `Renderer.onLost`. */
export type RendererLostListener = (info: RendererLostInfo) => void;

/**
 * Composite error type reachable through the `Renderer.onError` fan-out channel
 * (D-4). This is the fan-out channel's *wire contract* — it does NOT define any
 * error; it only references the cluster unions whose members can arrive here.
 * As such it is an external wire alias (AGENTS.md Change stance add-only wire
 * exception), NOT the eliminated cross-cluster `RuntimeError` SSOT (D-3).
 *
 * Composition = `RhiError | RenderError | AssetRuntimeError | SkinError |
 * PostProcessError`. This equals the pre-decomposition
 * `RhiError | RuntimeError | PostProcessError` exactly: `RuntimeError` was
 * `RenderError | AssetRuntimeError | SkinError` (27 classes). `RecoverError`
 * and `EngineEnvironmentError` are intentionally excluded — neither is ever
 * fired through `onError` (`RecoverError` returns from `recover()`,
 * `EngineEnvironmentError` throws at construction), matching the original
 * `RuntimeError` union which excluded both (OOS-3 behavior equivalence).
 *
 * AI consumers do `switch (err.code)` over the union: the disjoint
 * `RhiErrorCode` / `RenderErrorCode` / `AssetRuntimeErrorCode` / `SkinErrorCode`
 * / `PostProcessErrorCode` literal sets let TS narrow each arm to the concrete
 * class (charter P3 union discoverability — every fan-out member is reachable
 * in an exhaustive switch, no `as any` escape). Example:
 *
 * ```ts
 * renderer.onError((err) => {
 *   switch (err.code) {
 *     case 'asset-not-registered': // AssetRuntimeError arm, err narrowed here
 *       return report(err.hint);
 *     // ...one arm per RhiErrorCode | RenderErrorCode | AssetRuntimeErrorCode
 *     //    | SkinErrorCode | PostProcessErrorCode member; no default needed,
 *     //    TS flags any unhandled code at compile time.
 *   }
 * });
 * ```
 */
export type RendererError =
  | RhiError
  | RenderError
  | AssetRuntimeError
  | SkinError
  | PostProcessError;

/**
 * Listener registered through `Renderer.onError` (fix-f2). Receives any
 * {@link RendererError} fanned out through the channel.
 */
export type RendererErrorListener = (error: RendererError) => void;

/** First-version options bag (intentionally empty; reserved for v0.1). */
export interface RendererOptions {
  // feat-20260608-create-app-param-surface-trim / M1 / AC-02: `clearColor`
  // was deleted as a one-cut breaking change (AGENTS.md Change stance +
  // requirements constraint #1: no deprecation window, no shim). Scene
  // clear color now lives on the Camera entity (`clearR / clearG /
  // clearB / clearA`); zero-Camera fallback uses
  // `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]` from
  // `render-system-record`. AI users that pass `{ clearColor: [...] }`
  // get a TS2353 excess-property error at compile time.
  //
  // feat-20260608-create-app-param-surface-trim / M2 / AC-06 + D-3:
  // `shaderManifestUrl` was deleted from RendererOptions and moved to
  // the third-arg `BundlerOptions` (build-tool injection channel). The
  // fallback literal '/shaders/manifest.json' stays at the createRenderer
  // body site (D-2 q5-A) so the LO 1.1 zero-config takeoff path keeps
  // working without any explicit injection. AI users that pass
  // `{ shaderManifestUrl: '...' }` to RendererOptions get a TS2353
  // excess-property error at compile time pointing them to the third
  // arg (charter P1 progressive disclosure -- the message names
  // BundlerOptions, not a free-form string).
  /**
   * D-S1 single-point exemption channel (feat-20260508-rhi-surface-completion
   * / w9): raw GPUDevice used by the GPUCanvasContext.configure({device})
   * path. GPUCanvasContext is outside the RHI surface (spec couples context
   * to canvas, not GPUDevice), so the raw GPUDevice is injected through
   * RendererOptions.rawDeviceForContextConfigure. apps/hello/triangle/src/main.ts:96
   * captures the raw device via _internal_getRawDevice and passes it in;
   * every other engine path goes through the RHI interface.
   *
   * Accepted forms:
   *   - direct value (unknown)              - raw GPUDevice already captured
   *   - thunk `() => unknown | undefined`   - lazy capture, evaluated AFTER
   *     createRenderer's internal rhi.requestDevice settles (lets callers
   *     wrap requestDevice to capture the raw device transparently)
   *
   * Type intentionally unknown: keeps the RHI surface free of raw GPUDevice
   * typing; webgpu-backend internally casts to GPUDevice.
   */
  readonly rawDeviceForContextConfigure?: unknown | (() => unknown | undefined);
  /**
   * M3 D-P4 escape hatch (feat-20260511-rhi-wgpu-impl): explicit
   * `RhiInstance` injection bypasses the dynamic-import auto-select
   * facade. When set, `createRenderer` uses this instance verbatim and
   * neither `@forgeax/engine-rhi-webgpu` nor `@forgeax/engine-rhi-wgpu` is imported
   * dynamically (charter proposition 5 discoverable opt-in /
   * plan-strategy §6 M3 + §7.4 escape hatch + Bevy
   * `RenderCreation::Manual` partial equivalent).
   *
   * Typical use cases:
   *   - Testing / debugging — inject a deterministic stub.
   *   - Pinning a specific backend (e.g. `@forgeax/engine-rhi-wgpu` even when
   *     `navigator.gpu` is present, for cross-shim regression tests).
   *   - Advanced AI users implementing their own `RhiInstance` shim.
   *
   * AI users who want the default behaviour leave this field omitted;
   * `navigator.gpu` presence/absence drives the dynamic import (see the
   * `createRenderer` JSDoc for the full auto-select decision tree).
   */
  readonly rhi?: RhiInstance | undefined;
}

/**
 * Public Renderer surface. The concrete class is constructed by
 * `createRenderer(canvas, options?)`; callers never instantiate this directly.
 *
 * ECS render bridge error tier table (D-S3 / D-S4 / D-S6 / D-S7 / D-S8):
 *
 * | Path | Behaviour | onError fired? |
 * |:--|:--|:--|
 * | `ready` step 1 manifest load fails | settles err (`ShaderError 'manifest-malformed'` / `'shader-not-found'`) | no — surfaced through `await renderer.ready` |
 * | `ready` step 2 pipeline compile fails | settles err (`RhiError 'shader-compile-failed'` / `'feature-not-enabled'` / `'limit-exceeded'`) | no — surfaced through ready |
 * | `ready` step 3 asset upload fails | settles err (`RhiError 'limit-exceeded'` / `'webgpu-runtime-error'`) | no — surfaced through ready |
 * | `draw([world], { owner: 0 })` before `ready` settles (D-S4) | frame skipped | yes — `'rhi-not-available'` |
 * | RenderSystem 0 Camera | frame skipped | yes — `'render-system-no-camera'` |
 * | RenderSystem N>1 Camera | first archetype hit rendered | yes — `'render-system-multi-camera'` |
 * | RenderSystem N>1 DirectionalLight | first archetype hit used | yes — `'render-system-multi-light'` |
 * | RenderSystem 0 DirectionalLight | unlit fallback (intensity = 0) | no — D-Q7 softening |
 * | RenderSystem 0 renderables (Camera entity only) | clear pass executed; canvas painted with `Camera.clearR/G/B/A`; no geometry submitted | no — D-Q7 softening |
 * | RenderSystem all renderables fail asset-not-registered | clear pass executed; per-entity `'asset-not-registered'` fires for each unregistered handle | yes — per entity |
 * | RenderSystem entity missing Transform / MeshRenderer | default value used | no — D-Q7 softening |
 * | RenderSystem unregistered `MeshFilter.assetHandle` | entity skipped | yes — `'asset-not-registered'` (`detail = { assetHandle }`) |
 * | RenderSystem internal exception (mat4 NaN / GPU bounds) | frame skipped + retry next frame | yes — `'webgpu-runtime-error'` (`detail = { error }`) |
 */
export interface Renderer {
  /** Opaque backend marker (K-4). */
  readonly backend: RendererBackend;
  /**
   * Captured RhiDevice handle. The forgeax RhiDevice the engine created
   * internally via `rhi.requestAdapter() -> adapter.requestDevice()`.
   * AI users read through this accessor instead of monkey-patching
   * `rhi.requestAdapter` to capture the device handle.
   */
  readonly device: RhiDevice;
  /**
   * Instance-per-engine ShaderRegistry: on first access this lazy property
   * constructs a `ShaderRegistry({ device, manifestUrl })` instance;
   * subsequent accesses return the same instance. Callers must
   * `await shader.loadManifest()` before they can call `shader.get(hash)`.
   */
  readonly shader: ShaderRegistry;
  /**
   * Instance-per-engine `AssetRegistry` pre-populated with `HANDLE_CUBE` /
   * `HANDLE_TRIANGLE`. AI users look up assets via `renderer.assets.get(handle)`
   * or register custom meshes via `renderer.assets.register(asset).unwrap()`.
   */
  readonly assets: AssetRegistry;
  /**
   * feat-20260527-sprite-nineslice M4 / w16 (D-5 + AC-16): per-Renderer
   * metrics counter for runtime-time soft signals.
   *
   * AI users read `renderer.metrics.snapshot()['<feature>.<event>']` to observe
   * events the engine surfaces without a `console.warn` flood (charter P3:
   * machine-readable counters over text). Two methods compose the surface:
   *
   *   | Method                  | Purpose                                  |
   *   |:------------------------|:-----------------------------------------|
   *   | `increment(name)`       | Engine-internal: bump counter for `name`.|
   *   | `snapshot()`            | AI-user-facing: read all counters.       |
   *   | `reset()`               | Test isolation: drop every counter.      |
   *
   * Currently surfaced counters (closed namespace, see `EngineMetrics`
   * JSDoc):
   *
   *   - `nineslice.scale-too-small`            (AC-16, w17 end-to-end)
   *   - `nineslice.tile-needs-repeat-sampler`  (D-9, w18 register-time soft-warn)
   *
   * Multi-Renderer isolation: each Renderer instance owns its own EngineMetrics
   * (D-5 candidate 1) so per-test counters never bleed across renderers.
   */
  readonly metrics: EngineMetrics;
  /**
   * feat-20260601-gpu-resource-store-extraction M1: the GPU residency store.
   * `renderer.assets` keeps the CPU POD registry; `renderer.store` owns the
   * GPU resource lifecycle. Render-path texture / mesh residency is pulled
   * lazily via `store.ensureResident`. The equirect-to-cubemap IBL projection
   * is engine internals (feat-20260630 D-3): AI users declare
   * `Skylight{equirect}` and the record arm drives the projection; there is no
   * user-facing upload call. The store holds no AssetRegistry reference (D-2);
   * callers pass the source POD fetched from `renderer.assets`.
   */
  readonly store: GpuResourceStore;
  /**
   * V-2 first-class input shim (plan-strategy D-2 + AC-09 — feat-20260519).
   *
   * Curried `(world: World) => InputSnapshot | undefined` reader: a thin
   * facade over `world.getResource<InputSnapshot>('InputSnapshot')`.
   *
   * Charter P5 producer/consumer split: the renderer never holds a World
   * reference; the World is supplied per call so the renderer lifecycle
   * remains decoupled from the World lifecycle.
   *
   * Returns `undefined` when no InputSnapshot Resource is registered on
   * the World (charter P3: empty signal is the signal).
   */
  readonly input: {
    snapshot(world: World): InputSnapshot | undefined;
  };
  /**
   * Initialization barrier (D-S3 — feat-20260509-ecs-render-bridge-mvp).
   *
   * Resolves only after three steps complete, in strict serial order:
   *   1. `shader.loadManifest()` — fetch + parse manifest.json.
   *   2. PBR pipeline compile — `createShaderModule` + 3x
   *      `createBindGroupLayout` (view / material / mesh-array) +
   *      `createPipelineLayout` + `createRenderPipeline`.
   *   3. `AssetRegistry` builtin mesh upload — `createBuffer` +
   *      `queue.writeBuffer` for cube + triangle vertex / index buffers.
   * Any step failure settles with `Result.err(RhiError)`.
   *
   * Calling `draw([world], { owner: 0 })` before `ready` settles fires
   * `onError` with `'rhi-not-available'` and skips the frame (D-S4).
   *
   * @example
   *   const renderer = await createRenderer(canvas);
   *   const ready = await renderer.ready;
   *   if (!ready.ok) throw ready.error;
   *   const r = renderer.draw([world], { owner: 0 });
   *   if (!r.ok) console.error(r.error);
   */
  readonly ready: Promise<Result<void, RhiError>>;
  /**
   * Draw one frame for the supplied World (D-S2 + K-4 rewrite).
   *
   * RenderSystem (engine-internal phase) walks the World query graph
   * across three stages — Extract / Prepare / Record — and submits a
   * single GPU command buffer per call. Per-call behaviour is governed by
   * the error tier table on `Renderer` (D-S4..D-S8); AI users observe
   * fan-out through `onError` and frame-skip semantics through the same
   * structured RhiError closed union.
   *
   * @example Spawn-then-draw:
   *   const world = new World();
   *   world.spawn(
   *     { component: Transform, data: cameraTransform },
   *     { component: Camera, data: cameraParams },
   *   );
   *   world.spawn({
   *     component: MeshFilter,
   *     data: { assetHandle: HANDLE_CUBE },
   *   });
   *   const ready = await renderer.ready;
   *   if (!ready.ok) throw ready.error;
   *   const r = renderer.draw([world], { owner: 0 });
   *   if (!r.ok) handleError(r.error);
   *
   * w24 — Result<void, RhiError> shape: returns Result.ok(undefined) on
   * success; Result.err(rhiError) on facade-level catch (transient runtime
   * exception). Per-stage RhiError continues to fan out through `onError`
   * (charter proposition 5; D-P6 dual-channel preserved). The Result return
   * is the synchronous facade-level summary; AI users can ignore it or
   * branch on `.ok` (biome lint warns on unhandled return).
   *
   * feat-20260708-composited-multi-world-rendering M3 (AC-01 / AC-02 / D-5),
   * extended by feat-20260709-editor-world-partition M1 / w6: `worlds` is
   * composited into one frame — renderables + lights merge from every world,
   * while cameras come from the `cameraOwner` world and singleton resources
   * (skylight / skybox / postProcessParams) come from the `resourceOwner`
   * world. {@link DrawOwnerOptions} accepts either the legacy `{ owner }`
   * single-owner form (cameraOwner === resourceOwner === owner) or the split
   * `{ cameraOwner, resourceOwner }` form; one of the two is required (omitting
   * both is a compile-time error). There is no legacy `draw(world)` overload.
   * Single-world users pass `draw([world], { owner: 0 })` (the app frame-loop
   * does this wrapping transparently). Entry validation returns `Result.err`
   * before any extract on:
   *   - empty `worlds`               -> `'render-system-empty-worlds'`
   *   - `cameraOwner` out of range   -> `'render-system-owner-out-of-range'`
   *     (`.detail = { role: 'camera', owner, worldCount }`)
   *   - `resourceOwner` out of range -> `'render-system-owner-out-of-range'`
   *     (`.detail = { role: 'resource', owner, worldCount }`)
   * cameraOwner is validated before resourceOwner (first offender wins).
   *
   * @example Composite two worlds (owner supplies both camera + resources):
   *   const scene = new World();   // camera + lights + geometry
   *   const overlay = new World(); // extra geometry, no camera
   *   const r = renderer.draw([scene, overlay], { owner: 0 });
   *   if (!r.ok) handleError(r.error);
   *
   * @example Split owners (scene camera, editor-overlay resources):
   *   const r = renderer.draw([scene, editor], { cameraOwner: 0, resourceOwner: 1 });
   */
  draw(worlds: World[], options: DrawOwnerOptions): Result<void, RhiError>;
  /**
   * Read the canvas's current pixel contents back into an RGBA Uint8Array.
   *
   * Reads the WebGPU canvas's backing image via the lowest-common-
   * denominator browser path: `createImageBitmap → OffscreenCanvas 2D
   * drawImage → getImageData`. The WebGPU canvas's GPUTexture is not
   * directly readable via `getImageData`, so this OffscreenCanvas bounce
   * is the canonical browser path; AI users avoid hand-rolling the
   * recipe (charter proposition 5 consistent abstraction).
   *
   * Returns top-left origin RGBA (the natural getImageData convention).
   * Apps that need bottom-left origin (parity comparisons against
   * `gl.readPixels`) Y-flip the result locally.
   *
   * AI users typically: `renderer.draw([world], { owner: 0 })` to update the canvas,
   * then `await renderer.readPixels()` to sample. Output buffer length
   * is `canvas.width * canvas.height * 4`.
   *
   * | Path | Behavior |
   * |:--|:--|
   * | OffscreenCanvas + 2D ctx all available | `Result.ok(Uint8Array)` |
   * | OffscreenCanvas / 2D ctx unavailable | `Result.err(RhiError 'webgpu-runtime-error')` (`detail.error: string`) |
   * | `createImageBitmap` throws | `Result.err(RhiError 'webgpu-runtime-error')` (`detail.error: string`) |
   *
   * dawn-node smoke harness path uses raw RHI (`device.queue.copyTexture
   * ToBuffer + mapAsync`) directly against an offscreen `GPUTexture` —
   * that path has no canvas and does not collapse with this method.
   * Future RHI-level readback abstraction tracked separately.
   */
  readPixels(): Promise<Result<Uint8Array, RhiError>>;
  /**
   * Release renderer-owned resources + detach listeners. Idempotent.
   *
   * @placeholder fix-f6: M2/M3 placeholder form — the `RhiDevice` interface
   * does not yet expose a `destroy()` entry, so the current implementation
   * only detaches the listener registry + blocks subsequent `draw()` calls;
   * the underlying GPU resources are reclaimed naturally via the spec
   * pass-through layer (`device.lost` pass-through + browser GC). The
   * explicit `device.destroy()` path will be closed out in a later RHI
   * interface extension. See the `Renderer.dispose` row of the "API index"
   * in `packages/engine/README.md` plus plan-strategy §6 NOTE on M3 scope.
   */
  dispose(): void;
  /** Register a notify-only listener for device-loss. Returns unsubscribe fn. */
  onLost(listener: RendererLostListener): () => void;
  /**
   * Register an RHI creation-time error listener (fix-f2 / charter
   * proposition 4 explicit-failure delivery).
   *
   * @returns unsubscribe fn
   */
  onError(listener: RendererErrorListener): () => void;
  /**
   * Pull-style health snapshot. Returns the canonical `HealthSnapshot` from the
   * registry's last-fired state, or the alive baseline when never fired. No
   * second store — derived from `HealthListenerRegistry.getLastSnapshot()` per
   * D-4 SSOT.
   *
   * AI users consume via `switch (snap.reason)`; TS narrows `snap.detail` to
   * the per-reason detail type without `as` casts.
   */
  health(): HealthSnapshot;
  /**
   * Attempt a single idempotent device rebuild (feat-20260622-s5 M3).
   *
   * Only acts in the `device-lost` health state; `alive` returns
   * `recover-not-needed` (also returned after a successful rebuild — the
   * renderer is alive again, so a second recover() is a no-op signal).
   * Rebuild sequence: `gpuStore.destroyAll()` + `context.unconfigure()` ->
   * clear the render-graph pendingDestroy queue (B-2) -> re-acquire device via
   * the same backend pack (`requestAdapter` -> `requestDevice`) -> rebuild
   * Shader/Pipeline -> re-attach the device.lost fan-out -> `fire('alive')`.
   * CPU POD caches (AssetRegistry catalog/payload, pack cache) survive; only
   * GPU resources are released and re-uploaded on the next draw via
   * `ensureResident` (A-AC-12).
   *
   * Async because device acquisition is async (`requestAdapter` /
   * `requestDevice`). A single attempt: no retry loop, no backoff, no timer
   * (A-OOS-1). On failure resolves `Result.err` (`recover-adapter-unavailable`
   * / `recover-device-unavailable`) and leaves `health().reason ===
   * 'device-lost'` — recover() never fakes the renderer back to `alive`
   * (A-AC-07). The host owns the retry cadence (call recover() again after a
   * host-chosen delay).
   */
  recover(): Promise<Result<void, RecoverError>>;
  /**
   * Push-style health subscription with unsubscribe.
   *
   * Delegates to `HealthListenerRegistry.add(cb)` — late-attach replay fires
   * the callback immediately when a snapshot has already been emitted, so
   * late-subscribing callers still see the current state (AC-07).
   *
   * @returns unsubscribe function
   */
  onHealthChange(cb: HealthChangeListener): () => void;
  /**
   * feat-20260520-directional-light-shadow-mapping M1c / w8:
   * debugReadback reads the shadow depth texture (depth32float) into a 5-
   * pixel POD { center, corners: {tl,tr,bl,br}, mapSize }. Uses
   * copyTextureToBuffer + mapAsync + Float32Array direct read. Returns null
   * when no shadow RT is allocated (shadow pass hasn't run yet, or no
   * DirectionalLight with castShadow).
   *
   * AI users consume per-pixel depth values as [0,1] floats; no 24-in-32
   * unorm decode needed (depth32float, D-2 round-3).
   */
  debugReadback?(): Promise<{
    readonly center: number;
    readonly corners: {
      readonly tl: number;
      readonly tr: number;
      readonly bl: number;
      readonly br: number;
    };
    readonly mapSize: number;
  } | null>;
  /**
   * feat-20260520-directional-light-shadow-mapping M1c / w8:
   * lights.directionalShadow exposes shadow configuration (mapSize,
   * lightSpaceMatrix) for Inspector consumption. Null when the renderer
   * has no active shadow system (shader manifest empty or no
   * DirectionalLight with castShadow).
   */
  readonly directionalShadow?: {
    readonly mapSize: number;
    readonly lightSpaceMatrix: readonly number[] | null;
  } | null;
  /**
   * feat-20260520-directional-light-shadow-mapping M2 / w14 (AC-12):
   * debugSampleShadowFactor emulates the shader's naive single-sample shadow
   * factor on CPU given world-space positions. Reads shadow depth via
   * copyTextureToBuffer + mapAsync, computes lightSpaceMatrix * pos, UV remap,
   * and currentDepth <= storedDepth comparison (matches pbr.wgsl naive lookup).
   *
   * Returns null when no shadow RT is allocated or lightSpaceMatrix is absent.
   * Each result carries { shadowFactor: number } where 1 = lit, 0 = fully
   * shadowed. M2 intentionally does not smooth (M3 adds PCF).
   */
  debugSampleShadowFactor?(
    worldPositions: ReadonlyArray<readonly [number, number, number]>,
  ): Promise<ReadonlyArray<{ readonly shadowFactor: number }> | null>;
  /**
   * feat-20260528-frustum-culling M5 / w14: per-frame frustum-culling
   * statistics collected during the extract stage. `culled` is the count
   * of entities removed from renderables by frustum culling; `total` is
   * the count that reached the culling decision point. Both are zero
   * before the first `draw([world], { owner: 0 })` or when no `MeshRenderer` entities
   * are in the world.
   */
  readonly frustumStats: { readonly culled: number; readonly total: number };
  /**
   * feat-20260531-bloom-first-declarative-render-graph-pass M4 fix-up w19:
   * per-frame render-graph pass names in declaration order. Empty array
   * before the first `draw([world], { owner: 0 })` call; populated lazily when the
   * per-frame graph is built. Read-only introspection surface so smoke
   * tests can assert the declarative pass chain is wired without reaching
   * into engine internals.
   */
  readonly perFramePassNames: readonly string[];
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
   * createBindGroup counter. Reset to 0 on every `draw([world], { owner: 0 })` call,
   * bumped per cache-miss in the record stage. Stable-frame AC-03
   * asserts `createBindGroup === 0` when all bind groups are cached.
   * AI users read this getter to verify cache effectiveness without
   * inspecting internal cache state.
   */
  readonly bindGroupCounts: { readonly createBindGroup: number; readonly keys: readonly string[] };
  /**
   * feat-20260601-customizable-render-pipeline-seam M1 / w8: register a render-pipeline
   * logic under `id` (engine builtins use the `forgeax::` prefix; user pipelines use
   * `<package>::<id>`). Same-id re-register throws `PipelineError`
   * (`'pipeline-already-registered'`) - programmer-error fail-fast. Sits alongside
   * `shader` / `assets` / `store` as a public capability surface (charter F1 IDE
   * autocomplete on `renderer.`). Forwards 1:1 to the RenderSystem layer.
   */
  registerPipeline(id: string, impl: RenderPipeline): void;
  /**
   * feat-20260601-customizable-render-pipeline-seam M1 / w8 (D-19): install the pipeline
   * described by a `RenderPipelineAsset` POD (built inline, no registration step). On an
   * unregistered `pipelineId` returns `Result.err(PipelineError{code:'pipeline-not-found'})`;
   * AI users consume `err.code` by property access. On success the next `draw` rebuilds the
   * per-frame graph through the newly installed pipeline (runtime hot-swap).
   */
  installPipeline(asset: RenderPipelineAsset): Result<void, PipelineError>;
  /**
   * feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M2 / F-2 fix-up:
   * fullscreen post-process registration channel. `postProcess.register(id, entry)`
   * registers a `PostProcessShaderEntry` under `id`; the dispatcher in
   * `addFullscreenPass({shader: id})` looks it up via `runtime.lookupPostProcess`.
   * Same-id re-register throws `PostProcessError({code:'post-process-already-registered'})`
   * (programmer-error fail-fast, mirrors `registerPipeline`). An unregistered id
   * referenced by `addFullscreenPass` throws `PostProcessError({code:'post-process-not-found'})`
   * from the dispatcher. Sits alongside `registerPipeline` / `installPipeline` as a
   * public capability surface (charter F1: IDE autocomplete on `renderer.postProcess.`).
   * Forwards 1:1 to the RenderSystem layer (plan-strategy D-D).
   */
  readonly postProcess: {
    register(
      id: string,
      entry: import('./fullscreen-post-process-pass').PostProcessShaderEntry,
    ): void;
  };
  /**
   * feat-20260612-skin-palette-per-frame-upload M1 / m1-1: test-only access
   * hatch returning the internal `PipelineState` closure variable (or `null`
   * before `await renderer.ready` settles). Mirrors the existing
   * `_internal_getRawDevice` pattern so unit tests can assert PipelineState
   * field shape (e.g. `skinPaletteAllocator` presence after stub retirement)
   * without re-routing through `RenderSystem`. Public surface stays opaque:
   * the return is widened to `unknown`, callers cast at the test boundary.
   * @internal
   */
  _internal_getPipelineState(): unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Renderer health / recover surface (feat-20260621-renderer-health-recover-skeleton M1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Closed union of renderer health states.
 *
 * 3 members per plan-strategy D-1:
 *   - `'alive'` — healthy baseline (registry not yet fired)
 *   - `'device-lost'` — device loss detected
 *   - `'internal-fault'` — internal renderer fault
 *
 * AI users exhaustively switch on `HealthReason` without default; TS guards
 * completeness.
 */
export type HealthReason = 'alive' | 'device-lost' | 'internal-fault';

/** Detail for `HealthReason 'device-lost'`. */
export interface HealthDetailDeviceLost {
  readonly lostReason: 'unknown' | 'destroyed';
  readonly message: string;
}

/** Detail for `HealthReason 'internal-fault'`. */
export interface HealthDetailInternalFault {
  readonly message: string;
}

/**
 * Pull-style health snapshot — discriminated union by `reason`.
 *
 * Per plan-strategy D-2: `switch(snap.reason)` narrows `snap.detail` to the
 * per-reason detail type automatically, with zero `as` casts. `alive` has no
 * `.detail` field; `device-lost` / `internal-fault` have a required `.detail`
 * of the respective variant.
 *
 *   - `recoverable` — derived from `reason` via `deriveRecoverable`
 */
export type HealthSnapshot =
  | { readonly reason: 'alive'; readonly recoverable: boolean }
  | {
      readonly reason: 'device-lost';
      readonly detail: HealthDetailDeviceLost;
      readonly recoverable: boolean;
    }
  | {
      readonly reason: 'internal-fault';
      readonly detail: HealthDetailInternalFault;
      readonly recoverable: boolean;
    };

/**
 * Maps `HealthReason` to recoverable boolean per the derive table
 * (requirements section "range"):
 *
 *   | reason         | recoverable |
 *   |:---------------|:-----------|
 *   | `'alive'`      | false       |
 *   | `'device-lost'`| true        |
 *   | `'internal-fault'` | false   |
 */
export function deriveRecoverable(reason: HealthReason): boolean {
  switch (reason) {
    case 'alive':
      return false;
    case 'device-lost':
      return true;
    case 'internal-fault':
      return false;
  }
}

/** Callback type for `Renderer.onHealthChange`. */
export type HealthChangeListener = (snapshot: HealthSnapshot) => void;

// ────────────────────────────────────────────────────────────────────────────
// Internal — shared listener-registry helper (used by both backends).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Internal helper: a tiny notify-only event registry. Not exported on the
 * public surface (`./internal/*` is locked via package.json#exports).
 */
export class LostListenerRegistry {
  private readonly listeners = new Set<RendererLostListener>();
  private fired = false;
  private lastInfo: RendererLostInfo | null = null;

  add(listener: RendererLostListener): () => void {
    this.listeners.add(listener);
    // Late-attach replay: if loss already fired, immediately notify the new
    // listener so callers attaching after-the-fact still see the event.
    if (this.fired && this.lastInfo) {
      listener(this.lastInfo);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  fire(info: RendererLostInfo): void {
    this.fired = true;
    this.lastInfo = info;
    for (const listener of this.listeners) {
      listener(info);
    }
  }

  /**
   * Detach all listeners (called from the fix-f6 dispose path). Does not
   * reset `fired` / `lastInfo`: listeners added after dispose still receive
   * the late-attach replay, consistent with the spec style.
   */
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Internal helper: fan-out registry for the `Renderer.onError` channel (fix-f2
 * delivers the charter proposition 4 explicit-failure red line).
 *
 * Difference from `LostListenerRegistry`: this registry fans out structured
 * structured error objects from the fan-out families composed in
 * `RendererError` — both carrying the `.code` closed-union discriminant + the
 * three fields `.expected` / `.hint` + optional `.detail`. Late-attach replay
 * behavior is identical — errors that fired before dispose are immediately
 * replayed to any subsequent `add`.
 */
export class RhiErrorListenerRegistry {
  private readonly listeners: RendererErrorListener[] = [];
  private fired = false;
  private lastError: RendererError | null = null;

  add(listener: RendererErrorListener): () => void {
    this.listeners.push(listener);
    if (this.fired && this.lastError) {
      try {
        listener(this.lastError);
      } catch (err) {
        // Late-attach replay: a throwing listener does not abort the registry;
        // surface the throw via console.error so the runtime is still
        // observable (charter proposition 4 explicit failure baseline).
        console.error('[RhiErrorListenerRegistry] late-attach listener threw:', err);
      }
    }
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Fire `error` to all currently-registered listeners. D-PD4 dual-channel
   * fan-out semantics:
   *   (a) FIFO insertion order — listeners fire in `add` order;
   *   (b) Listener-throw isolation — a throwing listener does not abort
   *       subsequent listeners; the throw is captured and surfaced via
   *       console.error;
   *   (c) Zero-listener fallback — when no listener is registered the error
   *       is emitted via console.error so the runtime is still observable
   *       (charter proposition 4 explicit failure baseline; no silent skip).
   */
  fire(error: RendererError): void {
    this.fired = true;
    this.lastError = error;
    if (this.listeners.length === 0) {
      console.error(`[RhiError ${error.code}] expected: ${error.expected}; hint: ${error.hint}`);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(error);
      } catch (err) {
        console.error('[RhiErrorListenerRegistry] listener threw:', err);
      }
    }
  }

  clear(): void {
    this.listeners.length = 0;
  }
}

/**
 * Internal helper: fan-out registry for the `Renderer.onHealthChange` channel
 * (feat-20260621-renderer-health-recover-skeleton M1).
 *
 * 3rd isomorph of the `LostListenerRegistry` / `RhiErrorListenerRegistry` pattern
 * (plan-strategy D-5 / OOS-5: do not extract a generic base class). Replicates:
 *   - `fired` / `lastSnapshot` for late-attach replay
 *   - `add(listener)` returns unsubscribe function
 *   - `fire(snapshot)` with try/catch isolation (console.error on throw)
 *   - `clear()` detaches listeners, does not reset `fired` / `lastSnapshot`
 *   - `getLastSnapshot()` — public getter returning last fired snapshot or
 *     `{ reason: 'alive', recoverable: false }` baseline
 */
export class HealthListenerRegistry {
  private readonly listeners = new Set<HealthChangeListener>();
  private fired = false;
  private lastSnapshot: HealthSnapshot | null = null;

  add(listener: HealthChangeListener): () => void {
    this.listeners.add(listener);
    if (this.fired && this.lastSnapshot) {
      try {
        listener(this.lastSnapshot);
      } catch (err) {
        console.error('[HealthListenerRegistry] late-attach listener threw:', err);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  fire(snapshot: HealthSnapshot): void {
    this.fired = true;
    this.lastSnapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('[HealthListenerRegistry] listener threw:', err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  getLastSnapshot(): HealthSnapshot {
    if (this.fired && this.lastSnapshot) {
      return this.lastSnapshot;
    }
    return { reason: 'alive', recoverable: false };
  }
}
