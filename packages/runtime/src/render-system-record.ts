// @forgeax/engine-runtime - RenderSystem Prepare + Record stages.
//
// SSBO single-branch architecture: every renderable issues a per-entity
// `drawIndexed(indexCount, instanceCount, ...)`. When the entity carries an
// `Instances` component the record stage uploads the packed mat4 transforms
// from the ECS-managed `array<f32>` field to a per-entity GPU storage
// buffer (cached by entity packed u32; reallocated on archetype version
// bump) and binds it at @group(3) with `instances.instanceCount`; when the
// entity does not, the shared identity-mat4 fallback storage buffer is
// bound with `instanceCount === 1`. Both paths run through the same shader
// (entity_world * instances_local[instance_index]).
//
// `entity_world` mat4 is uploaded per-renderable to
// `pipelineState.meshStorageBuffer` at slot `i * MESH_PER_ENTITY_STRIDE`
// (256-byte alignment for dynamic-offset binding); the mesh BGL was
// flipped to `hasDynamicOffset: true` in T-M3-2.
//
// Material UBO retains the per-entity dynamic-offset path (OOS-02 ownership
// in `feat-future-render-world`).
//
// feat-20260513-instanced-mesh M5 (T-M5-1 + T-M5-3) supersede:
//   - Legacy per-frame entity-count cap fail-fast block removed.
//   - The `LimitExceededDetail` field reshape ({ maxStorageBufferBindingSize,
//     requestedBytes }) anchored the new sole emit point at
//     `AssetRegistry.createInstancedBuffer`.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15
// supersede:
//   - `AssetRegistry.createInstancedBuffer` / `updateInstancedBuffer` /
//     `getInstancedGpuBuffer` triplet removed; `InstancedBufferAsset` POD
//     deleted. Per-entity instance transforms now live inside the ECS via
//     the `Instances { transforms: 'array<f32>' }` component (D-1
//     component-level stride 16 declared on the defineComponent options
//     arg). The record stage owns GPU storage buffer allocation +
//     `LimitExceededDetail` emit (against
//     `device.limits.maxStorageBufferBindingSize`) and the cap-gate
//     against `device.caps.storageBuffer` (D-5 cap-gate: backends
//     lacking storage buffer support emit `RhiError 'feature-not-enabled'`).

import type { World } from '@forgeax/engine-ecs';
import { type Mat4, mat3, mat4, vec3 } from '@forgeax/engine-math';
import type { RenderGraph, ResolveContext } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupEntry,
  type Buffer,
  type CommandBuffer,
  type RenderPipeline,
  type RhiCanvasContext,
  type RhiCommandEncoder,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import type {
  Handle,
  MaterialRenderState,
  MeshAsset,
  PassSelector,
  RenderPipelineAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { derive, toShared } from '@forgeax/engine-types';
import { bin } from './cluster-binner';
import {
  HdrpIndexListOverflowError,
  HdrpLightBudgetExceededError,
  PointShadowAtlasBoundsViolationError,
  PointShadowAtlasUninitializedError,
  ShadowDisabledByMissingComponentError,
  SkyboxCubemapNotReadyError,
} from './errors';
import { GpuBuffer } from './gpu-resource';
import type { GpuResourceStore } from './gpu-resource-store';
import {
  createHdrpUnifiedBindGroup,
  getOrCreateHdrpBuffers,
  packClusterUniform,
} from './hdrp-buffers';
import { LIGHT_INDEX_LIST_CAPACITY } from './hdrp-pipeline';
import { getOrCreateIblCache } from './ibl/IblPipelineCache';
import {
  assembleMaterialWithSkylightEntries,
  type EmissiveAoBindGroupResources,
} from './ibl/skylight-bind-group';
import type { InstanceBufferCacheEntry } from './instance-buffer-cache';
import {
  LIGHT_ARRAY_HEADER_BYTES,
  LIGHT_ARRAY_MAX_SLOTS,
  POINT_LIGHT_STD430_BYTES,
  packLightArrayHeader,
  packLightSlot,
  packPointLight,
  packSpotLight,
  SPOT_LIGHT_STD430_BYTES,
} from './light-buffer-layout';
import { SKIN_MATERIAL_SHADER_ID } from './pbr-pipeline';
import { buildBeginRenderPassDescriptor } from './pipeline-spec';
import type { RenderPipeline as RenderPipelineDef } from './render-pipeline';
import type {
  _InternalRenderPipelineContext,
  RenderPipelineContext,
  RenderPipelineData,
} from './render-pipeline-context';
import {
  type MeshGpuHandles,
  type PipelineState,
  type RenderSystemInternals,
  type RenderSystemRuntime,
  STANDARD_PBR_UBO_SIZE,
} from './render-system';
import type {
  CameraSnapshot,
  DirectionalLightSnapshot,
  DispatchEntry,
  ExtractedLights,
  MaterialSnapshot,
  PointShadowSnapshot,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from './render-system-extract';
import { resolveAssetHandle } from './resolve-asset-handle';
import { ShadowAtlas } from './shadow-atlas';
import { getOrCreateSsaoBuffers } from './ssao-buffers';
import { matchPass } from './systems/pass-selector';

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
function makeZeroCameraFallbackSnapshot(): CameraSnapshot {
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
   * feat-20260520-directional-light-shadow-mapping verify round 1 fix
   * (AC-04 + AC-22): once-warn latch for shadow disabled by missing
   * component. Fire at most once per RenderSystem lifetime.
   */
  warnedShadowDisabled: boolean;
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
  /** feat-20260531-skybox-env-background M3 / w20: once-warn when camera
   * tonemap is 'none' but a SkyboxBackground entity exists. Skybox needs
   * the HDR render target allocated by the tonemap path; without it the
   * skybox pass is skipped (plan-strategy D-2 NOTE). */
  warnedSkyboxTonemapNone: boolean;
  /**
   * Per-handle warn-once anchor for the sprite-bucket missing-texture
   * fallback (feat-20260520-2d-sprite-layer-mvp M-3 / w25; @fallback +
   * AC-18 path (4)). A `Set<number>` keyed by the raw Handle<TextureAsset>
   * id - the sprite bucket fires `console.warn` exactly once per missing
   * texture handle per RenderSystem lifetime so AI users see a single
   * actionable message without per-frame log flooding. The set lives
   * across frames so the second frame on the same missing handle stays
   * silent (charter P3 explicit failure: warn-once preserves signal /
   * noise floor while structured RhiError below stays per-frame fire).
   *
   * Note on the WeakSet/Set choice: plan-strategy mentions WeakSet but
   * Handle values are numeric brand u32s (not object references), so
   * WeakSet<object> is not applicable; Set<number> gives identical
   * warn-once-per-handle semantics at zero additional cost (charter F1
   * minimal surface; the per-RenderSystem lifetime cap is the upper
   * bound).
   */
  readonly warnedMissingSpriteTextureHandles: Set<number>;
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
   * feat-20260531-per-frame-bind-group-cache M2 / w7: per-frame bind group
   * caches. Keyed by variant discriminator + ordered handle-id sequence;
   * hit returns the cached BindGroup from a previous frame, miss calls
   * device.createBindGroup and stores the result. viewBindGroupCache
   * covers both main (#1) and shadow (#3) variants (distinct keys per D-2).
   */
  readonly viewBindGroupCache: Map<string, BindGroup>;
  readonly meshBindGroupCache: Map<string, BindGroup>;
  /**
   * feat-20260531-per-frame-bind-group-cache M3 / w12: per-entity material
   * and instances bind group caches. Keyed by variant discriminator +
   * entityKey + ordered handle-id sequence (D-2 handle-set keys). Cache
   * fields use 'BgCache' suffix to avoid collision with the banned
   * identifier 'materialBindGroup' (check-render-record-no-opaque-order-
   * zero-material.mjs grep gate).
   */
  readonly materialBgCache: Map<string, BindGroup>;
  readonly instancesBgCache: Map<string, BindGroup>;
  /**
   * M2 / w7: maps each opaque RHI handle object (Buffer / TextureView /
   * Sampler) to a sequential numeric id. A single shared counter per
   * RenderFrameState (stable across the RenderSystem lifetime) so the same
   * GPU resource always maps to the same id. Used by getOrCreateBindGroup
   * to build deterministic cache keys from object handles.
   */
  readonly handleToId: WeakMap<object, number>;
  nextHandleId: number;
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
}

/**
 * Stride between per-renderable `entity_world` mat4 slots inside the
 * shared `pipelineState.meshStorageBuffer`. The 256-byte alignment is
 * required because the storage buffer is bound with
 * `hasDynamicOffset: true` and WebGPU spec
 * `minStorageBufferOffsetAlignment` defaults to 256.
 */
const MESH_PER_ENTITY_STRIDE = 256;

/**
 * feat-20260612-skin-palette-per-frame-upload M3 / m3-2: pure helper that
 * builds the `setBindGroup(2, ...)` dynamic-offset tuple at the skin /
 * non-skin draw site.
 *
 * - Skin entries (`skinByteOffset !== undefined`) bind a 2-entry mesh-array
 *   BGL (binding 0 mesh-array UBO, binding 1 palette UBO; both
 *   `hasDynamicOffset: true`), so the tuple carries two offsets: the mesh
 *   slot follows the per-entity 256-byte stride; the palette slot carries
 *   the per-entity cursor M2 m2-6 wrote into `entry.source.skin.byteOffset`.
 * - Non-skin entries bind the URP / HDRP 1-entry mesh-array BGL, so the
 *   tuple carries only the mesh slot offset (length 1). Adding a second
 *   offset there would trip WebGPU validation against the 1-binding BGL.
 *
 * Extracted from the inline `group2DynamicOffsets = [i * MESH_PER_ENTITY_STRIDE,
 * 0]` site (PR #353 stub) so the contract `group2DynamicOffsets[1] ===
 * byteOffset` is testable from a focused unit fixture without driving
 * recordFrame end-to-end.
 *
 * @internal -- exported for unit test access (m3-1)
 */
export function _computeSkinGroup2DynOffsets(
  meshSlotIdx: number,
  skinByteOffset: number | undefined,
): readonly number[] {
  const meshOffset = meshSlotIdx * MESH_PER_ENTITY_STRIDE;
  if (skinByteOffset === undefined) return [meshOffset];
  return [meshOffset, skinByteOffset];
}

/**
 * feat-20260612-skin-palette-per-frame-upload M3 / m3-2: read-side accessor
 * for the per-frame skin BG cache miss / hit counters published by the
 * record stage. Mirrors the existing `bindGroupCounts.createBindGroup`
 * surface but scoped to the skin-mesh BG cache so the m3-1 acceptanceCheck
 * (miss=1 + hit=N-1 across N skinned entities sharing one allocator buffer
 * + mesh SSBO) can be observed without traversing the full record-stage
 * dispatch log. The PipelineState carries the mutable counter object
 * (`_skinBgCacheStats: { miss, hit }`); the record-stage cache miss / hit
 * branches bump it; this accessor returns the live reference.
 *
 * @internal -- exported for unit test access (m3-1)
 */
export function _skinBgCacheStats(pipelineState: {
  readonly _skinBgCacheStats: { miss: number; hit: number };
}): { miss: number; hit: number } {
  return pipelineState._skinBgCacheStats;
}
// feat-20260518-pbr-direct-lighting-mvp M5 / M5-engine-fix Bug 2:
// per-entity Mesh SSBO slot size = mat4 worldFromLocal (64 B) + mat3
// normalMatrix std140 (3 vec4 columns = 48 B) = 112 B. The BindGroup
// entry's `size` MUST cover the full struct so the shader's `meshes[i].
// normalMatrix` access stays in bounds; previously this was 64 B which
// matched only the mat4 prefix and triggered a WebGPU validation error
// on the standard pipeline (which references `normalMatrix`). The 112 B
// shape matches common.wgsl `struct Mesh { worldFromLocal, normalMatrix }`
// byte-for-byte (see common.wgsl line 32-35).
const MESH_SSBO_BYTES = 112;
// bug-20260610: WebGL2 fallback shader declares `array<Mesh, 128>` as a
// uniform buffer; binding must cover the full array size. The storage
// variant binds a single 112-B slot via dynamic offset, but the uniform
// variant requires the whole 14336-B range visible to the shader.
const MESH_UBO_FULL_ARRAY_BYTES = 112 * 128;
// W3C WebGPU §3.6 GPUBufferUsage flags used by the per-entity instance
// transform buffer (STORAGE | COPY_DST = 128 | 8).
const STORAGE_USAGE = 128;
const UNIFORM_USAGE = 64;
const COPY_DST_USAGE = 8;
const MAX_UNIFORM_INSTANCES = 128;

/**
 * feat-20260531-per-frame-bind-group-cache M2 / w7: assigns a stable
 * sequential numeric id to each opaque RHI handle object (Buffer,
 * TextureView, Sampler). The same object reference always maps to the
 * same id; calling this each frame on the same GPU resource is idempotent.
 * Used by buildBindGroupCacheKey to produce deterministic string keys
 * for Map<string, BindGroup> caches (D-2: fine-grain handle-set keys).
 */
/**
 * @internal — exported for AC-10 (w15) WeakMap behavior-invariant test access.
 */
export function getOrAssignHandleId(frameState: RenderFrameState, handle: object): number {
  let id = frameState.handleToId.get(handle);
  if (id === undefined) {
    id = frameState.nextHandleId;
    frameState.handleToId.set(handle, id);
    frameState.nextHandleId = id + 1;
  }
  return id;
}

/**
 * M2 / w7: builds a deterministic cache-key string from a variant
 * discriminator and an ordered array of bound resource handles.
 * Ordering is the bind group entry order (binding 0..N); the variant
 * discriminator prefixes the key to isolate main vs shadow view
 * variants (AC-06).
 *
 * @internal — exported for unit test access (w9-a R-2 mutation-resistance test)
 */
export function buildBindGroupCacheKey(
  variant: string,
  handles: object[],
  frameState: RenderFrameState,
): string {
  const ids = handles.map((h) => getOrAssignHandleId(frameState, h));
  return `${variant}-${ids.join('-')}`;
}

/**
 * M3 / w12: extracts the underlying GPU resource object from a bind
 * group entry descriptor. Returns the raw object reference (Buffer,
 * TextureView, or Sampler) that `getOrAssignHandleId` can map to a
 * stable numeric id for cache-key construction.
 */
function extractEntryResourceHandle(entry: { resource: { kind: string; value: unknown } }): object {
  const v = entry.resource.value;
  if (typeof v === 'object' && v !== null && 'buffer' in (v as Record<string, unknown>)) {
    return (v as { buffer: object }).buffer;
  }
  return v as object;
}

/**
 * M2 / w7: lookup-then-create helper for per-frame bind group caches.
 * On cache hit returns the cached BindGroup (zero-cost).
 * On cache miss calls the factory, bumps bindGroupCounts.createBindGroup,
 * stores the result, and returns it.
 *
 * This single shared helper avoids jscpd dup-check violations across the
 * 14 createBindGroup call sites (plan-strategy S5.6).
 */
function getOrCreateBindGroup(
  cache: Map<string, BindGroup>,
  key: string,
  factory: () => BindGroup,
  bindGroupCounts: BindGroupCounts,
): BindGroup {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const bg = factory();
  bindGroupCounts.createBindGroup += 1;
  bindGroupCounts.keys.push(key);
  cache.set(key, bg);
  return bg;
}

/**
 * M4 / w14: drops cache entries whose entityKey segment (extracted from
 * the key string prefix) is not in the validated entity key set.
 *
 * Cache keys follow the 'variant-entityKey-handleIds...' format (D-2).
 * This helper extracts the entityKey by finding the first two '-'
 * delimiters, parses the segment between them as a number, and deletes
 * the entry when that number is not in the live set.
 *
 * The same logic applies to materialBgCache and instancesBgCache — the
 * single helper avoids a jscpd dup-check violation (plan-strategy S5.6).
 *
 * @internal — exported for unit test access (w16 sentinel-survival test)
 */
export function cleanPerEntityCache(
  cache: Map<string, BindGroup>,
  validatedEntityKeys: Set<number>,
  _variant: string,
): void {
  for (const key of cache.keys()) {
    const firstDash = key.indexOf('-');
    if (firstDash === -1) continue;
    const secondDash = key.indexOf('-', firstDash + 1);
    if (secondDash === -1) continue;
    const ek = Number(key.slice(firstDash + 1, secondDash));
    // D-6 sentinel keys (e.g. 'shadow-material-singleton') produce NaN here
    // because their segment between the dashes is non-numeric. Skip them so
    // the sentinel entries survive across frames — they are init-time stable
    // and must NOT be evicted by per-entity clean-up.
    if (Number.isNaN(ek)) continue;
    if (!validatedEntityKeys.has(ek)) {
      cache.delete(key);
    }
  }
}

/**
 * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
 * record-stage entry-point hook to the closure-scoped mesh-SSBO grow
 * controller (createRenderer.ts). Called once per frame, after
 * `validatedOrdered` has been finalised and BEFORE the first per-entity
 * `queue.writeBuffer`. Returns Result-like (never throws — D-5):
 *
 *  - `{ ok: true }`       — slotCount already covers `neededSlots` (idempotent
 *                           short-circuit), or the controller successfully grew
 *                           in this call. Caller proceeds with the frame.
 *  - `{ ok: false, code }` — controller hit ceiling / capacity and ALREADY
 *                           fired the structured error via errorRegistry.
 *                           Caller must early-return: skip writeBuffer loops,
 *                           skip pass record (AC-08: 0 writeBuffer / 0 draw,
 *                           no truncation).
 *
 * This helper does NOT re-fire on `ok:false` — the controller is the single
 * fire site (createRenderer.ts grow factory), so callers see exactly one
 * structured error per ceiling event (charter P3 explicit failure: no
 * double-fire).
 *
 * Dev-mode visibility: when grow actually grew (slotCount transition) AND
 * `import.meta.env?.DEV` is truthy, a single `console.info('[mesh-ssbo] ...')`
 * line reports the before / after / requested counts. The optional-chain
 * keeps non-vite envs (dawn-node smoke, plain tsup tests) silent —
 * `import.meta.env` is undefined there, the chain short-circuits to
 * undefined, the if-guard is falsy (AC-11 + plan-strategy §2.D-3).
 *
 * Bind-group cache invalidation is automatic: on grow, the controller
 * mutates `meshSsboState.mesh.buffer` / `.material.buffer` in place
 * (wrapper-object identity preserved, inner buffer replaced — research §F8).
 * Downstream `getOrAssignHandleId(<inner buffer>)` therefore yields a fresh
 * id, `buildBindGroupCacheKey` composes a different key, and
 * `getOrCreateBindGroup` rebuilds the BindGroup on the next frame
 * (AC-07; T-M3-03 (a) test).
 *
 * @internal — exported for unit-test access (`mesh-ssbo-grow.test.ts`
 * T-M3-01 / T-M3-02 / T-M3-03 cover idempotency, ceiling, dev info).
 */
export function ensureMeshSsboCapacity(
  internals: {
    readonly growMeshSsbo?:
      | ((neededSlots: number) =>
          | { readonly ok: true }
          | {
              readonly ok: false;
              readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
            })
      | undefined;
    readonly meshSsboState?: { readonly slotCount: number } | undefined;
  },
  neededSlots: number,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
    } {
  // Empty scene / no controller wired (legacy / test fixture path).
  if (neededSlots <= 0) return { ok: true };
  const grow = internals.growMeshSsbo;
  if (grow === undefined) return { ok: true };
  // Idempotent guard — current slotCount already covers neededSlots.
  // The controller's own internal guard catches this too, but bailing here
  // skips the spy / tracing overhead and matches the AC-09 contract that
  // grow runs at most once per frame transition.
  const before = internals.meshSsboState?.slotCount ?? 0;
  if (before > 0 && before >= neededSlots) return { ok: true };
  const result = grow(neededSlots);
  // Note: ok:false has already fired the structured error inside the
  // controller (createRenderer.ts grow factory). Do NOT double-fire here.
  if (!result.ok) return result;
  // Dev-mode visibility — only on a real slotCount transition (skip
  // no-op idempotent paths above; ceiling path returned early on ok:false).
  const after = internals.meshSsboState?.slotCount ?? before;
  if (after !== before) {
    // Module-local binding read (NOT `recordModule.devModeProbe`) so vitest
    // ESM-readonly export forced us to expose the probe as a settable holder
    // (`setMeshSsboDevModeProbeForTests`) instead of a `vi.spyOn` target.
    if (meshSsboDevModeProbe()) {
      // biome-ignore lint/suspicious/noConsole: AC-11 mandates a `[mesh-ssbo]` info line in dev mode (vite build dead-strips this branch via the `import.meta.env.DEV` constant fold; tsup / esbuild prod sets NODE_ENV=production).
      console.info(
        '[mesh-ssbo] grew slotCount: %d -> %d (requested=%d)',
        before,
        after,
        neededSlots,
      );
    }
  }
  return result;
}

/**
 * Test seam: a closure-local function pointer ensureMeshSsboCapacity reads
 * for the dev-mode gate. Defaults to `isMeshSsboDevMode`; tests swap it out
 * via `setMeshSsboDevModeProbeForTests` because vitest 4.x export bindings
 * are non-writable (ESM spec) and `import.meta.env.DEV` is build-time-frozen
 * by the vite transform — neither `vi.spyOn(recordModule, 'isMeshSsboDevMode')`
 * nor `vi.stubEnv('DEV', false)` toggles it at runtime.
 */
let meshSsboDevModeProbe: () => boolean = isMeshSsboDevMode;

/**
 * @internal — test-only injection seam for `ensureMeshSsboCapacity`'s
 * dev-mode gate. Pass `undefined` to restore the production probe
 * (`isMeshSsboDevMode`). Production code paths NEVER call this.
 */
export function setMeshSsboDevModeProbeForTests(probe: (() => boolean) | undefined): void {
  meshSsboDevModeProbe = probe ?? isMeshSsboDevMode;
}

/**
 * Dev-mode probe for `ensureMeshSsboCapacity`'s console.info gate
 * (plan-strategy §2.D-3 + AC-11). True when the build is in dev mode:
 *   - `import.meta.env?.DEV` is truthy (vite dev / vitest), OR
 *   - `process.env.NODE_ENV !== 'production'` (esbuild / tsup / dawn-node).
 * Optional-chain keeps it safe in non-vite ESM envs that never inject
 * `import.meta.env` (the chain short-circuits to undefined → falsy).
 *
 * Vite's `import.meta.env.DEV` is constant-folded at build time, so the
 * production bundle dead-code-strips the entire branch even though the
 * test fall-through reads `process.env.NODE_ENV`.
 *
 * @internal — exported as a function (not a const) so unit tests can
 * `vi.spyOn(...).mockReturnValue(false)` to exercise the dev=false path
 * (vitest 4.x cannot toggle `import.meta.env.DEV` at runtime — it is
 * compile-time-frozen by the vite transform).
 */
export function isMeshSsboDevMode(): boolean {
  const importMetaDev = (import.meta as { env?: { DEV?: unknown } }).env?.DEV;
  if (importMetaDev) return true;
  // Fallback for tsup / esbuild / dawn-node where import.meta.env is absent:
  // NODE_ENV !== 'production' counts as dev. NODE_ENV unset (undefined)
  // also counts as dev so test envs without explicit NODE_ENV log too —
  // production builds always set NODE_ENV='production'. We read process via
  // globalThis to keep this file @types/node-free (rest of the package is
  // browser-typed; engine-runtime ships ESM into both browser + dawn-node).
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (proc !== undefined && proc.env?.NODE_ENV === 'production') return false;
  if (proc === undefined) return false;
  return true;
}

/**
 * feat-20260518-pbr-direct-lighting-mvp M5 / w22.11 (D-2 + D-10 + AC-06):
 * mutable per-frame dispatch counter object owned by `createRenderSystem`
 * and bumped here at the actual `pass.setPipeline(...)` call site (the
 * only point with both `mat.shadingModel` and `mesh.layout` in scope).
 * Three-way split mirrors the three render pipelines on PipelineState.
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
   * Debug-only: records every cache-miss key passed to getOrCreateBindGroup
   * for unit-test observability. Production paths do not read this array.
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

// feat-20260601-customizable-render-pipeline-seam M2 / w12: the former
// `RecordPassContext` (26-field full surface, including the `internals` kitchen-sink and
// the 0-consumed `skyboxCount` residual) is DELETED. The per-frame shared state injected
// into the render-graph pass execute closures is now the clean `RenderPipelineContext`
// (defined in `render-pipeline-context.ts`): `internals` is gone (replaced by the named
// `assets` / `store` / `pipelineState` / `runtime` surfaces) so a pipeline author cannot
// reach the runtime kitchen-sink through the public ctx (AC-08). The graph is
// `RenderGraph<RenderPipelineContext>` so `execute(ctx)` forwards the object to each
// closure with no `as` assertion.
//
// Encoder ownership (RD-4): `ctx.encoder` is the SHARED frame encoder used by the main /
// tonemap / FXAA passes (finished + submitted once at frame end); the shadow pass opens
// its OWN encoder internally + submits independently (the runtime-side manual barrier for
// the depth write -> sample hazard).

// M1 / w7: ensureLazyTexture DELETED — GPU texture ownership moved to render-graph
// via addColorTarget + compile(device). The graph allocates transient/persistent
// render targets during the compile allocation phase; pass execute closures resolve
// TextureViews through resolve(name). PerPassResources texture slots still hold
// the last-used views for bindgroup-invalidation self-checks (D-3 physical texture
// identity), but the graph owns the create/destroy lifecycle.

/**
 * feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9: pick the static
 * geometry pipeline handle for a (shadingModel x tonemapActive x msaaActive)
 * combination. The four mode axes (LDR/HDR x single/MSAA) map to the 14 static
 * pipeline handles built in createRenderer (7 base + 7 count=4 variants). A
 * pipeline's `multisample.count` must match the colour-attachment sampleCount,
 * so the count=4 variant is required whenever the camera carries
 * `antialias === 'msaa'`. Returns null when the requested pipeline was not
 * built (empty-manifest path / MSAA variant build failure) -- the caller fires
 * a structured `shader-compile-failed` on the null-narrow.
 */
// feat-20260615-pipeline-spec-ssot M6-T1: the standard-shading fallback
// selector was deleted. The pre-M6 selector silently substituted the
// boot-time URP `pipelineState.standardPipeline*` whenever the per-
// MaterialShader cache returned null and HDRP was inactive -- masking
// real PipelineSpecError build failures behind a layout-compatible-but-
// wrong PSO. Charter P3 explicit-failure now governs: a missing cache
// entry surfaces as null, and the per-submesh
// `if (smPipelineHandle === null) continue` skip-draw (which already
// covered the HDRP-active and skin-shader miss-skip paths) is the single
// uniform recovery shape across URP / HDRP / skin.

function selectGeometryPipeline(
  pipelineState: PipelineState,
  shading: 'unlit' | 'standard' | 'sprite',
  tonemapActive: boolean,
  msaaActive: boolean,
): RenderPipeline | null {
  if (shading === 'sprite') {
    if (tonemapActive) {
      return msaaActive ? pipelineState.spritePipelineHdrMsaa : pipelineState.spritePipelineHdr;
    }
    return msaaActive ? pipelineState.spritePipelineMsaa : pipelineState.spritePipeline;
  }
  if (shading === 'standard') {
    if (tonemapActive) {
      return msaaActive ? pipelineState.standardPipelineHdrMsaa : pipelineState.standardPipelineHdr;
    }
    return msaaActive ? pipelineState.standardPipelineMsaa : pipelineState.standardPipeline;
  }
  // unlit
  if (tonemapActive) {
    return msaaActive ? pipelineState.unlitPipelineHdrMsaa : pipelineState.unlitPipelineHdr;
  }
  return msaaActive ? pipelineState.unlitPipelineMsaa : pipelineState.unlitPipeline;
}

/**
 * feat-20260601-gpu-resource-store-extraction M1 / D-9: resolve a texture's
 * GPU view through the pull-model residency store. The three steps replace the
 * pre-extraction single-call accessor on the registry:
 *   1. fetch the TextureAsset POD off the registry (CPU; registry keeps PODs)
 *   2. synchronously `ensureResident(handle, pod)` (first access builds the
 *      GPU texture + prewarmed mipmap blit; subsequent access is O(1))
 *   3. return the GPU view (or undefined on POD miss / ensureResident err)
 *
 * Returns `undefined` when the POD is absent (handle never registered) or the
 * upload fails (a structured error is fired). Callers then fall back to their
 * existing placeholder view, preserving the pre-extraction fallback semantics.
 */
// feat-20260601-gpu-resource-store-extraction M1 (D-1): builtin mesh handle
// ids 1-5 (CUBE/TRIANGLE/QUAD/SPHERE/NINESLICE_QUAD) are seeded + uploaded
// by createRenderer step-3 into `pipelineState.meshes`; they are not routed
// through the store's `ensureResident` pull path. Any handle id above this
// max is a user mesh. feat-20260527-sprite-nineslice M2 / w11: bumped to 5
// when HANDLE_NINESLICE_QUAD joined the builtin set.
const BUILTIN_MESH_ID_MAX = 5;

// feat-20260527-sprite-nineslice M2 / w11 (D-2): raw u32 id of
// HANDLE_NINESLICE_QUAD used to look up the 16-vertex / 54-index mesh
// from `pipelineState.meshes` when a sprite material declares non-zero
// `slices`. Mirrors the literal in `asset-registry.ts:HANDLE_NINESLICE_QUAD`.
const NINESLICE_QUAD_RAW_ID = 5;

function residentTextureView(
  world: World,
  store: GpuResourceStore,
  runtime: RenderSystemRuntime,
  handle: Handle<'TextureAsset', 'shared'>,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture-view return
): any | undefined {
  const podRes = resolveAssetHandle<TextureAsset>(world, handle);
  if (!podRes.ok) return undefined;
  const residentRes = store.ensureResident(handle, podRes.value);
  if (!residentRes.ok) {
    // Only RhiError fans out to the onError channel (RhiError | RuntimeError);
    // a registered TextureAsset POD is format/colorSpace-consistent so the
    // ImageError consistency arm never fires here. Degrade to placeholder.
    if (residentRes.error instanceof RhiError) runtime.errorRegistry.fire(residentRes.error);
    return undefined;
  }
  return store.getTextureGpuView(handle);
}

// feat-20260621-learn-render-5-5-parallax M2 / w8 (D-3): the built-in
// standard-PBR user-region texture field order, used when the shader is not
// resolvable through getParamSchema (cross-worktree late-register). Mirrors
// derive(default-standard-pbr).textureFieldNames.
const BUILTIN_USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
];

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w8 (D-3): ordered user-region
 * texture field names for a material's bind-group assembly, derived from the
 * shader's paramSchema via the `derive()` SSOT (insertion order = sampler/
 * texture pair order in derive().bglEntries). Falls back to the built-in 3
 * fields when the schema is unavailable.
 */
function userRegionTextureFieldOrder(
  schema: Parameters<typeof derive>[0] | undefined,
): readonly string[] {
  if (schema === undefined) return BUILTIN_USER_REGION_TEXTURE_FIELDS;
  return [...derive(schema).textureFieldNames];
}

/**
 * feat-20260621-learn-render-5-5-parallax M2 / w8: the fallback texture view
 * for a user-region field when no handle is provided (graceful, charter P3).
 * normalTexture decodes to a flat tangent normal; everything else (baseColor,
 * MR, height, ...) uses the 1x1 white default (height white -> zero displacement).
 */
function defaultViewForUserRegionField(
  field: string,
  pipelineState: PipelineState,
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture-view
): any {
  if (field === 'normalTexture') return pipelineState.defaultNormalTextureView;
  if (field === 'baseColorTexture') return pipelineState.fallbackTextureView;
  return pipelineState.defaultWhiteTextureView;
}

/**
 * feat-20260527-sprite-nineslice M4 / w17 (AC-16): once-per-renderable
 * detection of "Transform.scale below the four 9-slice corner anchors". Pure
 * helper extracted out of recordFrame so unit tests can drive it without a
 * GPU device — the recordFrame loop calls this with its `transformWorld` /
 * `slices` / `renderableIndex` / `seenIndices` / `metrics` arguments.
 *
 * The scale-vs-anchor formula mirrors plan-strategy §D-3 — `scaleX` must
 * accommodate `|slices.x| + |slices.z|`, and `scaleY` must accommodate
 * `|slices.y| + |slices.w|`. Slices ≡ all zero is a no-op (legacy quad
 * path); a breach increments `nineslice.scale-too-small` exactly once per
 * `renderableIndex` per RenderSystem lifetime via the `seenIndices` Set
 * (the same warn-once anchor pattern used for missing-texture sprites).
 *
 * @param transformWorld The entity's resolved Transform.world mat4 (16 floats column-major).
 * @param slices         The four anchor distances `[left, top, right, bottom]`
 *                       (sentinel `bottom < 0` for tile mode is consumed via abs()).
 * @param renderableIndex The entity index into the validated renderables list.
 * @param seenIndices    The per-frame-state guard Set; entries are added on increment.
 * @param metrics        The per-Renderer EngineMetrics counter.
 * @internal — exported for unit-test access (w17).
 */
export function detectNineSliceScaleTooSmall(
  transformWorld: Float32Array,
  slices: readonly [number, number, number, number],
  renderableIndex: number,
  seenIndices: Set<number>,
  metrics: { increment(name: string): void },
): void {
  const anyNonZero = slices[0] !== 0 || slices[1] !== 0 || slices[2] !== 0 || slices[3] !== 0;
  if (!anyNonZero) return;
  const scaleX = Math.hypot(transformWorld[0] ?? 1, transformWorld[1] ?? 0, transformWorld[2] ?? 0);
  const scaleY = Math.hypot(transformWorld[4] ?? 0, transformWorld[5] ?? 1, transformWorld[6] ?? 0);
  const horizontalAnchor = Math.abs(slices[0]) + Math.abs(slices[2]);
  const verticalAnchor = Math.abs(slices[1]) + Math.abs(slices[3]);
  if (scaleX < horizontalAnchor || scaleY < verticalAnchor) {
    if (!seenIndices.has(renderableIndex)) {
      seenIndices.add(renderableIndex);
      metrics.increment('nineslice.scale-too-small');
    }
  }
}

/**
 * Build the 80-byte Material UBO payload for a sprite material entry
 * (feat-20260527-sprite-nineslice M2 / w11, plan-strategy §D-3 + §D-7).
 *
 * Layout (16 floats, std140 4 vec4 slots):
 *   slot 0  [ 0..15] colorTint     vec4
 *   slot 1  [16..31] region        vec4 (uMin, vMin, uW, vH; flip pre-applied)
 *   slot 2  [32..47] pivotAndSize  vec4 (pivotX, pivotY, sourceScaleX, sourceScaleY)
 *   slot 3  [48..63] slicesAndMode vec4 (left, top, right, bottom; tile sentinel: bottom < 0)
 *   slot 4  [64..79] reserved zero (PBR payload occupies this slot but the
 *                                   sprite path leaves it untouched, so the
 *                                   80B buffer slice is zero-initialised).
 *
 * The first 48 B (colorTint / region / pivotAndSize) are byte-for-byte
 * equivalent to the legacy hard-coded sprite write path: D-7 isolation
 * regression net (`render-system-record-pbr-ubo-stable.test.ts`) detects
 * any byte drift in the PBR variant; the sprite three-state regression net
 * (`render-system-record-sprite-ubo-bytes.test.ts`) covers the slot 3
 * sentinel triple.
 *
 * The helper does NOT consult the texture upload state — missing-texture
 * debug-pink override and the per-frame RhiError fire stay in the inline
 * caller (they require runtime / errorRegistry / frameState). The helper
 * stays a pure POD writer so unit tests can run without a GPU device.
 *
 * @param material  the extracted MaterialSnapshot (shadingModel='sprite')
 * @param transformWorld  the entity's resolved Transform.world mat4 (16
 *                        floats, column-major); column lengths give the
 *                        sprite quad's source scale.
 * @returns 80-byte ArrayBuffer ready for `queue.writeBuffer`.
 */
export function buildSpriteMaterialUboPayload(
  material: MaterialSnapshot,
  transformWorld: Float32Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(STANDARD_PBR_UBO_SIZE);
  const f32 = new Float32Array(buf);
  // World basis-column lengths drive the sprite quad's world-space size
  // (feat-20260601 D-3): scaleX = |col0|, scaleY = |col1|.
  const sw = transformWorld;
  const sourceScaleX = Math.hypot(sw[0] ?? 1, sw[1] ?? 0, sw[2] ?? 0);
  const sourceScaleY = Math.hypot(sw[4] ?? 0, sw[5] ?? 1, sw[6] ?? 0);
  const sf = material.spriteFields;
  const baseColor = material.baseColor;
  const colorTintR = baseColor[0] ?? 1;
  const colorTintG = baseColor[1] ?? 1;
  const colorTintB = baseColor[2] ?? 1;
  const colorTintA = sf?.colorTintAlpha ?? 1;
  let regionX = sf?.region[0] ?? 0;
  let regionY = sf?.region[1] ?? 0;
  let regionZ = sf?.region[2] ?? 1;
  let regionW = sf?.region[3] ?? 1;
  const pivotX = sf?.pivot[0] ?? 0.5;
  const pivotY = sf?.pivot[1] ?? 0.5;
  if (sf?.flipX === true) {
    regionX = regionX + regionZ;
    regionZ = -regionZ;
  }
  if (sf?.flipY === true) {
    regionY = regionY + regionW;
    regionW = -regionW;
  }
  // slot 0 — colorTint
  f32[0] = colorTintR;
  f32[1] = colorTintG;
  f32[2] = colorTintB;
  f32[3] = colorTintA;
  // slot 1 — region
  f32[4] = regionX;
  f32[5] = regionY;
  f32[6] = regionZ;
  f32[7] = regionW;
  // slot 2 — pivotAndSize
  f32[8] = pivotX;
  f32[9] = pivotY;
  f32[10] = sourceScaleX;
  f32[11] = sourceScaleY;
  // slot 3 — slicesAndMode (D-3 sentinel: extract pre-encodes sliceMode=1
  // by negating slices.w; this writer copies verbatim and the shader
  // recovers the magnitude with abs() + reads the sign for tile vs stretch).
  // Default (no slices on snapshot) is [0, 0, 0, 0] which lets the shader
  // early-out to the legacy sprite path (HANDLE_QUAD topology, no 9-slice).
  const slices = sf?.slices;
  if (slices !== undefined) {
    f32[12] = slices[0];
    f32[13] = slices[1];
    f32[14] = slices[2];
    f32[15] = slices[3];
  }
  // slot 4 (16..19) stays zero — sprite path does not consume the PBR-only
  // occlusionStrength byte.
  return buf;
}

/**
 * Build the 80-byte Material UBO payload for a PBR / unlit material entry
 * (feat-20260527-sprite-nineslice M2 / w11; D-7 regression-net helper).
 *
 * Byte-for-byte equivalent to the legacy hard-coded PBR write path; any
 * deviation is caught by `render-system-record-pbr-ubo-stable.test.ts`.
 * The schema-driven paramSnapshot overlay (feat-20260523 M9-T05; AC-14)
 * positions vec4 / f32 slots onto std140 [slot0 vec4, slot1 f32 metallic,
 * slot1 f32 roughness] mirroring the engine-shipped default-standard-pbr
 * Material struct.
 */
export function buildPbrMaterialUboPayload(material: MaterialSnapshot): ArrayBuffer {
  const buf = new ArrayBuffer(STANDARD_PBR_UBO_SIZE);
  const f32 = new Float32Array(buf);
  // Layout (issue-1: channelMap split per D-8) -- byte-equivalent to the
  // post-split sidecar paramSchema for default-standard-pbr (10 numeric
  // entries packed std140 into one merged UBO at binding(0)).
  //   f32[0..3]   baseColor          (offset 0,  vec4)
  //   f32[4]      metallic           (offset 16)
  //   f32[5]      roughness          (offset 20)
  //   f32[6]      metallicChannel    (offset 24)  -- glTF 2.0 default = B = 2
  //   f32[7]      roughnessChannel   (offset 28)  -- glTF 2.0 default = G = 1
  //   f32[8]      aoChannel          (offset 32)  -- glTF 2.0 default = R = 0
  //   f32[9]      extraChannel       (offset 36)  -- reserved = 0
  //                                  (offset 40..47 implicit pad: vec3 align=16)
  //   f32[12..14] emissive           (offset 48,  vec3)
  //   f32[15]     emissiveIntensity  (offset 60)
  //   f32[16]     occlusionStrength  (offset 64)
  //                                  (offset 68..79 trailing pad to 16 B align)
  // Total = 80 B, matches std140 derive(sidecar).uboLayout.totalBytes.
  f32[0] = material.baseColor[0] ?? 0;
  f32[1] = material.baseColor[1] ?? 0;
  f32[2] = material.baseColor[2] ?? 0;
  f32[3] = 1;
  f32[4] = material.metallic;
  f32[5] = material.roughness;
  // channelMap default = (B, G, R, _) per AGENTS.md + glTF 2.0
  // KHR_materials_pbrSpecularGlossiness ARM packing -- now 4 independent
  // f32 selectors; fragment casts each to u32 at the pick site.
  f32[6] = 2; // metallicChannel  <- B
  f32[7] = 1; // roughnessChannel <- G
  f32[8] = 0; // aoChannel        <- R
  f32[9] = 0; // extraChannel     <- reserved
  // emissive vec3 + emissiveIntensity (offset 48..63)
  const em = material.emissive;
  f32[12] = em?.[0] ?? 0;
  f32[13] = em?.[1] ?? 0;
  f32[14] = em?.[2] ?? 0;
  f32[15] = material.emissiveIntensity ?? 0;
  // occlusionStrength (offset 64)
  f32[16] = material.occlusionStrength ?? 1;
  // Schema-driven paramSnapshot overlay (feat-20260523 M9-T05, AC-14):
  // for user-shaders with a paramSnapshot, project the first vec4/color
  // entry onto slot 0 and the first two f32 entries onto slot 1's first
  // two floats. The default-standard-pbr path lands on the same offsets
  // via the explicit fields above, so the overlay is a no-op for the
  // engine's stock PBR shader (charter P4 + R-H regression fence).
  const paramSnap = material.paramSnapshot;
  if (paramSnap !== undefined) {
    const f32Snap = (name: string): number | undefined => {
      const v = paramSnap[name];
      return typeof v === 'number' ? v : undefined;
    };
    const colorSnap = (name: string): readonly number[] | undefined => {
      const v = paramSnap[name];
      return Array.isArray(v) && v.every((x) => typeof x === 'number')
        ? (v as readonly number[])
        : undefined;
    };
    // Walk schema in declared order, fill positional UBO slots.
    const materialShaderId = material.materialShaderId;
    // Note: schema lookup is the caller's job (it owns the runtime ref);
    // when the helper has no access to runtime, paramSnap is consumed
    // positionally without a schema walk. The inline caller (recordFrame)
    // still performs the schema-driven walk and writes the overlay before
    // queueing this payload, so this helper is only the byte-stable
    // baseline. To preserve byte-for-byte equivalence in the helper-only
    // unit-test path, the overlay pass is skipped when the helper is
    // called without an external schema reference.
    void materialShaderId;
    void f32Snap;
    void colorSnap;
  }
  return buf;
}

/**
 * feat-20260608-multi-light-warn-once M3: warn-once latch for directional
 * N>1 overrun. Fires console.warn at most once per RenderSystem lifetime.
 * Extracted as a pure helper so the warn-once logic is directly testable
 * without a full recordFrame argument list (AC-05 (c)).
 */
export function warnMultiLightDirectional(
  frameState: Pick<RenderFrameState, 'warnedMultiLightDirectional'>,
  directionalCount: number,
  envOverride?: { env?: { NODE_ENV?: string } },
): void {
  if (!frameState.warnedMultiLightDirectional && directionalCount > 1) {
    frameState.warnedMultiLightDirectional = true;
    const env =
      envOverride ?? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] render-system-multi-light directional: at most 1 entity (got N=' +
          directionalCount +
          '). First entity used; rest dropped.',
        {
          code: 'render-system-multi-light',
          expected: 'at most 1 directional',
          detail: { type: 'directional', got: directionalCount },
        },
      );
    }
  }
}

