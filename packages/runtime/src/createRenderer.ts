// @forgeax/engine-runtime — `createRenderer` async factory (K-4 + M3 D-P4 auto-select facade).
//
// Behaviour (bug-20260526-channel2-adapter-fail-no-channel3-fallback):
//   Channel 1. `options.rhi` supplied → use it verbatim (escape hatch, D-R5).
//   Channel 2. `navigator.gpu` present → static `@forgeax/engine-rhi-webgpu`.
//              If adapter/device/context fails → fall back to Channel 3.
//   Channel 3. Dynamic `import('@forgeax/engine-rhi-wgpu')` + `await ensureReady()`.
//   Failure  → throw `EngineEnvironmentError` with `detail.webgpuError` +
//              `detail.wgpuError` (compound failure from both channels).
//
// **D-P4 three-channel error propagation** (RK-04 + plan-strategy §7.3):
//   (a) Construction-time → `createRenderer(...)` rejects with
//       `EngineEnvironmentError` whose `detail.webgpuError` is the Channel 2
//       `RhiError` and `detail.wgpuError` is the Channel 3 failure (when both
//       channels fail; AI users `try { await createRenderer(...) } catch (e) {
//       switch (e.detail.webgpuError?.code) { ... } }`).
//   (b) Run-time pipeline build → `renderer.ready` rejects with the
//       structured `RhiError` (`shader-compile-failed` / `limit-exceeded` /
//       `webgpu-runtime-error` / ...); AI users `await renderer.ready`.
//   (c) onError fan-out → `renderer.onError(listener)` captures the same
//       errors as a fallback observability channel (charter proposition 4
//       structured + proposition 9 graceful degradation).
//
// AC-15 source-level: this file uses `globalThis.navigator` rather than
// `navigator` directly; it never touches `window` or `document`.

import type { World } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  RenderPipeline,
  Result,
  RhiCanvasContext,
  RhiDevice,
  RhiInstance,
  Sampler,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
// Static rhi-webgpu import — channel 2 (navigator.gpu present) consumes this
// namespace synchronously. rhi-webgpu is **already** a static dep via
// `engine-runtime/src/index.ts:export { acquireCanvasContext } from
// '@forgeax/engine-rhi-webgpu'` (M3 D-P3 single-entry SSOT for vite apps), so
// the bundler treats it as eager-loaded regardless of how this file refers to
// it. Channel 3 (rhi-wgpu) stays dynamic — only rhi-wgpu has no static
// reference in engine-runtime and therefore tree-shakes out of browser-only
// bundles. See file-header comment (revision F-01) and `loadBackendPack`
// JSDoc for the full rationale.
import * as rhiWebgpu from '@forgeax/engine-rhi-webgpu';
import {
  findVariantByKey,
  ShaderRegistry,
  type ShaderRegistryDevice,
} from '@forgeax/engine-shader';
import type {
  AnimationClip,
  AssetGuid as AssetGuidType,
  Handle,
  ImportTransport,
  ManifestEntry,
  MaterialRenderState,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { derive, handleSlot } from '@forgeax/engine-types';
import {
  AssetRegistry,
  HANDLE_CUBE,
  HANDLE_NINESLICE_QUAD,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
} from './asset-registry';
import { BuiltinAssetRegistry } from './builtin-asset-registry';
import { classifyEnvErrorReason, composeEnvErrorHint } from './create-renderer-env-classify';
import { DynamicTextureStore } from './dynamic-texture-store';
import { createEngineMetrics } from './engine-metrics';
import {
  EngineEnvironmentError,
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
  RecoverError,
} from './errors';
import type { PostProcessShaderEntry } from './fullscreen-post-process-pass';
import { glyphTextLayoutSystem } from './glyph-text-layout-system';
import { GpuBuffer } from './gpu-resource';
import { GpuResourceStore } from './gpu-resource-store';
import { createHdrpBindGroupLayoutDescriptor } from './hdrp-buffers';
import { HDRP_PIPELINE_ID, hdrpPipeline } from './hdrp-pipeline';
import { clearIblCacheForDevice, setIblComposedShaders } from './ibl/IblPipelineCache';
import { createSkylightFallback, type SkylightFallback } from './ibl/skylight-bind-group';
import {
  assertStorageBufferCap,
  LIGHT_ARRAY_HEADER_BYTES,
  LIGHT_ARRAY_MAX_SLOTS,
  POINT_LIGHT_STD430_BYTES,
  SPOT_LIGHT_STD430_BYTES,
} from './light-buffer-layout';
import type { MipmapShaderModuleFactory } from './mipmap-generator';
import {
  buildPbrPipelineLayouts,
  buildPbrSkinLayouts,
  SKIN_MATERIAL_SHADER_ID,
} from './pbr-pipeline';
import { buildPipelineForMaterialShader } from './pipeline-builder';
import {
  buildBindGroupLayoutDescriptor,
  buildSpecConstTable,
  cacheKeyOf,
  getOrBuildPipeline,
  type PipelineCache,
  type PipelineDeviceProvider,
  type PipelineSpec,
  PipelineSpecError,
} from './pipeline-spec';
import { TONEMAP_POST_PROCESS_ID } from './render-graph-primitives';
import {
  configureSurface,
  createRenderSystem,
  type MeshGpuHandles,
  type PipelineState,
  type RenderSystem,
} from './render-system';
import {
  type HealthChangeListener,
  HealthListenerRegistry,
  type HealthSnapshot,
  LostListenerRegistry,
  type Renderer,
  type RendererErrorListener,
  type RendererLostListener,
  type RendererOptions,
  RhiErrorListenerRegistry,
} from './renderer';
import { resolveAssetHandle } from './resolve-asset-handle';
import {
  ADVANCE_ANIMATION_PLAYER_SYSTEM,
  AdvanceAnimationPlayer,
  ANIMATION_ASSET_RESOLVER_KEY,
  type AnimationAssetResolver,
  registerAdvanceAnimationPlayer,
} from './systems/advance-animation-player';
import {
  PROPAGATE_TRANSFORMS_SYSTEM,
  PropagateTransforms,
  registerPropagateTransforms,
} from './systems/propagate-transforms';
import {
  createSkinPaletteAllocator,
  type SkinPaletteAllocator,
} from './systems/skin-palette-allocator';
// feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild — auto-wire
// the per-cell entity extract pass into the per-frame draw chain so AI users
// who spawn a Tilemap + TileLayer pair get derived render entities without
// hand-driving the system (charter F1 progressive disclosure).
import { tilemapChunkExtractSystem } from './tilemap-chunk-extract-system';
import { URP_PIPELINE_ID, urpPipeline } from './urp-pipeline';
import { deriveVertexBufferLayout } from './vertex-attribute-layout';

// Re-export registerAdvanceAnimationPlayer so consumers can wire it.
// Re-export registerPropagateTransforms so consumers can wire the
// Transform.world mat4 derivation (audio listener sync + picking read the
// derived Transform.world from scripts).
export {
  ADVANCE_ANIMATION_PLAYER_SYSTEM,
  AdvanceAnimationPlayer,
  ANIMATION_ASSET_RESOLVER_KEY,
  PROPAGATE_TRANSFORMS_SYSTEM,
  PropagateTransforms,
  registerAdvanceAnimationPlayer,
  registerPropagateTransforms,
};

// feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4): a single
// shared empty ArrayBuffer used by `buildPipelineContext` to synthesize the
// 6-key VertexAttributeMap when no caller-supplied attributes are available
// for the pbr-skin path. `deriveVertexBufferLayout` is the SSOT for the layout
// (vertex-attribute-layout.ts) and reads only key presence -- value identity
// never matters -- so a zero-byte ArrayBuffer per key produces the exact
// 6-attribute / 72-byte stride layout that the @forgeax::pbr-skin shader's
// @location(0..5) declarations expect.
const PBR_SKIN_SENTINEL_ATTR_BUFFER = new ArrayBuffer(0);

/** Default 4-attribute vertex layout used as fallback when meshAttributes is undefined. */
const DEFAULT_VERTEX_ATTRS: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
};

/**
 * Bundler-layer injection accepted by `createRenderer` (and proxied by
 * `createApp`) as the optional third argument.
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: aggregates the two
 * host-injected build-tool channels:
 *
 *   - shaderManifestUrl: the URL the host's vite-plugin-shader emit step
 *     wrote `manifest.json` to. When this field is omitted (or `bundler`
 *     itself is omitted), createRenderer falls back to
 *     '/shaders/manifest.json' (D-2 q5-A) so the LO 1.1 zero-config takeoff
 *     path keeps working without explicit injection. Tests can inject via a
 *     `data:application/json,...` URL to bypass fetch.
 *
 *   - importTransport: dev-only ImportTransport forwarded verbatim to the
 *     AssetRegistry third ctor slot so DDC-miss assets can lazy-import.
 *     Absent => shipped form (a DDC miss fails fast with `asset-not-imported`).
 *
 * The interface is duplicated structurally in `@forgeax/engine-app`
 * (BundlerOptions exported from packages/app); demos consume through the app
 * package, the engine accepts via this local minimal shape so packages/runtime
 * does NOT depend on packages/app (charter P4 + reverse-coupling deny-list).
 * TypeScript structural typing makes the two interchangeable at every call
 * site (M3 forgeaxBundlerAdapter() returns the same shape).
 */
export interface BundlerOptions {
  readonly importTransport?: ImportTransport | undefined;
  readonly shaderManifestUrl?: string | undefined;
}

// ─── Backend pack — M3 auto-select internal shape ───────────────────────────

/**
 * Internal "backend pack" carries the two dynamic-import-loaded entries the
 * engine consumes (rhi singleton + the optional top-level async
 * `createShaderModule`). Defining this interface in the engine layer keeps
 * the rhi-webgpu / rhi-wgpu shim surfaces structurally aligned without
 * forcing both shims to grow an identical top-level factory — when the
 * wgpu-wasm path does not expose a top-level `createShaderModule`, the
 * facade falls back to the synchronous `device.createShaderModule` path
 * inside `makeShaderDeviceAdapter` (charter proposition 9 graceful
 * degradation).
 */
interface RhiBackendPack {
  readonly rhi: RhiInstance & {
    readonly acquireCanvasContext: (
      canvas: HTMLCanvasElement | OffscreenCanvas,
    ) => Result<RhiCanvasContext, RhiError>;
  };
  /** Async top-level shader module factory; rhi-webgpu exposes this; rhi-wgpu falls back to device.createShaderModule. */
  readonly createShaderModule?:
    | ((
        device: RhiDevice,
        desc: { code: string; label?: string | undefined },
      ) => Promise<Result<ShaderModule, RhiError>>)
    | undefined;
  /**
   * D-VD2 dispatch translator (feat-20260511-rhi-spec-realign-aggressive
   * Round 2): translates spec `GPUUncapturedErrorEvent` / `GPUDeviceLostInfo`
   * shapes into the 17-member `RhiErrorCode` union. rhi-webgpu provides this;
   * other backends (rhi-wgpu, explicit escape hatch) may omit — when undefined
   * the engine falls back to a minimal device-lost-only translator inline so
   * the AGENTS.md break-point #4 fan-out promise still holds on the lost path
   * (charter proposition 5 consistent abstraction — both `Renderer.onError`
   * channel members fire across all three load channels).
   */
  readonly translateErrorEventToRhiError?:
    | ((event: unknown) => { readonly ok: false; readonly error: RhiError })
    | undefined;
  /**
   * D-VD2 raw GPUDevice escape hatch (feat-20260511-rhi-spec-realign-aggressive
   * Round 2): given a forgeax `RhiDevice`, returns the underlying raw
   * `GPUDevice` so the engine can register `onuncapturederror` listener on
   * the spec event target. Only the rhi-webgpu pack exposes this entry; the
   * rhi-wgpu wasm pack and explicit escape hatch skip the listener
   * registration (graceful degradation — device.lost dual-channel still
   * fires through the forgeax RhiDevice.lost Promise on every path).
   * @internal
   */
  readonly _internal_getRawDevice?: ((device: RhiDevice) => unknown | undefined) | undefined;
}

/**
 * Fold a raw module object (from a static import, dynamic import, or explicit
 * escape-hatch wrapper) into a typed `RhiBackendPack` by probing for known
 * optional fields via the `'x' in mod` pattern (existing convention).
 *
 * For the explicit escape hatch (Channel 1) where the instance IS the rhi
 * singleton, wrap it as `{ rhi: instance, ...extras }` before calling this
 * helper — the function always reads `mod.rhi` for the singleton.
 *
 * @param mod Raw module object with at least `rhi: RhiInstance & { acquireCanvasContext }`
 * @returns Typed RhiBackendPack with optional fields populated when present on mod
 * @internal — exported for unit test access (w20)
 */
export function loadRhiPack(mod: Record<string, unknown>): RhiBackendPack {
  const rhi = mod.rhi as unknown as RhiBackendPack['rhi'];
  const csm =
    'createShaderModule' in mod
      ? (mod.createShaderModule as NonNullable<RhiBackendPack['createShaderModule']>)
      : undefined;
  const tx =
    'translateErrorEventToRhiError' in mod
      ? (mod.translateErrorEventToRhiError as NonNullable<
          RhiBackendPack['translateErrorEventToRhiError']
        >)
      : undefined;
  const rd =
    '_internal_getRawDevice' in mod
      ? (mod._internal_getRawDevice as NonNullable<RhiBackendPack['_internal_getRawDevice']>)
      : undefined;
  return {
    rhi,
    ...(csm !== undefined ? { createShaderModule: csm } : {}),
    ...(tx !== undefined ? { translateErrorEventToRhiError: tx } : {}),
    ...(rd !== undefined ? { _internal_getRawDevice: rd } : {}),
  };
}

/**
 * D-P4 auto-select facade — decides which @forgeax/engine-rhi-* backend implementation
 * to use at runtime.
 *
 * Priority (matches plan-strategy §6 M3 pseudocode):
 *   1. `options.rhi` (escape hatch, D-R5) — verbatim use; neither rhi backend
 *      pack is consulted.
 *   2. `'gpu' in globalThis.navigator && globalThis.navigator.gpu` →
 *      **static** `rhiWebgpu` namespace (already eager-loaded via the
 *      index.ts `acquireCanvasContext` re-export; revision F-01 cleared the
 *      Rollup `[INEFFECTIVE_DYNAMIC_IMPORT]` warning by aligning the import
 *      shape with the bundler's observed eager-load reality).
 *   3. Otherwise → dynamic `import('@forgeax/engine-rhi-wgpu')` + `await ensureReady()`
 *      (R-04 + R-05). This dynamic import remains **effective** — rhi-wgpu
 *      has no static reference in engine-runtime, so the wgpu-wasm artefact
 *      tree-shakes out of webgpu-only browser bundles.
 *
 * Returns `Result.err(RhiError)` on rhi-wgpu wasm load failure (channel (a),
 * D-P4 RK-04). AI users branch on `.code === 'rhi-not-available'` to display
 * a degradation banner or retry.
 */
async function loadBackendPack(
  options: RendererOptions | undefined,
): Promise<Result<RhiBackendPack, RhiError>> {
  // Channel 1 — escape hatch (D-R5): explicit rhi instance overrides auto-detect.
  // Cast to the extended shape; AI users supplying their own instance accept
  // that the facade may call `acquireCanvasContext` on it (charter
  // proposition 5 single-import surface).
  //
  // M4 / w25: if the explicit instance carries a top-level `createShaderModule`
  // (rhi-webgpu / rhi-wgpu both do), surface it through the pack so the
  // pipeline build step uses the async factory path symmetrically with
  // channel 2/3 — without this the escape hatch falls back to the structural
  // device probe in `invokeDeviceCreateShaderModule` which returns
  // 'rhi-not-available' for instances that keep createShaderModule on the
  // RhiInstance rather than the RhiDevice (charter proposition 5 consistent
  // abstraction across all three load channels).
  const explicit = options?.rhi;
  if (explicit !== undefined && explicit !== null) {
    // Channel 1 wraps the explicit instance as a module-shaped object so
    // loadRhiPack can probe optional fields uniformly. The instance IS the
    // rhi singleton + optionally carries createShaderModule /
    // translateErrorEventToRhiError / _internal_getRawDevice directly.
    const explicitMod: Record<string, unknown> = { rhi: explicit };
    const extras = explicit as unknown as Record<string, unknown>;
    if ('createShaderModule' in extras) explicitMod.createShaderModule = extras.createShaderModule;
    if ('translateErrorEventToRhiError' in extras)
      explicitMod.translateErrorEventToRhiError = extras.translateErrorEventToRhiError;
    if ('_internal_getRawDevice' in extras)
      explicitMod._internal_getRawDevice = extras._internal_getRawDevice;
    return ok(loadRhiPack(explicitMod));
  }

  // Channel 2 — navigator.gpu present → rhi-webgpu (no wasm download; AC-11).
  //
  // Revision F-01 (post-implement-review): switched from `await import(...)`
  // to the static `rhiWebgpu` namespace re-binding. `engine-runtime/src/
  // index.ts` already does `export { acquireCanvasContext } from
  // '@forgeax/engine-rhi-webgpu'` (M3 D-P3 single-entry SSOT), which makes
  // rhi-webgpu a static dependency of the runtime bundle. Rollup correctly
  // flagged the combined static + dynamic edges with
  // [INEFFECTIVE_DYNAMIC_IMPORT] (AC-16(b)). The dynamic shape was strictly
  // a notation mismatch: rhi-webgpu was always eager-loaded in practice.
  // Channel 3 (rhi-wgpu) retains its dynamic import — that one IS effective.
  //
  const nav: { gpu?: unknown } | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: { gpu?: unknown } }).navigator
      : undefined;
  if (nav !== undefined && 'gpu' in nav && nav.gpu !== undefined && nav.gpu !== null) {
    // Channel 2 — rhi-webgpu D-VD2 Round 2: the namespace carries rhi +
    // createShaderModule + translateErrorEventToRhiError + _internal_getRawDevice.
    // loadRhiPack probes all optional fields uniformly.
    return ok(loadRhiPack(rhiWebgpu as unknown as Record<string, unknown>));
  }

  // Channel 3 — navigator.gpu absent → rhi-wgpu lazy load (R-04 + R-05).
  try {
    const mod = (await import('@forgeax/engine-rhi-wgpu')) as Record<string, unknown>;
    const ensureReady = mod.ensureReady as () => Promise<unknown>;
    await ensureReady();
    // loadRhiPack probes rhi + optional fields (createShaderModule /
    // translateErrorEventToRhiError / _internal_getRawDevice) uniformly.
    return ok(loadRhiPack(mod));
  } catch (loadError) {
    const detail = loadError instanceof Error ? loadError.message : String(loadError);
    // Bundle size literal stays anchored to the M5 metrics baseline
    // (0.51 MB = 536512 bytes gzip per report/rhi-wgpu/bundle-size.json +
    // AGENTS.md ## RHI / WebGPU dual-impl stance line 130 SSOT). w54 round 2
    // fix-up F-1 closure aligned this literal with packages/rhi-wgpu/src/
    // errors.ts so AI consumers of err.hint see one bundle-size figure
    // regardless of which fault site triggers the rhi-not-available code
    // (charter proposition 3 machine-readable SSOT).
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'either navigator.gpu available OR @forgeax/engine-rhi-wgpu wasm bundle loadable',
        hint: `failed to load @forgeax/engine-rhi-wgpu wasm bundle (0.51 MB gzip per M5 bundle-size baseline); check network connectivity or use createRenderer(canvas, { rhi: explicitInstance }) escape hatch (cause: ${detail})`,
      }),
    );
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Async factory: probes WebGPU (channel 2: rhi-webgpu, channel 3: rhi-wgpu);
 * returns a fully-initialized Renderer or throws `EngineEnvironmentError`.
 *
 * Channel priority (bug-20260526-channel2-adapter-fail-no-channel3-fallback):
 *   1. `options.rhi` → escape hatch (D-R5), verbatim use.
 *   2. `navigator.gpu` present → static `rhiWebgpu` namespace.
 *      If adapter/device/context fails → falls back to channel 3.
 *   3. Dynamic `import('@forgeax/engine-rhi-wgpu')` + wasm load.
 *   4. All fail → throw `EngineEnvironmentError` with `detail.webgpuError`
 *      + `detail.wgpuError`.
 *
 * @param canvas HTMLCanvasElement | OffscreenCanvas — render surface.
 * @param options RendererOptions — clear color / shader manifest URL /
 *                D-S1 raw-device single-point exemption / M3 `rhi` escape hatch.
 *
 * **Error propagation — three channels (D-P4 RK-04):**
 *   (a) Construction-time: this Promise rejects with `EngineEnvironmentError`
 *       whose `detail.webgpuError` is the Channel 2 `RhiError` and
 *       `detail.wgpuError` is the Channel 3 failure (when both fail).
 *   (b) Run-time pipeline build: `renderer.ready` rejects with a
 *       structured `RhiError` once the dynamic-import path is past.
 *   (c) Fan-out observability: `renderer.onError(listener)` captures the
 *       same errors as a fallback channel.
 *
 * @throws {EngineEnvironmentError} when no backend is usable.
 */

/**
 * Per-variant PipelineLayout selector (M4.5 / D-10 option A).
 *
 * The HDRP variant (`CLUSTER_FORWARD_AVAILABLE=true` or canonical `''`
 * all-true when the shader declares the cluster axis) needs the 7-slot
 * group(2) BGL chain (`hdrpPbrPipelineLayout`); URP variants
 * (`CLUSTER_FORWARD_AVAILABLE=false` / undefined / no axis) keep the
 * 1-slot mesh-array BGL chain (`pbrPipelineLayout`).
 *
 * Returns `null` only when the URP fallback layout itself is null
 * (Camera-only / empty-manifest path). When the HDRP layout is null but
 * URP exists, the HDRP variant gracefully falls back to URP — the WGSL
 * resolved upstream by `findVariantByKey` is the URP variant in that
 * case (manifest entry with all-true definesKey === '' was registered
 * with isHdrpActive=false at boot when storage-buffer caps are absent).
 *
 * Pure function — exported for unit-test access (M4.5 / w35).
 */
/**
 * Closed enum of pipeline-layout kinds the selector can dispatch to.
 *
 * `pbr` — standard PBR (1-entry mesh-array BGL).
 * `pbr-skin` — bug-20260611-skin-pipeline-layout: 2-entry mesh-array BGL
 *   (binding 0 meshes + binding 1 palette) for the `forgeax::pbr-skin`
 *   material shader.
 * `hdrp-pbr` — feat-20260609 HDRP cluster-forward variant (7-slot group(2)
 *   BGL substituted at slot 2).
 *
 * AC-09 grep gate: the selector body (`selectPipelineLayoutForVariant`)
 * **MUST NOT** contain literal `'forgeax::pbr-skin'` (or any other
 * shader-id literal). The caller resolves `LayoutKind` upstream and passes
 * the structured value through (charter P4 consistent abstraction). New
 * material-shader layouts add a `LayoutKind` member + a PipelineState slot
 * + a switch arm here in one cut (charter P3 extensibility).
 */
export type LayoutKind = 'pbr' | 'pbr-skin' | 'hdrp-pbr';

export function selectPipelineLayoutForVariant(
  state: {
    readonly pbrPipelineLayout: PipelineLayout | null;
    readonly hdrpPbrPipelineLayout: PipelineLayout | null;
    readonly pbrSkinPipelineLayout: PipelineLayout | null;
  } | null,
  variantSet: string | undefined,
  layoutKind?: LayoutKind,
): PipelineLayout | null {
  if (state === null) return null;
  // bug-20260611: skin layout selection takes precedence over HDRP variant
  // resolution. HDRP × skin is OOS-1 (plan-strategy R-2 — left for a
  // dedicated feat); when an HDRP-variant skin call ever lands, we fail
  // fast with `null` rather than silently returning the URP layout
  // (charter P3 explicit failure, mirrors memory anchor
  // `hdrp-active-must-not-fallback-to-urp-pipeline`).
  if (layoutKind === 'pbr-skin') {
    return state.pbrSkinPipelineLayout;
  }
  // HDRP variant matches when:
  //   - layoutKind === 'hdrp-pbr' (caller-driven, future-proof), OR
  //   - variantSet is the canonical all-true key '' (boot-time HDRP
  //     registration produces '' when both axes resolve to true), OR
  //   - variantSet contains `CLUSTER_FORWARD_AVAILABLE=true` substring
  //     (record-stage caller emits the expanded form).
  // URP variants have CLUSTER_FORWARD_AVAILABLE=false explicitly, or omit
  // the axis altogether, or pass undefined (no variant routing).
  // G-14 (D-11): empty-string is the canonical all-true HDRP key, so we
  // explicitly distinguish '' vs undefined rather than using an optional-chain
  // (charter P3: explicit failure / no implicit empty-vs-missing collapse).
  const isHdrpVariant =
    layoutKind === 'hdrp-pbr' ||
    variantSet === '' ||
    // biome-ignore lint/complexity/useOptionalChain: G-14 grep gate forbids the optional-chain falsy collapse on variantSet.
    (variantSet !== undefined && variantSet.includes('CLUSTER_FORWARD_AVAILABLE=true'));
  if (isHdrpVariant && state.hdrpPbrPipelineLayout !== null) {
    return state.hdrpPbrPipelineLayout;
  }
  return state.pbrPipelineLayout;
}

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options?: RendererOptions,
  // feat-20260608-create-app-param-surface-trim / M2 / D-3: the third arg is
  // now BundlerOptions -- the build-tool injection channel that aggregates
  // (a) shaderManifestUrl (vite-plugin-shader emit URL) and (b) importTransport
  // (dev-only AssetRegistry transport from feat-20260604). Both fields
  // optional so {} is a valid call shape. Absent => both shipped-form
  // fallbacks fire: shaderManifestUrl falls back to '/shaders/manifest.json'
  // (D-2 q5-A, ~30 lines below); importTransport stays undefined (AssetRegistry
  // shipped form, DDC miss fails fast with `asset-not-imported`, AC-08).
  //
  // The interface lives in @forgeax/engine-app to keep host-injection types
  // colocated with createApp; createRenderer accepts a structurally-compatible
  // local minimal shape so packages/runtime does NOT depend on packages/app
  // (charter P4 layering, R-4 reverse-coupling deny-list).
  bundler?: BundlerOptions,
): Promise<Renderer> {
  // D-P4 auto-select — backend selection happens BEFORE context acquisition
  // (w19 / M4). `loadBackendPack` reads navigator.gpu and returns either the
  // rhi-webgpu static pack (Channel 2) or the rhi-wgpu dynamic-import pack
  // (Channel 3). `tryCreateWebGPURenderer` then calls
  // `pack.rhi.acquireCanvasContext(canvas)` which polymorphically routes to:
  //   Channel 2: rhi-webgpu internally calls canvas.getContext('webgpu')
  //   Channel 3: rhi-wgpu internally calls wasm createSurface(canvas)
  // Neither getContext nor wasm surface is invoked until after the pack is
  // selected (charter P4 consistent abstraction).
  const packResult = await loadBackendPack(options).catch((e: unknown) => {
    const errMsg = e instanceof Error ? e.message : String(e);
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected:
          'rhi-webgpu static namespace OR dynamic import of @forgeax/engine-rhi-wgpu succeeds',
        hint: `unexpected exception during backend-pack load: ${errMsg}`,
      }),
    );
  });
  if (!packResult.ok) {
    throw new EngineEnvironmentError('rhi backend pack load failed', {
      webgpuError: packResult.error,
    });
  }
  const pack = packResult.value;
  const webgpuOutcome = await tryCreateWebGPURenderer(canvas, options, pack, bundler).catch(
    (e: unknown) => {
      return { kind: 'throw' as const, error: toError(e) };
    },
  );
  if (webgpuOutcome.kind === 'ok') {
    return webgpuOutcome.renderer;
  }

  // Collect the structured error for the EngineEnvironmentError detail.
  // D-1: on the context-null path, webgpuError is undefined (no synthetic
  // RhiError wrapping — context-null is upstream of rhi-wgpu).
  let webgpuError: RhiError | Error | undefined;
  if (webgpuOutcome.kind === 'rhi-err') {
    webgpuError = webgpuOutcome.error;
  } else if (webgpuOutcome.kind === 'throw') {
    webgpuError = webgpuOutcome.error;
  }

  // Channel 2 to Channel 3 fallback (bug-20260526):
  // `navigator.gpu` present does not guarantee adapter availability;
  // `requestAdapter()` may return null in headless Chrome, remote
  // servers, or iframe sandboxes. When Channel 2 fails AND the pack was
  // NOT from the escape-hatch (`options.rhi`), dynamically import
  // `@forgeax/engine-rhi-wgpu` and retry renderer creation.
  const isEscapeHatch = options?.rhi !== undefined && options?.rhi !== null;
  if (!isEscapeHatch) {
    try {
      const mod = (await import('@forgeax/engine-rhi-wgpu')) as Record<string, unknown>;
      const ensureReady = mod.ensureReady as () => Promise<unknown>;
      await ensureReady();
      const wgpuPack = loadRhiPack(mod);
      const wgpuOutcome = await tryCreateWebGPURenderer(canvas, options, wgpuPack, bundler).catch(
        (e: unknown) => {
          return { kind: 'throw' as const, error: toError(e) };
        },
      );
      if (wgpuOutcome.kind === 'ok') {
        return wgpuOutcome.renderer;
      }
      // Channel 3 also failed — compound error with both failure details.
      let wgpuError: RhiError | Error | undefined;
      if (wgpuOutcome.kind === 'rhi-err') {
        wgpuError = wgpuOutcome.error;
      } else if (wgpuOutcome.kind === 'throw') {
        wgpuError = wgpuOutcome.error;
      }
      // bug-20260610: when both channels fail with environmental codes
      // (adapter-unavailable / rhi-not-available), append browser-config guidance
      // so AI users do not chase non-existent GPU bugs (Edge with WebGPU flag
      // disabled is the canonical case — see composeEnvErrorHint JSDoc).
      const envHint = composeEnvErrorHint(webgpuError, wgpuError);
      const baseReason = classifyEnvErrorReason(
        'no usable rendering backend',
        webgpuError ?? wgpuError,
      );
      throw new EngineEnvironmentError(
        envHint !== undefined ? `${baseReason}; ${envHint}` : baseReason,
        {
          ...(webgpuError !== undefined ? { webgpuError } : {}),
          ...(wgpuError !== undefined ? { wgpuError } : {}),
        },
      );
    } catch (channel3Error) {
      // Channel 3 dynamic import / ensureReady threw — compound error.
      if (channel3Error instanceof EngineEnvironmentError) {
        throw channel3Error;
      }
      const wgpuError =
        channel3Error instanceof Error ? channel3Error : new Error(String(channel3Error));
      const envHint = composeEnvErrorHint(webgpuError, wgpuError);
      const baseReason = classifyEnvErrorReason(
        'no usable rendering backend (Channel 3 fallback failed)',
        webgpuError ?? wgpuError,
      );
      throw new EngineEnvironmentError(
        envHint !== undefined ? `${baseReason}; ${envHint}` : baseReason,
        {
          ...(webgpuError !== undefined ? { webgpuError } : {}),
          wgpuError,
        },
      );
    }
  }

  throw new EngineEnvironmentError(
    classifyEnvErrorReason('no usable rendering backend', webgpuError),
    {
      ...(webgpuError !== undefined ? { webgpuError } : {}),
    },
  );
}

// ─── WebGPU branch ──────────────────────────────────────────────────────────

/**
 * Wire the spec `device.lost` Promise into the lost / error / health channels
 * (research §F-4 / R2). D-VD2 Round 2: the same event fans out through
 * `errorRegistry` so `renderer.onError(err => switch err.code { 'device-lost' })`
 * triggers, and through `healthRegistry` so `health().reason` flips to
 * `'device-lost'` (feat-20260622-s5 M1/M2).
 *
 * Extracted to a single helper (SSOT) so the createRenderer assembly path AND
 * the recover() rebuild path attach byte-identical fan-out to whichever device
 * is current — recover() mints a fresh device whose own `lost` Promise must be
 * re-wired to the SAME registries the host already subscribed to.
 */
function attachDeviceLostFanout(
  device: RhiDevice,
  pack: RhiBackendPack,
  registries: {
    lostRegistry: LostListenerRegistry;
    errorRegistry: RhiErrorListenerRegistry;
    healthRegistry: HealthListenerRegistry;
  },
): void {
  const { lostRegistry, errorRegistry, healthRegistry } = registries;
  device.lost
    .then((info) => {
      const safe = {
        reason: info?.reason ?? 'unknown',
        message: info?.message ?? '',
      };
      lostRegistry.fire(safe);
      // Health channel fan-out: safe.reason is 'unknown' | 'destroyed' per
      // RhiDevice.lost return type, matching HealthDetailDeviceLost.lostReason
      // with no narrowing cast needed (plan-decisions D-6 / OOS-1).
      //
      // requirements A constraint (W3C spec assumption): `reason ===
      // 'destroyed'` is INTENTIONAL teardown (host/driver called
      // device.destroy() -- e.g. renderer.dispose(), browser tab recycle,
      // or test-isolation device pooling), NOT a recoverable fault. It must
      // NOT flip health to 'device-lost' (which would make draw() refuse via
      // the M2 guard and invite a spurious recover()). The lost + error
      // channels still fire below so AI users observe the teardown; only the
      // health channel (which drives the draw guard + recover eligibility)
      // is gated. Genuine unrecoverable loss surfaces as reason 'unknown'.
      if (safe.reason !== 'destroyed') {
        healthRegistry.fire({
          reason: 'device-lost',
          detail: { lostReason: safe.reason, message: safe.message },
          recoverable: true,
        });
      }
      // Dual-channel fan-out: translate to RhiError + fire errorRegistry.
      // When pack.translateErrorEventToRhiError is unavailable (e.g. explicit
      // escape-hatch instance that omits the translator), build a minimal
      // device-lost RhiError inline so the wire-up promise still holds on
      // the lost path (graceful degradation; charter proposition 5).
      if (pack.translateErrorEventToRhiError) {
        const translated = pack.translateErrorEventToRhiError(safe);
        errorRegistry.fire(translated.error);
      } else {
        errorRegistry.fire(
          new RhiError({
            code: 'device-lost',
            expected: 'device must remain alive (driver / browser must not destroy the GPUDevice)',
            hint: `device-lost reason: ${safe.reason}; message: ${safe.message || '<empty>'}`,
          }),
        );
      }
    })
    .catch((err: unknown) => {
      lostRegistry.fire({ reason: 'unknown', message: String(err) });
      healthRegistry.fire({
        reason: 'device-lost',
        detail: { lostReason: 'unknown', message: String(err) },
        recoverable: true,
      });
      errorRegistry.fire(
        new RhiError({
          code: 'device-lost',
          expected: 'device.lost Promise resolves with GPUDeviceLostInfo',
          hint: `device.lost Promise rejected unexpectedly: ${String(err)}`,
        }),
      );
    });
}

/**
 * tryCreateWebGPURenderer returns three kinds of outcome (fix-f1 / w16):
 * - `ok`           → Renderer created successfully
 * - `rhi-err`      → RHI Result.err path (preserves the original RhiError
 *                    for AI consumers to read; now includes context acquisition
 *                    failures via pack.rhi.acquireCanvasContext)
 * - `throw`        → exception path (caught and wrapped by the caller as
 *                    an Error)
 */
type WebGPUOutcome =
  | { kind: 'ok'; renderer: Renderer }
  | { kind: 'rhi-err'; error: RhiError }
  | { kind: 'throw'; error: Error };

/**
 * Goes through the strict two-step path injected by `@forgeax/engine-rhi-webgpu`:
 *   `rhi.requestAdapter()` -> `adapter.requestDevice()`
 * (M6 fix-up [w51] retires the legacy single-step factory per plan-strategy
 * §6 M3 break-point #2 + AGENTS.md break-point list 2026-05-10 #2). Returns
 * `Result<RhiAdapter, RhiError>` then `Result<RhiDevice, RhiError>`; any
 * failure / failure to acquire the canvas WebGPU context returns a
 * structured outcome so the caller can decide on fallback and error-
 * preservation strategy (plan-strategy §7.3).
 *
 * fix-f1: on either Result.err path the original `RhiError` is preserved
 * via the `rhi-err` outcome — when fallback also fails, AI consumers read
 * it via `EngineEnvironmentError.detail.webgpuError.code`.
 *
 * w19 / M4: context acquisition goes through `pack.rhi.acquireCanvasContext(canvas)`
 * — a polymorphic entry that routes to canvas.getContext('webgpu') in
 * rhi-webgpu (Channel 2) or wasm createSurface in rhi-wgpu (Channel 3).
 * The backend pack is selected BEFORE this call (in `loadBackendPack` /
 * the Channel 2→3 fallback in `createRenderer`), so the canvas context
 * is never type-locked by a wrong backend's acquisition attempt.
 */
