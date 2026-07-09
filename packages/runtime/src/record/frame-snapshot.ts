// @forgeax/engine-runtime - RenderSystem record stage: frame-snapshot.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import { vec3 } from '@forgeax/engine-math';

/**
 * feat-20260708-composited-multi-world-rendering M1 / D-1 / D-9:
 * worldId-entityKey composite key helper. Formula: `worldId * 2^32 + entityKey`.
 *
 * worldId is the index into `worlds[]` (the `draw` call argument). entityKey
 * is the packed Entity u32 (encodeEntity(indexSlot, generation)) surfaced
 * through `RenderableSnapshot.entityKey`.
 *
 * Key properties:
 *   - worldId=0 identity: `worldEntityKey(0, k) === k` — single-world path
 *     cache behavior is bit-for-bit unchanged (AC-03 regression guarantee).
 *   - JS safe integer: worldId < 2^21 keeps the composite key below
 *     Number.MAX_SAFE_INTEGER (2^53).
 *   - SSOT: all cache-key compositing consumers import this single helper;
 *     no inline `worldId * 2^32 + k` duplication (D-9).
 *
 * @internal — exported for unit test + glyph/tilemap/record consumers;
 * not part of the public @forgeax/engine-runtime API surface.
 */
export function worldEntityKey(worldId: number, entityKey: number): number {
  return worldId * 4294967296 + entityKey; // 2^32 = 4294967296
}

import type { RenderGraph } from '@forgeax/engine-render-graph';
import type { BindGroup } from '@forgeax/engine-rhi';
import type { MaterialRenderState, RenderPipelineAsset } from '@forgeax/engine-types';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import type { RenderPipeline as RenderPipelineDef } from '../render-pipeline';
import type { RenderPipelineContext } from '../render-pipeline-context';
import type { MeshGpuHandles } from '../render-system';
import type {
  CameraSnapshot,
  DispatchEntry,
  PointShadowSnapshot,
  RenderableSnapshot,
  SpotLightSnapshot,
} from '../render-system-extract';
import type { ShadowAtlas } from '../shadow-atlas';

/**
 * feat-20260608-create-app-param-surface-trim / M1 / D-8 (q8 user lock):
 * fallback clear color when the world carries no Camera entity. Opaque
 * black `[0, 0, 0, 1]`, replacing the historical
 * `[0.06, 0.06, 0.08, 1.0]` dark-slate sentinel. Single SSOT consumed by
 * the synthetic CameraSnapshot built when `cameras.length === 0`
 * (Case B in `recordFrame`) and read directly by tests
 * (`zero-camera-clear-fallback.test.ts`). AC-05.
 */
export const ZERO_CAMERA_CLEAR_FALLBACK: readonly [number, number, number, number] = [0, 0, 0, 1];

/**
 * Build a synthetic CameraSnapshot the record stage uses when the world
 * carries no Camera entity. Identity-shaped projection / view inputs
 * keep the existing matrix math numerically stable; clear-color quartet
 * sourced from `ZERO_CAMERA_CLEAR_FALLBACK` so the swap-chain still
 * paints `[0, 0, 0, 1]` (AI-user friendly observable signal that the
 * `'render-system-no-camera'` diagnostic fired without leaving stale
 * pixels on screen).
 */
export function makeZeroCameraFallbackSnapshot(): CameraSnapshot {
  // Identity world mat4 so `mat4.invert(world)` yields identity view.
  const identityWorld = new Float32Array(16);
  identityWorld[0] = 1;
  identityWorld[5] = 1;
  identityWorld[10] = 1;
  identityWorld[15] = 1;
  return {
    position: vec3.create(0, 0, 0),
    world: identityWorld,
    fov: Math.PI / 4,
    aspect: 1,
    near: 0.1,
    far: 100,
    // feat-20260613 M6 / w20: synthetic camera defaults to perspective so
    // the CSM extract path stays consistent with the previously-implicit
    // perspective shape (unchanged behavior; explicit field).
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1.0,
    whitePoint: 4.0,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1.0,
    bloomIntensity: 1.0,
    bloomBlurRadius: 4.0,
    clearR: ZERO_CAMERA_CLEAR_FALLBACK[0],
    clearG: ZERO_CAMERA_CLEAR_FALLBACK[1],
    clearB: ZERO_CAMERA_CLEAR_FALLBACK[2],
    clearA: ZERO_CAMERA_CLEAR_FALLBACK[3],
  };
}

// feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t2
// (D-7): host-clamp the merged DirectionalLight's pcfKernelSize to the nearest
// valid odd kernel in {1,3,5} before it reaches the View UBO float [128].
// lighting-directional.wgsl runs a constant-trip-count loop to MAX_PCF_HALF=2
// (merged 5.3-production-shadow-demos AC-14 variant-free pattern) and clips each
// iteration to half = (pcfKernelSize-1)/2, so the supported kernel set is
// {1,3,5} (cap 5). undefined (no shadow fields) defaults to 3.
export function clampPcfKernelSize(value: number | undefined): number {
  if (value === undefined) return 3;
  if (value <= 1) return 1;
  if (value <= 3) return 3;
  return 5;
}

/**
 * Per-RenderSystem mutable frame state.
 *
 * Owned by the `createRenderSystem` closure; advanced once per
 * `recordFrame` invocation. The `instanceBuffers` map holds the per-entity
 * GPU storage buffers for Instances-bearing entities (cache key = the
 * packed Entity u32 surfaced via `InstancesSnapshot.cacheKey`); entries
 * are recreated when the `archVersion` bumps or `byteLength` changes.
 *
 * feat-20260518-pbr-direct-lighting-mvp M3 / w14 (AC-17 a): the
 * `warnedZeroLightStandard` flag latches the first-frame warning that
 * fires when the world contains a StandardMaterial entity but zero
 * DirectionalLight entries — once latched the next 100 frames suppress
 * the warning so the AI user is not flooded with repeated noise (charter
 * P3 silent failure -> explicit warning at most once per RenderSystem
 * lifetime).
 */