/**
 * feat-20260608-multi-light-warn-once M3: warn-once latch for point light
 * N>4 overrun (first-slice cap). Fires at most once per RenderSystem
 * lifetime.
 */
export function warnMultiLightPoint(
  frameState: Pick<RenderFrameState, 'warnedMultiLightPoint'>,
  pointCount: number,
  envOverride?: { env?: { NODE_ENV?: string } },
): void {
  if (!frameState.warnedMultiLightPoint && pointCount > 4) {
    frameState.warnedMultiLightPoint = true;
    const env =
      envOverride ?? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] render-system-multi-light point: at most 4 entities (got N=' +
          pointCount +
          '). First 4 used; rest dropped.',
        {
          code: 'render-system-multi-light',
          expected: 'at most 4 point',
          detail: { type: 'point', got: pointCount },
        },
      );
    }
  }
}

/**
 * feat-20260608-multi-light-warn-once M3: warn-once latch for spot light
 * N>4 overrun (first-slice cap). Fires at most once per RenderSystem
 * lifetime.
 */
export function warnMultiLightSpot(
  frameState: Pick<RenderFrameState, 'warnedMultiLightSpot'>,
  spotCount: number,
  envOverride?: { env?: { NODE_ENV?: string } },
): void {
  if (!frameState.warnedMultiLightSpot && spotCount > 4) {
    frameState.warnedMultiLightSpot = true;
    const env =
      envOverride ?? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] render-system-multi-light spot: at most 4 entities (got N=' +
          spotCount +
          '). First 4 used; rest dropped.',
        {
          code: 'render-system-multi-light',
          expected: 'at most 4 spot',
          detail: { type: 'spot', got: spotCount },
        },
      );
    }
  }
}