async function tryCreateWebGPURenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: RendererOptions | undefined,
  pack: RhiBackendPack,
  // feat-20260608 M2 / D-3: BundlerOptions threaded verbatim. Carries
  // shaderManifestUrl (consumed in getShader fallback ~30 lines below) and
  // importTransport (forwarded to the AssetRegistry third ctor slot;
  // undefined keeps the shipped form, AC-08).
  bundler: BundlerOptions | undefined,
): Promise<WebGPUOutcome> {
  const importTransport = bundler?.importTransport;
  // M6 fix-up [w51]: spec-aligned two-step path. Step 1 - requestAdapter()
  // surfaces adapter.features / adapter.limits (capability pre-screen,
  // charter proposition 4 forward-reachable). Step 2 - adapter.requestDevice()
  // requests the actual device. M3 D-P4: `pack.rhi` is the auto-selected
  // backend singleton (rhi-webgpu / rhi-wgpu / explicit escape hatch).
  // w19: thread canvas as compatibleSurface so the wgpu GL backend can
  // enumerate adapters against it (escape hatch, capability-gated).
  const adapterResult = await pack.rhi.requestAdapter(undefined, canvas);
  if (!adapterResult.ok) {
    return { kind: 'rhi-err', error: adapterResult.error };
  }
  const adapter = adapterResult.value;
  const result = await adapter.requestDevice();
  if (!result.ok) {
    return { kind: 'rhi-err', error: result.error };
  }
  const device: RhiDevice = result.value;

  // Acquire the canvas context through the backend pack (M3 / w16).
  // rhi-webgpu: internally calls canvas.getContext('webgpu') + branded wrap.
  // rhi-wgpu: internally calls wasm createSurface(canvas) + configure.
  // When context acquisition fails (null from canvas.getContext or wasm
  // createSurface throws), the pack returns Result.err(RhiError).
  const ctxResult = pack.rhi.acquireCanvasContext(canvas);
  if (!ctxResult.ok) {
    return { kind: 'rhi-err', error: ctxResult.error };
  }
  const context: RhiCanvasContext = ctxResult.value;

  const lostRegistry = new LostListenerRegistry();
  const errorRegistry = new RhiErrorListenerRegistry();
  const healthRegistry = new HealthListenerRegistry();
  // device.lost dual-track (research §F-4 / R2 countermeasure): the spec
  // Promise is passed through to the lost-fan-out registry (extracted to
  // attachDeviceLostFanout so the recover() rebuild path re-attaches the
  // SAME wiring to the freshly-minted device — SSOT, one fan-out shape).
  attachDeviceLostFanout(device, pack, { lostRegistry, errorRegistry, healthRegistry });

  // D-VD2 Round 2 wire-up part 2: register the spec `onuncapturederror`
  // listener on the raw GPUDevice so GPUUncapturedErrorEvent (validation /
  // oom / internal) is translated to the 17-member RhiErrorCode union +
  // dispatched through `Renderer.onError`. When the pack does not expose a
  // raw-device escape hatch (rhi-wgpu wasm path, custom escape hatch), the
  // listener registration is skipped — the device.lost dual-channel above
  // still fires through `RhiDevice.lost` Promise on every path (graceful
  // degradation per charter proposition 9; per-path coverage matrix in
  // packages/engine/README.md `## Error model`).
  if (pack._internal_getRawDevice && pack.translateErrorEventToRhiError) {
    const rawDeviceForErrors = pack._internal_getRawDevice(device);
    if (rawDeviceForErrors && typeof rawDeviceForErrors === 'object') {
      const target = rawDeviceForErrors as {
        onuncapturederror?: ((event: unknown) => void) | null;
      };
      // Spec form: `device.onuncapturederror = (event) => ...`. The listener
      // sets a property handler (spec normative GPUDevice extends EventTarget
      // and exposes `onuncapturederror` as a settable callback property);
      // engine writes through the property so any pre-existing handler that
      // an AI user assigned would be replaced (last-write-wins; spec lifetime
      // is device-scoped so engine ownership is OK — AI users observe via
      // `Renderer.onError` not the raw property).
      target.onuncapturederror = (event: unknown): void => {
        const translated = pack.translateErrorEventToRhiError?.(event);
        if (translated && !translated.ok) {
          errorRegistry.fire(translated.error);
        }
      };
    }
  }
  // D-S1 single-point exemption threading: forward rawDevice from
  // RendererOptions into internals so webgpu-backend.ts can use the
  // GPUCanvasContext.configure({device}) path. Accepts either a direct
  // value or a thunk - the thunk form lets callers wrap the
  // rhi.requestAdapter -> adapter.requestDevice two-step (so the raw
  // device is captured during this function's awaits above) and still get
  // the captured value at draw time. Evaluated lazily here, after both
  // requestAdapter and requestDevice have settled.
  const rawDeviceCandidate = options?.rawDeviceForContextConfigure;
  const rawDevice =
    typeof rawDeviceCandidate === 'function'
      ? (rawDeviceCandidate as () => unknown | undefined)()
      : rawDeviceCandidate;
  return {
    kind: 'ok',
    renderer: await makeWebGPURenderer({
      canvas,
      device,
      context,
      options,
      bundler,
      lostRegistry,
      errorRegistry,
      healthRegistry,
      pack,
      importTransport,
      ...(rawDevice !== undefined ? { rawDevice } : {}),
    }),
  };
}

interface WebGPURendererInternals {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  device: RhiDevice;
  // M6 / w41 (feat-20260510-rhi-resource-creation): forgeax RhiCanvasContext
  // brand; RenderSystem + ensureContextConfigured both go through the RHI
  // surface (charter proposition 5 consistent abstraction red line).
  context: RhiCanvasContext;
  options: RendererOptions | undefined;
  /**
   * feat-20260608-create-app-param-surface-trim / M2 / D-3: BundlerOptions
   * forwarded verbatim from createRenderer's third arg. Carries
   * shaderManifestUrl (host-injected vite-plugin-shader emit URL; absent =>
   * createRenderer falls back to '/shaders/manifest.json') and the
   * importTransport that previously rode a dedicated internal slot.
   */
  bundler: BundlerOptions | undefined;
  lostRegistry: LostListenerRegistry;
  errorRegistry: RhiErrorListenerRegistry;
  healthRegistry: HealthListenerRegistry;
  /** M3 D-P4 auto-select pack — carries the dynamic-imported rhi-webgpu / rhi-wgpu singleton + optional async shader factory. */
  pack: RhiBackendPack;
  /**
   * Legacy D-S1 single-point exemption channel (feat-20260508-rhi-surface-completion
   * / w9). After M6 the canvas-context configure path goes through
   * `RhiCanvasContext.configure({ device: RhiDevice, ... })` (the shim
   * resolves to the underlying raw GPUDevice via RAW_DEVICE_MAP), so this
   * field is retained only for backwards compatibility with callers that
   * still pass `RendererOptions.rawDeviceForContextConfigure` (now
   * effectively a no-op on the RHI path).
   */
  rawDevice?: unknown;
  /**
   * feat-20260604-hdr-equirect-cube-importer-loader M4 / w16 (D-3): the
   * dev-only ImportTransport, forwarded verbatim from createRenderer to the
   * AssetRegistry third ctor slot. `undefined` keeps the shipped form (DDC
   * miss fails fast with `asset-not-imported`, AC-08).
   */
  importTransport?: ImportTransport | undefined;
  /**
   * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-05:
   * mesh-SSBO grow hook surfaced by `makeWebGPURenderer` after the controller
   * is constructed. Undefined before `makeWebGPURenderer` runs; populated by
   * the time the renderer is returned to the caller. M3's record stage reads
   * this field via the runtime path that bridges into render-system-record.ts
   * (the bridging plumbing is in M3's targetFiles).
   *
   * Returns `{ ok: true }` when the grow completed (or short-circuited
   * idempotently); `{ ok: false, code }` with a fired structured error
   * (`MeshSsboCeilingReachedError` or `MeshSsboCapacityExceededError`) when
   * the request cannot be satisfied. Never throws (D-5).
   */
  growMeshSsbo?: (neededSlots: number) => MeshSsboGrowResult;
  /**
   * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
   * read-only handle to the grow controller's state (slotCount + wrapper
   * refs), surfaced alongside `growMeshSsbo` so `ensureMeshSsboCapacity`
   * (record-stage wiring) can short-circuit when slotCount already covers the
   * frame's renderable count and so the dev-mode info log can report the
   * before/after slot count transition. Undefined until buildReadyWebGPU
   * has wired the controller; identity stable across grow events.
   */
  meshSsboState?: MeshSsboState;
}