export interface RenderFrameState {
  frameNumber: number;
  /**
   * feat-20260529-rendergraph-pass-abstraction M4 / w13c fix: the per-frame
   * render graph is structurally static (the 4 pass execute fns are module-
   * level, the resource declarations never change, and caps.backendKind is
   * stable per device). Build + compile it ONCE and reuse the compiled graph
   * across frames -- re-constructing `new RenderGraph()` + compile() every
   * frame added allocation/GC jitter that intermittently perturbed the async
   * IBL-warmup timing (ibl-irradiance smoke meanAbsDelta flake). `execute`
   * still receives a fresh per-frame RenderPipelineContext, so behaviour is
   * unchanged; only the topology build is hoisted out of the hot path.
   */
  perFrameGraph: RenderGraph<RenderPipelineContext> | null;
  readonly instanceBuffers: Map<number, InstanceBufferCacheEntry>;
  warnedZeroLightStandard: boolean;
  /**
   * feax-20260608-multi-light-warn-once M3: once-warn latch for multi-light
   * overrun per bucket (directional N>1 / point N>4 / spot N>4). Fires at
   * most once per RenderSystem lifetime per bucket so AI users see a single
   * actionable console.warn without per-frame flooding (charter P3 explicit
   * failure: warn-once preserves signal/noise floor).
   */
  warnedMultiLightDirectional: boolean;
  warnedMultiLightPoint: boolean;
  warnedMultiLightSpot: boolean;
  /**
   * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
   * once-warn latches for >1 Skylight / >1 SkyboxBackground entity. Fire at most
   * once per RenderSystem lifetime so the multi-entity warn (which names the
   * winning entity handle, F-8) does not flood the console every frame.
   */
  warnedMultiSkylight: boolean;
  warnedMultiSkybox: boolean;
  /** feat-20260531-skybox-env-background M3 / w20: once-warn when camera
   * tonemap is 'none' but a SkyboxBackground entity exists. Skybox needs
   * the HDR render target allocated by the tonemap path; without it the
   * skybox pass is skipped (plan-strategy D-2 NOTE). */
  warnedSkyboxTonemapNone: boolean;
  /**
   * Per-handle warn-once anchor for the missing baseColor-texture fallback,
   * shared by every textured material path (sprite / sprite-lit / standard-pbr
   * / pbr-skin / unlit — feat-20260520-2d-sprite-layer-mvp M-3 / w25 seeded it
   * for sprites; feat-future-pbr-missing-texture-fallback-explicit generalised
   * it to PBR/skin so GLB textures that fail to reach the GPU no longer render
   * silently flat). A `Set<number>` keyed by the raw Handle<TextureAsset> id -
   * the writer fires `console.warn` exactly once per missing texture handle per
   * RenderSystem lifetime so AI users see a single actionable message without
   * per-frame log flooding. The set lives across frames so the second frame on
   * the same missing handle stays silent (charter P3 explicit failure:
   * warn-once preserves signal / noise floor while structured RhiError below
   * stays per-frame fire).
   *
   * Note on the WeakSet/Set choice: plan-strategy mentions WeakSet but
   * Handle values are numeric brand u32s (not object references), so
   * WeakSet<object> is not applicable; Set<number> gives identical
   * warn-once-per-handle semantics at zero additional cost (charter F1
   * minimal surface; the per-RenderSystem lifetime cap is the upper
   * bound).
   */
  readonly warnedMissingBaseColorTextureHandles: Set<number>;
  /**
   * feat-20260527-sprite-nineslice M2 / w11 + M4 / w16 (AC-16): once-per-
   * renderable guard for the `nineslice.scale-too-small` metric increment.
   * Keyed by `renderableIndex` so the second frame on the same mis-scaled
   * entity does NOT keep bumping the counter — AI users see one counter
   * tick per offending entity per RenderSystem lifetime, matching the
   * single-event semantics of the structured fail-fast (charter P3:
   * machine-readable signal, not a per-frame inflation). M4 retired the
   * placeholder console.warn; the increment lands on the per-Renderer
   * EngineMetrics through `runtime.metrics.increment(...)`.
   */
  readonly warnedNineSliceScaleEntities: Set<number>;
  /**
   * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
   * per-handle fire-once anchor for the lazy equirect-to-cubemap projection
   * failure. A `Set<number>` keyed by the raw Handle<EquirectAsset> id - the
   * record arm fires the structured `EquirectProjectionFailedError` exactly
   * once per failed source per RenderSystem lifetime (the store records
   * `status:'failed'` permanently and never retries, R-2 / AC-09; without this
   * latch the record arm would re-fire the error every frame). The set lives
   * across frames so the second frame on the same failed handle stays silent
   * (charter P3: warn-once preserves signal / noise floor).
   */
  readonly firedEquirectProjectionFailedHandles: Set<number>;
  /**
   * feat-20260622-handle-to-id-allocator-elimination M1 / w3: per-frame
   * bind group caches converted to nested WeakMap chain roots (D-3).
   * Each root is a WeakMap<object, WeakMap<...>> walked by
   * getOrCreateFromChain; the chain depth varies by variant
   * (view-main = 7, mesh = 1, hdrp-unified = 5, skin = 2).
   * The root WeakMap is init-time stable — never cleared, no eviction.
   * Chain keys are always inner buffer handles, never wrappers (D-3).
   */
  readonly viewBindGroupCache: WeakMap<object, unknown>;
  readonly meshBindGroupCache: WeakMap<object, unknown>;
  /**
   * feat-20260622-handle-to-id-allocator-elimination M1 / w2: per-entity
   * bind group caches scoped by entityKey (packed u32 as number).
   * Outer Map<number, WeakMap<handle, ...>> lets GC collect entries for
   * destroyed entities whose handles are unreachable; per-entity material
   * and instances share the same two-level shape (D-1). The inner WeakMap
   * value is opaque (`unknown`) because `getOrCreateFromChain` walks a
   * variable-depth chain — intermediate handles map to nested WeakMaps and
   * only the final handle maps to the variant->BindGroup leaf Map. Direct
   * readers (HDRP shadow-instances read end) assert the leaf shape locally.
   */
  /**
   * feat-20260708-composited-multi-world-rendering M1 / D-1a #2: outer Map
   * keyed by `worldEntityKey(worldId, entityKey)`. Inner WeakMap unchanged.
   */
  readonly materialBgPerEntity: Map<number, WeakMap<object, unknown>>;
  /**
   * feat-20260708-composited-multi-world-rendering M1 / D-1a #3: outer Map
   * keyed by `worldEntityKey(worldId, entityKey)`. Inner WeakMap unchanged.
   */
  readonly instancesBgPerEntity: Map<number, WeakMap<object, unknown>>;
  /**
   * feat-20260622-handle-to-id-allocator-elimination M1 / w2: cross-entity
   * shared material bind group cache (OQ-1 option A). Outer key is the
   * material shaderId string; inner chain is a WeakMap keyed by the same
   * handle objects used in per-entity chains. Reuses the generic
   * `getOrCreatePerEntity` helper with outerKey string|number (D-1).
   */
  readonly materialBgShared: Map<string, WeakMap<object, unknown>>;
  /**
   * feat-20260622-handle-to-id-allocator-elimination M1 / w2: singleton
   * material bind group cache (D-6). Single flat Map<variant, BindGroup>
   * for the one true singleton in production: shadow-material-singleton.
   * shadow-instances-singleton is a test fixture fiction (research F3);
   * no second singleton field is needed.
   */
  readonly singletonMaterialCache: Map<string, BindGroup>;
  /**
   * feat-20260601-customizable-render-pipeline-seam M1 / w7: the raw u32 handle of the
   * currently installed RenderPipelineAsset (0 = none installed). `installPipeline` sets
   * it; `draw` compares it against the handle the memoized `perFrameGraph` was last built
   * for and, on change (pipeline swap), nulls `perFrameGraph` to force a rebuild. Effect
   * toggles (camera.bloom early-return inside a pass closure) do NOT change this handle,
   * so they never trigger a rebuild (requirements edge case: only a SWAP rebuilds).
   */
  installedPipelineHandle: number;
  /**
   * feat-20260601-customizable-render-pipeline-seam M1 / w7: the active RenderPipeline
   * impl resolved from the registry by `installPipeline`. recordFrame calls
   * `activePipeline.buildGraph(ctx, data)` when the memoized graph needs (re)building.
   * Defaults to the built-in forgeax::urp pipeline.
   */
  activePipeline: RenderPipelineDef;
  /**
   * feat-20260601-customizable-render-pipeline-seam verify round 2: the
   * `RenderPipelineAsset.config` of the currently installed pipeline asset.
   * `installPipeline` stores it alongside `activePipeline` / `installedPipelineHandle`;
   * `recordFrame` projects it onto `RenderPipelineData.config` so a pipeline's `buildGraph`
   * reads its install-time config at topology-build time. `undefined` when the installed
   * asset declared no `config` (the standard forward pipeline always installs with config
   * undefined). Without this field `config.passCount` was a silent no-op (config was dropped
   * at the seam); threading it makes one-logic-N-configs observably distinct (AC-03).
   */
  installedPipelineConfig: RenderPipelineAsset['config'];
  /**
   * feat-20260608-cluster-lighting M2 / w10: HDRP active flag.
   * True iff the currently installed RenderPipelineAsset has
   * `pipelineId === 'forgeax::hdrp'`. URP-only code paths gate on
   * `!isHdrpActive` so HDRP demos do not double-count light contributions.
   */
  isHdrpActive: boolean;
  /**
   * feat-20260608-cluster-lighting M5 / w20 + M6 / w23 + M5 / w22:
   * once-per-frame fire dedup set for HDRP per-frame fail-soft errors
   * (`hdrp-light-budget-exceeded`, `hdrp-index-list-overflow`). Cleared
   * at the end of each frame so the next frame re-fires if the condition
   * persists. Set<string> keyed by RuntimeErrorCode literal.
   */
  hdrpOncePerFrameFired: Set<string>;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1).
   * Lazily-allocated cube_array shadow atlas owned by the RenderSystem
   * lifetime. `null` until the first frame whose `lights.pointShadow` is
   * non-empty (zero-shadow scenes never allocate; AC-09). The atlas is
   * disposed by the renderer dispose path; subsequent frames with a non-empty
   * snapshot list re-allocate.
   */
  pointShadowAtlas: ShadowAtlas | null;
  /**
   * feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-3):
   * per-frame projection of `lights.pointShadow` from the extract stage. The
   * graph closure for the point shadow caster pass reads this list to drive
   * the 6 x N face iteration; `recordFrame` writes it before `graph.execute`.
   * Empty array on frames with no shadow-casting point lights — the URP
   * `addPointShadowPass` is gated at `buildGraph` time on the snapshot count
   * being non-zero (AC-09 zero-shadow zero-pass).
   */
  pointShadowSnapshots: readonly PointShadowSnapshot[];
  /**
   * feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1):
   * last fold-pass output, computed at `recordFrame` entry from the
   * transparent-sort-ordered dispatch + mode-gate (D-5: only mode 0
   * folds; other modes yield singleton buckets). Currently an
   * observational compute — the drawIndexed swap (1 instanced draw per
   * fold bucket) is the follow-on integration that wires each bucket
   * into the sprite-pass / geometry-pass dispatch loops. The bucket
   * count is the source of truth for `render.instancing.foldedDraws`
   * metric (M3 / w13) — every fold-eligible bucket (bucketSize >= 1
   * under mode 0 AND not bypassed) contributes one increment.
   */
  lastFoldBucketCount: number;
  /**
   * feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): per-frame projection
   * of `lights.spot` from the extract stage. The URP `addSpotShadowPass` graph
   * closure (`recordSpotShadowPass`) reads this list to render each
   * castShadow spot's perspective depth into its `spotShadowDepth` atlas tile
   * (viewport keyed on `shadowAtlasTile`). `recordFrame` writes it before
   * `graph.execute`. Spots with `shadowAtlasTile < 0` (castShadow:false,
   * degenerate direction, or clipped beyond cap 4) are skipped — zero
   * shadow-casting spots means zero spot shadow passes (AC-03).
   */
  spotShadowSnapshots: readonly SpotLightSnapshot[];
}