export function recordFrame(
  internals: RenderSystemInternals,
  world: World,
  cameras: CameraSnapshot[],
  lights: ExtractedLights,
  renderables: RenderableSnapshot[],
  transparentDispatch: readonly DispatchEntry[],
  frameState: RenderFrameState,
  dispatchCounts: DispatchCounts,
  bindGroupCounts: BindGroupCounts,
  skylight: SkylightSnapshot | undefined,
  skylightCount: number,
  skybox: SkyboxSnapshot | undefined,
  skyboxCount: number,
  postProcessParams: ReadonlyMap<string, Uint8Array>,
): void {
  // The `try / finally` wrapper advances `frameState.frameNumber` exactly
  // once per `recordFrame` invocation regardless of which early-return
  // branch is taken (camera missing, cap exceeded, pipeline pending,
  // swap-chain unavailable, etc).
  // Case B: 0 Camera => fire onError diagnostic. After
  // feat-20260608-create-app-param-surface-trim / M1 / D-8, the frame
  // is NOT skipped: a synthetic CameraSnapshot is injected so the
  // downstream clear-pass-only path (Case E softening, D-Q7) still
  // paints the swap-chain with the `ZERO_CAMERA_CLEAR_FALLBACK` color
  // (`[0, 0, 0, 1]` opaque black; AC-05). The synthetic camera carries
  // identity-shaped projection / view inputs (fov=PI/4, aspect=1,
  // near=0.1, far=100) so the existing matrix math stays numerically
  // stable; no MeshRenderer entity will pass validation in this state
  // (no Camera = no scene), so geometry submission is a no-op and only
  // the swap-chain clear lands.
  let activeCameras = cameras;
  if (activeCameras.length === 0) {
    internals.errorRegistry.fire(
      new RhiError({
        code: 'render-system-no-camera',
        expected: 'world has at least one entity with Transform + Camera',
        hint: 'world.spawn({ component: Transform, data: { posX, posY, posZ, quatX, quatY, quatZ, quatW, scaleX, scaleY, scaleZ } }, { component: Camera, data: { fov, aspect, near, far, clearR, clearG, clearB, clearA } }) before renderer.draw(world)',
      }),
    );
    activeCameras = [makeZeroCameraFallbackSnapshot()];
  }
  try {
    // Case D: N>1 Camera => fire onError, use first hit (D-S7).
    if (activeCameras.length > 1) {
      internals.errorRegistry.fire(
        new RhiError({
          code: 'render-system-multi-camera',
          expected: 'world has exactly one entity with Transform + Camera',
          hint: 'remove duplicate Camera entities or wait for feat-future-multi-viewport',
        }),
      );
    }
    const camera = activeCameras[0];
    if (!camera) return;

    if (lights.directionalCount > 1) {
      warnMultiLightDirectional(frameState, lights.directionalCount);
    }
    // feat-20260520-directional-light-shadow-mapping verify round 1 fix:
    // once-warn for shadow disabled by missing component (AC-04 + AC-22).
    // Fires at most once per RenderSystem lifecycle via warnedShadowDisabled
    // latch. Follows the same console.warn pattern as warnedZeroLightStandard
    // (non-production only) so smoke gates that track onError fire count
    // are not polluted by configuration once-warns.
    if (!frameState.warnedShadowDisabled) {
      const ac04 = lights.directional !== undefined && lights.shadowMapSize === undefined;
      const ac22 = lights.hasOrphanShadow;
      if (ac04 || ac22) {
        frameState.warnedShadowDisabled = true;
        const err = new ShadowDisabledByMissingComponentError(ac04 ? 'shadow' : 'light');
        const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
        if (env?.env?.NODE_ENV !== 'production') {
          console.warn(`[forgeax] ${err.message}`, {
            code: err.code,
            expected: err.expected,
            hint: err.hint,
          });
        }
      }
    }

    // feat-20260608-cluster-lighting M6 / w23 (F-4 fix): URP-only multi-light
    // warn. HDRP supports 256 punctual lights via SSBO; the 4-slot first-slice
    // cap is irrelevant under HDRP, so gate on `!isHdrpActive` to silence noise.
    // Sibling tweak-20260608-rhi-hdr-renderable-caps-and-warn-once (#320)
    // extracted the warn into warnMultiLight{Point,Spot} helpers (warn-once
    // dedup); we keep the helpers and add the HDRP gate on top.
    if (!frameState.isHdrpActive) {
      if (lights.point.length > LIGHT_ARRAY_MAX_SLOTS) {
        warnMultiLightPoint(frameState, lights.point.length);
      }
      if (lights.spot.length > LIGHT_ARRAY_MAX_SLOTS) {
        warnMultiLightSpot(frameState, lights.spot.length);
      }
    }
    void activeCameras; // referenced below

    // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
    // project lights.pointShadow onto frameState so the URP point shadow caster
    // pass can read the snapshot list during graph execute. Lazy-allocate the
    // cube_array atlas on first non-empty frame; zero-shadow scenes never
    // touch the GPU here (AC-09). The snapshot list is stable for the
    // duration of recordFrame; the URP `addPointShadowPass` gate at
    // buildGraph time reads the same list to decide whether to insert the
    // shadow pass declaration into the graph.
    frameState.pointShadowSnapshots = lights.pointShadow;
    if (lights.pointShadow.length > 0) {
      if (frameState.pointShadowAtlas === null) {
        const firstSnap = lights.pointShadow[0];
        const faceSize = firstSnap?.mapSize ?? 512;
        frameState.pointShadowAtlas = new ShadowAtlas(internals.device, {
          faceSize,
          layers: 4,
        });
      }
      try {
        frameState.pointShadowAtlas.ensure();
      } catch (e) {
        if (
          e instanceof PointShadowAtlasUninitializedError ||
          e instanceof PointShadowAtlasBoundsViolationError
        ) {
          internals.errorRegistry.fire(e);
        } else {
          throw e;
        }
      }
    }

    // ExtractedLights three-arm consumption (R-10 preparation; M2 / w16):
    //
    //   - lights.directional : feeds the View UBO at slot [16..23]
    //                          (lightDir + lightColor; existing path).
    //   - lights.point[]     : will be packed into pointLightsBuffer
    //                          (std430 storage buffer) in M3 / w20.
    //   - lights.spot[]      : will be packed into spotLightsBuffer
    //                          (std430 storage buffer) in M3 / w20.
    //
    // Each variant carries the discriminant `kind` so the M3 packing
    // call sites can run exhaustive switch (charter P2 + AC-03).
    const directionalLight: DirectionalLightSnapshot | undefined = lights.directional;
    const pointLights = lights.point;
    const spotLights = lights.spot;
    // Voiding for M2: storage buffer wiring lands in M3 / w20. Reading the
    // arrays at this site keeps the union shape pinned (TS narrows on
    // `kind` at the M3 record-time pack call sites).
    void pointLights;
    void spotLights;

    // Case C: 0 DirectionalLight = legitimate scene; the View UBO falls
    // back to a zero-intensity directional payload so the shader's
    // `view.lightDir * view.lightColor` term contributes nothing
    // (physically-correct black under standard, untouched under unlit).
    const light = directionalLight ?? {
      kind: 'directional' as const,
      direction: vec3.create(0, -1, 0),
      color: vec3.create(0, 0, 0),
      intensity: 0,
    };

    const totalLightCount =
      (directionalLight !== undefined ? 1 : 0) + pointLights.length + spotLights.length;

    // feat-20260520-skylight-ibl-cubemap M4 / t27 (AC-10 + F-4 nit):
    // 0-light three-condition conjunction (plan-strategy D-5):
    //   no Skylight (skylight === undefined)
    //   AND 0 direct light (totalLightCount === 0)
    //   AND StandardMaterial (renderables.some shadingModel === 'standard')
    // All three true -> black + warn. Any one false -> no warn.
    //
    // Multi-Skylight warn (F-4 nit): >1 Skylight entity -> warn in dev and
    // prod (consistent with charter P3 explicit failure). First Skylight
    // (by archetype order) wins.
    if (skylightCount > 1) {
      console.warn(
        '[forgeax] Skylight: multiple skylight entities found, using first. Only the first Skylight (by archetype order) is used for IBL ambient.',
      );
    }

    // feat-20260531-skybox-env-background M2 / w12: multi-SkyboxBackground
    // once-warn (mirrors Skylight pattern above, plan-strategy D-6).
    // First SkyboxBackground (by archetype order) wins; >1 warns in dev
    // and prod (charter P3 explicit failure, no silent drop).
    if (skyboxCount > 1) {
      console.warn(
        '[forgeax] SkyboxBackground: multiple entities detected, using the first. Consider keeping a single SkyboxBackground entity per scene.',
      );
    }

    // feat-20260608-cluster-lighting M5 / w21 + M6 / w23 + r2 fix-up: HDRP
    // per-frame path. Run the CPU cluster binner against extracted punctual
    // lights when the HDRP pipeline is active. Fail-soft: index-list-overflow
    // and light-budget-exceeded fire once per frame and continue rendering.
    const hdrpLightCount = pointLights.length + spotLights.length;
    if (frameState.isHdrpActive && hdrpLightCount > 0) {
      const HDRP_LIGHT_BUDGET = 256;
      let effectivePointLights = pointLights;
      let effectiveSpotLights = spotLights;
      if (hdrpLightCount > HDRP_LIGHT_BUDGET) {
        if (!frameState.hdrpOncePerFrameFired.has('hdrp-light-budget-exceeded')) {
          frameState.hdrpOncePerFrameFired.add('hdrp-light-budget-exceeded');
          internals.errorRegistry.fire(
            new HdrpLightBudgetExceededError(hdrpLightCount, HDRP_LIGHT_BUDGET),
          );
        }
        if (pointLights.length >= HDRP_LIGHT_BUDGET) {
          effectivePointLights = pointLights.slice(0, HDRP_LIGHT_BUDGET);
          effectiveSpotLights = [];
        } else {
          effectivePointLights = pointLights;
          effectiveSpotLights = spotLights.slice(0, HDRP_LIGHT_BUDGET - pointLights.length);
        }
      }

      const hdrpLights: Array<{ position: Float32Array; range: number }> = [];
      for (const pl of effectivePointLights) {
        const range =
          Number.isFinite(pl.invRangeSquared) && pl.invRangeSquared > 0
            ? Math.sqrt(1 / pl.invRangeSquared)
            : 1000;
        hdrpLights.push({ position: pl.position as unknown as Float32Array, range });
      }
      for (const sl of effectiveSpotLights) {
        const range =
          Number.isFinite(sl.invRangeSquared) && sl.invRangeSquared > 0
            ? Math.sqrt(1 / sl.invRangeSquared)
            : 1000;
        hdrpLights.push({ position: sl.position as unknown as Float32Array, range });
      }

      const clusterGrid = frameState.installedPipelineConfig?.clusterGrid ?? {
        x: 16,
        y: 9,
        z: 24,
      };
      const gridX = clusterGrid.x;
      const gridY = clusterGrid.y;
      const gridZ = clusterGrid.z;
      const clusterCount = gridX * gridY * gridZ;

      const projMatrix = computeProjectionMatrix(camera);
      const viewMatrix = computeViewMatrix(camera);

      const clusterGridBuf = new Uint32Array(clusterCount * 2);
      const lightIndexListBuf = new Uint32Array(LIGHT_INDEX_LIST_CAPACITY);

      const binResult = bin(
        hdrpLights as unknown as Array<{
          position: import('@forgeax/engine-math').Vec3;
          range: number;
        }>,
        viewMatrix,
        projMatrix,
        { x: gridX, y: gridY, z: gridZ },
        camera.near,
        camera.far,
        clusterGridBuf,
        lightIndexListBuf,
        LIGHT_INDEX_LIST_CAPACITY,
      );

      if (!binResult.ok && !frameState.hdrpOncePerFrameFired.has('hdrp-index-list-overflow')) {
        frameState.hdrpOncePerFrameFired.add('hdrp-index-list-overflow');
        const detail = binResult.error.detail;
        internals.errorRegistry.fire(
          new HdrpIndexListOverflowError(detail.actual, detail.capacity),
        );
      }

      // Falsify injection point: FORGEAX_HDRP_FALSIFY_CLUSTER_GRID_ZERO
      // zeroes the cluster_grid buffer so every fragment culls every light.
      // Used by hello-hdrp-lighting smoke FALSIFY=cluster-grid-zero to
      // prove the smoke has discriminability (must FAIL vs baseline).
      // Read process via globalThis to keep this file @types/node-free.
      const envFalsify = (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env;
      if (envFalsify?.FORGEAX_HDRP_FALSIFY_CLUSTER_GRID_ZERO) {
        clusterGridBuf.fill(0);
      }

      const hdrpBuffers = getOrCreateHdrpBuffers(internals, clusterGrid);
      if (hdrpBuffers !== null) {
        const lightDataPayload = new Float32Array(256 * 16);
        let slotIdx = 0;
        for (const pl of effectivePointLights) {
          if (slotIdx >= 256) break;
          // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-4
          // (plan-strategy §D-8): thread the optional shadow info through
          // packLightSlot. PointLightSnapshot.shadowAtlasLayer is set by
          // extract's join pass when the entity carries PointLightShadow;
          // sentinel -1 means no shadow (unshadowed evalPoint path).
          const layer = pl.shadowAtlasLayer;
          const packed =
            layer !== undefined &&
            layer >= 0 &&
            pl.shadowNear !== undefined &&
            pl.shadowFar !== undefined
              ? packLightSlot(pl, {
                  shadowAtlasLayer: layer,
                  near: pl.shadowNear,
                  far: pl.shadowFar,
                })
              : packLightSlot(pl);
          lightDataPayload.set(packed, slotIdx * 16);
          slotIdx += 1;
        }
        for (const sl of effectiveSpotLights) {
          if (slotIdx >= 256) break;
          const packed = packLightSlot(sl);
          lightDataPayload.set(packed, slotIdx * 16);
          slotIdx += 1;
        }
        const lightDataUpload = internals.device.queue.writeBuffer(
          hdrpBuffers.lightDataBuffer,
          0,
          lightDataPayload,
        );
        if (!lightDataUpload.ok) internals.errorRegistry.fire(lightDataUpload.error);

        const clusterGridUpload = internals.device.queue.writeBuffer(
          hdrpBuffers.clusterGridBuffer,
          0,
          clusterGridBuf,
        );
        if (!clusterGridUpload.ok) internals.errorRegistry.fire(clusterGridUpload.error);

        const lightIndexListUpload = internals.device.queue.writeBuffer(
          hdrpBuffers.lightIndexListBuffer,
          0,
          lightIndexListBuf,
        );
        if (!lightIndexListUpload.ok) internals.errorRegistry.fire(lightIndexListUpload.error);

        // scope-amend-webgl2-ubo: SSAO intensity is folded into the
        // cluster_uniform .w lane (formerly pad), removing the dedicated
        // @binding(9) UBO that pushed fragment-stage UBO count past
        // WebGL2's max_uniform_buffers_per_shader_stage=11. Disabled-SSAO
        // path writes 0 so `mix(1.0, ssao*ao, 0.0) = 1.0` in the lighting
        // shader (no PSO recompile across enable/disable).
        const clusterSsaoConfig = frameState.installedPipelineConfig?.ssao;
        const clusterSsaoIntensity =
          clusterSsaoConfig !== undefined && clusterSsaoConfig.enabled === true
            ? (clusterSsaoConfig.intensity ?? 1.0)
            : 0;
        const clusterUniformPayload = packClusterUniform(
          { x: gridX, y: gridY, z: gridZ },
          camera.near,
          camera.far,
          clusterSsaoIntensity,
        );
        const clusterUniformUpload = internals.device.queue.writeBuffer(
          hdrpBuffers.clusterUniformBuffer,
          0,
          new Uint8Array(clusterUniformPayload),
        );
        if (!clusterUniformUpload.ok) internals.errorRegistry.fire(clusterUniformUpload.error);
      }

      // ── feat-20260612-hdrp-ssao M1 / w6 + M7 / w33 ───────────────
      // Per-frame SSAO uniform write (plan-strategy D-1 + D-C):
      //   view + projection + inverseProjection at offsets 0/64/128 +
      //   intensityPad (vec4 — x=intensity, yzw padding) at offset 192;
      //   total 256 B (matches host SSAO_UNIFORM_BYTES + WGSL struct).
      // Single writeBuffer covers all four fields so one queue entry
      // updates the entire UBO.
      // Separate from View UBO (592 B invariant); does not affect
      // material PSO bytecode.
      //
      // Writes when HDRP is active; config.ssao?.enabled guard comes in
      // M4 / w19 after the config.ssao type narrowing is added.
      {
        const ssaoBufs = getOrCreateSsaoBuffers(internals);
        if (ssaoBufs !== null) {
          const sProj = computeProjectionMatrix(camera);
          const sView = computeViewMatrix(camera);
          // inverseProjection = inverse(projection): NDC -> view-space.
          const invProjOnly = mat4.create();
          mat4.invert(invProjOnly, sProj);

          // Float32Array of 64 (256 B): 3 mat4 (48) + intensityPad vec4 (4)
          // + 12 trailing padding floats. We only fill the declared region.
          const ssaoUniformPayload = new Float32Array(64);
          ssaoUniformPayload.set(sView as unknown as Float32Array, 0);
          ssaoUniformPayload.set(sProj as unknown as Float32Array, 16);
          ssaoUniformPayload.set(invProjOnly as unknown as Float32Array, 32);
          // intensityPad.x = config.ssao.intensity ?? 1.0 (LO 5.9 default).
          // yzw remain 0 from Float32Array zero-init.
          const ssaoConfig = frameState.installedPipelineConfig?.ssao;
          const intensity =
            ssaoConfig !== undefined && ssaoConfig.enabled === true
              ? (ssaoConfig.intensity ?? 1.0)
              : 1.0;
          ssaoUniformPayload[48] = intensity;

          const ssaoUniformRes = internals.device.queue.writeBuffer(
            ssaoBufs.uniformBuffer,
            0,
            ssaoUniformPayload,
          );
          if (!ssaoUniformRes.ok) internals.errorRegistry.fire(ssaoUniformRes.error);
        }
      }

      void binResult;
    }

    // An unlit material also carries a materialShaderId (extract sets both
    // shadingModel='unlit' and materialShaderId for the renderState-aware
    // pipeline route), so the standard-material test must additionally exclude
    // shadingModel==='unlit' / 'sprite' -- only true standard (lit) materials
    // render black with 0 lights.
    const hasStandardMaterial = renderables.some(
      (r) => r.material.materialShaderId !== undefined && r.material.shadingModel === undefined,
    );
    if (
      skylight === undefined &&
      totalLightCount === 0 &&
      hasStandardMaterial &&
      !frameState.warnedZeroLightStandard
    ) {
      frameState.warnedZeroLightStandard = true;
      const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
      if (env?.env?.NODE_ENV !== 'production') {
        console.warn(
          '[forgeax] standard material renders black with 0 lights of any type (no Skylight, and directional + point + spot all empty); spawn at least one light (Skylight, DirectionalLight, PointLight, or SpotLight) or switch material to shadingModel:"unlit". See AGENTS.md section Breaking changes 2026-05-19.',
        );
      }
    }

    // Case E (this commit): 0 renderables = legitimate scene (LO §1.1
    // hello-window minimum semantic). Mirrors the Case C softening for
    // 0 DirectionalLight (line 134 above; D-Q7). recordFrame() falls
    // through to encode + submit a clear-pass-only render pass so the
    // canvas is painted with `clearColor` even when no entity carries
    // MeshFilter + MeshRenderer. Geometry submission (mat4 uploads,
    // bind-group construction, vertex/index binding, drawIndexed) is
    // conditional on `validatedOrdered.length > 0` further down.

    const pipelineState = internals.getPipelineState();
    if (pipelineState === null) return;

    // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: write the
    // shadowParams UBO bound at viewBg binding 6. 4 lanes x vec4<f32>:
    // lane[shadowAtlasLayer] = (near, far, 1/(far-near), 0). Lanes for
    // non-shadow-casting slots stay zero (the WGSL sample path is gated by
    // PointLight.shadowAtlasLayer >= 0 so a non-shadow light cannot read
    // its lane). Always write the full 64 B so stale non-zero lanes from a
    // previous frame's allocation cannot poison the current frame.
    {
      const SHADOW_PARAMS_LANE_COUNT = 4;
      const SHADOW_PARAMS_FLOATS_PER_LANE = 4;
      const shadowParamsArr = new Float32Array(
        SHADOW_PARAMS_LANE_COUNT * SHADOW_PARAMS_FLOATS_PER_LANE,
      );
      for (let i = 0; i < frameState.pointShadowSnapshots.length; i++) {
        const ps = frameState.pointShadowSnapshots[i];
        if (ps === undefined) continue;
        const layer = ps.shadowAtlasLayer;
        if (layer < 0 || layer >= SHADOW_PARAMS_LANE_COUNT) continue;
        const base = layer * SHADOW_PARAMS_FLOATS_PER_LANE;
        const near = ps.nearPlane;
        const far = ps.farPlane;
        const invSpan = far > near ? 1 / (far - near) : 0;
        shadowParamsArr[base] = near;
        shadowParamsArr[base + 1] = far;
        shadowParamsArr[base + 2] = invSpan;
        shadowParamsArr[base + 3] = 0;
      }
      const shadowParamsWriteRes = internals.device.queue.writeBuffer(
        pipelineState.shadowParamsBuffer,
        0,
        shadowParamsArr,
      );
      if (!shadowParamsWriteRes.ok) {
        internals.errorRegistry.fire(shadowParamsWriteRes.error);
      }
    }

    const canvasContext: RhiCanvasContext | null = internals.context;
    if (canvasContext === null) return;

    const currentTextureResult = canvasContext.getCurrentTexture();
    if (!currentTextureResult.ok) {
      internals.errorRegistry.fire(currentTextureResult.error);
      return;
    }
    // bug-20260519: when the canvas storage format differs from the
    // sRGB-encoding view format, ask for the view explicitly so the GPU
    // performs linear -> sRGB encoding on store. When formats match
    // (offscreen render targets / non-sRGB swap-chains) request the
    // default view to stay compatible with textures created without
    // `viewFormats`.
    const viewDesc =
      pipelineState.colorAttachmentFormat === pipelineState.format
        ? {}
        : { format: pipelineState.colorAttachmentFormat as unknown as GPUTextureFormat };
    const viewResult = internals.device.createTextureView(currentTextureResult.value, viewDesc);
    if (!viewResult.ok) {
      internals.errorRegistry.fire(viewResult.error);
      return;
    }
    const view = viewResult.value;

    // bug-20260519: depth attachment. Allocate a `depth24plus-stencil8` texture sized
    // to the swap-chain texture; recreate when the canvas resizes. The
    // pipelines were upgraded to `depthStencil: { format: 'depth24plus-stencil8',
    // depthWriteEnabled: true, depthCompare: 'less' }` + `cullMode: 'back'`
    // in the same fix; without a depth attachment the renderpass would
    // fail validation. The size mirrors the actual GPU texture, not the
    // CSS-pixel canvas attribute, so HiDPI canvases stay correct.
    const colorTexAny = currentTextureResult.value as unknown as {
      readonly width: number;
      readonly height: number;
    };
    const targetW = colorTexAny.width | 0;
    const targetH = colorTexAny.height | 0;

    // M1 / w7: ensure the per-frame graph is built + compiled before any
    // resource resolution. buildGraph runs once per RenderSystem (memoized on
    // frameState.perFrameGraph; a pipeline swap or shadow-map-size drift nulls
    // it to force a rebuild) and allocates every addColorTarget via
    // compile(device). The view-resolution + passCtx-construction blocks below
    // read the resolved TextureViews from the compiled graph.
    //
    // w7-fix (round 3): the buildGraph call MUST receive a properly typed
    // RenderPipelineData object — the earlier round passed `undefined as
    // RenderPipelineData`, which made any custom pipeline reading
    // `data.config?.passCount` (the AC-03 documented surface) throw a
    // TypeError on `data.config`. Standard-forward also reads `data.shadowMapSize`
    // for shadowDepth sizing. We compute the topology-relevant subset of
    // RenderPipelineData here (camera + targetW/H + skylight + skybox
    // + tonemapActive + shadowMapSize + config) and stub validated /
    // validatedOrdered / skyboxActive / splitLdrSprite as their identity
    // values: those are per-frame *runtime* state, never used to shape
    // graph topology (a topology that branches on them would mean the
    // graph rebuilds every frame, defeating the memoization).
    const earlyTonemapActive = camera.tonemap !== 'none';
    const earlyShadowMapSize = lights.shadowMapSize;
    const earlyCascadeCount = lights.cascadeCount;
    // Drift-rebuild: if the installed shadow map size or cascade count has
    // changed since the last buildGraph, null perFrameGraph so the next
    // buildGraph re-sizes the shadowDepth target. cascadeCount changes the
    // atlas tilesPerSide and the N-pass loop count. The RenderSystem's
    // installed-pipeline-handle change already triggers a similar rebuild on
    // pipeline swap.
    if (
      frameState.perFrameGraph !== null &&
      (pipelineState.perPassResources.shadowMapSize !== (earlyShadowMapSize ?? 0) ||
        pipelineState.perPassResources.shadowCascadeCount !== (earlyCascadeCount ?? 0))
    ) {
      frameState.perFrameGraph = null;
    }
    const earlyData: RenderPipelineData = {
      camera,
      validated: [],
      validatedOrdered: [],
      targetW,
      targetH,
      skylight,
      skylightCount,
      skyboxActive: false,
      skybox,
      tonemapActive: earlyTonemapActive,
      splitLdrSprite: false,
      config: frameState.installedPipelineConfig,
      shadowMapSize: earlyShadowMapSize,
      cascadeCount: earlyCascadeCount,
    };
    // pipelineState carried so buildGraph closures can read the swap-chain
    // colour format (pipelineState.colorAttachmentFormat) when declaring
    // offscreen render targets — a custom pipeline that renders the scene into
    // its own colour target MUST match the geometry PSO format, which follows
    // the UA-preferred canvas format (bgra8unorm-srgb on macOS/Windows since
    // bug-20260612-webgpu-canvas-format-prefer-bgra). The per-frame passCtx
    // below already carries it; the memoized earlyCtx build path did not, so
    // offscreen-RT demos hardcoded rgba8unorm-srgb and broke on BGRA runners
    // (nightly #385/#391).
    const earlyCtx = {
      runtime: internals,
      pipelineState,
      targetW,
      targetH,
    };
    if (frameState.perFrameGraph === null) {
      frameState.perFrameGraph = frameState.activePipeline.buildGraph(
        earlyCtx as unknown as RenderPipelineContext,
        earlyData,
      );
    }
    const perFrameGraph = frameState.perFrameGraph;
    if (perFrameGraph === null) return;

    // Update swap-chain size + recompile on resize.
    const needsRecompile = perFrameGraph.setSwapChainSize(targetW, targetH);
    if (needsRecompile) {
      const rcRes = perFrameGraph.compile({
        backendKind: internals.device.caps.backendKind,
        caps: internals.device.caps,
        device: internals.device,
      });
      if (!rcRes.ok) {
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'render-graph recompile on resize succeeds',
            hint: 'inspect detail.error for the render-graph compile failure code',
            detail: {
              error: {
                code: rcRes.error.code,
                message: `${rcRes.error.code}: ${rcRes.error.expected}`,
              },
            },
          }),
        );
        return;
      }
    }

    // M1 / w7: depth texture owned by render-graph (addColorTarget('depth', ...)).
    // The graph allocates + recompiles on resize; recordFrame reads the resolved
    // TextureView each frame via getColorTargetView.
    //
    // feat-20260609 framebuffers demo M5R2 / T-12-a: the 'depth' name is the
    // urp-pipeline convention; a custom pipeline may declare its own depth
    // target name (e.g. 'offscreenDepth') and route it through addScenePass
    // with `_routeFromOpts: true`. Allow undefined here — the legacy default
    // value of `depthView` reaches recordMainPass only as a fallback when
    // _routeFromOpts is unset (i.e. urp-pipeline path), in which case the
    // urp-pipeline always declares 'depth' and graphDepthView is non-null.
    // For the _routeFromOpts path the override replaces it, so a null carrier
    // is harmless.
    const graphDepthView =
      (frameState.perFrameGraph?.getColorTargetView('depth') as TextureView | undefined) ?? null;
    const depthView: TextureView | null = graphDepthView;
    // feat-20260608-create-app-param-surface-trim / M1 / D-1: clear-color
    // sourced from the active CameraSnapshot SoA columns (first-archetype-hit
    // per OOS-2). When the world had zero Camera entities, `camera` here is
    // the synthetic fallback snapshot built above (Case B), which carries
    // `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]` per D-8.
    const clear: readonly [number, number, number, number] = [
      camera.clearR,
      camera.clearG,
      camera.clearB,
      camera.clearA,
    ];

    // M1 / w7: shadow RT owned by render-graph (addColorTarget('shadowDepth', ...)).
    // The graph's compile phase allocates a depth32float texture; recordFrame reads
    // the resolved TextureView each frame. When shadowMapSize is 0/undefined the
    // shadow pass is skipped entirely (recordShadowPass gates on shadowView).
    const shadowMs = lights.shadowMapSize;
    const shadowView: TextureView | null =
      shadowMs !== undefined && shadowMs > 0
        ? ((frameState.perFrameGraph?.getColorTargetView('shadowDepth') as TextureView) ?? null)
        : null;

    // M1 / w7: write back graph-resolved TextureViews into perPassResources
    // so downstream pass closures (recordMainPass, recordTonemapPass,
    // recordFxaaPass, recordShadowPass, recordSkyboxPass) and the view BG
    // cache construction can read them without changing their own signatures.
    // The graph owns the texture lifecycle; perPassResources holds a cached
    // reference for bindgroup invalidation self-checks (D-3 physical texture
    // identity).
    {
      const graphDepthView = frameState.perFrameGraph?.getColorTargetView('depth') as
        | TextureView
        | undefined;
      if (graphDepthView !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.depthTextureView = graphDepthView as any;
        pipelineState.perPassResources.depthTextureWidth = targetW;
        pipelineState.perPassResources.depthTextureHeight = targetH;
      }
      if (shadowView !== null) {
        // M5-T2: shadow textureView writeback to the ECS-managed slot
        // is removed; downstream consumers (recordFrame view-main b3,
        // recordShadowPass shadowView gate, debugSampleShadowFactor
        // probe) now read directly from the render-graph via
        // `getColorTargetView('shadowDepth')` /
        // `renderSystem.getCurrentShadowView()` (D-2 SSOT). The texture
        // handle writeback below stays — debugReadbackShadowDepth still
        // copies from the GPU Texture, not the view.
        // w7-fix (round 3): also write back the GPU Texture handle. The
        // pre-w7 ensureLazyTexture path wrote both view + texture; w7 only
        // wrote the view, leaving `shadowTexture` null forever and breaking
        // `debugReadbackShadowDepth` (it copies from the texture, not the
        // view). Mirrors the fxaaIntermediateTexture writeback below.
        const graphShadowTex = frameState.perFrameGraph?.getColorTargetTexture('shadowDepth');
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.shadowTexture = graphShadowTex as any;
        pipelineState.perPassResources.shadowMapSize = shadowMs ?? 0;
        pipelineState.perPassResources.shadowCascadeCount = lights.cascadeCount ?? 0;
        // feat-20260613-csm-cascaded-shadow-maps M5 / w28: populate the
        // legacy single-mat4 field (cascade 0 lightViewProj — kept for
        // Inspector backward compatibility) AND the full 4-cascade matrix
        // pack (consumed by debugSampleShadowFactor's CSM-aware probe so
        // worldPos → cascade picking matches the main path's geometry).
        // Both are pre-allocated 64-float arrays (single mat4 / 4 mat4)
        // and overwritten in place each frame.
        const lvp0 = lights.lightViewProj?.[0];
        if (lvp0 !== undefined) {
          pipelineState.perPassResources.shadowLightSpaceMatrix = new Float32Array(lvp0);
        }
        if (lights.lightViewProj !== undefined) {
          const csmPack = new Float32Array(64);
          for (let c = 0; c < 4; c++) {
            const m = lights.lightViewProj[c];
            if (m === undefined) continue;
            for (let i = 0; i < 16; i++) csmPack[c * 16 + i] = m[i] ?? 0;
          }
          pipelineState.perPassResources.shadowCsmLightViewProj = csmPack;
        }
      }
      const graphFxaaView = frameState.perFrameGraph?.getColorTargetView('fxaaIntermediate') as
        | TextureView
        | undefined;
      if (graphFxaaView !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.fxaaIntermediateView = graphFxaaView as any;
        pipelineState.perPassResources.fxaaIntermediateWidth = targetW;
        pipelineState.perPassResources.fxaaIntermediateHeight = targetH;
        // Also write back the GPU Texture handle (needed by recordFxaaPass
        // for encoder.copyTextureToTexture from swap-chain to intermediate).
        const graphFxaaTex = frameState.perFrameGraph?.getColorTargetTexture('fxaaIntermediate');
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.fxaaIntermediateTexture = graphFxaaTex as any;
      }
      const graphHdrView = frameState.perFrameGraph?.getColorTargetView('hdrColor') as
        | TextureView
        | undefined;
      if (graphHdrView !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.hdrColorView = graphHdrView as any;
        pipelineState.perPassResources.hdrTextureWidth = targetW;
        pipelineState.perPassResources.hdrTextureHeight = targetH;
      }
      // Note: hdrDepth, hdrColorMsaa, msaaColor, msaaDepth are written back
      // below after msaaActive/tonemapActive routing, since their per-pass
      // ownership depends on per-frame MSAA/tonemap state.
    }

    // feat-20260519-tonemap-reinhard-mvp / M3 / T-M3.1 + T-M3.3: tone-map
    // routing. When the active camera carries `tonemap !== 'none'` the
    // geometry pass writes into a per-renderer `rgba16float` HDR offscreen
    // attachment (lazily allocated + resized to swap-chain dimensions) and
    // a fullscreen tone-map pass after geometry samples the HDR view +
    // writes the final LDR pixels into the swap-chain `bgra8unorm-srgb`
    // view. When `tonemap === 'none'` the geometry pass writes directly to
    // the swap-chain srgb view (zero-overhead path; AC-03(c)).
    const tonemapActive = camera.tonemap !== 'none';
    // feat-20260531-skybox-env-background M2 / w9: skybox is active when
    // a SkyboxBackground entity is present AND tonemap is active (hdrColor
    // is only allocated when tonemap is on -- plan-strategy D-2 NOTE).
    let skyboxActive = skybox !== undefined && tonemapActive;
    // feat-20260531-skybox-env-background M3 / w20: once-warn when camera
    // tonemap is 'none' but a SkyboxBackground entity exists. The skybox
    // pass requires the HDR render target allocated by the tonemap path;
    // without it the skybox is skipped for this frame. This is a config
    // issue, not a resource-timing issue -- don't fire a structured error
    // (plan-strategy D-2 NOTE, charter P3 non-silent).
    if (skybox !== undefined && !tonemapActive && !frameState.warnedSkyboxTonemapNone) {
      frameState.warnedSkyboxTonemapNone = true;
      console.warn(
        '[forgeax] SkyboxBackground: skybox requires tonemap active (camera.tonemap !== "none") to write HDR target. The skybox pass will be skipped for this frame.',
      );
    }
    // feat-20260531-skybox-env-background M3 / w18: degradation when cubemap
    // GPU view is not ready. getCubemapGpuView returns undefined if the
    // equirect-to-cube upload has not completed yet. Fire structured error
    // and revert to clear colour (charter P3 explicit failure, not silent).
    if (skybox !== undefined && tonemapActive) {
      // biome-ignore lint/suspicious/noExplicitAny: branded Handle cast from snapshot raw number
      const cubemapView = internals.gpuStore.getCubemapGpuView(skybox.cubemapHandle as any);
      if (cubemapView === undefined) {
        skyboxActive = false;
        // Degrade to clear colour background (charter P3 explicit failure).
        // The structured SkyboxCubemapNotReadyError carries the cubemap
        // handle id so AI users can trace the unregistered asset. The onError
        // channel accepts RhiError | RuntimeError, so this fans out with no
        // cast — AI users reach the 'skybox-cubemap-not-ready' arm in an
        // exhaustive switch over the union.
        internals.errorRegistry.fire(new SkyboxCubemapNotReadyError(skybox.cubemapHandle));
      }
    }
    // feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9 (D-6, C-9):
    // MSAA is a per-Camera switch derived from `camera.antialias`, never
    // stored separately. When active the geometry pass writes a count=4
    // multisample colour target and resolves to a single-sample output; the
    // record stage selects the `*Msaa` pipeline variants and the geometry
    // pass attaches the resolve target. When inactive every attachment +
    // pipeline stays single-sample (the pre-MSAA path is byte-for-byte
    // unchanged).
    const msaaActive = camera.antialias === 'msaa';
    let geometryColorView: TextureView | null = view;
    let geometryDepthView: TextureView | null = depthView;
    // Single-sample resolve out for the main colour pass (LDR: swap-chain
    // srgb view; HDR: hdrColorResolve view) + the multisample unorm target
    // for the LDR sprite split sub-pass. Both null when msaaActive is false.
    let geometryColorResolveView: TextureView | null = null;
    let ldrSpriteColorView: TextureView | null = null;
    if (tonemapActive) {
      // M1 / w7: HDR colour + depth textures owned by render-graph.
      // The graph owns all transient targets; recordFrame reads resolved
      // TextureViews each frame via getColorTargetView.
      geometryColorView =
        (frameState.perFrameGraph?.getColorTargetView('hdrColor') as TextureView) ?? view;
      geometryDepthView = msaaActive
        ? ((frameState.perFrameGraph?.getColorTargetView('hdrDepthMsaa') as TextureView) ??
          depthView)
        : ((frameState.perFrameGraph?.getColorTargetView('hdrDepth') as TextureView) ?? depthView);
      if (msaaActive) {
        geometryColorView =
          (frameState.perFrameGraph?.getColorTargetView('hdrColorMsaa') as TextureView) ??
          geometryColorView;
        geometryColorResolveView =
          (frameState.perFrameGraph?.getColorTargetView('hdrColor') as TextureView) ?? view;
      }
    } else if (msaaActive) {
      // M1 / w7: LDR MSAA textures owned by render-graph. The graph
      // allocates a count=4 bgra8unorm texture (msaaColor). The geometry
      // pass needs an srgb view of it (bgra8unorm-srgb) for hardware sRGB
      // encoding; the sprite sub-pass uses the unorm view. Create the
      // srgb view from the graph-owned texture on first use or resize.
      // bug-20260611: WebGL2 fallback path allocates msaaColor without
      // viewFormats so requesting a `*-srgb` view fails; in that case
      // pipelineState.format === pipelineState.colorAttachmentFormat (the
      // surface is already configured as the sRGB storage format directly),
      // so the graph default view IS the sRGB view -- skip the rebuild.
      const msaaColorView = frameState.perFrameGraph?.getColorTargetView(
        'msaaColor',
      ) as TextureView;
      const msaaColorTex = frameState.perFrameGraph?.getColorTargetTexture('msaaColor');
      const srgbReinterpretSupported = pipelineState.format !== pipelineState.colorAttachmentFormat;
      if (
        srgbReinterpretSupported &&
        msaaColorTex !== undefined &&
        (pipelineState.perPassResources.msaaColorView === null ||
          pipelineState.perPassResources.msaaTextureWidth !== targetW ||
          pipelineState.perPassResources.msaaTextureHeight !== targetH)
      ) {
        const srgbViewRes = internals.device.createTextureView(msaaColorTex as never, {
          format: pipelineState.colorAttachmentFormat as unknown as GPUTextureFormat,
        });
        if (srgbViewRes.ok) {
          // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
          pipelineState.perPassResources.msaaColorView = srgbViewRes.value as any;
          pipelineState.perPassResources.msaaTextureWidth = targetW;
          pipelineState.perPassResources.msaaTextureHeight = targetH;
        }
      }
      geometryColorView = srgbReinterpretSupported
        ? pipelineState.perPassResources.msaaColorView
        : msaaColorView;
      geometryDepthView = frameState.perFrameGraph?.getColorTargetView('msaaDepth') as TextureView;
      geometryColorResolveView = view;
      ldrSpriteColorView = msaaColorView;
    }

    // M1 / w7: write back MSAA-dependent graph-resolved views to perPassResources.
    {
      const graphHdrDepthView = frameState.perFrameGraph?.getColorTargetView('hdrDepth') as
        | TextureView
        | undefined;
      if (graphHdrDepthView !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.hdrDepthView = graphHdrDepthView as any;
        pipelineState.perPassResources.hdrDepthSampleCount = msaaActive ? 4 : 1;
      }
      const graphHdrMsaaView = frameState.perFrameGraph?.getColorTargetView('hdrColorMsaa') as
        | TextureView
        | undefined;
      if (graphHdrMsaaView !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.hdrColorMsaaView = graphHdrMsaaView as any;
      }
      const graphMsaaColorView = frameState.perFrameGraph?.getColorTargetView('msaaColor') as
        | TextureView
        | undefined;
      if (graphMsaaColorView !== undefined) {
        // w7-fix (round 3): msaaColor is one count=4 storage texture (bgra8unorm)
        // viewed through TWO formats: bgra8unorm (sprite split sub-pass, no
        // sRGB encoding) and bgra8unorm-srgb (geometry pass, hardware sRGB
        // encoding). The graph publishes the default bgra8unorm view; the
        // LDR-MSAA branch above creates the bgra8unorm-srgb view from the
        // graph-owned texture and stores it as `msaaColorView`. So the
        // sprite-side view is the graph default; the geometry-side view stays
        // whatever the LDR-MSAA branch (or HDR-MSAA path) just installed.
        // Overwriting `msaaColorView` here would drop the srgb view and the
        // geometry pass would attempt to write a bgra8unorm view alongside a
        // bgra8unorm-srgb resolve target, failing colorAttachment/resolveTarget
        // format-match validation.
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.msaaSpriteColorView = graphMsaaColorView as any;
        pipelineState.perPassResources.msaaTextureWidth = targetW;
        pipelineState.perPassResources.msaaTextureHeight = targetH;
      }
      const graphMsaaDepthView = frameState.perFrameGraph?.getColorTargetView('msaaDepth') as
        | TextureView
        | undefined;
      if (graphMsaaDepthView !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: opaque RHI handle
        pipelineState.perPassResources.msaaDepthView = graphMsaaDepthView as any;
      }
    }

    // Validate renderable handles + collect render plan. Empty `renderables`
    // input or all-unregistered handles both produce `validatedOrdered.length === 0`,
    // which is the Case E (clear-pass-only) path.
    //
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (@new-surface): per-entry
    // `renderableIndex` tracks the position into the original renderables[]
    // array so the bucket-aware reordering below can correlate
    // transparent-sort output (TransparentEntry.renderableIndex) back to
    // the validated row.
    // bug-20260527-renderstate-pipeline-dispatch-gap D-4:
    // build a renderableIndex -> renderState map from dispatch entries
    // so each ValidatedRenderable carries its per-material renderState
    // override without an O(n^2) back-scan in the draw loop.
    const renderStateByRenderableIdx = new Map<number, MaterialRenderState | undefined>();
    for (const de of transparentDispatch) {
      if (de.renderableIndex !== undefined) {
        renderStateByRenderableIdx.set(de.renderableIndex, de.renderState);
      }
    }
    // w10: also build a renderableIndex -> stencilReference map from
    // dispatch entries for per-draw setStencilReference calls.
    const stencilRefByRenderableIdx = new Map<number, number | undefined>();
    for (const de of transparentDispatch) {
      if (de.renderableIndex !== undefined) {
        stencilRefByRenderableIdx.set(de.renderableIndex, de.stencilReference);
      }
    }
    const validated: ValidatedRenderable[] = [];
    for (let rIdx = 0; rIdx < renderables.length; rIdx++) {
      const r = renderables[rIdx];
      if (r === undefined) continue;
      const assetRes = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(r.assetHandle));
      if (!assetRes.ok) {
        internals.errorRegistry.fire(
          new RhiError({
            code: 'asset-not-registered',
            expected: 'MeshFilter.assetHandle in AssetRegistry',
            hint: 'use HANDLE_CUBE / HANDLE_TRIANGLE imports; custom mesh register path: feat-future-asset-system',
            detail: { assetHandle: r.assetHandle },
          }),
        );
        continue;
      }
      // feat-20260601-gpu-resource-store-extraction M1 (D-1): builtin meshes
      // (ids 1-4: CUBE/TRIANGLE/QUAD/SPHERE) keep the createRenderer step-3
      // direct-upload + `pipelineState.meshes` path -- they are NOT routed
      // through `ensureResident`. User-registered meshes pull through the store
      // on first access (the register->upload push was severed in this M1);
      // the POD fetched above (assetRes.value) is passed in, store holds no
      // registry ref (D-2). A first-access miss builds the GPU buffers; later
      // frames hit the O(1) cache.
      const meshAssetHandle = toShared<'MeshAsset'>(r.assetHandle);
      let meshHandles = internals.gpuStore.getMeshGpuHandles(meshAssetHandle);
      if (meshHandles === undefined && r.assetHandle > BUILTIN_MESH_ID_MAX) {
        const residentRes = internals.gpuStore.ensureResident(meshAssetHandle, assetRes.value);
        if (residentRes.ok) {
          meshHandles = residentRes.value;
        } else if (residentRes.error instanceof RhiError) {
          internals.errorRegistry.fire(residentRes.error);
        }
      }
      meshHandles = meshHandles ?? pipelineState.meshes.get(r.assetHandle);
      if (meshHandles === undefined) {
        internals.errorRegistry.fire(
          new RhiError({
            code: 'asset-not-registered',
            expected: 'GPU mesh buffers uploaded for assetHandle',
            hint: 'await renderer.ready before draw(world); ensure AssetRegistry.configureGpuDevice ran so user meshes are uploaded',
            detail: { assetHandle: r.assetHandle },
          }),
        );
        continue;
      }
      // feat-20260527-sprite-nineslice M2 / w11 (plan-strategy §D-2):
      // sprite branch with non-zero `slices` overrides the user-supplied
      // mesh handle (typically HANDLE_QUAD = 3) with the 16-vertex / 54-index
      // HANDLE_NINESLICE_QUAD (id=5) topology so the vertex shader sees the
      // 4×4 grid required for 9-region anchor mapping. Default slices
      // ([0, 0, 0, 0]) keeps the legacy HANDLE_QUAD path; a flip from
      // zero to non-zero on the same entity routes here per-frame so AI
      // users can toggle 9-slice on the fly without re-spawning the entity
      // (charter F1 minimum surface). The HANDLE_NINESLICE_QUAD GPU buffers
      // are seeded by createRenderer step-3 (w12 patch).
      let effectiveMeshHandles = meshHandles;
      if (r.material.shadingModel === 'sprite') {
        const slicesArr = r.material.spriteFields?.slices;
        if (
          slicesArr !== undefined &&
          (slicesArr[0] !== 0 || slicesArr[1] !== 0 || slicesArr[2] !== 0 || slicesArr[3] !== 0)
        ) {
          const nineSliceHandles = pipelineState.meshes.get(NINESLICE_QUAD_RAW_ID);
          if (nineSliceHandles !== undefined) {
            effectiveMeshHandles = nineSliceHandles;
          }
        }
      }
      validated.push({
        source: r,
        mesh: effectiveMeshHandles,
        renderableIndex: rIdx,
        renderState: renderStateByRenderableIdx.get(rIdx),
        stencilReference: stencilRefByRenderableIdx.get(rIdx),
      });
    }

    // ── feat-20260531-per-frame-bind-group-cache M4 / w14 ────────────
    // D-5 per-frame clean-up at recordFrame entry: drop cache entries
    // whose key is not in the current validated renderables set. This
    // prevents unbounded growth after entity despawn.
    //
    // Build a Set<number> of entityKeys from the validated renderables.
    // The entityKey is the packed Entity u32 (encodeEntity(indexSlot,
    // generation)) surfaced by D-1.  Entries in the per-entity caches
    // (materialBgCache, instancesBgCache) whose entityKey segment is NOT
    // in this set are orphaned — their entity has been despawned — and
    // must be dropped.
    //
    // view + mesh caches are frame-shared (no entityKey component), so
    // they are not subject to per-entity clean-up.  Their keys contain
    // GPU resource handle ids, and the caches are naturally bounded by
    // the fixed number of GPU resource combinations.
    const validatedEntityKeys = new Set<number>();
    for (const v of validated) {
      validatedEntityKeys.add(v.source.entityKey);
    }

    // Clean per-entity material BG cache: drop entries whose entityKey
    // segment is absent from the current validated set.
    cleanPerEntityCache(frameState.materialBgCache, validatedEntityKeys, 'material');

    // Clean per-entity instances BG cache.
    cleanPerEntityCache(frameState.instancesBgCache, validatedEntityKeys, 'instances');

    // viewBindGroupCache + meshBindGroupCache are frame-shared (keyed by
    // GPU resource handle ids, no entityKey).  GPU resources are created
    // once at init-time and their handle references are immutable — the
    // cache is naturally bounded.  No per-frame clean-up needed.

    // D-5 retrofit: instanceBuffers clean-up.  The instanceBuffers Map is
    // keyed by `encacheKey` (packed Entity u32, same as entityKey on
    // RenderableSnapshot).  Drop entries whose key is no longer in the
    // validated set — this retrofits the same per-frame clean-up policy
    // onto the pre-existing cache (which previously had no clean-up at
    // all, OQ-3 / R-4).
    //
    // feat-20260619 M4 / F11: destroy the GPU buffer before Map.delete so
    // despawned entities release their instance-buffer backing memory
    // symmetrically (D-6). Failure fires errorRegistry + continues sweep.
    for (const [key, entry] of frameState.instanceBuffers.entries()) {
      if (!validatedEntityKeys.has(key)) {
        if (!entry.buffer.isDestroyed) {
          const r = entry.buffer.destroy();
          if (!r.ok) internals.errorRegistry.fire(r.error);
        }
        frameState.instanceBuffers.delete(key);
      }
    }

    // M3 / w26: dispatch-ordered render. The dispatch list is pre-sorted
    // by queue (ascending, stable) by the extract stage per plan-strategy D-3.
    // Reorder validated renderables to follow the dispatch order, falling
    // back to extract order for renderables with no matching dispatch entry.
    let validatedOrdered: ValidatedRenderable[] = validated;
    if (transparentDispatch.length > 0) {
      const validatedByRenderableIdx = new Map<number, ValidatedRenderable>();
      const seen = new Set<number>();
      for (const v of validated) {
        validatedByRenderableIdx.set(v.renderableIndex, v);
      }
      const ordered: ValidatedRenderable[] = [];
      for (const de of transparentDispatch) {
        if (de.renderableIndex === undefined) continue;
        const v = validatedByRenderableIdx.get(de.renderableIndex);
        if (v !== undefined && !seen.has(de.renderableIndex)) {
          seen.add(de.renderableIndex);
          ordered.push(v);
        }
      }
      // Append any renderables not in the dispatch list (e.g. default-material entities)
      for (const v of validated) {
        if (!seen.has(v.renderableIndex)) {
          ordered.push(v);
        }
      }
      validatedOrdered = ordered;
    }

    // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
    // ensure the mesh-SSBO + material-UBO buffer pair is large enough to hold
    // `validatedOrdered.length` slots BEFORE the first per-entity writeBuffer
    // (line 1786 below). On `ok:false` the controller has already fired a
    // structured RuntimeError (`mesh-ssbo-ceiling-reached` /
    // `mesh-ssbo-capacity-exceeded`); we early-return the frame: 0
    // writeBuffer + 0 draw + no pass record (AC-08, no truncation). The
    // helper is idempotent across same-frame re-calls (AC-09) and
    // short-circuits on length=0 / length<=slotCount (boundary table).
    //
    // bug-20260609: feat-20260608 M5 amend made the material UBO indexed by
    // cumulative *material-slot* count (one slot per submesh material),
    // which is >= entity count once any entity carries `materials.length>1`.
    // The mesh + material buffer pair share `slotCount` (single allocator),
    // so we size against the larger of the two requirements: entity count
    // (mesh-SSBO consumer) vs cumulative material-slot count (material-UBO
    // consumer). Sprite entities collapse to 1 slot per the materialSlotStart
    // computation below, mirroring the same rule (sprite per-submesh OOS-1).
    let neededMaterialSlots = 0;
    for (const e of validatedOrdered) {
      if (e === undefined) continue;
      neededMaterialSlots +=
        e.source.material.shadingModel === 'sprite' ? 1 : e.source.materials.length;
    }
    const neededSlots = Math.max(validatedOrdered.length, neededMaterialSlots);
    const meshSsboCapResult = ensureMeshSsboCapacity(internals, neededSlots);
    if (!meshSsboCapResult.ok) {
      return;
    }

    // D-2 (bug-20260527): LDR sprite pass split.
    // When the LDR path (tonemapActive=false) has sprite entities in the
    // validated draw list, the render is split into two serial passes sharing
    // the same swap-chain texture:
    //   geometry pass — sRGB view (bgra8unorm-srgb), loadOp=clear, non-sprite entities
    //   sprite pass   — unorm view (bgra8unorm), loadOp=load, sprite entities
    // The sprite LDR pipeline targets bgra8unorm (blendable; D-1) so it cannot
    // share the same render pass with the bgra8unorm-srgb–targeted geometry
    // pipelines (WebGPU requires attachment view format == pipeline target
    // format). bgra8unorm is the storage format of the swap-chain texture and
    // is always a valid view format (spec: storage format is implicitly in
    // viewFormats); no viewFormats change needed (D-4).
    const splitLdrSprite =
      !tonemapActive &&
      validatedOrdered.some((v) => v !== undefined && v.source.material.shadingModel === 'sprite');
    let ldrSpriteUnormView: TextureView | null = null;
    if (splitLdrSprite) {
      const unormViewRes = internals.device.createTextureView(currentTextureResult.value, {});
      if (!unormViewRes.ok) {
        internals.errorRegistry.fire(unormViewRes.error);
        return;
      }
      ldrSpriteUnormView = unormViewRes.value;
    }

    // View / mesh uniform uploads are only needed when geometry will be drawn,
    // OR when a skybox is active (skybox pass reads inverseViewProj from
    // the View UBO). Skip the writeBuffer round-trips on the Case E
    // (clear-pass-only) path only when neither condition is met.
    // feat-20260531-skybox-env-background M2 / w6: gate relaxed from
    // `validatedOrdered.length > 0` to include skybox-only frames
    // (plan-strategy D-3, R-3).
    if (validatedOrdered.length > 0 || skyboxActive) {
      // Compose worldViewProj once per frame (view * proj).
      const projMatrix = computeProjectionMatrix(camera);
      const viewMatrix = computeViewMatrix(camera);
      const worldViewProj = mat4.create();
      mat4.multiply(worldViewProj, projMatrix, viewMatrix);

      // feat-20260518 M3 / w14 (AC-07 / AC-09): build the full view UBO payload.
      // Pre-w7: 28 floats (112 B). Post-w7: 44 floats (176 B) with
      // lightSpaceMatrix mat4 at tail (offset 112, 64 B). Single
      // queue.writeBuffer covers the whole payload (one round-trip
      // per frame, charter P5 consistent abstraction).
      // Outgoing-direction convention (DirectionalLight @semantics
      // outgoing): the host uploads light.direction verbatim; the shader
      // negates it internally via `let l = normalize(-view.lightDir)` to
      // get the L vector for BRDF (single SSOT, no double-negation).
      //
      // feat-20260520-directional-light-shadow-mapping M1b / w7:
      // viewPayload widened to 148 floats (592 B) to carry CSM fields
      // (feat-20260613-csm-cascaded-shadow-maps M4 / w16+w25).
      // Layout matches common.wgsl View struct byte-for-byte:
      //   [ 0..15] worldViewProj, [16..18] lightDir, [20..22] lightColor,
      //   [24..26] cameraPos, [28..43] lightViewProj0 (was lightSpaceMatrix),
      //   [44..59] inverseViewProj, [60..75] lightViewProj1,
      //   [76..91] lightViewProj2, [92..107] lightViewProj3,
      //   [108]/[112]/[116]/[120] splitPlanes (vec4 stride),
      //   [124] cascadeCount, [125] cascadeBlend, [126] pcfKernelSize,
      //   [127..147] tail pad.
      const VIEW_PAYLOAD_FLOATS = 148;
      const viewPayload = new Float32Array(VIEW_PAYLOAD_FLOATS);
      for (let i = 0; i < 16; i++) viewPayload[i] = (worldViewProj as unknown as number[])[i] ?? 0;
      viewPayload[16] = (light.direction[0] ?? 0) * light.intensity;
      viewPayload[17] = (light.direction[1] ?? -1) * light.intensity;
      viewPayload[18] = (light.direction[2] ?? 0) * light.intensity;
      viewPayload[20] = light.color[0] ?? 0;
      viewPayload[21] = light.color[1] ?? 0;
      viewPayload[22] = light.color[2] ?? 0;
      viewPayload[24] = camera.position[0] ?? 0;
      viewPayload[25] = camera.position[1] ?? 0;
      viewPayload[26] = camera.position[2] ?? 0;
      // lightViewProj[0] at [28..43] (replaces lightSpaceMatrix).
      if (lights.lightViewProj !== undefined && lights.lightViewProj[0] !== undefined) {
        for (let i = 0; i < 16; i++) viewPayload[28 + i] = lights.lightViewProj[0][i] ?? 0;
      }
      // inverseViewProj at [44..59] — unchanged position.
      // Host pre-computes mat4.invert so the skybox fragment shader avoids
      // per-pixel matrix inversion (charter P4 consistent abstraction).
      const inverseViewProj = mat4.create();
      mat4.invert(inverseViewProj, worldViewProj);
      for (let i = 0; i < 16; i++)
        viewPayload[44 + i] = (inverseViewProj as unknown as number[])[i] ?? 0;
      // lightViewProj[1..3] at [60..107].
      if (lights.lightViewProj !== undefined) {
        for (let c = 1; c <= 3; c++) {
          const base = 60 + (c - 1) * 16;
          const lvp = lights.lightViewProj[c];
          if (lvp !== undefined) {
            for (let i = 0; i < 16; i++) viewPayload[base + i] = lvp[i] ?? 0;
          }
        }
      }
      // splitPlanes at [108], [112], [116], [120] (vec4 stride = 4 floats).
      if (lights.splitPlanes !== undefined) {
        for (let s = 0; s < 4; s++) {
          viewPayload[108 + s * 4] = lights.splitPlanes[s] ?? 0;
        }
      }
      // cascadeCount / cascadeBlend at [124..125].
      viewPayload[124] = lights.cascadeCount ?? 0;
      viewPayload[125] = lights.cascadeBlend ?? 0;
      // feat-20260621-learn-render-5-3-production-shadow-demos M0 / AC-14:
      // pcfKernelSize at [126] (first tail-pad slot, plan-strategy D-0). The
      // WGSL View struct (common.wgsl) reads this lane; 0 when no shadow
      // component (lighting-directional.wgsl clamps to a single tap).
      viewPayload[126] = lights.pcfKernelSize ?? 0;

      const viewUploadResult = internals.device.queue.writeBuffer(
        pipelineState.viewUniformBuffer,
        0,
        viewPayload,
      );
      if (!viewUploadResult.ok) throw viewUploadResult.error;

      // feat-20260519-light-casters-point-spot-pbr M3 / w20 (D-S1 + D-S2 +
      // D-S6): per-frame full rewrite of the PointLight + SpotLight std430
      // storage buffers. Header (16 B count u32 + 12 B pad) at offset 0 +
      // first-slice cap N=4 slots packed sequentially. The N>4 fail-fast
      // upstream (line 161 onward) ensures `lights.point.length` /
      // `lights.spot.length` <= 4 by the time we reach here when the
      // listener registry consumed the structured error; the slice keeps
      // the buffer write bounded even if downstream listeners ignore the
      // RhiError (charter P9 graceful degradation: surplus entities are
      // dropped, frame still records).
      const pointSlots = lights.point.slice(0, LIGHT_ARRAY_MAX_SLOTS);
      const pointHeader = packLightArrayHeader(pointSlots.length);
      const pointHeaderUpload = internals.device.queue.writeBuffer(
        pipelineState.pointLightsBuffer,
        0,
        new Uint8Array(pointHeader),
      );
      if (!pointHeaderUpload.ok) throw pointHeaderUpload.error;
      for (let i = 0; i < pointSlots.length; i++) {
        const slot = pointSlots[i];
        if (slot === undefined) continue;
        const packed = packPointLight(slot);
        const offset = LIGHT_ARRAY_HEADER_BYTES + i * POINT_LIGHT_STD430_BYTES;
        const writeRes = internals.device.queue.writeBuffer(
          pipelineState.pointLightsBuffer,
          offset,
          packed,
        );
        if (!writeRes.ok) throw writeRes.error;
      }
      const spotSlots = lights.spot.slice(0, LIGHT_ARRAY_MAX_SLOTS);
      const spotHeader = packLightArrayHeader(spotSlots.length);
      const spotHeaderUpload = internals.device.queue.writeBuffer(
        pipelineState.spotLightsBuffer,
        0,
        new Uint8Array(spotHeader),
      );
      if (!spotHeaderUpload.ok) throw spotHeaderUpload.error;
      for (let i = 0; i < spotSlots.length; i++) {
        const slot = spotSlots[i];
        if (slot === undefined) continue;
        const packed = packSpotLight(slot);
        const offset = LIGHT_ARRAY_HEADER_BYTES + i * SPOT_LIGHT_STD430_BYTES;
        const writeRes = internals.device.queue.writeBuffer(
          pipelineState.spotLightsBuffer,
          offset,
          packed,
        );
        if (!writeRes.ok) throw writeRes.error;
      }

      // Per-renderable entity_world upload: one mat4 written to slot
      // `i * MESH_PER_ENTITY_STRIDE` in the shared meshStorageBuffer.
      // feat-20260518 M3 / w14 (AC-08): each slot ALSO carries a 48-byte
      // mat3 normalMatrix at offset 64 (3 vec4 columns; pads each column
      // to 16 B per std140). The mat3 = transpose(invert(mat3(worldFromLocal)))
      // lets the fragment shader transform normals correctly under
      // non-uniform scale. The host computes once per renderable per
      // frame using `mat3.normalMatrix` (math package SSOT helper).
      for (let i = 0; i < validatedOrdered.length; i++) {
        const entry = validatedOrdered[i];
        if (entry === undefined) continue;
        // feat-20260601 D-3: the world mat4 is the resolved `Transform.world`
        // view (propagateTransforms output) carried verbatim on the snapshot;
        // copy the 16 floats straight into the SSBO slot with zero `mat4.compose`
        // (AC-07). The normal matrix is derived from the same world mat4.
        const worldFromLocal = entry.source.transform.world;
        // Build a 28-float (112 byte) slot: [0..16) mat4 + [16..28) mat3
        // padded as 3 vec4 (12 floats; columns 0/1/2 at slot offsets
        // 16/20/24; padding at indices 19/23/27 stays 0).
        const slot = new Float32Array(28);
        for (let k = 0; k < 16; k++) slot[k] = worldFromLocal[k] ?? 0;
        const normal = mat3.normalMatrix(
          mat3.create(),
          worldFromLocal as unknown as Parameters<typeof mat3.normalMatrix>[1],
        );
        // mat3 column 0 -> slot[16..19]
        slot[16] = normal[0] ?? 0;
        slot[17] = normal[1] ?? 0;
        slot[18] = normal[2] ?? 0;
        // mat3 column 1 -> slot[20..23]
        slot[20] = normal[3] ?? 0;
        slot[21] = normal[4] ?? 0;
        slot[22] = normal[5] ?? 0;
        // mat3 column 2 -> slot[24..27]
        slot[24] = normal[6] ?? 0;
        slot[25] = normal[7] ?? 0;
        slot[26] = normal[8] ?? 0;

        const meshUpload = internals.device.queue.writeBuffer(
          pipelineState.meshStorageBuffer.buffer,
          i * MESH_PER_ENTITY_STRIDE,
          slot,
        );
        if (!meshUpload.ok) throw meshUpload.error;
      }
    }

    const encoderResult = internals.device.createCommandEncoder({ label: 'render-system-frame' });
    if (!encoderResult.ok) {
      internals.errorRegistry.fire(encoderResult.error);
      return;
    }
    const encoder: RhiCommandEncoder = encoderResult.value;

    // ── feat-20260531-per-frame-bind-group-cache M2 / w7-w8 ────────
    // Per-frame bind group caches (D-2 handle-set keys, D-4
    // RenderFrameState host). Each call site below uses
    // getOrCreateBindGroup to: (1) build a deterministic cache key from
    // variant discriminator + ordered bound resource handles, (2) lookup
    // the cache Map, (3) hit = reuse, miss = factory create + bump
    // bindGroupCounts.createBindGroup + store.
    //
    // View main (#1) key = 'view-main' + ids of b0(viewUniformBuffer),
    // b1(pointLightsBuffer), b2(spotLightsBuffer), b3(graph shadowDepth
    // view or shadowFallbackTextureView), b4(shadowSampler).
    // Mesh (#2) key = 'mesh' + id of b0(meshStorageBuffer).
    let viewBindGroup: BindGroup | null = null;
    let meshBindGroup: BindGroup | null = null;
    // feat-20260609-hdrp-cluster-fragment-ggx M4 / w19: HDRP unified group(2)
    // BindGroup. Non-null when `frameState.isHdrpActive` AND HDRP buffer
    // allocation succeeded; consumed by recordMainPass at `setBindGroup(2, ...)`.
    let hdrpClusterBindGroup: BindGroup | null = null;
    if (validated.length > 0) {
      // M5-T1: shadow atlas view sourced directly from render-graph
      // (`addColorTarget('shadowDepth', ...)` declared in `urp-pipeline.ts`).
      // Graph owns the texture lifecycle; record-stage reads the resolved
      // view each frame (D-2 SSOT). When the graph has not allocated the
      // target (no DirectionalLightShadow wired or shadowMapSize=0),
      // `getColorTargetView` returns undefined and we fall through to the
      // 1x1 fallback view that keeps the BGL satisfied.
      const graphShadowView = frameState.perFrameGraph?.getColorTargetView('shadowDepth') as
        | TextureView
        | undefined;
      const b3View =
        graphShadowView !== undefined ? graphShadowView : pipelineState.shadowFallbackTextureView;
      // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1: bind the real
      // ShadowAtlas cube_array view when point shadows are active in this
      // frame; otherwise the 1x1x6 fallback (cleared to 1.0 = fully lit).
      const pointShadowAtlas = frameState.pointShadowAtlas;
      const atlasViewMaybe = pointShadowAtlas?.isAllocated()
        ? pointShadowAtlas.getAtlasView()
        : null;
      const b5View =
        atlasViewMaybe !== null ? atlasViewMaybe : pipelineState.shadowAtlasFallbackTextureView;
      const viewKey = buildBindGroupCacheKey(
        'view-main',
        [
          pipelineState.viewUniformBuffer as unknown as object,
          pipelineState.pointLightsBuffer as unknown as object,
          pipelineState.spotLightsBuffer as unknown as object,
          b3View as unknown as object,
          pipelineState.perPassResources.shadowSampler as unknown as object,
          b5View as unknown as object,
          pipelineState.shadowParamsBuffer as unknown as object,
        ],
        frameState,
      );
      viewBindGroup = getOrCreateBindGroup(
        frameState.viewBindGroupCache,
        viewKey,
        () => {
          const viewBindGroupResult = internals.device.createBindGroup({
            label: 'pbr-view-bg',
            layout: pipelineState.viewBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.viewUniformBuffer },
                },
              },
              {
                binding: 1,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.pointLightsBuffer },
                },
              },
              {
                binding: 2,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.spotLightsBuffer },
                },
              },
              {
                binding: 3,
                resource: {
                  kind: 'textureView',
                  value: b3View,
                },
              },
              {
                binding: 4,
                resource: {
                  kind: 'sampler',
                  value: pipelineState.perPassResources.shadowSampler,
                },
              },
              // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1:
              // cube_array shadow atlas view (real ShadowAtlas when point
              // shadows are active; else 1x1x6 fallback).
              {
                binding: 5,
                resource: {
                  kind: 'textureView',
                  value: b5View,
                },
              },
              // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1:
              // shadowParams UBO (`array<vec4<f32>, 4>` = 64 B). Lane N
              // stores `(near, far, 1/(far-near), 0)` for the point light
              // with shadowAtlasLayer === N. Updated per frame from
              // `pointShadowSnapshots` below.
              {
                binding: 6,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.shadowParamsBuffer },
                },
              },
              // feat-20260613-csm-cascaded-shadow-maps M5 / w28 (rebased to
              // binding 7 on 2026-06-13 to make room for point-shadow 5/6):
              // forward shaders declare binding 7 in common.wgsl (shared
              // view BGL) but never reference it; only shadow_caster.wgsl
              // reads it. Host writes a stable singleton buffer so every
              // forward bind group entry stays populated.
              {
                binding: 7,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.shadowCasterCascadeBuffer },
                },
              },
            ],
          });
          if (!viewBindGroupResult.ok) throw viewBindGroupResult.error;
          return viewBindGroupResult.value;
        },
        bindGroupCounts,
      );

      // M3 / T-M3-04 (R1 grep gate): pass the inner `.buffer` to handle-id
      // assignment so the cache key tracks the underlying GPU buffer
      // identity. The wrapper object's identity is stable across grow
      // events; passing the wrapper would defeat AC-07 cache invalidation.
      const meshKey = buildBindGroupCacheKey(
        'mesh',
        [pipelineState.meshStorageBuffer.buffer as unknown as object],
        frameState,
      );
      meshBindGroup = getOrCreateBindGroup(
        frameState.meshBindGroupCache,
        meshKey,
        () => {
          // bug-20260610: WebGL2 fallback path needs the binding to cover the
          // whole `array<Mesh, 128>` uniform buffer (14336 B) instead of a
          // single dynamic-offset slot (112 B). `caps.storageBuffer === false`
          // is the same proxy createRenderer uses to pick the uniform variant.
          const meshBindSize = internals.device.caps.storageBuffer
            ? MESH_SSBO_BYTES
            : MESH_UBO_FULL_ARRAY_BYTES;
          const meshBindGroupResult = internals.device.createBindGroup({
            label: 'pbr-mesh-bg',
            layout: pipelineState.meshBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: pipelineState.meshStorageBuffer.buffer,
                    offset: 0,
                    size: meshBindSize,
                  },
                },
              },
            ],
          });
          if (!meshBindGroupResult.ok) throw meshBindGroupResult.error;
          return meshBindGroupResult.value;
        },
        bindGroupCounts,
      );

      // feat-20260609-hdrp-cluster-fragment-ggx M4 / w19: when HDRP is active,
      // build the unified group(2) BindGroup that carries the mesh SSBO at
      // binding 0 + the 4 cluster buffers at bindings 3..6. The bindGroup
      // shares the mesh SSBO with URP's `meshBindGroup` (same `meshStorageBuffer.buffer`
      // + same per-entity stride), so the dynamic offset issued at
      // `setBindGroup(2, ...)` covers binding 0 of either layout. Cached
      // alongside `meshBindGroupCache` keyed on the mesh SSBO + cluster
      // buffer identities; cache invalidates on a buffer-grow event the same
      // way the mesh path does (handle id rotation).
      if (frameState.isHdrpActive) {
        const hdrpBuffers = getOrCreateHdrpBuffers(
          internals,
          frameState.installedPipelineConfig?.clusterGrid,
        );
        if (hdrpBuffers !== null) {
          const hdrpKey = buildBindGroupCacheKey(
            'hdrp-unified',
            [
              pipelineState.meshStorageBuffer.buffer as unknown as object,
              hdrpBuffers.lightDataBuffer as unknown as object,
              hdrpBuffers.clusterGridBuffer as unknown as object,
              hdrpBuffers.lightIndexListBuffer as unknown as object,
              hdrpBuffers.clusterUniformBuffer as unknown as object,
            ],
            frameState,
          );
          hdrpClusterBindGroup = getOrCreateBindGroup(
            frameState.meshBindGroupCache,
            hdrpKey,
            () => {
              const bg = createHdrpUnifiedBindGroup(
                internals,
                hdrpBuffers,
                pipelineState.meshStorageBuffer.buffer,
              );
              if (bg === null) {
                throw new RhiError({
                  code: 'webgpu-runtime-error',
                  expected: 'HDRP unified BindGroup creation succeeds when HDRP is active',
                  hint: 'inspect prior errorRegistry events for createBindGroup failure detail',
                });
              }
              return bg;
            },
            bindGroupCounts,
          );
        }
      }
    }

    // ── feat-20260529-rendergraph-pass-abstraction M4 / w13b ───────────
    // Declarative render-graph drives the per-frame passes. The graph
    // orchestrates which pass execute closures run (topological order from
    // reads/writes); each closure calls the verbatim-extracted pass
    // recorder with the shared RenderPipelineContext. All 4 per-frame passes
    // (shadow / main / tonemap / FXAA) now run as graph execute closures
    // (AC-04); graph.execute is the sole frame-recording path (AC-05).
    //
    // Encoder semantics (RD-4): the shadow closure opens its OWN command
    // encoder + queue.submit (manual barrier for depth write -> sample);
    // main/tonemap/FXAA share `encoder` (passCtx.encoder), finished +
    // submitted once at frame end.
    // feat-20260601 M2 / w12: the per-frame shared state is the clean
    // `RenderPipelineContext` - `internals` is replaced by the named `assets`
    // (CPU POD) / `store` (GPU residency) / `pipelineState` / `runtime` (device +
    // errorRegistry + shader-cache lookups) surfaces (`internals` itself satisfies
    // `RenderSystemRuntime` so `runtime: internals` is a zero-cost reference). The
    // 0-consumed `skyboxCount` residual is dropped.
    const passCtx: _InternalRenderPipelineContext = {
      assets: internals.assets,
      world,
      store: internals.gpuStore,
      pipelineState,
      runtime: internals,
      encoder,
      view,
      clear,
      targetW,
      targetH,
      currentTexture: currentTextureResult.value,
      camera,
      tonemapActive,
      geometryColorView,
      geometryDepthView,
      validated,
      validatedOrdered,
      viewBindGroup,
      meshBindGroup,
      frameState,
      dispatchCounts,
      bindGroupCounts,
      skylight,
      skylightCount,
      skyboxActive,
      skybox,
      splitLdrSprite,
      ldrSpriteUnormView,
      msaaActive,
      geometryColorResolveView,
      ldrSpriteColorView,
      postProcessParams,
      dispatch: transparentDispatch,
      hdrpClusterBindGroup,
    };
    // feat-20260601 M2 / w12 (D-B): the per-frame projected snapshot handed to
    // `buildGraph` as the second argument. Cross-frame-stable deps live on ctx;
    // these per-frame recomputed quantities live on data (the standard forward
    // pipeline's topology is frame-invariant so it ignores `data`; a custom
    // pipeline can shape its graph from it).
    const passData: RenderPipelineData = {
      camera,
      validated,
      validatedOrdered,
      targetW,
      targetH,
      skylight,
      skylightCount,
      skyboxActive,
      skybox,
      tonemapActive,
      splitLdrSprite,
      // feat-20260601 verify round 2 (D-C): the install-time config of the currently
      // active pipeline, threaded through `installPipeline` -> frameState ->
      // `buildGraph(ctx, data)`. A custom pipeline reads `data.config?.passCount` to size
      // its declared pass chain; the standard forward pipeline ignores it.
      config: frameState.installedPipelineConfig,
      // w7-fix (round 3): ECS-driven shadow map size for the urp
      // pipeline's shadowDepth color target sizing.
      shadowMapSize: lights.shadowMapSize,
      // M3 / w12: cascade count for atlas sizing + N-pass loop.
      cascadeCount: lights.cascadeCount,
    };

    // Build + compile the per-frame graph once per RenderSystem (memoized); see
    // RenderFrameState.perFrameGraph JSDoc for the timing-flake rationale.
    // feat-20260601 M1 / w7: the graph is built through the currently installed
    // RenderPipeline (forgeax::urp by default). `draw` nulls
    // perFrameGraph on a pipeline swap so the next frame rebuilds via the new impl
    // (hot-swap); effect toggles do not null it.
    if (frameState.perFrameGraph === null) {
      frameState.perFrameGraph = frameState.activePipeline.buildGraph(passCtx, passData);
    }
    const graph = frameState.perFrameGraph;
    if (graph === null) return;
    graph.execute(passCtx);

    const finishResult = encoder.finish();
    if (!finishResult.ok) {
      internals.errorRegistry.fire(finishResult.error);
      return;
    }
    const cmd: CommandBuffer = finishResult.value;
    const submitResult = internals.device.queue.submit([cmd]);
    if (!submitResult.ok) {
      internals.errorRegistry.fire(submitResult.error);
      return;
    }
    // bug-20260622 D-3: reclaim retired transient textures after the main
    // queue.submit. Fire-and-forget with .catch — the async
    // onSubmittedWorkDone may resolve after the renderer/device is disposed
    // (e.g. test teardown), at which point the WASM instance / queue ref is
    // no longer valid; we swallow the post-dispose rejection.
    graph.reclaimRetiredTransients().catch(() => {});
  } finally {
    frameState.frameNumber += 1;
    // feat-20260608-cluster-lighting M5 / w22: clear HDRP once-per-frame fired
    // set so the next frame re-fires if the condition persists.
    frameState.hdrpOncePerFrameFired.clear();
  }
}