async function makeWebGPURenderer(internals: WebGPURendererInternals): Promise<Renderer> {
  let disposed = false;
  // Lazy ShaderRegistry instance (plan-strategy section S-10 / D-R10 / OQ-5
  // close): constructed on first access; subsequent accesses return the
  // same instance.
  let shaderInstance: ShaderRegistry | null = null;
  // feat-20260523-shader-template-instance-split M9-T03 (D-PipelineBuilder):
  // the ShaderRegistryDevice adapter is created once and shared between the
  // ShaderRegistry instance (manifest hash -> ShaderModule) AND the M9
  // per-MaterialShader pipeline cache (materialShaderId -> RenderPipeline).
  // Sharing the adapter reuses the underlying async module-compile cache
  // (moduleCache + errorCache + pending Set inside makeShaderDeviceAdapter),
  // so a user shader registered at app boot incurs exactly one async
  // compile across both paths (charter P4 consistent abstraction +
  // architecture-principles #6 idempotency).
  let sharedShaderModuleAdapter: ShaderDeviceAdapterInternal | null = null;
  const getShaderModuleAdapter = (): ShaderDeviceAdapterInternal => {
    if (sharedShaderModuleAdapter === null) {
      sharedShaderModuleAdapter = makeShaderDeviceAdapter(
        internals.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
      );
    }
    return sharedShaderModuleAdapter;
  };
  const getShader = (): ShaderRegistry => {
    if (shaderInstance === null) {
      // feat-20260608-create-app-param-surface-trim / M2 / D-2 q5-A:
      // shaderManifestUrl moved to BundlerOptions (third arg). The fallback
      // literal '/shaders/manifest.json' stays here so the LO 1.1
      // hello-window zero-config takeoff path keeps working without any
      // bundler injection. The 'shaderManifestUrl' in (...) check preserves
      // the zero-entry opt-in: explicitly passing
      // `bundler: { shaderManifestUrl: undefined }` retains the
      // old "no manifest fetched" mode used by tests / camera-only worlds.
      const bundler = internals.bundler;
      const explicitUrl = bundler?.shaderManifestUrl;
      shaderInstance = new ShaderRegistry({
        device: getShaderModuleAdapter(),
        manifestUrl:
          bundler !== undefined && 'shaderManifestUrl' in bundler
            ? explicitUrl
            : '/shaders/manifest.json',
      });
    }
    return shaderInstance;
  };
  // D-S9: AssetRegistry instance shared with RenderSystem. RenderSystem
  // looks up MeshFilter.assetHandle here per frame; buildReadyWebGPU step 3
  // uploads the registry's builtin mesh geometry to GPU buffers so the
  // RenderSystem can route MeshFilter.assetHandle to a real (vbo, ibo) pair.
  //
  // feat-20260527 M1 / w1: ShaderRegistry is now eager-constructed and
  // constructor-injected into AssetRegistry (plan-strategy D-1). The
  // ShaderRegistryDevice adapter (shared between SR and per-MaterialShader
  // pipeline cache) is already available at this point.
  const shaderRegistry = getShader();

  // feat-20260528-material-shader-registration-unification M3 / w14:
  // placeholder hardcoded registerMaterialShader calls deleted.
  //
  // bug-20260601-hello-tonemap-material-register M1 (plan-strategy D-1):
  // All material-shader entries are now registered from the manifest
  // BEFORE the renderer is returned, so `register<MaterialAsset>` referencing
  // an engine shader succeeds without waiting for `renderer.ready`.

  // feat-20260623-asset-payload-generic-open-registry M3 / w10: host apps
  // that need custom loaders register them on `assets.loaders.register(...)`.
  // feat-20260604-hdr-equirect-cube-importer-loader M4 / w16 (D-3 / AC-05):
  // the host-injected ImportTransport (or undefined for the shipped form) is
  // threaded into the AssetRegistry ctor -- the construction-time-
  // only single injection point (no setter, no illegal intermediate state).
  const assets = new AssetRegistry(shaderRegistry, internals.importTransport);
  // feat-20260601-gpu-resource-store-extraction M1: the GPU residency layer
  // lives in a standalone store; `assets` keeps the CPU POD registry only.
  const gpuStore = new GpuResourceStore();
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): transient per-frame
  // video texture store, fully independent of gpuStore (AC-08). Configured with
  // the device alongside gpuStore below; threaded into the record stage via the
  // RenderSystemRuntime so a `videoTextureFields` material field uploads its
  // frame here instead of entering the static ensureResident cache.
  const dynamicTextureStore = new DynamicTextureStore();
  // feat-20260527-sprite-nineslice M4 / w16 (D-5): per-Renderer EngineMetrics
  // counter. Surfaced through `renderer.metrics` and threaded to the record
  // stage via `RenderSystemRuntime.metrics` so soft-warns
  // (`nineslice.scale-too-small`, `nineslice.tile-needs-repeat-sampler`) bump
  // counters AI users read with `renderer.metrics.snapshot()` (charter P3
  // machine-readable signals over a per-frame console.warn flood). Each
  // Renderer instance owns its own counter Map (D-5 candidate 1 isolation).
  const metrics = createEngineMetrics();
  // feat-20260527-sprite-nineslice M4 / w18 prep (D-9): hand the same
  // EngineMetrics instance to AssetRegistry so register-time soft-warns
  // (sliceMode=1 + sampler.addressMode !== 'repeat') bump
  // 'nineslice.tile-needs-repeat-sampler' on the SAME counter the runtime
  // reads.
  assets.setMetrics(metrics);

  // M1 (bug-20260601-hello-tonemap-material-register D-1/D-2): prepare
  // engine-shipped material shaders (cap gate + manifest load + registration)
  // so they are available in ShaderRegistry before `register<MaterialAsset>`.
  // Failures throw structured RhiError / ShaderError through `createRenderer`.
  await prepareMaterialShaders(internals.device, getShader, assets);
  // M5 wiring (feat-20260517-vite-plugin-image-build-time-cook w14b): hand
  // the RhiDevice to the AssetRegistry so `loadByGuid<TextureAsset>` ->
  // `loadTextureFromEntry` -> `uploadTexture` actually runs the GPU
  // upload step plan-strategy section 3.2 sequence specifies. Without
  // this call uploadTexture step 3 short-circuits with `Result.ok(undefined)`
  // and the render-system materialBindGroup falls through to the 1x1
  // white fallback view (charter P3 violation: silent loss of texture).
  // bug-20260518 D-1: configureGpuDevice gains a 2nd parameter --
  // `pack.createShaderModule`, the top-level async shader-module factory
  // (rhi-webgpu / rhi-wgpu both expose it). The runtime mipmap utility uses
  // this factory inside `generateMipmaps` instead of the (now-deleted)
  // synchronous `device.createShaderModule` member. The parameter is
  // structurally optional at this call-site so the explicit-rhi escape
  // hatch (D-R5) without a top-level factory still routes through the
  // existing `invokeDeviceCreateShaderModule` fallback in
  // buildReadyWebGPU; AssetRegistry.uploadTexture's mipmap branch surfaces
  // the missing-factory case as a structured `rhi-not-available` error
  // (charter P3 explicit failure) rather than throwing here.
  //
  // The factory's pack signature accepts a fully-typed `RhiDevice`, while
  // `MipmapShaderModuleFactory` declares its `device` parameter as the
  // narrower `MipmapDevice` subset. At runtime the value handed in IS a
  // real `RhiDevice` (same `internals.device` cast on the line below), so
  // the structural cast is sound; TS rejects only because function-param
  // contravariance is strict. No new cast lands on `internals.device`.
  const packShaderFactory = internals.pack.createShaderModule;
  // The RhiDevice surface satisfies `MipmapBlitDevice` (createTexture +
  // createTextureView + createCommandEncoder + createBindGroup +
  // queue.submit + queue.writeTexture all live on RhiDevice).
  // feat-20260601-gpu-resource-store-extraction M1 (D-3 / D-8): device +
  // shader-module factory + cube-POD register relay are wired onto the store
  // together. feat-20260614 M8 (D-15 / D-17): `registerCube` is the wire-layer
  // closure `(world, pod) => world.allocSharedRef('CubeTextureAsset', pod)` --
  // the runtime-minted cube POD lands in the draw-time world's user-tier
  // SharedRefStore (the AssetRegistry owns no handles). The store passes the
  // draw-time world through at `uploadCubemapFromEquirect` time.
  gpuStore.configureGpuDevice(
    // biome-ignore lint/suspicious/noExplicitAny: MipmapBlitDevice descriptors are typed `any`; RhiDevice satisfies the shape
    internals.device as any,
    packShaderFactory as unknown as MipmapShaderModuleFactory | undefined,
    (world, pod) => {
      let handle: Handle<'CubeTextureAsset', 'shared'>;
      handle = world.allocSharedRef('CubeTextureAsset', pod, () => {
        gpuStore.evictCubemap(handleSlot(handle));
      });
      return ok(handle);
    },
    internals.device.caps,
  );
  // feat-20260623-world-space-video-asset M4 / w16 (D-3): wire the same device
  // into the transient video texture store (createTexture / createTextureView /
  // destroyTexture / queue.copyExternalImageToTexture all live on RhiDevice).
  dynamicTextureStore.configureGpuDevice(
    // biome-ignore lint/suspicious/noExplicitAny: DynamicTextureDevice is a structural subset of RhiDevice
    internals.device as any,
  );
  // D-S3: Renderer.ready three-step strict-serial Promise. Kicked off
  // synchronously here so `await renderer.ready` is the AI-user-facing
  // barrier; failure is structured and goes through Promise reject (no
  // throw, no silent skip — charter proposition 4 explicit failure).
  let pipelineState: PipelineState | null = null;
  let readySettled = false;
  // w24 — Renderer.ready returns Promise<Result<void, RhiError>>: resolve
  // ok(undefined) on success / resolve err(RhiError) on failure. The legacy
  // reject path is converted by a `.then() / .catch()` wrap so the inner
  // factory (`buildReadyWebGPU`) keeps its reject-on-error shape (research
  // F-3 internal contract preserved) while the public surface settles
  // strictly resolve-only (charter proposition 4 explicit failure - AI
  // users branch on `.ok` instead of try/catch).
  // feat-20260523-shader-template-instance-split M9-T03 (D-PipelineBuilder):
  // per-MaterialShader pipeline cache (LDR + HDR variants keyed by
  // `${materialShaderId}:${ldr|hdr}`). Map is owned by the renderer (lifetime
  // = Renderer) so cache hits persist across draw calls but reset between
  // renderers. Map.get / .set are sync; the underlying shader-module compile
  // is async-cached inside `makeShaderDeviceAdapter` (1-frame warmup -- first
  // miss returns Result.err('rhi-not-available'); after the async build
  // resolves the adapter caches the module, the next miss-then-build returns
  // Ok and lands in this Map).
  //
  // M6 fix-up: declared BEFORE `buildReadyWebGPU` so the boot-time SPEC_CONST
  // prewarm step inside that promise can seed URP-variant entries directly
  // (the seeding closure captures this Map by reference; ordering is safe
  // because the prewarm step runs strictly before the first frame's
  // `getMaterialShaderPipeline` lookup that would consume it).
  const materialShaderPipelineCache = new Map<string, RenderPipeline>();
  // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): per-shader material
  // BGL + pipeline layout cache. A custom material shader declaring >3
  // user-region textures (e.g. parallax `heightTexture`) needs a material BGL
  // whose user-region + injection start differ from the shared built-in
  // 18-entry layout, plus a pipeline layout [view, perShaderMaterialBgl,
  // meshArray, instances] that the PSO builds against. Built lazily on first
  // request and cached by shaderId; 3-texture shaders never enter the cache
  // (they reuse the shared layout, byte-for-byte the built-in shape — D-2).
  const perShaderMaterialLayoutCache = new Map<
    string,
    { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout }
  >();
  // Returns the per-shader { materialBgl, pipelineLayout } for a custom shader
  // whose user-region texture count exceeds the built-in 3, or null when the
  // shader resolves to the shared built-in layout (3 textures) / is
  // unregistered / pipelineState is not ready. Pure-ish: builds + caches on
  // miss via the same buildBindGroupLayoutDescriptor SSOT (kind
  // 'pbr-material-merged' + materialParamSchema) used by buildPbrPipelineLayouts.
  const getOrBuildPerShaderMaterialLayout = (
    materialShaderId: string,
  ): { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout } | null => {
    const cached = perShaderMaterialLayoutCache.get(materialShaderId);
    if (cached !== undefined) return cached;
    if (pipelineState === null) return null;
    const lookup = getShader().lookupMaterialShader(materialShaderId);
    if (!lookup.ok) return null;
    const paramSchema = lookup.value.paramSchema;
    // 3-or-fewer user-region textures derive to the same 18-entry shape as the
    // shared built-in BGL -> reuse it (D-2 bit-for-bit; no per-shader entry).
    if (derive(paramSchema).textureFieldNames.size <= 3) return null;
    const spec: PipelineSpec = {
      shader: { id: materialShaderId, passKind: 'forward', variantSet: undefined },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    };
    const desc = buildBindGroupLayoutDescriptor(spec, {
      kind: 'pbr-material-merged',
      materialParamSchema: paramSchema,
    });
    const bglRes = internals.device.createBindGroupLayout(
      // biome-ignore lint/suspicious/noExplicitAny: BGL desc 'entries' is mutable per @webgpu/types; rhiDevice accepts it
      desc as any,
    );
    if (!bglRes.ok) {
      internals.errorRegistry.fire(bglRes.error);
      return null;
    }
    const plRes = internals.device.createPipelineLayout({
      label: `pbr-pl-${materialShaderId}`,
      bindGroupLayouts: [
        pipelineState.viewBindGroupLayout,
        bglRes.value,
        pipelineState.meshBindGroupLayout,
        pipelineState.instancesBindGroupLayout,
      ],
    });
    if (!plRes.ok) {
      internals.errorRegistry.fire(plRes.error);
      return null;
    }
    const built = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
    perShaderMaterialLayoutCache.set(materialShaderId, built);
    return built;
  };
  // feat-20260622-s5 M3 / w17: the pipeline build is factored into a closure so
  // the recover() rebuild can re-run the SAME three-step assembly against the
  // freshly-acquired device (SSOT — one build path, one set of seed callbacks).
  // All captured references (getShader / gpuStore / getShaderModuleAdapter /
  // materialShaderPipelineCache / renderSystem) are stable across recover; only
  // `internals.device` / `internals.pack` are read live, so a rebuild after a
  // device swap compiles against the new device.
  const buildPipeline = (): Promise<PipelineState> =>
    buildReadyWebGPU(
      internals.device,
      getShader,
      gpuStore,
      internals.pack.createShaderModule,
      internals.errorRegistry,
      // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 /
      // T-M2-05 + M3 / T-M3-04: callback set by buildReadyWebGPU once
      // meshSsboController is wired. Both the grow hook AND the read-only
      // state ref land on `internals` so the record stage (M3
      // ensureMeshSsboCapacity) can read slotCount + call grow through
      // RenderSystemInternals.
      (hook, state) => {
        internals.growMeshSsbo = hook;
        internals.meshSsboState = state;
      },
      // feat-20260609 R3-fixup: seed the lazy adapter cache with the
      // eagerly-compiled shadow_caster module.
      (label, module) => {
        getShaderModuleAdapter().seedModule(label, module);
      },
      // M6 fix-up: seed `materialShaderPipelineCache` from the boot-time
      // SPEC_CONST prewarm. Closure captures the Map declared just above so
      // the URP-variant prewarmed PSOs become visible to the URP record path
      // immediately (no 1-frame async-compile skip-draw window).
      (key, pso) => {
        if (!materialShaderPipelineCache.has(key)) {
          materialShaderPipelineCache.set(key, pso);
        }
      },
      // feat-20260621 M-A3 (D-5): register the built-in tonemap on the unified
      // post-process channel once buildReadyWebGPU resolves the tonemap manifest
      // entry's composed WGSL. Fires after the manifest-load await, by which point
      // `renderSystem` (declared synchronously below) is defined. The 16 B params
      // schema mirrors the prior dedicated UBO: [exposure(f32), whitePoint(f32),
      // mode(u32), pad(f32)]; the extract stage bridges Camera.exposure/whitePoint/
      // tonemap into this channel each frame (render-system-extract.ts w13).
      (source: string) => {
        renderSystem.postProcess.register(TONEMAP_POST_PROCESS_ID, {
          source,
          params: { byteSize: 16, defaultValue: new Uint8Array(16) },
          reads: ['hdrColor'],
        });
      },
    );
  const ready: Promise<Result<void, RhiError>> = buildPipeline().then(
    (state): Result<void, RhiError> => {
      pipelineState = state;
      readySettled = true;
      return ok(undefined);
    },
    (e: unknown): Result<void, RhiError> => {
      readySettled = true;
      if (e instanceof RhiError) return err(e);
      const message = e instanceof Error ? e.message : String(e);
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'Renderer.ready three-step strict-serial succeeds',
          hint: `pipeline build raised: ${message}`,
        }),
      );
    },
  );
  /**
   * bug-20260527-renderstate-pipeline-dispatch-gap D-3:
   * finds the engine-shipped PBR manifest entry from the shader registry
   * by content marker (f_schlick BRDF helper call, same marker
   * buildReadyWebGPU uses). Returns undefined when the manifest is
   * empty (Camera-only path) or the pbr entry is not found.
   */
  const findStandardPbrEntry = (): import('@forgeax/engine-types').ManifestEntry | undefined => {
    for (const entry of getShader().entries()) {
      if (entry.wgsl.includes('f_schlick')) return entry;
    }
    return undefined;
  };
  // Shared builder context for the per-MaterialShader pipeline cache.
  // Built once; reused for both registered shader IDs and fallback
  // paths (D-3). Null when manifest is empty (Camera-only path).
  //
  // feat-20260609-hdrp-cluster-fragment-ggx M4.5 / w37 (D-10 option A):
  // `variantSet` parameter selects between URP `pbrPipelineLayout` (1-slot
  // group(2) BGL) and HDRP `hdrpPbrPipelineLayout` (7-slot group(2) BGL)
  // via `selectPipelineLayoutForVariant`. When undefined (legacy callers
  // / fallback path) the URP layout is used preserving prior behaviour.
  const buildPipelineContext = (
    variantSet?: string,
    materialShaderId?: string,
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // when layoutKind === 'pbr-skin' the SSOT for the vertex buffer layout
    // is `deriveVertexBufferLayout` (vertex-attribute-layout.ts) — the same
    // function that the WGSL @location(N) declarations / naga reflect tests
    // consume. A caller passing a real `MeshAsset.attributes` produces the
    // exact 6-attribute / 72-byte layout the skin shader expects; passing
    // undefined falls into the synthetic 6-key sentinel below (the skin
    // path is fully determined by layoutKind, so key-presence is the only
    // signal `deriveVertexBufferLayout` reads — values never matter).
    meshAttributes?: VertexAttributeMap,
  ) => {
    // bug-20260611: derive LayoutKind from materialShaderId (caller-driven)
    // so the selector body stays free of literal shader-id strings (AC-09).
    // Skin shader gets its own 4-slot layout chain with 2-entry mesh-array
    // BGL; everything else routes through the URP/HDRP variantSet logic.
    const layoutKind: LayoutKind | undefined =
      materialShaderId === SKIN_MATERIAL_SHADER_ID ? 'pbr-skin' : undefined;
    // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): a custom shader
    // with >3 user-region textures owns a per-shader pipeline layout (its
    // material BGL is wider than the shared built-in 18-entry). Skin / HDRP
    // keep their dedicated layouts; everything else falls back to the shared
    // URP/HDRP selector. 3-texture customs return null here -> shared layout
    // (D-2 byte-for-byte).
    const perShaderLayout =
      layoutKind === undefined && materialShaderId !== undefined
        ? getOrBuildPerShaderMaterialLayout(materialShaderId)
        : null;
    const pipelineLayout =
      perShaderLayout !== null
        ? perShaderLayout.pipelineLayout
        : selectPipelineLayoutForVariant(pipelineState, variantSet, layoutKind);
    if (pipelineLayout === null) return null;
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // pbr-skin -> deriveVertexBufferLayout (single SSOT for skin/non-skin
    // attribute layout). Caller may pass a real `MeshAsset.attributes`;
    // otherwise we synthesize a 6-key sentinel because deriveVertexBufferLayout
    // only reads key presence (value identity is irrelevant). Non-skin
    // layoutKinds keep the hardcoded 4-attribute / 48-byte layout for
    // backward-compat (`undefined` / `'pbr'` / `'hdrp-pbr'` -- the URP/HDRP
    // path has no skin attributes, AC-04 zero-regression).
    const vertexBuffers: readonly GPUVertexBufferLayout[] =
      layoutKind === 'pbr-skin'
        ? (deriveVertexBufferLayout(
            meshAttributes ??
              ({
                position: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                normal: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                uv: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                tangent: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                skinIndex: PBR_SKIN_SENTINEL_ATTR_BUFFER,
                skinWeight: PBR_SKIN_SENTINEL_ATTR_BUFFER,
              } satisfies VertexAttributeMap),
          ) as unknown as readonly GPUVertexBufferLayout[])
        : ([
            {
              arrayStride: 12 * 4,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
                { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' as const },
                { shaderLocation: 2, offset: 6 * 4, format: 'float32x2' as const },
                { shaderLocation: 3, offset: 8 * 4, format: 'float32x4' as const },
              ],
            },
          ] as unknown as readonly GPUVertexBufferLayout[]);
    return {
      device: internals.device,
      shaderModuleFactory: getShaderModuleAdapter(),
      pipelineLayout,
      vertexBuffers,
    };
  };
  /**
   * Builds a pipeline for the given entry, caches it keyed by cacheKey,
   * and returns it. Returns null on build failure (firing errorRegistry
   * for non-transient errors).
   */
  const buildAndCachePipeline = (
    cacheKey: string,
    entry: {
      readonly source: string;
      readonly paramSchema: readonly unknown[];
    },
    label: string,
    moduleLabel: string,
    isHdr: boolean,
    renderState: MaterialRenderState | undefined,
    topology: PrimitiveTopology | undefined,
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    // feat-20260609 M4.5 / w37 (D-10): thread variantSet to the layout selector
    // so HDRP-variant PSOs build with `hdrpPbrPipelineLayout` (7-slot group(2))
    // and URP-variant PSOs build with `pbrPipelineLayout` (1-slot group(2)).
    variantSet?: string,
    passKind: PassKind = 'forward',
    // bug-20260611-skin-pipeline-layout: thread materialShaderId so
    // buildPipelineContext can derive `LayoutKind === 'pbr-skin'` and pick
    // the 2-entry mesh-array BGL chain.
    materialShaderId?: string,
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // pass the per-mesh `VertexAttributeMap` so the pbr-skin path's
    // vertex buffer layout flows from the SSOT `deriveVertexBufferLayout`
    // (vertex-attribute-layout.ts) instead of a parallel hardcoded copy.
    // Undefined falls into the synthetic 6-key sentinel inside
    // `buildPipelineContext` (key-presence-only); non-skin layoutKinds
    // ignore this parameter entirely.
    meshAttributes?: VertexAttributeMap,
    // bug-20260615 M2 / m2-1: sampleCount drives the multisample descriptor
    // field in buildPipelineForMaterialShader — it is a CAMERA fact (per-frame
    // antialias setting), not a material renderState value. Default 1 preserves
    // byte-identity of every existing pre-M2 cache slot + descriptor.
    sampleCount: number = 1,
  ): RenderPipeline | null => {
    const ctx = buildPipelineContext(variantSet, materialShaderId, meshAttributes);
    if (ctx === null) return null;
    // bug-20260612: route the LDR color format through pipelineState so the
    // backend-aware swap-chain format chosen at buildReadyWebGPU flows here.
    // Callers gate on pipelineState !== null before reaching this lambda
    // (search "buildAndCachePipeline" call sites — every one is preceded by
    // the explicit null check).
    if (pipelineState === null) return null;
    const ldrColorFormat = pipelineState.colorAttachmentFormat as unknown as GPUTextureFormat;
    const built = buildPipelineForMaterialShader(
      cacheKey,
      // biome-ignore lint/suspicious/noExplicitAny: cast through any to satisfy MaterialShaderEntry shape
      entry as any,
      {
        ...ctx,
        colorFormat: isHdr ? HDR_COLOR_ATTACHMENT_FORMAT : ldrColorFormat,
        depthFormat: DEPTH_TEXTURE_FORMAT,
        label,
        // feat-20260604 w16-b: the shader-MODULE cache identity. Stable across
        // topology / renderState / isHdr / indexFormat (all baked into the PSO,
        // not the module), so every pipeline variant of the same shader source
        // reuses one compiled module instead of forcing a fresh async compile
        // per variant. See PipelineBuilderContext.moduleLabel.
        moduleLabel,
      },
      renderState,
      // w8/w15: pack topology (+ stripIndexFormat) into the builder's geometry
      // param. Strip topologies bake stripIndexFormat into the immutable PSO
      // (WebGPU spec: only valid for line-strip / triangle-strip). The record
      // stage (w9 + w15) threads each mesh's topology + indexFormat here; when
      // the caller omits stripIndexFormat we fall back to 'uint32' (the engine
      // procedural index width: createBoxGeometry etc. emit Uint32 indices).
      topology !== undefined
        ? {
            topology,
            ...(topology === 'line-strip' || topology === 'triangle-strip'
              ? { stripIndexFormat: stripIndexFormat ?? ('uint32' as const) }
              : {}),
          }
        : undefined,
      undefined, // vertexEntry — default vs_main
      undefined, // fragmentEntry — default fs_main
      undefined, // defines — none
      passKind,
      sampleCount,
    );
    if (!built.ok) {
      if (built.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(built.error);
      }
      return null;
    }
    materialShaderPipelineCache.set(cacheKey, built.value);
    return built.value;
  };
  const getMaterialShaderPipeline = (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind: PassKind = 'forward',
    // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
    // forwarded to `buildAndCachePipeline -> buildPipelineContext` so the
    // pbr-skin layout chain reads from the `deriveVertexBufferLayout` SSOT.
    // Optional: existing callers (URP / HDRP / shadow-depth) pass undefined
    // and the hardcoded 4-attribute layout is preserved (AC-04 zero-regression).
    meshAttributes?: VertexAttributeMap,
    // bug-20260615 M2 / m2-1: sampleCount is threaded through to the cache key,
    // buildAndCachePipeline, and ultimately buildPipelineForMaterialShader which
    // sets the multisample descriptor field. Default 1 preserves byte-identity
    // of every pre-M2 caller.
    sampleCount: number = 1,
  ): RenderPipeline | null => {
    // feat-20260615-pipeline-spec-ssot M2-T2: cache key derived from PipelineSpec
    // 4-axis SSOT via cacheKeyOf(spec). The spec carries all 4 axes (shader /
    // attachments / geometry / renderState), replacing the legacy 8-segment string
    // construction. vertexLayout is now included in the cache key (was previously
    // threaded but not hashed — research F1 R-VertexLayout-Cache). sampleCount is
    // cast to 1 | 4 for the closed spec axis.
    // M2-fixup follow-up: LDR color format SSOT is `pipelineState.colorAttachmentFormat`
    // (set in buildReadyWebGPU from selectSwapChainFormat). Hardcoding 'bgra8unorm-srgb'
    // here let the cache key drift from the prewarm key on backends where
    // getPreferredCanvasFormat returns rgba8unorm (dawn-node, lavapipe, wgpu-wasm GLES),
    // forcing a redundant second PSO build on first-frame URP record path.
    const ldrColorFormat: GPUTextureFormat =
      pipelineState !== null
        ? (pipelineState.colorAttachmentFormat as unknown as GPUTextureFormat)
        : ('bgra8unorm-srgb' as unknown as GPUTextureFormat);
    const colorFormat: GPUTextureFormat =
      passKind === 'shadow-caster'
        ? (undefined as unknown as GPUTextureFormat)
        : isHdr
          ? ('rgba16float' as unknown as GPUTextureFormat)
          : ldrColorFormat;
    const spec: PipelineSpec = {
      shader: { id: materialShaderId, passKind, variantSet },
      attachments: {
        colorFormats: passKind === 'shadow-caster' ? [] : [colorFormat],
        depthFormat:
          passKind === 'shadow-caster'
            ? ('depth32float' as unknown as GPUTextureFormat)
            : ('depth24plus-stencil8' as unknown as GPUTextureFormat),
        sampleCount: (sampleCount === 4 ? 4 : 1) as 1 | 4,
      },
      geometry: {
        topology: topology ?? 'triangle-list',
        stripIndexFormat: indexFormat,
        vertexLayout: meshAttributes ?? DEFAULT_VERTEX_ATTRS,
      },
      renderState,
    };
    const cacheKey = cacheKeyOf(spec);
    const cached = materialShaderPipelineCache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (pipelineState === null) return null;
    const lookup = getShader().lookupMaterialShader(materialShaderId);
    if (!lookup.ok) {
      // bug-20260527-renderstate-pipeline-dispatch-gap D-3:
      // fallback path parity -- when renderState is defined and the
      // shader id is not registered, build a renderState-variant of
      // the standard pipeline from the engine-shipped PBR entry.
      if (renderState === undefined) return null;
      const pbrEntry = findStandardPbrEntry();
      if (pbrEntry === undefined) return null;
      return buildAndCachePipeline(
        cacheKey,
        { source: pbrEntry.wgsl, paramSchema: [] },
        `pbr-pipeline-fallback-${materialShaderId}${isHdr ? '-hdr' : ''}`,
        // w16-b: module identity is the fallback PBR source, stable across
        // topology / renderState / HDR (all baked into the PSO) so every
        // variant reuses one compiled module.
        'module-fallback-pbr',
        isHdr,
        renderState,
        topology,
        indexFormat,
        // M4.5 / w37 (D-10): the fallback path also threads variantSet so the
        // layout selector picks HDRP layout when an HDRP caller falls into
        // this branch (registered shader id missing).
        variantSet,
        // feat-20260609 / T-002: passKind threaded through the fallback path
        // for parity with the main path; default 'forward' keeps every prior
        // fallback caller byte-identical.
        passKind,
        // bug-20260611-skin-pipeline-layout: passing materialShaderId here is
        // intentional even on the fallback (registered-id-missing) branch --
        // a missing skin shader registration should not silently pick the
        // wrong BGL chain. With LayoutKind='pbr-skin' the selector returns
        // null when pbrSkinPipelineLayout is null (charter P3 explicit fail).
        materialShaderId,
        // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
        // forward meshAttributes through the fallback path so the pbr-skin
        // layout chain reads from the deriveVertexBufferLayout SSOT here too.
        meshAttributes,
        sampleCount,
      );
    }
    // feat-20260609 M4 / w31: resolve variant WGSL from manifest when
    // variantSet is non-empty. The boot-time registered shader (from
    // `registerMaterialShader` at line ~2473) carries the default (all-true)
    // variant's WGSL. For URP callers that want a different variant
    // (e.g. STORAGE_BUFFER_AVAILABLE=true without CLUSTER_FORWARD_AVAILABLE),
    // we look up the manifest entry, find the matching variant, and
    // substitute its composedWgsl into the PSO build path. The pipeline
    // layout itself is built by buildPbrPipelineLayouts (M3 / w12).
    // When variantSet is empty/undefined, the boot-time registered entry
    // (which is the all-true default) is used verbatim — backward compat.
    let shaderEntry = lookup.value;
    // M4.5 / w38 (D-11): `variantSet === ''` is canonical all-true (HDRP
    // path) and MUST hit the manifest variant lookup -- treat it as a
    // first-class variant request, not a falsy "no variant" signal.
    // Use `!== undefined` so the empty-string case enters the lookup.
    if (variantSet !== undefined) {
      const registry = getShader();
      for (const msEntry of registry.materialShaderManifestEntries()) {
        if (msEntry.identifier === materialShaderId) {
          const variant = findVariantByKey(msEntry, variantSet);
          if (variant) {
            // M3 / w12-w13: variant substitution carries the same source +
            // paramSchema as the boot-registered entry; the binding layout
            // is no longer carried on MaterialShaderEntry (deleted in
            // w13) — buildPbrPipelineLayouts is the BGL SSOT and reads
            // derive(paramSchema).bglEntries on demand.
            shaderEntry = {
              source: variant.composedWgsl,
              paramSchema: lookup.value.paramSchema,
            };
          }
          break;
        }
      }
    }
    // feat-20260609 M4 / R3-fixup: append `-${passKind}` to the PSO label so
    // GPU debug captures (and the shadow-caster branch in the builder)
    // make the cache variant visible. The fallback path above keeps the
    // pre-existing fallback-* label shape (no shadow-caster fallback
    // exists today; the only shadow caller registers shadowCaster directly).
    const passKindLabelSegment = passKind === 'forward' ? '' : `-${passKind}`;
    return buildAndCachePipeline(
      cacheKey,
      shaderEntry,
      `pbr-pipeline-${materialShaderId}${isHdr ? '-hdr' : ''}${passKindLabelSegment}`,
      // feat-20260609 M4 / w31: when variantSet is non-empty, the module identity
      // includes the variant key so URP (STORAGE_BUFFER_AVAILABLE=true) and HDRP
      // (CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true) variants
      // compile as separate shader modules (they have different WGSL sources).
      // When variantSet is empty/undefined, the module identity stays pre-M4
      // backward-compatible for all PSOs of the default variant.
      // M4.5 / w38 (D-11): same `!== undefined` discipline as the cache
      // key -- `''` (canonical all-true) gets its own module-label slot,
      // distinct from the no-variant path. Trailing `#` for the empty
      // case is intentional (parallel to the cache key's `:variant:`
      // empty-tail segment); module identity stays a function of the
      // exact variantSet string.
      variantSet !== undefined
        ? `module-${materialShaderId}#${variantSet}`
        : `module-${materialShaderId}`,
      isHdr,
      renderState,
      topology,
      indexFormat,
      // M4.5 / w37 (D-10): main path threads variantSet so HDRP-variant PSO
      // builds against `hdrpPbrPipelineLayout` (7-slot group(2) BGL) and URP
      // builds against `pbrPipelineLayout` (1-slot group(2) BGL).
      variantSet,
      // feat-20260609 / T-002: passKind selects createRenderPipeline
      // attachment shape (forward color+DS vs shadow-caster depth32float
      // no-color). Orthogonal to variantSet (which selects the BGL chain).
      passKind,
      // bug-20260611-skin-pipeline-layout: thread the registered materialShaderId
      // so buildPipelineContext can resolve LayoutKind='pbr-skin' for the skin
      // shader (2-entry mesh-array BGL).
      materialShaderId,
      // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
      // forward meshAttributes so the pbr-skin path's vertex buffer layout
      // is derived via the SSOT (deriveVertexBufferLayout). For URP/HDRP
      // callers (and for any caller passing undefined) the synthetic 6-key
      // sentinel inside buildPipelineContext keeps the layout deterministic.
      meshAttributes,
      sampleCount,
    );
  };
  const getParamSchema = (materialShaderId: string) => {
    const lookup = getShader().lookupMaterialShader(materialShaderId);
    return lookup.ok ? lookup.value.paramSchema : undefined;
  };
  // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): expose the per-shader
  // material BGL so the record stage creates the material bind group against
  // the matching layout (wider for >3-texture custom shaders). Returns
  // undefined for 3-texture / unregistered shaders -> record falls back to the
  // shared built-in materialBindGroupLayout.
  const getMaterialBindGroupLayout = (materialShaderId: string): BindGroupLayout | undefined =>
    getOrBuildPerShaderMaterialLayout(materialShaderId)?.materialBgl ?? undefined;
  // feat-20260609 M4 / T-10-a: post-process pipeline factory backing
  // RenderSystemRuntime.getPostProcessPipeline. Solves M1 CONCERN-1: previously
  // the dispatcher in render-graph-primitives.ts passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await
  // device.createShaderModule (async). This factory uses the same shared
  // makeShaderDeviceAdapter the material-shader pipeline cache uses (sync
  // wrapper + 1-frame warmup); first-call returns null while the async compile
  // is in flight; second frame onward returns the built pipeline.
  //
  // The pipeline layout is fixed:
  //   group(0) = empty BGL (reserved per render-graph-primitives.ts convention
  //              for view bind groups; populated by future post-process passes
  //              that need view UBOs)
  //   group(1) = the input-texture BGL the dispatcher already composed via
  //              buildFullscreenPostProcessPass (texture + sampler)
  // Vertex stage: vs_main (no vertex buffers); fragment stage: fs_main targeting
  // `colorFormat`. Topology: triangle-list with cullMode='none' (3-vertex
  // fullscreen draw via the canonical fullscreen_triangle pattern).
  let emptyPostProcessBgl: BindGroupLayout | null = null;
  const buildPostProcessPipeline = (
    entry: PostProcessShaderEntry,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
    label: string,
  ): RenderPipeline | null => {
    const moduleFactory = getShaderModuleAdapter();
    const moduleResult = moduleFactory.createShaderModule({
      code: entry.source,
      label: `${label}-module`,
    });
    if (!moduleResult.ok) {
      // 'rhi-not-available' = async compile in flight: caller falls back one frame.
      // Other codes are real failures: surface through the error registry so AI
      // users see a structured RhiError instead of a silent black screen (charter P3).
      if (moduleResult.error.code !== 'rhi-not-available') {
        internals.errorRegistry.fire(moduleResult.error);
      }
      return null;
    }
    if (emptyPostProcessBgl === null) {
      const bglRes = internals.device.createBindGroupLayout({ entries: [] });
      if (!bglRes.ok) {
        internals.errorRegistry.fire(bglRes.error);
        return null;
      }
      emptyPostProcessBgl = bglRes.value;
    }
    const layoutRes = internals.device.createPipelineLayout({
      label: `${label}-layout`,
      bindGroupLayouts: [emptyPostProcessBgl, bgl],
    });
    if (!layoutRes.ok) {
      internals.errorRegistry.fire(layoutRes.error);
      return null;
    }
    const pipelineRes = internals.device.createRenderPipeline({
      label,
      layout: layoutRes.value as unknown as GPUPipelineLayout,
      vertex: {
        module: moduleResult.value as unknown as GPUShaderModule,
        entryPoint: 'vs_main',
        buffers: [],
      } as unknown as GPUVertexState,
      fragment: {
        module: moduleResult.value as unknown as GPUShaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: colorFormat }],
      } as unknown as GPUFragmentState,
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: undefined,
      multisample: undefined,
    });
    if (!pipelineRes.ok) {
      internals.errorRegistry.fire(pipelineRes.error);
      return null;
    }
    return pipelineRes.value;
  };
  const renderSystem: RenderSystem = createRenderSystem({
    canvas: internals.canvas,
    // feat-20260622-s5 M3 / w17: device + context read live off `internals` via
    // getters so the recover() rebuild (which swaps internals.device /
    // internals.context for a freshly-acquired pair) is observed by the record
    // stage without reconstructing the RenderSystem (RenderSystemRuntime.device
    // / RenderSystemInternals.context are read at frame time, not cached).
    get device() {
      return internals.device;
    },
    get context() {
      return internals.context;
    },
    // feat-20260608-create-app-param-surface-trim / M1 / AC-02: clearColor
    // is no longer threaded through createRenderSystem; the record stage
    // reads `camera.clearR/G/B/A` straight from the Camera SoA columns.
    getPipelineState: () => pipelineState,
    assets,
    gpuStore,
    dynamicTextureStore,
    errorRegistry: internals.errorRegistry,
    healthRegistry: internals.healthRegistry,
    getMaterialShaderPipeline,
    getParamSchema,
    getMaterialBindGroupLayout,
    metrics,
    // feat-20260609 M4 / T-10-a: post-process pipeline factory (CONCERN-1 fix).
    // createRenderSystem wraps this in a per-RenderSystem cache + the public
    // getPostProcessPipeline lookup the dispatcher reads at frame time.
    buildPostProcessPipeline,
    // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
    // forward the grow hook + state via getter closures — buildReadyWebGPU
    // sets `internals.growMeshSsbo` / `internals.meshSsboState` after this
    // factory call, so the record stage reads them through the closures
    // (read at frame time, when ready has already settled).
    get growMeshSsbo() {
      return internals.growMeshSsbo;
    },
    get meshSsboState() {
      return internals.meshSsboState;
    },
  });
  // feat-20260601-customizable-render-pipeline-seam M1 / w8 (D-19): DOGFOOD. The default
  // frame is driven through the SAME public channel an AI user would use - registerPipeline
  // the built-in forward logic, then installPipeline a default RenderPipelineAsset POD
  // (built inline, no AssetRegistry round-trip; D-19: installPipeline takes the payload,
  // there is no World at boot to allocate a shared ref against). install cannot fail here
  // (the id was just registered), so it throws -- a failure would be an engine-boot
  // invariant break, not part of the RhiError onError fan-out (PipelineError is a distinct
  // union).
  renderSystem.registerPipeline(URP_PIPELINE_ID, urpPipeline);
  // feat-20260608-cluster-lighting M2 / w10: HDRP cluster-forward registered (not installed).
  // installPipeline(hdrpAsset) is the explicit AI-user opt-in.
  renderSystem.registerPipeline(HDRP_PIPELINE_ID, hdrpPipeline);
  const defaultInstall = renderSystem.installPipeline({
    kind: 'render-pipeline',
    pipelineId: URP_PIPELINE_ID,
  });
  if (!defaultInstall.ok) throw defaultInstall.error;
  // m3-2: onFrameEnd injection point. The recorder subscribes via
  // renderer._onFrameEnd(cb) to get frame-completion callbacks after
  // renderSystem.draw(world). @internal — underscore-prefix, not part of
  // the public Renderer interface in renderer.ts.
  const _onFrameEndListeners = new Set<() => void>();

  type RendererInternal = Renderer & {
    /** @internal Register a frame-end listener. Returns an unsubscribe function. */
    _onFrameEnd(listener: () => void): () => void;
  };

  const renderer: RendererInternal = {
    backend: 'webgpu',
    device: internals.device,
    get shader(): ShaderRegistry {
      return getShader();
    },
    assets,
    metrics,
    store: gpuStore,
    input: RENDERER_INPUT_FACADE,
    ready,
    get frustumStats() {
      return renderSystem.frustumStats;
    },
    get perFramePassNames() {
      return renderSystem.perFramePassNames;
    },
    get bindGroupCounts() {
      return renderSystem.bindGroupCounts;
    },
    draw(world: World): Result<void, RhiError> {
      // feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
      // (plan-strategy D-1, D-8): post-dispose the renderer is dead. AI
      // users observing `result.ok === false && err.code === 'rhi-not-
      // available'` know to rebuild the renderer (mirrors the "ready not
      // settled" + "pipelineState null" fail-fast paths below; reuses the
      // existing closed-union member, no new ErrorCode introduced).
      if (disposed) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected: 'renderer not disposed before calling renderer.draw(world)',
          hint: 'renderer.dispose() flipped the lifecycle latch; rebuild via createRenderer / Engine.create',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      // M2 / w9 (A-IN-5): device-lost guard — draw() silently returns err
      // without firing onError each frame. The device-lost channel fires once
      // through the dual-channel fan-out (:750-797); draw() does not repeat it
      // (canvas holds previous frame). Host observes health().reason ===
      // 'device-lost' and calls recover() when ready.
      if (internals.healthRegistry.getLastSnapshot().reason === 'device-lost') {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'GPUDevice is lost; recover() to rebuild and resume rendering',
            hint: 'call renderer.recover() after a host-chosen delay; camera holds previous frame',
          }),
        );
      }
      // D-S4: ready not settled => fire onError + skip frame. Uses
      // 'rhi-not-available' (closed union placeholder semantics; charter
      // proposition 4 explicit failure - AI users observe through onError
      // and decide whether to retry).
      if (!readySettled) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected: 'await renderer.ready before calling renderer.draw(world)',
          hint: 'await renderer.ready resolves once the manifest / pipeline / asset upload chain completes',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      // pipeline build rejected: ready Promise has already surfaced the
      // structured error to AI users through `await renderer.ready`. Skip
      // to keep draw(world) idempotent; a transient retry next frame is
      // the responsibility of the AI user (charter proposition 9).
      if (pipelineState === null) {
        const e = new RhiError({
          code: 'rhi-not-available',
          expected: 'pipelineState built during Renderer.ready',
          hint: 'await renderer.ready resolved successfully; rebuild renderer or fix the upstream RhiError',
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
      // Configure context lazily on first draw (D-S1 single-point
      // exemption): GPUCanvasContext.configure({device}) needs a raw
      // GPUDevice; main.ts passes it via RendererOptions.rawDeviceForContextConfigure.
      ensureContextConfigured(internals, pipelineState, internals.errorRegistry);
      // w24 — facade-level try/catch produces Result.err on unexpected throw
      // (D-P6 dual-channel preserved: per-stage RhiError continues to fan out
      // through onError separately; the facade Result is the synchronous
      // summary AI users can ignore or branch on).
      try {
        // PreRender stage (plan-strategy D-2): lay out + bake every GlyphText
        // entity before the render walk reaches it. A `font-concurrency-exceeded`
        // TextError is a structured author-facing signal (distinct domain from
        // RhiError); it does not abort the frame -- healthy labels still render.
        glyphTextLayoutSystem(world, assets, gpuStore);
        tilemapChunkExtractSystem(world);
        renderSystem.draw(world);
        // m3-2: fire onFrameEnd listeners after the frame render completes,
        // before returning the synchronous result. Recorder subscribes via
        // renderer._onFrameEnd to inject frameMark events.
        for (const fn of _onFrameEndListeners) {
          fn();
        }
        return ok(undefined);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const e = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'renderSystem.draw(world) completes without throwing',
          hint: `RenderSystem internal error: ${message}`,
        });
        internals.errorRegistry.fire(e);
        return err(e);
      }
    },
    async readPixels(): Promise<Result<Uint8Array, RhiError>> {
      // Read the canvas's current pixel contents back into an RGBA Uint8Array
      // via the lowest-common-denominator browser path: createImageBitmap ->
      // OffscreenCanvas 2D drawImage -> getImageData. The WebGPU canvas's
      // GPUTexture is not directly readable via getImageData, so this 2D
      // bounce is the canonical browser path. Returns top-left origin RGBA
      // (the natural getImageData convention); apps that need bottom-left
      // origin (parity with gl.readPixels) Y-flip on top of the result.
      const target = internals.canvas;
      try {
        const bmp = await createImageBitmap(target);
        const off = new OffscreenCanvas(target.width, target.height);
        const ctx2d = off.getContext('2d', { willReadFrequently: true });
        if (ctx2d === null) {
          bmp.close();
          return err(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'OffscreenCanvas 2D context available',
              hint: 'browser does not expose a 2D context on OffscreenCanvas; readPixels requires the OffscreenCanvas + 2D ctx + getImageData browser combo',
              detail: {
                error: {
                  code: 'unknown',
                  message: 'OffscreenCanvas.getContext("2d") returned null',
                },
              },
            }),
          );
        }
        ctx2d.drawImage(bmp, 0, 0);
        const imgData = ctx2d.getImageData(0, 0, target.width, target.height);
        bmp.close();
        return ok(
          new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength),
        );
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'createImageBitmap + OffscreenCanvas 2D pipeline succeeds',
            hint: 'pixel readback failed; verify the canvas has been drawn to and the browser supports OffscreenCanvas + createImageBitmap',
            detail: { error: { code: 'unknown', message } },
          }),
        );
      }
    },
    /**
     * Release every GPU resource the renderer owns + detach the listener
     * registries; flip the `disposed` latch so subsequent `draw(world)`
     * calls fail-fast with `'rhi-not-available'`.
     *
     * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
     * 6-step cascade (plan-strategy D-2 ordering):
     *   1. `gpuStore.destroyAll()`           -- texture / cubemap / mesh maps
     *   2. `renderSystem.disposeFrameState()` -- graph.drain() + instanceBuffers
     *   3. (folded into step 2 above)
     *   4. `clearIblCacheForDevice(device)`  -- per-device IBL pipeline cache
     *   5. `context.unconfigure()`           -- canvas-context teardown
     *   6. `lostRegistry.clear() / errorRegistry.clear()`
     *
     * Each step runs inside its own try/catch (D-3 method A): a sub-step
     * failure DOES NOT halt the cascade; the structured RhiError (or wrapped
     * runtime exception) fans out through `errorRegistry.fire` so AI users
     * observing `renderer.onError` see every dispose-time fault. The
     * `disposed` latch flips up-front so a re-entrant dispose (or a draw
     * that races with the cascade) short-circuits.
     *
     * NOT calling `device.destroy()` on the raw GPUDevice (w25 lesson from
     * feat-20260517-vite-plugin-image-build-time-cook CI-fix v4): w23
     * attempted to evict stale devices from the chromium WebGPU adapter
     * pool via `_internal_getRawDevice`, but the explicit destroy
     * accelerated pool poisoning -- after the first `dispose()` the
     * chromium adapter pool started recycling the just-destroyed device
     * into the next `requestDevice` so the NEXT test's `Engine.create`
     * resolved with `ready.error.code: 'device-lost'`. Cross-test isolation
     * moved to the vitest infra layer (`browser.isolate: true`) instead of
     * test code self-managing device lifecycle.
     *
     * Stays in sync with the `Renderer.dispose` row of the README "API index".
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Step 1: release every Buffer / Texture handle owned by the runtime
      // GPU residency layer (feat-20260601-gpu-resource-store-extraction).
      try {
        gpuStore.destroyAll();
      } catch (cause) {
        internals.errorRegistry.fire(wrapDisposeError(cause, 'gpuStore.destroyAll'));
      }
      // Step 2 + 3: drain the per-frame render-graph pool + the per-entity
      // instanceBuffers GPU storage cache. Both walks live on the
      // RenderSystem closure (frameState is closure-private).
      try {
        renderSystem.disposeFrameState();
      } catch (cause) {
        internals.errorRegistry.fire(wrapDisposeError(cause, 'renderSystem.disposeFrameState'));
      }
      // Step 4: drop the per-device IBL pipeline cache entry. The GPU
      // pipeline / texture handles inside the entry are released
      // implicitly when the device tears down (spec contract); clearing
      // the WeakMap entry lets GC reclaim the JS-side cache record.
      try {
        clearIblCacheForDevice(internals.device);
      } catch (cause) {
        internals.errorRegistry.fire(wrapDisposeError(cause, 'clearIblCacheForDevice'));
      }
      // Step 5: tear down the canvas context. Idempotent per spec: a second
      // unconfigure() on an already-unconfigured context is a no-op.
      try {
        internals.context.unconfigure();
      } catch (cause) {
        internals.errorRegistry.fire(wrapDisposeError(cause, 'context.unconfigure'));
      }
      // Step 6: detach the listener registries so any post-dispose error
      // event (race with the spec layer) does not fan out to user-supplied
      // listeners (charter P3 explicit failure: post-dispose the renderer
      // is dead, no observable side-effects). Performed last so steps 1-5
      // can still surface failures through `errorRegistry.fire`.
      try {
        internals.lostRegistry.clear();
        internals.errorRegistry.clear();
      } catch {
        // listener-registry clear() is best-effort cleanup at the very end
        // of dispose; no further fan-out channel survives.
      }
    },
    onError(listener: RendererErrorListener): () => void {
      return internals.errorRegistry.add(listener);
    },
    onLost(listener: RendererLostListener): () => void {
      return internals.lostRegistry.add(listener);
    },
    health(): HealthSnapshot {
      return internals.healthRegistry.getLastSnapshot();
    },
    async recover(): Promise<Result<void, RecoverError>> {
      // feat-20260622-s5 M3 / w17 (A-IN-3 / D-1): single idempotent device
      // rebuild. One attempt only — no loop, no backoff, no timer, no extra
      // in-flight health state (A-OOS-1); the host owns the cadence of calling
      // this again. Fail-Fast entry guards (architecture-principles #5):
      // disposed renderer or non-device-lost state short-circuits before any
      // GPU work.
      if (disposed) {
        // A-IN-6: disposed latch wins; recover() never rebuilds a dead
        // renderer. `recover-not-needed` is the sentinel (no degraded state to
        // recover from on a disposed renderer).
        return err(new RecoverError('recover-not-needed'));
      }
      const snapshot = internals.healthRegistry.getLastSnapshot();
      // A-AC-08: `alive` (including the alive state after a prior successful
      // recover) is a no-op signal — idempotent second call.
      if (snapshot.reason !== 'device-lost') {
        return err(new RecoverError('recover-not-needed'));
      }

      // Step (a): release every GPU resource owned by the lost device. The CPU
      // POD caches (AssetRegistry catalog/payload, pack cache) are NOT touched
      // (A-AC-12) — only the GpuResourceStore + canvas context are torn down.
      gpuStore.destroyAll();
      internals.context.unconfigure();

      // Step (b) / B-2 / B-AC-02: shed device-bound RenderSystem state minted by
      // the lost device — the render-graph pendingDestroy queue (its PooledTextures
      // belong to the lost device; the clear skips device.destroyTexture, mirroring
      // the null-device fast path) plus the post-process registry + param UBOs (so
      // the rebuild's buildReadyWebGPU re-registers the tonemap without a
      // `post-process-already-registered` collision).
      renderSystem.resetForRecover();

      // Step (c): re-acquire device through the SAME backend pack (the
      // idempotent factory primitives tryCreateWebGPURenderer uses). On the
      // adapter / device failure paths, health stays `device-lost` (A-AC-07):
      // recover() never fakes the renderer back to `alive`.
      const adapterResult = await internals.pack.rhi.requestAdapter(undefined, internals.canvas);
      if (!adapterResult.ok) {
        return err(new RecoverError('recover-adapter-unavailable'));
      }
      let device: RhiDevice;
      try {
        const deviceResult = await adapterResult.value.requestDevice();
        if (!deviceResult.ok) {
          return err(new RecoverError('recover-device-unavailable'));
        }
        device = deviceResult.value;
      } catch {
        return err(new RecoverError('recover-device-unavailable'));
      }
      const ctxResult = internals.pack.rhi.acquireCanvasContext(internals.canvas);
      if (!ctxResult.ok) {
        return err(new RecoverError('recover-device-unavailable'));
      }

      // Step (d): swap in the new device + context. Downstream reads device via
      // getters off `internals` (RenderSystem, ensureContextConfigured), so the
      // swap is observed without reconstructing the RenderSystem.
      internals.device = device;
      internals.context = ctxResult.value;

      // Re-attach the device.lost fan-out to the new device's lost Promise,
      // reusing the SAME registries the host already subscribed to (SSOT
      // helper). When this device is lost again, health() flips to
      // `device-lost` and the host can call recover() once more.
      attachDeviceLostFanout(device, internals.pack, {
        lostRegistry: internals.lostRegistry,
        errorRegistry: internals.errorRegistry,
        healthRegistry: internals.healthRegistry,
      });

      // Step (e): rebuild GPU-bound state against the new device. The per-shader
      // PSO + layout caches hold handles minted by the lost device; drop them so
      // the rebuild compiles fresh PSOs. configureGpuDevice + prepareMaterialShaders
      // + buildPipeline reuse the exact boot-time assembly (the closures capture
      // stable references; only `internals.device` changed).
      materialShaderPipelineCache.clear();
      perShaderMaterialLayoutCache.clear();
      gpuStore.configureGpuDevice(
        // biome-ignore lint/suspicious/noExplicitAny: MipmapBlitDevice descriptors are typed `any`; RhiDevice satisfies the shape
        internals.device as any,
        internals.pack.createShaderModule as unknown as MipmapShaderModuleFactory | undefined,
        (world, pod) => {
          let handle: Handle<'CubeTextureAsset', 'shared'>;
          handle = world.allocSharedRef('CubeTextureAsset', pod, () => {
            gpuStore.evictCubemap(handleSlot(handle));
          });
          return ok(handle);
        },
        internals.device.caps,
      );
      try {
        await prepareMaterialShaders(internals.device, getShader, assets);
        pipelineState = await buildPipeline();
      } catch {
        // Pipeline rebuild failed against the new device. Treat as a device
        // unavailability (the device was acquired but is not usable); health
        // stays `device-lost` so the host can retry.
        return err(new RecoverError('recover-device-unavailable'));
      }

      // Step (f): the renderer is alive again. The next draw() lazily
      // re-configures the canvas context (ensureContextConfigured keys off the
      // fresh pipelineState's `configured` flag) and re-uploads GPU resources
      // via ensureResident from the preserved CPU POD caches (A-AC-12).
      internals.healthRegistry.fire({ reason: 'alive', recoverable: false });
      return ok(undefined);
    },
    onHealthChange(cb: HealthChangeListener): () => void {
      return internals.healthRegistry.add(cb);
    },
    async debugReadback() {
      if (pipelineState === null) return null;
      return debugReadbackShadowDepth(internals, pipelineState);
    },
    // feat-20260520-directional-light-shadow-mapping M3 / w16 (D-6 + AC-13):
    // debugSampleShadowFactor renders one pixel per probe through the
    // shadow-probe pipeline (constructed in createPipelineState) and reads
    // back the resulting r32float values. The probe shader runs the same
    // textureSampleCompareLevel(shadowMap, shadowSampler, uv, currentDepth)
    // call pbr.wgsl::evalDirectional() uses with the same UV remap and the
    // **same** PipelineState.shadowSampler. M3 probe uses 3x3 PCF + fixed
    // floor-bias 0.005 (conservative lower bound; probe has no surface
    // normal for the slope-dependent term). Caps at
    // PROBE_MAX_COUNT (64); excess inputs are dropped with no error.
    //
    // Separate command encoder per the M1c lesson (see feat-20260520
    // commit ceff773b): binding the shadow RT as both depth-attachment
    // (write) and texture-binding (read) inside the same encoder triggers
    // WebGPU "usage scope" validation and silently drops one side.
    async debugSampleShadowFactor(
      worldPositions: ReadonlyArray<readonly [number, number, number]>,
    ): Promise<ReadonlyArray<{ readonly shadowFactor: number }> | null> {
      if (pipelineState === null) return null;
      const state = pipelineState;
      if (
        state.shadowProbePipeline === null ||
        state.shadowProbeBindGroupLayout === null ||
        state.shadowProbeLsmUbo === null ||
        state.shadowProbeInputBuf === null ||
        state.shadowProbeOutputView === null ||
        state.shadowProbeOutputTex === null ||
        state.shadowProbeStagingBuf === null
      ) {
        return null;
      }
      // feat-20260613-csm-cascaded-shadow-maps M5 / w28: probe consumes
      // the 4-cascade lightViewProj pack + cascadeCount; falls through to
      // single-cascade when the CSM pack hasn't been populated (e.g.
      // pre-extract first frame).
      const csmPack = state.perPassResources.shadowCsmLightViewProj;
      const cascadeCount = state.perPassResources.shadowCascadeCount;
      const lsm = state.perPassResources.shadowLightSpaceMatrix;
      if (csmPack === null && lsm === null) return null;
      // M5-T2: shadow texture view resolved via render-graph getter
      // (`renderSystem.getCurrentShadowView()` -> graph
      // `addColorTarget('shadowDepth', ...)`); the ECS-managed
      // perPassResources slot was deleted in this milestone (D-2
      // SSOT). Falls back to the 1x1 fallback view when the graph
      // has not allocated the target (castShadow:false or
      // shadowMapSize=0).
      const graphShadowView = renderSystem.getCurrentShadowView();
      const probeShadowView =
        graphShadowView !== null ? graphShadowView : state.shadowFallbackTextureView;

      const requested = worldPositions.length;
      const probeCount = Math.min(requested, PROBE_MAX_COUNT);

      // Pack worldPositions into vec4<f32>[64] (16 B per slot; w=1 unused).
      // Slots beyond probeCount are zero-padded — fs_main never reads them
      // because instanceCount = probeCount.
      const inputData = new Float32Array(PROBE_MAX_COUNT * 4);
      for (let i = 0; i < probeCount; i++) {
        const p = worldPositions[i];
        if (p === undefined) continue;
        const base = i * 4;
        inputData[base] = p[0];
        inputData[base + 1] = p[1];
        inputData[base + 2] = p[2];
        inputData[base + 3] = 1.0;
      }

      const inputUploadResult = internals.device.queue.writeBuffer(
        state.shadowProbeInputBuf,
        0,
        inputData.buffer,
        inputData.byteOffset,
        inputData.byteLength,
      );
      if (!inputUploadResult.ok) {
        internals.errorRegistry.fire(inputUploadResult.error);
        return null;
      }

      // LSM UBO write: PROBE_LSM_UBO_BYTES bytes (4 × 64 mat4 + cascadeCount
      // u32 + 12 B pad). Layout mirrors the SHADOW_PROBE_WGSL `CsmLsm` struct.
      // When only the legacy single-mat4 lsm is available (CSM pack null),
      // duplicate it across all 4 cascade slots so the probe still works
      // pre-extract or in single-cascade legacy paths.
      const lsmBytes = new Float32Array(PROBE_LSM_UBO_BYTES / 4);
      const baseMat = csmPack ?? null;
      if (baseMat !== null) {
        for (let i = 0; i < 64; i++) lsmBytes[i] = baseMat[i] ?? 0;
      } else if (lsm !== null) {
        for (let c = 0; c < 4; c++) {
          for (let i = 0; i < 16; i++) lsmBytes[c * 16 + i] = lsm[i] ?? 0;
        }
      }
      // cascadeCount (u32) at byte 256 -> float index 64. Use a Uint32 view
      // sharing the underlying buffer so the value stays a u32 word.
      const lsmU32 = new Uint32Array(lsmBytes.buffer);
      lsmU32[64] = Math.max(1, cascadeCount) >>> 0;
      const lsmUploadResult = internals.device.queue.writeBuffer(
        state.shadowProbeLsmUbo,
        0,
        lsmBytes.buffer,
        lsmBytes.byteOffset,
        PROBE_LSM_UBO_BYTES,
      );
      if (!lsmUploadResult.ok) {
        internals.errorRegistry.fire(lsmUploadResult.error);
        return null;
      }

      // Transient probe BindGroup: binds the **active** shadow texture view
      // (not the 1x1 fallback when a real shadow map exists) + the **same**
      // comparison sampler the main pass viewBindGroup binding(4) uses, so
      // probe + geometry pass cannot drift on sampler config.
      const probeBgResult = internals.device.createBindGroup({
        label: 'shadow-probe-bg',
        layout: state.shadowProbeBindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: state.shadowProbeLsmUbo } },
          },
          {
            binding: 1,
            resource: { kind: 'buffer', value: { buffer: state.shadowProbeInputBuf } },
          },
          {
            binding: 2,
            resource: { kind: 'textureView', value: probeShadowView },
          },
          {
            binding: 3,
            resource: { kind: 'sampler', value: state.perPassResources.shadowSampler },
          },
        ],
      });
      if (!probeBgResult.ok) {
        internals.errorRegistry.fire(probeBgResult.error);
        return null;
      }
      const probeBg = probeBgResult.value;

      // Separate command encoder per M1c lesson — must not share with any
      // in-flight encoder that binds the shadow RT as RenderAttachment.
      const encResult = internals.device.createCommandEncoder({
        label: 'shadow-probe-encoder',
      });
      if (!encResult.ok) {
        internals.errorRegistry.fire(encResult.error);
        return null;
      }
      const enc = encResult.value;

      // Clear value: r=1.0 means "fully lit" — slots beyond probeCount land
      // here, and any fragments outside the rasterised columns (none, since
      // we cover the full RT row exactly) would also default to lit.
      const probePass = enc.beginRenderPass({
        label: 'shadow-probe-pass',
        colorAttachments: [
          {
            view: state.shadowProbeOutputView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 1, g: 0, b: 0, a: 0 },
          },
        ],
      } as never);
      probePass.setPipeline(state.shadowProbePipeline);
      probePass.setBindGroup(0, probeBg);
      probePass.draw(6, probeCount, 0, 0);
      probePass.end();

      enc.copyTextureToBuffer(
        { texture: state.shadowProbeOutputTex as never, aspect: 'all' },
        {
          buffer: state.shadowProbeStagingBuf as never,
          bytesPerRow: PROBE_READBACK_ROW_BYTES,
          rowsPerImage: 1,
        },
        { width: PROBE_MAX_COUNT, height: 1, depthOrArrayLayers: 1 },
      );

      const finishResult = enc.finish();
      if (!finishResult.ok) {
        internals.errorRegistry.fire(finishResult.error);
        return null;
      }
      const submitResult = internals.device.queue.submit([finishResult.value]);
      if (!submitResult.ok) {
        internals.errorRegistry.fire(submitResult.error);
        return null;
      }

      const mapResult = await state.shadowProbeStagingBuf.mapAsync(1);
      if (!mapResult.ok) {
        internals.errorRegistry.fire(mapResult.error);
        return null;
      }
      const mappedBuf = mapResult.value;
      const rangeResult = mappedBuf.getMappedRange();
      if (!rangeResult.ok) {
        internals.errorRegistry.fire(rangeResult.error);
        return null;
      }
      const data = new Float32Array(rangeResult.value);
      const results: { shadowFactor: number }[] = [];
      for (let i = 0; i < requested; i++) {
        if (i < probeCount) {
          results.push({ shadowFactor: data[i] ?? 1 });
        } else {
          // Caller asked for more than PROBE_MAX_COUNT; surface a sentinel
          // 1.0 (fully lit) so length matches the request without inventing
          // a new error code (charter F2 minimal surface).
          results.push({ shadowFactor: 1 });
        }
      }
      mappedBuf.unmap();

      return results;
    },
    get directionalShadow() {
      if (pipelineState === null) return null;
      return directionalShadowSnapshot(pipelineState);
    },
    // feat-20260601-customizable-render-pipeline-seam M1 / w8: 1:1 forwards to the
    // RenderSystem layer (plan-strategy D-D: all real logic lives there; the facade is a
    // zero-processing pass-through, same pattern as the perFramePassNames getter above).
    registerPipeline(id, impl) {
      renderSystem.registerPipeline(id, impl);
    },
    installPipeline(asset) {
      return renderSystem.installPipeline(asset);
    },
    // F-2 fix-up: 1:1 forward to RenderSystem.postProcess.register (D-D zero
    // processing — the registry + dedup live on the RenderSystem closure).
    postProcess: {
      register(id, entry) {
        renderSystem.postProcess.register(id, entry);
      },
    },
    // feat-20260612-skin-palette-per-frame-upload M1 / m1-1: @internal test
    // hatch — returns the closure-held `pipelineState` (or `null` before
    // `await renderer.ready` settles). Same shape as `getPipelineState`
    // already passed into `createRenderSystem` above, exposed on the public
    // Renderer object for unit tests asserting PipelineState field presence
    // (e.g. `skinPaletteAllocator` after stub retirement). Returns `unknown`
    // so the public surface stays opaque; callers cast at the test boundary.
    _internal_getPipelineState() {
      return pipelineState;
    },
    /**
     * @internal Register a frame-end listener. Returns an unsubscribe function.
     * Only non-null when FORGEAX_ENGINE_RHI_DEBUG=1 + recorder attached (m3-1 wiring).
     * Fires after renderSystem.draw(world) completes each frame.
     */
    _onFrameEnd(listener: () => void): () => void {
      _onFrameEndListeners.add(listener);
      return () => {
        _onFrameEndListeners.delete(listener);
      };
    },
  };
  return renderer;
}

// ─── feat-20260520-directional-light-shadow-mapping M1c / w8 helpers ────────

/**
 * debugReadbackShadowDepth: reads 5 depth pixels from the shadow RT via
 * copyTextureToBuffer + mapAsync + Float32Array direct read.
 *
 * D-2 round-3: format = depth32float -> Float32Array direct read;
 * no 24-in-32 unorm decode. D-5: 5 pixel integer coordinates
 * (center + 4 corners), whole-image copy with 256B-aligned row stride,
 * JS-side strided read of the 5 target pixels.
 */
async function debugReadbackShadowDepth(
  internals: WebGPURendererInternals,
  state: PipelineState,
): Promise<{
  readonly center: number;
  readonly corners: {
    readonly tl: number;
    readonly tr: number;
    readonly bl: number;
    readonly br: number;
  };
  readonly mapSize: number;
} | null> {
  const tex = state.perPassResources.shadowTexture;
  if (tex === null) return null;
  const mapSize = state.perPassResources.shadowMapSize;
  if (mapSize <= 0) return null;

  // feat-20260613-csm-cascaded-shadow-maps M5 / w28: shadow texture is now
  // a `tilesPerSide × mapSize` atlas (2 × mapSize for cascadeCount<=4).
  // depth32float copyTextureToBuffer requires copying the entire
  // subresource, so we read the full atlas and slice the cascade-0
  // quadrant for the legacy center / corners API contract.
  const cascadeCount = Math.max(1, state.perPassResources.shadowCascadeCount);
  const tilesPerSide = cascadeCount <= 1 ? 1 : 2;
  const atlasSize = tilesPerSide * mapSize;

  const bytesPerPixel = 4; // depth32float
  const rowBytes = atlasSize * bytesPerPixel;
  // 256B alignment per WebGPU spec copyTextureToBuffer bytesPerRow requirement
  const alignedRowBytes = ((rowBytes + 255) >> 8) << 8;
  const totalBytes = alignedRowBytes * atlasSize;

  // COPY_DST = 0x08, MAP_READ = 0x01
  const COPY_DST = 0x08;
  const MAP_READ = 0x01;
  const bufResult = internals.device.createBuffer({
    label: 'shadow-readback-staging',
    size: totalBytes,
    usage: COPY_DST | MAP_READ,
    mappedAtCreation: false,
  });
  if (!bufResult.ok) {
    internals.errorRegistry.fire(bufResult.error);
    return null;
  }
  const stagingBuf = bufResult.value;

  const encResult = internals.device.createCommandEncoder({ label: 'shadow-readback-encoder' });
  if (!encResult.ok) {
    internals.errorRegistry.fire(encResult.error);
    return null;
  }
  const enc = encResult.value;

  enc.copyTextureToBuffer(
    { texture: tex as never, aspect: 'depth-only' },
    { buffer: stagingBuf as never, bytesPerRow: alignedRowBytes, rowsPerImage: atlasSize },
    { width: atlasSize, height: atlasSize, depthOrArrayLayers: 1 },
  );

  const finishResult = enc.finish();
  if (!finishResult.ok) {
    internals.errorRegistry.fire(finishResult.error);
    return null;
  }
  const submitResult = internals.device.queue.submit([finishResult.value]);
  if (!submitResult.ok) {
    internals.errorRegistry.fire(submitResult.error);
    return null;
  }

  const mapResult = await stagingBuf.mapAsync(1);
  if (!mapResult.ok) {
    internals.errorRegistry.fire(mapResult.error);
    return null;
  }
  const mappedBuf = mapResult.value;
  const rangeResult = mappedBuf.getMappedRange();
  if (!rangeResult.ok) {
    internals.errorRegistry.fire(rangeResult.error);
    return null;
  }
  const data = new Float32Array(rangeResult.value);

  // D-5: 5 pixel integer coordinates
  const cx = mapSize >> 1;
  const cy = mapSize >> 1;
  const readPixel = (x: number, y: number): number => {
    const offset = y * alignedRowBytes + x * bytesPerPixel;
    // Float32Array indices are in f32 units (bytesPerPixel = 4, so offset/4)
    return data[offset >> 2] ?? 0;
  };

  const result = {
    center: readPixel(cx, cy),
    corners: {
      tl: readPixel(0, 0),
      tr: readPixel(mapSize - 1, 0),
      bl: readPixel(0, mapSize - 1),
      br: readPixel(mapSize - 1, mapSize - 1),
    },
    mapSize,
  };

  mappedBuf.unmap();
  // forgeax Buffer wrapper does not expose destroy(); the underlying
  // GPUBuffer is reclaimed when the JS wrapper is garbage-collected.

  return result;
}