/**
 * feat-20260518-pbr-direct-lighting-mvp M5 / w22.11 (D-2 + D-10 + AC-06):
 * mutable per-frame dispatch counter object owned by `createRenderSystem`
 * and bumped here at the actual `pass.setPipeline(...)` call site (the
 * only point with both `mat.materialShaderId` and `mesh.layout` in scope).
 * Unlit / custom shader pipeline dispatch tracked here.
 */
export interface DispatchCounts {
  unlit: number;
  /** feat-20260523 M4-T07: 'standard' counter removed; schema-driven
   *  materials are tracked via materialShaderId in the pipeline cache. */
}

/**
 * feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
 * createBindGroup counter. Closure-mutable object aligned with
 * DispatchCounts precedent. Reset in draw(world) entry, bumped on
 * cache-miss createBindGroup calls (M2-M4).
 */
export interface BindGroupCounts {
  createBindGroup: number;
  /**
   * Debug-only: records the variant of every cache-miss BindGroup created via
   * `getOrCreateFromChain` for unit-test observability. Production paths do
   * not read this array.
   */
  keys: string[];
}

/**
 * A renderable resolved against the AssetRegistry for the current frame:
 * its source snapshot, the GPU mesh handles, the row index used to correlate
 * transparent-sort output back to this entry, and an optional per-material
 * renderState override (bug-20260527-renderstate-pipeline-dispatch-gap D-4).
 * Module-scoped so RenderPipelineContext can type `validated` / `validatedOrdered`
 * without `any` (was a recordFrame-local interface before F-4).
 */
export interface ValidatedRenderable {
  readonly source: RenderableSnapshot;
  readonly mesh: MeshGpuHandles;
  readonly renderableIndex: number;
  readonly renderState: MaterialRenderState | undefined;
  /**
   * w10: per-pass stencil reference value folded from
   * {@link DispatchEntry.stencilReference} (draw-call dynamic state). The draw
   * loop calls `pass.setStencilReference(stencilReference ?? 0)` before each
   * draw; `undefined` falls back to the WebGPU default 0 (semantic no-op).
   */
  readonly stencilReference: number | undefined;
}