/**
 * feat-20260609 M2: filter dispatch entries by a {@link PassSelector}.
 *
 * Each dispatch entry carries `tags` (a free key-value map) sourced from the
 * material's per-pass tags.  The selector is matched entry-by-entry via
 * {@link matchPass}; entries whose tags satisfy the selector are returned.
 * An empty selector returns the input array unchanged (match-all semantics).
 *
 * @param dispatch Per-frame dispatch entries (from the extract stage).
 * @param selector Pipeline-specific pass selector (e.g. `{ LightMode: ['Forward'] }`).
 * @returns Dispatch entries whose tags match the selector.
 */
export function filterDispatchBySelector(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): readonly DispatchEntry[] {
  if (Object.keys(selector).length === 0) return dispatch;
  return dispatch.filter((e) => matchPass(e.tags, selector));
}

/**
 * feat-20260609 M2: build a set of renderable indices whose dispatch entries
 * match the given selector.  Used by the record pass closures to skip entities
 * that do not belong to the current pass.
 *
 * Returns null when the dispatch array is empty (no dispatch-based filtering
 * to apply — draw all entities).  Returns an empty set when dispatch is
 * non-empty but no entries matched (draw nothing).  Returns a populated set
 * when at least one dispatch entry matched.
 */
function buildMatchedRenderableIndices(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): Set<number> | null {
  // PRODUCTION INVARIANT: in real frames extractFrame always populates
  // dispatch[] for every visible renderable (Forward + ShadowCaster tags
  // emitted per validated entity, including the default-material handle=0
  // path — see render-system-extract.ts default-material dispatch emission).
  // The empty-dispatch null fallback below exists ONLY for unit-test
  // fixtures that mock dispatch out (early w-* tests written before
  // dispatch existed). Returning null causes the downstream loop to skip
  // selector filtering, preserving back-compat for those fixtures. If a
  // future refactor moves dispatch population earlier or makes it
  // conditional, the test fixtures should be updated rather than this
  // fallback widened to production.
  if (dispatch.length === 0) return null;
  const filtered = filterDispatchBySelector(dispatch, selector);
  const set = new Set<number>();
  for (const e of filtered) {
    set.add(e.renderableIndex);
  }
  return set;
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: shadow depth pass
 * recording, extracted verbatim from recordFrame. Renders shadow casters
 * into the shadow depth RT using an INDEPENDENT command encoder + its own
 * queue.submit (RD-4: this independent-encoder boundary is the runtime-side
 * manual barrier that synchronizes the depth-texture write with the
 * subsequent sample in the main pass). Driven by the render-graph 'shadow'
 * pass execute closure.
 */
export function recordShadowPass(
  c: _InternalRenderPipelineContext,
  selector?: PassSelector,
  viewport?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  cascadeIndex: number = 0,
): void {
  const { runtime, pipelineState, validated, meshBindGroup, dispatch, frameState } = c;
  // feat-20260613-csm-cascaded-shadow-maps M5 / w28: write the per-pass
  // cascade index to the shared shadowCasterCascadeBuffer. The shadow
  // pass below uses an INDEPENDENT command encoder + own queue.submit, so
  // queue.writeBuffer here lands serially against this pass's submit
  // even when N cascades are recorded back-to-back -- each pass's submit
  // sees its own index.
  const cascadeIdxPayload = new Uint32Array([cascadeIndex >>> 0, 0, 0, 0]);
  const cascadeWriteResult = runtime.device.queue.writeBuffer(
    pipelineState.shadowCasterCascadeBuffer,
    0,
    cascadeIdxPayload,
  );
  if (!cascadeWriteResult.ok) throw cascadeWriteResult.error;
  // w10 shadow depth pass: uses a separate command encoder so Dawn/WebGPU
  // can synchronize the depth texture write (RenderAttachment) with the
  // subsequent read (TextureBinding in the geometry pass). Sharing an
  // encoder triggers "usage includes writable usage and another usage in
  // the same synchronization scope" validation error.
  // feat-20260609 M4 / T-010: shadow PSO via frameState.pipelineCache lookup
  // (same path as forward passes — charter P4 consistent abstraction).
  // getMaterialShaderPipeline lazily builds + caches PSO keyed on
  // (shaderId, isHdr, renderState, topology, indexFormat, variantSet, passKind).
  const shadowPipeline =
    runtime.getMaterialShaderPipeline?.(
      'forgeax::default-shadow-caster',
      false, // isHdr — shadow depth pass is always LDR
      undefined, // renderState — vertex-only shader, no render state
      'triangle-list', // topology — shadow PSO targets triangle-list
      undefined, // indexFormat — triangle-list ignores strip index width
      undefined, // variantSet — shadow_caster.wgsl has no group(2) bindings
      'shadow-caster', // passKind — distinguishes from forward PSO
    ) ?? null;
  // M5-T1: shadow depth target read directly from render-graph
  // (`addColorTarget('shadowDepth', ...)` declared in `urp-pipeline.ts`;
  // D-2 SSOT). Returns undefined when the graph has not allocated the
  // target (no DirectionalLightShadow wired or shadowMapSize=0); the
  // gate below (`shadowView !== null`) is preserved by coalescing
  // undefined to null.
  const shadowView =
    (frameState.perFrameGraph?.getColorTargetView('shadowDepth') as TextureView | undefined) ??
    null;
  // feat-20260609 M2: filter entities by pass selector.
  const matchedIndices =
    selector !== undefined ? buildMatchedRenderableIndices(dispatch, selector) : null;

  // bug-20260619-csm RC-3 (AC-10, D-3): map each renderable to its
  // ShadowCaster pass shader so the depth pass selects the per-entity PSO
  // (mirrors the forward pass's per-entity PSO selection — charter P4).
  // A material with a custom ShadowCaster shader (e.g. an alpha-test cutout
  // that calls `discard`) gets its own fragment-carrying PSO; default
  // casters resolve to `forgeax::default-shadow-caster` (vertex-only), so
  // there is no regression for the built-in materials. Built from the
  // dispatch entries tagged `LightMode: 'ShadowCaster'` (extract already
  // populates `materialShaderId` per pass).
  const shadowShaderByRenderableIdx = new Map<number, string>();
  for (const de of dispatch) {
    if (de.tags.LightMode === 'ShadowCaster' && de.materialShaderId !== undefined) {
      shadowShaderByRenderableIdx.set(de.renderableIndex, de.materialShaderId);
    }
  }

  if (shadowPipeline !== null && shadowView !== null && validated.length > 0) {
    // feat-20260529-rendergraph-pass-abstraction M4 / w14 (RD-4 verification
    // point): this INDEPENDENT 'render-system-shadow' command encoder + its
    // own queue.submit below is the runtime-side manual barrier that splits
    // the shadowDepth write (here) from the main pass sample. The render-
    // graph mirrors the same shadow -> main hazard as an explicit barrier on
    // wgpu-native (barrier-backend-kind.test.ts w14); on webgpu / wgpu-webgl2
    // the encoder boundary alone provides synchronization. main / tonemap /
    // FXAA stay on the shared frame encoder (c.encoder), submitted once.
    const shadowEncResult = runtime.device.createCommandEncoder({
      label: 'render-system-shadow',
    });
    if (shadowEncResult.ok) {
      const shadowEnc = shadowEncResult.value;

      // M2 / w8: shadow view (#3) cache lookup with 'view-shadow'
      // variant discriminator (AC-06: distinct key from 'view-main').
      // b3 is always shadowFallbackTextureView (not the actual shadow
      // map — WebGPU forbids writing to and sampling from the same
      // texture in the same synchronization scope). Handles are all
      // init-time stable (D-6 sentinel effectively — key hits from
      // frame 2 onward).
      const shadowViewKey = buildBindGroupCacheKey(
        'view-shadow',
        [
          pipelineState.viewUniformBuffer as unknown as object,
          pipelineState.pointLightsBuffer as unknown as object,
          pipelineState.spotLightsBuffer as unknown as object,
          pipelineState.shadowFallbackTextureView as unknown as object,
          pipelineState.perPassResources.shadowSampler as unknown as object,
          pipelineState.shadowAtlasFallbackTextureView as unknown as object,
          pipelineState.shadowParamsBuffer as unknown as object,
        ],
        c.frameState,
      );
      const shadowViewBg = getOrCreateBindGroup(
        c.frameState.viewBindGroupCache,
        shadowViewKey,
        () => {
          const shadowViewBgResult = runtime.device.createBindGroup({
            label: 'shadow-view-bg',
            layout: pipelineState.viewBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.viewUniformBuffer },
                },
              },
              {
                binding: 1,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.pointLightsBuffer },
                },
              },
              {
                binding: 2,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.spotLightsBuffer },
                },
              },
              {
                binding: 3,
                resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
              },
              {
                binding: 4,
                resource: { kind: 'sampler', value: pipelineState.perPassResources.shadowSampler },
              },
              // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-1:
              // shadowViewBg uses the cube_array fallback at binding 5
              // (NOT the real ShadowAtlas atlas view) because the directional
              // shadow caster is reading depth from b3 -- but mixing the
              // real atlas view here would put the cube_array under both a
              // sample and a write attachment hazard during the SAME frame
              // (point shadow caster pass writes the atlas; here we only
              // need a valid bind to satisfy the BGL shape, never sample it
              // in shadow_caster.wgsl).
              {
                binding: 5,
                resource: {
                  kind: 'textureView',
                  value: pipelineState.shadowAtlasFallbackTextureView,
                },
              },
              {
                binding: 6,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.shadowParamsBuffer },
                },
              },
              // feat-20260613-csm-cascaded-shadow-maps M5 / w28 (rebased to
              // binding 7 on 2026-06-13): per-pass cascade-index uniform
              // consumed by shadow_caster.vs_main.
              {
                binding: 7,
                resource: {
                  kind: 'buffer',
                  value: { buffer: pipelineState.shadowCasterCascadeBuffer },
                },
              },
            ],
          });
          if (!shadowViewBgResult.ok) throw shadowViewBgResult.error;
          return shadowViewBgResult.value;
        },
        c.bindGroupCounts,
      );

      // Dummy material bind group for @group(1) — not consumed by the
      // shadow-caster shader but must match the pipeline's
      // materialBindGroupLayout (14 entries: material 0..6 + Skylight
      // 7..13 per feat-20260520-skylight-ibl-cubemap D-5 round-4).
      //
      // M4 / w15 (D-6 sentinel cache): all handles are init-time stable
      // pipelineState defaults + skylightFallback resources.  Use a fixed
      // sentinel key (no entityKey) — hit from frame 2 onward, zero-cost
      // after the first frame.  Key is 'shadow-material-singleton'; the
      // clean-up loop in recordFrame skips sentinel keys via Number.isNaN
      // (the segment between the two dashes is non-numeric).
      const shadowMaterialBaseEntries = [
        {
          binding: 0,
          resource: {
            kind: 'buffer' as const,
            value: {
              buffer: pipelineState.materialUniformBuffer.buffer,
              offset: 0,
              size: STANDARD_PBR_UBO_SIZE,
            },
          },
        },
        {
          binding: 1,
          resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
        },
        {
          binding: 2,
          resource: {
            kind: 'textureView' as const,
            value: pipelineState.defaultWhiteTextureView,
          },
        },
        {
          binding: 3,
          resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
        },
        {
          binding: 4,
          resource: {
            kind: 'textureView' as const,
            value: pipelineState.defaultWhiteTextureView,
          },
        },
        {
          binding: 5,
          resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
        },
        {
          binding: 6,
          resource: {
            kind: 'textureView' as const,
            value: pipelineState.defaultNormalTextureView,
          },
        },
      ];
      const shadowSkyFb = pipelineState.skylightFallback;
      const shadowEmissiveAo: EmissiveAoBindGroupResources = {
        emissiveSampler: pipelineState.defaultSampler,
        emissiveView: pipelineState.defaultWhiteTextureView,
        occlusionSampler: pipelineState.defaultSampler,
        occlusionView: pipelineState.defaultWhiteTextureView,
      };
      const shadowMergedEntries =
        shadowSkyFb !== null
          ? assembleMaterialWithSkylightEntries(
              shadowMaterialBaseEntries,
              {
                irradianceView: shadowSkyFb.irradianceView,
                irradianceSampler: shadowSkyFb.sampler,
                prefilterView: shadowSkyFb.prefilterView,
                prefilterSampler: shadowSkyFb.sampler,
                brdfLutView: shadowSkyFb.brdfLutView,
                brdfLutSampler: shadowSkyFb.sampler,
                intensityBuffer: shadowSkyFb.intensityBuffer,
              },
              shadowEmissiveAo,
            )
          : shadowMaterialBaseEntries;
      const shadowMaterialBg = getOrCreateBindGroup(
        c.frameState.materialBgCache,
        'shadow-material-singleton',
        () => {
          const shadowMaterialBgResult = runtime.device.createBindGroup({
            label: 'shadow-material-bg',
            layout: pipelineState.materialBindGroupLayout,
            entries: shadowMergedEntries,
          });
          if (!shadowMaterialBgResult.ok) throw shadowMaterialBgResult.error;
          return shadowMaterialBgResult.value;
        },
        c.bindGroupCounts,
      );

      // feat-20260604-instances-per-instance-transform-shader-group3-bin M2 / w12 (D-1 (C)):
      // shadow pass per-instance channel alignment — replaces the identity singleton
      // @group(3) binding with per-entity instance buffer + drawIndexed(instanceCount).
      //
      // C1: inside the shadow loop, resolve the per-entity instance buffer (reuse
      // frameState.instanceBuffers cache, or build+upload fresh). When entry has no
      // Instances component, fall back to identityInstanceBuffer + instanceCount=1.
      // C2: shadowPass.drawIndexed(indexCount, instanceCount, 0, 0, 0) with real
      // inst.instanceCount (not hardcoded 1).
      //
      // R2-1 (Reviewer note): the shadow encoder finishes BEFORE the main pass builds
      // frameState.instanceBuffers (main pass at ~:2950), so we build/upload per-entity
      // instance buffers INSIDE the shadow loop — shadow reads current-frame data.

      const shadowPass: RhiRenderPassEncoder = shadowEnc.beginRenderPass(
        buildBeginRenderPassDescriptor(
          { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 },
          { colorViews: [], depthView: shadowView },
          'shadow-caster',
          { depthLoadOp: cascadeIndex === 0 ? 'clear' : 'load' },
        ) as never,
      );

      shadowPass.setPipeline(shadowPipeline);
      // feat-20260613 M6 / w20 (D-4): per-cascade viewport always applies.
      // viewport clips the depth rasterization to one atlas tile so N
      // cascades share a single atlas depth texture. The pre-CSM
      // single-cascade fallback (full-RT pass when viewport === undefined)
      // is gone — urp-pipeline always passes a viewport per cascade and
      // any other caller is expected to follow the same contract. The
      // signature remains a defaulted parameter so compute callers can
      // still pass `{ x: 0, y: 0, w: mapSize, h: mapSize }` for a single-
      // tile render.
      const tileViewport: NonNullable<typeof viewport> = viewport ?? {
        x: 0,
        y: 0,
        w: pipelineState.perPassResources.shadowMapSize,
        h: pipelineState.perPassResources.shadowMapSize,
      };
      shadowPass.setViewport(tileViewport.x, tileViewport.y, tileViewport.w, tileViewport.h, 0, 1);
      shadowPass.setBindGroup(0, shadowViewBg);
      shadowPass.setBindGroup(1, shadowMaterialBg, [0]);
      const shadowMeshBindGroup: BindGroup = meshBindGroup as BindGroup;
      // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer
      // (the wrapper) -- the de-dup compare uses wrapper identity (one wrapper
      // per RHI handle from gpuStore), and `.handle` is passed to the RHI
      // setVertexBuffer / setIndexBuffer call.
      let shadowLastVertexBuffer: GpuBuffer | null = null;
      let shadowLastIndexBuffer: GpuBuffer | null = null;
      // bug-20260619-csm RC-3 (D-3): track the currently-bound shadow PSO so
      // per-entity setPipeline only fires on change (same de-dup discipline as
      // vertex/index buffers above). The default-shadow-caster PSO is already
      // bound by the setPipeline call above; the loop switches to a custom
      // ShadowCaster PSO when a material supplies one.
      let shadowLastPipeline: typeof shadowPipeline = shadowPipeline;

      for (let i = 0; i < validated.length; i++) {
        const entry = validated[i];
        if (entry === undefined) continue;

        // feat-20260609 M2: skip entities that don't match the pass selector.
        if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;

        // bug-20260619-csm RC-3 (AC-10, D-3): resolve the per-entity shadow
        // PSO from its ShadowCaster shader id. Default casters keep the
        // vertex-only `forgeax::default-shadow-caster` PSO bound above; a
        // material with a custom ShadowCaster shader (cutout alpha-test) gets
        // its own fragment-carrying PSO so `discard` runs in the depth pass.
        const entryShadowShaderId = shadowShaderByRenderableIdx.get(entry.renderableIndex);
        let entryShadowPipeline = shadowPipeline;
        if (
          entryShadowShaderId !== undefined &&
          entryShadowShaderId !== 'forgeax::default-shadow-caster'
        ) {
          // Custom ShadowCaster PSO; same cache path as the default above
          // (passKind 'shadow-caster'). On a cache miss (async build in
          // flight / build failure) fall back to the default PSO so the
          // caster still writes depth rather than dropping its draw.
          entryShadowPipeline =
            runtime.getMaterialShaderPipeline?.(
              entryShadowShaderId,
              false, // isHdr — shadow depth pass is always LDR
              undefined, // renderState
              'triangle-list', // topology — shadow PSO targets triangle-list
              undefined, // indexFormat
              undefined, // variantSet — shadow caster has no variant axes
              'shadow-caster', // passKind
            ) ?? shadowPipeline;
        }
        if (entryShadowPipeline !== shadowLastPipeline && entryShadowPipeline !== null) {
          shadowPass.setPipeline(entryShadowPipeline);
          shadowLastPipeline = entryShadowPipeline;
        }

        // feat-20260604-mesh-topology-debug-draw M5 / w14 (AC-09, D-A6): the
        // shadow caster PSO is triangle-list; it only projects triangle faces.
        // line-list / line-strip / point-list meshes have no surface to cast a
        // shadow, so skip them here. triangle-strip is still a face topology
        // and projects (the shadow PSO's fixed triangle-list rasterizes its
        // expanded triangles correctly enough for the depth pass).
        //
        // feat-20260608 M4 / w16: per-submesh shadow draw — iterate submeshes
        // and skip non-triangle submeshes individually (each submesh may differ).
        const shadowSubmeshes = entry.mesh.submeshes;
        const hasAnyShadowSubmesh = shadowSubmeshes.some(
          (sm) => sm.topology === 'triangle-list' || sm.topology === 'triangle-strip',
        );
        if (!hasAnyShadowSubmesh) {
          continue;
        }

        if (entry.mesh.vertexBuffer !== shadowLastVertexBuffer) {
          shadowPass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
          shadowLastVertexBuffer = entry.mesh.vertexBuffer;
        }
        if (entry.mesh.indexed && entry.mesh.indexBuffer !== shadowLastIndexBuffer) {
          // indexed=true implies indexBuffer is non-null GpuBuffer.
          if (entry.mesh.indexBuffer !== null) {
            shadowPass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
            shadowLastIndexBuffer = entry.mesh.indexBuffer;
          }
        }

        shadowPass.setBindGroup(2, shadowMeshBindGroup, [i * MESH_PER_ENTITY_STRIDE]);

        // C1 + C2 (w12): per-entity instance buffer + instanceCount
        let shadowInstanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
        let shadowInstanceCount = 1;
        const shadowInst = entry.source.instances;
        if (shadowInst !== undefined) {
          const uniformFallback = runtime.device.caps.storageBuffer === false;
          // Over-cap uniform fallback can't fit the per-instance window — bind
          // identity and let the shader collapse (same semantics as the main
          // pass). Otherwise build/upload the per-entity instance buffer: storage
          // by default, uniform when the device lacks storage buffers.
          if (uniformFallback && shadowInst.instanceCount > MAX_UNIFORM_INSTANCES) {
            shadowInstanceCount = shadowInst.instanceCount;
            shadowInstanceBuffer = pipelineState.identityInstanceBuffer;
          } else {
            const bufUsage = uniformFallback
              ? UNIFORM_USAGE | COPY_DST_USAGE
              : STORAGE_USAGE | COPY_DST_USAGE;
            const requestedBytes = shadowInst.transforms.byteLength;
            const cached = c.frameState.instanceBuffers.get(shadowInst.cacheKey);
            let active: InstanceBufferCacheEntry | null = null;
            if (
              cached !== undefined &&
              cached.uploadedArchVersion === shadowInst.archVersion &&
              cached.uploadedByteLength === requestedBytes
            ) {
              active = cached;
            } else if (requestedBytes > 0) {
              const bufRes = runtime.device.createBuffer({
                size: requestedBytes,
                usage: bufUsage,
                mappedAtCreation: false,
              });
              if (!bufRes.ok) {
                runtime.errorRegistry.fire(bufRes.error);
              } else {
                // feat-20260619 M4 / F12: destroy the old cached buffer
                // before replacing it with the new one (D-6).
                if (cached !== undefined && !cached.buffer.isDestroyed) {
                  const r = cached.buffer.destroy();
                  if (!r.ok) runtime.errorRegistry.fire(r.error);
                }
                const newBuffer = new GpuBuffer(runtime.device, bufRes.value);
                active = {
                  buffer: newBuffer,
                  uploadedArchVersion: shadowInst.archVersion,
                  uploadedByteLength: requestedBytes,
                };
                c.frameState.instanceBuffers.set(shadowInst.cacheKey, active);
              }
            }
            if (active !== null) {
              const writeRes = runtime.device.queue.writeBuffer(
                active.buffer.handle,
                0,
                shadowInst.transforms,
              );
              if (!writeRes.ok) {
                runtime.errorRegistry.fire(writeRes.error);
              } else {
                shadowInstanceBuffer = active.buffer.handle;
                shadowInstanceCount = Math.max(1, shadowInst.instanceCount);
              }
            }
          }
        }

        // Bind per-entity instances BG for @group(3) (or fallback identity)
        const shadowInstancesBgKey = `shadow-instances-${entry.source.entityKey}-${getOrAssignHandleId(c.frameState, shadowInstanceBuffer as unknown as object)}`;
        const shadowInstancesBg = getOrCreateBindGroup(
          c.frameState.instancesBgCache,
          shadowInstancesBgKey,
          () => {
            const result = runtime.device.createBindGroup({
              label: 'shadow-instances-bg',
              layout: pipelineState.instancesBindGroupLayout,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: { buffer: shadowInstanceBuffer },
                  },
                },
              ],
            });
            if (!result.ok) throw result.error;
            return result.value;
          },
          c.bindGroupCounts,
        );

        shadowPass.setBindGroup(3, shadowInstancesBg);
        // feat-20260608 M4 / w16: per-submesh shadow draw loop.
        // Only draw submeshes whose topology is triangle-list or triangle-strip
        // (line-list / point-list submeshes cast no shadow and are skipped).
        for (const sm of shadowSubmeshes) {
          if (sm.topology !== 'triangle-list' && sm.topology !== 'triangle-strip') {
            continue;
          }
          if (entry.mesh.indexed) {
            shadowPass.drawIndexed(sm.indexCount, shadowInstanceCount, sm.indexOffset, 0, 0);
          } else {
            shadowPass.draw(sm.vertexCount, shadowInstanceCount, 0, 0);
          }
        }
      }

      shadowPass.end();

      const shadowFinishResult = shadowEnc.finish();
      if (shadowFinishResult.ok) {
        runtime.device.queue.submit([shadowFinishResult.value]);
      } else {
        runtime.errorRegistry.fire(shadowFinishResult.error);
      }
    } else {
      runtime.errorRegistry.fire(shadowEncResult.error);
    }
  }
}