/**
 * directionalShadowSnapshot: reads the current shadow configuration
 * (mapSize, lightSpaceMatrix) from PipelineState. Returns null when no
 * shadow RT exists (shader manifest empty or castShadow:false).
 */
function directionalShadowSnapshot(state: PipelineState): {
  readonly mapSize: number;
  readonly lightSpaceMatrix: readonly number[] | null;
} | null {
  if (state.perPassResources.shadowTexture === null) return null;
  return {
    mapSize: state.perPassResources.shadowMapSize,
    lightSpaceMatrix: state.perPassResources.shadowLightSpaceMatrix
      ? Array.from(state.perPassResources.shadowLightSpaceMatrix)
      : null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

/**
 * V-2 first-class input shim (plan-strategy D-2 + AC-09 — feat-20260519).
 *
 * Curried `input.snapshot(world)` reader (charter P4 consistent abstraction).
 * Holds no World reference (P5 producer/consumer split); reads via
 * `world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)` per call.
 */
const RENDERER_INPUT_FACADE: {
  snapshot(world: World): InputSnapshot | undefined;
} = {
  snapshot(world: World): InputSnapshot | undefined {
    // World.getResource throws on missing key; charter P3 demands the
    // empty signal be the signal here (callers check `=== undefined`),
    // so guard with hasResource first.
    if (!world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) return undefined;
    return world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
  },
};

/**
 * Sync-shaped `ShaderRegistryDevice` adapter wrapping `@forgeax/engine-rhi-webgpu`'s
 * async `createShaderModule(rhiDevice, desc)`.
 *
 * Shape: fire-and-forget pre-bake — the first call for hash X returns
 * `Result.err(RhiError)` (a pending signal) while kicking off the async
 * createShaderModule + cache write; subsequent calls for the same hash hit
 * the cache and return `Result.ok(ShaderModule)` (charter proposition 9
 * graceful degradation).
 *
 * @placeholder M3 scope limit: the full async pre-bake wiring is delivered
 * by the ECS-driven render pipeline (later closure). The current shape is
 * already enough to support MVP-2.2 instance-per-engine + AI consumer
 * onboarding (charter proposition 1 progressive disclosure / proposition 4
 * explicit failure with retry guidance in the error hint).
 */
/**
 * Extended ShaderRegistryDevice contract for engine internals: adds a
 * `seedModule(label, module)` to populate the lazy adapter cache from an
 * already-compiled module, so eager-built modules (PBR / unlit / shadow
 * caster) and the lazy MaterialShader pipeline cache share one cache and
 * the lazy path is hit-on-first-call (no 1-frame warmup) for engine-shipped
 * shaders. Externally still typed as ShaderRegistryDevice (see callers in
 * ShaderRegistry).
 */
interface ShaderDeviceAdapterInternal extends ShaderRegistryDevice {
  /**
   * feat-20260609 R3-fixup: seed the adapter's moduleCache with an
   * already-compiled ShaderModule under `label`. Used by the eager
   * shadow_caster pre-bake so the lazy PSO build hit on
   * `module-forgeax::default-shadow-caster` returns OK on frame 1.
   */
  seedModule(label: string, module: ShaderModule): void;
}

function makeShaderDeviceAdapter(
  rhiDevice: RhiDevice,
  _errorRegistry: RhiErrorListenerRegistry,
  asyncCreateShaderModule:
    | ((
        device: RhiDevice,
        desc: { code: string; label?: string | undefined },
      ) => Promise<Result<ShaderModule, RhiError>>)
    | undefined,
): ShaderDeviceAdapterInternal {
  const moduleCache = new Map<string, ShaderModule>();
  const errorCache = new Map<string, RhiError>();
  const pending = new Set<string>();

  return {
    createShaderModule(desc): Result<ShaderModule, RhiError> {
      const key = desc.label ?? desc.code;
      const cachedModule = moduleCache.get(key);
      if (cachedModule !== undefined) return ok(cachedModule);
      const cachedError = errorCache.get(key);
      if (cachedError !== undefined) return err(cachedError);

      // Fire async creation; first sync call returns pending error (the AI consumer retry pattern).
      // M3 D-P4: rhi-webgpu supplies the async factory; rhi-wgpu (no top-level
      // async factory) falls back to the synchronous device.createShaderModule
      // entry which already returns Result<ShaderModule, RhiError>.
      if (!pending.has(key)) {
        pending.add(key);
        const desc2: { code: string; label?: string | undefined } = { code: desc.code };
        if (desc.label !== undefined) desc2.label = desc.label;
        const asyncResult: Promise<Result<ShaderModule, RhiError>> = asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, desc2)
          : invokeDeviceCreateShaderModule(rhiDevice, desc2);
        void asyncResult.then((result) => {
          if (result.ok) {
            moduleCache.set(key, result.value);
          } else {
            errorCache.set(key, result.error);
          }
          pending.delete(key);
        });
      }

      return err(makeRhiNotAvailableError());
    },
    seedModule(label: string, module: ShaderModule): void {
      moduleCache.set(label, module);
    },
  };
}

/**
 * Fallback path for the M3 D-P4 auto-select facade when the backend pack
 * does not supply a top-level async `createShaderModule` (e.g. the rhi-wgpu
 * path which routes through the synchronous `device.createShaderModule`
 * entry, or an explicit escape-hatch instance that omits the async
 * factory). The forgeax `RhiDevice` interface intentionally does not expose
 * a sync `createShaderModule` (fix-f3; see packages/rhi/src/index.ts line
 * 1164), so this helper performs a structural probe + returns a structured
 * error when neither the async factory nor a structural sync entry exists
 * (charter proposition 4 explicit failure baseline).
 */
function invokeDeviceCreateShaderModule(
  rhiDevice: RhiDevice,
  desc: { code: string; label?: string | undefined },
): Promise<Result<ShaderModule, RhiError>> {
  const candidate = (
    rhiDevice as unknown as {
      createShaderModule?: (d: {
        code: string;
        label?: string | undefined;
      }) => Result<ShaderModule, RhiError>;
    }
  ).createShaderModule;
  if (typeof candidate === 'function') {
    try {
      return Promise.resolve(candidate.call(rhiDevice, desc));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return Promise.resolve(
        err(
          new RhiError({
            code: 'shader-compile-failed',
            expected: 'device.createShaderModule returns Result<ShaderModule, RhiError>',
            hint: `synchronous fallback threw: ${message}`,
          }),
        ),
      );
    }
  }
  return Promise.resolve(
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected:
          'either RhiBackendPack.createShaderModule (async) or device.createShaderModule (sync) available',
        hint: 'the explicit RhiInstance escape hatch must expose a top-level createShaderModule(device, desc) or RhiDevice.createShaderModule(desc) entry',
      }),
    ),
  );
}

/**
 * Synthesizes a `RhiError` with code 'rhi-not-available' for the
 * sync-adapter pending path. AI-consumer onboarding: consume
 * `.code === 'rhi-not-available'` → after `await loadManifest` retry
 * `registry.get` (charter proposition 4 explicit failure + proposition 9).
 *
 * 'rhi-not-available' is the placeholder member of the 5-member closed
 * union (plan-decisions OQ-P2).
 */
function makeRhiNotAvailableError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'shader module pre-bake to complete asynchronously',
    hint: 'await registry.loadManifest() finished; retry registry.get(hash) on next frame',
  });
}

// ─── D-S3 Renderer.ready three-step serial pipeline ─────────────────────────

// feat-20260518-pbr-direct-lighting-mvp M5 / w22.9 (AC-05 + plan-strategy
// D-3 + D-4): the legacy inline fallback PBR-shaped WGSL source has been
// deleted in favor of the manifest-driven path. The build-time
// `@forgeax/engine-vite-plugin-shader` plugin eagerly compiles
// `@forgeax/engine-shader/src/{pbr,unlit}.wgsl` (with common.wgsl + brdf.wgsl
// as naga_oil `#import` peers) at `buildStart`; the runtime path consumes
// the resulting manifest entries via `getShader().get(<hash>)`. The two
// distinct shader modules are wired into the three render pipelines
// (`unlitBuiltinPipeline` + `unlitPipeline` for unlit at the 6F
// vs 12F vertex strides; `standardPipeline` for PBR at 12F stride) so the
// triple-pipeline contract (M5 / w22.10 + w22.11) hands distinct
// `unlitBuiltinPipeline.module === unlitPipeline.module !==
// standardPipeline.module` GPU handles back to `RenderSystem` per-frame
// dispatch (D-P4 + AGENTS.md `MeshRenderer` shadingModel discriminant).

const GPU_BUFFER_USAGE_MAP_READ = 0x01;
const GPU_BUFFER_USAGE_VERTEX = 0x20;
const GPU_BUFFER_USAGE_INDEX = 0x10;
const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const GPU_BUFFER_USAGE_STORAGE = 0x80;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_SHADER_STAGE_FRAGMENT = 0x2;

// Per-pipeline buffer sizes consumed by the manifest-shipped pbr / unlit
// shaders (D-S2 + plan-strategy; w22.9 retired the inline fallback shader
// constant in favor of the @forgeax/engine-vite-plugin-shader manifest path):
//   View    UBO  : worldViewProj mat4x4<f32> = 64 bytes (frame-shared)
//   Material UBO : { vec3 baseColor, f32 metallic, f32 roughness } padded to 32
//   Mesh    SSBO : runtime-sized `array<Mesh>` where Mesh = mat4x4<f32> =
//                  64 bytes (indexed via @builtin(instance_index), bound
//                  with size = instanceCount * 64 B per draw; D-P9)
//
// feat-20260513-instanced-mesh M5 (T-M5-1 + T-M5-3): legacy
// per-frame entity-count cap removed.
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15: the
// `'limit-exceeded'` emit point migrated from the now-deleted
// `AssetRegistry.createInstancedBuffer` factory to the RenderSystem record
// stage's per-entity instance buffer upload path
// (`packages/runtime/src/render-system-record.ts`); the cap-check still
// runs against `device.limits.maxStorageBufferBindingSize`, but the
// `requestedBytes` now reflects the ECS-managed `Instances.transforms`
// snapshot size per frame. The shared `meshStorageBuffer` and
// `materialUniformBuffer` are owned by `meshSsboController` (M2 / T-M2-05):
// the initial allocation lands at `INITIAL_MESH_SSBO_SLOT_COUNT = 1024`
// slots and grows on demand via `growMeshSsbo(neededSlots)` (pow2 doubling,
// ceiling = `device.limits.maxStorageBufferBindingSize` per plan-strategy
// §2.D-1; spec floor of 128 MiB / 256 B stride = 524288 slots theoretical
// max).
//
// `PER_ENTITY_STRIDE = 256` is retained for the material UBO path
// (D-P9 trade-off; material binding still uses per-entity dynamic
// offsets, supersede in OOS-02 `feat-future-render-world`). The mesh
// storage buffer is allocated at `PER_ENTITY_STRIDE * slotCount` size
// during initial build (slotCount = INITIAL_MESH_SSBO_SLOT_COUNT) and
// pow2-doubled per grow event; the new path writes the leading
// `instanceCount * 64 B` (tight-packed) per renderable into the
// allocated slot.
// feat-20260518-pbr-direct-lighting-mvp M3 / w13 + AC-07 std140 layout:
//   View    UBO  : worldViewProj (64 B mat4) + lightDir (16 B vec3+pad) +
//                  lightColor (16 B vec3+pad) + cameraPos (16 B vec3+pad)
//                  = 112 B (frame-shared). Field order matches common.wgsl
//                  `View` struct byte-for-byte (single SSOT, charter P5).
//                  Naming: cameraPos (not viewPos) -> mirrors pbr.wgsl
//                  `view.cameraPos` literal.
//
// feat-20260520-directional-light-shadow-mapping M1b / w7: extended to 176 B.
// feat-20260531-skybox-env-background M2 / w3: extended to 240 B.
// inverseViewProj mat4x4<f32> (64 B) appended at tail (offset 176, align 16,
// total 176 + 64 = 240 B). Field added to common.wgsl View struct; host
// writes the tail via queue.writeBuffer in render-system-record.
// feat-20260613-csm-cascaded-shadow-maps M4 / w16: extended to 592 B.
// lightSpaceMatrix replaced by lightViewProj_A at offset 112; inverseViewProj
// stays at offset 176; lightViewProj_B..D + splitPlanes[4] + cascadeCount +
// cascadeBlend + tail padding appended after inverseViewProj. Total 148 f32
// = 592 B, fixed independent of cascadeCount (AC-08).
// feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t3:
// depthBias / normalBias / pcfKernelSize from the merged DirectionalLight
// append at the formerly-free tail pad (bytes 504/508/512, floats 126/127/128).
// VIEW_UBO_BYTES stays 592 (the host tail pad shrinks 88 B -> 64 B); the WGSL
// View struct in common.wgsl carries the matching 3 f32 (SSOT comment synced).
const VIEW_UBO_BYTES = 592;

// ── feat-20260520-directional-light-shadow-mapping M2 / w15 (AC-12 numeric flip)
//
// debugSampleShadowFactor probe pipeline. Renders one pixel per probe into a
// 1xN r32float color attachment using a fragment shader that mirrors
// pbr.wgsl::evalDirectional()'s M3 shadow lookup (slope-scaled bias + 3x3 PCF).
// The probe uses a fixed floor-bias of 0.005 (no normal-dependent slope term)
// because it only receives world positions, not surface normals. This is the
// minimum-bias floor the main pass applies; the probe's result is a conservative
// lower bound on the actual shadow factor.
//
// M3 probe uses textureLoad (returns raw f32 from texture_depth_2d) for 9-tap
// PCF; the comparison sampler (binding 3) is retained in the bindings for layout
// compatibility with the probe BindGroupLayout but is unused by the M3 probe
// fragment stage.
//
// Probe count cap: 64. AI users wanting more should batch. Keeps the
// readback staging buffer at 256 B (single 256B-aligned row).
const PROBE_MAX_COUNT = 64;
const PROBE_INPUT_BYTES = PROBE_MAX_COUNT * 16; // array<vec4<f32>, 64>
// feat-20260613-csm-cascaded-shadow-maps M5 / w28: probe LSM UBO carries
// 4 cascade lightViewProj matrices (4 × 64 B = 256 B) + cascadeCount u32
// + 12 B pad to 16 B = 272 B; round up to 288 for std140 / 16 B alignment.
// The shader walks the 4 matrices in order and picks the first cascade
// whose projected (uv, z) falls inside [0,1]^3 -- the geometric equivalent
// of the main path's viewZ-based cascade selection (probe has no camera
// matrix, so frustum-containment is the closed form).
const PROBE_LSM_UBO_BYTES = 288;
const PROBE_OUTPUT_TEXTURE_FORMAT: GPUTextureFormat = 'r32float';
const PROBE_READBACK_ROW_BYTES = 256; // 256B-aligned per WebGPU spec; 64*4=256 B already

const SHADOW_PROBE_WGSL = `
struct CsmLsm {
  m0 : mat4x4<f32>,
  m1 : mat4x4<f32>,
  m2 : mat4x4<f32>,
  m3 : mat4x4<f32>,
  cascadeCount : u32,
  probePadA : u32,
  probePadB : u32,
  probePadC : u32,
};
struct WorldPositions { p : array<vec4<f32>, ${PROBE_MAX_COUNT}> };

@group(0) @binding(0) var<uniform> lsm : CsmLsm;
@group(0) @binding(1) var<storage, read> worldPositions : WorldPositions;
@group(0) @binding(2) var shadowMap : texture_depth_2d;
@group(0) @binding(3) var shadowSampler : sampler_comparison;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) @interpolate(flat) probeIdx : u32,
};

@vertex fn vs_main(@builtin(vertex_index) v : u32, @builtin(instance_index) i : u32) -> VsOut {
  let n = f32(${PROBE_MAX_COUNT});
  let xL = (f32(i) / n) * 2.0 - 1.0;
  let xR = (f32(i + 1u) / n) * 2.0 - 1.0;
  var x : f32 = xL;
  var y : f32 = -1.0;
  switch (v) {
    case 0u: { x = xL; y = -1.0; }
    case 1u: { x = xR; y = -1.0; }
    case 2u: { x = xR; y =  1.0; }
    case 3u: { x = xL; y = -1.0; }
    case 4u: { x = xR; y =  1.0; }
    default: { x = xL; y =  1.0; }
  }
  var out : VsOut;
  out.clip = vec4<f32>(x, y, 0.0, 1.0);
  out.probeIdx = i;
  return out;
}

fn _probeCascadeMatrix(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return lsm.m0; }
    case 1u: { return lsm.m1; }
    case 2u: { return lsm.m2; }
    default: { return lsm.m3; }
  }
}

@fragment fn fs_main(in : VsOut) -> @location(0) f32 {
  let p4 = worldPositions.p[in.probeIdx];
  // Walk cascades in order; pick the first whose projection lands inside
  // its tile-local UV [0,1]^2 with z <= 1. Cascades are nested (cascade 0
  // tight near, cascade 3 wide far) so the smallest containing cascade
  // wins -- same geometric containment evalDirectional resolves via
  // viewZ + splitPlanes in the main path.
  let count = max(lsm.cascadeCount, 1u);
  let tilesPerSide : u32 = select(2u, 1u, count <= 1u);
  let inv = 1.0 / f32(tilesPerSide);
  var uv : vec2<f32> = vec2<f32>(2.0, 2.0);
  var currentDepth : f32 = 2.0;
  for (var c : u32 = 0u; c < count; c = c + 1u) {
    let m = _probeCascadeMatrix(c);
    let lightClip = m * vec4<f32>(p4.xyz, 1.0);
    let projCoords = lightClip.xyz / lightClip.w;
    let tileUv = vec2<f32>(projCoords.x * 0.5 + 0.5, -projCoords.y * 0.5 + 0.5);
    let candDepth = projCoords.z;
    if (tileUv.x >= 0.0 && tileUv.x <= 1.0 && tileUv.y >= 0.0 && tileUv.y <= 1.0 && candDepth <= 1.0) {
      let col = c % tilesPerSide;
      let row = c / tilesPerSide;
      let tileOrigin = vec2<f32>(f32(col) * inv, f32(row) * inv);
      uv = tileUv * inv + tileOrigin;
      currentDepth = candDepth;
      break;
    }
  }
  var shadow : f32 = 1.0;
  let bias : f32 = 0.005;
  let adjustedDepth : f32 = currentDepth - bias;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 && currentDepth <= 1.0) {
    let texelDims = vec2<f32>(textureDimensions(shadowMap, 0));
    let baseCoord = vec2<i32>(uv * texelDims);
    let maxCoord = vec2<i32>(texelDims) - vec2<i32>(1, 1);
    var blocked : f32 = 0.0;
    for (var x = -1; x <= 1; x++) {
      for (var y = -1; y <= 1; y++) {
        let sampleCoord = clamp(baseCoord + vec2<i32>(x, y), vec2<i32>(0, 0), maxCoord);
        let pcfDepth = textureLoad(shadowMap, sampleCoord, 0);
        if (adjustedDepth > pcfDepth) {
          blocked = blocked + 1.0;
        }
      }
    }
    shadow = 1.0 - blocked / 9.0;
  }
  return shadow;
}
`;

// Canvas swap-chain storage + view formats.
//
// `bug-20260519` — wood-container looked black on screen because pipelines
// authored linear values (sampler decoded `rgba8unorm-srgb` -> linear) into
// a `bgra8unorm` (linear) canvas; the display interpreted the linear bytes
// as sRGB-encoded and crushed them near zero.
//
// Fix: configure canvas storage as `bgra8unorm` and provide
// `bgra8unorm-srgb` in `viewFormats` so the per-frame `createTextureView`
// can yield the sRGB *view*. Pipelines target the sRGB view -> the GPU
// encodes linear -> sRGB on store; the display decodes sRGB back to
// linear, so colours land correctly.
//
// Spec anchor: W3C WebGPU §3.3 GPUCanvasConfiguration disallows
// `format: '<...>-srgb'` directly; the srgb-via-viewFormats path is the
// canonical recipe.
// bug-20260610: switched from `bgra8unorm` to `rgba8unorm` so the same
// constant works on both backends. WebGPU spec allows both as a canvas
// storage format on browser-native WebGPU (D3D / Metal), and wgpu's GLES
// backend only supports Rgba (Bgra is hardware-illegal on OpenGL ES 3.0).
// RGBA-on-Metal/D3D pays at most a tiny driver-side swizzle which is
// invisible to AI users; the alternative — branching the format per
// backend — would split every demo's pipeline-target list and viewFormats
// declarations into two parallel chains for no measurable gain.
//
// bug-20260612: superseded — the trade-off above (one tiny swizzle hidden
// from AI users) ignored the per-frame Chromium "configured with a
// different format than is preferred" warning that pollutes hello-* demo
// console capture. The module-level `SWAP_CHAIN_STORAGE_FORMAT` /
// `SWAP_CHAIN_VIEW_FORMAT` constants were deleted; both formats now flow
// from `selectSwapChainFormat(storageBufferCapable)` (defined below) into
// `PipelineState.format` / `.colorAttachmentFormat` and from there into
// every pipeline target / configure() call. Channel 2 follows
// `navigator.gpu.getPreferredCanvasFormat()`; Channel 3 keeps `rgba8unorm`
// (GLES hardware constraint). The historical comment block above is
// retained as the OOS-5 evolution record.

// bug-20260612: backend-aware swap-chain format selection. bug-20260610's
// hard-coded `rgba8unorm` triggers Chromium's "configured with a different
// format than is preferred ... extra copy ... may impact performance"
// warning every time the canvas is configured on Channel 2 (D3D / Metal /
// Vulkan all prefer `bgra8unorm` via the WebGPU-spec `getPreferredCanvasFormat`
// entry point). The console noise pollutes hello-* demo capture and misleads
// AI users debugging unrelated issues (charter F1 + P3).
//
// Branching by `storageBufferCapable` (Channel 2 native WebGPU = true /
// Channel 3 wgpu-wasm GLES = false) preserves the GLES hardware constraint
// (Bgra-on-OpenGL-ES is illegal — wgpu rejects it) while letting the
// browser-native path follow UA preference. The `view` format is the
// `${storage}-srgb` partner; WebGPU spec §3.3 allows both
// `bgra8unorm` / `bgra8unorm-srgb` and `rgba8unorm` / `rgba8unorm-srgb`
// pairs through the `viewFormats` srgb route.
//
// Three-step protection inside `selectSwapChainFormat`:
//   1. `storageBufferCapable === false` → hard `rgba8unorm` (Channel 3 GLES
//      hardware constraint; `navigator.gpu` is irrelevant in this branch).
//   2. `storageBufferCapable === true` + `navigator.gpu.getPreferredCanvasFormat`
//      callable → use the spec-preferred format from the UA (typically
//      `bgra8unorm` on Chrome / Edge / Safari).
//   3. `storageBufferCapable === true` but `navigator.gpu` missing or
//      `getPreferredCanvasFormat` not a function (very old UA, or test
//      shim) → fall back to `rgba8unorm` and surface a structured
//      `RhiError { code: 'rhi-not-available' }` through the renderer's
//      error registry so AI users can subscribe via `Renderer.onError(cb)`
//      and react. Charter P3: explicit failure > silent fallback.
//
// Exported (module-private to runtime; **not** re-exported through the
// `@forgeax/engine-runtime` barrel) so the unit test can import it
// without spinning up a renderer. Consumers outside this module must
// not depend on it — public swap-chain-format negotiation is **not**
// part of the engine surface.
export interface SwapChainFormatPair {
  readonly storage: GPUTextureFormat;
  readonly view: GPUTextureFormat;
  /**
   * Set when step ③ above fired. Caller (buildReadyWebGPU) inspects this
   * field to fire a structured RhiError through the registry. `undefined`
   * on the happy paths (steps ① and ②).
   */
  readonly fallbackReason?: 'preferred-canvas-format-missing';
}

/** @internal */
export function selectSwapChainFormat(storageBufferCapable: boolean): SwapChainFormatPair {
  if (storageBufferCapable === false) {
    // Step ①: Channel 3 wgpu-wasm WebGL2 — Bgra is hardware-illegal on
    // OpenGL ES 3.0 (wgpu's GLES backend rejects it via downlevel flags).
    return { storage: 'rgba8unorm', view: 'rgba8unorm-srgb' };
  }
  // Step ②: Channel 2 native WebGPU — follow UA preference.
  const nav = (
    globalThis as { navigator?: { gpu?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } }
  ).navigator;
  const gpu = nav?.gpu;
  const getPreferred = gpu?.getPreferredCanvasFormat;
  if (gpu !== undefined && typeof getPreferred === 'function') {
    const storage = getPreferred.call(gpu);
    return { storage, view: `${storage}-srgb` as unknown as GPUTextureFormat };
  }
  // Step ③: navigator.gpu absent or getPreferredCanvasFormat not a function.
  // Fall back to rgba8unorm + flag the diagnostic; caller fires RhiError.
  return {
    storage: 'rgba8unorm',
    view: 'rgba8unorm-srgb',
    fallbackReason: 'preferred-canvas-format-missing',
  };
}

// feat-20260519-tonemap-reinhard-mvp / M2 / T-M2.5: HDR offscreen colour
// attachment format. `rgba16float` is the WebGPU spec's filterable HDR
// format (no `float32-filterable` feature gate required) and carries enough
// dynamic range for the Reinhard-extended luminance compression to land
// physically-meaningful values (research F1 + Constraints C1-C2 +
// plan-strategy D-2 / AC-03(d)). The post-process tonemap pass samples this
// attachment and writes the LDR result into the swap-chain's
// `bgra8unorm-srgb` view.
const HDR_COLOR_ATTACHMENT_FORMAT: GPUTextureFormat = 'rgba16float';

// feat-20260601-gpu-resource-store-extraction M1 (D-9 sub-contract 1): texture
// formats prewarmed into the mipmap pipeline cache at `renderer.ready` so the
// record-stage `gpuStore.ensureResident` texture arm runs a pure-synchronous
// mipmap blit (no lazy async build inside the sync draw frame). Covers every
// `mipmap:true` 2D texture format the smoke set uploads: `rgba8unorm-srgb`
// (sRGB color / sprite / wood) + `rgba8unorm` (linear normal / metallic-rough /
// occlusion maps). HDR equirect (`rgba16float` / `rgba32float`) is uploaded via
// the eager `uploadCubemapFromEquirect` cubemap path, NOT the sync texture arm,
// so it is intentionally absent here. A `mipmap:true` texture in an
// un-prewarmed format surfaces a structured RhiError at record (never an
// async stall) -- the falsifiable anchor for an incomplete prewarm list.
const MIPMAP_PREWARM_FORMATS: readonly GPUTextureFormat[] = ['rgba8unorm-srgb', 'rgba8unorm'];

// feat-20260531-bloom-first-declarative-render-graph-pass / w13:
// UBO sizes for bloom params (std140 layout).
//   BRIGHT:   threshold (f32)             + 12 B pad = 16 B
//   BLUR:     texelSize.xy (vec2f) + radius (f32) + pad = 16 B
//   COMPOSITE: intensity (f32)            + 12 B pad = 16 B
const BRIGHT_PARAMS_BYTES = 16;
const BLUR_PARAMS_BYTES = 16;
const COMPOSITE_PARAMS_BYTES = 16;

// Depth-stencil format for the per-frame depth attachment. `depth24plus-stencil8`
// is the WebGPU-mandated format on every adapter (core required format);
// pipelines and the per-frame `createTexture(...)` call agree on this single
// literal so the renderpass attachment + pipeline format match. bug-20260519:
// without a depth attachment + back-face cull every cube triangle painted in
// submission order — the back face overdrew the front face and the side
// faces showed as a wood-coloured rim outside the front-face footprint.
const DEPTH_TEXTURE_FORMAT: GPUTextureFormat = 'depth24plus-stencil8';

const PER_ENTITY_STRIDE = 256;
// feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-05:
// the legacy MESH_SSBO_SLOT_COUNT / MATERIAL_UBO_TOTAL_BYTES /
// MESH_SSBO_TOTAL_BYTES literal-1024 module constants are gone. The
// renderer now starts at INITIAL_MESH_SSBO_SLOT_COUNT and grows on demand
// via `createMeshSsboGrowController` (pow2 doubling, ceiling =
// device.limits.maxStorageBufferBindingSize / PER_ENTITY_STRIDE per
// plan-strategy §2.D-1). PER_ENTITY_STRIDE stays at 256 B (OOS-10:
// stride is unchanged; only slotCount grows).
const INITIAL_MESH_SSBO_SLOT_COUNT = 1024;

// ── createMeshSsboGrowController ───────────────────────────────────────────
//
// feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-05:
// pure factory that owns the mesh-SSBO + material-UBO grow state. State is
// closure-local (plan-strategy §2.D-4: no separate allocator class — state
// stays beside its createBuffer producer). Outer wrapper-object identity is
// stable across grow so PipelineState.meshStorageBuffer / materialUniformBuffer
// references never dangle (research §F8 / §3.1 R1); inner `.buffer` is
// replaced by a fresh createBuffer return value when the grow path runs.
//
// Grow algorithm (AC-05 / AC-06):
//   1. If `slotCount >= needed` → idempotent guard short-circuits with `{ ok: true }`.
//   2. Compute `targetSlots = nextPow2 doubling from slotCount until >= needed`.
//   3. If `targetSlots * stride > device.limits.maxStorageBufferBindingSize`
//      → fire `MeshSsboCeilingReachedError` and return `{ ok: false, code: 'mesh-ssbo-ceiling-reached' }`.
//      No createBuffer is called; recordFrame is expected to skip the frame.
//   4. createBuffer × 2 (mesh + material) sized at `targetSlots * stride`,
//      using the usage flags captured at construction (mesh = STORAGE|COPY_DST,
//      material = UNIFORM|COPY_DST — both unchanged from initialBuild).
//   5. Replace `state.mesh.buffer` and `state.material.buffer` in-place;
//      update `state.mesh.sizeInBytes` and `state.material.sizeInBytes`;
//      bump `state.slotCount = targetSlots`.
//   6. Defensive belt-and-suspenders: if the grow somehow lands with
//      `state.slotCount < needed` (shouldn't happen given the pow2 invariant)
//      → fire `MeshSsboCapacityExceededError` and return capacity-exceeded.
//
// Errors flow through `errorRegistry.fire` only (D-5: never throw — keeps the
// grow surface compatible with the recordFrame outer try/catch without
// dual-firing through 'webgpu-runtime-error').

/** Pow2 round-up — smallest power of 2 >= n (n>=1). */
function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let v = 1;
  while (v < n) v <<= 1;
  return v;
}

/**
 * WebGPU spec floor for `maxStorageBufferBindingSize` (128 MiB).
 * @see {@link https://www.w3.org/TR/webgpu/#dom-supported-limits-maxstoragebufferbindingsize}
 */
const WEBGPU_SPEC_FLOOR_MAX_STORAGE_BUFFER_BINDING_SIZE = 134217728;

/**
 * Derive a usable storage-buffer ceiling from device limits.
 *
 * Mirrors the `SKIN_PALETTE_MAX_BINDING_BYTES` 0/undefined floor pattern
 * (createRenderer.ts:4070-4073): when `maxStorageBufferBindingSize` is 0 or
 * undefined (WebKit `downlevel_webgl2_defaults`), climb the fallback chain —
 * `maxBufferSize` → `maxUniformBufferBindingSize` → WebGPU spec floor
 * 134217728 (128 MiB).
 *
 * Pure helper — no device dependency, directly testable in node.
 */
export function deriveStorageBufferCeiling(
  limits: Readonly<{
    maxStorageBufferBindingSize?: number;
    maxBufferSize?: number;
    maxUniformBufferBindingSize?: number;
  }>,
): number {
  // Preferred: the device-reported storage-buffer binding size (when > 0).
  if (
    typeof limits.maxStorageBufferBindingSize === 'number' &&
    limits.maxStorageBufferBindingSize > 0
  ) {
    return limits.maxStorageBufferBindingSize;
  }
  // Fallback 1: maxBufferSize (device-level buffer allocation limit).
  if (typeof limits.maxBufferSize === 'number' && limits.maxBufferSize > 0) {
    return limits.maxBufferSize;
  }
  // Fallback 2: maxUniformBufferBindingSize (uniform binding limit, lower
  // but still a real device capacity signal).
  if (
    typeof limits.maxUniformBufferBindingSize === 'number' &&
    limits.maxUniformBufferBindingSize > 0
  ) {
    return limits.maxUniformBufferBindingSize;
  }
  // Fallback 3: WebGPU spec floor — always non-zero, safe as last resort.
  return WEBGPU_SPEC_FLOOR_MAX_STORAGE_BUFFER_BINDING_SIZE;
}

/**
 * Mesh + material buffer wrapper carrying the inner `Buffer` handle plus
 * the byte-size at the time of allocation. The wrapper-object identity is
 * stable across grow events — only `.buffer` and `.sizeInBytes` are mutated
 * in place — so `PipelineState.meshStorageBuffer` / `materialUniformBuffer`
 * fields capture the wrapper once and survive grow events without a re-bind
 * cycle through the public Renderer surface (research §F8 R1).
 */
export interface MeshSsboBufferWrapper {
  buffer: Buffer;
  sizeInBytes: number;
}

/** Closure-local grow state surfaced for spy assertions in unit tests. */
export interface MeshSsboState {
  slotCount: number;
  mesh: MeshSsboBufferWrapper;
  material: MeshSsboBufferWrapper;
}

/** `growMeshSsbo` return shape (D-5: Result-like, never throws). */
export type MeshSsboGrowResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
      /** Pre-grow slotCount — the caller can render up to this many slots (degraded subset). */
      readonly degradedToSlotCount: number;
    };

/** Minimal device surface the grow controller needs (mocked in unit tests). */
export interface MeshSsboGrowDevice {
  readonly limits: { readonly maxStorageBufferBindingSize: number };
  readonly createBuffer: (descriptor: {
    readonly label?: string;
    readonly size: number;
    readonly usage: number;
    readonly mappedAtCreation?: boolean;
  }) => Buffer;
}

/** Minimal error-registry surface (just `fire` — `RhiErrorListenerRegistry` matches). */
export interface MeshSsboGrowErrorRegistry {
  fire: (e: MeshSsboCeilingReachedError | MeshSsboCapacityExceededError) => void;
}

export interface MeshSsboGrowControllerInit {
  readonly device: MeshSsboGrowDevice;
  readonly errorRegistry: MeshSsboGrowErrorRegistry;
  readonly initialSlotCount: number;
  readonly perEntityStride: number;
  readonly meshUsage: number;
  readonly materialUsage: number;
}

export interface MeshSsboGrowController {
  readonly state: MeshSsboState;
  /** Allocate the initial mesh + material buffer pair at `initialSlotCount`. */
  readonly initialBuild: () => void;
  /** Grow to satisfy `neededSlots`; idempotent + ceiling-aware. */
  readonly growMeshSsbo: (neededSlots: number) => MeshSsboGrowResult;
}

/**
 * Build a closure-scoped mesh-SSBO grow controller. Module-scope so unit
 * tests (`__tests__/mesh-ssbo-grow.test.ts`) can construct it with a fake
 * device + spy errorRegistry without spinning up the full WebGPU renderer
 * (charter F2 minimal surface — the controller is the testable seam).
 */
export function createMeshSsboGrowController(
  init: MeshSsboGrowControllerInit,
): MeshSsboGrowController {
  const { device, errorRegistry, initialSlotCount, perEntityStride, meshUsage, materialUsage } =
    init;
  // Wrapper-object identity is set once and shared with PipelineState.
  // Inner buffer + sizeInBytes are mutated in place during grow.
  const meshWrapper: MeshSsboBufferWrapper = {
    buffer: undefined as unknown as Buffer,
    sizeInBytes: 0,
  };
  const materialWrapper: MeshSsboBufferWrapper = {
    buffer: undefined as unknown as Buffer,
    sizeInBytes: 0,
  };
  const state: MeshSsboState = {
    slotCount: 0,
    mesh: meshWrapper,
    material: materialWrapper,
  };
  let initialised = false;

  const allocBufferPair = (slots: number): void => {
    const sizeInBytes = slots * perEntityStride;
    const meshBuf = device.createBuffer({
      label: 'pbr-mesh-ssbo',
      size: sizeInBytes,
      usage: meshUsage,
      mappedAtCreation: false,
    });
    const materialBuf = device.createBuffer({
      label: 'pbr-material-ubo',
      size: sizeInBytes,
      usage: materialUsage,
      mappedAtCreation: false,
    });
    meshWrapper.buffer = meshBuf;
    meshWrapper.sizeInBytes = sizeInBytes;
    materialWrapper.buffer = materialBuf;
    materialWrapper.sizeInBytes = sizeInBytes;
    state.slotCount = slots;
  };

  const initialBuild = (): void => {
    if (initialised) return;
    initialised = true;
    allocBufferPair(initialSlotCount);
  };

  const growMeshSsbo = (neededSlots: number): MeshSsboGrowResult => {
    // (1) idempotent guard — already large enough.
    if (state.slotCount >= neededSlots) {
      return { ok: true };
    }
    // (2) pow2 double until >= needed.
    let target = state.slotCount > 0 ? state.slotCount : 1;
    while (target < neededSlots) target = target * 2;
    // Round up to nextPow2 of needed in case slotCount is 0 / not pow2.
    target = Math.max(target, nextPow2(neededSlots));
    const ceilingBytes = deriveStorageBufferCeiling(device.limits);
    const targetBytes = target * perEntityStride;
    // (3) ceiling check — refuse + fire structured error.
    if (targetBytes > ceilingBytes) {
      errorRegistry.fire(
        new MeshSsboCeilingReachedError(neededSlots, state.slotCount, ceilingBytes),
      );
      return {
        ok: false,
        code: 'mesh-ssbo-ceiling-reached',
        degradedToSlotCount: state.slotCount,
      };
    }
    // (4) + (5) allocate fresh buffers + replace inner refs.
    allocBufferPair(target);
    // (6) defensive belt-and-suspenders.
    if (state.slotCount < neededSlots) {
      errorRegistry.fire(
        new MeshSsboCapacityExceededError(neededSlots, state.slotCount, ceilingBytes),
      );
      return {
        ok: false,
        code: 'mesh-ssbo-capacity-exceeded',
        degradedToSlotCount: state.slotCount,
      };
    }
    return { ok: true };
  };

  return { state, initialBuild, growMeshSsbo };
}