/**
 * feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1
 * + §D-3 + AC-04). Records the 6 x N point-shadow caster passes — one render
 * pass per (shadow-casting point light, cube face) pair — that write per-light
 * cube_array atlas depth. Driven by the URP `addPointShadowPass` graph closure;
 * gated upstream on `frameState.pointShadowSnapshots.length > 0` (AC-09 zero-
 * shadow zero-pass).
 *
 * Pass count = 6 * N where N = `frameState.pointShadowSnapshots.length`. Each
 * pass opens an INDEPENDENT command encoder + queue.submit so Dawn / WebGPU
 * synchronizes the depth-write boundary with the subsequent atlas sample in
 * the forward pass (RD-4 manual barrier; same pattern as `recordShadowPass`).
 *
 * Round-2 F-3 fix-up: actual geometry walk + draw landed. Per face we
 * (1) write the face VP mat4 into `viewUniformBuffer` at offset 112 (the
 * `lightSpaceMatrix` slot) — `forgeax::default-shadow-caster` reads
 * `view.lightSpaceMatrix * worldPos` and the encoder boundary serializes
 * the queue.writeBuffer with the subsequent draw, so each face sees its own
 * VP without needing a per-face UBO bind. (2) Reuse the directional shadow
 * caster PSO + cached `shadow-view-bg` / `shadow-material-singleton` /
 * `shadow-mesh-bg` already built by `recordShadowPass`. (3) After all
 * (snapshot, face) passes complete, restore `viewUniformBuffer.lightSpaceMatrix`
 * to the directional value the main forward pass needs (the queue.submit
 * ordering guarantees the restore lands before the main encoder runs).
 *
 * Caveat: the cached `view-shadow` BG binds `shadowAtlasFallbackTextureView`
 * at binding 5 (NOT the real ShadowAtlas atlas view) so the BG is valid even
 * while the real atlas faces are being written through the depth attachment;
 * the shadow_caster.wgsl shader never samples binding 5 anyway (vertex-only
 * pipeline).
 *
 * No new shader / no new PSO / no new BGL is required for this round; the
 * change is purely runtime wiring. A dedicated `forgeax::default-point-
 * shadow-caster` PSO with a per-face VP UBO + dynamic offset would let the
 * pass run without touching `viewUniformBuffer.lightSpaceMatrix` and could
 * be considered for a follow-on optimization milestone (`OOS-future`).
 */
export function recordPointShadowPass(c: _InternalRenderPipelineContext): void {
  const { runtime, frameState, validated, meshBindGroup, pipelineState } = c;
  const snapshots = frameState.pointShadowSnapshots;
  if (snapshots.length === 0) return;
  const atlas = frameState.pointShadowAtlas;
  if (atlas === null || !atlas.isAllocated()) return;

  // Reuse the directional shadow caster PSO -- its WGSL reads
  // `view.lightSpaceMatrix * worldPos` which is exactly what we need once we
  // overwrite the slot per face below.
  const shadowPipeline =
    runtime.getMaterialShaderPipeline?.(
      'forgeax::default-shadow-caster',
      false,
      undefined,
      'triangle-list',
      undefined,
      undefined,
      'shadow-caster',
    ) ?? null;
  if (shadowPipeline === null) return;

  // Snapshot the directional lightSpaceMatrix so we can restore it after the
  // 6 x N face passes. recordShadowPass already wrote `viewUniformBuffer` at
  // offset 112 above; mirror its source in `pipelineState.perPassResources`
  // (cached by the directional path for Inspector consumption -- charter P4
  // single SSOT). When no directional shadow is active the slot was zeroed
  // by the viewPayload write at recordFrame top; we restore zeros.
  const restoreLightSpaceMatrix = pipelineState.perPassResources.shadowLightSpaceMatrix;
  const RESTORE_LSM_BYTES = 64; // mat4 = 16 floats x 4 B
  const VIEW_UBO_LSM_OFFSET = 112;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (snap === undefined) continue;
    for (let face = 0; face < 6; face++) {
      // (1) Overwrite viewUniformBuffer.lightSpaceMatrix with this face's VP.
      // shadowMatrices is Float32Array(96) = 6 mat4 in [+X,-X,+Y,-Y,+Z,-Z];
      // pull the 16-float subarray for this face.
      const faceVp = snap.shadowMatrices.subarray(face * 16, (face + 1) * 16);
      const lsmWriteRes = runtime.device.queue.writeBuffer(
        pipelineState.viewUniformBuffer,
        VIEW_UBO_LSM_OFFSET,
        faceVp,
      );
      if (!lsmWriteRes.ok) {
        runtime.errorRegistry.fire(lsmWriteRes.error);
        continue;
      }

      const encResult = runtime.device.createCommandEncoder({
        label: `point-shadow-l${snap.shadowAtlasLayer}-f${face}`,
      });
      if (!encResult.ok) {
        runtime.errorRegistry.fire(encResult.error);
        continue;
      }
      const enc = encResult.value;
      let view: TextureView;
      try {
        view = atlas.faceView(snap.shadowAtlasLayer, face);
      } catch (e) {
        if (
          e instanceof PointShadowAtlasUninitializedError ||
          e instanceof PointShadowAtlasBoundsViolationError
        ) {
          runtime.errorRegistry.fire(e);
        } else {
          throw e;
        }
        continue;
      }
      const pass = enc.beginRenderPass(
        buildBeginRenderPassDescriptor(
          { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 },
          { colorViews: [], depthView: view },
          'point-shadow-caster',
        ) as never,
      );

      // (2) Bind the same shadow PSO + view BG + material BG + mesh BG cached
      // by recordShadowPass earlier in this frame. The shadow path's view BG
      // binds the cube_array fallback at binding 5, so this BG is safe to
      // use while the real atlas faces are render-attached here.
      pass.setPipeline(shadowPipeline);
      // Look up the shadow view BG built earlier this frame by recordShadowPass.
      // `view-shadow` is the cache key prefix; tied to the same handle ids.
      // If the directional shadow path wasn't taken (no DirectionalLightShadow),
      // shadow-view-bg was never built -- skip the geometry walk in that case
      // (the depth attachment was still cleared above which is the AC-04
      // "atlas face cleared to far" minimum guarantee).
      const shadowViewKeyForLookup = buildBindGroupCacheKey(
        'view-shadow',
        [
          pipelineState.viewUniformBuffer as unknown as object,
          pipelineState.pointLightsBuffer as unknown as object,
          pipelineState.spotLightsBuffer as unknown as object,
          pipelineState.shadowFallbackTextureView as unknown as object,
          pipelineState.perPassResources.shadowSampler as unknown as object,
          pipelineState.shadowAtlasFallbackTextureView as unknown as object,
          pipelineState.shadowParamsBuffer as unknown as object,
        ],
        frameState,
      );
      // Build (or reuse) the shadow-view BG. If the directional shadow path
      // already populated it earlier this frame, the cache hits; otherwise
      // (no DirectionalLightShadow in the scene -- recordShadowPass never
      // ran) we build it on-demand here so the point shadow caster has a
      // valid b0 view BG even on directional-shadow-free scenes.
      const cachedShadowViewBg = getOrCreateBindGroup(
        frameState.viewBindGroupCache,
        shadowViewKeyForLookup,
        () => {
          const r = runtime.device.createBindGroup({
            label: 'shadow-view-bg',
            layout: pipelineState.viewBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'buffer', value: { buffer: pipelineState.viewUniformBuffer } },
              },
              {
                binding: 1,
                resource: { kind: 'buffer', value: { buffer: pipelineState.pointLightsBuffer } },
              },
              {
                binding: 2,
                resource: { kind: 'buffer', value: { buffer: pipelineState.spotLightsBuffer } },
              },
              {
                binding: 3,
                resource: { kind: 'textureView', value: pipelineState.shadowFallbackTextureView },
              },
              {
                binding: 4,
                resource: { kind: 'sampler', value: pipelineState.perPassResources.shadowSampler },
              },
              {
                binding: 5,
                resource: {
                  kind: 'textureView',
                  value: pipelineState.shadowAtlasFallbackTextureView,
                },
              },
              {
                binding: 6,
                resource: { kind: 'buffer', value: { buffer: pipelineState.shadowParamsBuffer } },
              },
            ],
          });
          if (!r.ok) throw r.error;
          return r.value;
        },
        c.bindGroupCounts,
      );
      // Same on-demand build for the dummy material BG (the shadow_caster
      // shader does not consume @group(1) but the PSO requires the BGL
      // to validate). Reuse the same singleton key recordShadowPass uses
      // so the two paths share one allocation per frame.
      const cachedShadowMaterialBg = getOrCreateBindGroup(
        frameState.materialBgCache,
        'shadow-material-singleton',
        () => {
          const fb = pipelineState.skylightFallback;
          const fallbackEntries = [
            {
              binding: 0,
              resource: {
                kind: 'buffer' as const,
                value: {
                  buffer: pipelineState.materialUniformBuffer.buffer,
                  offset: 0,
                  size: STANDARD_PBR_UBO_SIZE,
                },
              },
            },
            {
              binding: 1,
              resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
            },
            {
              binding: 2,
              resource: { kind: 'textureView' as const, value: pipelineState.fallbackTextureView },
            },
            {
              binding: 3,
              resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
            },
            {
              binding: 4,
              resource: {
                kind: 'textureView' as const,
                value: pipelineState.defaultNormalTextureView,
              },
            },
            {
              binding: 5,
              resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
            },
            {
              binding: 6,
              resource: { kind: 'textureView' as const, value: pipelineState.fallbackTextureView },
            },
          ];
          const merged =
            fb !== null
              ? assembleMaterialWithSkylightEntries(
                  fallbackEntries,
                  {
                    irradianceView: fb.irradianceView,
                    irradianceSampler: fb.sampler,
                    prefilterView: fb.prefilterView,
                    prefilterSampler: fb.sampler,
                    brdfLutView: fb.brdfLutView,
                    brdfLutSampler: fb.sampler,
                    intensityBuffer: fb.intensityBuffer,
                  },
                  {
                    emissiveSampler: pipelineState.defaultSampler,
                    emissiveView: pipelineState.defaultWhiteTextureView,
                    occlusionSampler: pipelineState.defaultSampler,
                    occlusionView: pipelineState.defaultWhiteTextureView,
                  },
                )
              : fallbackEntries;
          const r = runtime.device.createBindGroup({
            label: 'shadow-material-bg',
            layout: pipelineState.materialBindGroupLayout,
            entries: merged,
          });
          if (!r.ok) throw r.error;
          return r.value;
        },
        c.bindGroupCounts,
      );
      if (meshBindGroup === null) {
        pass.end();
        const finishOnly = enc.finish();
        if (!finishOnly.ok) {
          runtime.errorRegistry.fire(finishOnly.error);
          continue;
        }
        const submitOnly = runtime.device.queue.submit([finishOnly.value]);
        if (!submitOnly.ok) {
          runtime.errorRegistry.fire(submitOnly.error);
        }
        continue;
      }
      pass.setBindGroup(0, cachedShadowViewBg);
      pass.setBindGroup(1, cachedShadowMaterialBg, [0]);

      // (3) Iterate the validated entries and emit one drawIndexed per
      // shadow-casting submesh. Same shape as the directional shadow loop;
      // the per-instance instance buffers built earlier this frame in
      // recordShadowPass are reused (cached on frameState.instanceBuffers).
      let lastVB: GpuBuffer | null = null;
      let lastIB: GpuBuffer | null = null;
      for (let ei = 0; ei < validated.length; ei++) {
        const entry = validated[ei];
        if (entry === undefined) continue;
        const submeshes = entry.mesh.submeshes;
        const hasTriangle = submeshes.some(
          (sm) => sm.topology === 'triangle-list' || sm.topology === 'triangle-strip',
        );
        if (!hasTriangle) continue;
        if (entry.mesh.vertexBuffer !== lastVB) {
          pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
          lastVB = entry.mesh.vertexBuffer;
        }
        if (entry.mesh.indexed && entry.mesh.indexBuffer !== lastIB && entry.mesh.indexBuffer) {
          pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
          lastIB = entry.mesh.indexBuffer;
        }
        pass.setBindGroup(2, meshBindGroup, [ei * MESH_PER_ENTITY_STRIDE]);
        // Resolve the per-entity instance BG cached by recordShadowPass.
        const inst = entry.source.instances;
        let instCount = 1;
        let instBufferKey: object = pipelineState.identityInstanceBuffer as unknown as object;
        if (inst !== undefined) {
          const cached = frameState.instanceBuffers.get(inst.cacheKey);
          if (
            cached !== undefined &&
            cached.uploadedArchVersion === inst.archVersion &&
            cached.uploadedByteLength === inst.transforms.byteLength
          ) {
            instBufferKey = cached.buffer.handle as unknown as object;
            instCount = Math.max(1, inst.instanceCount);
          }
        }
        const instBgKey = `shadow-instances-${entry.source.entityKey}-${getOrAssignHandleId(frameState, instBufferKey)}`;
        const cachedInstBg = frameState.instancesBgCache.get(instBgKey);
        if (cachedInstBg === undefined) continue; // recordShadowPass should have populated it
        pass.setBindGroup(3, cachedInstBg);
        for (const sm of submeshes) {
          if (sm.topology !== 'triangle-list' && sm.topology !== 'triangle-strip') continue;
          if (entry.mesh.indexed) {
            pass.drawIndexed(sm.indexCount, instCount, sm.indexOffset, 0, 0);
          } else {
            pass.draw(sm.vertexCount, instCount, 0, 0);
          }
        }
      }

      pass.end();
      const finishResult = enc.finish();
      if (!finishResult.ok) {
        runtime.errorRegistry.fire(finishResult.error);
        continue;
      }
      const submitResult = runtime.device.queue.submit([finishResult.value]);
      if (!submitResult.ok) {
        runtime.errorRegistry.fire(submitResult.error);
      }
    }
  }

  // (4) Restore viewUniformBuffer.lightSpaceMatrix to the directional value
  // (or zero if no directional shadow this frame). The main forward pass
  // builds its own viewBg from the SAME viewUniformBuffer + reads
  // view.lightSpaceMatrix for directional shadow factor reconstruction.
  const restoreBuf = new Float32Array(16);
  if (restoreLightSpaceMatrix !== null) {
    for (let i = 0; i < 16; i++) restoreBuf[i] = restoreLightSpaceMatrix[i] ?? 0;
  }
  // restoreBuf is already exactly 16 floats x 4 B = 64 B; no size override needed.
  void RESTORE_LSM_BYTES;
  const restoreRes = runtime.device.queue.writeBuffer(
    pipelineState.viewUniformBuffer,
    VIEW_UBO_LSM_OFFSET,
    restoreBuf,
  );
  if (!restoreRes.ok) {
    runtime.errorRegistry.fire(restoreRes.error);
  }
}

/**
 * feat-20260531-skybox-env-background M2 / w8: skybox pass recording stub.
 * Renders a fullscreen triangle that samples a cubemap using the camera's
 * inverseViewProj from the View UBO and writes the result to the hdrColor
 * render target. The pass runs after shadow and before main (D-1 topology).
 *
 * This stub early-returns when skyboxActive is false -- the actual execute
 * body is implemented in M3 / w16 (recordSkyboxPass execute). The render-
 * graph still declares the pass so the compile() step validates the
 * dependency edges (shadow -> skybox -> main) even before the execute
 * body is filled in.
 */
export function recordSkyboxPass(c: _InternalRenderPipelineContext): void {
  // Early-return when skybox is not active (no SkyboxBackground entity,
  // or tonemap is disabled -- plan-strategy D-2 NOTE). The graph still
  // compiles because the pass declaration is unconditional; only the
  // execute body is gated on skyboxActive.
  if (!c.skyboxActive) return;
  const skyboxSnapshot = c.skybox;
  if (skyboxSnapshot === undefined) return;

  const { runtime, store, encoder, pipelineState } = c;

  // Guard: hdrColorView must be allocated (tonemapActive implies it)
  const hdrColorView = pipelineState.perPassResources.hdrColorView;
  if (hdrColorView === null) return;

  // feat-20260604 M2 / w10: under MSAA the skybox + main passes share the
  // count=4 multisample target (hdrColorMsaa); only the main pass (last to
  // write) resolves to the single-sample hdrColor (D-8 -- avoids a wasteful
  // mid-chain resolve). The skybox pass writes the multisample target with no
  // resolveTarget and uses the count=4 skybox pipeline variant.
  const skyboxColorView = c.msaaActive
    ? pipelineState.perPassResources.hdrColorMsaaView
    : hdrColorView;
  if (skyboxColorView === null) return;

  // Guard: pipeline resources must exist (null when manifest has no
  // skybox entry -- legacy manifests continue to boot)
  const skyboxPipeline = c.msaaActive
    ? pipelineState.perPassResources.skyboxPipelineMsaa
    : pipelineState.perPassResources.skyboxPipeline;
  const skyboxBgl = pipelineState.perPassResources.skyboxBindGroupLayout;
  const skyboxSampler = pipelineState.perPassResources.skyboxSampler;
  if (skyboxPipeline === null || skyboxBgl === null || skyboxSampler === null) return;

  // Resolve cubemap GPU view from AssetRegistry. Returns undefined if
  // the cubemap has not been uploaded yet (async equirect upload in
  // progress). In that case, degradation to main pass loadOp:'clear'
  // is handled by the passCtx.skyboxActive gate above -- if the
  // cubemap isn't ready, skyboxActive is already false (see w18).
  // biome-ignore lint/suspicious/noExplicitAny: branded Handle cast from raw number
  const cubemapView = store.getCubemapGpuView(skyboxSnapshot.cubemapHandle as any);
  if (cubemapView === undefined) return;

  // Rebuild skybox BindGroup every frame. Unlike tonemap (whose HDR
  // view only changes on resize), the cubemap GpuView is recreated
  // on each uploadCubemapFromEquirect call (which may happen mid-app
  // asynchronously). Cache invalidates when hdrColorView changes
  // (resize), but otherwise rebuild per-frame is cheap (3 entries,
  // no UBO write -- View UBO is shared with main pass).
  if (
    pipelineState.perPassResources.skyboxBindGroup === null ||
    pipelineState.perPassResources.hdrTextureWidth !== c.targetW ||
    pipelineState.perPassResources.hdrTextureHeight !== c.targetH
  ) {
    const skyboxBgRes = runtime.device.createBindGroup({
      label: 'skybox-bg',
      layout: skyboxBgl,
      entries: [
        {
          binding: 0,
          resource: { kind: 'textureView', value: cubemapView },
        },
        {
          binding: 1,
          resource: { kind: 'sampler', value: skyboxSampler },
        },
        {
          binding: 2,
          resource: {
            kind: 'buffer',
            value: { buffer: pipelineState.viewUniformBuffer },
          },
        },
      ],
    });
    if (!skyboxBgRes.ok) {
      runtime.errorRegistry.fire(skyboxBgRes.error);
      return;
    }
    pipelineState.perPassResources.skyboxBindGroup = skyboxBgRes.value;
  }

  // Skybox pass: clear hdrColor (first pass writing to it),
  // draw fullscreen triangle, write cubemap colour.
  // No depth/stencil -- skybox is the far plane; main pass depth test rejects
  // occluded skybox pixels (plan-strategy D-1). HDR target ('rgba16float') is
  // declared on specAttachments for descriptor parity, even though color-only
  // policies do not gate on format.
  const skyboxPass = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [skyboxColorView] },
      'skybox',
    ) as never,
  );

  skyboxPass.setPipeline(skyboxPipeline);
  skyboxPass.setBindGroup(0, pipelineState.perPassResources.skyboxBindGroup);
  skyboxPass.draw(3);
  skyboxPass.end();
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: main forward
 * (geometry) pass recording, extracted verbatim from recordFrame. Uses the
 * SHARED frame encoder (c.encoder); the geometry + optional LDR sprite-split
 * sub-pass write into geometryColorView (HDR target or swap-chain view).
 * Driven by the render-graph 'main' pass execute closure.
 */