// feat-20260613 fix-issue-1 (D-8 channelMap split, AC-07 std140 layout):
// per-entity material slice carries the post-split sidecar paramSchema for
// default-standard-pbr (10 numeric entries packed std140 across 80 B):
//   baseColor          : vec4<f32>     16 B  (offset 0)
//   metallic + roughness + 4 channel selectors  4*f32 numeric run (offset 16..40)
//   (implicit pad to 48 -- vec3 align=16)
//   emissive           : vec3<f32>     12 B  (offset 48)
//   emissiveIntensity  : f32           +4 B (offset 60)
//   occlusionStrength  : f32           +4 B (offset 64)
//                                      = 80 B  (alignUp 16)
// The dynamic-offset stride of `PER_ENTITY_STRIDE = 256` is unchanged
// (D-P9 256-byte minimum dynamic-offset alignment); only the BindGroup
// entry's `size` matches the new 80 B struct. The trailing 256 - 80 = 176 B
// per entity slot stays unread by the shader. SSOT lives in
// `./render-system.ts` so `render-system-record.ts` can import the same
// value without a createRenderer cycle (charter P5 consistent abstraction).

/**
 * Build the `Renderer.ready` Promise (D-S3 three-step strict-serial chain).
 *
 * Steps run in order; any rejection short-circuits the chain and the
 * resulting Promise rejects with a structured `RhiError` / `ShaderError`.
 * AI users `await renderer.ready` once before the first `draw(world)` call;
 * subsequent frames may skip the await (the Promise stays resolved).
 *
 * Step 1 (manifest load): `shader.loadManifest()` populates the runtime
 * registry. Failure = `ShaderError 'manifest-malformed'` /
 * `'shader-not-found'`.
 *
 * Step 2 (pipeline compile): synthesises the PBR pipeline (3 BindGroupLayout
 * + 1 PipelineLayout + 1 ShaderModule + 1 RenderPipeline). Failure =
 * `RhiError 'shader-compile-failed'` / `'feature-not-enabled'` /
 * `'limit-exceeded'`.
 *
 * Step 3 (asset upload): allocates GPU buffers for the builtin cube and
 * triangle meshes via `device.createBuffer` + `queue.writeBuffer`. Failure
 * = `RhiError 'limit-exceeded'` / `'webgpu-runtime-error'` /
 * `'queue-write-buffer-out-of-bounds'`.
 */
/**
 * bug-20260601-hello-tonemap-material-register M1: prepare engine-shipped
 * material shaders (cap gate + manifest load + registration) before the
 * renderer is returned so that `register<MaterialAsset>` referencing an
 * engine shader (e.g. `forgeax::default-standard-pbr`) succeeds without
 * waiting for `renderer.ready` (plan-strategy D-1/D-2/D-5).
 *
 * Failures (cap-gate insufficient, manifest-malformed, shader-not-found)
 * throw structured `RhiError` / `ShaderError` which propagate through
 * `createRenderer`'s synchronous reject path (D-2 structured reject).
 */
async function prepareMaterialShaders(
  rhiDevice: RhiDevice,
  getShader: () => ShaderRegistry,
  assets: AssetRegistry,
): Promise<void> {
  // feat-20260528-material-shader-registration-unification M3 / w15:
  // pre-computed UUIDv5 GUIDs for engine-shipped material shaders.
  // Derived from FORGEAX_NAMESPACE (9a09805a-7623-482e-b322-9fc3591f2a38)
  // with SHA-1 per RFC 4122 section 4.3.
  const pbrGuidRes = AssetGuid.parse('94d85ce4-650c-54b1-a86a-eaf22696ecbc');
  const unlitGuidRes = AssetGuid.parse('37f593ea-0c79-528c-b7f7-23d17045d776');
  const spriteGuidRes = AssetGuid.parse('658234f6-a605-5fff-957d-7149b48fd0f4');
  const pbrSkinGuidRes = AssetGuid.parse('5ad0833e-2f17-56e5-a3d2-dab543afae65');
  // feat-20260531-world-space-msdf-text-rendering M5 / w21: stable UUIDv5 for
  // the world-space MSDF text material shader (deriveBuiltin('forgeax::msdf-text')
  // under FORGEAX_NAMESPACE). Registered via the manifest materialShaders[]
  // loop below alongside sprite / unlit (D-7 -- materialShaderId path).
  const msdfTextGuidRes = AssetGuid.parse('b8f92146-3b24-519b-97a2-271419b53563');
  const shadowCasterGuidRes = AssetGuid.parse('2e167c2a-1747-5bd7-b56d-aea9bc3f436e');
  const pbrGuid = pbrGuidRes.ok
    ? pbrGuidRes.value
    : (new Uint8Array(16) as unknown as AssetGuidType);
  const unlitGuid = unlitGuidRes.ok
    ? unlitGuidRes.value
    : (new Uint8Array(16) as unknown as AssetGuidType);
  const spriteGuid = spriteGuidRes.ok
    ? spriteGuidRes.value
    : (new Uint8Array(16) as unknown as AssetGuidType);
  const pbrSkinGuid = pbrSkinGuidRes.ok
    ? pbrSkinGuidRes.value
    : (new Uint8Array(16) as unknown as AssetGuidType);
  const msdfTextGuid = msdfTextGuidRes.ok
    ? msdfTextGuidRes.value
    : (new Uint8Array(16) as unknown as AssetGuidType);
  const shadowCasterGuid = shadowCasterGuidRes.ok
    ? shadowCasterGuidRes.value
    : (new Uint8Array(16) as unknown as AssetGuidType);
  const ENGINE_SHADER_GUIDS = new Map<string, AssetGuidType>([
    ['forgeax::default-standard-pbr', pbrGuid],
    ['forgeax::default-unlit', unlitGuid],
    ['forgeax::sprite', spriteGuid],
    ['forgeax::default-standard-pbr-skin', pbrSkinGuid],
    ['forgeax::msdf-text', msdfTextGuid],
    ['forgeax::default-shadow-caster', shadowCasterGuid],
  ]);

  // ── Step 0: storage-buffer cap gate ───────────────────────────────────────
  const capValue = (rhiDevice.limits as Readonly<Record<string, number>>)
    .maxStorageBuffersPerShaderStage;
  let storageBufferCapable = true;
  if (typeof capValue === 'number') {
    const capCheck = assertStorageBufferCap(capValue);
    if (!capCheck.ok) throw capCheck.error;
    storageBufferCapable = capCheck.value;
  }

  // ── Step 1: manifest load ─────────────────────────────────────────────────
  const registry = getShader();
  const loaded = await registry.loadManifest();
  if (!loaded.ok) {
    throw loaded.error;
  }

  // ── Step 1b: material shader variant resolution + registration ───────────
  // feat-20260609-hdrp-cluster-fragment-ggx M1 / w7: dual-axis variant
  // resolution. At boot time isHdrpActive is always false (URP default),
  // so CLUSTER_FORWARD_AVAILABLE=false variant is selected. HDRP variant
  // (CLUSTER_FORWARD_AVAILABLE=true) is resolved later when
  // installPipeline(hdrpAsset) activates HDRP.
  const isHdrpActive = false; // M4: wire to actual renderSystem.frameState.isHdrpActive
  for (const msEntry of registry.materialShaderManifestEntries()) {
    // bug-20260610: skip synthetic non-material engine entries piggy-backing
    // on the materialShaders channel for variant surfacing (shadow_caster).
    // They use the `forgeax::engine-` prefix and are consumed by Step 2's
    // engine-entry compile path, NOT by registerMaterialShader.
    if (msEntry.identifier.startsWith('forgeax::engine-')) continue;
    // buildVariantKey logic: sorted key=value pairs joined with +; all-true = ''.
    const variantDefines: Record<string, boolean> = {
      STORAGE_BUFFER_AVAILABLE: storageBufferCapable,
    };
    // Only include CLUSTER_FORWARD_AVAILABLE when the material shader declares
    // the axis (has a variant with this key), preserving backward compat for
    // entries without the pragma.
    if (msEntry.variants.some((v) => 'CLUSTER_FORWARD_AVAILABLE' in v.defines)) {
      variantDefines.CLUSTER_FORWARD_AVAILABLE = isHdrpActive;
    }
    const sortedEntries = Object.entries(variantDefines).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const definesKey = sortedEntries.every(([, v]) => v === true)
      ? ''
      : sortedEntries.map(([k, v]) => `${k}=${v}`).join('+');
    const chosen = findVariantByKey(msEntry, definesKey);
    const wgsl = chosen?.composedWgsl ?? msEntry.composedWgsl;
    if (wgsl.length > 0) {
      const existing = registry.lookupMaterialShader(msEntry.identifier);
      if (existing.ok) continue;
      const paramSchema = JSON.parse(
        msEntry.paramSchema,
      ) as readonly import('@forgeax/engine-types').ParamSchemaEntry[];
      // feat-20260613-material-paramschema-driven-binding M3 / w12-w13:
      // paramSchema is the SSOT; the BGL is derived on demand via
      // `derive(paramSchema).bglEntries` and consumed by
      // buildPbrPipelineLayouts at pipeline-build time. The historical
      // separate bind-layout sidecar field has been deleted from
      // MaterialShaderEntry / ShaderAsset (D-1 / D-2).
      registry.registerMaterialShader(msEntry.identifier, {
        source: wgsl,
        paramSchema,
      });
      // Sanity check the schema parses through derive — a malformed sidecar
      // schema (e.g. unknown type literal) should fail loud at register time
      // (charter P3 explicit failure). The derived output is discarded; the
      // SSOT consumer is buildPbrPipelineLayouts later.
      derive(paramSchema);

      const shaderGuid = ENGINE_SHADER_GUIDS.get(msEntry.identifier);
      if (shaderGuid !== undefined) {
        const shaderAsset = {
          kind: 'shader' as const,
          name: msEntry.identifier,
          source: wgsl,
          paramSchema,
        };
        // feat-20260614 M8 (D-17): catalogue the shader asset by GUID so it is
        // GUID-addressable; no handle minted. A shader without an engine GUID
        // lives only in the ShaderRegistry (the registerMaterialShader SSOT
        // above) -- there is no GUID to catalogue it under.
        assets.catalog(shaderGuid, shaderAsset);
      }
    }
  }

  // ── Step 1c: register forgeax::default-shadow-caster from manifest entries ──
  // feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat M3 / T-007:
  // shadow_caster.wgsl is a vertex-only depth pass (29 lines). It enters the
  // manifest as a general entry (no .wgsl.meta.json sidecar) — not via the
  // materialShaders[] path. Detect it with the same marker as the legacy triage
  // (@location(0) position without @location(1) normal) and register it as the
  // 6th built-in material shader.
  const shadowCasterIdentifier = 'forgeax::default-shadow-caster';
  if (!registry.lookupMaterialShader(shadowCasterIdentifier).ok) {
    for (const entry of registry.entries()) {
      if (
        entry.wgsl.includes('@location(0) position') &&
        !entry.wgsl.includes('@location(1) normal')
      ) {
        // shadow_caster.wgsl is vertex-only (29 lines) with no bindings;
        // empty paramSchema. M3 / w12-w13 (D-2 / D-12): derive([]) returns
        // bglEntries=[], graceful empty-schema path; the separate
        // bind-layout sidecar field is gone — paramSchema is the SSOT.
        registry.registerMaterialShader(shadowCasterIdentifier, {
          source: entry.wgsl,
          paramSchema: [],
        });
        const shaderGuid = ENGINE_SHADER_GUIDS.get(shadowCasterIdentifier);
        if (shaderGuid !== undefined) {
          const shaderAsset = {
            kind: 'shader' as const,
            name: shadowCasterIdentifier,
            source: entry.wgsl,
            paramSchema: [] as readonly import('@forgeax/engine-types').ParamSchemaEntry[],
          };
          // feat-20260614 M8 (D-17): catalogue by GUID; no handle minted.
          assets.catalog(shaderGuid, shaderAsset);
        }
        break;
      }
    }
  }
}

async function buildReadyWebGPU(
  rhiDevice: RhiDevice,
  getShader: () => ShaderRegistry,
  gpuStore: GpuResourceStore,
  asyncCreateShaderModule:
    | ((
        device: RhiDevice,
        desc: { code: string; label?: string | undefined },
      ) => Promise<Result<ShaderModule, RhiError>>)
    | undefined,
  errorRegistry: RhiErrorListenerRegistry,
  // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 /
  // T-M2-05 + M3 / T-M3-04: surface for setting `internals.growMeshSsbo`
  // + `internals.meshSsboState` so the record stage's
  // `ensureMeshSsboCapacity` hook can reach both. The mesh-SSBO grow
  // controller is owned in this function's scope, so the cleanest expose
  // path is a callback that buildReadyWebGPU invokes once after
  // `meshSsboController` is wired (the alternative — returning the
  // function + state alongside the PipelineState — bloats every
  // successful call site for two optional hooks).
  setGrowMeshSsboHook: (
    hook: (neededSlots: number) => MeshSsboGrowResult,
    state: MeshSsboState,
  ) => void,
  // feat-20260609 R3-fixup: seed-shader-module hook the lazy
  // MaterialShader pipeline cache adapter exposes (see
  // makeShaderDeviceAdapter / ShaderDeviceAdapterInternal). Used to seed
  // the shadow_caster module under
  // `module-forgeax::default-shadow-caster` so the lazy PSO build hits
  // OK on frame 1 (no 1-frame warmup for the engine-shipped shadow
  // caster).
  seedShaderModule: (label: string, module: ShaderModule) => void,
  // M6 fix-up (feat-20260615-pipeline-spec-ssot): seed-pipeline hook the
  // outer `makeWebGPURenderer` exposes for `materialShaderPipelineCache`.
  // Invoked once per URP-variant SPEC_CONST entry after the boot-time
  // prewarm completes, so the URP record path's first-frame
  // `getMaterialShaderPipeline` lookup hits a live PSO instead of falling
  // into a 1-frame async-compile skip-draw window. Idempotent: caller
  // guards against re-seeding when a key already exists.
  seedMaterialShaderPipelineCache: (key: string, pso: RenderPipeline) => void,
  // feat-20260621 M-A3 (D-5): register the engine built-in tonemap onto the
  // unified post-process channel once the tonemap manifest entry's composed
  // WGSL is resolved. Invoked with the tonemap WGSL source string; the outer
  // `makeWebGPURenderer` closure forwards it to
  // `renderSystem.postProcess.register('forgeax::tonemap', { source, params })`.
  // Scope bridge mirrors `setGrowMeshSsboHook` / `seedShaderModule`: the
  // tonemap source resolves inside this async function (after the manifest-load
  // await), by which point the synchronous `renderSystem` const is defined.
  registerBuiltinTonemap: (source: string) => void,
): Promise<PipelineState> {
  // bug-20260610: WebGL2 fallback path — read storage-buffer capability up
  // front so both Step 2 (shader-module compile, where we patch engine
  // entries to the STORAGE_BUFFER_AVAILABLE=false variant) and Step 3
  // (buildPbrPipelineLayouts, which switches between read-only-storage
  // and uniform BGL entries) walk the same axis. Step 0 already ran in
  // `prepareMaterialShaders`; this is an idempotent re-read driven by
  // `device.limits.maxStorageBuffersPerShaderStage`, which is 0 on the
  // wgpu-wasm WebGL2 backend (downlevel_webgl2_defaults).
  const capValue = (rhiDevice.limits as Readonly<Record<string, number>>)
    .maxStorageBuffersPerShaderStage;
  let storageBufferCapable = true;
  if (typeof capValue === 'number') {
    const capCheck = assertStorageBufferCap(capValue);
    storageBufferCapable = capCheck.ok ? capCheck.value : true;
  }

  // bug-20260612: choose swap-chain storage / view formats by backend.
  // Channel 2 (native WebGPU) follows navigator.gpu.getPreferredCanvasFormat();
  // Channel 3 (wgpu-wasm GLES, storageBufferCapable=false) hard-codes
  // rgba8unorm. The pair flows into PipelineState.format /
  // .colorAttachmentFormat below and through it into every downstream
  // pipeline target, configure() call, and color-attachment format —
  // single SSOT, no scattered branches. See selectSwapChainFormat
  // (above the SWAP_CHAIN_*_FORMAT historical constants).
  const swapChainFormats = selectSwapChainFormat(storageBufferCapable);
  // The 'null' (headless RhiNull) backend has no UA preferred-canvas-format by
  // design; the rgba8unorm fallback is its intended steady state, not a
  // degraded one — firing 'rhi-not-available' there is territorially wrong
  // (the backend IS available) and only pollutes Renderer.onError in headless
  // CI. Skip the diagnostic for it; Channel 2/3 still report a missing
  // getPreferredCanvasFormat as before.
  if (swapChainFormats.fallbackReason !== undefined && rhiDevice.caps.backendKind !== 'null') {
    // Step ③ in selectSwapChainFormat fired — surface a structured
    // diagnostic through the RhiError channel so AI users subscribed via
    // Renderer.onError(cb) can detect "extremely-old UA / missing
    // navigator.gpu.getPreferredCanvasFormat" and react. The renderer
    // continues with the rgba8unorm fallback (charter §9 graceful
    // degradation; charter P3 explicit failure — no silent fallback).
    errorRegistry.fire(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'navigator.gpu.getPreferredCanvasFormat is callable on Channel 2',
        hint: 'browser is too old or WebGPU implementation incomplete; falling back to rgba8unorm swap-chain format. Update the UA or use a Channel-3-compatible canvas configuration.',
      }),
    );
  }

  // ── Step 2: PBR + unlit pipeline compile ───────────────────────────────────
  // bug-20260519 D-1 + D-3: gate the entire PBR / unlit shader-compile block
  // behind `manifestEntries.length > 0`. The Camera-only / clear-pass-only
  // path (LO 1.1 hello-window equivalent) ships an empty manifest -- no
  // PBR/unlit entry to find, no shader module to compile. When the gate is
  // skipped both `unlitModule` and `pbrModule` stay `null` and the later
  // unlit / standard `createRenderPipeline` calls are skipped in turn so
  // the returned `PipelineState.{unlitPipeline,standardPipeline}` fields
  // are written `null` (D-3 nullable). The render-time access point in
  // `render-system-record.ts` narrows on `=== null` and fires a structured
  // `RhiError shader-compile-failed` (charter P3 explicit failure;
  // AC-03). Other PipelineState fields (BindGroupLayout chain / shared
  // buffers / defaultSampler / fallbackTextureView / depthTexture* /
  // identityInstanceBuffer / mesh handles) keep their existing
  // construction so the clear-pass path remains fully wired (D-3
  // explicit scope).
  const registry = getShader();
  //
  // feat-20260518-pbr-direct-lighting-mvp M5 / w22.9 (AC-05 + plan-strategy
  // D-3 + D-4 + dual-pipeline contract w12): the manifest now ships the
  // pbr.wgsl + unlit.wgsl entries written by `@forgeax/engine-vite-plugin-shader`'s
  // `buildStart` hook (engine-entries eager compile via naga_oil). Identify
  // them by content marker (charter P3 explicit failure: silent fallback to
  // a wrong entry would produce mis-shaded pixels indistinguishable from
  // success). pbr.wgsl is the only entry whose composed body contains the
  // `f_schlick(` BRDF helper call; the other engine entry is unlit.
  // M3 D-P4: rhi-webgpu supplies the async factory; rhi-wgpu and the
  // explicit escape hatch fall back to the synchronous device entry.
  const manifestEntries: ManifestEntry[] = [];
  for (const entry of registry.entries()) {
    manifestEntries.push(entry);
  }
  let pbrModule: ShaderModule | null = null;
  let unlitModule: ShaderModule | null = null;
  let spriteModule: ShaderModule | null = null;
  let fxaaModule: ShaderModule | null = null;
  let skyboxModule: ShaderModule | null = null;
  let bloomBrightModule: ShaderModule | null = null;
  let bloomBlurModule: ShaderModule | null = null;
  let bloomCompositeModule: ShaderModule | null = null;
  let ssaoModule: ShaderModule | null = null;
  if (manifestEntries.length > 0) {
    // Merge of bug-20260519 D-1 + D-3 (manifest-zero gate, this branch's
    // outer `if (manifestEntries.length > 0)`) + main feat-20260519-tonemap
    // T-M2.5 (engine SSOT triple — pbr + unlit + tonemap) +
    // feat-20260520-directional-light-shadow-mapping M1c / w9 (shadow_caster
    // as additional engine entry) + feat-20260520-2d-sprite-layer-mvp M-3 / w24
    // (sprite as additional engine entry) + feat-20260520-skylight-ibl-cubemap
    // M5-amend Gap A (4 IBL precompute entries).
    //
    // Manifest non-empty: require pbr + unlit + tonemap; shadow_caster +
    // sprite + IBL entries are optional — absent ones leave their module
    // null and the dependent pipeline stays null (callers fail-fast at
    // dispatch if they relied on a missing entry).
    //
    // Marker triage (charter P3 explicit failure):
    //   - tonemap.wgsl: declares `struct TonemapParams`
    //   - sprite.wgsl: declares `pivotAndSize` Material field
    //   - pbr.wgsl: composes `f_schlick`
    //   - shadow_caster.wgsl: only position input (no normal/uv/tangent)
    //   - IBL entries: identified by their fragment entry-point markers
    //     (equirectToCube_fs / irradianceConvolve_fs / prefilterEnv_fs /
    //     brdfLutBake_fs) which survive naga_oil composition unchanged.
    //   - unlit.wgsl: none of the above markers → falls into the unlit slot.
    let pbrEntry: ManifestEntry | undefined;
    let unlitEntry: ManifestEntry | undefined;
    let tonemapEntry: ManifestEntry | undefined;
    let spriteEntry: ManifestEntry | undefined;
    let iblEquirectEntry: ManifestEntry | undefined;
    let iblIrradianceEntry: ManifestEntry | undefined;
    let iblPrefilterEntry: ManifestEntry | undefined;
    let iblBrdfLutEntry: ManifestEntry | undefined;
    let fxaaEntry: ManifestEntry | undefined;
    let skyboxEntry: ManifestEntry | undefined;
    let bloomBrightEntry: ManifestEntry | undefined;
    let bloomBlurEntry: ManifestEntry | undefined;
    let bloomCompositeEntry: ManifestEntry | undefined;
    let ssaoEntry: ManifestEntry | undefined;
    // feat-20260609 R3-fixup: shadow_caster module pre-bake. T-009 deleted
    // the hardcoded shadowCasterPipeline; the lazy
    // getMaterialShaderPipeline path (passKind='shadow-caster') uses
    // the shared adapter cache, which is unwarmed for shadow_caster on
    // frame 1. We eagerly compile + seed the adapter cache so the lazy
    // build hit on `module-forgeax::default-shadow-caster` returns OK
    // without a 1-frame warmup. Identified by the same heuristic Step 1c
    // uses (vertex-only marker: `@location(0) position` without
    // `@location(1) normal`).
    let shadowCasterEntry: ManifestEntry | undefined;
    for (const entry of manifestEntries) {
      if (entry.wgsl.includes('TonemapParams')) {
        tonemapEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('pivotAndSize')) {
        spriteEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('equirectToCube_fs')) {
        iblEquirectEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('irradianceConvolve_fs')) {
        iblIrradianceEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('prefilterEnv_fs')) {
        iblPrefilterEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('brdfLutBake_fs')) {
        iblBrdfLutEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('f_schlick')) {
        pbrEntry ??= entry;
        continue;
      }
      // feat-20260528-fxaa-post-processing: fxaa marker — the composed
      // WGSL contains the rgb2luma helper unique to the FXAA algorithm
      // (plan-strategy D-5). Identified before shadow_caster / unlit
      // fallback so the marker takes priority over generic position-only
      // heuristics.
      if (entry.wgsl.includes('rgb2luma')) {
        fxaaEntry ??= entry;
        continue;
      }
      // feat-20260531-skybox-env-background M3 / w15: skybox marker --
      // the composed WGSL contains the skybox_fs fragment entry point
      // unique to skybox.wgsl (plan-strategy D-7).
      if (entry.wgsl.includes('skybox_fs')) {
        skyboxEntry ??= entry;
        continue;
      }
      // feat-20260531-bloom-first-declarative-render-graph-pass / w13:
      // bloom marker triage (D-7). The 3 WGSL modules embed unique content
      // markers: 'bloomBrightExtract' (bloom-bright.wgsl), 'bloomBlurDir'
      // (bloom-blur.wgsl, shared by H/V pipelines), 'bloomComposite'
      // (bloom-composite.wgsl). Blur H/V share the same module (D-1).
      if (entry.wgsl.includes('bloomBrightExtract')) {
        bloomBrightEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('bloomBlurDir')) {
        bloomBlurEntry ??= entry;
        continue;
      }
      if (entry.wgsl.includes('bloomComposite')) {
        bloomCompositeEntry ??= entry;
        continue;
      }
      // feat-20260612-hdrp-ssao M6 / w27: SSAO marker triage (D-E).
      // The composed WGSL contains 'fs_ssao_calc' fragment entry point
      // which survives naga_oil composition unchanged. Same pattern as
      // bloomBrightExtract marker.
      if (entry.wgsl.includes('fs_ssao_calc')) {
        ssaoEntry ??= entry;
        continue;
      }
      // feat-20260609 R3-fixup: shadow_caster.wgsl marker — vertex-only
      // depth pass, identified by `@location(0) position` without
      // `@location(1) normal` (matches Step 1c heuristic in
      // prepareMaterialShaders). Caught before the unlit fallback so the
      // module gets eagerly baked and seeded into the adapter cache.
      if (
        entry.wgsl.includes('@location(0) position') &&
        !entry.wgsl.includes('@location(1) normal')
      ) {
        shadowCasterEntry ??= entry;
        continue;
      }
      unlitEntry ??= entry;
    }
    if (pbrEntry === undefined || unlitEntry === undefined || tonemapEntry === undefined) {
      throw new RhiError({
        code: 'shader-compile-failed',
        expected:
          'manifest entries include pbr.wgsl + unlit.wgsl + tonemap.wgsl (engine SSOT triple)',
        hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with the 3 engine entries; check vite plugin engineEntries option',
      });
    }
    // bug-20260610: WebGL2 fallback path — when storageBufferCapable=false
    // the variant-aware Step 1b registers material shaders with the
    // STORAGE_BUFFER_AVAILABLE=false WGSL (uniform fallback for meshes /
    // pointLights / instances), but Step 2 above triaged pbr/unlit/sprite/
    // pbr-skin/msdf-text from the FLAT `registry.entries()` map which only
    // contains the default (storage) variant. Compiling those with
    // STORAGE_BUFFER_AVAILABLE=true while the pipeline layout is built
    // for uniform-fallback (line 3014 `buildPbrPipelineLayouts({ storageBuffer: false })`)
    // produces a wgpu-core validation error: "Shader global ResourceBinding
    // { group: 2, binding: 0 } is not available in the pipeline layout —
    // Storage class Uniform doesn't match the shader Storage" — caught
    // when running under wgpu-wasm WebGL2 where storage buffers are absent.
    //
    // Fix: build an identifier→variant-WGSL map from
    // `registry.materialShaderManifestEntries()` (which findVariantByKey
    // resolved earlier), then patch each engine entry's `.wgsl` field with
    // the variant-correct source so the subsequent createShaderModule calls
    // match the layout. Identifiers come from the engine SSOT triple; if a
    // material-shader entry is absent (older manifest schema) the patch is
    // a no-op and the original entry.wgsl flows through unchanged.
    if (!storageBufferCapable) {
      // bug-20260612: variant selection must be field-wise, not by hardcoded
      // key. Single-axis shaders (unlit/sprite/pbr-skin/msdf-text/shadow-caster)
      // expose `STORAGE_BUFFER_AVAILABLE=false` directly. Multi-axis PBR (added
      // CLUSTER_FORWARD_AVAILABLE in PR #344) only emits compound keys like
      // `CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false`, so
      // findVariantByKey('STORAGE_BUFFER_AVAILABLE=false') silently misses.
      // The fallback path forces isHdrpActive=false (Step 1b above), so the
      // matching PBR variant is the (CFA=false, SBA=false) one — pick by
      // defines fields and prefer CLUSTER_FORWARD_AVAILABLE=false when present;
      // otherwise any STORAGE_BUFFER_AVAILABLE=false variant.
      const idToVariantWgsl = new Map<string, string>();
      for (const ms of registry.materialShaderManifestEntries()) {
        const exact = ms.variants.find(
          (v) =>
            v.defines.STORAGE_BUFFER_AVAILABLE === false &&
            (!('CLUSTER_FORWARD_AVAILABLE' in v.defines) ||
              v.defines.CLUSTER_FORWARD_AVAILABLE === false),
        );
        const v =
          exact ?? ms.variants.find((cand) => cand.defines.STORAGE_BUFFER_AVAILABLE === false);
        if (v !== undefined) {
          idToVariantWgsl.set(ms.identifier, v.composedWgsl);
        }
      }
      const patch = (entry: ManifestEntry, identifier: string): ManifestEntry => {
        const wgsl = idToVariantWgsl.get(identifier);
        return wgsl !== undefined ? { ...entry, wgsl } : entry;
      };
      pbrEntry = patch(pbrEntry, 'forgeax::default-standard-pbr');
      unlitEntry = patch(unlitEntry, 'forgeax::default-unlit');
      if (shadowCasterEntry !== undefined) {
        // feat-20260609 T-018 fixup: shadow_caster.wgsl is now a material
        // shader (vertex-only depth-only PSO) with reservedIdentifier
        // `forgeax::default-shadow-caster`; bug-20260610 picks the
        // STORAGE_BUFFER_AVAILABLE=false variant on the WebGL2 fallback
        // path so the uniform-array body compiles against the URP layout.
        shadowCasterEntry = patch(shadowCasterEntry, 'forgeax::default-shadow-caster');
      }
      if (spriteEntry !== undefined) {
        spriteEntry = patch(spriteEntry, 'forgeax::sprite');
      }
    }
    // Wire composed IBL shaders into IblPipelineCache before the cache's
    // createIblPipelines runs (called downstream by
    // AssetRegistry.uploadCubemapFromEquirect during the first Skylight
    // dispatch). When all 4 are present, register them; otherwise leave
    // the cache untouched (charter F1: tests / non-IBL hosts that ship
    // empty / 3-entry manifests still boot, and the IBL pipeline cache's
    // own error surfacing covers the "missing" case downstream).
    if (
      iblEquirectEntry !== undefined &&
      iblIrradianceEntry !== undefined &&
      iblPrefilterEntry !== undefined &&
      iblBrdfLutEntry !== undefined
    ) {
      setIblComposedShaders({
        equirectToCube: iblEquirectEntry.wgsl,
        irradiance: iblIrradianceEntry.wgsl,
        prefilter: iblPrefilterEntry.wgsl,
        brdfLut: iblBrdfLutEntry.wgsl,
      });
    }
    const pbrShaderResult = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, { code: pbrEntry.wgsl, label: 'pbr' })
          : invokeDeviceCreateShaderModule(rhiDevice, { code: pbrEntry.wgsl, label: 'pbr' }),
      'shader-compile-failed',
      'PBR shader module compiled',
      'inspect manifest pbr entry composed wgsl; check device.features',
    );
    if (!pbrShaderResult.ok) throw pbrShaderResult.error;
    pbrModule = pbrShaderResult.value;

    const unlitShaderResult = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, { code: unlitEntry.wgsl, label: 'unlit' })
          : invokeDeviceCreateShaderModule(rhiDevice, { code: unlitEntry.wgsl, label: 'unlit' }),
      'shader-compile-failed',
      'unlit shader module compiled',
      'inspect manifest unlit entry composed wgsl; check device.features',
    );
    if (!unlitShaderResult.ok) throw unlitShaderResult.error;
    unlitModule = unlitShaderResult.value;

    // feat-20260609 R3-fixup: eagerly compile shadow_caster module + seed
    // the lazy MaterialShader pipeline cache adapter so the first frame's
    // shadow PSO build (passKind='shadow-caster') hits OK without a
    // 1-frame warmup. T-009 deleted the hardcoded shadowCasterPipeline;
    // the lazy path replaces it but the adapter cache key
    // ('module-forgeax::default-shadow-caster') was previously unwarmed,
    // causing the first frame's createShaderModule to return
    // 'rhi-not-available' and the shadow PSO build to fail (which left
    // the shadow depth attachment unwritten). Optional: when the manifest
    // omits shadow_caster (legacy hosts), the lazy path simply falls
    // through to the existing 1-frame retry; no regression.
    if (shadowCasterEntry !== undefined) {
      const shadowCasterShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: shadowCasterEntry.wgsl,
                label: 'shadow_caster',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: shadowCasterEntry.wgsl,
                label: 'shadow_caster',
              }),
        'shader-compile-failed',
        'shadow_caster shader module compiled',
        'inspect manifest shadow_caster entry composed wgsl; check device.features',
      );
      if (!shadowCasterShaderResult.ok) throw shadowCasterShaderResult.error;
      // Seed the adapter cache under the same label
      // (`module-${materialShaderId}`) that getMaterialShaderPipeline
      // uses so the lazy build's createShaderModule call hits OK on
      // frame 1.
      seedShaderModule('module-forgeax::default-shadow-caster', shadowCasterShaderResult.value);
    }

    // feat-20260621 M-A3 (D-5): register the built-in tonemap onto the unified
    // post-process channel instead of building a dedicated pipeline. The composed
    // tonemap WGSL (`tonemapEntry.wgsl`, @group(1) bindings after w16) becomes the
    // registered `entry.source`; `postProcess.register` eager-creates the 16 B
    // params UBO (fail-fast). The empty-manifest path never reaches here (the
    // manifest triple guard above throws when tonemapEntry is undefined), so
    // registration is unconditional within this gate.
    //
    // Eager pre-warm (zero-regression): the dedicated tonemap pipeline used to be
    // built during `ready`, so tonemap rendered correctly on frame 1 with NO
    // event-loop yield. The unified `getPostProcessPipeline` lazy path otherwise
    // returns `rhi-not-available` until the async shader-compile promise resolves
    // -- a consumer driving `draw()` in a tight loop without an `await` between
    // frames (e.g. the hello-tonemap dawn smoke) would stall on a black frame
    // forever. Mirror the shadow_caster prewarm: await-compile the tonemap module
    // here and `seedShaderModule` it under the exact label
    // `buildPostProcessPipeline` requests (`post-process-${id}-module`), so the
    // first `getPostProcessPipeline('forgeax::tonemap', …)` hits the module cache
    // synchronously and builds the pipeline on frame 1.
    const tonemapPrewarm = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, {
              code: tonemapEntry.wgsl,
              label: `post-process-${TONEMAP_POST_PROCESS_ID}-module`,
            })
          : invokeDeviceCreateShaderModule(rhiDevice, {
              code: tonemapEntry.wgsl,
              label: `post-process-${TONEMAP_POST_PROCESS_ID}-module`,
            }),
      'shader-compile-failed',
      'tonemap shader module compiled (unified post-process prewarm)',
      'inspect manifest tonemap entry composed wgsl; check device.features',
    );
    if (!tonemapPrewarm.ok) throw tonemapPrewarm.error;
    seedShaderModule(`post-process-${TONEMAP_POST_PROCESS_ID}-module`, tonemapPrewarm.value);
    registerBuiltinTonemap(tonemapEntry.wgsl);

    // feat-20260520-2d-sprite-layer-mvp M-3 / w24: sprite shader module
    // is optional in the 3-tuple legacy manifest (back-compat for apps
    // that locked their manifest URL before this feat). With the
    // vite-plugin-shader 4-entry surface (M-3 / w20), spriteEntry is
    // present and we build both LDR + HDR sprite pipeline variants.
    if (spriteEntry !== undefined) {
      const spriteShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: spriteEntry.wgsl, label: 'sprite' })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: spriteEntry.wgsl,
                label: 'sprite',
              }),
        'shader-compile-failed',
        'sprite shader module compiled',
        'inspect manifest sprite entry composed wgsl; check device.features',
      );
      if (!spriteShaderResult.ok) throw spriteShaderResult.error;
      spriteModule = spriteShaderResult.value;
    }

    // feat-20260528-fxaa-post-processing: fxaa shader module is optional
    // (apps with legacy manifests without fxaa.wgsl continue to boot).
    // Identified by rgb2luma content marker (plan-strategy D-5). When
    // present, the module is compiled here; pipeline construction happens
    // alongside the tonemap pipeline below (step 2 prebuild).
    if (fxaaEntry !== undefined) {
      const fxaaShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: fxaaEntry.wgsl, label: 'fxaa' })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: fxaaEntry.wgsl,
                label: 'fxaa',
              }),
        'shader-compile-failed',
        'fxaa shader module compiled',
        'inspect manifest fxaa entry composed wgsl; check device.features',
      );
      if (!fxaaShaderResult.ok) throw fxaaShaderResult.error;
      fxaaModule = fxaaShaderResult.value;
    }

    // feat-20260531-skybox-env-background M3 / w15: skybox shader module.
    // Optional (apps with legacy manifests without skybox.wgsl continue to
    // boot). Identified by skybox_fs content marker (plan-strategy D-7).
    // Compiled here; pipeline construction happens alongside tonemap/fxaa
    // in step 2 prebuild below.
    if (skyboxEntry !== undefined) {
      const skyboxShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, { code: skyboxEntry.wgsl, label: 'skybox' })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: skyboxEntry.wgsl,
                label: 'skybox',
              }),
        'shader-compile-failed',
        'skybox shader module compiled',
        'inspect manifest skybox entry composed wgsl; check device.features',
      );
      if (!skyboxShaderResult.ok) throw skyboxShaderResult.error;
      skyboxModule = skyboxShaderResult.value;
    }

    // feat-20260531-bloom-first-declarative-render-graph-pass / w13:
    // bloom shader modules are optional (apps with legacy manifests without
    // bloom.wgsl continue to boot). Identified by the D-7 content markers
    // 'bloomBrightExtract' / 'bloomBlurDir' / 'bloomComposite'. When
    // present, each module is compiled here; pipeline construction happens
    // alongside the FXAA / tonemap pipelines below.
    if (bloomBrightEntry !== undefined) {
      const brightShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: bloomBrightEntry.wgsl,
                label: 'bloom-bright',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: bloomBrightEntry.wgsl,
                label: 'bloom-bright',
              }),
        'shader-compile-failed',
        'bloom-bright shader module compiled',
        'inspect manifest bloom-bright entry composed wgsl; check device.features',
      );
      if (!brightShaderResult.ok) throw brightShaderResult.error;
      bloomBrightModule = brightShaderResult.value;
    }
    if (bloomBlurEntry !== undefined) {
      const blurShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: bloomBlurEntry.wgsl,
                label: 'bloom-blur',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: bloomBlurEntry.wgsl,
                label: 'bloom-blur',
              }),
        'shader-compile-failed',
        'bloom-blur shader module compiled',
        'inspect manifest bloom-blur entry composed wgsl; check device.features',
      );
      if (!blurShaderResult.ok) throw blurShaderResult.error;
      bloomBlurModule = blurShaderResult.value;
    }
    if (bloomCompositeEntry !== undefined) {
      const compositeShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: bloomCompositeEntry.wgsl,
                label: 'bloom-composite',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: bloomCompositeEntry.wgsl,
                label: 'bloom-composite',
              }),
        'shader-compile-failed',
        'bloom-composite shader module compiled',
        'inspect manifest bloom-composite entry composed wgsl; check device.features',
      );
      if (!compositeShaderResult.ok) throw compositeShaderResult.error;
      bloomCompositeModule = compositeShaderResult.value;
    }
    // feat-20260612-hdrp-ssao M6 / w27: SSAO shader module compilation.
    // Optional manifest entry — absent on legacy manifests (zero-overhead
    // opt-out, same as bloom). Identified by 'fs_ssao_calc' content marker.
    if (ssaoEntry !== undefined) {
      const entry = ssaoEntry;
      const ssaoShaderResult = await runShimStep(
        () =>
          asyncCreateShaderModule
            ? asyncCreateShaderModule(rhiDevice, {
                code: entry.wgsl,
                label: 'hdrp-ssao',
              })
            : invokeDeviceCreateShaderModule(rhiDevice, {
                code: entry.wgsl,
                label: 'hdrp-ssao',
              }),
        'shader-compile-failed',
        'hdrp-ssao shader module compiled',
        'inspect manifest hdrp-ssao entry composed wgsl; check device.features',
      );
      if (!ssaoShaderResult.ok) throw ssaoShaderResult.error;
      ssaoModule = ssaoShaderResult.value;
    }
  }

  // feat-20260520-skylight-ibl-cubemap M4 round-4 / t59: the PBR pipeline
  // layout construction migrated to `pbr-pipeline.ts buildPbrPipelineLayouts`.
  // The factory builds 4 BindGroupLayouts (view + material + mesh-array +
  // instances) and the 4-slot pipeline layout in one call, throwing on any
  // device.createBindGroupLayout / device.createPipelineLayout failure.
  // material BGL now carries 14 entries (material 0..6 + Skylight 7..13 via
  // mergeSkylightIntoMaterialBgl) -- pipeline layout itself stays at 4 slots,
  // no @group(4) allocated (D-5 round-4 fix for the round-2 maxBindGroups=4
  // BLOCKER). The unlit pipeline currently shares this 14-entry layout
  // (carrying fallback identity at binding 7..13 from the record stage);
  // future split via `buildUnlitMaterialBgl` is exposed for tests.
  //
  // feat-20260520-directional-light-shadow-mapping merge: view BGL entries
  // include binding(3) shadowMap + binding(4) comparison sampler (extended
  // in `buildPbrViewBglEntries`); the shadow caster pipeline + shadow RT
  // remain owned by createRenderer below, but the layout is shared.
  // bug-20260610: storageBufferCapable is hoisted to the top of
  // buildReadyWebGPU (above) so Step 2 (variant patch) and this layout
  // build read the same value.
  const pbrLayouts = runShimSyncStep(
    // biome-ignore lint/suspicious/noExplicitAny: rhiDevice BGL desc 'entries' is mutable per @webgpu/types; PbrPipelineDevice narrows on readonly
    () => ok(buildPbrPipelineLayouts(rhiDevice as any, { storageBuffer: storageBufferCapable })),
    'webgpu-runtime-error',
    'buildPbrPipelineLayouts succeeded',
    'check device.limits.maxBindingsPerBindGroup (need >=14) and maxBindGroupsPerPipelineLayout',
  );
  if (!pbrLayouts.ok) throw pbrLayouts.error;
  const viewBglResult = ok(pbrLayouts.value.viewBgl);
  const materialBglResult = ok(pbrLayouts.value.materialBgl);
  const meshArrayBglResult = ok(pbrLayouts.value.meshArrayBgl);
  const instancesBglResult = ok(pbrLayouts.value.instancesBgl);
  const pipelineLayoutResult = ok(pbrLayouts.value.pipelineLayout);

  // feat-20260609-hdrp-cluster-fragment-ggx M4.5 / w36 (D-10 option A):
  // boot-time build of the HDRP-variant PipelineLayout. The 4-BGL chain is
  // [view, material, hdrp-unified-7-slot, instances]; the HDRP unified BGL
  // (createHdrpBindGroupLayoutDescriptor) replaces the 1-slot pbr-mesh-array
  // BGL at group(2) so an HDRP-variant PSO validates against the 7-slot
  // group(2) bindGroup that the record stage sets via hdrpClusterBindGroup.
  // Stays null when createBindGroupLayout / createPipelineLayout fails;
  // selectPipelineLayoutForVariant gracefully falls back to pbrPipelineLayout
  // (URP layout) so the manifest entry's URP variant WGSL still builds a
  // valid PSO instead of hard-disabling the entire HDRP-variant build path.
  let hdrpPbrPipelineLayoutHandle: PipelineLayout | null = null;
  {
    const hdrpUnifiedBglDesc = createHdrpBindGroupLayoutDescriptor(storageBufferCapable);
    // biome-ignore lint/suspicious/noExplicitAny: rhiDevice BGL desc 'entries' mutable per @webgpu/types
    const hdrpUnifiedBglRes = rhiDevice.createBindGroupLayout(hdrpUnifiedBglDesc as any);
    if (hdrpUnifiedBglRes.ok) {
      const hdrpPlRes = rhiDevice.createPipelineLayout({
        label: 'hdrp-pbr-pl',
        bindGroupLayouts: [
          viewBglResult.value,
          materialBglResult.value,
          hdrpUnifiedBglRes.value,
          instancesBglResult.value,
        ],
      });
      if (hdrpPlRes.ok) {
        hdrpPbrPipelineLayoutHandle = hdrpPlRes.value;
      }
    }
  }

  // bug-20260611-skin-pipeline-layout-mesh-array-bgl-2bindings: boot-time
  // build of the skin-variant PipelineLayout. Mirrors the HDRP block above
  // (D-2 / D-3 in plan-strategy): reuse view / material / instances BGLs
  // from `pbrLayouts` and only create a 2-entry mesh-array BGL (binding 0
  // meshes + binding 1 palette) so the `forgeax::pbr-skin` shader's
  // `@group(2) @binding(1) palette` declaration validates. Stays null when
  // createBindGroupLayout / createPipelineLayout fails;
  // selectPipelineLayoutForVariant returns null in that case (charter P3
  // explicit failure -- no silent fallback to URP layout, mirroring memory
  // anchor `hdrp-active-must-not-fallback-to-urp-pipeline`).
  let pbrSkinPipelineLayoutHandle: PipelineLayout | null = null;
  // feat-20260611 R2 / M8 / w28: capture the 2-binding skin mesh-array BGL
  // produced by `buildPbrSkinLayouts` so the record stage can build a BG
  // matching `pbr-skin-pl` (pipeline-layout BGL[2] is this 2-entry skin
  // BGL, NOT the 1-entry `pbr-mesh-array-bgl`). The BGL handle stays null
  // when the skin pipeline layout itself failed to build, keeping the skin
  // path explicitly disabled (charter P3 — record-stage falls back to URP
  // path which is correct for non-skin entries; skin entries hit the
  // explicit-failure branch).
  let pbrSkinMeshBindGroupLayoutHandle: BindGroupLayout | null = null;
  {
    const skinLayoutsResult = runShimSyncStep(
      () =>
        ok(
          buildPbrSkinLayouts(
            // biome-ignore lint/suspicious/noExplicitAny: PbrPipelineDevice shim aligns with rhiDevice interface
            rhiDevice as any,
            { storageBuffer: storageBufferCapable },
            pbrLayouts.value,
          ),
        ),
      'webgpu-runtime-error',
      'buildPbrSkinLayouts succeeded',
      'check device.limits.maxBindingsPerBindGroup (need >=14) and maxBindGroupsPerPipelineLayout',
    );
    if (skinLayoutsResult.ok) {
      pbrSkinPipelineLayoutHandle = skinLayoutsResult.value.pipelineLayout;
      pbrSkinMeshBindGroupLayoutHandle = skinLayoutsResult.value.meshArrayBgl;
    }
  }

  // feat-20260612-skin-palette-per-frame-upload M1 / m1-2: skin palette
  // allocator. Replaces the prior 16320 B identity-seeded UBO stub (PR #353,
  // feat-20260611 R2 / M8 / w28 IS-14, retired identity-buffer field) with
  // the animator-ready `SkinPaletteAllocator` from
  // `./systems/skin-palette-allocator`. Per
  // plan-strategy D-1 candidate (b) the allocator is the single
  // authoritative carrier of the palette GPU resource -- no parallel
  // identity-fallback buffer; the boot code only constructs the allocator
  // and the per-frame extract / record stages drive `allocateSlice` +
  // `writeJointPalette` (M2 / M3) to land animated palette data. The
  // allocator's `buffer` is `null` until the first `allocateSlice` call
  // grows it, and the record stage gates skin entries on `pbrSkinPipelineLayout`
  // + `skinPaletteAllocator.buffer !== null` (charter P3 explicit failure).
  //
  // M6 fix: the cap is the device's max BUFFER binding size for the
  // selected usage path -- NOT 16320 B (that's the static BG @binding(1)
  // ENTRY size, a per-draw window slid by dynamic offset; the underlying
  // buffer must span every entity's window so `dynOffset + entry.size <=
  // buffer.size` holds for the last skinned draw). Pre-M6 conflated the
  // two and rejected the 2nd skin entity with SkinPaletteOverflowError.
  //
  // Storage path -> `maxStorageBufferBindingSize`; uniform fallback ->
  // `maxUniformBufferBindingSize` (WebGPU spec floor 64 KiB; 16320 still
  // fits 4 entities back-to-back even on the floor).
  const skinPaletteLimitKey = storageBufferCapable
    ? 'maxStorageBufferBindingSize'
    : 'maxUniformBufferBindingSize';
  const skinPaletteDeviceLimit = (rhiDevice.limits as Readonly<Record<string, number>>)[
    skinPaletteLimitKey
  ];
  const SKIN_PALETTE_MAX_BINDING_BYTES =
    typeof skinPaletteDeviceLimit === 'number' && skinPaletteDeviceLimit > 0
      ? skinPaletteDeviceLimit
      : 65536; // WebGPU spec floor for maxUniformBufferBindingSize
  const skinPaletteAllocatorHandle: SkinPaletteAllocator = createSkinPaletteAllocator(
    rhiDevice,
    SKIN_PALETTE_MAX_BINDING_BYTES,
    storageBufferCapable,
  );

  // bug-20260519: the legacy `pbr-pipeline-unlit-builtin` (6F-stride + a
  // 24-byte zero-fill dummy VBO that hard-coded uv=(0,0)) is gone. BUILTIN
  // geometry now ships 12-floats per vertex (pos + normal + uv + tangent)
  // identical to procedural meshes, so a single (`unlit-procedural` /
  // `standard`) pipeline pair covers every renderable.

  // ── Step 3: AssetRegistry builtin mesh GPU upload ─────────────────────────
  // M5 / w22.7 (feat-20260518-pbr-direct-lighting-mvp): the hard-coded
  // `[HANDLE_CUBE, HANDLE_TRIANGLE]` loop has moved to AssetRegistry —
  // `configureGpuDevice` (already invoked above the buildReadyWebGPU call)
  // replays every registered MeshAsset (incl. BUILTIN_CUBE / HANDLE_TRIANGLE
  // seeded by the constructor). Step 3 here only seeds the legacy
  // `pipelineState.meshes` Map for backward compat with existing fixtures
  // (render-system-record-instances.browser.test.ts etc.); render-system-record
  // queries `gpuStore.getMeshGpuHandles` first and falls back to this Map only
  // for the builtins — which keeps user-mesh registrations flowing through the
  // store's pull path (`ensureResident`) without a createRenderer rebuild
  // (AGENTS.md "Demo failures route to engine fixes").
  const queue = rhiDevice.queue;
  const meshHandles = new Map<number, MeshGpuHandles>();
  // feat-20260520-2d-sprite-layer-mvp post-merge fix: HANDLE_QUAD joins the
  // builtin upload loop so sprite materials referencing the unit-quad
  // through MeshFilter.assetHandle resolve to GPU vertex/index buffers
  // (record stage's `gpuStore.getMeshGpuHandles(handle)` returns the
  // GPU pair instead of firing `asset-not-registered`). Builtins are seeded
  // here (createRenderer step-3 direct upload), not via the store pull path
  // (D-1), so the upload chain ends here. Same explicit-upload intent as the
  // pre-existing HANDLE_CUBE / HANDLE_TRIANGLE pair (charter P5 consistent
  // abstraction).
  // feat-20260527-sprite-nineslice M2 / w12: HANDLE_NINESLICE_QUAD joins
  // the explicit-upload list so the 16-vertex / 54-index 9-slice quad has
  // GPU-resident vertex / index buffers when render-system-record routes
  // sprite + non-zero-slices entities to it (D-2). Closes feat-20260527
  // round-1 issue #2 dangling-slot root cause: the prior implement only
  // added the skip-list entry without the upload, leaving a registered
  // handle whose `pipelineState.meshes.get(id)` returned undefined.
  for (const handle of [
    HANDLE_CUBE,
    HANDLE_TRIANGLE,
    HANDLE_QUAD,
    HANDLE_SPHERE,
    HANDLE_NINESLICE_QUAD,
  ]) {
    const id = handleSlot(handle);
    const gpu = gpuStore.getMeshGpuHandles(handle);
    if (gpu !== undefined) {
      meshHandles.set(id, gpu as MeshGpuHandles);
      continue;
    }
    // Fallback: AssetRegistry was constructed without a wired device
    // (e.g. test fixtures bypass `configureGpuDevice`); fall back to the
    // legacy direct-upload path so the BUILTIN seed retains GPU buffers
    // even on the unwired path.
    // M5 / w19: HANDLE_CUBE / HANDLE_TRIANGLE are now
    // `Handle<'MeshAsset','shared'>` (the unified SSOT brand from
    // `@forgeax/engine-types` per feat-20260517-handle-type-unify) which
    // matches AssetRegistry.get<MeshAsset>'s parameter type
    // `Handle<'MeshAsset', 'shared'>` directly — no cross-brand cast.
    // feat-20260614 M8 (D-15): the builtin seed handles are builtin-tier
    // (slot < BUILTIN_BASE); resolve their PODs directly from the process-
    // static BuiltinAssetRegistry (no World needed at boot).
    const asset = BuiltinAssetRegistry.resolve(handle);
    if (asset === null) continue;
    if (asset.kind !== 'mesh') continue;
    // Builtins always carry indices; the `?? 0` keeps typecheck happy now that
    // MeshAsset.indices is optional, and supports a vertex-only fallback mesh
    // if one is ever added here (indexBuffer: null path below).
    const meshIndices = asset.indices;
    const vertexBytes = asset.vertices.byteLength;
    const indexBytesUnpadded = meshIndices?.byteLength ?? 0;
    const indexBytes = ((indexBytesUnpadded + 3) >> 2) << 2; // round up to multiple of 4
    const vboLabel =
      handle === HANDLE_NINESLICE_QUAD
        ? 'nineslice-quad-vbo'
        : handle === HANDLE_SPHERE
          ? 'sphere-vbo'
          : handle === HANDLE_CUBE
            ? 'cube-vbo'
            : handle === HANDLE_QUAD
              ? 'quad-vbo'
              : 'triangle-vbo';
    const iboLabel =
      handle === HANDLE_NINESLICE_QUAD
        ? 'nineslice-quad-ibo'
        : handle === HANDLE_SPHERE
          ? 'sphere-ibo'
          : handle === HANDLE_CUBE
            ? 'cube-ibo'
            : handle === HANDLE_QUAD
              ? 'quad-ibo'
              : 'triangle-ibo';
    const vboResult = runShimSyncStep(
      () =>
        rhiDevice.createBuffer({
          label: vboLabel,
          size: vertexBytes,
          usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
          mappedAtCreation: false,
        }),
      'webgpu-runtime-error',
      'createBuffer (vbo) succeeded',
      'check device.limits.maxBufferSize and remaining VRAM',
    );
    if (!vboResult.ok) throw vboResult.error;
    const vboWrite = runShimSyncStep(
      () => queue.writeBuffer(vboResult.value, 0, asset.vertices),
      'queue-write-buffer-out-of-bounds',
      'queue.writeBuffer (vbo) succeeded',
      'verify offset alignment and bounds against buffer.size',
    );
    if (!vboWrite.ok) throw vboWrite.error;
    // Vertex-only mesh: skip the index buffer (indexBuffer: null below). The
    // indexed path is unchanged byte-for-byte when `meshIndices` is present.
    // biome-ignore lint/suspicious/noExplicitAny: opaque GPU buffer handle; null for vertex-only
    let ibo: any = null;
    if (meshIndices !== undefined) {
      const iboResult = runShimSyncStep(
        () =>
          rhiDevice.createBuffer({
            label: iboLabel,
            size: indexBytes,
            usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          }),
        'webgpu-runtime-error',
        'createBuffer (ibo) succeeded',
        'check device.limits.maxBufferSize and remaining VRAM',
      );
      if (!iboResult.ok) throw iboResult.error;
      ibo = iboResult.value;
      // Pad the source view up to indexBytes (multiple of 4) so writeBuffer's
      // 4-byte alignment requirement is satisfied even when the index byte
      // count itself is not a multiple of 4 (e.g. triangle = 6 bytes).
      const indexSrc = new Uint8Array(indexBytes);
      indexSrc.set(new Uint8Array(meshIndices.buffer, meshIndices.byteOffset, indexBytesUnpadded));
      const iboWrite = runShimSyncStep(
        () => queue.writeBuffer(ibo, 0, indexSrc),
        'queue-write-buffer-out-of-bounds',
        'queue.writeBuffer (ibo) succeeded',
        'verify offset alignment and bounds against buffer.size',
      );
      if (!iboWrite.ok) throw iboWrite.error;
    }
    // M-3 / w12: builtin direct-upload fallback path mirrors the gpuStore
    // mesh entry shape -- raw RHI Buffer handles are wrapped in GpuBuffer so
    // the dispose chain (M-5) can walk them via `.destroy()`.
    meshHandles.set(handle, {
      vertexBuffer: new GpuBuffer(rhiDevice, vboResult.value),
      indexBuffer: ibo === null ? null : new GpuBuffer(rhiDevice, ibo as Buffer),
      vboBytes: vertexBytes,
      iboBytes: meshIndices === undefined ? 0 : indexBytes,
      indexCount: meshIndices?.length ?? 0,
      indexFormat: meshIndices instanceof Uint32Array ? 'uint32' : 'uint16',
      // bug-20260519: BUILTIN_CUBE / BUILTIN_TRIANGLE migrated to 12F
      // (position + normal + uv + tangent), so the fallback literal mirrors
      // every other mesh upload site.
      layout: '12F',
      vertexCount: asset.vertices.length / 12,
      indexed: meshIndices !== undefined,
      topology: asset.submeshes[0]?.topology ?? 'triangle-list',
      submeshes: asset.submeshes,
    });
  }

  // ── Step 3.b: per-pipeline shared UBO / SSBO buffers ──────────────────────
  // The 3 BindGroups (view / material / mesh) the pbr.wgsl pipeline expects
  // are built per draw(world) frame in render-system.ts; the underlying
  // buffers are pipeline-scoped (allocated once, queue.writeBuffer-updated
  // per frame). The mesh storage path uses a runtime-sized
  // array<Mesh> bound up to instanceCount * 64 B per draw
  // (feat-20260511-tetris-retro-followups M4 D-P9); the buffer is initially
  // sized for INITIAL_MESH_SSBO_SLOT_COUNT = 1024 slots and grows on demand
  // via `meshSsboController.growMeshSsbo(neededSlots)` (M2 / T-M2-05;
  // pow2 doubling, ceiling = device.limits.maxStorageBufferBindingSize).
  const viewUboResult = runShimSyncStep(
    () =>
      rhiDevice.createBuffer({
        label: 'pbr-view-ubo',
        size: VIEW_UBO_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (view ubo) succeeded',
    'check device.limits.maxUniformBufferBindingSize',
  );
  if (!viewUboResult.ok) throw viewUboResult.error;

  // feat-20260613-csm-cascaded-shadow-maps M5 / w28: per-pass cascade-index
  // UBO consumed by shadow_caster.wgsl. 16 B (u32 index + 12 B pad to clear
  // the WebGL2 16 B uniform alignment requirement). Stable singleton; the
  // record stage queue.writeBuffer-overwrites the index immediately before
  // each cascade pass's command-encoder submit, and the per-pass submits
  // serialize host writes against GPU reads.
  const shadowCasterCascadeUboResult = runShimSyncStep(
    () =>
      rhiDevice.createBuffer({
        label: 'shadow-caster-cascade-ubo',
        size: 16,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (shadow-caster cascade ubo) succeeded',
    'check device.limits.maxUniformBufferBindingSize',
  );
  if (!shadowCasterCascadeUboResult.ok) throw shadowCasterCascadeUboResult.error;
  // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-05:
  // mesh + material buffer pair owned by `meshSsboController`; the
  // controller closes over `rhiDevice` + `internals.errorRegistry` so
  // `growMeshSsbo(neededSlots)` (called by record stage in M3) can rebuild
  // both buffers in lock-step (AC-06). Initial allocation lands at
  // `INITIAL_MESH_SSBO_SLOT_COUNT = 1024` slots (parity with the pre-feat
  // legacy literal); subsequent grow events pow2-double in one shot
  // (AC-05). PER_ENTITY_STRIDE stays at 256 B — only slot count grows
  // (OOS-10). Wrapper-object identity (`meshSsboState.mesh` /
  // `meshSsboState.material`) is stable across grow so PipelineState
  // fields below reference these wrappers once and survive grow events
  // (research §F8 R1).
  // M5 / T-M5-02 (P0 fix surfaced by GRID_SIZE=46 stress smoke):
  // `MeshSsboGrowDevice.createBuffer` returns a raw `Buffer`, but
  // `rhiDevice.createBuffer` returns `Result<Buffer, RhiError>` (RHI
  // explicit-failure contract). The previous direct cast
  // `rhiDevice as unknown as MeshSsboGrowDevice` smuggled a Result wrapper
  // into `meshWrapper.buffer`, which then surfaced at queue.submit as
  // "no overload matched for writeBuffer: object is not of the correct
  // interface type" once the 1024-slot grow path actually fired (any
  // workload >= 1024 entities; M5 culling stress is the first to land).
  // Unit tests at M2-02/03 mock createBuffer to return `Buffer` directly,
  // so they never caught the mismatch. Adapter unwraps the Result here
  // (errors bubble to the surrounding `runShimSyncStep` / record-stage
  // outer try/catch as `webgpu-runtime-error`).
  const meshSsboGrowDeviceAdapter: MeshSsboGrowDevice = {
    limits: rhiDevice.limits,
    createBuffer: (descriptor) => {
      const result = rhiDevice.createBuffer(descriptor);
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
  const meshSsboController = createMeshSsboGrowController({
    device: meshSsboGrowDeviceAdapter,
    errorRegistry: errorRegistry,
    initialSlotCount: INITIAL_MESH_SSBO_SLOT_COUNT,
    perEntityStride: PER_ENTITY_STRIDE,
    // bug-20260610: WebGL2 fallback uses uniform-buffer for the mesh array
    // (matches the STORAGE_BUFFER_AVAILABLE=false shader variant which
    // declares `var<uniform> meshes : array<Mesh, 128>` instead of
    // `var<storage> meshes : array<Mesh>`).
    meshUsage: storageBufferCapable
      ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
      : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    materialUsage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const initialBuildResult = runShimSyncStep<true>(
    () => {
      meshSsboController.initialBuild();
      return ok(true as const);
    },
    'webgpu-runtime-error',
    'createBuffer (mesh ssbo + material ubo initial build) succeeded',
    'check device.limits.maxStorageBufferBindingSize / maxUniformBufferBindingSize',
  );
  if (!initialBuildResult.ok) throw initialBuildResult.error;
  const meshSsboState = meshSsboController.state;
  // Expose the grow hook + state on internals (via the setGrowMeshSsboHook
  // callback) so M3's record stage `ensureMeshSsboCapacity` can call it
  // (T-M2-05 acceptanceCheck #3 + T-M3-04 wiring: `growMeshSsbo` mention
  // count >= 2 in createRenderer.ts — definition + this exposure).
  setGrowMeshSsboHook(meshSsboController.growMeshSsbo, meshSsboController.state);

  // feat-20260519-light-casters-point-spot-pbr M3 / w20 (D-S1 + D-S2):
  // PointLight + SpotLight std430 storage buffers. Header 16 B (count u32 +
  // 12 B pad) + 4-slot first-slice cap (32 B / 48 B per slot). Sized
  // generously so that the buffer.size never changes once allocated; per-
  // frame writeBuffer overwrites the entire range (D-S6 full rewrite +
  // charter P3 explicit failure: stable buffer.size means no orphan slot
  // reuse).
  const POINT_LIGHTS_BUFFER_BYTES =
    LIGHT_ARRAY_HEADER_BYTES + POINT_LIGHT_STD430_BYTES * LIGHT_ARRAY_MAX_SLOTS;
  const SPOT_LIGHTS_BUFFER_BYTES =
    LIGHT_ARRAY_HEADER_BYTES + SPOT_LIGHT_STD430_BYTES * LIGHT_ARRAY_MAX_SLOTS;
  // bug-20260610: WebGL2 fallback — pointLights / spotLights buffers must
  // be UNIFORM-usage (the storage variant of the shader is gated by
  // STORAGE_BUFFER_AVAILABLE; the uniform-fallback path expects uniform
  // buffers). Without this swap, the buffer-creation succeeds (driver still
  // accepts STORAGE flag), but `createBindGroup` validation rejects the
  // mismatch: `Usage flags BufferUsages(COPY_DST | STORAGE) ... do not
  // contain required usage flags BufferUsages(UNIFORM)`.
  const LIGHTS_BUFFER_USAGE = storageBufferCapable
    ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
    : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST;
  const pointLightsBufferResult = runShimSyncStep(
    () =>
      rhiDevice.createBuffer({
        label: 'pbr-point-lights-ssbo',
        size: POINT_LIGHTS_BUFFER_BYTES,
        usage: LIGHTS_BUFFER_USAGE,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (point-lights ssbo) succeeded',
    'check device.limits.maxStorageBufferBindingSize',
  );
  if (!pointLightsBufferResult.ok) throw pointLightsBufferResult.error;
  const spotLightsBufferResult = runShimSyncStep(
    () =>
      rhiDevice.createBuffer({
        label: 'pbr-spot-lights-ssbo',
        size: SPOT_LIGHTS_BUFFER_BYTES,
        usage: LIGHTS_BUFFER_USAGE,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (spot-lights ssbo) succeeded',
    'check device.limits.maxStorageBufferBindingSize',
  );
  if (!spotLightsBufferResult.ok) throw spotLightsBufferResult.error;

  // feat-20260513-instanced-mesh M3 (T-M3-2): identity-mat4 fallback
  // storage buffer. Single 64-byte storage buffer carrying one identity
  // mat4 column-major. Renderables without an `Instances` component bind
  // this buffer at @group(3) so the shader's
  // `instances_local[instance_index]` lookup at idx=0 returns I (no
  // additional transform), giving the consistent-abstraction single
  // branch (charter prop 5; plan D-7 fallback semantics). The buffer is
  // seeded once at pipeline creation; the record-stage never rewrites
  // it.
  // bug-20260610: WebGL2 fallback uses uniform-buffer for instances
  // (the shader's `STORAGE_BUFFER_AVAILABLE=false` variant declares
  // `var<uniform> instances : array<InstanceData, 128>`).
  const IDENTITY_INSTANCE_BYTES = storageBufferCapable ? 64 : 64 * 128; // uniform array<InstanceData, 128> is full-sized
  const identityInstanceResult = runShimSyncStep(
    () =>
      rhiDevice.createBuffer({
        label: 'pbr-identity-instance-ssbo',
        size: IDENTITY_INSTANCE_BYTES,
        usage: storageBufferCapable
          ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
          : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (identity instance ssbo) succeeded',
    'check device.limits.maxStorageBufferBindingSize',
  );
  if (!identityInstanceResult.ok) throw identityInstanceResult.error;
  // Seed the identity-mat4 (column-major; diagonal 1s).
  const identityMat4 = new Float32Array(16);
  identityMat4[0] = 1;
  identityMat4[5] = 1;
  identityMat4[10] = 1;
  identityMat4[15] = 1;
  const identityWrite = runShimSyncStep(
    () => queue.writeBuffer(identityInstanceResult.value, 0, identityMat4),
    'queue-write-buffer-out-of-bounds',
    'queue.writeBuffer (identity instance ssbo) succeeded',
    'verify offset alignment and bounds against buffer.size',
  );
  if (!identityWrite.ok) throw identityWrite.error;

  // feat-20260515 M3 / T-M3-05 (research F-6 fix): default sampler + fallback
  // 1x1 white texture seed the materialBindGroup sampler / textureView
  // entries when MaterialAsset.baseColorTexture is undefined. Default
  // sampler matches research F-5 SSOT three-source convergence (linear
  // min/mag/mipmap; repeat addressMode); the fallback texture is a 1x1
  // RGBA8 white pixel so unlit / standard materials with no texture
  // multiply by 1 in M5 once UV-driven sampling lands.
  const defaultSamplerResult = runShimSyncStep(
    () =>
      rhiDevice.createSampler({
        label: 'default-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      }),
    'webgpu-runtime-error',
    'createSampler (default) succeeded',
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!defaultSamplerResult.ok) throw defaultSamplerResult.error;

  const nearestSamplerResult = runShimSyncStep(
    () =>
      rhiDevice.createSampler({
        label: 'nearest-sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
        mipmapFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    'webgpu-runtime-error',
    'createSampler (nearest) succeeded',
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!nearestSamplerResult.ok) throw nearestSamplerResult.error;

  // feat-20260520-directional-light-shadow-mapping M1c / w8 + M2 / w14:
  // shadow comparison sampler — clamp-to-edge, linear filter, compare:'less'.
  // Used for shadow map sampling in M2/M3 and shadow depth pass. comparison
  // sampler enables textureSampleCompareLevel in pbr.wgsl's evalDirectional().
  // Created once at pipeline build time; reused across frames.
  const shadowSamplerResult = runShimSyncStep(
    () =>
      rhiDevice.createSampler({
        label: 'shadow-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        compare: 'less',
      }),
    'webgpu-runtime-error',
    'createSampler (shadow) succeeded',
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!shadowSamplerResult.ok) throw shadowSamplerResult.error;

  // GPUTextureUsage flags spec literals: TEXTURE_BINDING (0x4) | COPY_DST
  // (0x2) -- the fallback white texture only needs sampler binding +
  // queue.writeTexture for the seed white pixel.
  const TEXTURE_BINDING_USAGE = 0x4;
  const TEXTURE_COPY_DST_USAGE = 0x2;
  const fallbackTextureResult = runShimSyncStep(
    () =>
      rhiDevice.createTexture({
        label: 'fallback-white-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING_USAGE | TEXTURE_COPY_DST_USAGE,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    'webgpu-runtime-error',
    'createTexture (fallback white) succeeded',
    'check device.limits.maxTextureDimension2D',
  );
  if (!fallbackTextureResult.ok) throw fallbackTextureResult.error;

  // The fallback white pixel is a 1x1 RGBA8 sample. The forgeax rhi shim
  // enforces `bytesPerRow % 256 === 0` regardless of row count (spec
  // normative for multi-row copies, but the shim is uniformly strict).
  // Pad the source buffer to a 256-byte row stride; the upload still
  // writes only 1x1 because the destination size is 1x1.
  const FALLBACK_BYTES_PER_ROW = 256;
  const fallbackPixel = new Uint8Array(FALLBACK_BYTES_PER_ROW);
  fallbackPixel[0] = 255;
  fallbackPixel[1] = 255;
  fallbackPixel[2] = 255;
  fallbackPixel[3] = 255;
  const fallbackWriteResult = runShimSyncStep(
    () =>
      queue.writeTexture(
        {
          texture: fallbackTextureResult.value as unknown as GPUTexture,
          mipLevel: 0,
          origin: { x: 0, y: 0, z: 0 },
        },
        fallbackPixel,
        { offset: 0, bytesPerRow: FALLBACK_BYTES_PER_ROW, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      ),
    'queue-write-buffer-out-of-bounds',
    'queue.writeTexture (fallback white pixel) succeeded',
    'verify bytesPerRow / rowsPerImage alignment',
  );
  if (!fallbackWriteResult.ok) throw fallbackWriteResult.error;

  const fallbackTextureViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(fallbackTextureResult.value, {
        label: 'fallback-white-view',
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    'createTextureView (fallback white) succeeded',
    'check fallback texture format / usage',
  );
  if (!fallbackTextureViewResult.ok) throw fallbackTextureViewResult.error;

  // Normal-slot fallback: 1x1 RGBA8 (128, 128, 255, 255). pbr.wgsl decodes
  // sample.rg * 2 - 1 + z = sqrt(1 - x^2 - y^2), so RG=(128,128)=0.5 maps
  // to tangent (0, 0, 1) -- zero perturbation when normalTexture is absent.
  // Cannot share the white fallback (255,255,...) because RG=(255,255)=1.0
  // gives tangent.xy=(1,1) -> 1 - 2 = -1 under the sqrt -> NaN (saturate
  // clamps to 0 z=0, still wrong). White-on-missing semantics for baseColor
  // / metallicRoughness slots is preserved by keeping those bound to the
  // shared fallbackTextureView; only the normal slot uses this view.
  const fallbackNormalTextureResult = runShimSyncStep(
    () =>
      rhiDevice.createTexture({
        label: 'fallback-normal-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'rgba8unorm',
        usage: TEXTURE_BINDING_USAGE | TEXTURE_COPY_DST_USAGE,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    'webgpu-runtime-error',
    'createTexture (fallback normal) succeeded',
    'check device.limits.maxTextureDimension2D',
  );
  if (!fallbackNormalTextureResult.ok) throw fallbackNormalTextureResult.error;

  const fallbackNormalPixel = new Uint8Array(FALLBACK_BYTES_PER_ROW);
  fallbackNormalPixel[0] = 128;
  fallbackNormalPixel[1] = 128;
  fallbackNormalPixel[2] = 255;
  fallbackNormalPixel[3] = 255;
  const fallbackNormalWriteResult = runShimSyncStep(
    () =>
      queue.writeTexture(
        {
          texture: fallbackNormalTextureResult.value as unknown as GPUTexture,
          mipLevel: 0,
          origin: { x: 0, y: 0, z: 0 },
        },
        fallbackNormalPixel,
        { offset: 0, bytesPerRow: FALLBACK_BYTES_PER_ROW, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      ),
    'queue-write-buffer-out-of-bounds',
    'queue.writeTexture (fallback normal pixel) succeeded',
    'verify bytesPerRow / rowsPerImage alignment',
  );
  if (!fallbackNormalWriteResult.ok) throw fallbackNormalWriteResult.error;

  const fallbackNormalTextureViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(fallbackNormalTextureResult.value, {
        label: 'fallback-normal-view',
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    'createTextureView (fallback normal) succeeded',
    'check fallback normal texture format / usage',
  );
  if (!fallbackNormalTextureViewResult.ok) throw fallbackNormalTextureViewResult.error;

  // feat-20260520-directional-light-shadow-mapping M2 / w14 (D-1):
  // shadowFallbackTextureView is a 1x1 depth32float fallback bound at
  // viewBindGroup entry 3 when no shadow RT exists (castShadow:false
  // or allocation failed). Cleared to 1.0 (far plane) via a minimal
  // render pass so textureSampleCompareLevel always returns 1.0 (fully lit).
  // Uses RENDER_ATTACHMENT for the clear pass + TEXTURE_BINDING for sampling.
  const RENDER_ATTACHMENT_USAGE = 0x10;
  const SHADOW_FALLBACK_USAGE = TEXTURE_BINDING_USAGE | RENDER_ATTACHMENT_USAGE;
  const shadowFallbackTexResult = runShimSyncStep(
    () =>
      rhiDevice.createTexture({
        label: 'shadow-fallback-depth-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'depth32float',
        usage: SHADOW_FALLBACK_USAGE,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    'webgpu-runtime-error',
    'createTexture (shadow fallback depth) succeeded',
    'check device.limits.maxTextureDimension2D',
  );
  if (!shadowFallbackTexResult.ok) throw shadowFallbackTexResult.error;

  const shadowFallbackViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(shadowFallbackTexResult.value, {
        label: 'shadow-fallback-depth-view',
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    'createTextureView (shadow fallback depth) succeeded',
    'check shadow fallback texture format / usage',
  );
  if (!shadowFallbackViewResult.ok) throw shadowFallbackViewResult.error;

  // Clear the 1x1 depth fallback to 1.0 (far plane) via a 1-pixel render pass.
  const shadowFallbackClearEncResult = rhiDevice.createCommandEncoder({
    label: 'shadow-fallback-clear-encoder',
  });
  if (!shadowFallbackClearEncResult.ok) throw shadowFallbackClearEncResult.error;
  const shadowFallbackPass = shadowFallbackClearEncResult.value.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: shadowFallbackViewResult.value,
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  } as never);
  shadowFallbackPass.end();
  const shadowFallbackClearFinish = shadowFallbackClearEncResult.value.finish();
  if (!shadowFallbackClearFinish.ok) throw shadowFallbackClearFinish.error;
  const shadowFallbackClearSubmit = queue.submit([shadowFallbackClearFinish.value]);
  if (!shadowFallbackClearSubmit.ok) throw shadowFallbackClearSubmit.error;

  // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 1x1x6
  // depth32float cube_array fallback bound at viewBindGroup entry 5 when no
  // PointLightShadow snapshots are active. dimension: '2d' with
  // depthOrArrayLayers: 6 produces a 6-layer 2D array that
  // `dimension: 'cube-array'` views can target (one cube, layers=1). The
  // texture is cleared to depth=1.0 (far plane) so
  // textureSampleCompareLevel always returns 1.0 (fully lit) regardless of
  // the depthRef the shader passes. AC-09 zero-allocation invariant
  // preserved: the real cube_array atlas in ShadowAtlas is still
  // lazy-allocated (the fallback is always created, but it only takes 24
  // bytes of GPU memory).
  const shadowAtlasFallbackTexResult = runShimSyncStep(
    () =>
      rhiDevice.createTexture({
        label: 'shadow-atlas-fallback-cube-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 6 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'depth32float',
        usage: SHADOW_FALLBACK_USAGE,
        viewFormats: [],
        textureBindingViewDimension: 'cube',
      }),
    'webgpu-runtime-error',
    'createTexture (shadow atlas fallback cube) succeeded',
    'check device.limits.maxTextureDimension2D and cube-array support',
  );
  if (!shadowAtlasFallbackTexResult.ok) throw shadowAtlasFallbackTexResult.error;

  const shadowAtlasFallbackViewResult = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(shadowAtlasFallbackTexResult.value, {
        label: 'shadow-atlas-fallback-cube-array-view',
        dimension: 'cube-array',
        aspect: 'depth-only',
        baseArrayLayer: 0,
        arrayLayerCount: 6,
        baseMipLevel: 0,
        mipLevelCount: 1,
      }),
    'webgpu-runtime-error',
    'createTextureView (shadow atlas fallback cube-array) succeeded',
    'check shadow atlas fallback texture format / usage / dimension',
  );
  if (!shadowAtlasFallbackViewResult.ok) throw shadowAtlasFallbackViewResult.error;

  // Clear all 6 fallback faces to 1.0 (far plane). One pass per face
  // (WebGPU forbids cube views as render-pass attachments; per-face 2D view
  // is required).
  for (let face = 0; face < 6; face++) {
    const faceViewRes = runShimSyncStep(
      () =>
        rhiDevice.createTextureView(shadowAtlasFallbackTexResult.value, {
          label: `shadow-atlas-fallback-face-${face}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      'webgpu-runtime-error',
      `createTextureView (shadow atlas fallback face ${face}) succeeded`,
      'check shadow atlas fallback texture format / usage',
    );
    if (!faceViewRes.ok) throw faceViewRes.error;
    const encRes = rhiDevice.createCommandEncoder({
      label: `shadow-atlas-fallback-clear-encoder-face-${face}`,
    });
    if (!encRes.ok) throw encRes.error;
    const pass = encRes.value.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: faceViewRes.value,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    } as never);
    pass.end();
    const finRes = encRes.value.finish();
    if (!finRes.ok) throw finRes.error;
    const subRes = queue.submit([finRes.value]);
    if (!subRes.ok) throw subRes.error;
  }

  // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: shadowParams
  // uniform buffer = `array<vec4<f32>, 4>` (4 lanes x 16 B = 64 B). One
  // lane per PointLightShadow slot (cap = 4). Each lane stores
  // `(near, far, 1/(far-near), 0)` for depth-ref reconstruction in
  // lighting-punctual.wgsl evalPointShadowed. Written per frame in the
  // record stage from `frameState.pointShadowSnapshots`. Initial contents
  // are zero (writeBuffer at create time is implicit per spec); zero lanes
  // are safe because the WGSL sample path is gated on
  // `PointLight.shadowAtlasLayer >= 0` -- a non-shadow-casting light
  // cannot read its lane.
  const SHADOW_PARAMS_BYTES = 4 * 16;
  const shadowParamsBufferResult = runShimSyncStep(
    () =>
      rhiDevice.createBuffer({
        label: 'shadow-params-ubo',
        size: SHADOW_PARAMS_BYTES,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (shadow params UBO) succeeded',
    'check device.limits.maxUniformBufferBindingSize (need >= 64)',
  );
  if (!shadowParamsBufferResult.ok) throw shadowParamsBufferResult.error;
  // Zero-initialize the buffer so the no-shadow path reads deterministic
  // zeros (writeBuffer with 64 B of zeros).
  const SHADOW_PARAMS_ZEROES = new Uint8Array(SHADOW_PARAMS_BYTES);
  const shadowParamsZeroWriteRes = queue.writeBuffer(
    shadowParamsBufferResult.value,
    0,
    SHADOW_PARAMS_ZEROES,
  );
  if (!shadowParamsZeroWriteRes.ok) throw shadowParamsZeroWriteRes.error;

  // feat-20260520-skylight-ibl-cubemap M2 round-4 / t40 amend
  // (plan-strategy D-5 round-4 REVISED): allocate the fallback Skylight
  // identity resource bundle -- 1x1 all-zero rgba16float texture_cube * 2
  // (irradiance + prefilter) + 1x1 all-zero rg16float brdfLut +
  // intensity=0 uniform buffer + a single linear/clamp sampler reused
  // across the three texture slots. No stand-alone BindGroupLayout /
  // BindGroup is allocated -- those roles moved into the PBR material
  // BGL factory (entries 7..13 inside @group(1)). The M4 record-stage
  // material BG assembly site feeds these resources through
  // `assembleMaterialWithSkylightEntries` when `skylightCount === 0` so
  // `standardPipeline` / `standardPipelineHdr` dispatch with ambient = 0
  // -- physical convergence with D-4 (charter F1: AI users writing
  // demos do not need a "is there a skylight?" branch).
  //
  // SkylightDevice / SkylightQueue minimal subsets are structurally
  // compatible with RhiDevice / RhiQueue; the cast at the boundary is
  // safe by construction (the helper only touches createBindGroupLayout
  // / createSampler / createTexture / createTextureView / createBuffer /
  // createBindGroup on the device side and writeTexture / writeBuffer on
  // the queue side, all of which RhiDevice / RhiQueue declare).
  let skylightFallback: SkylightFallback | null = null;
  try {
    skylightFallback = createSkylightFallback(
      rhiDevice as unknown as Parameters<typeof createSkylightFallback>[0],
      queue as unknown as Parameters<typeof createSkylightFallback>[1],
    );
  } catch (caught) {
    if (caught instanceof RhiError) throw caught;
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'createSkylightFallback succeeded',
      hint: `verify texture_cube + uniform allocation (cause: ${
        caught instanceof Error ? caught.message : String(caught)
      })`,
    });
  }

  // feat-20260615-pipeline-spec-ssot M2-T4: PipelineCache is the single PSO container
  // (SSOT axiom — plan D-12). Created once at boot; shared across all call sites.
  // The provider is a thin wrapper over rhiDevice that fills in vertex buffers +
  // pipeline layout on the descriptor produced by buildPipelineDescriptor.
  const pipelineCache: PipelineCache = new Map();

  // Shader module mapping — maps spec.shader.id to compiled shader modules +
  // optional per-pass metadata (layout, entry points). Material shaders fill
  // only vertex/fragment; fullscreen-post passes add layout + entry points
  // for the boot-time SPEC_CONST pre-warm and lazy-build getOrBuildPipeline.
  const shaderModuleMap = new Map<
    string,
    {
      vertex: unknown;
      fragment: unknown;
      vertexEntryPoint?: string;
      fragmentEntryPoint?: string;
      layout?: unknown;
      label?: string;
    }
  >();
  if (unlitModule !== null)
    shaderModuleMap.set('forgeax::default-unlit', {
      vertex: unlitModule,
      fragment: unlitModule,
    });
  if (pbrModule !== null)
    shaderModuleMap.set('forgeax::default-standard-pbr', {
      vertex: pbrModule,
      fragment: pbrModule,
    });
  if (spriteModule !== null)
    shaderModuleMap.set('forgeax::default-sprite', {
      vertex: spriteModule,
      fragment: spriteModule,
    });
  // M2-T4: fullscreen-post shader modules (tonemap + skybox) are registered
  // in their respective blocks after pipeline layout creation — layout is
  // required for the boot-time SPEC_CONST pre-warm to succeed. The entries
  // in SPEC_CONST_TABLE will be pre-warmed per-block.

  // M2-T4: provider no longer overwrites vertex buffers — buildPipelineDescriptor
  // derives them from spec.geometry.vertexLayout (SSOT). Layout is only filled
  // when the descriptor doesn't already carry one (fullscreen-post passes set it
  // via modules.layout). Fullscreen-post module detection added for label generation.
  const pipelineDeviceProvider: PipelineDeviceProvider = {
    createRenderPipeline(descriptor: Record<string, unknown>):
      | {
          ok: true;
          value: unknown;
        }
      | { ok: false; error: unknown } {
      const d = { ...descriptor } as Record<string, unknown>;

      // Layout: only fill if buildPipelineDescriptor did not already set it.
      if (d.layout === undefined) {
        d.layout = pipelineLayoutResult.value;
      }

      // Sprite HDR uses fragment entry point 'fs_main_hdr'; all other
      // standard material pipelines (unlit/standard LDR/HDR, sprite LDR)
      // use 'fs_main'. The spec is business-agnostic (plan D-7) so the
      // provider resolves this by checking the fragment module reference
      // against the compiled sprite module + the attachment format.
      //
      // Also generates a label for each PSO so integration tests and GPU
      // debug captures can identify the pipeline variant. The label shape
      // is derived from the fragment module + color format (backward-
      // compatible with pre-M2 descriptor literals).
      let label = 'pbr-pipeline';
      if (d.fragment) {
        const f = { ...(d.fragment as Record<string, unknown>) } as Record<string, unknown>;
        const fragModule = f.module;
        const targets = f.targets as Array<Record<string, unknown>> | undefined;
        const isHdr = targets?.[0]?.format === HDR_COLOR_ATTACHMENT_FORMAT;

        if (fragModule === spriteModule) {
          label = isHdr ? 'sprite-pipeline-hdr' : 'sprite-pipeline';
          if (isHdr) {
            f.entryPoint = 'fs_main_hdr';
          }
        } else if (fragModule === unlitModule || fragModule === pbrModule) {
          const prefix = fragModule === unlitModule ? 'unlit' : 'standard';
          label = isHdr ? `pbr-pipeline-${prefix}-hdr` : `pbr-pipeline-${prefix}`;
        } else if (fragModule === fxaaModule) {
          label = 'fxaa-pipeline';
        } else if (fragModule === skyboxModule) {
          const msaa = d.multisample as Record<string, unknown> | undefined;
          label = msaa !== undefined ? 'skybox-pipeline-msaa' : 'skybox-pipeline';
        } else if (fragModule === bloomBrightModule) {
          label = 'bloom-bright-pipeline';
        } else if (fragModule === bloomBlurModule) {
          label = (d.label as string) ?? 'bloom-blur-h-pipeline';
        } else if (fragModule === bloomCompositeModule) {
          label = 'bloom-composite-pipeline';
        } else if (fragModule === ssaoModule) {
          label = (d.label as string) ?? 'ssao-calc-pipeline';
        }

        d.fragment = f;
      }
      d.label = (d.label as string | undefined) ?? label;

      return rhiDevice.createRenderPipeline(
        d as unknown as Parameters<typeof rhiDevice.createRenderPipeline>[0],
      );
    },
  };

  // bug-20260615 fix-up: build the SPEC_CONST table with the runtime-resolved
  // LDR view format. Hard-coding `bgra8unorm-srgb` at module load made the
  // pre-warmed PSOs incompatible with the actual swap-chain format on
  // backends where `getPreferredCanvasFormat()` (or the wgpu-wasm GLES path)
  // returns `rgba8unorm` (Channel 3 + dawn-node) — every frame's whole
  // commandBuffer was being rejected. Calling `buildSpecConstTable` after
  // `selectSwapChainFormat` resolves keeps the pre-warmed key (`cacheKeyOf`)
  // and the runtime tonemap call site (uses the same `swapChainFormats.view`)
  // identical, so the cache lookup hits instead of double-building.
  // Pass both view (unlit / standard / tonemap LDR target) and storage
  // (sprite LDR target — pre-feat sprite PSO targeted swapChainFormats.storage
  // directly so the alpha-blend pass writes the raw, non-srgb view of the
  // swap-chain texture; see pipeline-spec.ts SPRITE_ATTACHMENTS jsdoc).
  const runtimeSpecConstTable = buildSpecConstTable(
    swapChainFormats.view,
    swapChainFormats.storage,
  );

  // Boot-time pre-warm: build SPEC_CONST entries whose shader modules are
  // compiled. Entries referencing a missing module are silently skipped
  // (the empty-manifest path — D-3). Any build failure for an available
  // module throws PipelineSpecError (fail-fast, charter P3).
  if (unlitModule !== null || pbrModule !== null || spriteModule !== null) {
    for (const spec of runtimeSpecConstTable) {
      const modules = shaderModuleMap.get(spec.shader.id);
      if (modules === undefined) {
        // Module not compiled (empty-manifest for this shader): skip.
        continue;
      }
      try {
        getOrBuildPipeline(spec, pipelineDeviceProvider, pipelineCache, modules);
      } catch (err) {
        if (err instanceof PipelineSpecError) throw err;
        throw new PipelineSpecError({
          code: 'pipeline-build-failed',
          detail: { cause: err },
          hint: `Boot-time SPEC_CONST pre-warm failed for shader '${spec.shader.id}'; inspect gpuMessage on the cause`,
        });
      }
    }

    // M6 fix-up: seed `materialShaderPipelineCache` (owned by the outer
    // `makeWebGPURenderer` scope) from the prewarmed `pipelineCache` for
    // SPEC_CONST entries whose `variantSet !== undefined`. The URP record
    // path queries `getMaterialShaderPipeline(...)` keyed off
    // `cacheKeyOf(spec)` with `variantSet=URP_PBR_VARIANT_SET`; both caches
    // generate keys via the same `cacheKeyOf` so the lookup hits the
    // boot-time prewarmed PSO instead of triggering a 1-frame async-compile
    // skip-draw. Seeding only variantSet-bearing entries keeps the
    // no-variant entries flowing through the original
    // `pipelineState.standardPipeline*` channel (consumed by sprite /
    // unlit-fallback paths), so URP-vs-no-variant cache identity stays
    // explicit instead of collapsing into one map (charter P3).
    for (const spec of runtimeSpecConstTable) {
      if (spec.shader.variantSet === undefined) continue;
      if (shaderModuleMap.get(spec.shader.id) === undefined) continue;
      const key = cacheKeyOf(spec);
      const built = pipelineCache.get(key);
      if (built !== undefined) {
        seedMaterialShaderPipelineCache(key, built as RenderPipeline);
      }
    }
  }

  // helper: look up a pre-warmed PSO from cache by (shaderId, isHdr, sampleCount).
  // Resolves the matching runtimeSpecConstTable entry, computes cacheKeyOf,
  // and returns the cached handle. Returns null when the spec entry's module
  // was not compiled (empty-manifest path) or the cache is cold.
  const getCachedPipelineOrNull = (
    shaderId: string,
    isHdr: boolean,
    sampleCount: 1 | 4,
  ): RenderPipeline | null => {
    for (const entry of runtimeSpecConstTable) {
      if (entry.shader.id === shaderId && entry.attachments.sampleCount === sampleCount) {
        const color0 = entry.attachments.colorFormats[0];
        const entryIsHdr = color0 === HDR_COLOR_ATTACHMENT_FORMAT;
        if (entryIsHdr === isHdr) {
          const key = cacheKeyOf(entry);
          return (pipelineCache.get(key) ?? null) as RenderPipeline | null;
        }
      }
    }
    return null;
  };

  // ── feat-20260520-directional-light-shadow-mapping M2 / w15 (AC-12) ───────
  //
  // Shadow-factor probe pipeline. Compiled once at pipeline build time when
  // the shader manifest is non-empty (gated on `unlitModule !== null` as a
  // proxy for "the device can compile shaders"; see the empty-manifest D-3
  // pattern). The probe uses an inline WGSL constant (SHADOW_PROBE_WGSL,
  // declared near the top of this file) and its own 1-BGL pipeline layout —
  // intentionally orthogonal to the main pipeline's 4-BGL chain. Probe-only
  // resources (LSM UBO + storage input + 1xN r32float RT + 256B staging
  // buffer) are allocated up-front; per-call cost in `debugSampleShadowFactor`
  // is two `queue.writeBuffer` + one transient BindGroup + one render pass +
  // one `copyTextureToBuffer` + one `mapAsync`.
  let shadowProbePipelineHandle: RenderPipeline | null = null;
  let shadowProbeBindGroupLayoutHandle: BindGroupLayout | null = null;
  let shadowProbeLsmUboHandle: Buffer | null = null;
  let shadowProbeInputBufHandle: Buffer | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle (matches sibling shadowTexture field)
  let shadowProbeOutputTexHandle: any | null = null;
  let shadowProbeOutputViewHandle: TextureView | null = null;
  let shadowProbeStagingBufHandle: Buffer | null = null;
  // bug-20260610: WebGL2 (downlevel_webgl2_defaults) reports
  // `maxStorageBuffersPerShaderStage = 0`, which makes the shadow-probe
  // BindGroupLayout fail at creation (its binding 1 is a fragment-stage
  // storage buffer). The probe is a debug helper used by
  // `debugSampleShadowFactor`; without it the main render path is intact.
  // Skip the entire probe-pipeline construction when storage buffers are
  // unavailable; the probe handles stay null and the debug entry returns
  // a structured RhiError if invoked (charter P3 explicit failure).
  if (unlitModule !== null && storageBufferCapable) {
    const probeBglResult = runShimSyncStep(
      () =>
        rhiDevice.createBindGroupLayout({
          label: 'shadow-probe-bgl',
          entries: [
            {
              binding: 0,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              buffer: { type: 'uniform' },
            },
            {
              binding: 1,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              buffer: { type: 'read-only-storage' },
            },
            {
              binding: 2,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              texture: { sampleType: 'depth', viewDimension: '2d' },
            },
            {
              binding: 3,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              sampler: { type: 'comparison' },
            },
          ],
        }),
      'webgpu-runtime-error',
      'createBindGroupLayout(shadow-probe) succeeded',
      'check device.limits.maxBindGroupsPerPipelineLayout',
    );
    if (!probeBglResult.ok) throw probeBglResult.error;
    shadowProbeBindGroupLayoutHandle = probeBglResult.value;

    const probePipelineLayoutResult = runShimSyncStep(
      () =>
        rhiDevice.createPipelineLayout({
          label: 'shadow-probe-pl',
          bindGroupLayouts: [probeBglResult.value],
        }),
      'webgpu-runtime-error',
      'createPipelineLayout(shadow-probe) succeeded',
      'verify shadow-probe BindGroupLayout matches inline WGSL @group(0) bindings',
    );
    if (!probePipelineLayoutResult.ok) throw probePipelineLayoutResult.error;

    const probeShaderResult = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, {
              code: SHADOW_PROBE_WGSL,
              label: 'shadow-probe',
            })
          : invokeDeviceCreateShaderModule(rhiDevice, {
              code: SHADOW_PROBE_WGSL,
              label: 'shadow-probe',
            }),
      'shader-compile-failed',
      'shadow-probe shader module compiled',
      'inspect SHADOW_PROBE_WGSL constant; verify textureSampleCompareLevel + comparison sampler binding',
    );
    if (!probeShaderResult.ok) throw probeShaderResult.error;
    const probeModule = probeShaderResult.value;

    // M2-T4: shadow-probe pipeline via getOrBuildPipeline (lazy-build).
    // The probe is a fullscreen pass that samples the cascaded shadow map and
    // writes a per-pixel visibility factor into an r32float color attachment
    // (PROBE_OUTPUT_TEXTURE_FORMAT) — `passKind: 'post-process'` is correct;
    // the prior `'shadow-caster'` value triggered `buildPipelineDescriptor`'s
    // depth-only branch (skip fragment stage), producing a PSO with no
    // attachment that Dawn rejects with "No attachment was specified" (bug
    // surfaced by the bug-20260615 hello-cube smoke once the BGRA/RGBA
    // attachment-mismatch error storm was cleared).
    {
      const probeSpec: PipelineSpec = {
        shader: { id: 'forgeax::shadow::probe', passKind: 'post-process', variantSet: undefined },
        attachments: {
          colorFormats: [PROBE_OUTPUT_TEXTURE_FORMAT],
          depthFormat: undefined,
          sampleCount: 1,
        },
        geometry: {
          topology: 'triangle-list',
          stripIndexFormat: undefined,
          vertexLayout: {},
        },
        renderState: { cullMode: 'none' },
      };
      const modules = {
        vertex: probeModule,
        fragment: probeModule,
        layout: probePipelineLayoutResult.value,
      };
      try {
        shadowProbePipelineHandle = getOrBuildPipeline(
          probeSpec,
          pipelineDeviceProvider,
          pipelineCache,
          modules,
        ) as RenderPipeline;
      } catch (err) {
        if (err instanceof PipelineSpecError) throw err;
        throw new PipelineSpecError({
          code: 'pipeline-build-failed',
          detail: { cause: err },
          hint: 'createRenderPipeline(shadow-probe) failed; inspect SHADOW_PROBE_WGSL',
        });
      }
    }

    const probeLsmUboResult = runShimSyncStep(
      () =>
        rhiDevice.createBuffer({
          label: 'shadow-probe-lsm-ubo',
          size: PROBE_LSM_UBO_BYTES,
          usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
          mappedAtCreation: false,
        }),
      'webgpu-runtime-error',
      'createBuffer(shadow-probe LSM UBO) succeeded',
      'check device.limits.maxUniformBufferBindingSize',
    );
    if (!probeLsmUboResult.ok) throw probeLsmUboResult.error;
    shadowProbeLsmUboHandle = probeLsmUboResult.value;

    const probeInputBufResult = runShimSyncStep(
      () =>
        rhiDevice.createBuffer({
          label: 'shadow-probe-input-storage',
          size: PROBE_INPUT_BYTES,
          usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
          mappedAtCreation: false,
        }),
      'webgpu-runtime-error',
      'createBuffer(shadow-probe input storage) succeeded',
      'check device.limits.maxStorageBufferBindingSize',
    );
    if (!probeInputBufResult.ok) throw probeInputBufResult.error;
    shadowProbeInputBufHandle = probeInputBufResult.value;

    // GPUTextureUsage.COPY_SRC = 0x01 spec literal. The probe RT is
    // copyTextureToBuffer source; RENDER_ATTACHMENT for the probe pass
    // colour target; TEXTURE_BINDING is unused but cheap and keeps the
    // texture symmetric with the shadow RT for future debug taps.
    const TEXTURE_COPY_SRC_USAGE = 0x01;
    const PROBE_RT_USAGE = TEXTURE_BINDING_USAGE | RENDER_ATTACHMENT_USAGE | TEXTURE_COPY_SRC_USAGE;
    const probeOutputTexResult = runShimSyncStep(
      () =>
        rhiDevice.createTexture({
          label: 'shadow-probe-output-1xN-r32float',
          size: { width: PROBE_MAX_COUNT, height: 1, depthOrArrayLayers: 1 },
          mipLevelCount: 1,
          sampleCount: 1,
          dimension: '2d',
          format: PROBE_OUTPUT_TEXTURE_FORMAT,
          usage: PROBE_RT_USAGE,
          viewFormats: [],
          textureBindingViewDimension: undefined,
        }),
      'webgpu-runtime-error',
      'createTexture(shadow-probe output) succeeded',
      'check device.limits.maxTextureDimension2D and r32float RENDER_ATTACHMENT support',
    );
    if (!probeOutputTexResult.ok) throw probeOutputTexResult.error;
    shadowProbeOutputTexHandle = probeOutputTexResult.value;

    const probeOutputViewResult = runShimSyncStep(
      () =>
        rhiDevice.createTextureView(probeOutputTexResult.value, {
          label: 'shadow-probe-output-view',
          dimension: '2d',
        }),
      'webgpu-runtime-error',
      'createTextureView(shadow-probe output) succeeded',
      'check shadow-probe output texture format / usage',
    );
    if (!probeOutputViewResult.ok) throw probeOutputViewResult.error;
    shadowProbeOutputViewHandle = probeOutputViewResult.value;

    const probeStagingBufResult = runShimSyncStep(
      () =>
        rhiDevice.createBuffer({
          label: 'shadow-probe-staging',
          size: PROBE_READBACK_ROW_BYTES,
          usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
          mappedAtCreation: false,
        }),
      'webgpu-runtime-error',
      'createBuffer(shadow-probe staging) succeeded',
      'check device.limits.maxBufferSize',
    );
    if (!probeStagingBufResult.ok) throw probeStagingBufResult.error;
    shadowProbeStagingBufHandle = probeStagingBufResult.value;
  }

  // ── feat-20260520-2d-sprite-layer-mvp / M-3 / w24 ────────────────────────
  //
  // Sprite alpha-blend pipeline pair — LDR (`bgra8unorm-srgb` swap-chain
  // view) + HDR (`rgba16float` offscreen view; routed when active camera
  // carries `tonemap !== 'none'`, same as unlit/standard HDR siblings).
  //
  // @new-surface sprite alpha-blend pipeline (4th + 5th GPU render-pipeline
  // handles on PipelineState; the engine grows 5 -> 9 distinct pipelines:
  // unlit + standard + tonemap each existed before; sprite adds LDR + HDR).
  // The blend op is premultiplied alpha (charter P5 consistent abstraction
  // with the OpenGL / WebGPU industry default; sprite.wgsl fragment outputs
  // premultiplied RGB so srcFactor='one' / dstFactor='one-minus-src-alpha'
  // composes correctly).
  //
  // @reuses pipelineLayoutResult (the 4-BindGroupLayout chain shared with
  //   unlit / standard / pbr — view + material + meshArray + instances).
  // @reuses defaultSampler — sprite material BindGroup entries 3 + 5
  //   (metallicRoughnessSampler / normalSampler placeholders bound to
  //   `pipelineState.defaultSampler`; D-1 candidate b; zero new sampler
  //   created).
  // @reuses defaultWhiteTextureView — sprite material BindGroup entries
  //   4 + 6 (metallicRoughnessTexture / normalTexture placeholders bound
  //   to `pipelineState.defaultWhiteTextureView`; D-1 candidate b; the
  //   1x1 white view was already provisioned for unlit / standard fallback
  //   so the sprite path adds 0 lines of new GPU resource code, only
  //   binding references in render-system-record.ts w25).
  //   Sprite material BindGroup populates entries 0..2 with sprite's own
  //   uniform / sampler / texture, and entries 3..6 with
  //   pipelineState.defaultSampler + pipelineState.defaultWhiteTextureView
  //   (D-1 candidate b — zero new GPU resource; 4-line binding wiring lives
  //   in render-system-record.ts w25). The unused entries are physically
  //   bound to ensure WebGPU's BindGroupLayout congruence (declared in the
  //   shader at @binding 3..6 even though the sprite fragment never reads
  //   them; plan-strategy D-1 + sprite.wgsl JSDoc head).
  //
  // @derives unlit / standard LDR+HDR dual-pipeline structure (lines 2058-
  //   2147 above + 2174-2253 below). The sprite pair mirrors the unlit
  //   pair byte-for-byte except for:
  //     - module: spriteModule (vs unlitModule)
  //     - fragment.targets[0].blend: premultiplied alpha (vs no blend)
  //     - depthStencil.depthWriteEnabled: false (vs true)
  //     - depthStencil.depthCompare: 'less-equal' (vs 'less')
  //   The vertex stride stays 12F (HANDLE_QUAD passes through the same
  //   12-float interleaved layout as procedural meshes), so no new vertex
  //   pipeline branch is needed in the record stage (plan-strategy §3 RT4).
  //
  // Premultiplied alpha blend op (`{ srcFactor: 'one', dstFactor:
  // 'one-minus-src-alpha', operation: 'add' }`) is the industry-default for
  // sprite atlases; sprite.wgsl emits premultiplied RGB so the over-
  // composite math (`dst' = src + dst * (1 - src.a)`) is direct.
  // feat-20260615-pipeline-spec-ssot M2-T4: sprite pipelines are pre-warmed in
  // SPEC_CONST_TABLE (4 entries: LDR/HDR x S1/S4). Cache lookup replaces the
  // prior local-handle variables + createMsaaVariant closure.
  // The pre-existing sprite-build-failure defer-to-null semantics are now
  // handled by the boot-time SPEC_CONST pre-warm block above: if the sprite
  // module exists but the SPEC_CONST build fails, the fail-fast throw blocks
  // the engine from entering the first frame (charter P3: no silent fallback).
  // AI users who need sprite tolerance for lavapipe / dawn-vulkan validation
  // can skip SPEC_CONST entries at their own peril via a future M7 opt-out
  // gate; the current M2 contract is fail-fast.
  // feat-20260608-tilemap-object-layer-rendering M2 / m2-t6 (D-8): SPEC_CONST
  // sprite entries set cullMode='none' so H/V flip via negative scaleX/scaleY
  // (tilemap per-cell entity TRS form, D-1) does not get culled when winding
  // inverts. See pipeline-spec.ts sprite LDR S1/S4 + HDR S1/S4 entries.

  // ── feat-20260519-tonemap-reinhard-mvp / M2 / T-M2.5 ──────────────────────
  //
  // HDR variants of the unlit + standard pipelines (rgba16float colour
  // attachment instead of bgra8unorm-srgb) plus the post-process tonemap
  // pipeline + 3-entry BGL + sampler + 16 B params UBO. Routed by record-
  // stage when the active camera carries `tonemap !== 'none'` (AC-03(a) /
  // AC-11). Sharing the geometry shader modules across the sRGB + HDR
  // pipelines keeps the shader compile cost flat and the WGSL byte-for-byte
  // identical between the two routes — the only difference is the colour-
  // attachment format declaration in the fragment state target list (charter
  // P5 consistent abstraction; plan-strategy D-2 + D-3).
  //
  // bug-20260519 D-3 nullable extension: the HDR pipeline block is gated on
  // `pbrModule + unlitModule !== null` so the empty-manifest path skips every
  // device.create* call below and writes `null` into the corresponding
  // PipelineState fields. feat-20260621 M-A3 (D-5): the dedicated tonemap
  // pipeline / BGL / sampler / params-UBO handles are gone — the built-in
  // tonemap registers through the unified post-process channel (see the
  // `registerBuiltinTonemap` callback above; pipeline + BGL + sampler + UBO
  // are owned by dispatchFullscreenPass / postProcess.register).
  let fxaaPipelineHandle: RenderPipeline | null = null;
  let fxaaBglHandle: BindGroupLayout | null = null;
  let fxaaSamplerHandle: Sampler | null = null;
  let skyboxPipelineHandle: RenderPipeline | null = null;
  let skyboxBglHandle: BindGroupLayout | null = null;
  let skyboxSamplerHandle: Sampler | null = null;
  let skyboxPipelineMsaaHandle: RenderPipeline | null = null;
  // feat-20260531-bloom-first-declarative-render-graph-pass / w13:
  // bloom pipeline handles (D-1, D-4, D-6). Bright + 2x blur (H/V per-axis)
  // + 1x composite = 4 pipelines. Blur H/V share the same WGSL module but
  // are separate pipelines with per-axis texelSize baked at creation (D-1).
  // All 4 use rgba16float target format (D-6).
  let bloomBrightPipelineHandle: RenderPipeline | null = null;
  let bloomBlurHPipelineHandle: RenderPipeline | null = null;
  let bloomBlurVPipelineHandle: RenderPipeline | null = null;
  let bloomCompositePipelineHandle: RenderPipeline | null = null;
  let bloomBrightBglHandle: BindGroupLayout | null = null;
  let bloomBlurBglHandle: BindGroupLayout | null = null;
  let bloomCompositeBglHandle: BindGroupLayout | null = null;
  let bloomSamplerHandle: Sampler | null = null;
  let bloomBrightParamsBufferHandle: Buffer | null = null;
  let bloomBlurParamsBufferHandle: Buffer | null = null;
  let bloomCompositeParamsBufferHandle: Buffer | null = null;
  // feat-20260612-hdrp-ssao M6 / w26 + w43: SSAO pipeline handles (D-A).
  // calc + blur RenderPipeline pair sharing a dedicated 6-entry BGL.
  // Optional — null when manifest lacks hdrp-ssao entry.
  let ssaoCalcPipelineHandle: RenderPipeline | null = null;
  let ssaoBlurPipelineHandle: RenderPipeline | null = null;
  let ssaoBglHandle: BindGroupLayout | null = null;
  if (unlitModule !== null && pbrModule !== null) {
    // feat-20260615-pipeline-spec-ssot M2-T4: unlit/standard HDR pipeline
    // variants are pre-warmed in SPEC_CONST_TABLE (4 entries: unlit/standard
    // HDR x S1/S4). Cache lookup replaces prior local-handle variables.
    // The fxaa / skybox / bloom / SSAO fullscreen pipelines below
    // are NOT in SPEC_CONST_TABLE and remain boot-time lazy-built here.
    // feat-20260621 M-A3 (D-5): tonemap is no longer built here — it registers
    // through the unified post-process channel (registerBuiltinTonemap).

    // feat-20260528-fxaa-post-processing M2 / w10: FXAA pipeline prebuilt.
    // When the manifest contains the fxaa entry (rgb2luma marker, D-5),
    // construct the 2-entry BGL (texture + sampler, no UBO per D-2),
    // pipeline layout, fullscreen render pipeline (vertex = fullscreen
    // triangle from fxaa.wgsl, fragment = FXAA 3.11 algorithm), and
    // linear clamp-to-edge sampler. Mirrors the tonemap pipeline
    // construction pattern directly above.
    if (fxaaModule !== null) {
      // FXAA BindGroupLayout: 2 entries (texture + sampler, no UBO).
      // D-2: the fxaa.wgsl fragment stage declares @binding(0) texture_2d<f32>
      // + @binding(1) sampler.
      const fxaaBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
            label: 'fxaa-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' },
              },
            ],
          }),
        'webgpu-runtime-error',
        'createBindGroupLayout(fxaa) succeeded',
        'check device.limits.maxBindGroupsPerPipelineLayout',
      );
      if (!fxaaBglResult.ok) throw fxaaBglResult.error;
      fxaaBglHandle = fxaaBglResult.value;

      const fxaaPipelineLayoutResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'fxaa-pl',
            bindGroupLayouts: [fxaaBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(fxaa) succeeded',
        'verify fxaa BindGroupLayout matches shader @group(0) bindings',
      );
      if (!fxaaPipelineLayoutResult.ok) throw fxaaPipelineLayoutResult.error;

      // M2-T4: FXAA pipeline via getOrBuildPipeline (lazy-build, not in SPEC_CONST_TABLE).
      // Color-space contract: FXAA writes bgra8unorm (NON-srgb) storage format.
      // Lazy-build via cache miss on first access.
      {
        const fxaaSpec: PipelineSpec = {
          shader: { id: 'forgeax::post::fxaa', passKind: 'post-process', variantSet: undefined },
          attachments: {
            colorFormats: [swapChainFormats.storage],
            depthFormat: undefined,
            sampleCount: 1,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = {
          vertex: fxaaModule,
          fragment: fxaaModule,
          layout: fxaaPipelineLayoutResult.value,
        };
        try {
          fxaaPipelineHandle = getOrBuildPipeline(
            fxaaSpec,
            pipelineDeviceProvider,
            pipelineCache,
            modules,
          ) as RenderPipeline;
        } catch (err) {
          if (err instanceof PipelineSpecError) throw err;
          throw new PipelineSpecError({
            code: 'pipeline-build-failed',
            detail: { cause: err },
            hint: 'createRenderPipeline (fxaa fullscreen) failed; inspect gpuMessage',
          });
        }
      }

      // FXAA sampler: linear filter + clamp-to-edge. Clamp-to-edge
      // prevents edge bleed when sampling at the screen extents.
      const fxaaSamplerResult = runShimSyncStep(
        () =>
          rhiDevice.createSampler({
            label: 'fxaa-sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        'webgpu-runtime-error',
        'createSampler (fxaa) succeeded',
        'check device.limits.maxSamplersPerShaderStage',
      );
      if (!fxaaSamplerResult.ok) throw fxaaSamplerResult.error;
      fxaaSamplerHandle = fxaaSamplerResult.value;
    }

    // feat-20260531-skybox-env-background M3 / w15: skybox pipeline prebuilt.
    // When the manifest contains the skybox entry (skybox_fs marker, D-7),
    // construct the 3-entry BGL (texture_cube + sampler + View UBO),
    // pipeline layout, fullscreen render pipeline (vertex = fullscreen
    // triangle from skybox.wgsl, fragment = cubemap sample + write HDR),
    // and linear clamp-to-edge sampler. Mirrors tonemap/fxaa construction
    // pattern. Skybox writes to hdrColor rgba16float, NOT to the swap-chain
    // (plan-strategy D-2: tonemap pass reads hdrColor and maps to LDR).
    if (skyboxModule !== null) {
      const skyboxBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
            label: 'skybox-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float', viewDimension: 'cube' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' },
              },
              {
                binding: 2,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' },
              },
            ],
          }),
        'webgpu-runtime-error',
        'createBindGroupLayout(skybox) succeeded',
        'check device.limits.maxBindGroupsPerPipelineLayout',
      );
      if (!skyboxBglResult.ok) throw skyboxBglResult.error;
      skyboxBglHandle = skyboxBglResult.value;

      const skyboxPipelineLayoutResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'skybox-pl',
            bindGroupLayouts: [skyboxBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(skybox) succeeded',
        'verify skybox BindGroupLayout matches shader @group(0) bindings',
      );
      if (!skyboxPipelineLayoutResult.ok) throw skyboxPipelineLayoutResult.error;

      // Skybox pipeline writes to hdrColor rgba16float render target (NOT
      // M2-T4: skybox pipeline via getOrBuildPipeline + SPEC_CONST_TABLE pre-warm.
      // Skybox HDR S1 + S4 entries are in SPEC_CONST_TABLE. Register module with
      // layout + fragmentEntryPoint 'skybox_fs'. The S1 variant is built via
      // getOrBuildPipeline; MSAA S4 variant catches failure gracefully (same as
      // pre-M2 behavior: warn + fire error, set handle to null).
      shaderModuleMap.set('forgeax::skybox::cube', {
        vertex: skyboxModule,
        fragment: skyboxModule,
        fragmentEntryPoint: 'skybox_fs',
        layout: skyboxPipelineLayoutResult.value,
      });
      // S1 (non-MSAA)
      {
        const skyboxSpec: PipelineSpec = {
          shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
          attachments: {
            colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
            depthFormat: undefined,
            sampleCount: 1,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = shaderModuleMap.get('forgeax::skybox::cube');
        if (modules === undefined) throw new Error('expected skybox module in shaderModuleMap');
        skyboxPipelineHandle = getOrBuildPipeline(
          skyboxSpec,
          pipelineDeviceProvider,
          pipelineCache,
          modules,
        ) as RenderPipeline;
      }
      // S4 (MSAA variant — graceful failure, same as pre-M2)
      {
        const skyboxMsaaSpec: PipelineSpec = {
          shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
          attachments: {
            colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
            depthFormat: undefined,
            sampleCount: 4,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = shaderModuleMap.get('forgeax::skybox::cube');
        if (modules === undefined) throw new Error('expected skybox module in shaderModuleMap');
        try {
          skyboxPipelineMsaaHandle = getOrBuildPipeline(
            skyboxMsaaSpec,
            pipelineDeviceProvider,
            pipelineCache,
            modules,
          ) as RenderPipeline;
        } catch (msaaErr) {
          // The MSAA variant is a graceful-degradation path -- console.warn is the
          // canonical signal for "feature degrades, not fails" (noConsole allows warn).
          console.warn(
            `[forgeax] skybox MSAA pipeline variant build failed at renderer init; ` +
              `non-MSAA skybox unaffected. (cause: ${String(msaaErr)})`,
          );
          // PipelineSpecError carries the underlying cause in `.detail.cause`;
          // the warn above already surfaces the message.
          skyboxPipelineMsaaHandle = null;
        }
      }

      // Skybox sampler: filterable (linear/linear/clamp). Clamp-to-edge
      // prevents seam artifacts at cubemap face boundaries.
      const skyboxSamplerResult = runShimSyncStep(
        () =>
          rhiDevice.createSampler({
            label: 'skybox-sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        'webgpu-runtime-error',
        'createSampler (skybox) succeeded',
        'check device.limits.maxSamplersPerShaderStage',
      );
      if (!skyboxSamplerResult.ok) throw skyboxSamplerResult.error;
      skyboxSamplerHandle = skyboxSamplerResult.value;
    }

    // feat-20260531-bloom-first-declarative-render-graph-pass / w13:
    // bloom pipeline assembly (D-1, D-4, D-6). Assembled inside the
    // (unlit+pbr+tonemap) gate for rhiDevice access but bloom modules
    // are optional — each guard is independent. When bloom modules are
    // absent (legacy manifest), handles stay null and execute closures
    // skip the bloom passes entirely (zero-overhead opt-out).
    //
    // Pipeline roster:
    //   bloom-bright  : 1-tex + sampler + UBO@2 BGL, rgba16float target
    //   bloom-blur-h  : same BGL, same module as blur-v, H-axis texelSize
    //   bloom-blur-v  : same BGL, same module as blur-h, V-axis texelSize
    //   bloom-composite: 2-tex + sampler + UBO@3 BGL, rgba16float target

    // Shared bloom sampler: linear filter + clamp-to-edge (all 4 passes
    // sample from textures using fullscreen triangle UVs).
    if (bloomBrightModule !== null || bloomBlurModule !== null || bloomCompositeModule !== null) {
      const bloomSamplerResult = runShimSyncStep(
        () =>
          rhiDevice.createSampler({
            label: 'bloom-sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        'webgpu-runtime-error',
        'createSampler (bloom) succeeded',
        'check device.limits.maxSamplersPerShaderStage',
      );
      if (!bloomSamplerResult.ok) throw bloomSamplerResult.error;
      bloomSamplerHandle = bloomSamplerResult.value;
    }

    // Bloom bright: 1-tex + sampler + UBO@2 BGL (D-4).
    if (bloomBrightModule !== null && bloomSamplerHandle !== null) {
      const brightBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
            label: 'bloom-bright-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' },
              },
              {
                binding: 2,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' },
              },
            ],
          }),
        'webgpu-runtime-error',
        'createBindGroupLayout(bloom-bright) succeeded',
        'check device.limits.maxBindGroupsPerPipelineLayout',
      );
      if (!brightBglResult.ok) throw brightBglResult.error;
      bloomBrightBglHandle = brightBglResult.value;

      const brightPlResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'bloom-bright-pl',
            bindGroupLayouts: [brightBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(bloom-bright) succeeded',
        'verify bloom-bright BindGroupLayout matches shader @group(0) bindings',
      );
      if (!brightPlResult.ok) throw brightPlResult.error;

      // M2-T4: bloom-bright pipeline via getOrBuildPipeline (lazy-build).
      {
        const brightSpec: PipelineSpec = {
          shader: {
            id: 'forgeax::post::bloom-bright',
            passKind: 'post-process',
            variantSet: undefined,
          },
          attachments: {
            colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
            depthFormat: undefined,
            sampleCount: 1,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = {
          vertex: bloomBrightModule,
          fragment: bloomBrightModule,
          layout: brightPlResult.value,
        };
        try {
          bloomBrightPipelineHandle = getOrBuildPipeline(
            brightSpec,
            pipelineDeviceProvider,
            pipelineCache,
            modules,
          ) as RenderPipeline;
        } catch (err) {
          if (err instanceof PipelineSpecError) throw err;
          throw new PipelineSpecError({
            code: 'pipeline-build-failed',
            detail: { cause: err },
            hint: 'createRenderPipeline (bloom-bright fullscreen) failed; inspect gpuMessage',
          });
        }
      }

      // Bright params UBO: 16 B std140 (threshold f32 + 12 B pad).
      const brightParamsResult = runShimSyncStep(
        () =>
          rhiDevice.createBuffer({
            label: 'bloom-bright-params-ubo',
            size: BRIGHT_PARAMS_BYTES,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          }),
        'webgpu-runtime-error',
        'createBuffer (bloom-bright params UBO) succeeded',
        'check device.limits.maxUniformBufferBindingSize',
      );
      if (!brightParamsResult.ok) throw brightParamsResult.error;
      bloomBrightParamsBufferHandle = brightParamsResult.value;
    }

    // Bloom blur H/V: same BGL (1-tex + sampler + UBO@2), same module,
    // two separate pipelines with per-axis texelSize (D-1, D-4).
    if (bloomBlurModule !== null && bloomSamplerHandle !== null) {
      const blurBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
            label: 'bloom-blur-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' },
              },
              {
                binding: 2,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' },
              },
            ],
          }),
        'webgpu-runtime-error',
        'createBindGroupLayout(bloom-blur) succeeded',
        'check device.limits.maxBindGroupsPerPipelineLayout',
      );
      if (!blurBglResult.ok) throw blurBglResult.error;
      bloomBlurBglHandle = blurBglResult.value;

      const blurPlResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'bloom-blur-pl',
            bindGroupLayouts: [blurBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(bloom-blur) succeeded',
        'verify bloom-blur BindGroupLayout matches shader @group(0) bindings',
      );
      if (!blurPlResult.ok) throw blurPlResult.error;

      // M2-T4: bloom-blur H/V pipelines via getOrBuildPipeline (lazy-build).
      // H and V share the same PSO descriptor — only per-axis texelSize UBO
      // distinguishes them at record time. getOrBuildPipeline cache-hit on the
      // second call returns the same handle (identical spec, identical PSO).
      {
        const blurSpec: PipelineSpec = {
          shader: {
            id: 'forgeax::post::bloom-blur',
            passKind: 'post-process',
            variantSet: undefined,
          },
          attachments: {
            colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
            depthFormat: undefined,
            sampleCount: 1,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = {
          vertex: bloomBlurModule,
          fragment: bloomBlurModule,
          layout: blurPlResult.value,
          label: 'bloom-blur-h-pipeline',
        };
        try {
          bloomBlurHPipelineHandle = getOrBuildPipeline(
            blurSpec,
            pipelineDeviceProvider,
            pipelineCache,
            modules,
          ) as RenderPipeline;
        } catch (err) {
          if (err instanceof PipelineSpecError) throw err;
          throw new PipelineSpecError({
            code: 'pipeline-build-failed',
            detail: { cause: err },
            hint: 'createRenderPipeline (bloom-blur-h fullscreen) failed; inspect gpuMessage',
          });
        }
        // V is cache-hit on the same spec (identical PSO; per-axis UBO differentiates at record time).
        bloomBlurVPipelineHandle =
          bloomBlurHPipelineHandle as unknown as typeof bloomBlurVPipelineHandle;
      }

      // Blur params UBO: 16 B std140 (texelSize.xy + radius + pad).
      const blurParamsResult = runShimSyncStep(
        () =>
          rhiDevice.createBuffer({
            label: 'bloom-blur-params-ubo',
            size: BLUR_PARAMS_BYTES,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          }),
        'webgpu-runtime-error',
        'createBuffer (bloom-blur params UBO) succeeded',
        'check device.limits.maxUniformBufferBindingSize',
      );
      if (!blurParamsResult.ok) throw blurParamsResult.error;
      bloomBlurParamsBufferHandle = blurParamsResult.value;
    }

    // Bloom composite: 2-tex + sampler + UBO@3 BGL (D-4, D-5).
    if (bloomCompositeModule !== null && bloomSamplerHandle !== null) {
      const compositeBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
            label: 'bloom-composite-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
              },
              {
                binding: 2,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' },
              },
              {
                binding: 3,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' },
              },
            ],
          }),
        'webgpu-runtime-error',
        'createBindGroupLayout(bloom-composite) succeeded',
        'check device.limits.maxBindGroupsPerPipelineLayout',
      );
      if (!compositeBglResult.ok) throw compositeBglResult.error;
      bloomCompositeBglHandle = compositeBglResult.value;

      const compositePlResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'bloom-composite-pl',
            bindGroupLayouts: [compositeBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(bloom-composite) succeeded',
        'verify bloom-composite BindGroupLayout matches shader @group(0) bindings',
      );
      if (!compositePlResult.ok) throw compositePlResult.error;

      // M2-T4: bloom-composite pipeline via getOrBuildPipeline (lazy-build).
      {
        const compositeSpec: PipelineSpec = {
          shader: {
            id: 'forgeax::post::bloom-composite',
            passKind: 'post-process',
            variantSet: undefined,
          },
          attachments: {
            colorFormats: [HDR_COLOR_ATTACHMENT_FORMAT],
            depthFormat: undefined,
            sampleCount: 1,
          },
          geometry: {
            topology: 'triangle-list',
            stripIndexFormat: undefined,
            vertexLayout: {},
          },
          renderState: { cullMode: 'none' },
        };
        const modules = {
          vertex: bloomCompositeModule,
          fragment: bloomCompositeModule,
          layout: compositePlResult.value,
        };
        try {
          bloomCompositePipelineHandle = getOrBuildPipeline(
            compositeSpec,
            pipelineDeviceProvider,
            pipelineCache,
            modules,
          ) as RenderPipeline;
        } catch (err) {
          if (err instanceof PipelineSpecError) throw err;
          throw new PipelineSpecError({
            code: 'pipeline-build-failed',
            detail: { cause: err },
            hint: 'createRenderPipeline (bloom-composite fullscreen) failed; inspect gpuMessage',
          });
        }
      }

      // Composite params UBO: 16 B std140 (intensity f32 + 12 B pad).
      const compositeParamsResult = runShimSyncStep(
        () =>
          rhiDevice.createBuffer({
            label: 'bloom-composite-params-ubo',
            size: COMPOSITE_PARAMS_BYTES,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          }),
        'webgpu-runtime-error',
        'createBuffer (bloom-composite params UBO) succeeded',
        'check device.limits.maxUniformBufferBindingSize',
      );
      if (!compositeParamsResult.ok) throw compositeParamsResult.error;
      bloomCompositeParamsBufferHandle = compositeParamsResult.value;
    }

    // ── feat-20260612-hdrp-ssao M6 / w26 + w43 + M8 / w37 ───────────────────
    //
    // SSAO post-processing chain: 2 passes (calc + blur) with a dedicated
    // 9-entry BGL matching hdrp-ssao.wgsl @group(0) bindings 0-8 (D-A + D-D).
    // Both pipelines share the same BGL (calc binds 0-6, blur binds 7-8 +
    // reuses the 256B uniform write); the WGSL declares all entries even when
    // a given pass leaves some unused, so wgpu/dawn pipeline-layout matching
    // is one-shot.
    //
    // w37 dawn-blocker fix (carry from w27-a): pre-M8 the BGL had a single
    // sampler at binding 3 typed 'filtering' that paired with the depth
    // texture at binding 5. WebGPU requires depth textures to be sampled with
    // a non-filtering / comparison sampler — the mismatch crashed every HDRP
    // PSO build on dawn (7 dawn tests red unrelated to SSAO itself).
    // ssao_depth_sampler at binding 6 (non-filtering) is dedicated to
    // hdr_depth; the existing filtering sampler at binding 3 stays for the
    // float noise / gbuffer_normal textures.
    //
    // Fullscreen triangle vertex (vs_ssao), R8 scalar fragment output. Cull
    // none, no depth/stencil (fullscreen post-process pass).
    if (ssaoModule !== null) {
      // Dedicated SSAO BGL: 9 entries (bindings 0-8 per current WGSL).
      //   0 = uniform (SsaoUniform 256B)
      //   1 = storage (kernel SSBO)
      //   2 = texture_2d (noise)
      //   3 = sampler (filtering, for noise / normal float textures)
      //   4 = texture_2d (gbuffer_normal)
      //   5 = texture_depth_2d (hdrDepth)
      //   6 = sampler (non-filtering, dedicated to depth)  -- w37
      //   7 = texture_2d (ssaoRaw, blur input)             -- w37
      //   8 = sampler (filtering, for ssaoRaw)             -- w37
      const ssaoBglResult = runShimSyncStep(
        () =>
          rhiDevice.createBindGroupLayout({
            label: 'ssao-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'read-only-storage' },
              },
              {
                binding: 2,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                // hdrp-ssao-noise is rgba32float; without the
                // float32-filterable extension this format is unfilterable.
                // The ssao-data noise generator uses NEAREST/REPEAT sampling
                // so unfilterable-float is sufficient and works on dawn.
                texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
              },
              {
                binding: 3,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                // The noise sampler (binding 2 + 4) must be non-filtering
                // because binding 2 is unfilterable-float. WebGPU validation
                // pairs sampler 'filtering' kind with filterable textures
                // only; using non-filtering for the noise + gbuffer_normal
                // path keeps both samples valid.
                sampler: { type: 'non-filtering' },
              },
              {
                binding: 4,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
              },
              {
                binding: 5,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d' },
              },
              {
                binding: 6,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'non-filtering' },
              },
              {
                binding: 7,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
              },
              {
                binding: 8,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                // Shared with binding 3 (single sampler resource); both BGL
                // entries must declare the same sampler-type kind.
                sampler: { type: 'non-filtering' },
              },
            ],
          }),
        'webgpu-runtime-error',
        'createBindGroupLayout(ssao) succeeded',
        'check device.limits.maxBindGroupsPerPipelineLayout',
      );
      if (!ssaoBglResult.ok) throw ssaoBglResult.error;
      ssaoBglHandle = ssaoBglResult.value;

      const ssaoPipelineLayoutResult = runShimSyncStep(
        () =>
          rhiDevice.createPipelineLayout({
            label: 'ssao-pl',
            bindGroupLayouts: [ssaoBglResult.value],
          }),
        'webgpu-runtime-error',
        'createPipelineLayout(ssao) succeeded',
        'verify SSAO BindGroupLayout matches shader @group(2) bindings',
      );
      if (!ssaoPipelineLayoutResult.ok) throw ssaoPipelineLayoutResult.error;

      // M2-T4: SSAO calc + blur pipelines via getOrBuildPipeline (lazy-build).
      // Different fragment entry points distinguish calc (fs_ssao_calc) from
      // blur (fs_ssao_blur); distinct synthetic shader IDs ensure correct cache
      // key separation (same module, different entry points → different PSOs).
      {
        const layout = ssaoPipelineLayoutResult.value;
        const baseModules = {
          vertex: ssaoModule,
          fragment: ssaoModule,
          vertexEntryPoint: 'vs_ssao',
          layout,
        };
        // SSAO calc
        {
          const calcSpec: PipelineSpec = {
            shader: {
              id: 'forgeax::post::ssao-calc',
              passKind: 'post-process',
              variantSet: undefined,
            },
            attachments: {
              colorFormats: ['r8unorm' as unknown as GPUTextureFormat],
              depthFormat: undefined,
              sampleCount: 1,
            },
            geometry: {
              topology: 'triangle-list',
              stripIndexFormat: undefined,
              vertexLayout: {},
            },
            renderState: { cullMode: 'none' },
          };
          try {
            ssaoCalcPipelineHandle = getOrBuildPipeline(
              calcSpec,
              pipelineDeviceProvider,
              pipelineCache,
              { ...baseModules, fragmentEntryPoint: 'fs_ssao_calc' },
            ) as RenderPipeline;
          } catch (err) {
            if (err instanceof PipelineSpecError) throw err;
            throw new PipelineSpecError({
              code: 'pipeline-build-failed',
              detail: { cause: err },
              hint: 'createRenderPipeline (ssao-calc fullscreen) failed; inspect gpuMessage',
            });
          }
        }
        // SSAO blur
        {
          const blurSpec: PipelineSpec = {
            shader: {
              id: 'forgeax::post::ssao-blur',
              passKind: 'post-process',
              variantSet: undefined,
            },
            attachments: {
              colorFormats: ['r8unorm' as unknown as GPUTextureFormat],
              depthFormat: undefined,
              sampleCount: 1,
            },
            geometry: {
              topology: 'triangle-list',
              stripIndexFormat: undefined,
              vertexLayout: {},
            },
            renderState: { cullMode: 'none' },
          };
          try {
            ssaoBlurPipelineHandle = getOrBuildPipeline(
              blurSpec,
              pipelineDeviceProvider,
              pipelineCache,
              { ...baseModules, fragmentEntryPoint: 'fs_ssao_blur' },
            ) as RenderPipeline;
          } catch (err) {
            if (err instanceof PipelineSpecError) throw err;
            throw new PipelineSpecError({
              code: 'pipeline-build-failed',
              detail: { cause: err },
              hint: 'createRenderPipeline (ssao-blur fullscreen) failed; inspect gpuMessage',
            });
          }
        }
      }
    }
  }

  // feat-20260601-gpu-resource-store-extraction M1 (D-9 sub-contract 1): prewarm
  // the mipmap pipeline cache for the smoke texture formats while still on the
  // async `renderer.ready` path. This builds the one-time mipmap shader module +
  // per-format pipeline into the deviceCache so the record-stage texture
  // ensureResident (sync) reproduces the pre-extraction async uploadTexture
  // byte-for-byte without an async stall in the synchronous draw frame. A build
  // failure here is surfaced through ready's reject channel (structured RhiError).
  //
  // Gated on `manifestEntries.length > 0` (the same Camera-only / clear-pass
  // skip as the Step-2 pipeline compile, bug-20260519 D-3): a zero-manifest
  // world renders no material geometry, so no texture is ever made resident and
  // the mipmap shader-module build (a `createShaderModule` call) must not fire
  // -- preserving the zero-manifest "0 createShaderModule" invariant
  // (renderer-ready.test.ts AC-02).
  if (manifestEntries.length > 0) {
    const prewarmRes = await gpuStore.prewarmMipmapPipeline(
      rhiDevice as unknown as Parameters<GpuResourceStore['prewarmMipmapPipeline']>[0],
      MIPMAP_PREWARM_FORMATS,
    );
    if (!prewarmRes.ok) throw prewarmRes.error;
  }

  return {
    // feat-20260518-pbr-direct-lighting-mvp M5 / w22.10 (AC-06 dual->triple
    // pipeline + D-2 + D-10): three distinct GPU render-pipeline handles
    // backed by 2 distinct shader modules (unlit + pbr) x 2 vertex stride
    // configurations (6F builtin + 12F procedural; the 6F + pbr combination
    // does not exist per D-2). All three share the identical 4-BindGroupLayout
    // chain so material BG entries built once compose for any of the three
    // pipelines (charter P5 consistent abstraction). The legacy `pipeline`
    // alias field has been retired; consumers select per
    // (mat.shadingModel, mesh.layout) tuple via the record-stage three-way
    // setPipeline branch (w22.11).
    // bug-20260519: BUILTIN cube migrated to 12F so the legacy
    // `unlitBuiltinPipeline` (+ its zero-stride `unlitBuiltinDummyAttrBuffer`)
    // is gone; consumers pick per `mat.shadingModel` only via the record-stage
    // 2-way `setPipeline` branch.
    // feat-20260615-pipeline-spec-ssot M2-T4: standard material PSOs are
    // pre-warmed in SPEC_CONST_TABLE and cached in pipelineCache. Cache
    // lookup replaces the prior local-handle variables (SSOT axiom D-12).
    // feat-20260615-pipeline-spec-ssot M2-T4: standard material PSOs are
    // pre-warmed in SPEC_CONST_TABLE and cached in pipelineCache. Cache
    // lookup replaces the prior local-handle variables (SSOT axiom D-12).
    // lookupSpecInTable resolves entries by (shaderId, isHdr, sampleCount);
    // null when the spec entry's module was not compiled (empty-manifest path).
    // (see definition near SPEC_CONST boot-time pre-warm block above)
    unlitPipeline: getCachedPipelineOrNull('forgeax::default-unlit', false, 1),
    standardPipeline: getCachedPipelineOrNull('forgeax::default-standard-pbr', false, 1),
    unlitPipelineMsaa: getCachedPipelineOrNull('forgeax::default-unlit', false, 4),
    standardPipelineMsaa: getCachedPipelineOrNull('forgeax::default-standard-pbr', false, 4),
    spritePipelineMsaa: getCachedPipelineOrNull('forgeax::default-sprite', false, 4),
    spritePipelineHdrMsaa: getCachedPipelineOrNull('forgeax::default-sprite', true, 4),
    unlitPipelineHdrMsaa: getCachedPipelineOrNull('forgeax::default-unlit', true, 4),
    standardPipelineHdrMsaa: getCachedPipelineOrNull('forgeax::default-standard-pbr', true, 4),
    // feat-20260523-shader-template-instance-split M9-T03 (D-PipelineBuilder):
    // expose the shared pbr/unlit/sprite pipeline layout so the per-
    // MaterialShader pipeline cache callback (createRenderer.ts
    // getMaterialShaderPipeline) can reuse it at lazy build time without
    // re-running pbrLayouts construction. `null` when the manifest is empty
    // (Camera-only path; bug-20260519 D-3 nullable parallel to the unlit /
    // standard pipeline fields above).
    pbrPipelineLayout:
      unlitModule !== null && pbrModule !== null ? pipelineLayoutResult.value : null,
    // feat-20260609-hdrp-cluster-fragment-ggx M4.5 / w36 (D-10 option A):
    // HDRP-variant PipelineLayout (4-BGL chain with HDRP unified 7-slot
    // group(2) BGL substituted for the URP 1-slot mesh-array BGL). Built
    // at boot above (see hdrpPbrPipelineLayoutHandle); gated on the same
    // unlit/pbr module presence as `pbrPipelineLayout` so Camera-only and
    // empty-manifest paths see null on both fields. Selected per call by
    // `selectPipelineLayoutForVariant` based on the caller's variantSet.
    hdrpPbrPipelineLayout:
      unlitModule !== null && pbrModule !== null ? hdrpPbrPipelineLayoutHandle : null,
    // bug-20260611-skin-pipeline-layout: skin-variant PipelineLayout (4-BGL
    // chain with 2-entry mesh-array BGL substituted for the standard 1-entry
    // mesh-array BGL). Built at boot above (see pbrSkinPipelineLayoutHandle);
    // gated on the same unlit/pbr module presence so Camera-only and empty-
    // manifest paths see null. Selected per call by
    // `selectPipelineLayoutForVariant` when the caller passes
    // `LayoutKind = 'pbr-skin'`.
    pbrSkinPipelineLayout:
      unlitModule !== null && pbrModule !== null ? pbrSkinPipelineLayoutHandle : null,
    // feat-20260611 R2 / M8 / w28 (IS-14): record-stage skin BG plumbing.
    // Mirror the gating used by `pbrSkinPipelineLayout` -- both fields
    // come from the same `buildPbrSkinLayouts` call so they live or die
    // together. Surfaced on PipelineState so render-system-record can
    // build a 2-binding BG matching `pbr-skin-pl` (was: 1-binding
    // `pbr-mesh-bg` + `pbr-mesh-array-bgl`, which the device rejected
    // every frame with `Bind group layout pbr-skin-mesh-array-bgl ... does
    // not match layout pbr-mesh-array-bgl` + Invalid CommandBuffer +
    // queue-submit-failed).
    pbrSkinMeshBindGroupLayout:
      unlitModule !== null && pbrModule !== null ? pbrSkinMeshBindGroupLayoutHandle : null,
    // feat-20260612-skin-palette-per-frame-upload M1 / m1-2: animator-ready
    // skin-palette allocator (replaces the prior identity-buffer stub).
    // Same gating as `pbrSkinPipelineLayout` -- `null` when the skin
    // pipeline-layout build itself failed.
    skinPaletteAllocator:
      unlitModule !== null && pbrModule !== null ? skinPaletteAllocatorHandle : null,
    // feat-20260520-2d-sprite-layer-mvp M-3 / w24 (@new-surface): sprite
    // alpha-blend pipeline pair — LDR (bgra8unorm-srgb) + HDR
    // (rgba16float). The record stage routes sprite-bucket entities here
    // when the active camera carries `tonemap === 'none'` (LDR) or
    // `tonemap !== 'none'` (HDR; M-3 / w25). `null` on legacy 3-tuple
    // manifests; the record stage narrows on `=== null` and reports
    // through the structured RhiError surface (charter P3 explicit failure).
    spritePipeline: getCachedPipelineOrNull('forgeax::default-sprite', false, 1),
    spritePipelineHdr: getCachedPipelineOrNull('forgeax::default-sprite', true, 1),
    meshes: meshHandles,
    format: swapChainFormats.storage,
    colorAttachmentFormat: swapChainFormats.view,
    viewBindGroupLayout: viewBglResult.value,
    materialBindGroupLayout: materialBglResult.value,
    meshBindGroupLayout: meshArrayBglResult.value,
    viewUniformBuffer: viewUboResult.value,
    shadowCasterCascadeBuffer: shadowCasterCascadeUboResult.value,
    // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 /
    // T-M2-05: PipelineState now references the wrapper objects owned by
    // `meshSsboController.state`. Outer wrapper-object identity is stable
    // across grow (research §F8 R1) so these field references never go
    // stale; the inner `.buffer` is mutated in place when growMeshSsbo
    // rebuilds the pair. PipelineState field types are widened to
    // `{ buffer: Buffer; sizeInBytes: number }` in T-M2-06 to match.
    materialUniformBuffer: meshSsboState.material,
    meshStorageBuffer: meshSsboState.mesh,
    pointLightsBuffer: pointLightsBufferResult.value,
    spotLightsBuffer: spotLightsBufferResult.value,
    instancesBindGroupLayout: instancesBglResult.value,
    identityInstanceBuffer: identityInstanceResult.value,
    defaultSampler: defaultSamplerResult.value,
    nearestSampler: nearestSamplerResult.value,
    fallbackTextureView: fallbackTextureViewResult.value,
    // feat-20260518 M3 / w13: the 1x1 white textureView aliases
    // `fallbackTextureView` since both serve the same purpose (default-
    // texture seed for missing sampler / texture binding entries). The
    // alias keeps the new code path declarative without duplicating the
    // GPU resource (charter F2 minimal surface).
    defaultWhiteTextureView: fallbackTextureViewResult.value,
    // Normal-slot fallback view (1x1 RGBA8 (128,128,255,255)). RG=(128,128)
    // decodes to tangent (0,0,1) under pbr.wgsl's RG-only normal decoder.
    // Distinct from defaultWhiteTextureView because RG=(255,255)=1.0 gives
    // sqrt(1 - 1 - 1) = NaN, breaking the no-normal-map case.
    defaultNormalTextureView: fallbackNormalTextureViewResult.value,
    // feat-20260519-tonemap-reinhard-mvp M2 / T-M2.5: HDR variants of the
    // unlit + standard pipelines (rgba16float colour attachment).
    unlitPipelineHdr: getCachedPipelineOrNull('forgeax::default-unlit', true, 1),
    standardPipelineHdr: getCachedPipelineOrNull('forgeax::default-standard-pbr', true, 1),
    // feat-20260520-directional-light-shadow-mapping M2 / w14 (D-1):
    // 1x1 depth32float fallback bound at viewBindGroup binding(3).
    shadowFallbackTextureView: shadowFallbackViewResult.value,
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 1x1x6
    // depth32float cube_array fallback bound at viewBindGroup binding(5)
    // when no PointLightShadow snapshots are active. Always-present
    // (24 B GPU footprint); ShadowAtlas takes over when a real frame has
    // pointShadowSnapshots.length > 0.
    shadowAtlasFallbackTextureView: shadowAtlasFallbackViewResult.value,
    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: 64 B point
    // shadow params UBO bound at viewBindGroup binding(6). Written per
    // frame from `frameState.pointShadowSnapshots`.
    shadowParamsBuffer: shadowParamsBufferResult.value,
    // feat-20260520-directional-light-shadow-mapping M2 / w15 (AC-12):
    // shadow-factor probe pipeline + supporting GPU resources. All fields
    // null when the shader manifest is empty (no shaders -> no probe).
    shadowProbePipeline: shadowProbePipelineHandle,
    shadowProbeBindGroupLayout: shadowProbeBindGroupLayoutHandle,
    shadowProbeLsmUbo: shadowProbeLsmUboHandle,
    shadowProbeInputBuf: shadowProbeInputBufHandle,
    shadowProbeOutputTex: shadowProbeOutputTexHandle,
    shadowProbeOutputView: shadowProbeOutputViewHandle,
    shadowProbeStagingBuf: shadowProbeStagingBufHandle,
    // feat-20260520-skylight-ibl-cubemap M2 round-4 / t40 amend
    // (plan-strategy D-5 round-4 REVISED): fallback Skylight identity
    // resource bundle wired in alongside the other PipelineState fields.
    // M4 record stage will narrow on `!== null`, then feed these handles
    // through `assembleMaterialWithSkylightEntries` to populate material
    // BG entries 7..13 when skylightCount === 0 (no stand-alone bg).
    skylightFallback,
    // feat-20260529-rendergraph-pass-abstraction M3 / w11 (D-2 + Finding 3):
    // per-pass mutable resource slots moved to PerPassResources.
    perPassResources: {
      depthTexture: null,
      depthTextureView: null,
      depthTextureWidth: 0,
      depthTextureHeight: 0,
      configured: false,
      hdrColorTexture: null,
      hdrColorView: null,
      hdrDepthTexture: null,
      hdrDepthView: null,
      hdrTextureWidth: 0,
      hdrTextureHeight: 0,
      hdrDepthSampleCount: 1,
      fxaaPipeline: fxaaPipelineHandle,
      fxaaBindGroupLayout: fxaaBglHandle,
      fxaaSampler: fxaaSamplerHandle,
      fxaaIntermediateTexture: null,
      fxaaIntermediateView: null,
      fxaaIntermediateWidth: 0,
      fxaaIntermediateHeight: 0,
      fxaaBindGroup: null,
      // feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w7: MSAA
      // attachment slots. All null/0 until the first antialias='msaa' frame.
      msaaColorTexture: null,
      msaaColorView: null,
      msaaSpriteColorTexture: null,
      msaaSpriteColorView: null,
      msaaDepthTexture: null,
      msaaDepthView: null,
      msaaTextureWidth: 0,
      msaaTextureHeight: 0,
      hdrColorMsaaTexture: null,
      hdrColorMsaaView: null,
      skyboxPipeline: skyboxPipelineHandle,
      skyboxPipelineMsaa: skyboxPipelineMsaaHandle,
      skyboxBindGroupLayout: skyboxBglHandle,
      skyboxSampler: skyboxSamplerHandle,
      skyboxBindGroup: null,
      shadowTexture: null,
      shadowMapSize: 0,
      shadowCascadeCount: 0,
      shadowSampler: shadowSamplerResult.value,
      shadowLightSpaceMatrix: null,
      shadowCsmLightViewProj: null,
      // feat-20260531-bloom-first-declarative-render-graph-pass / w13 + w16:
      // bloom per-pass resource slots. Pipeline handles assembled during
      // buildReadyWebGPU (marker-triage + compile + createRenderPipeline).
      // Intermediate textures are allocate in the execute closures at 1/2-res
      // (ensureLazyTexture, slot width/height tracking for size-drift rebuild).
      // BindGroup caches survive until the intermediate view is invalidated
      // by a resize (width/height drift forces null).
      bloomBrightPipeline: bloomBrightPipelineHandle,
      bloomBlurHPipeline: bloomBlurHPipelineHandle,
      bloomBlurVPipeline: bloomBlurVPipelineHandle,
      bloomCompositePipeline: bloomCompositePipelineHandle,
      bloomBrightBindGroupLayout: bloomBrightBglHandle,
      bloomBlurBindGroupLayout: bloomBlurBglHandle,
      bloomCompositeBindGroupLayout: bloomCompositeBglHandle,
      bloomSampler: bloomSamplerHandle,
      bloomBrightParamsBuffer: bloomBrightParamsBufferHandle,
      bloomBlurParamsBuffer: bloomBlurParamsBufferHandle,
      bloomCompositeParamsBuffer: bloomCompositeParamsBufferHandle,
      bloomBrightTexture: null,
      bloomBrightView: null,
      bloomBrightWidth: 0,
      bloomBrightHeight: 0,
      bloomBlurHTexture: null,
      bloomBlurHView: null,
      bloomBlurHWidth: 0,
      bloomBlurHHeight: 0,
      bloomBlurVTexture: null,
      bloomBlurVView: null,
      bloomBlurVWidth: 0,
      bloomBlurVHeight: 0,
      bloomBrightBindGroup: null,
      bloomBlurHBindGroup: null,
      bloomBlurVBindGroup: null,
      bloomCompositeBindGroup: null,
      // feat-20260612-hdrp-ssao M6 / w26 + M8 / w38: SSAO pipeline slots.
      ssaoCalcPipeline: ssaoCalcPipelineHandle,
      ssaoBlurPipeline: ssaoBlurPipelineHandle,
      ssaoBgl: ssaoBglHandle,
      // M8 / w38: lazy-allocated on first SSAO record frame. Sampler kinds
      // and the 1x1 ssaoRaw fallback view are constant across frames and
      // cached after first construction.
      ssaoFilteringSampler: null,
      ssaoDepthSampler: null,
      ssaoFallbackRawView: null,
      ssaoCalcBindGroup: null,
      ssaoBlurBindGroup: null,
    },
  };
}

/**
 * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21
 * (plan-strategy D-3 method A): wrap a thrown sub-step value into a
 * structured `RhiError` with a stable `code` so the dispose cascade can
 * fan out the failure through `errorRegistry.fire` without losing the
 * cause string. Each step's wrapper carries the step name so AI users
 * inspecting `err.hint` see which sub-step failed.
 */
function wrapDisposeError(cause: unknown, step: string): RhiError {
  if (cause instanceof RhiError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: `${step} completes during Renderer.dispose() without throwing`,
    hint: `dispose sub-step '${step}' threw: ${message}; cascade continues to subsequent steps`,
  });
}

function ensureContextConfigured(
  internals: WebGPURendererInternals,
  state: PipelineState,
  errorRegistry: RhiErrorListenerRegistry,
): void {
  if (state.perPassResources.configured) return;
  // M6 / w41 (feat-20260510-rhi-resource-creation): configure goes through
  // the forgeax `RhiCanvasContext` surface; the shim resolves the forgeax
  // RhiDevice back to the underlying raw GPUDevice via RAW_DEVICE_MAP
  // internally so the spec slot still gets a valid raw handle while AI-user-
  // facing code only sees the RHI surface (charter proposition 5).
  // The configure descriptor (WebGL2-fallback gate: storage-cap proxy ->
  // sRGB view format + usage bits) is the shared SSOT `configureSurface`
  // (render-system.ts), also used by the F2 surface-outdated reconfigure
  // branch so the two cannot drift (architecture-principles #1 SSOT).
  const cfgResult = configureSurface(
    internals.context,
    internals.device,
    state.format,
    state.colorAttachmentFormat,
  );
  if (!cfgResult.ok) {
    errorRegistry.fire(cfgResult.error);
    return;
  }
  state.perPassResources.configured = true;
  // bug-20260612: write the actually-configured swap-chain storage format
  // to a globalThis probe so AC-02 / AC-03 verification (Playwright
  // page.evaluate / vitest browser project) can read the value without
  // needing an Inspector RPC roundtrip or a yet-unimplemented
  // canvasContext.getConfiguration(). Always-on (single string property,
  // no runtime cost); naming aligns with existing globalThis.__forgeax*
  // counters (smoke-camera-pose probe lineage). View format is the
  // `${storage}-srgb` partner — derived, not duplicated.
  (globalThis as { __forgeaxSwapChainFormat?: GPUTextureFormat }).__forgeaxSwapChainFormat =
    state.format as unknown as GPUTextureFormat;
}

/**
 * Convert a synchronous RHI shim call that may throw a non-RhiError exception
 * into the canonical `Result<T, RhiError>` shape. AI users `await
 * renderer.ready` and consume `.code` / `.expected` / `.hint` regardless of
 * whether the underlying shim returned `Result.err` directly or threw a raw
 * Error (charter proposition 4 explicit failure baseline).
 */
function runShimSyncStep<T>(
  fn: () => Result<T, RhiError>,
  fallbackCode:
    | 'shader-compile-failed'
    | 'webgpu-runtime-error'
    | 'queue-write-buffer-out-of-bounds',
  expected: string,
  hint: string,
): Result<T, RhiError> {
  try {
    return fn();
  } catch (caught) {
    if (caught instanceof RhiError) {
      return err(caught);
    }
    const detail = caught instanceof Error ? caught.message : String(caught);
    return err(
      new RhiError({
        code: fallbackCode,
        expected,
        hint: `${hint} (cause: ${detail})`,
      }),
    );
  }
}

/** Async variant of `runShimSyncStep`. */
async function runShimStep<T>(
  fn: () => Promise<Result<T, RhiError>>,
  fallbackCode: 'shader-compile-failed' | 'webgpu-runtime-error',
  expected: string,
  hint: string,
): Promise<Result<T, RhiError>> {
  try {
    return await fn();
  } catch (caught) {
    if (caught instanceof RhiError) {
      return err(caught);
    }
    const detail = caught instanceof Error ? caught.message : String(caught);
    return err(
      new RhiError({
        code: fallbackCode,
        expected,
        hint: `${hint} (cause: ${detail})`,
      }),
    );
  }
}

// ─── Animation system wiring (M1 / T-19) ─────────────────────────────────

/**
 * Create an AnimationAssetResolver backed by an AssetRegistry.
 *
 * Resolves raw handle numbers (from AnimationPlayer.clip) to AnimationClip
 * assets by looking them up in the asset registry's internal map.
 */
export function createAnimationAssetResolver(assets: AssetRegistry | null): AnimationAssetResolver {
  // feat-20260614 M8 (D-15 / D-17): AnimationClip handles are user-tier column
  // slots resolved through the per-World SharedRefStore via resolveAssetHandle;
  // the AssetRegistry holds no handle map. `assets` is retained in the signature
  // for call-site stability but is no longer the resolution source.
  void assets;
  return {
    resolveAnimationClip(world: World, handleRaw: number): AnimationClip | undefined {
      const lookup = resolveAssetHandle(
        world,
        handleRaw as unknown as Handle<'AnimationClip', 'shared'>,
      );
      if (!lookup.ok) return undefined;
      const asset = lookup.value as unknown as { kind?: string };
      if (asset.kind !== 'animation-clip') return undefined;
      return lookup.value as AnimationClip;
    },
  };
}