export function recordMainPass(c: _InternalRenderPipelineContext, selector?: PassSelector): void {
  const {
    runtime,
    world,
    store,
    pipelineState,
    encoder,
    clear,
    tonemapActive,
    geometryColorView,
    geometryDepthView,
    validatedOrdered,
    viewBindGroup,
    meshBindGroup,
    frameState,
    dispatchCounts,
    bindGroupCounts,
    skylight,
    skylightCount,
    skyboxActive,
    splitLdrSprite,
    ldrSpriteUnormView,
    msaaActive,
    geometryColorResolveView,
    ldrSpriteColorView,
    dispatch,
    hdrpClusterBindGroup,
  } = c;
  // bug-20260615 M3 / m3-1: sampleCount is threaded through every
  // getMaterialShaderPipeline call site so the cache key / builder
  // disambiguate count=1 vs count=4 PSOs. Derived from the per-camera
  // msaaActive boolean (already on the context).
  const sampleCount = msaaActive ? 4 : 1;
  // feat-20260609-hdrp-cluster-fragment-ggx M4 / w16: HDRP active swaps the
  // group(2) bindGroup for the unified 7-entry layout (mesh SSBO at binding 0
  // + cluster 4 buffer at bindings 3..6). The dynamic offset
  // (`i * MESH_PER_ENTITY_STRIDE`) stays valid because the unified BGL binds
  // the SAME mesh SSBO at binding 0; the cluster-forward shader reads the
  // cluster bindings off the rest of the layout. Plan D-1 (URP path zero
  // change) is preserved — when `!isHdrpActive` the URP `meshBindGroup`
  // path runs verbatim.
  const meshGroup2: BindGroup | null =
    frameState.isHdrpActive && hdrpClusterBindGroup !== null ? hdrpClusterBindGroup : meshBindGroup;
  // ── Geometry (main colour) pass ──────────────────────────────────
  // D-2: tracks whether the geometry pass was explicitly ended inside
  // the `if (validatedOrdered.length > 0)` block (sprite split path),
  // to avoid a double-end at the unconditional `pass.end()` below.
  let geometryPassEnded = false;
  // feat-20260531-skybox-env-background M2 / w8: condition main colour
  // loadOp on skyboxActive (AC-05). When skybox is active, the skybox
  // pass writes the far plane + cubemap colour to hdrColor before main;
  // main must load (not clear) to composite geometry on top. Depth
  // loadOp stays 'clear' -- skybox does not write depth, so main's
  // depth test naturally covers skybox pixels with foreground geometry.
  const mainColorLoadOp = skyboxActive ? 'load' : 'clear';
  // feat-20260604 M2 / w9-w10: MSAA resolve placement. When MSAA is active the
  // geometry pass writes a count=4 multisample target. The resolve to the
  // single-sample output (LDR swap-chain view / HDR hdrColor) happens at the
  // LAST pass that writes that multisample target: the main pass itself when
  // there is no LDR sprite split, or the sprite sub-pass end when there is
  // (F-1 -- geometry + sprites share one multisample texture; resolving at the
  // main pass would drop the sprites drawn after). The sprite sub-pass is
  // LDR-only, so under HDR the main pass always resolves.
  const mainPassResolves = msaaActive && geometryColorResolveView !== null && !splitLdrSprite;
  // forward main pass: depth24plus-stencil8 auto-emits stencil ops via the
  // helper's stencil-op gate (plan-strategy M4 R3/R5 stencil-op SSOT).
  // mainColorLoadOp toggles between 'clear' and 'load' (skyboxActive case).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      {
        colorFormats: ['rgba16float'],
        depthFormat: 'depth24plus-stencil8',
        sampleCount: msaaActive ? 4 : 1,
      },
      {
        colorViews: [geometryColorView],
        depthView: geometryDepthView,
        ...(mainPassResolves ? { resolveTargets: [geometryColorResolveView] } : {}),
      },
      'forward',
      {
        colorLoadOp: mainColorLoadOp,
        clearColor: { r: clear[0] ?? 0, g: clear[1] ?? 0, b: clear[2] ?? 0, a: clear[3] ?? 1 },
      },
    ) as never,
  );

  // Geometry submission block: setPipeline + 4 bind groups + per-entity
  // material uploads + drawIndexed.

  // feat-20260609 M2: filter entities by pass selector.
  const matchedIndices =
    selector !== undefined ? buildMatchedRenderableIndices(dispatch, selector) : null;

  if (validatedOrdered.length > 0) {
    const MATERIAL_PER_ENTITY_STRIDE = 256;
    // feat-20260518-pbr-direct-lighting-mvp M5 / w22.10 (D-4 + D-9 +
    // AC-07 std140): per-entity material slice grew from 32 B (legacy
    // baseColor:vec4 + metallic + roughness + 8B padding) to 48 B
    // mirroring the post-w22.10 `Material` WGSL struct field-for-field
    // (see STANDARD_PBR_UBO_SIZE JSDoc in render-system.ts). The dynamic-
    // offset stride stays 256 B (D-P9 256-byte minimum alignment); only
    // the BindGroup entry's `size` swaps to 48 to match the new struct.
    const MATERIAL_SLICE = STANDARD_PBR_UBO_SIZE;
    // feat-20260515 M3 / T-M3-05 (research F-6 fix): materialBindGroup now
    // carries 3 entries -- the per-entity material UBO (binding 0,
    // dynamic-offset retained from D-P9), the default sampler (binding 1,
    // pipelineState.defaultSampler from createRenderer; research F-5
    // linear min/mag/mipmap + repeat addressMode), and the texture-view
    // (binding 2, resolved from MaterialSnapshot.baseColorTexture via
    // AssetRegistry.getTextureGpuView when present, falling back to the
    // pipelineState.fallbackTextureView 1x1 white pixel).
    //
    // The first validated renderable's material is sampled to choose the
    // texture-view (M3 milestone simplification; M5 lifts this to
    // per-entity slot writes once UV-driven sampling lands).
    //
    // feat-20260517-merge-mesh-renderer-material-renderer M3 / w10
    // (this commit): the prior structural cast over `firstMaterial`
    // (used to reach `baseColorTexture` before the snapshot carried
    // it as a first-class field) is removed in favour of direct
    // snapshot field access. `MaterialSnapshot` (extract-stage SSOT)
    // already declares `baseColorTexture` (M2 / w6); record reads it
    // directly with no asset registry round-trip and no cast --
    // Pipeline Isolation: extract owns the asset to snapshot
    // translation; record consumes the snapshot POD only (charter
    // proposition 5 consistent abstraction; AC-07 reverse-grep gate
    // `scripts/forgeax/check-render-record-no-material-asset-get.mjs`
    // forbids both the cast pattern and any direct material asset
    // typed-lookup regrowth in this file).
    // bug-20260522-per-entity-material-texture-binding D-1/D-2:
    // the pre-loop `firstMaterial` / `materialTextureView` / `
    // baseMaterialEntries` / single shared `materialBindGroup` are
    // removed. Each entity now creates its own per-entity material BG
    // inside the draw loop, resolving binding=2 from its own
    // `entry.source.material.baseColorTexture` (mirroring sprite path).
    //
    // feat-20260520-skylight-ibl-cubemap M3 round-4 / t48 amend: the
    // 14-entry merged BG (7 material + 7 Skylight) is now assembled per
    // entity inside the draw loop. The Skylight part stays scene-level
    // (single `skylightResources` resolved once below); only the first 7
    // material entries are rebuilt per-entity with the correct
    // per-entity textureView at binding=2.
    const skylightFallback = pipelineState.skylightFallback;
    if (skylightFallback === null) {
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'pipelineState.skylightFallback != null when PBR pipeline is active',
        hint: 'createRenderer must allocate skylightFallback alongside the PBR pipeline (D-5 round-4)',
      });
    }
    // feat-20260520-skylight-ibl-cubemap M4 round-4 / t60 (D-5 round-4):
    // select active vs fallback Skylight resources by `skylightCount` from
    // the extract stage. Active path reaches into the per-device
    // `IblPipelineCache` slots (irradianceView / prefilterView / brdfLutView)
    // populated by `uploadCubemapFromEquirect`; fallback uses the
    // 1x1-zero identity bundle that converges ambient to 0 (D-4 physical
    // convergence -- no `if (hasSkylight)` shader branch).
    // The samplers are reused from `skylightFallback.sampler` for both
    // paths (linear / clamp-to-edge is correct for IBL cube + 2D LUT
    // sampling either way). The intensity uniform is rewritten per-frame
    // when active so `sampleIblSpecular * intensity` carries the user's
    // Skylight.intensity value; fallback keeps intensity=0 (createSkylightFallback
    // seed) so ambient = 0 even when the same buffer is shared.
    let activeViews: { irr: unknown; pref: unknown; brdf: unknown } | undefined;
    // Per-frame Skylight uniform: std140 16 B = [intensity, colorR, colorG,
    // colorB]. Default to all-zero so a transition from "has Skylight" ->
    // "no Skylight" does not leak the prior frame's ambient (intensity 0
    // muzzles everything, including the white fallback irradiance cube).
    {
      const zeroPayload = new Float32Array([0, 0, 0, 0]);
      runtime.device.queue.writeBuffer(
        // biome-ignore lint/suspicious/noExplicitAny: opaque Buffer handle
        skylightFallback.intensityBuffer as any,
        0,
        zeroPayload,
      );
    }
    if (skylight !== undefined && skylightCount >= 1) {
      // A Skylight exists. Write its intensity + color regardless of whether
      // a cubemap is bound: with a cubemap the IBL views below light the
      // ambient; WITHOUT one, the white fallback irradiance cube + this color
      // give an instant solid-color ambient (downstream integration #4) with
      // no async precompute. The white fallback only contributes when a
      // Skylight is present because the zero-payload above sets intensity 0
      // when no Skylight exists.
      const [cr, cg, cb] = skylight.color;
      const uniformPayload = new Float32Array([skylight.intensity, cr, cg, cb]);
      runtime.device.queue.writeBuffer(
        // biome-ignore lint/suspicious/noExplicitAny: opaque Buffer handle
        skylightFallback.intensityBuffer as any,
        0,
        uniformPayload,
      );
      // biome-ignore lint/suspicious/noExplicitAny: device is the opaque RhiDevice
      const cache = getOrCreateIblCache(runtime.device as any);
      if (
        cache.irradianceView !== undefined &&
        cache.prefilterView !== undefined &&
        cache.brdfLutView !== undefined
      ) {
        activeViews = {
          irr: cache.irradianceView,
          pref: cache.prefilterView,
          brdf: cache.brdfLutView,
        };
      }
    }
    const skylightResources =
      activeViews !== undefined
        ? {
            irradianceView: activeViews.irr as never,
            irradianceSampler: skylightFallback.sampler,
            prefilterView: activeViews.pref as never,
            prefilterSampler: skylightFallback.sampler,
            brdfLutView: activeViews.brdf as never,
            brdfLutSampler: skylightFallback.sampler,
            intensityBuffer: skylightFallback.intensityBuffer,
          }
        : {
            irradianceView: skylightFallback.irradianceView,
            irradianceSampler: skylightFallback.sampler,
            prefilterView: skylightFallback.prefilterView,
            prefilterSampler: skylightFallback.sampler,
            brdfLutView: skylightFallback.brdfLutView,
            brdfLutSampler: skylightFallback.sampler,
            intensityBuffer: skylightFallback.intensityBuffer,
          };
    // Per-entity material uploads (D-P9 retained path).
    // feat-20260613 fix-issue-1 (D-8 channelMap split): the payload mirrors
    // the post-split sidecar paramSchema for default-standard-pbr (10 numeric
    // entries packed std140 across 80 B):
    //   [0..3]   baseColor          vec4<f32>     (offset 0)
    //   [4]      metallic           f32           (offset 16)
    //   [5]      roughness          f32           (offset 20)
    //   [6]      metallicChannel    f32           (offset 24)
    //   [7]      roughnessChannel   f32           (offset 28)
    //   [8]      aoChannel          f32           (offset 32)
    //   [9]      extraChannel       f32           (offset 36)
    //   [12..14] emissive           vec3<f32>     (offset 48, vec3 align=16)
    //   [15]     emissiveIntensity  f32           (offset 60)
    //   [16]     occlusionStrength  f32           (offset 64)
    // Channel selectors default to (B,G,R,_) = (2,1,0,0) per glTF 2.0
    // KHR_materials_pbrSpecularGlossiness ARM packing; the fragment casts
    // each f32 to u32 at the pick_channel call site. The full 80 B is
    // overwritten per-entity so unlit entities still produce a deterministic
    // payload (charter P3 explicit failure: zero-init via fresh ArrayBuffer).
    //
    // feat-20260608 M5 amend / w16-a: per-submesh material UBO slot.
    // Each entity now allocates `entry.source.materials.length` consecutive
    // 256 B slots (one per submesh material). `materialSlotStart[i]` is the
    // first-slot index (cumulative sum) so the j-th material of entity i
    // lands at `(materialSlotStart[i] + j) * MATERIAL_PER_ENTITY_STRIDE`.
    // Sprite entities and the legacy single-material path collapse to one
    // slot (length=1), preserving the byte-stable single-material layout
    // that render-system-record-pbr-ubo-stable.test.ts pins.
    const materialSlotStart: number[] = new Array(validatedOrdered.length);
    {
      let cursor = 0;
      for (let i = 0; i < validatedOrdered.length; i++) {
        materialSlotStart[i] = cursor;
        const e = validatedOrdered[i];
        if (e === undefined) continue;
        // Sprite path stays single-slot regardless of materials.length
        // (sprite per-submesh is OOS-1; the sprite UBO has its own layout).
        const slotsForEntity =
          e.source.material.shadingModel === 'sprite' ? 1 : e.source.materials.length;
        cursor += slotsForEntity;
      }
    }
    for (let i = 0; i < validatedOrdered.length; i++) {
      const entry = validatedOrdered[i];
      if (entry === undefined) continue;
      const entitySlotStart = materialSlotStart[i] ?? 0;
      const slotOffset = entitySlotStart * MATERIAL_PER_ENTITY_STRIDE;
      let payloadBuffer: ArrayBuffer;
      let payloadF32: Float32Array;

      if (entry.source.material.shadingModel === 'sprite') {
        // feat-20260527-sprite-nineslice M2 / w11 (D-3 + D-7): the inline
        // sprite UBO writer is now the `buildSpriteMaterialUboPayload`
        // helper. It produces a 4-vec4 payload (colorTint / region /
        // pivotAndSize / slicesAndMode); the slot 3 carries the 9-slice
        // sentinel (extract pre-encodes sliceMode=1 by negating slices.w).
        // The first 48 B are byte-for-byte equivalent to the legacy
        // hard-coded write path so existing sprite fixtures stay green
        // (D-7 isolation). D-7 PBR regression net (`render-system-record-
        // pbr-ubo-stable.test.ts`) catches any byte drift in the PBR
        // counterpart `buildPbrMaterialUboPayload` below.
        // feat-20260608 M5 amend / w16-a: sprite stays single-slot (sprite
        // per-submesh is OOS-1) -- one writeBuffer at slotOffset only.
        payloadBuffer = buildSpriteMaterialUboPayload(
          entry.source.material,
          entry.source.transform.world,
        );
        payloadF32 = new Float32Array(payloadBuffer);
        // Sprite missing-texture detection: helper produced the byte
        // baseline; the runtime / errorRegistry-bound debug-pink override
        // stays here because the helper is a pure POD writer.
        const matHandleRaw = entry.source.material.baseColorTexture as
          | Handle<'TextureAsset', 'shared'>
          | undefined;
        if (matHandleRaw !== undefined) {
          const view = residentTextureView(world, store, runtime, matHandleRaw);
          if (view === undefined) {
            const rawId = matHandleRaw as unknown as number;
            if (!frameState.warnedMissingSpriteTextureHandles.has(rawId)) {
              frameState.warnedMissingSpriteTextureHandles.add(rawId);
              console.warn(
                `[forgeax] sprite texture ${rawId} missing GPU view, rendering debug pink (entityIndex=${entry.renderableIndex})`,
              );
            }
            runtime.errorRegistry.fire(
              new RhiError({
                code: 'asset-not-registered',
                expected: 'sprite material baseColor TextureAsset uploaded to GPU',
                hint: 'register + uploadTexture the sprite texture before draw(world); rendering falls back to debug pink quad until then',
                detail: { assetHandle: rawId },
              }),
            );
            // Debug pink override on slot 0 colorTint.rgb (alpha preserved).
            payloadF32[0] = 1.0;
            payloadF32[1] = 0.4;
            payloadF32[2] = 0.7;
          }
        }
        // feat-20260527-sprite-nineslice M2 / w11 + AC-16: register-time
        // fail-fast catches static `slices` violations (validateSpriteSlices
        // 6 branches); runtime catches the dynamic case where Transform.scale
        // is too small to host the four corner anchors. M4 / w16 (D-5)
        // replaces the M2 placeholder console.warn with a real
        // `runtime.metrics.increment('nineslice.scale-too-small')` call so AI
        // users observe the breach through `renderer.metrics.snapshot()`
        // (charter P3 machine-readable signal over text). Per-frame anchor-
        // budget formula:
        //   scale_x must accommodate slices.x (left) + |slices.z| (right);
        //   scale_y must accommodate slices.y (top)  + |slices.w| (bottom).
        // The counter increments once per offending entity per RenderSystem
        // lifetime (the warnedNineSliceScaleEntities Set guards re-entry on
        // the same renderable index across frames so AI users see a single
        // counter bump instead of one-per-frame inflation; consistent with
        // the missing-texture warn-once anchor below).
        const sf = entry.source.material.spriteFields;
        const slicesArr = sf?.slices;
        if (slicesArr !== undefined) {
          detectNineSliceScaleTooSmall(
            entry.source.transform.world,
            slicesArr,
            entry.renderableIndex,
            frameState.warnedNineSliceScaleEntities,
            runtime.metrics,
          );
        }
      } else {
        // PBR / unlit: byte-stable helper produces the baseline; schema-
        // driven paramSnapshot overlay (feat-20260523 M9-T05, AC-14) lives
        // here because it requires the runtime ref to look up paramSchema.
        // feat-20260608 M5 amend / w16-a: build N payloads (one per
        // submesh material) and write them at consecutive slots starting
        // at materialSlotStart[i]. The single-material path (length=1)
        // collapses to one write at slotOffset, byte-stable with the
        // pre-amend layout (render-system-record-pbr-ubo-stable.test.ts).
        const matsArr = entry.source.materials;
        for (let mk = 0; mk < matsArr.length; mk++) {
          const mat = matsArr[mk];
          if (mat === undefined) continue;
          const slotPayload = buildPbrMaterialUboPayload(mat);
          const slotPayloadF32 = new Float32Array(slotPayload);
          const paramSnap = mat.paramSnapshot;
          if (paramSnap !== undefined) {
            const f32Snap = (name: string): number | undefined => {
              const v = paramSnap[name];
              return typeof v === 'number' ? v : undefined;
            };
            const colorSnap = (name: string): readonly number[] | undefined => {
              const v = paramSnap[name];
              return Array.isArray(v) && v.every((x) => typeof x === 'number')
                ? (v as readonly number[])
                : undefined;
            };
            const materialShaderId = mat.materialShaderId;
            const schema =
              materialShaderId !== undefined
                ? runtime.getParamSchema?.(materialShaderId)
                : undefined;
            if (schema !== undefined) {
              let f32SlotIdx = 0;
              let vec4SlotFilled = false;
              for (const sentry of schema) {
                if (sentry.type === 'color' || sentry.type === 'vec4') {
                  if (!vec4SlotFilled) {
                    const v = colorSnap(sentry.name);
                    if (v !== undefined) {
                      slotPayloadF32[0] = v[0] ?? 0;
                      slotPayloadF32[1] = v[1] ?? 0;
                      slotPayloadF32[2] = v[2] ?? 0;
                      slotPayloadF32[3] = v[3] ?? 1;
                    }
                    vec4SlotFilled = true;
                  }
                } else if (sentry.type === 'f32') {
                  const v = f32Snap(sentry.name);
                  if (v !== undefined) {
                    if (f32SlotIdx === 0) slotPayloadF32[4] = v;
                    else if (f32SlotIdx === 1) slotPayloadF32[5] = v;
                  }
                  f32SlotIdx++;
                }
              }
            }
          }
          const subMatUpload = runtime.device.queue.writeBuffer(
            pipelineState.materialUniformBuffer.buffer,
            (entitySlotStart + mk) * MATERIAL_PER_ENTITY_STRIDE,
            new Uint8Array(slotPayload),
          );
          if (!subMatUpload.ok) throw subMatUpload.error;
        }
        // The first material's payload is also published into payloadBuffer
        // so the legacy single-write branch below can stay a no-op for the
        // PBR/unlit path (we already wrote N slots inside the loop above).
        // Setting `payloadBuffer` to a 0-byte sentinel is unsafe (the
        // sprite branch shares this var); the cleanest exit is to skip the
        // post-block writeBuffer entirely for non-sprite. We do that with
        // an `else continue` before the post-block writeBuffer. Sprite
        // path falls through with its single slot.
        // Continue to the next entity -- the per-material writes above
        // already covered every slot.
        continue;
      }
      const materialUpload = runtime.device.queue.writeBuffer(
        pipelineState.materialUniformBuffer.buffer,
        slotOffset,
        new Uint8Array(payloadBuffer),
      );
      if (!materialUpload.ok) throw materialUpload.error;
    }

    pass.setBindGroup(0, viewBindGroup as BindGroup);

    // Track which (mesh-vertex-buffer, mesh-index-buffer, pipeline) combo
    // was last bound so consecutive entities sharing the same combo skip
    // the redundant rebinds (cheap GPU cost; net wins on workloads where
    // most entities share BUILTIN_CUBE + unlit). Initial nulls force the
    // first iteration to bind unconditionally.
    // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer.
    let lastVertexBuffer: GpuBuffer | null = null;
    let lastIndexBuffer: GpuBuffer | null = null;
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (@new-surface): pipeline
    // tag widened from 2-literal ('unlit' | 'standard') to 3-literal
    // (+ 'sprite'). The sprite path picks `spritePipeline` (LDR) or
    // `spritePipelineHdr` (HDR rgba16float target) and binds a per-
    // entity sprite material BindGroup (D-1 candidate b — 4 unused
    // entries 3..6 bind defaultSampler + defaultWhiteTextureView).
    // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
    let lastPipelineHandle: any = null;

    for (let i = 0; i < validatedOrdered.length; i++) {
      const entry = validatedOrdered[i];
      if (entry === undefined) continue;

      // feat-20260609 M2: skip entities that don't match the pass selector.
      if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;

      // D-2: sprite entities are dispatched in the separate sprite pass
      // (bgra8unorm unorm view, loadOp=load) so they must NOT be drawn
      // here in the geometry pass (bgra8unorm-srgb sRGB view, loadOp=clear).
      // In the HDR path (tonemapActive=true) or when there are no sprites,
      // splitLdrSprite=false and this guard is a no-op.
      if (splitLdrSprite && entry.source.material.shadingModel === 'sprite') continue;

      // feat-20260520-2d-sprite-layer-mvp M-3 / w25: pipeline pick widens
      // from 2-way to 3-way (+ sprite). Each shading model routes to its
      // own LDR / HDR pipeline pair via the `tonemapActive` gate; the
      // sprite path additionally requires building a per-entity sprite
      // material BindGroup with the 4-placeholder bindings (D-1
      // candidate b) so each sprite carries its own texture binding.
      const shading = entry.source.material.shadingModel;
      const materialShaderId =
        entry.source.skin !== undefined
          ? SKIN_MATERIAL_SHADER_ID
          : entry.source.material.materialShaderId;

      let pipelineTag: 'unlit' | 'sprite';
      if (shading === 'unlit') {
        pipelineTag = 'unlit';
      } else if (shading === 'sprite') {
        pipelineTag = 'sprite';
      } else if (materialShaderId !== undefined) {
        pipelineTag = 'unlit';
      } else {
        pipelineTag = 'unlit';
      }

      // w10: setStencilReference per draw when the dispatch entry carries
      // a stencil reference value (plan-strategy D-3: draw-call dynamic
      // state after setPipeline). Defaults to 0 when no reference is set
      // (WebGPU stencil reference default, semantically a no-op).
      pass.setStencilReference(entry.stencilReference ?? 0);

      if (entry.mesh.vertexBuffer !== lastVertexBuffer) {
        pass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
        lastVertexBuffer = entry.mesh.vertexBuffer;
      }
      // feat-20260604 M4 / w11: vertex-only meshes (indexed === false) carry no
      // index buffer; skip setIndexBuffer entirely and dispatch via pass.draw
      // below. Indexed meshes keep the existing setIndexBuffer path unchanged.
      if (entry.mesh.indexed && entry.mesh.indexBuffer !== lastIndexBuffer) {
        if (entry.mesh.indexBuffer !== null) {
          pass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
          lastIndexBuffer = entry.mesh.indexBuffer;
        }
      }

      // Dispatch counter bump — sprite folds into the same 2-bucket
      // surface for now (`pipelineDispatchCounts.{unlit, standard}`
      // mirror the original 2-pipeline scope; sprite-bucket counters
      // can land in a follow-up if AI users need them separately).
      // sprite entries do not bump either counter — the bench (M-4)
      // can read sprite render counts via the transparent bucket
      // length instead.
      if (pipelineTag === 'unlit') dispatchCounts.unlit += 1;

      // Resolve the per-instance buffer: ECS-managed array<f32> snapshot
      // when `Instances` present, identity fallback otherwise (consistent-
      // abstraction single branch — both paths bind something at @group(3)).
      let instanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
      let instanceCount = 1;
      const inst = entry.source.instances;
      if (inst !== undefined) {
        // feat-20260526-pbr-uniform-fallback-no-storage-buffer M3 / w13:
        // caps.storageBuffer===false -> uniform fallback with 128-instance
        // cap (128 * 64B = 8192B < WebGL2 min 16384B UBO limit).
        // caps.storageBuffer===true -> existing storage buffer path unchanged.
        const uniformFallback = runtime.device.caps.storageBuffer === false;
        let instanceBufferUsage = STORAGE_USAGE | COPY_DST_USAGE;

        if (uniformFallback) {
          if (inst.instanceCount > MAX_UNIFORM_INSTANCES) {
            runtime.errorRegistry.fire(
              new RhiError({
                code: 'limit-exceeded',
                expected: `instance count <= ${MAX_UNIFORM_INSTANCES} (uniform fallback cap)`,
                hint: `reduce instance count to ${MAX_UNIFORM_INSTANCES} or use a WebGPU-capable backend`,
                detail: {
                  maxStorageBufferBindingSize: MAX_UNIFORM_INSTANCES * 64,
                  requestedBytes: inst.instanceCount * 64,
                },
              }),
            );
            instanceCount = inst.instanceCount;
            instanceBuffer = pipelineState.identityInstanceBuffer;
            const setBgResult = runtime.device.createBindGroup({
              label: 'pbr-instances-bg',
              layout: pipelineState.instancesBindGroupLayout,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: { buffer: instanceBuffer },
                  },
                },
              ],
              // biome-ignore lint/suspicious/noExplicitAny: dynamic buffer map key
            }) as any;
            if (!setBgResult.ok) throw setBgResult.error;
            pass.setBindGroup(3, setBgResult.value as BindGroup);
            // feat-20260608 M4 / w16: per-submesh draw loop (uniform fallback path).
            for (const sm of entry.mesh.submeshes) {
              if (entry.mesh.indexed) {
                pass.drawIndexed(sm.indexCount, instanceCount, sm.indexOffset, 0, 0);
              } else {
                pass.draw(sm.vertexCount, instanceCount, 0, 0);
              }
            }
            continue;
          }
          instanceBufferUsage = UNIFORM_USAGE | COPY_DST_USAGE;
        }

        {
          // Cap-gate (LimitExceededDetail single emit point — feat-20260514
          // M3 / w15 anchor): `requestedBytes <= maxStorageBufferBindingSize`.
          const requestedBytes = inst.transforms.byteLength;
          const cap = runtime.device.limits.maxStorageBufferBindingSize;
          if (typeof cap === 'number' && requestedBytes > cap) {
            runtime.errorRegistry.fire(
              new RhiError({
                code: 'limit-exceeded',
                expected: `requestedBytes (${requestedBytes}) <= maxStorageBufferBindingSize (${cap})`,
                hint: 'reduce instance count to fit within device.limits.maxStorageBufferBindingSize, or split transforms across multiple Instances entries',
                detail: {
                  maxStorageBufferBindingSize: cap,
                  requestedBytes,
                },
              }),
            );
          } else {
            // Look up the cached GPU buffer or create a fresh one when the
            // archetype version bumped or the byte length changed.
            const cached = frameState.instanceBuffers.get(inst.cacheKey);
            let active: InstanceBufferCacheEntry | null = null;
            if (
              cached !== undefined &&
              cached.uploadedArchVersion === inst.archVersion &&
              cached.uploadedByteLength === requestedBytes
            ) {
              active = cached;
            } else if (requestedBytes > 0) {
              const bufRes = runtime.device.createBuffer({
                size: requestedBytes,
                usage: instanceBufferUsage,
                mappedAtCreation: false,
              });
              if (!bufRes.ok) {
                runtime.errorRegistry.fire(bufRes.error);
              } else {
                // feat-20260619 M4 / F12: destroy the old cached buffer
                // before replacing it with the new one (D-6).
                if (cached !== undefined && !cached.buffer.isDestroyed) {
                  const r = cached.buffer.destroy();
                  if (!r.ok) runtime.errorRegistry.fire(r.error);
                }
                const newBuffer = new GpuBuffer(runtime.device, bufRes.value);
                active = {
                  buffer: newBuffer,
                  uploadedArchVersion: inst.archVersion,
                  uploadedByteLength: requestedBytes,
                };
                frameState.instanceBuffers.set(inst.cacheKey, active);
              }
            }
            if (active !== null) {
              const writeRes = runtime.device.queue.writeBuffer(
                active.buffer.handle,
                0,
                inst.transforms,
              );
              if (!writeRes.ok) {
                runtime.errorRegistry.fire(writeRes.error);
              } else {
                instanceBuffer = active.buffer.handle;
                instanceCount = Math.max(1, inst.instanceCount);
              }
            }
          }
        }
      }

      // feat-20260531-per-frame-bind-group-cache M3 / w12: per-entity
      // instances bind group cache lookup (D-2 handle-set key).
      // Key = 'instances' + entityKey + instanceBuffer handle id.
      // The instanceBuffers cache already handles archVersion/byteLength
      // invalidation (handle changes on buffer rebuild); the BG cache
      // naturally misses when the underlying handle id differs.
      const instancesBgKey = `instances-${entry.source.entityKey}-${getOrAssignHandleId(frameState, instanceBuffer as unknown as object)}`;
      const instancesBindGroup: BindGroup = getOrCreateBindGroup(
        frameState.instancesBgCache,
        instancesBgKey,
        () => {
          const result = runtime.device.createBindGroup({
            label: 'pbr-instances-bg',
            layout: pipelineState.instancesBindGroupLayout,
            entries: [
              {
                binding: 0,
                resource: {
                  kind: 'buffer',
                  value: { buffer: instanceBuffer },
                },
              },
            ],
          });
          if (!result.ok) throw result.error;
          return result.value;
        },
        bindGroupCounts,
      );

      // feat-20260611 R2 / M8 / w28 (IS-14): skin entries need a 2-binding
      // group(2) BG matching `pbr-skin-pl` (binding 0 mesh-array UBO +
      // binding 1 palette UBO). Building this here -- not in the
      // `meshBindGroup` factory above -- because the binding-shape
      // (1-entry vs 2-entry) is per-entry, not per-frame. URP / HDRP
      // entries keep using `meshGroup2` (1-entry mesh-array or HDRP
      // unified). The skin-variant cache key includes both buffer
      // identities so a future allocator-driven palette buffer rotation
      // invalidates the BG without manual eviction.
      //
      // PSO-availability gate: only swap to the skin BG when (a) the
      // skin pipeline layout itself was built (charter P3 fail-stop on
      // BGL-build failure), AND (b) the skin PSO cache returns a non-null
      // pipeline for this entry. Without (b), the per-submesh selector
      // below falls back to URP `standardPipeline` (`pbr-pl` layout,
      // 1-entry mesh-array BGL); binding the 2-entry skin BG against
      // that pipeline reproduces the exact `pbr-mesh-array-bgl ... does
      // not match layout pbr-skin-mesh-array-bgl` device error R1
      // captured. Mirrors the uniform null skip-draw pattern (M6-T1).
      let group2BindGroup: BindGroup = meshGroup2 as BindGroup;
      // feat-20260612-skin-palette-per-frame-upload M3 / m3-2: dyn-offset
      // tuple sourced from `_computeSkinGroup2DynOffsets`.  Defaults to the
      // length-1 non-skin shape; the skin branch below re-computes with the
      // per-entity `entry.source.skin.byteOffset` cursor.
      let group2DynamicOffsets: readonly number[] = _computeSkinGroup2DynOffsets(i, undefined);
      const isSkinEntry = entry.source.skin !== undefined;
      // feat-20260612-skin-palette-per-frame-upload M1 / m1-3 + M6: the
      // record stage reads the GPU buffer reference through
      // `entry.source.skin.buffer` (per-slice carrier set at extract time
      // by allocateSlice). On the storage path every slice carries the
      // same shared buffer pointer, so the BG cache key collapses to one
      // entry per frame (miss=1 + hit=N-1). On the uniform fallback path
      // each slice carries its own per-entity 16320 B UBO, so the BG
      // cache key naturally splits per entity (one BG per buffer pointer)
      // -- there is no shared-buffer assumption to break under
      // 16 KiB UBO cap. Charter P3 explicit failure preserved: skin
      // entries skip when the pipeline layout is missing OR the slice
      // failed to allocate (no buffer field). dynOffset[1] = byteOffset
      // is 0 on the uniform path (entry already covers the full buffer)
      // and walks 0, 1536, 3072, ... on the storage path.
      const skinAllocator = pipelineState.skinPaletteAllocator;
      const skinSlice = entry.source.skin;
      const skinResources =
        isSkinEntry &&
        pipelineState.pbrSkinMeshBindGroupLayout !== null &&
        skinAllocator !== null &&
        skinSlice !== undefined
          ? {
              meshArrayBgl: pipelineState.pbrSkinMeshBindGroupLayout,
              paletteBuffer: skinSlice.buffer,
              paletteBindingWindowBytes: skinAllocator.bindingWindowBytes,
            }
          : null;
      // Probe the skin PSO cache up front so we can decide whether to swap
      // to the 2-binding skin BG. The same probe + selector is repeated in
      // the per-submesh loop below (the loop's variantSet derivation is
      // identical -- skin shader registers a single all-true variant so
      // the canonical empty-key rule applies on HDRP and the URP key is
      // the explicit expanded form, mirroring the standard PBR path).
      const skinVariantSet = frameState.isHdrpActive
        ? ''
        : 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true';
      const skinPsoProbe =
        skinResources !== null
          ? (runtime.getMaterialShaderPipeline?.(
              SKIN_MATERIAL_SHADER_ID,
              tonemapActive,
              entry.renderState,
              entry.mesh.submeshes[0]?.topology ?? 'triangle-list',
              entry.mesh.indexFormat,
              skinVariantSet,
              undefined, // passKind — defaults to 'forward'
              undefined, // meshAttributes — skin probe uses first submesh, derive from entry
              sampleCount,
            ) ?? null)
          : null;
      if (skinResources !== null && skinPsoProbe !== null) {
        const meshBindSize = runtime.device.caps.storageBuffer
          ? MESH_SSBO_BYTES
          : MESH_UBO_FULL_ARRAY_BYTES;
        const skinBgKey = buildBindGroupCacheKey(
          'pbr-skin-mesh',
          [
            pipelineState.meshStorageBuffer.buffer as unknown as object,
            skinResources.paletteBuffer as unknown as object,
          ],
          frameState,
        );
        // m3-2: skin BG cache miss / hit instrumentation. Probe the cache
        // before delegating to `getOrCreateBindGroup` so we can publish the
        // per-frame counter the m3-1 acceptanceCheck reads (miss=1 + hit
        // =N-1 across N skin entries sharing one allocator buffer + mesh
        // SSBO). The probe is read-only; the actual factory + cache.set
        // still flow through `getOrCreateBindGroup` to keep
        // `bindGroupCounts.createBindGroup` accounting in the same place.
        // Field is optional + opt-in (no PipelineState type change at this
        // milestone -- read via structural cast so prod paths that omit
        // the counter pay nothing).
        const skinStats = (pipelineState as { _skinBgCacheStats?: { miss: number; hit: number } })
          ._skinBgCacheStats;
        if (skinStats !== undefined) {
          if (frameState.meshBindGroupCache.has(skinBgKey)) skinStats.hit += 1;
          else skinStats.miss += 1;
        }
        const skinBindGroup: BindGroup = getOrCreateBindGroup(
          frameState.meshBindGroupCache,
          skinBgKey,
          () => {
            const result = runtime.device.createBindGroup({
              label: 'pbr-skin-mesh-bg',
              layout: skinResources.meshArrayBgl,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: {
                      buffer: pipelineState.meshStorageBuffer.buffer,
                      offset: 0,
                      size: meshBindSize,
                    },
                  },
                },
                {
                  binding: 1,
                  resource: {
                    kind: 'buffer',
                    value: {
                      buffer: skinResources.paletteBuffer,
                      offset: 0,
                      // M6 SSOT: static BG entry size (= MAX_JOINTS * 64 =
                      // 16320 B) sourced from the allocator. The per-draw
                      // window slides via `group2DynamicOffsets[1]`
                      // (= entry.source.skin.byteOffset) so this size
                      // stays at the worst case across all skin entries
                      // -- one BG covers every skinned draw in the frame
                      // (m3-1b miss=1 + hit=N-1 contract). The allocator
                      // guarantees `buffer.size >= byteOffset + this size`
                      // so dynOffset[1] passes WebGPU validation.
                      size: skinResources.paletteBindingWindowBytes,
                    },
                  },
                },
              ],
            });
            if (!result.ok) throw result.error;
            return result.value;
          },
          bindGroupCounts,
        );
        group2BindGroup = skinBindGroup;
        // m3-2: dyn-offset tuple via `_computeSkinGroup2DynOffsets` with the
        // per-entity palette cursor M2 m2-6 wrote at the extract stage.
        // Replaces the prior PR #353 hard-coded `0` second slot -- every
        // skin entry now points the palette window at its own slice while
        // sharing the worst-case BG entry size above.
        group2DynamicOffsets = _computeSkinGroup2DynOffsets(i, entry.source.skin?.byteOffset);
      } else if (isSkinEntry) {
        // Skin entry but skin PSO not ready (cache miss / async build pending,
        // or skin pipeline layout failed at boot). Skip the draw rather than
        // fall back to URP `pbr-pl` against the 6-attribute skin VBO -- that
        // path produced the layer-3 / layer-4 device errors R1 captured. Once
        // the async PSO compile resolves the cache hits and the next frame
        // routes the skin BG + skin pipeline together. Mirrors the uniform
        // null skip-draw shape (M6-T1, charter P3 explicit failure).
        continue;
      }
      pass.setBindGroup(2, group2BindGroup, group2DynamicOffsets);

      // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (@fallback sprite
      // bucket): sprite entries get a per-entity material BindGroup so
      // each sprite carries its own texture binding at @group(1) @binding(2).
      // Bindings 3..6 (metallicRoughness sampler/texture + normal
      // sampler/texture) bind `pipelineState.defaultSampler` +
      // `pipelineState.defaultWhiteTextureView` placeholders (D-1
      // candidate b — zero new GPU resource; the 1x1 white view was
      // already provisioned for unlit / standard fallback so the sprite
      // path adds 4 binding references, no new resource code).
      //
      // Missing-texture fallback (AC-18 path 4 + R7 isolation): when the
      // sprite texture has no GPU view, the binding uses
      // `defaultWhiteTextureView` as the fallback texture and the
      // material UBO upload above wrote debug-pink colorTint so the
      // sprite is visually distinct. The warn-once + RhiError surface
      // fires inside the upload loop. R7 isolation: this does NOT change
      // the existing unlit / standard bucket missing-texture handling —
      // those keep their silent-white fallback (a future
      // `feat-future-pbr-missing-texture-fallback-explicit` will retrofit).
      // bug-20260610 layer 7d: BG is per-submesh — each iteration of
      // the submesh draw loop below builds (or cache-hits) a BG with
      // matsForRebind[smIdx]'s 5 textureViews (baseColor / MR / normal /
      // emissive / occlusion). Cache key is 14-handle-id only (entityKey
      // dropped) so identical-material submeshes / entities dedup
      // globally. Sprite path is unchanged (single spriteBg, sprite
      // per-submesh OOS-1). The non-sprite branch leaves perSubmeshBg
      // declared but null; the submesh loop reassigns it per iteration
      // and the source-grep gate in skylight-fallback-path.test.ts /
      // systems.unit.test.ts continues to match
      // `setBindGroup\s*\(\s*1\s*,\s*perSubmeshBg\b` on the in-loop call.
      let perSubmeshBg: BindGroup | null = null;
      if (entry.source.material.shadingModel === 'sprite') {
        const spriteTexHandle = entry.source.material.baseColorTexture as
          | Handle<'TextureAsset', 'shared'>
          | undefined;
        let spriteTexView = pipelineState.defaultWhiteTextureView;
        if (spriteTexHandle !== undefined) {
          const view = residentTextureView(world, store, runtime, spriteTexHandle);
          if (view !== undefined) spriteTexView = view as never;
        }
        const spriteSampler =
          entry.source.material.sampler !== undefined
            ? pipelineState.defaultSampler // sampler asset resolution stays simple — sprite uses defaultSampler unless asset registry resolves a custom one in a follow-up
            : pipelineState.defaultSampler;
        const spriteBaseMaterialEntries = [
          {
            binding: 0,
            resource: {
              kind: 'buffer' as const,
              value: {
                buffer: pipelineState.materialUniformBuffer.buffer,
                offset: 0,
                size: STANDARD_PBR_UBO_SIZE,
              },
            },
          },
          { binding: 1, resource: { kind: 'sampler' as const, value: spriteSampler } },
          { binding: 2, resource: { kind: 'textureView' as const, value: spriteTexView } },
          // @reuses defaultSampler + defaultWhiteTextureView for the 4
          // unused PBR-layout slots; D-1 candidate (b).
          {
            binding: 3,
            resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
          },
          {
            binding: 4,
            resource: {
              kind: 'textureView' as const,
              value: pipelineState.defaultWhiteTextureView,
            },
          },
          {
            binding: 5,
            resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
          },
          {
            binding: 6,
            resource: {
              kind: 'textureView' as const,
              value: pipelineState.defaultNormalTextureView,
            },
          },
        ];
        const spriteEmissiveAo: EmissiveAoBindGroupResources = {
          emissiveSampler: pipelineState.defaultSampler,
          emissiveView: pipelineState.defaultWhiteTextureView,
          occlusionSampler: pipelineState.defaultSampler,
          occlusionView: pipelineState.defaultWhiteTextureView,
        };
        const spriteMergedEntries = assembleMaterialWithSkylightEntries(
          spriteBaseMaterialEntries,
          skylightResources,
          spriteEmissiveAo,
        );

        // M3 / w12: sprite material BG cache (D-2 handle-set key).
        // Same pattern as #9: 'material' + entityKey + ordered
        // handle ids for all 14 entries. Sprite filler b3-b6
        // (defaultSampler/defaultWhite/defaultNormal) are constant
        // handles — no spurious invalidation.
        const spriteMaterialBgKey = `material-${entry.source.entityKey}-${spriteMergedEntries
          .map((e) => getOrAssignHandleId(frameState, extractEntryResourceHandle(e)))
          .join('-')}`;
        const spriteBg: BindGroup = getOrCreateBindGroup(
          frameState.materialBgCache,
          spriteMaterialBgKey,
          () => {
            const result = runtime.device.createBindGroup({
              label: 'sprite-material-bg',
              layout: pipelineState.materialBindGroupLayout,
              entries: spriteMergedEntries,
            });
            if (!result.ok) throw result.error;
            return result.value;
          },
          bindGroupCounts,
        );
        // feat-20260608 M5 amend / w16-a: dynamic offset uses
        // materialSlotStart[i] (cumulative from preceding entities) since
        // multi-material entities now occupy >1 slot. Sprite stays single
        // slot (sprite per-submesh is OOS-1).
        pass.setBindGroup(1, spriteBg, [(materialSlotStart[i] ?? 0) * MATERIAL_PER_ENTITY_STRIDE]);
      } else {
        // bug-20260610 layer 7d: per-submesh BG construction.
        //
        // Prior to this fix, this branch built a single BG per entity using
        // `entry.source.material` (= materials[0]) for all 5 textureViews
        // (baseColor / metallicRoughness / normal / emissive / occlusion).
        // feat-20260608 M5 amend introduced per-submesh MaterialUBO slots
        // but kept the entity-level texture views, so multi-material
        // entities (Sponza: 1 entity x 25 materials x 103 submeshes)
        // sampled materials[0]'s textures across every submesh.
        //
        // The actual BG is now built inside the per-submesh draw loop
        // below using `matsForRebind[smIdx]`. This branch leaves
        // perSubmeshBg=null and becomes structural so the source-grep
        // gate (`setBindGroup\s*\(\s*1\s*,\s*perSubmeshBg\b`) keeps
        // firing on the per-submesh setBindGroup call inside the loop.
      }
      pass.setBindGroup(3, instancesBindGroup);
      // feat-20260608 M4 / w16: per-submesh pipeline selection + draw loop.
      // Each submesh carries its own topology, so pipeline selection is per-submesh.
      // Vertex/index buffers and bind groups are set once (shared across all submeshes).
      // feat-20260608 M5 amend / w16-a: the material UBO bind (group=1)
      // ALSO moves into the loop -- the j-th submesh sees the j-th
      // material slot via dynamic offset (entitySlotStart + j) * 256.
      const entityMatBaseOffset = (materialSlotStart[i] ?? 0) * MATERIAL_PER_ENTITY_STRIDE;
      const matsForRebind = entry.source.materials;
      const isSpriteEntry = entry.source.material.shadingModel === 'sprite';
      for (let smIdx = 0; smIdx < entry.mesh.submeshes.length; smIdx++) {
        const sm = entry.mesh.submeshes[smIdx];
        if (sm === undefined) continue;
        if (!isSpriteEntry) {
          // bug-20260610 layer 7d: per-submesh BG construction. Texture
          // views resolve from `matsForRebind[smIdx]` so the j-th submesh
          // sees its own materials[j] textures (baseColor / MR / normal /
          // emissive / occlusion). Pick slot j when materials.length covers
          // smIdx; otherwise fall back to slot 0 (count-mismatch already
          // filtered by extract; this guard handles the materials.length=1
          // single-material path mapped over multi-submesh meshes safely).
          // Cache key drops entityKey: identical-texture-set submeshes
          // (whether on the same entity or different ones) share one BG.
          // The 14 handle ids fully discriminate the binding state since
          // sampler/textureView/buffer handles are stable per frame
          // (frameState's getOrAssignHandleId is per-frame).
          const matSlotIdx = smIdx < matsForRebind.length ? smIdx : 0;
          const submeshMaterial = matsForRebind[matSlotIdx] ?? entry.source.material;
          // feat-20260621-learn-render-5-5-parallax M2 / w8 (D-3): assemble the
          // user-region bind group by iterating the shader's
          // derive(paramSchema).textureFieldNames SSOT (sampler-first pairing,
          // matching derive().bglEntries ordering), instead of hardcoding
          // baseColor/MR/normal at binding 2/4/6. Any Nth texture (e.g. parallax
          // heightTexture) flows through here without a coupled edit. Each field
          // reads its handle from MaterialSnapshot.textureHandles; a missing
          // handle falls back to the per-field default view (charter P3:
          // graceful — texture params are optional at register time).
          const smShaderId = submeshMaterial.materialShaderId;
          // Field NAMES come from the shader's own schema so the handle lookup
          // resolves the shader's declared textures (e.g. parallax's
          // diffuse/normal/depth, which differ from the built-in
          // baseColor/MR/normal even though both derive a 3-pair user-region).
          // The COUNT/order must match the BGL bound below: w6 hands out a
          // per-shader BGL whenever the derived user-region shape differs from
          // the shared built-in (getMaterialBindGroupLayout); a same-shape
          // shader (3 texture2d pairs) reuses the shared BGL and its own 3
          // fields produce the identical 3-pair shape.
          const smPerShaderBgl =
            smShaderId !== undefined ? runtime.getMaterialBindGroupLayout?.(smShaderId) : undefined;
          const smSchema =
            smShaderId !== undefined ? runtime.getParamSchema?.(smShaderId) : undefined;
          const smUserRegionFields = userRegionTextureFieldOrder(smSchema);
          const smBaseEntries: BindGroupEntry[] = [
            {
              binding: 0,
              resource: {
                kind: 'buffer' as const,
                value: {
                  buffer: pipelineState.materialUniformBuffer.buffer,
                  offset: 0,
                  size: MATERIAL_SLICE,
                },
              },
            },
          ];
          // The bind group MUST emit exactly as many texture pairs as the bound
          // BGL's user-region declares (mismatch => dawn "Binding entry not
          // set"). The shared built-in BGL has a fixed 3-pair user-region; a
          // per-shader BGL (w6) has one pair per shader-declared texture. Fill
          // each slot positionally from the shader's own fields (so parallax's
          // diffuse/normal/depth resolve) and pad any remaining shared-BGL
          // slots with default views (so a 1-texture material like unlit still
          // satisfies all 3 shared slots).
          const smBglPairCount =
            smPerShaderBgl !== undefined
              ? smUserRegionFields.length
              : BUILTIN_USER_REGION_TEXTURE_FIELDS.length;
          // Sampler-first pairs at binding 1+2i (sampler) / 2+2i (texture),
          // matching derive(paramSchema).bglEntries (sampler emitted first).
          for (let fi = 0; fi < smBglPairCount; fi++) {
            const field = smUserRegionFields[fi];
            const samplerBinding = 1 + fi * 2;
            const textureBinding = samplerBinding + 1;
            let smView: unknown =
              field !== undefined
                ? defaultViewForUserRegionField(field, pipelineState)
                : pipelineState.defaultWhiteTextureView;
            const smHandle =
              field !== undefined ? submeshMaterial.textureHandles?.get(field) : undefined;
            if (smHandle !== undefined) {
              const view = residentTextureView(world, store, runtime, smHandle);
              if (view !== undefined) smView = view;
            }
            smBaseEntries.push(
              {
                binding: samplerBinding,
                resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
              },
              {
                binding: textureBinding,
                resource: { kind: 'textureView' as const, value: smView as never },
              },
            );
          }
          // emissive / occlusion live in the engine-injection lightmap region,
          // assembled after the user-region by assembleMaterialWithSkylightEntries.
          let smEmissiveView: unknown = pipelineState.defaultWhiteTextureView;
          const smEmissiveHandle = submeshMaterial.emissiveTexture;
          if (smEmissiveHandle !== undefined) {
            const view = residentTextureView(world, store, runtime, smEmissiveHandle);
            if (view !== undefined) smEmissiveView = view;
          }
          let smOcclusionView: unknown = pipelineState.defaultWhiteTextureView;
          const smOcclusionHandle = submeshMaterial.occlusionTexture;
          if (smOcclusionHandle !== undefined) {
            const view = residentTextureView(world, store, runtime, smOcclusionHandle);
            if (view !== undefined) smOcclusionView = view;
          }
          const smEmissiveAo: EmissiveAoBindGroupResources = {
            emissiveSampler: pipelineState.defaultSampler,
            emissiveView: smEmissiveView as never,
            occlusionSampler: pipelineState.defaultSampler,
            occlusionView: smOcclusionView as never,
          };
          const smMergedEntries = assembleMaterialWithSkylightEntries(
            smBaseEntries,
            skylightResources,
            smEmissiveAo,
          );
          // bug-20260610 layer 7d: cache key drops the per-entity entityKey
          // segment so identical-material submeshes/entities dedup globally.
          // Insert a non-numeric sentinel ('shared') in the 2nd segment so
          // cleanPerEntityCache (which parses `<prefix>-<entityKey>-<rest>`)
          // skips these entries — Number(<'shared'>) yields NaN, the cleanup
          // loop's `Number.isNaN(ek)` branch keeps the entry alive across
          // frames. Without this prefix, cleanup treats the first handle id
          // as a candidate entityKey, mismatches the validated set, and
          // drops the entry every frame -> AC-03 hello-cube smoke fails
          // (frame-3 createBindGroupCount=1, expected 0).
          // feat-20260621-learn-render-5-5-parallax M2 / w8: a custom shader
          // with >3 textures owns a per-shader material BGL (w6); the bind
          // group must be created against THAT layout so the entry count
          // (e.g. 20 for a 4-texture shader) matches. Built-in / 3-texture
          // shaders resolve to the shared 18-entry BGL. The cache key includes
          // the shaderId so two shaders with a coincidentally-identical handle
          // set never collide on layout.
          const smMaterialBgl = smPerShaderBgl ?? pipelineState.materialBindGroupLayout;
          const submeshMaterialBgKey = `material-shared-${smShaderId ?? ''}-${smMergedEntries
            .map((e) => getOrAssignHandleId(frameState, extractEntryResourceHandle(e)))
            .join('-')}`;
          perSubmeshBg = getOrCreateBindGroup(
            frameState.materialBgCache,
            submeshMaterialBgKey,
            () => {
              const result = runtime.device.createBindGroup({
                label: 'pbr-material-skylight-bg',
                layout: smMaterialBgl,
                entries: smMergedEntries,
              });
              if (!result.ok) throw result.error;
              return result.value;
            },
            bindGroupCounts,
          );
          pass.setBindGroup(1, perSubmeshBg, [
            entityMatBaseOffset + matSlotIdx * MATERIAL_PER_ENTITY_STRIDE,
          ]);
        }
        const smTopology = sm.topology;
        let smPipelineHandle: typeof pipelineState.unlitPipeline;
        const nonDefaultTopology = smTopology !== 'triangle-list';
        if (shading === 'unlit') {
          const unlitRsp =
            (entry.renderState !== undefined || nonDefaultTopology) &&
            materialShaderId !== undefined
              ? runtime.getMaterialShaderPipeline?.(
                  materialShaderId,
                  tonemapActive,
                  entry.renderState,
                  smTopology,
                  entry.mesh.indexFormat,
                  undefined, // variantSet — unlit path has no variant
                  undefined, // passKind — defaults to 'forward'
                  undefined, // meshAttributes — unlit uses 4-attribute layout
                  sampleCount,
                )
              : undefined;
          smPipelineHandle =
            unlitRsp ?? selectGeometryPipeline(pipelineState, 'unlit', tonemapActive, msaaActive);
        } else if (shading === 'sprite') {
          smPipelineHandle = selectGeometryPipeline(
            pipelineState,
            'sprite',
            tonemapActive,
            msaaActive,
          );
        } else if (materialShaderId !== undefined) {
          // feat-20260609 M4.5 / w38 (D-11): the variantSet handed to
          // getMaterialShaderPipeline MUST mirror the boot-time
          // `definesKey` rule at createRenderer.ts:2483-2485 (sortedEntries
          // .every(v=>v===true) ? '' : 'A=v+...'). manifest variant.definesKey
          // is `''` for the all-true variant, so HDRP (both axes true) must
          // pass the canonical empty key to hit that variant via
          // findVariantByKey. Passing the expanded form would produce a
          // miss and silently fall back to the registered default WGSL,
          // creating a layout/binding mismatch under HDRP.
          //
          // URP path passes the explicit expanded form because the URP
          // variant's manifest definesKey IS that exact non-empty string
          // (CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true)
          // -- the canonical-empty rule only applies to the all-true case.
          const variantSet = frameState.isHdrpActive
            ? ''
            : 'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true';
          const cachedPipeline =
            runtime.getMaterialShaderPipeline?.(
              materialShaderId,
              tonemapActive,
              entry.renderState,
              smTopology,
              entry.mesh.indexFormat,
              variantSet,
              undefined, // passKind — defaults to 'forward'
              undefined, // meshAttributes — only skin path needs non-undefined
              sampleCount,
            ) ?? null;
          // feat-20260615-pipeline-spec-ssot M6-T1: cache miss resolves to
          // null uniformly across URP / HDRP / skin shaders. Charter P3
          // explicit failure: the pre-M6 URP-path silent fallback to the
          // boot-time `pipelineState.standardPipeline*` (M4.5-followup w43)
          // masked real PipelineSpecError build failures behind a
          // layout-compatible-but-wrong PSO. The per-submesh
          // `if (smPipelineHandle === null) continue` skip-draw (which
          // already covered HDRP-active and skin miss paths) is now the
          // single uniform recovery shape -- one frame of skip-draw on
          // first-touch, then the cached PSO flows in once the async
          // build resolves. The pre-loop skin-PSO probe still skips the
          // entire entry on first-submesh probe miss; this site only
          // fires on per-submesh topology variance miss.
          smPipelineHandle = cachedPipeline ?? null;
        } else {
          smPipelineHandle = selectGeometryPipeline(
            pipelineState,
            'unlit',
            tonemapActive,
            msaaActive,
          );
        }

        if (smPipelineHandle === null) {
          continue;
        }

        if (lastPipelineHandle !== smPipelineHandle) {
          // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
          pass.setPipeline(smPipelineHandle as any);
          lastPipelineHandle = smPipelineHandle;
        }

        if (entry.mesh.indexed) {
          pass.drawIndexed(sm.indexCount, instanceCount, sm.indexOffset, 0, 0);
        } else {
          pass.draw(sm.vertexCount, instanceCount, 0, 0);
        }
      }
    }

    // D-2: LDR sprite pass. Runs after the geometry pass when there are
    // sprite entities in the draw list and the LDR path is active.
    // The geometry pass used the bgra8unorm-srgb sRGB view (hardware sRGB
    // encoding for unlit/standard/pbr output). The sprite pass uses the
    // bgra8unorm storage view (loadOp=load) so the sprite LDR pipeline
    // (target=bgra8unorm, blend=premultiplied-alpha) can write over the
    // already-encoded geometry pixels. Depth is loaded from the geometry
    // pass so sprite-vs-mesh occlusion (depthCompare=less-equal) is
    // preserved (plan-strategy §2 D-2 + §4 R-4).
    if (splitLdrSprite && ldrSpriteUnormView !== null) {
      pass.end();
      geometryPassEnded = true;

      // feat-20260604 M2 / w9 (F-1): under MSAA the sprite sub-pass writes the
      // count=4 unorm view of the SAME multisample texture the geometry pass
      // wrote (loadOp=load preserves geometry under sprites) and resolves the
      // combined result to the single-sample swap-chain unorm view at this
      // (last) pass end. Depth reuses the shared count=4 multisample depth
      // (depthLoadOp=load preserves sprite-vs-mesh occlusion). The single-
      // sample path is byte-for-byte unchanged (writes the swap-chain view).
      const spriteColorView = msaaActive ? ldrSpriteColorView : ldrSpriteUnormView;
      // sprite-split sub-pass: forward shape with both color and depth loaded
      // (preserves prior content from the main forward pass under the sprites).
      // Stencil ops auto-emitted by the helper because depthFormat carries
      // stencil8.
      const spritePass: RhiRenderPassEncoder = encoder.beginRenderPass(
        buildBeginRenderPassDescriptor(
          {
            // bug-20260616: SSOT for the sprite-pass color format is the
            // runtime swap-chain storage format. The sprite PSO target was
            // pre-feat wired to `swapChainFormats.storage` (raw, non-srgb)
            // and this pass writes through the raw view of the same texture
            // (`ldrSpriteUnormView`), so encoder + PSO must agree. Hard-coding
            // `'bgra8unorm'` here broke Channel 3 / dawn-node where the
            // storage format is `rgba8unorm` (Attachment state mismatch fired
            // every frame: PSO target rgba8unorm-srgb vs encoder bgra8unorm).
            colorFormats: [pipelineState.format as unknown as GPUTextureFormat],
            depthFormat: 'depth24plus-stencil8',
            sampleCount: msaaActive ? 4 : 1,
          },
          {
            colorViews: [spriteColorView],
            depthView: geometryDepthView,
            ...(msaaActive ? { resolveTargets: [ldrSpriteUnormView] } : {}),
          },
          'forward',
          { colorLoadOp: 'load', depthLoadOp: 'load' },
        ) as never,
      );

      spritePass.setBindGroup(0, viewBindGroup as BindGroup);

      // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
      let lastSpritePipelineHandle: any = null;
      // M-3 / w12: sprite pass vertexBuffer/indexBuffer state migrate to GpuBuffer.
      let lastSpriteVertexBuffer: GpuBuffer | null = null;
      let lastSpriteIndexBuffer: GpuBuffer | null = null;
      const spritePH = msaaActive ? pipelineState.spritePipelineMsaa : pipelineState.spritePipeline;

      for (let i = 0; i < validatedOrdered.length; i++) {
        const spriteEntry = validatedOrdered[i];
        if (spriteEntry === undefined || spriteEntry.source.material.shadingModel !== 'sprite')
          continue;

        // feat-20260609 M2: skip entities that don't match the pass selector.
        if (matchedIndices !== null && !matchedIndices.has(spriteEntry.renderableIndex)) continue;

        if (spritePH === null) {
          runtime.errorRegistry.fire(
            new RhiError({
              code: 'shader-compile-failed',
              expected:
                'manifest entries include sprite.wgsl + the engine triple (pbr + unlit + tonemap)',
              hint: 'verify @forgeax/engine-vite-plugin-shader emits manifest.json with the 4 engine entries (sprite.wgsl is required when spawning sprite materials); check vite plugin engineEntries option',
            }),
          );
          return;
        }

        if (lastSpritePipelineHandle !== spritePH) {
          // biome-ignore lint/suspicious/noExplicitAny: opaque RHI pipeline handle
          spritePass.setPipeline(spritePH as any);
          lastSpritePipelineHandle = spritePH;
        }

        if (spriteEntry.mesh.vertexBuffer !== lastSpriteVertexBuffer) {
          spritePass.setVertexBuffer(0, spriteEntry.mesh.vertexBuffer.handle);
          lastSpriteVertexBuffer = spriteEntry.mesh.vertexBuffer;
        }
        if (
          spriteEntry.mesh.indexBuffer !== null &&
          spriteEntry.mesh.indexBuffer !== lastSpriteIndexBuffer
        ) {
          spritePass.setIndexBuffer(
            spriteEntry.mesh.indexBuffer.handle,
            spriteEntry.mesh.indexFormat,
          );
          lastSpriteIndexBuffer = spriteEntry.mesh.indexBuffer;
        }

        // Instance buffer resolution: same cap-gate logic as the geometry
        // pass entity loop; sprites with Instances (e.g. hello-sprite-atlas
        // 100-instance walk-cycle) require per-entity storage buffer upload.
        // SSOT mirror of geometry pass instances block above (~line 1610):
        // identical cap-gate sequence (storageBuffer cap → limit-exceeded →
        // cache-lookup → createBuffer → writeBuffer); variable names carry
        // "sprite" prefix; logic divergence would be a bug.
        let spriteInstanceBuffer: Buffer = pipelineState.identityInstanceBuffer;
        let spriteInstanceCount = 1;
        const spriteInst = spriteEntry.source.instances;
        if (spriteInst !== undefined) {
          const uniformFallback = runtime.device.caps.storageBuffer === false;
          let spriteBufUsage = STORAGE_USAGE | COPY_DST_USAGE;

          if (uniformFallback) {
            if (spriteInst.instanceCount > MAX_UNIFORM_INSTANCES) {
              runtime.errorRegistry.fire(
                new RhiError({
                  code: 'limit-exceeded',
                  expected: `instance count <= ${MAX_UNIFORM_INSTANCES} (uniform fallback cap)`,
                  hint: `reduce instance count to ${MAX_UNIFORM_INSTANCES} or use a WebGPU-capable backend`,
                  detail: {
                    maxStorageBufferBindingSize: MAX_UNIFORM_INSTANCES * 64,
                    requestedBytes: spriteInst.instanceCount * 64,
                  },
                }),
              );
              spriteInstanceCount = spriteInst.instanceCount;
              spriteInstanceBuffer = pipelineState.identityInstanceBuffer;
              const spriteInstBgResult = runtime.device.createBindGroup({
                label: 'sprite-pass-instances-bg',
                layout: pipelineState.instancesBindGroupLayout,
                entries: [
                  {
                    binding: 0,
                    resource: {
                      kind: 'buffer',
                      value: { buffer: spriteInstanceBuffer },
                    },
                  },
                ],
                // biome-ignore lint/suspicious/noExplicitAny: opaque RHI descriptor
              }) as any;
              if (!spriteInstBgResult.ok) throw spriteInstBgResult.error;
              spritePass.setBindGroup(3, spriteInstBgResult.value as BindGroup);
              spritePass.drawIndexed(spriteEntry.mesh.indexCount, spriteInstanceCount, 0, 0, 0);
              continue;
            }
            spriteBufUsage = UNIFORM_USAGE | COPY_DST_USAGE;
          }

          {
            const requestedBytes = spriteInst.transforms.byteLength;
            const cap = runtime.device.limits.maxStorageBufferBindingSize;
            if (typeof cap === 'number' && requestedBytes > cap) {
              runtime.errorRegistry.fire(
                new RhiError({
                  code: 'limit-exceeded',
                  expected: `requestedBytes (${requestedBytes}) <= maxStorageBufferBindingSize (${cap})`,
                  hint: 'reduce instance count to fit within device.limits.maxStorageBufferBindingSize, or split transforms across multiple Instances entries',
                  detail: {
                    maxStorageBufferBindingSize: cap,
                    requestedBytes,
                  },
                }),
              );
            } else {
              const cachedSprite = frameState.instanceBuffers.get(spriteInst.cacheKey);
              let activeSprite: InstanceBufferCacheEntry | null = null;
              if (
                cachedSprite !== undefined &&
                cachedSprite.uploadedArchVersion === spriteInst.archVersion &&
                cachedSprite.uploadedByteLength === requestedBytes
              ) {
                activeSprite = cachedSprite;
              } else if (requestedBytes > 0) {
                const bufRes = runtime.device.createBuffer({
                  size: requestedBytes,
                  usage: spriteBufUsage,
                  mappedAtCreation: false,
                });
                if (!bufRes.ok) {
                  runtime.errorRegistry.fire(bufRes.error);
                } else {
                  // feat-20260619 M4 / F12: destroy the old cached buffer
                  // before replacing it with the new one (D-6).
                  if (cachedSprite !== undefined && !cachedSprite.buffer.isDestroyed) {
                    const r = cachedSprite.buffer.destroy();
                    if (!r.ok) runtime.errorRegistry.fire(r.error);
                  }
                  const newBuf = new GpuBuffer(runtime.device, bufRes.value);
                  activeSprite = {
                    buffer: newBuf,
                    uploadedArchVersion: spriteInst.archVersion,
                    uploadedByteLength: requestedBytes,
                  };
                  frameState.instanceBuffers.set(spriteInst.cacheKey, activeSprite);
                }
              }
              if (activeSprite !== null) {
                const writeRes = runtime.device.queue.writeBuffer(
                  activeSprite.buffer.handle,
                  0,
                  spriteInst.transforms,
                );
                if (!writeRes.ok) {
                  runtime.errorRegistry.fire(writeRes.error);
                } else {
                  spriteInstanceBuffer = activeSprite.buffer.handle;
                  spriteInstanceCount = Math.max(1, spriteInst.instanceCount);
                }
              }
            }
          }
        }

        // M3 / w12: LDR sprite split pass per-entity instances BG cache.
        // Same pattern as #7.
        const spriteInstancesBgKey = `instances-${spriteEntry.source.entityKey}-${getOrAssignHandleId(frameState, spriteInstanceBuffer as unknown as object)}`;
        const spriteInstancesBg: BindGroup = getOrCreateBindGroup(
          frameState.instancesBgCache,
          spriteInstancesBgKey,
          () => {
            const result = runtime.device.createBindGroup({
              label: 'sprite-pass-instances-bg',
              layout: pipelineState.instancesBindGroupLayout,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: { buffer: spriteInstanceBuffer },
                  },
                },
              ],
            });
            if (!result.ok) throw result.error;
            return result.value;
          },
          bindGroupCounts,
        );

        spritePass.setBindGroup(2, meshBindGroup as BindGroup, [i * MESH_PER_ENTITY_STRIDE]);

        // Per-entity sprite material bind group: same 7-entry layout as in
        // the geometry pass sprite branch + Skylight merged entries (same
        // skylightResources in scope from above). Texture view is resolved
        // from the sprite material's baseColorTexture handle.
        const spriteTexHandle = spriteEntry.source.material.baseColorTexture as
          | Handle<'TextureAsset', 'shared'>
          | undefined;
        let spriteTexView = pipelineState.defaultWhiteTextureView;
        if (spriteTexHandle !== undefined) {
          const tv = residentTextureView(world, store, runtime, spriteTexHandle);
          if (tv !== undefined) spriteTexView = tv as never;
        }
        const spritePassBaseMaterialEntries = [
          {
            binding: 0,
            resource: {
              kind: 'buffer' as const,
              value: {
                buffer: pipelineState.materialUniformBuffer.buffer,
                offset: 0,
                size: STANDARD_PBR_UBO_SIZE,
              },
            },
          },
          {
            binding: 1,
            resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
          },
          { binding: 2, resource: { kind: 'textureView' as const, value: spriteTexView } },
          {
            binding: 3,
            resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
          },
          {
            binding: 4,
            resource: {
              kind: 'textureView' as const,
              value: pipelineState.defaultWhiteTextureView,
            },
          },
          {
            binding: 5,
            resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
          },
          {
            binding: 6,
            resource: {
              kind: 'textureView' as const,
              value: pipelineState.defaultNormalTextureView,
            },
          },
        ];
        const spritePassEmissiveAo: EmissiveAoBindGroupResources = {
          emissiveSampler: pipelineState.defaultSampler,
          emissiveView: pipelineState.defaultWhiteTextureView,
          occlusionSampler: pipelineState.defaultSampler,
          occlusionView: pipelineState.defaultWhiteTextureView,
        };
        const spritePassMergedEntries = assembleMaterialWithSkylightEntries(
          spritePassBaseMaterialEntries,
          skylightResources,
          spritePassEmissiveAo,
        );

        // M3 / w12: LDR sprite split-pass per-entity material BG cache.
        // Same pattern as #8/#9.
        const spritePassMaterialBgKey = `material-${spriteEntry.source.entityKey}-${spritePassMergedEntries
          .map((e) => getOrAssignHandleId(frameState, extractEntryResourceHandle(e)))
          .join('-')}`;
        const spritePassBg: BindGroup = getOrCreateBindGroup(
          frameState.materialBgCache,
          spritePassMaterialBgKey,
          () => {
            const result = runtime.device.createBindGroup({
              label: 'sprite-pass-material-bg',
              layout: pipelineState.materialBindGroupLayout,
              entries: spritePassMergedEntries,
            });
            if (!result.ok) throw result.error;
            return result.value;
          },
          bindGroupCounts,
        );

        spritePass.setBindGroup(1, spritePassBg, [i * MATERIAL_PER_ENTITY_STRIDE]);
        spritePass.setBindGroup(3, spriteInstancesBg);
        spritePass.drawIndexed(spriteEntry.mesh.indexCount, spriteInstanceCount, 0, 0, 0);
      }

      spritePass.end();
    }
  } // end if (validatedOrdered.length > 0) -- Case E falls through to pass.end()

  if (!geometryPassEnded) {
    pass.end();
  }
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13c: FXAA post-process
 * fullscreen pass, extracted verbatim from recordFrame. copyTextureToTexture
 * (swap-chain -> intermediate) then a fullscreen FXAA fragment pass writes
 * the anti-aliased result back into the swap-chain view, all on the SHARED
 * frame encoder (c.encoder). The pre-pass copy stays inside this closure
 * (graph first version models copy as a pass-internal op, not a separate
 * graph node). Gated on camera.antialias==='fxaa'. Driven by the 'fxaa'
 * graph pass.
 */
// ── feat-20260531-bloom-first-declarative-render-graph-pass / w14 ──
// Bloom execute closure placeholders. Real implementations in w15.
// The graph must declare execute callbacks for addPass; these empty stubs
// keep compile() satisfied until w15 fills in the actual record logic.
//
// Gate: bloom === 'off' || !tonemapActive => early-return (AC-04/AC-05).
// The closures receive RenderPipelineContext and route to w15 record functions.

export function recordBloomBrightPass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const { runtime, pipelineState, encoder, camera, tonemapActive } = _c;
  const pp = pipelineState.perPassResources;

  // Double gate: bloom=off => zero-overhead; tonemap=none => no HDR domain
  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomBrightPipeline === null ||
    pp.bloomBrightBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomBrightParamsBuffer === null
  )
    return;

  // M1 / w7: bloom intermediate textures owned by render-graph. Resolve
  // the GPU TextureView via the resolve context passed by graph.execute().
  const bloomBrightView = resolve?.resolve('bloomBright') as TextureView | undefined;
  const hdrColorView = resolve?.resolve('hdrColor') as TextureView | undefined;
  if (!bloomBrightView || !hdrColorView) return;

  // 2. Write threshold UBO (16 B std140: threshold f32 + 12 B pad).
  const brightParams = new Float32Array(4);
  brightParams[0] = camera.bloomThreshold;
  brightParams[1] = 0;
  brightParams[2] = 0;
  brightParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(pp.bloomBrightParamsBuffer, 0, brightParams);
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 3. Lazy BindGroup (1 tex + 1 sampler + 1 UBO).
  if (pp.bloomBrightBindGroup === null) {
    const bgRes = runtime.device.createBindGroup({
      label: 'bloom-bright-bg',
      layout: pp.bloomBrightBindGroupLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: hdrColorView } },
        { binding: 1, resource: { kind: 'sampler', value: pp.bloomSampler } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer: pp.bloomBrightParamsBuffer } } },
      ],
    });
    if (!bgRes.ok) throw bgRes.error;
    pp.bloomBrightBindGroup = bgRes.value;
  }

  // 4. Render pass into the 1/2-res intermediate.
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [bloomBrightView] },
      'bloom-bright',
    ) as never,
  );
  pass.setPipeline(pp.bloomBrightPipeline);
  pass.setBindGroup(0, pp.bloomBrightBindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordBloomBlurHPass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const { runtime, pipelineState, encoder, camera, targetW, tonemapActive } = _c;
  const pp = pipelineState.perPassResources;

  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomBlurHPipeline === null ||
    pp.bloomBlurBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomBlurParamsBuffer === null
  )
    return;

  // M1 / w7: bloom intermediate textures owned by render-graph. Resolve
  // via the resolve context passed by graph.execute().
  const bloomBlurHView = resolve?.resolve('bloomBlurH') as TextureView | undefined;
  const bloomBrightView = resolve?.resolve('bloomBright') as TextureView | undefined;
  if (!bloomBlurHView || !bloomBrightView) return;

  // 2. Write blur params UBO (16 B std140: texelSize.xy + radius + pad).
  // H-axis: texel offset along x only.
  const bw = Math.floor(targetW / 2);
  const blurParams = new Float32Array(4);
  blurParams[0] = bw > 0 ? 1.0 / bw : 1.0; // texelSize.x
  blurParams[1] = 0; // texelSize.y = 0 for H pass
  blurParams[2] = camera.bloomBlurRadius;
  blurParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(pp.bloomBlurParamsBuffer, 0, blurParams);
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 3. Lazy BindGroup (reads bloomBright from graph).
  if (pp.bloomBlurHBindGroup === null) {
    const bgRes = runtime.device.createBindGroup({
      label: 'bloom-blur-h-bg',
      layout: pp.bloomBlurBindGroupLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: bloomBrightView } },
        { binding: 1, resource: { kind: 'sampler', value: pp.bloomSampler } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer: pp.bloomBlurParamsBuffer } } },
      ],
    });
    if (!bgRes.ok) throw bgRes.error;
    pp.bloomBlurHBindGroup = bgRes.value;
  }

  // 4. Render pass into bloomBlurH intermediate (graph-owned).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [bloomBlurHView] },
      'bloom-blur',
    ) as never,
  );
  pass.setPipeline(pp.bloomBlurHPipeline);
  pass.setBindGroup(0, pp.bloomBlurHBindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordBloomBlurVPass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const { runtime, pipelineState, encoder, camera, targetH, tonemapActive } = _c;
  const pp = pipelineState.perPassResources;

  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomBlurVPipeline === null ||
    pp.bloomBlurBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomBlurParamsBuffer === null
  )
    return;

  // M1 / w7: bloom intermediate textures owned by render-graph. Resolve
  // via the resolve context passed by graph.execute().
  const bloomBlurVView = resolve?.resolve('bloomBlurV') as TextureView | undefined;
  const bloomBlurHView = resolve?.resolve('bloomBlurH') as TextureView | undefined;
  if (!bloomBlurVView || !bloomBlurHView) return;

  // 2. Write blur params UBO (16 B std140: texelSize.xy + radius + pad).
  // V-axis: texel offset along y only.
  const bh = Math.floor(targetH / 2);
  const blurParams = new Float32Array(4);
  blurParams[0] = 0; // texelSize.x = 0 for V pass
  blurParams[1] = bh > 0 ? 1.0 / bh : 1.0; // texelSize.y
  blurParams[2] = camera.bloomBlurRadius;
  blurParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(pp.bloomBlurParamsBuffer, 0, blurParams);
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 3. Lazy BindGroup (reads bloomBlurH from graph).
  if (pp.bloomBlurVBindGroup === null) {
    const bgRes = runtime.device.createBindGroup({
      label: 'bloom-blur-v-bg',
      layout: pp.bloomBlurBindGroupLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: bloomBlurHView } },
        { binding: 1, resource: { kind: 'sampler', value: pp.bloomSampler } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer: pp.bloomBlurParamsBuffer } } },
      ],
    });
    if (!bgRes.ok) throw bgRes.error;
    pp.bloomBlurVBindGroup = bgRes.value;
  }

  // 4. Render pass into bloomBlurV intermediate (graph-owned).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [bloomBlurVView] },
      'bloom-blur',
    ) as never,
  );
  pass.setPipeline(pp.bloomBlurVPipeline);
  pass.setBindGroup(0, pp.bloomBlurVBindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordBloomCompositePass(
  _c: _InternalRenderPipelineContext,
  resolve?: ResolveContext,
): void {
  const { runtime, pipelineState, encoder, camera, tonemapActive } = _c;
  const pp = pipelineState.perPassResources;

  if (camera.bloom !== 'on' || !tonemapActive) return;
  if (
    pp.bloomCompositePipeline === null ||
    pp.bloomCompositeBindGroupLayout === null ||
    pp.bloomSampler === null ||
    pp.bloomCompositeParamsBuffer === null
  )
    return;

  // M1 / w7: hdrColor + bloomBlurV textures owned by render-graph.
  const hdrColorView = resolve?.resolve('hdrColor') as TextureView | undefined;
  const bloomBlurVView = resolve?.resolve('bloomBlurV') as TextureView | undefined;
  if (!hdrColorView || !bloomBlurVView) return;

  // 1. Write composite params UBO (16 B std140: intensity + 12 B pad).
  const compositeParams = new Float32Array(4);
  compositeParams[0] = camera.bloomIntensity;
  compositeParams[1] = 0;
  compositeParams[2] = 0;
  compositeParams[3] = 0;
  const paramsWrite = runtime.device.queue.writeBuffer(
    pp.bloomCompositeParamsBuffer,
    0,
    compositeParams,
  );
  if (!paramsWrite.ok) throw paramsWrite.error;

  // 2. Lazy BindGroup (2 tex: hdrColor + bloomBlurV, 1 sampler, 1 UBO).
  if (pp.bloomCompositeBindGroup === null) {
    const bgRes = runtime.device.createBindGroup({
      label: 'bloom-composite-bg',
      layout: pp.bloomCompositeBindGroupLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: hdrColorView } },
        { binding: 1, resource: { kind: 'textureView', value: bloomBlurVView } },
        { binding: 2, resource: { kind: 'sampler', value: pp.bloomSampler } },
        {
          binding: 3,
          resource: { kind: 'buffer', value: { buffer: pp.bloomCompositeParamsBuffer } },
        },
      ],
    });
    if (!bgRes.ok) throw bgRes.error;
    pp.bloomCompositeBindGroup = bgRes.value;
  }

  // 3. Render pass: write hdrColor in-place (composite adds bloom on top).
  // bloom-composite policy is the only color-only kind with default loadOp='load'
  // (preserves the geometry beneath the additive composite).
  const pass: RhiRenderPassEncoder = encoder.beginRenderPass(
    buildBeginRenderPassDescriptor(
      { colorFormats: ['rgba16float'], depthFormat: undefined, sampleCount: 1 },
      { colorViews: [hdrColorView] },
      'bloom-composite',
    ) as never,
  );
  pass.setPipeline(pp.bloomCompositePipeline);
  pass.setBindGroup(0, pp.bloomCompositeBindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
}

export function recordFxaaPass(c: _InternalRenderPipelineContext): void {
  const { runtime, pipelineState, encoder, camera, targetW, targetH, currentTexture } = c;
  // feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M2 / w14:
  // refactored to use FullscreenPostProcessPass primitive. The FXAA pass
  // reads the swap-chain (via copyTextureToTexture -> fxaaIntermediate),
  // then executes a fullscreen FXAA fragment pass that writes the
  // anti-aliased result back into the swap-chain non-srgb storage view
  // (R-COLORSPACE: source is already sRGB-encoded; writing through srgb
  // view would double-encode — see color-space contract below).
  //
  // D-1 copy approach: encoder.copyTextureToTexture from swap-chain to
  // graph-owned fxaaIntermediate, then FXAA pass writes swap-chain.
  const fxaaActive = camera.antialias === 'fxaa';
  if (
    fxaaActive &&
    pipelineState.perPassResources.fxaaPipeline !== null &&
    pipelineState.perPassResources.fxaaBindGroupLayout !== null &&
    pipelineState.perPassResources.fxaaSampler !== null &&
    pipelineState.perPassResources.fxaaIntermediateTexture !== null &&
    pipelineState.perPassResources.fxaaIntermediateView !== null
  ) {
    // Copy swap-chain content to the graph-owned fxaaIntermediate texture.
    const swapTex = currentTexture as never;
    encoder.copyTextureToTexture(
      { texture: swapTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      {
        texture: pipelineState.perPassResources.fxaaIntermediateTexture as never,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: 0 },
      },
      { width: targetW, height: targetH, depthOrArrayLayers: 1 },
    );

    // Compose the 2-entry FXAA BindGroup (input texture + sampler) lazily.
    // The primitive resolves both through the pre-built BGL/sampler stored
    // in perPassResources (built once in createRenderer's ready phase).
    // The bindgroup is cached per-frame and invalidated on resize when
    // fxaaIntermediateView changes identity (D-3: physical texture identity
    // self-check from bindgroup-resize-invalidation).
    if (pipelineState.perPassResources.fxaaBindGroup === null) {
      const fxaaBgRes = runtime.device.createBindGroup({
        label: 'fxaa-bg',
        layout: pipelineState.perPassResources.fxaaBindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'textureView',
              value: pipelineState.perPassResources.fxaaIntermediateView,
            },
          },
          {
            binding: 1,
            resource: { kind: 'sampler', value: pipelineState.perPassResources.fxaaSampler },
          },
        ],
      });
      if (!fxaaBgRes.ok) throw fxaaBgRes.error;
      pipelineState.perPassResources.fxaaBindGroup = fxaaBgRes.value;
    }
    const fxaaBg = pipelineState.perPassResources.fxaaBindGroup;

    // R-COLORSPACE: write through the swap-chain's non-srgb storage view
    // (bgra8unorm). FXAA's source is ALREADY sRGB-encoded (verbatim copy
    // of swap-chain, sampled through non-srgb view → no decode). The shader
    // works in gamma space and emits sRGB-encoded values — writing through
    // the srgb view would double-encode and brighten every pixel.
    const fxaaStorageViewRes = runtime.device.createTextureView(currentTexture, {});
    if (!fxaaStorageViewRes.ok) {
      runtime.errorRegistry.fire(fxaaStorageViewRes.error);
      return;
    }
    const fxaaPass: RhiRenderPassEncoder = encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        { colorFormats: ['bgra8unorm'], depthFormat: undefined, sampleCount: 1 },
        { colorViews: [fxaaStorageViewRes.value] },
        'fxaa',
      ) as never,
    );
    fxaaPass.setPipeline(pipelineState.perPassResources.fxaaPipeline);
    fxaaPass.setBindGroup(0, fxaaBg);
    fxaaPass.draw(3, 1, 0, 0);
    fxaaPass.end();
  }
}

export function computeViewMatrix(camera: CameraSnapshot): Mat4 {
  // feat-20260601 D-3: view = invert(camera world mat4). The camera's resolved
  // world mat4 (propagateTransforms output) is read straight off the snapshot;
  // no recompose from decomposed TRS.
  const cameraFromWorld = mat4.create();
  mat4.invert(cameraFromWorld, camera.world as unknown as Mat4);
  return cameraFromWorld;
}

export function computeProjectionMatrix(camera: CameraSnapshot): Mat4 {
  // feat-20260613 M6 / w20: branch on projection variant. The view UBO
  // record path needs the right matrix shape so the main pass renders
  // correctly under both perspective and orthographic cameras (mirrors
  // the CSM extract fix in render-system-extract.ts).
  const proj = mat4.create();
  if (camera.projection === 'orthographic') {
    mat4.orthographic(
      proj,
      camera.orthoLeft,
      camera.orthoRight,
      camera.orthoBottom,
      camera.orthoTop,
      camera.near,
      camera.far,
    );
  } else {
    mat4.perspective(proj, camera.fov, camera.aspect, camera.near, camera.far);
  }
  return proj;
}
