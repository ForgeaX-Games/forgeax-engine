// @forgeax/engine-runtime - RenderSystem main entry (D-S2 three-stage Extract ->
// Prepare -> Record + 4-tier error fan-out).
//
// Engine-internal phase: NOT registered to World schedule (AC-09);
// `Renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })` invokes once per frame. See `Renderer` JSDoc in
// `./render-contract.ts` for the public error/frame contract and AGENTS.md
// "ECS render bridge" section for the AI-user-facing contract.
//
// Stage carve-out (review round 1 finding #3 - 505 line cap fallback):
//   - render-system.ts          (this file)             types + orchestration
//   - render-system-extract.ts  Extract ECS query phase + snapshot helpers
//   - render-system-record.ts   Prepare + Record GPU phase + matrix helpers
//
// @forgeax/engine-math is referenced through render-system-record.ts which builds
// view/proj matrices and worldFromLocal via `mat4.compose / .multiply /
// .invert` (charter proposition 5: no math reinvention; render-system.test.ts
// asserts `/@forgeax\/engine-math/` shows up in render-system.ts source).

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { RecorderSession } from '@forgeax/engine-profiler';
import type { BindGroupEntry, BindGroupLayout, Buffer, RenderPipeline } from '@forgeax/engine-rhi';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import {
  derive,
  type Handle,
  type MaterialAsset,
  type MaterialTextureValue,
  type MeshAsset,
  type RenderPipelineAsset,
  RenderQueue,
  type SamplerAsset,
  toShared,
} from '@forgeax/engine-types';
import { createClusterBinScratch } from './cluster-binner';
import {
  type ObservationUnavailableError,
  PointsLinesMaterialUnsupportedError,
  type RenderError,
} from './errors/render';
import {
  type RenderFeaturePreparedGraphicsResolverInput,
  runRenderFeatureFrame,
  settlePreparedGraphicsCompletion,
} from './features/host';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuWorkOwner,
} from './features/prepared-gpu-work';
import { resolveStandardRenderFeatureTargets } from './features/targets';
import {
  buildFullscreenPostProcessPass,
  DEPTH_MIN_PARAMS_BYTE_SIZE,
  entryHasDepthRead,
  type PostProcessShaderEntry,
} from './fullscreen-post-process-pass';
import { GpuDrivenProduction } from './gpu-driven/production-raster';
import type { RenderSceneInspection } from './inspection-types';
import { admitPointsLines } from './points-lines/admission';
import { PointsLinesExpansionCache } from './points-lines/expansion-cache';
import {
  inspectPointsLines,
  type PointsLinesInspection,
  type PointsLinesSourceError,
} from './points-lines/inspection';
import {
  createPointsLinesLanePreparationAdapter,
  type PointsLinesLanePreparationAdapter,
} from './points-lines/prepare';
import { createPointsLinesLaneAdapter, type PointsLinesBackend } from './points-lines/record';
import type { PointsLinesRetainedSnapshot } from './points-lines/snapshot';
import type { PointsLinesRecordOwner, PointsLinesRecordSubmission } from './record/render-context';

export type { RenderSceneInspection } from './inspection-types';

import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from './gpu-usage';
import { assembleMaterialWithSkylightEntries } from './ibl/skylight-bind-group';
import { disposeInstanceBuffers, disposeTransientInstanceBuffers } from './instance-buffer-cache';
import type { MeshMaterialBindingObservation } from './mesh-material-bindings';
import { validateClusterGrid } from './pipeline/standard-pipeline';
import { DEFAULT_CLUSTER_GRID } from './pipeline/standard-profile';
import { PostProcessError } from './post-process-errors';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolver,
} from './prepare/prepared-graphics-resolver';
import {
  type FrameObservation,
  type FrameObservationOptions,
  observeCurrentFrame,
  type RecordProfileRunner,
  recordFrame,
} from './record/frame';
import { buildPerFrameBindGroups } from './record/frame-lighting';
import type { RenderFrameState } from './record/frame-snapshot';
import { applyParamSnapshotToUbo, residentTextureView } from './record/main-pass-material';
import type { RenderSystemInternals } from './record/render-context';
import {
  type RenderFeatureGraphCandidate,
  resetRenderFeatureGraphState,
} from './record/typed-frame-graph';
import {
  type CameraSnapshot,
  type DrawOwnerOptions,
  RENDER_PHASE_CATALOG,
  type RenderPhase,
  type RenderPhaseSkipReason,
  type RenderRecordPhase,
} from './render-contract';
import type { DispatchEntry, ExtractedFrame, RenderableSnapshot } from './render-system-extract';
import { extractFrames } from './render-system-extract';
import { PersistentRenderScene } from './scene/render-scene';
import { resolveSsaoParameters } from './ssao-config';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from './systems/transparent-sort-config';

export type {
  _InternalRenderPipelineContext,
  _StandardForwardSceneView,
  PerPassResources,
  PipelineState,
  RenderSystemInternals,
  RenderSystemRuntime,
  SurfaceBackendKind,
  SwapChainFormatPair,
} from './record/render-context';
export {
  configureSurface,
  MATERIAL_PER_ENTITY_STRIDE,
  resolveSurfaceFormatPair,
  STANDARD_PBR_UBO_SIZE,
  selectSwapChainFormat,
} from './record/render-context';

/**
 * Unified transparent-queue sub-sort covering all four
 * {@link TransparentSortConfig} modes. Reorders the
 * `queue === RenderQueue.Transparent` segment of the dispatch list;
 * all other queue segments keep their relative order.
 *
 * | mode | primary key | secondary key | tertiary key |
 * |:--:|:--|:--|:--|
 * | 0 (LAYER_Z)   | `layer` ASC | `posZ` ASC | `materialHandle` ASC |
 * | 1 (LAYER_Y)   | `layer` ASC | `-(posY - pivotY * sizeY)` ASC | `materialHandle` ASC |
 * | 2 (LAYER_YZ)  | `layer` ASC | `(posY - pivotY * sizeY) + yzAlpha * posZ` ASC | `materialHandle` ASC |
 * | 3 (DISTANCE)  | `-(dist² from camera)` ASC (back-to-front, layer ignored) | — |
 *
 * The `materialHandle` tertiary key for modes 0/1/2 groups same-material
 * entries together whenever the primary+secondary sort values are equal
 * (e.g. tilemap tiles in the same row/layer share `posY` in LAYER_Y mode).
 * Consecutive same-material groups then collapse into fold buckets in the
 * record-stage fold operator, significantly reducing draw call count for
 * tilemap-heavy scenes.
 *
 * `posX/Y/Z` = translation column of the entity's world mat4 (indices 12/13/14).
 * `pivotY` = `RenderableSnapshot.material.paramSnapshot.pivotAndSize[1]` (default 0.5).
 * `sizeY`  = length of the Y-axis column of the world mat4 (indices 4/5/6).
 */
function sortTransparentDispatch(
  dispatch: DispatchEntry[],
  world: World,
  cameras: readonly CameraSnapshot[],
  renderables: readonly RenderableSnapshot[],
): DispatchEntry[] {
  const cfg = getTransparentSortConfig(world);
  const mode = cfg.mode;

  // Indices of Transparent-queue entries within the dispatch list.
  const transparentSlots: number[] = [];
  for (let i = 0; i < dispatch.length; i++) {
    if (dispatch[i]?.queue === RenderQueue.Transparent) transparentSlots.push(i);
  }
  if (transparentSlots.length <= 1) return dispatch;

  let sortedSlotOrder: number[];

  if (mode === TRANSPARENT_SORT_MODE_DISTANCE) {
    const camera = cameras[0];
    if (camera === undefined) return dispatch;
    const camPos = camera.position;

    // Squared camera distance per entry (negated → ascending = back-to-front).
    // D-3: world position = translation column of Transform.world (m[12,13,14]).
    const negDistSq = (entry: DispatchEntry): number => {
      const tx = renderables[entry.renderableIndex]?.transform;
      if (tx === undefined) return 0;
      const w = tx.world;
      const dx = (w[12] ?? 0) - (camPos[0] ?? 0);
      const dy = (w[13] ?? 0) - (camPos[1] ?? 0);
      const dz = (w[14] ?? 0) - (camPos[2] ?? 0);
      return -(dx * dx + dy * dy + dz * dz);
    };

    sortedSlotOrder = transparentSlots.slice().sort((a, b) => {
      const da = negDistSq(dispatch[a] as DispatchEntry);
      const db = negDistSq(dispatch[b] as DispatchEntry);
      if (da < db) return -1;
      if (da > db) return 1;
      return 0;
    });
  } else {
    // Modes 0/1/2: primary = layer ASC, secondary = mode-formula ASC.
    // sizeY = length of the Y-axis column (col1 = indices 4,5,6) of the
    // world mat4; rotation-invariant and handles flipV sign correctly.
    const sortVal = (entry: DispatchEntry): number => {
      const tx = renderables[entry.renderableIndex]?.transform;
      const w = tx?.world;
      const posY = (w?.[13] ?? 0) as number;
      const posZ = (w?.[14] ?? 0) as number;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return posZ;
      const mat = renderables[entry.renderableIndex]?.material;
      // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w15: post
      // SpriteFieldsSnapshot ablation, pivot lives in paramSnapshot
      // .pivotAndSize[0..1] (UBO-aligned vec4 slot 2, plan D-6). Non-sprite
      // materials carry paramSnapshot=undefined and fall back to 0.5.
      const pivotAndSize = mat?.paramSnapshot?.pivotAndSize as readonly number[] | undefined;
      const pivotY = (pivotAndSize?.[1] ?? 0.5) as number;
      const wy4 = (w?.[4] ?? 0) as number;
      const wy5 = (w?.[5] ?? 1) as number;
      const wy6 = (w?.[6] ?? 0) as number;
      const sizeY = Math.sqrt(wy4 * wy4 + wy5 * wy5 + wy6 * wy6);
      const footY = posY - pivotY * sizeY;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Y) return -footY;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_YZ) return footY + cfg.yzAlpha * posZ;
      // Defensive fallback for an unknown mode that slips past setTransparentSortConfig.
      return posZ;
    };

    sortedSlotOrder = transparentSlots.slice().sort((a, b) => {
      const da = dispatch[a] as DispatchEntry;
      const db = dispatch[b] as DispatchEntry;
      const la = da.layer;
      const lb = db.layer;
      if (la !== lb) return la - lb;
      const va = sortVal(da);
      const vb = sortVal(db);
      if (va < vb) return -1;
      if (va > vb) return 1;
      // Tertiary tiebreaker: group same-materialHandle entries together so
      // fold-eligible consecutive runs form. Entries at equal (layer,
      // sortVal) — e.g. tilemap tiles in the same row under LAYER_Y — are
      // depth-equivalent; reordering them by material does not change the
      // visual result but maximises fold-bucket width.
      return da.materialHandle - db.materialHandle;
    });
  }

  // Scatter the reordered Transparent entries back into their original slots.
  const result = dispatch.slice();
  for (let k = 0; k < transparentSlots.length; k++) {
    const targetSlot = transparentSlots[k] as number;
    const sourceSlot = sortedSlotOrder[k] as number;
    result[targetSlot] = dispatch[sourceSlot] as DispatchEntry;
  }
  return result;
}

/**
 * Engine-internal Extract / Prepare / Record driver; constructed by createRenderer.
 *
 * w15 M5 dual-pipeline dispatch: `pipelineDispatchCounts` surfaces per-frame
 * counters of how many entities were routed to each pipeline (plan-strategy
 * D-P4 / requirements AC-07). The counts roll over monotonically — test
 * callers read them after `draw([world], { cameraOwner: 0, resourceOwner: 0 })` to assert each tag saw >= 1 draw.
 * Reset is intentional on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry so per-frame assertions
 * stay local (charter proposition 4 explicit failure: test code sees exact
 * per-draw counts, not stale cross-frame totals).
 *
 * bug-20260519: BUILTIN cube migrated to 12F so the legacy `unlitBuiltin`
 * counter is gone; the surface collapses to `unlit` (every entity whose
 * shader identity is `forgeax::default-unlit`) + `standard` (every entity
 * whose shader identity is `forgeax::default-standard-pbr`).
 */
export interface RenderSystem {
  /** Returns true only when this invocation reached queue submission. */
  draw(
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    renderReadLeases?: readonly RenderReadLease[],
  ): boolean;
  /** Release renderer-owned persistent state for one detached World. */
  detachScene(world: World): void;
  /** Release the profiler catalog contribution owned by this RenderSystem. */
  releaseProfilerCatalog(): void;
  observeCurrentFrame(
    options: FrameObservationOptions,
  ): Promise<Result<FrameObservation, ObservationUnavailableError>>;
  readonly pipelineDispatchCounts: {
    readonly unlit: number;
  };
  /**
   * feat-20260528-frustum-culling M5 / w14: per-frame frustum-culling counters.
   * Updated by `draw([world], { cameraOwner: 0, resourceOwner: 0 })` on every call from the Extract stage.
   */
  readonly frustumStats: { culled: number; total: number };
  /** Per-frame candidate entities rejected by author visibility. */
  readonly visibilityStats: { explicitlyHidden: number };
  /** Persistent scene maintenance evidence from the ordinary single-World path. */
  readonly renderScene: RenderSceneInspection;
  /** Retained Points/Lines authoring facts from the single scene projection. */
  readonly pointsLinesSnapshots: readonly PointsLinesRetainedSnapshot[];
  /** Current mesh-slot provenance and active diagnostics from the last frame. */
  readonly meshMaterialBindings: readonly MeshMaterialBindingObservation[];
  /**
   * feat-20260531-bloom-first-declarative-render-graph-pass M4 fix-up w19:
   * per-frame render-graph pass names in declaration order. Empty array
   * before the first `draw([world], { cameraOwner: 0, resourceOwner: 0 })` call; populated after the per-frame
   * graph is built (lazily on first draw). Read-only introspection surface
   * so smoke tests can assert the declarative pass chain is wired without
   * reaching into engine internals.
   */
  readonly perFramePassNames: readonly string[];
  /**
   * feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
   * createBindGroup counter. Reset to 0 on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry,
   * bumped on each cache-miss createBindGroup call in the record stage.
   * Aligns with pipelineDispatchCounts precedent: closure-mutable object
   * + draw-entry reset + readonly getter. Stable-frame AC-03 asserts
   * createBindGroup == 0 when all bind groups are cache-resident.
   *
   * M5 / w19 type-safe finalization: the return type is purposely the
   * narrowest inline object literal `{ readonly createBindGroup: number }`
   * rather than a wider Record/alias — this ensures TS language service
   * hover shows the exact field name + type, and AC-09 consumption sites
   * infer `number` without `as` casts (plan-strategy D-7 + sec.8
   * discoverability).
   */
  readonly bindGroupCounts: {
    readonly createBindGroup: number;
    readonly keys: readonly string[];
  };
  /** Configure the sole Standard graph owner before the first frame. */
  configureStandard(config: RenderPipelineAsset['config']): void;
  /** Register one engine-owned post-process shader used by the Standard lane. */
  registerBuiltinPostProcess(id: string, entry: PostProcessShaderEntry): () => void;
  /**
   * feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w21:
   * release the per-RenderSystem frame-state GPU bookkeeping during
   * `Renderer.dispose()`. Retires the compiled graph and clears the instance-buffer cache.
   *
   * Idempotent (architecture-principles §6): a second call after both
   * structures are cleared is a no-op. Per-step failures inside drain /
   * disposeInstanceBuffers fall through silently -- the Renderer.dispose
   * cascade owns the try/catch + errorRegistry.fire fan-out (D-3).
   */
  disposeFrameState(): void;

  /**
   * feat-20260622-s5 M3 / B-2 / w18: drop the device-bound state the recover()
   * rebuild must shed before re-running the pipeline build against a fresh
   * device. Two effects, both keyed to the lost device:
   *   1. the per-frame render-graph's pendingDestroy queue (PooledTextures
   *      minted by the lost device — clearPendingDestroy skips destroyTexture);
   *   2. post-process declarations + their eager param UBOs. Declarations are
   *      CPU-owned author intent and survive; UBOs are stale lost-device
   *      handles and are rebuilt after the replacement device is live.
   * Idempotent and graph-optional (no-op when nothing has compiled yet).
   */
  resetForRecover(): void;
  /** Recreate post-process GPU parameter resources after a device rebuild. */
  restorePostProcessResources(): void;
}

function isStructuredRendererError(error: unknown): error is RhiError | RenderError {
  if (!(error instanceof Error)) return false;
  const structured = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  return (
    typeof structured.code === 'string' &&
    typeof structured.expected === 'string' &&
    typeof structured.hint === 'string' &&
    structured.detail !== undefined
  );
}

function reportPreparedGraphicsCompletionError(
  internals: RenderSystemInternals,
  error: unknown,
): void {
  if (isStructuredRendererError(error)) {
    internals.errorRegistry.fire(error);
    return;
  }
  const innerError =
    error instanceof RhiError
      ? error
      : { code: 'unknown' as const, message: String(error), name: (error as Error)?.name };
  internals.errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'prepared graphics completion cleanup reports its errors',
      hint: 'inspect detail.error for the underlying retirement or recovery failure',
      detail: { error: innerError },
    }),
  );
}

function isPendingRenderFeaturePreparation(error: RenderError): boolean {
  return (
    error.code === 'render-feature-preparation-failed' &&
    error.detail.reason.startsWith('rhi-not-available:')
  );
}

function makePreparedPipelinePendingError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'prepared pipeline shader module warm-up to finish asynchronously',
    hint: 'retry the prepared graphics pass on the next frame',
  });
}

type PointsLinesGpuResources = {
  readonly vertexBuffer: Buffer;
  readonly indexBuffer: Buffer;
};
type PointsLinesPreparationAdapter = PointsLinesLanePreparationAdapter<PointsLinesGpuResources>;

/**
 * The Standard renderer's single Points/Lines prepare owner.
 *
 * The retained snapshot is the identity boundary; this owner only resolves
 * the source assets, runs admission, and publishes the existing preparation
 * and record contracts to the main geometry loop. The expansion cache is
 * shared across lanes and this owner keeps the one prepared vertex/index
 * resource pair for each retained identity.
 */
class StandardPointsLinesOwner implements PointsLinesRecordOwner {
  private readonly cache = new PointsLinesExpansionCache();
  private readonly preparations = new Map<string, PointsLinesPreparationAdapter>();
  private readonly active = new Map<string, PointsLinesInspection>();
  private readonly layoutProjection = deriveVertexLayoutProjection({
    position: new Float32Array(0),
    normal: new Float32Array(0),
    uv: new Float32Array(0),
    tangent: new Float32Array(0),
  });

  constructor(private readonly internals: RenderSystemInternals) {}

  beginFrame(): void {
    this.active.clear();
  }

  prepare(
    entry: import('./record/frame-snapshot').ValidatedRenderable,
    clustered: boolean,
  ): PointsLinesRecordSubmission | undefined {
    const snapshot = entry.source.pointsLines;
    if (snapshot === undefined || snapshot.component === undefined || entry.world === undefined) {
      return undefined;
    }
    const key = `${snapshot.worldId}:${snapshot.entityKey}`;
    const topology = snapshot.component === 'Points' ? 'point-list' : 'line-list';
    const backend = this.backend();
    const lane = backend === 'wgpu-webgl2' ? 'cpu-webgl2' : clustered ? 'clustered' : 'direct';
    const meshResult = resolveAssetHandle<MeshAsset>(
      entry.world,
      toShared<'MeshAsset'>(entry.source.assetHandle),
    );
    const materialResult = resolveAssetHandle<MaterialAsset>(
      entry.world,
      toShared<'MaterialAsset'>(snapshot.materialHandle),
    );
    if (!meshResult.ok || !materialResult.ok) {
      this.publishRefusal(
        snapshot,
        new PointsLinesMaterialUnsupportedError({
          entity: snapshot.entityKey,
          material: 'unresolved',
          pass: 'forward',
          module: 'asset-resolution',
          reason: 'source MeshAsset or MaterialAsset could not be resolved',
        }),
      );
      return undefined;
    }
    const admission = admitPointsLines({
      entity: snapshot.entityKey,
      mesh: meshResult.value,
      material: materialResult.value,
      ...(snapshot.style?.kind === 'points'
        ? {
            points: {
              sizePx: snapshot.style.sizePx,
              shape: snapshot.style.shape === 'circle' ? 1 : 0,
            },
          }
        : { lines: { widthPx: snapshot.style?.widthPx ?? 1 } }),
    });
    if (!admission.ok) {
      this.publishRefusal(snapshot, admission.error);
      return undefined;
    }
    const geometryKey = this.cache.getOrCreate(snapshot, meshResult.value).key;
    const prepKey = `${geometryKey}:${lane}:${backend}`;
    let preparation = this.preparations.get(prepKey);
    if (preparation === undefined) {
      preparation = createPointsLinesLanePreparationAdapter(lane, backend, {
        cache: this.cache,
        adapter: {
          create: (geometry) => {
            const vertex = this.internals.device.createBuffer({
              label: `points-lines-vertices:${geometryKey}`,
              size: Math.max(4, geometry.vertices.byteLength),
              usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
              mappedAtCreation: false,
            });
            if (!vertex.ok) return err(vertex.error);
            const index = this.internals.device.createBuffer({
              label: `points-lines-indices:${geometryKey}`,
              size: Math.max(4, geometry.indices.byteLength),
              usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
              mappedAtCreation: false,
            });
            if (!index.ok) {
              this.internals.device.destroyBuffer(vertex.value);
              return err(index.error);
            }
            return ok({ vertexBuffer: vertex.value, indexBuffer: index.value });
          },
          upload: (resource, geometry) => {
            if (geometry.vertices.byteLength > 0) {
              const vertexWrite = this.internals.device.queue.writeBuffer(
                resource.vertexBuffer,
                0,
                geometry.vertices,
              );
              if (!vertexWrite.ok) return err(vertexWrite.error);
            }
            if (geometry.indices.byteLength > 0) {
              const indexWrite = this.internals.device.queue.writeBuffer(
                resource.indexBuffer,
                0,
                geometry.indices,
              );
              if (!indexWrite.ok) return err(indexWrite.error);
            }
            return ok(geometry.derivedBytes);
          },
          validate: (_resource, geometry) =>
            geometry.expandedVertexCount > 0 && geometry.expandedIndexCount > 0
              ? ok(undefined)
              : err(new Error('Points/Lines expansion contains no drawable triangles')),
          destroy: (resource) => {
            this.internals.device.destroyBuffer(resource.vertexBuffer);
            this.internals.device.destroyBuffer(resource.indexBuffer);
          },
        },
      });
      this.preparations.set(prepKey, preparation);
    }
    const prepared = preparation.prepare(snapshot, meshResult.value);
    if (!prepared.ok) {
      const lkg = preparation.lastKnownGood();
      if (lkg !== undefined) {
        const lkgPlan = createPointsLinesLaneAdapter(lane, backend).createRecordPlan(
          lkg.snapshot,
          lkg.geometry,
        );
        const state = preparation.inspect();
        this.active.set(
          key,
          inspectPointsLines({
            snapshot,
            topology,
            lane,
            pointCount: lkg.geometry.pointCount,
            segmentCount: lkg.geometry.segmentCount,
            sourceBytes: lkg.geometry.sourceBytes,
            derivedBytes: lkg.geometry.derivedBytes,
            cache: { hit: true, rebuilds: state.rebuilds, evictions: 0 },
            drawCount: lkgPlan.drawCount,
            uploadBytes: 0,
            lastKnownGood: true,
            refusal: {
              code: prepared.error.code,
              expected: prepared.error.expected,
              hint: prepared.error.hint,
              detail: prepared.error.detail,
              generation: prepared.error.detail.generation,
              lastKnownGood: true,
            },
          }),
        );
        return {
          plan: lkgPlan,
          vertexBuffer: lkg.resource.vertexBuffer,
          indexBuffer: lkg.resource.indexBuffer,
          layoutProjection: this.layoutProjection,
        };
      }
      this.publishRefusal(snapshot, prepared.error);
      return undefined;
    }
    const plan = createPointsLinesLaneAdapter(lane, backend).createRecordPlan(
      snapshot,
      prepared.value.geometry,
    );
    const state = preparation.inspect();
    this.active.set(
      key,
      inspectPointsLines({
        snapshot,
        topology,
        lane,
        pointCount: prepared.value.geometry.pointCount,
        segmentCount: prepared.value.geometry.segmentCount,
        sourceBytes: prepared.value.geometry.sourceBytes,
        derivedBytes: prepared.value.geometry.derivedBytes,
        cache: {
          hit: prepared.value.uploadedBytes === 0,
          rebuilds: state.rebuilds,
          evictions: 0,
        },
        drawCount: plan.drawCount,
        uploadBytes: prepared.value.uploadedBytes,
        lastKnownGood: prepared.value.lastKnownGood,
      }),
    );
    return {
      plan,
      vertexBuffer: prepared.value.resource.vertexBuffer,
      indexBuffer: prepared.value.resource.indexBuffer,
      layoutProjection: this.layoutProjection,
    };
  }

  resetForDeviceLoss(): void {
    for (const preparation of this.preparations.values()) preparation.resetForDeviceLoss();
    this.active.clear();
  }

  inspections(): readonly PointsLinesInspection[] {
    return [...this.active.values()];
  }

  private backend(): PointsLinesBackend {
    switch (this.internals.device.caps.backendKind) {
      case 'wgpu-webgl2':
        return 'wgpu-webgl2';
      case 'null':
        return 'null';
      default:
        return 'webgpu';
    }
  }

  private publishRefusal(
    snapshot: PointsLinesRetainedSnapshot,
    error: PointsLinesSourceError,
  ): void {
    this.active.set(
      `${snapshot.worldId}:${snapshot.entityKey}`,
      inspectPointsLines({
        snapshot,
        topology: snapshot.component === 'Points' ? 'point-list' : 'line-list',
        lane: 'refused',
        pointCount: 0,
        segmentCount: 0,
        sourceBytes: 0,
        derivedBytes: 0,
        cache: { hit: false, rebuilds: 0, evictions: 0 },
        drawCount: 0,
        uploadBytes: 0,
        lastKnownGood: false,
        refusal: {
          code: error.code,
          expected: error.expected,
          hint: error.hint,
          detail: error.detail,
          generation: snapshot.meshGeneration,
          lastKnownGood: false,
        },
      }),
    );
  }
}

export function createRenderSystem(internals: RenderSystemInternals): RenderSystem {
  const phaseCatalogRegistration = internals.profiler?.registerPhaseCatalog(
    'render',
    RENDER_PHASE_CATALOG,
  );
  let releaseProfilerCatalog =
    phaseCatalogRegistration?.ok === true ? phaseCatalogRegistration.value : undefined;
  let preparedWorlds: readonly World[] = [];
  const pointsLinesOwner = new StandardPointsLinesOwner(internals);
  const persistentRenderScene = new PersistentRenderScene({
    getDevice: () => internals.device,
    onGpuError: (error) => internals.errorRegistry.fire(error),
    onSharedRefMutation: (worldId, handle) => {
      internals.gpuStore.invalidateMesh(handle, preparedWorlds[worldId] ?? worldId);
    },
  });
  const gpuDrivenShaderFactory =
    internals.shaderModuleFactory ??
    ({
      createShaderModule: () =>
        err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'the renderer backend exposes shader module creation',
            hint: 'construct the renderer through the backend pack before activating GPU-driven rendering',
          }),
        ),
    } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory);
  let gpuDrivenProduction = new GpuDrivenProduction(internals.device, gpuDrivenShaderFactory);
  const featureGpuWork: RenderFeatureGpuWorkOwner = createRenderFeatureGpuWorkOwner({
    getDevice: () => internals.device,
    getShaderModuleFactory: () =>
      internals.shaderModuleFactory ??
      ({
        createShaderModule: () =>
          err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'the renderer backend exposes shader module creation',
              hint: 'construct the renderer through the backend pack before activating GPU features',
            }),
          ),
      } satisfies import('./pipeline-builder').PipelineBuilderShaderModuleFactory),
  });
  const disposeFeatureGpuWork = (): void => {
    const disposed = featureGpuWork.dispose();
    if (!disposed.ok) internals.errorRegistry.fire(disposed.error);
  };
  // Per-RenderSystem frame state: closure-internal frameNumber + the
  // per-entity instance GPU buffer cache (feat-20260514 M3 / w15: the
  // record stage owns GPU storage buffer allocation for Instances entities;
  // the `instanceBuffers` map is keyed by the packed Entity u32 surfaced
  // through `InstancesSnapshot.cacheKey` and rebuilds buffers on archetype
  // version bump or byte-length change). The legacy
  // `lastFiredLimitExceededFrame` engine-side dedup field was removed in
  // feat-20260513-instanced-mesh M5 (T-M5-1 + T-M5-3); the active
  // `'limit-exceeded'` emit point is now the record stage upload path.
  //
  // feat-20260708 M1 / D-1a #1: positive-half keys are worldEntityKey(worldId,
  // cacheKey) composites. Negative-half fold-bucket keys (sprite fold) stay
  // raw (material-handle-based, cross-world collision semantically correct).
  const frameState: RenderFrameState = {
    frameNumber: 0,
    directionalShadowCache: null,
    directionalShadowCacheRecorded: false,
    compiledFrameGraph: null,
    compiledFrameGraphTopologyKey: null,
    retiredCompiledFrameGraphs: new Set(),
    currentFrameObservationSource: undefined,
    currentDirectionalShadowView: null,
    currentSpotShadowView: null,
    instanceBuffers: new Map(),
    morphBuffers: new Map(),
    hdrpClusterBinScratch: createClusterBinScratch(),
    hdrpClusterGridScratch: null,
    hdrpLightIndexListScratch: null,
    hdrpClusterMembershipBindGroup: null,
    transientInstanceBuffers: [],
    warnedZeroLightStandard: false,
    warnedMultiLightDirectional: false,
    warnedMultiLightPoint: false,
    warnedMultiLightSpot: false,
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
    // once-warn latches for >1 Skylight / >1 SkyboxBackground (names winner).
    warnedMultiSkylight: false,
    warnedMultiSkybox: false,
    warnedSkyboxTonemapNone: false,
    // feat-20260520-2d-sprite-layer-mvp M-3 / w25 (AC-18 path 4): per-
    // handle warn-once anchor for the sprite-bucket missing-texture
    // fallback. Set<number> keyed by raw Handle<TextureAsset>; never
    // cleared (charter F1 minimal surface — the per-RenderSystem lifetime
    // is the natural upper bound).
    warnedMissingBaseColorTextureHandles: new Set<number>(),
    // feat-20260527-sprite-nineslice M2 / w11 + M4 / w16 (AC-16): once-per-
    // renderable guard for the runtime `nineslice.scale-too-small` metric
    // counter (`runtime.metrics.increment(...)` in render-system-record.ts).
    warnedNineSliceScaleEntities: new Set<number>(),
    // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
    // per-handle fire-once anchor for the lazy equirect projection failure
    // (EquirectProjectionFailedError). Set<number> keyed by raw
    // Handle<EquirectAsset>; never cleared (per-RenderSystem lifetime upper bound).
    firedEquirectProjectionFailedHandles: new Set<number>(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w3: per-frame
    // bind group caches as nested WeakMap chain roots. viewBindGroupCache
    // covers main and shadow variants; meshBindGroupCache keys on inner
    // buffer handles (D-3). Roots are stable between device recoveries.
    viewBindGroupCache: new WeakMap(),
    meshBindGroupCache: new WeakMap(),
    // feat-20260622-handle-to-id-allocator-elimination M1 / w2: per-entity
    // material and instances caches (outer Map<entityKey, WeakMap>).
    materialBgPerEntity: new Map(),
    instancesBgPerEntity: new Map(),
    instancesBgShared: new WeakMap(),
    // cross-entity shared material cache (outer Map<shaderId, WeakMap>).
    materialBgShared: new Map(),
    // cross-frame material assembly cache; entries are only retained when all
    // explicit texture/sampler handles resolved to resident GPU resources.
    materialBgAssemblyCache: new Map(),
    // singleton material cache (flat Map<variant, BindGroup>; D-6).
    singletonMaterialCache: new Map(),
    // post-process bind group cache (bloom / fxaa / ssao): identity-keyed
    // WeakMap chain so resize-retired transient targets rebuild automatically.
    postProcessBgCache: new WeakMap(),
    // feat-20260601-customizable-render-pipeline-seam M1 / w7: installed-pipeline state.
    // 0 = nothing installed yet (createRenderer dogfood installs the default before a
    // draw). activePipeline defaults to the built-in forward pipeline.
    installedPipelineHandle: 0,
    activePipeline: internals.standardPipeline,
    // feat-20260601 verify round 2: the standard forward pipeline installs with no config
    // (its topology is frame-invariant). Standard configuration overwrites this with the
    // resolved asset config on every swap so the active graph reads its current config.
    installedPipelineConfig: undefined,
    // feat-20260608-cluster-lighting M2 / w10 + M5 / w20: HDRP active flag + once-per-frame
    // warn dedup set for hdrp-light-budget-exceeded / hdrp-index-list-overflow.
    isHdrpActive: false,
    hdrpOncePerFrameFired: new Set(),
    // feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-2 (plan-strategy §D-1):
    // cube_array shadow atlas + per-frame snapshot list. Atlas is null until the
    // first frame whose extracted lights.pointShadow is non-empty (zero-shadow
    // scenes never allocate; AC-09); the snapshot list defaults to an empty
    // tuple so the typed point-shadow graph sees zero shadow lights as the
    // initial steady state.
    pointShadowAtlas: null,
    pointShadowSnapshots: [],
    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1):
    // initial fold-bucket count is 0; recordFrame writes the per-frame
    // value from foldDispatchBuckets(...) before dispatch.
    lastFoldBucketCount: 0,
    // feat-20260625-spot-light-shadow-mapping M2 / w9 (D-2): empty initial spot
    // shadow snapshot list so the spotShadowDepth caster pass renders zero
    // tiles until the first frame with a castShadow spot (AC-03).
    spotShadowSnapshots: [],
  };
  let directFrameId = 0;

  function beginProfilePhase(session: RecorderSession | undefined, phase: RenderPhase): boolean {
    if (session === undefined) return false;
    try {
      return session.beginPhase('render', phase).ok;
    } catch {
      return false;
    }
  }

  function endProfilePhase(session: RecorderSession | undefined): void {
    if (session === undefined) return;
    try {
      session.endPhase();
    } catch {
      // Profiler failures never alter rendering.
    }
  }

  function recordProfileSkip(
    session: RecorderSession | undefined,
    phase: RenderPhase,
    reason: RenderPhaseSkipReason,
  ): void {
    if (session === undefined) return;
    try {
      session.recordSkip({ source: 'render', phase, reason });
    } catch {
      // Profiler failures never alter rendering.
    }
  }

  function runProfiledRenderPhase<T>(
    session: RecorderSession | undefined,
    phase: RenderPhase,
    action: () => T,
  ): T {
    const opened = beginProfilePhase(session, phase);
    try {
      return action();
    } finally {
      if (opened) endProfilePhase(session);
    }
  }
  let lastBuiltPipelineHandle = 0;
  // Monotonic configuration epoch: bumped on every Standard configuration change to brand the
  // installed pipeline so `draw` can detect a swap and rebuild the per-frame
  // graph. Replaces the prior raw-handle brand (D-19: the pipeline configuration takes a
  // POD, no handle).
  let installEpoch = 0;
  // CPU post-process declarations are owned by the feature host and remain live
  // across recovery. Only device-bound buffers and pipelines are rebuilt here.
  // D-3 / D-8: per-shader params UBO resource table (id -> GPU Buffer).
  // Eager-created at register time when entry.params is present (byteSize >= 16,
  // defaultValue.length === byteSize); reused frame-to-frame via queue.writeBuffer.
  const postProcessParamsBuffers = new Map<string, Buffer>();
  const builtinPostProcessEntries = new Map<string, PostProcessShaderEntry>();
  let activeFeaturePostProcessEntries: ReadonlyMap<string, PostProcessShaderEntry> = new Map();
  const lookupPostProcess = (id: string): PostProcessShaderEntry | undefined =>
    builtinPostProcessEntries.get(id) ?? activeFeaturePostProcessEntries.get(id);
  // feat-20260621 M-A2 / w8: expose the eager-created per-id params UBO through
  // the narrow runtime surface so dispatchFullscreenPass can writeBuffer the
  // per-frame snapshot + bind it at group(1) binding(2).
  const getPostProcessParamsBuffer = (id: string): Buffer | undefined =>
    postProcessParamsBuffers.get(id);
  const ensurePostProcessParamsResources = (
    featureEntries: ReadonlyMap<string, PostProcessShaderEntry>,
  ): void => {
    const declarations = new Map<string, PostProcessShaderEntry>([
      ...builtinPostProcessEntries.entries(),
      ...featureEntries.entries(),
    ]);
    for (const [id, entry] of declarations) {
      const byteSize =
        entry.params?.byteSize ?? (entryHasDepthRead(entry) ? DEPTH_MIN_PARAMS_BYTE_SIZE : 0);
      if (byteSize === 0 || postProcessParamsBuffers.has(id)) continue;
      const created = internals.device.createBuffer({
        label: `post-process-params-${id}`,
        size: byteSize,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      });
      if (!created.ok) throw created.error;
      const buffer = created.value;
      if (entry.params !== undefined) {
        const written = internals.device.queue.writeBuffer(buffer, 0, entry.params.defaultValue);
        if (!written.ok) {
          internals.device.destroyBuffer(buffer);
          throw written.error;
        }
      }
      postProcessParamsBuffers.set(id, buffer);
    }
    for (const [id, buffer] of postProcessParamsBuffers) {
      if (declarations.has(id)) continue;
      internals.device.destroyBuffer(buffer);
      postProcessParamsBuffers.delete(id);
    }
  };
  // feat-20260609 M4 / T-10-a: post-process pipeline cache (id|colorFormat -> RhiRenderPipeline).
  // Solves CONCERN-1: dispatcher previously passed `pipeline=null` to
  // built.createHandle because per-frame execute closures cannot await async
  // shader compile. The cache here delegates the actual build to
  // `internals.buildPostProcessPipeline` (sync wrapper over the shared shader
  // adapter; 1-frame warmup), then memoizes by `id|colorFormat`.
  const postProcessPipelineCache = new Map<string, RenderPipeline>();
  const getPostProcessPipeline = (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
  ): RenderPipeline | null => {
    const key = `${id}|${colorFormat}`;
    const cached = postProcessPipelineCache.get(key);
    if (cached !== undefined) return cached;
    const entry = lookupPostProcess(id);
    if (entry === undefined) return null;
    const factory = internals.buildPostProcessPipeline;
    if (factory === undefined) return null;
    const built = factory(entry, bgl, colorFormat, `post-process-${id}`);
    if (built === null) return null;
    postProcessPipelineCache.set(key, built);
    return built;
  };
  Object.assign(internals, {
    lookupPostProcess,
    getPostProcessParamsBuffer,
    getPostProcessPipeline,
  });
  // w15 M5 (plan-strategy D-P4 / AC-07): per-frame dispatch counters. Reset
  // on every `draw([world], { cameraOwner: 0, resourceOwner: 0 })` entry; bumped once per actual `pass.setPipeline`
  // dispatch in render-system-record.ts. Two-way split mirrors the two
  // render pipelines on PipelineState (bug-20260519: BUILTIN cube migrated
  // to 12F so `unlitBuiltin` retired): `unlit` covers every
  // unlit material, `standard` covers every PBR material.
  const dispatchCounts: { unlit: number } = {
    unlit: 0,
  };
  // feat-20260531-per-frame-bind-group-cache M1 / w4: per-frame
  // createBindGroup counter scaffolding. Reset on every draw([world], { cameraOwner: 0, resourceOwner: 0 }) entry,
  // bumped on cache-miss in render-system-record.ts (M2-M4 bump points).
  // Aligns with dispatchCounts precedent: closure-mutable object.
  const bindGroupCounts: { createBindGroup: number; keys: string[] } = {
    createBindGroup: 0,
    keys: [],
  };
  const preparedPipelineIds = new WeakMap<object, string>();
  const preparedMaterialPipelineShaders = new WeakMap<object, string>();
  const preparedGroup0Pipelines = new WeakSet<object>();
  const preparedViewOnlyPipelines = new WeakSet<object>();
  const preparedRenderMaterialPipelines = new WeakSet<object>();
  const preparedAssetHandles = new WeakMap<World, Map<string, number>>();
  const preparedHandle = <Brand extends string>(
    world: World,
    guid: string,
    brand: Brand,
  ): Handle<Brand, 'shared'> | undefined => {
    let handles = preparedAssetHandles.get(world);
    if (handles === undefined) {
      handles = new Map();
      preparedAssetHandles.set(world, handles);
    }
    const key = `${brand}:${guid.toLowerCase()}`;
    const cached = handles.get(key);
    if (cached !== undefined) return cached as Handle<Brand, 'shared'>;
    const asset = internals.assets.lookup(guid);
    if (asset === undefined) return undefined;
    const handle = world.allocSharedRef(brand, asset);
    handles.set(key, handle as number);
    return handle;
  };
  const preparedMaterialBindings = (
    materialShaderId: string,
    worldIndex: number,
    materialGuid: string,
    layout: BindGroupLayout,
  ) => {
    const world = preparedWorlds[worldIndex];
    const material = internals.assets.lookup(materialGuid) as MaterialAsset | undefined;
    const pipelineState = internals.getPipelineState();
    if (world === undefined || material?.kind !== 'material' || pipelineState === null) {
      return err(new Error('prepared material asset is unavailable'));
    }
    const schema = internals.getParamSchema?.(materialShaderId) ?? [];
    const values = material.values ?? {};
    const derived = derive(schema);
    const fields = [...derived.textureFieldNames];
    let buffer: Buffer | undefined;
    let payloadByteLength = 0;
    if (derived.uboLayout.totalBytes > 0) {
      const payload = new Uint8Array(Math.max(16, derived.uboLayout.totalBytes));
      applyParamSnapshotToUbo(
        payload,
        schema,
        values as Readonly<Record<string, number | readonly number[]>>,
      );
      const created = internals.device.createBuffer({
        label: `prepared-material:${materialGuid}`,
        size: payload.byteLength,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      });
      if (!created.ok) return created;
      buffer = created.value;
      payloadByteLength = payload.byteLength;
      const written = internals.device.queue.writeBuffer(buffer, 0, payload);
      if (!written.ok) {
        internals.device.destroyBuffer(buffer);
        return written;
      }
    }
    const textureResources: Array<{
      sampler: import('@forgeax/engine-rhi').Sampler;
      view: import('@forgeax/engine-rhi').TextureView;
    }> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const value = field === undefined ? undefined : values[field];
      const textureValue =
        typeof value === 'object' && value !== null && 'texture' in value
          ? (value as MaterialTextureValue)
          : undefined;
      let sampler = pipelineState.defaultSampler;
      if (textureValue?.sampler !== undefined) {
        const handle = preparedHandle(world, String(textureValue.sampler), 'SamplerAsset');
        if (handle !== undefined) {
          const asset = resolveAssetHandle<SamplerAsset>(world, handle);
          if (asset.ok) {
            const resident = internals.gpuStore.ensureSamplerResident(handle, asset.value, world);
            if (resident.ok) sampler = resident.value;
          }
        }
      }
      let view = pipelineState.defaultWhiteTextureView;
      if (textureValue !== undefined) {
        const handle = preparedHandle(world, String(textureValue.texture), 'TextureAsset');
        if (handle !== undefined) {
          view = residentTextureView(world, internals.gpuStore, internals, handle) ?? view;
        }
      }
      textureResources.push({ sampler, view });
    }
    const entries: BindGroupEntry[] = [];
    let textureIndex = 0;
    for (let index = 0; index < derived.bglEntries.length; index += 1) {
      const expected = derived.bglEntries[index];
      if (expected?.buffer?.type === 'uniform' && buffer !== undefined) {
        entries.push({
          binding: expected.binding,
          resource: { kind: 'buffer', value: { buffer, size: payloadByteLength } },
        });
        continue;
      }
      const textureResource = textureResources[textureIndex];
      if (
        expected?.sampler?.type === 'filtering' &&
        derived.bglEntries[index + 1]?.texture !== undefined &&
        textureResource !== undefined
      ) {
        entries.push({
          binding: expected.binding,
          resource: { kind: 'sampler', value: textureResource.sampler },
        });
        continue;
      }
      if (expected?.texture !== undefined && textureResource !== undefined) {
        entries.push({
          binding: expected.binding,
          resource: { kind: 'textureView', value: textureResource.view },
        });
        textureIndex += 1;
        continue;
      }
      if (buffer !== undefined) internals.device.destroyBuffer(buffer);
      return err(new Error('prepared material schema contains unsupported binding kinds'));
    }
    for (let index = fields.length; index < 4; index += 1) {
      const binding = derived.userRegionBindingEnd + (index - fields.length) * 2;
      entries.push(
        {
          binding,
          resource: { kind: 'sampler', value: pipelineState.defaultSampler },
        },
        {
          binding: binding + 1,
          resource: { kind: 'textureView', value: pipelineState.defaultWhiteTextureView },
        },
      );
    }
    const fallback = pipelineState.skylightFallback;
    if (fallback === null) {
      if (buffer !== undefined) internals.device.destroyBuffer(buffer);
      return err(new Error('prepared material skylight fallback is unavailable'));
    }
    const completeEntries = assembleMaterialWithSkylightEntries(
      entries,
      {
        irradianceView: fallback.irradianceView,
        irradianceSampler: fallback.sampler,
        prefilterView: fallback.prefilterView,
        prefilterSampler: fallback.sampler,
        brdfLutView: fallback.brdfLutView,
        brdfLutSampler: fallback.sampler,
        intensityBuffer: fallback.intensityBuffer,
      },
      {
        emissiveSampler: pipelineState.defaultSampler,
        emissiveView: pipelineState.defaultWhiteTextureView,
        occlusionSampler: pipelineState.defaultSampler,
        occlusionView: pipelineState.defaultWhiteTextureView,
      },
    );
    const group = internals.device.createBindGroup({ layout, entries: completeEntries });
    if (!group.ok) {
      if (buffer !== undefined) internals.device.destroyBuffer(buffer);
      return group;
    }
    if (buffer === undefined) return group;
    return ok({
      handle: group.value,
      dynamicOffsets: [0],
      release: () => internals.device.destroyBuffer(buffer),
    });
  };
  const lastFrustumStats: { culled: number; total: number } = { culled: 0, total: 0 };
  const lastVisibilityStats: { explicitlyHidden: number } = { explicitlyHidden: 0 };
  let lastMeshMaterialBindings: readonly MeshMaterialBindingObservation[] = [];
  let lastMeshMaterialBindingFrame: ExtractedFrame | undefined;
  const preparedResolverFactory = (
    input: RenderFeaturePreparedGraphicsResolverInput,
  ): PreparedGraphicsResolver => {
    activeFeaturePostProcessEntries = input.fullscreenEffects;
    ensurePostProcessParamsResources(input.fullscreenEffects);
    return createPreparedGraphicsResolver({
      device: internals.device,
      featureIdentity: input.featureIdentity,
      generation: input.generation,
      capabilityAvailable: true,
      featureOrder: input.order,
      lookup: input.lookup,
      resolveGpuBuffer: (reference) =>
        featureGpuWork.resolveBuffer(input.featureIdentity, reference),
      resolvePipeline: (descriptor) => {
        const postProcessEntry =
          input.fullscreenEffects.get(descriptor.shader) ??
          builtinPostProcessEntries.get(descriptor.shader);
        if (postProcessEntry !== undefined) {
          const fullscreen = buildFullscreenPostProcessPass(
            { device: internals.device, errorRegistry: internals.errorRegistry },
            postProcessEntry,
          );
          if (fullscreen === null) return err(new Error('prepared post-process layout failed'));
          const pipeline = internals.getPostProcessPipeline?.(
            descriptor.shader,
            fullscreen.bindGroupLayout,
            descriptor.colorFormats[0] as GPUTextureFormat,
          );
          if (pipeline !== null && pipeline !== undefined) {
            preparedPipelineIds.set(pipeline as object, descriptor.shader);
            if (internals.getMaterialShaderBindingContract?.(descriptor.shader) === 'group-0') {
              preparedGroup0Pipelines.add(pipeline as object);
            }
          }
          return pipeline === null || pipeline === undefined
            ? err(makePreparedPipelinePendingError())
            : ok(pipeline);
        }
        const preparedPipeline = internals.getMaterialShaderPipeline?.(
          descriptor.shader,
          descriptor.colorFormats[0] === 'rgba16float',
          descriptor.renderState,
          descriptor.topology,
          descriptor.indexFormat,
          undefined,
          'forward',
          undefined,
          descriptor.sampleCount ?? 1,
          // Prepared graphics own their declared attachment format. Passing
          // it through keeps the PSO compatible with feature-target views
          // (the ordinary material path intentionally defaults to the
          // swap-chain view format).
          descriptor.colorFormats[0] as GPUTextureFormat,
          undefined,
          descriptor.depthFormat === undefined
            ? null
            : (descriptor.depthFormat as GPUTextureFormat),
          descriptor.vertexLayout,
        );
        // A requested material shader is an exact pipeline contract. During
        // async shader warmup, substituting the generic unlit pipeline can
        // mismatch vertex layouts and HDR attachment formats, turning a
        // retryable next-frame prepare into an invalid GPU command buffer.
        const pipeline = preparedPipeline ?? null;
        if (pipeline !== null) {
          preparedMaterialPipelineShaders.set(pipeline as object, descriptor.shader);
          const bindingContract = internals.getMaterialShaderBindingContract?.(descriptor.shader);
          if (bindingContract === 'group-0') {
            preparedGroup0Pipelines.add(pipeline as object);
          } else if (bindingContract === 'view-only') {
            preparedViewOnlyPipelines.add(pipeline as object);
          } else {
            preparedRenderMaterialPipelines.add(pipeline as object);
          }
        }
        return pipeline === null ? err(makePreparedPipelinePendingError()) : ok(pipeline);
      },
      resolveBindings: (descriptor, pipeline) => {
        const materialShaderId = preparedMaterialPipelineShaders.get(pipeline as object);
        const bindingContract =
          materialShaderId === undefined
            ? undefined
            : internals.getMaterialShaderBindingContract?.(materialShaderId);
        if (bindingContract === 'group-0-resource') {
          return descriptor.values.sceneDepth === undefined
            ? err(new Error('prepared group-0 resource pipeline requires a scene target'))
            : ok(undefined);
        }
        if (bindingContract === 'view-and-scene-depth') {
          return ok(undefined);
        }
        if (preparedGroup0Pipelines.has(pipeline as object)) {
          const layout =
            (materialShaderId === undefined
              ? undefined
              : internals.getMaterialBindGroupLayout?.(materialShaderId)) ??
            (
              pipeline as RenderPipeline & {
                getBindGroupLayout?: (index: number) => BindGroupLayout;
              }
            ).getBindGroupLayout?.(0);
          return layout === undefined
            ? err(new Error('prepared group-0 pipeline bind group layout is unavailable'))
            : internals.device.createBindGroup({ layout, entries: [] });
        }
        if (
          preparedViewOnlyPipelines.has(pipeline as object) ||
          (preparedRenderMaterialPipelines.has(pipeline as object) &&
            descriptor.values.group === 0) ||
          pipeline === internals.getPipelineState()?.unlitPipeline
        ) {
          return ok(undefined);
        }
        const group = descriptor.values.group;
        const layout =
          (materialShaderId !== undefined
            ? (internals.getMaterialBindGroupLayout?.(materialShaderId) ??
              (group === 0 ? internals.getPipelineState()?.materialBindGroupLayout : undefined))
            : undefined) ??
          (
            pipeline as RenderPipeline & {
              getBindGroupLayout?: (index: number) => BindGroupLayout;
            }
          ).getBindGroupLayout?.(group === 1 ? 1 : 0);
        const material = descriptor.values.material;
        if (
          group === 1 &&
          layout !== undefined &&
          materialShaderId !== undefined &&
          typeof material === 'object' &&
          material !== null &&
          'world' in material &&
          'guid' in material &&
          typeof material.world === 'number' &&
          typeof material.guid === 'string'
        ) {
          return preparedMaterialBindings(materialShaderId, material.world, material.guid, layout);
        }
        return layout === undefined
          ? err(new Error('prepared pipeline bind group layout is unavailable'))
          : internals.device.createBindGroup({
              layout,
              entries:
                group === 1 && preparedPipelineIds.has(pipeline as object)
                  ? [
                      {
                        binding: 0,
                        resource: {
                          kind: 'textureView',
                          value: internals.getPipelineState()?.fallbackTextureView as never,
                        },
                      },
                      {
                        binding: 1,
                        resource: {
                          kind: 'sampler',
                          value: internals.getPipelineState()?.defaultSampler as never,
                        },
                      },
                      ...(internals.getPostProcessParamsBuffer?.(
                        preparedPipelineIds.get(pipeline as object) ?? '',
                      ) === undefined
                        ? []
                        : [
                            {
                              binding: 2,
                              resource: {
                                kind: 'buffer' as const,
                                value: {
                                  buffer: internals.getPostProcessParamsBuffer?.(
                                    preparedPipelineIds.get(pipeline as object) ?? '',
                                  ) as never,
                                },
                              },
                            },
                          ]),
                    ]
                  : [],
            });
      },
    });
  };
  return {
    releaseProfilerCatalog(): void {
      releaseProfilerCatalog?.();
      releaseProfilerCatalog = undefined;
    },
    get renderScene(): RenderSceneInspection {
      return {
        ...persistentRenderScene.inspect(),
        gpuDriven: gpuDrivenProduction.inspect(),
      };
    },
    get pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
      return persistentRenderScene.pointsLinesSnapshots();
    },
    detachScene(world: World): void {
      persistentRenderScene.detach(world);
    },
    draw(
      worlds: readonly World[],
      opts: DrawOwnerOptions,
      renderReadLeases?: readonly RenderReadLease[],
    ): boolean {
      preparedWorlds = worlds;
      const profileSession = internals.profiler?.activeSession();
      let ownsProfileFrame = false;
      let submitted = false;
      if (profileSession !== undefined && opts.profileFrame === undefined) {
        try {
          ownsProfileFrame = profileSession.beginFrame(++directFrameId).ok;
        } catch {
          ownsProfileFrame = false;
        }
      }
      try {
        pointsLinesOwner.beginFrame();
        // cameraOwner drives the surfaced cameras + frustum
        // cull; resourceOwner drives skylight/skybox/postProcess + per-world
        // record config.
        const { cameraOwner, resourceOwner } = opts;
        // Keep the compiled graph as last-known-good until the candidate topology
        // compiles. The failed candidate frame does not execute it; successful
        // replacement retires it atomically in ensureCompiledFrameGraph.
        if (frameState.installedPipelineHandle !== lastBuiltPipelineHandle) {
          // Feature contributions describe the active pipeline graph. Drop the
          // old graph before the next frame re-runs feature contribution
          // so a hot-swap cannot reuse passes compiled for the retired pipeline.
          resetRenderFeatureGraphState(internals);
          lastBuiltPipelineHandle = frameState.installedPipelineHandle;
          persistentRenderScene.invalidate();
        }
        dispatchCounts.unlit = 0;

        // feat-20260708-composited-multi-world-rendering M3 / D-2 / m3-i2:
        // extractFrames merges per-world snapshots (renderables + lights from
        // every world, cameras + singleton resources from the owner world),
        // runs read-only extractFrame per world over the already-updated World,
        // resets frame state once, and isolates
        // per-world errors (AC-09).
        // Single-world draw([world], { cameraOwner: 0, resourceOwner: 0 }) is the identity path
        // (worldId=0), byte-for-byte equivalent to the pre-M3 direct
        // extractFrame path (AC-03 regression guarantee).
        //
        // Entry validation (empty worlds / owner out of range) is enforced by
        // the public renderer.draw facade (createRenderer.ts, D-5) before this
        // internal method is reached; the owner world is guaranteed present.
        //
        // feat-20260709-editor-world-partition M1 / w5+w6 (D-3): per-world
        // record configuration (transparent-sort mode, fold buckets, skybox /
        // asset resolution) is read from the resource-owner world — the world
        // that owns skylight / skybox / postProcessParams. w6 sources it from
        // the dedicated resourceOwner index. The variable is named
        // `resourceWorld` so the record-stage reads are self-describing (they
        // are resource-owner reads, not camera reads).
        const resourceWorld = worlds[resourceOwner] as World;
        const frame = runProfiledRenderPhase(profileSession, 'extract', () => {
          return persistentRenderScene.extractComposition(
            worlds,
            { cameraOwner, resourceOwner },
            internals.assets.catalogEpoch,
            () =>
              extractFrames(
                worlds,
                { cameraOwner, resourceOwner },
                internals.assets,
                internals.getPipelineState(),
                persistentRenderScene.materialSnapshotCacheStore(),
                { cull: 'none' },
              ),
            renderReadLeases,
          );
        });
        const {
          cameras,
          lights,
          renderables,
          dispatch,
          skylight,
          skylightCount,
          skybox,
          skyboxCount,
          frustumStats,
          visibilityStats,
          postProcessParams,
        } = frame;
        if (lastMeshMaterialBindingFrame !== frame) {
          lastMeshMaterialBindingFrame = frame;
          lastMeshMaterialBindings = renderables.map((renderable) => ({
            worldId: renderable.worldId,
            entityKey: renderable.entityKey,
            bindings: renderable.materials.map((material, slotIndex) => ({
              handle: material.materialHandle ?? 0,
              source: renderable.materialBindingSources[slotIndex] ?? 'engine-default',
            })),
            diagnostics: renderable.materialBindingDiagnostics ?? [],
          }));
        }

        bindGroupCounts.createBindGroup = 0;
        bindGroupCounts.keys = [];
        const preparedPipelineState = internals.getPipelineState();
        const bindGroupSkipReason: RenderPhaseSkipReason | undefined =
          internals.featureHost === undefined
            ? 'feature-host-unavailable'
            : internals.featureHost.size === 0
              ? 'feature-host-empty'
              : preparedPipelineState === null
                ? 'pipeline-state-unavailable'
                : frame.cameras.length === 0
                  ? 'camera-unavailable'
                  : undefined;
        if (bindGroupSkipReason !== undefined || preparedPipelineState === null) {
          recordProfileSkip(
            profileSession,
            'bind-groups',
            bindGroupSkipReason ?? 'pipeline-state-unavailable',
          );
        } else {
          runProfiledRenderPhase(profileSession, 'bind-groups', () =>
            buildPerFrameBindGroups(
              internals,
              frameState,
              preparedPipelineState,
              true,
              bindGroupCounts,
              undefined,
              false,
            ),
          );
        }
        lastFrustumStats.culled = frustumStats.culled;
        lastFrustumStats.total = frustumStats.total;
        lastVisibilityStats.explicitlyHidden = visibilityStats.explicitlyHidden;
        const featureTargets =
          preparedPipelineState === null || cameras[0] === undefined
            ? []
            : resolveStandardRenderFeatureTargets({
                tonemap: cameras[0].tonemap,
                antialias: cameras[0].antialias,
                colorAttachmentFormat: preparedPipelineState.colorAttachmentFormat,
                storageBuffer: internals.device.caps.storageBuffer,
                multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
              });
        let featureGraphCandidate: RenderFeatureGraphCandidate | undefined;
        const preparedResourceBatches = runProfiledRenderPhase(profileSession, 'features', () => {
          if (internals.featureHost === undefined) return [];
          const featureFrame = runRenderFeatureFrame(internals.featureHost, {
            worlds,
            owner: resourceOwner,
            frameNumber: frameState.frameNumber,
            visibilitySnapshots: frame.featureVisibilitySnapshots,
            hiddenEntityReports: frame.hiddenEntityReports,
            targets: featureTargets,
            generation: internals.featureHost?.preparedGeneration ?? 0,
            caps: internals.device.caps,
            ...(internals.getMaterialShaderBindingContract === undefined
              ? {}
              : { materialShaderBindingContract: internals.getMaterialShaderBindingContract }),
            createPreparedGraphicsResolver: preparedResolverFactory,
            gpuWork: featureGpuWork,
          });
          activeFeaturePostProcessEntries = featureFrame.fullscreenEffects;
          ensurePostProcessParamsResources(featureFrame.fullscreenEffects);
          lastVisibilityStats.explicitlyHidden = featureFrame.hiddenEntityReports.length;
          for (const featureError of featureFrame.errors) {
            if (!isPendingRenderFeaturePreparation(featureError)) {
              internals.errorRegistry.fire(featureError);
            }
          }
          featureGraphCandidate = {
            plans: featureFrame.plans,
            fullscreenEffects: featureFrame.fullscreenEffects,
            ...(featureFrame.preparedResourceBatches.length === 0
              ? {}
              : { preparedResourceKey: `frame-${frameState.frameNumber}` }),
            onRejected: () => {
              for (const batch of featureFrame.preparedResourceBatches) {
                const released = batch.release();
                if (!released.ok) {
                  internals.errorRegistry.fire(released.error);
                }
              }
            },
          };
          return featureFrame.preparedResourceBatches;
        });

        // Unified transparent-sort: (layer ASC, sortValue ASC) for modes 0/1/2;
        // distance back-to-front for mode=3. The transparent-sort config is a
        // per-world resource; it is read from the resource-owner world (the
        // world that owns skylight / skybox / singleton render state, w5 / D-3).
        // Only the Transparent segment is reordered; queue ordering between
        // segments (sortDispatchByQueue, stable) is preserved.
        const orderedDispatch = runProfiledRenderPhase(profileSession, 'sort', () =>
          sortTransparentDispatch(dispatch, resourceWorld, cameras, renderables),
        );

        // M3 / w26: single dispatch list replaces old three-bucket model.
        // Pass dispatch to recordFrame — the record stage iterates dispatch
        // entries in queue order per plan-strategy D-3.
        //
        // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2):
        // the record stage must resolve each renderable's mesh + material
        // textures against the world it was EXTRACTED from — never the single
        // resourceWorld. The extract stage already resolves per-world
        // (extractFrames loops worlds[] and stamps RenderableSnapshot.worldId);
        // the record stage regressed to resolving everything against
        // resourceWorld, so a user-tier mesh living in the cameraOwner world
        // (e.g. an editor gizmo handle) resolves against resourceWorld's
        // sharedRefs — either a miss (asset-not-registered) or, when that slot
        // is occupied by an unrelated user-tier payload (equirect), a
        // wrong-kind resolve that throws in ensureResident. `worlds` is threaded
        // so the record stage can index worlds[renderable.worldId]. `resourceWorld`
        // stays the singleton-resource owner (skybox equirect / transparent-sort
        // config / video provider) — those ARE resource-owner reads.
        const recordProfilePhase: RecordProfileRunner | undefined =
          profileSession === undefined || profileSession.detail === 'owner'
            ? undefined
            : function recordProfilePhase<T>(phase: RenderRecordPhase, action: () => T): T {
                // `passes` deliberately keeps only the graph-pass boundary.
                // The same runner is also called by geometry/material helpers;
                // invoking those wrappers would turn a pass probe into the
                // high-overhead per-draw `nested` probe.
                if (
                  profileSession.detail === 'passes' &&
                  (!phase.startsWith('record/graph-execute/') ||
                    (phase.slice('record/graph-execute/'.length).includes('/') &&
                      !phase.endsWith('/geometry-loop')))
                ) {
                  return action();
                }
                return runProfiledRenderPhase(profileSession, phase, action);
              };
        submitted = runProfiledRenderPhase(profileSession, 'record', () =>
          recordFrame(
            internals,
            resourceWorld,
            cameras,
            lights,
            renderables,
            orderedDispatch,
            frameState,
            dispatchCounts,
            bindGroupCounts,
            skylight,
            skylightCount,
            skybox,
            skyboxCount,
            postProcessParams,
            worlds,
            recordProfilePhase,
            {
              owner: gpuDrivenProduction,
              scene: persistentRenderScene.compositionGpuDrivenState(),
              onCoverage: (ownsAll) => {
                const key = `${internals.gpuStore.meshResidencyEpoch}:${frameState.isHdrpActive ? 'hdrp' : 'urp'}`;
                persistentRenderScene.setCompositionGpuDrivenCoverage(key, ownsAll);
              },
            },
            renderReadLeases,
            featureGraphCandidate,
            pointsLinesOwner,
          ),
        );
        persistentRenderScene.setPointsLinesInspections(pointsLinesOwner.inspections());
        if (internals.featureHost !== undefined && preparedResourceBatches.length > 0) {
          const batches = preparedResourceBatches;
          if (submitted) {
            internals.featureHost.markPreparedGraphicsSubmitted(batches);
            settlePreparedGraphicsCompletion(
              internals.featureHost,
              batches,
              internals.device.queue.onSubmittedWorkDone(),
              (error) => reportPreparedGraphicsCompletionError(internals, error),
            );
          } else {
            const retired = internals.featureHost.retirePreparedGraphics();
            if (!retired.ok) internals.errorRegistry.fire(retired.error);
          }
        }
      } catch (err) {
        const innerError =
          err instanceof RhiError
            ? err
            : { code: 'unknown' as const, message: String(err), name: (err as Error)?.name };
        internals.errorRegistry.fire(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'RenderSystem to record one frame without an internal exception',
            hint: 'inspect detail.error for the underlying cause; next frame will retry',
            detail: { error: innerError },
          }),
        );
      } finally {
        if (ownsProfileFrame) {
          try {
            profileSession?.endFrame();
          } catch {
            // Profiler failures never alter rendering.
          }
        }
      }
      return submitted;
    },
    pipelineDispatchCounts: dispatchCounts,
    observeCurrentFrame(options: FrameObservationOptions) {
      const currentFrameId = frameState.frameNumber - 1;
      return observeCurrentFrame(options, frameState.currentFrameObservationSource, currentFrameId);
    },
    bindGroupCounts: bindGroupCounts,
    frustumStats: lastFrustumStats,
    visibilityStats: lastVisibilityStats,
    get meshMaterialBindings(): readonly MeshMaterialBindingObservation[] {
      return lastMeshMaterialBindings;
    },
    get perFramePassNames(): readonly string[] {
      return frameState.compiledFrameGraph?.inspect().passes.map((pass) => pass.name) ?? [];
    },
    configureStandard(config: RenderPipelineAsset['config']): void {
      const profileConfig = internals.standardProfile;
      const resolvedConfig =
        profileConfig === undefined
          ? config
          : {
              ...(profileConfig.lighting === 'clustered'
                ? { clusterGrid: DEFAULT_CLUSTER_GRID }
                : {}),
              ...(profileConfig.ssao ? { ssao: { enabled: true } } : {}),
              ...config,
            };
      if (resolvedConfig?.clusterGrid !== undefined) {
        const grid = resolvedConfig.clusterGrid;
        const gridResult = validateClusterGrid(grid);
        if (!gridResult.ok) {
          throw gridResult.error;
        }
      }
      if (resolvedConfig?.ssao?.enabled === true) {
        const ssaoResult = resolveSsaoParameters(resolvedConfig.ssao);
        if (!ssaoResult.ok) {
          throw ssaoResult.error;
        }
      }
      // Standard configuration no longer carries a handle (D-19: RenderPipelineAsset is
      // supplied as a POD at boot/swap time before a World exists). The
      // brand-number that `draw` compares to force a per-frame graph rebuild is
      // now a monotonic epoch bumped on every install -- distinct configs (and
      // even identical re-installs) trigger the rebuild, which is correct: install
      // is a rare boot/swap event, never a per-frame cost.
      installEpoch += 1;
      frameState.installedPipelineHandle = installEpoch;
      frameState.isHdrpActive = resolvedConfig?.clusterGrid !== undefined;
      frameState.installedPipelineConfig = resolvedConfig;
    },
    registerBuiltinPostProcess(id: string, entry: PostProcessShaderEntry): () => void {
      // D-3: eager-create params UBO at register time + fail-fast
      // byteSize / defaultValue validation (q5=A).
      let paramsBuffer: Buffer | undefined;
      try {
        if (entry.params !== undefined) {
          const { byteSize, defaultValue } = entry.params;
          if (byteSize < 16 || defaultValue.length !== byteSize) {
            throw new PostProcessError({
              code: 'params-size-mismatch',
              detail: { byteSize, actualLength: defaultValue.length },
            });
          }
          const paramsBufferResult = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: byteSize,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!paramsBufferResult.ok) throw paramsBufferResult.error;
          paramsBuffer = paramsBufferResult.value;
          const writeResult = internals.device.queue.writeBuffer(paramsBuffer, 0, defaultValue);
          if (!writeResult.ok) throw writeResult.error;
        } else if (entryHasDepthRead(entry)) {
          const paramsBufferResult = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: DEPTH_MIN_PARAMS_BYTE_SIZE,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!paramsBufferResult.ok) throw paramsBufferResult.error;
          paramsBuffer = paramsBufferResult.value;
        }
        if (builtinPostProcessEntries.has(id)) {
          throw new PostProcessError({
            code: 'post-process-already-registered',
            detail: { id },
          });
        }
        builtinPostProcessEntries.set(id, entry);
        if (paramsBuffer !== undefined) postProcessParamsBuffers.set(id, paramsBuffer);
        return () => {
          if (builtinPostProcessEntries.get(id) === entry) {
            builtinPostProcessEntries.delete(id);
          }
          const current = postProcessParamsBuffers.get(id);
          if (current !== undefined) {
            internals.device.destroyBuffer(current);
            postProcessParamsBuffers.delete(id);
          }
          for (const key of postProcessPipelineCache.keys()) {
            if (key.startsWith(`${id}|`)) postProcessPipelineCache.delete(key);
          }
        };
      } catch (cause) {
        if (paramsBuffer !== undefined) internals.device.destroyBuffer(paramsBuffer);
        throw cause;
      }
    },
    disposeFrameState(): void {
      persistentRenderScene.dispose();
      gpuDrivenProduction.dispose();
      disposeFeatureGpuWork();
      // Retire graph-owned resources and dispose instance-buffer caches.
      // Both calls are idempotent + tolerate per-handle errors silently;
      // the Renderer.dispose() cascade owns the surrounding try/catch
      // (D-3 method A: void signature, sub-errors fan out via
      // errorRegistry.fire at the cascade layer, dispose still walks all
      // 6 steps).
      frameState.directionalShadowCache = null;
      frameState.directionalShadowCacheRecorded = false;
      frameState.currentFrameObservationSource = undefined;
      frameState.currentDirectionalShadowView = null;
      frameState.currentSpotShadowView = null;
      const compiled = frameState.compiledFrameGraph;
      frameState.compiledFrameGraph = null;
      frameState.compiledFrameGraphTopologyKey = null;
      if (compiled !== null) compiled.retire().catch(() => undefined);
      for (const retired of frameState.retiredCompiledFrameGraphs) {
        retired.retire().catch(() => undefined);
      }
      frameState.retiredCompiledFrameGraphs.clear();
      // feat-20260619 M4 (D-6): pass errorRegistry to disposeInstanceBuffers
      // so destroy failures fire structured errors (unified per-frame +
      // dispose error strategy).
      disposeInstanceBuffers(frameState.instanceBuffers, internals.errorRegistry);
      disposeTransientInstanceBuffers(frameState.transientInstanceBuffers, internals.errorRegistry);
      if (frameState.morphBuffers !== undefined) {
        for (const entry of frameState.morphBuffers.values()) {
          if (!entry.buffer.isDestroyed) {
            const result = entry.buffer.destroy();
            if (!result.ok) internals.errorRegistry.fire(result.error);
          }
        }
        frameState.morphBuffers.clear();
      }
      // feat-20260612-point-light-shadows-urp-hdrp M4 / T-M4-2: dispose the
      // cube_array shadow atlas owned by the RenderSystem closure. The atlas
      // is per-RenderSystem (= per Renderer) and is shared transparently
      // between URP and HDRP pipelines.
      // Idempotent: dispose() on a null / already-disposed atlas is a no-op.
      if (frameState.pointShadowAtlas !== null) {
        frameState.pointShadowAtlas.dispose();
        frameState.pointShadowAtlas = null;
      }
    },
    resetForRecover(): void {
      persistentRenderScene.resetGpuForRecover();
      gpuDrivenProduction.dispose();
      gpuDrivenProduction = new GpuDrivenProduction(internals.device, gpuDrivenShaderFactory);
      disposeFeatureGpuWork();
      // feat-20260622-s5 M3 / B-2 / w18: recover() rebuild drops device-bound
      // state minted by the lost device. The active graph and per-entity caches
      // must be discarded, not merely marked for destruction: their opaque
      // handles cannot be used on the fresh device and the next draw must
      // lazily build a new graph from the preserved ECS / asset POD caches.
      frameState.compiledFrameGraph?.retire().catch(() => undefined);
      frameState.compiledFrameGraph = null;
      frameState.compiledFrameGraphTopologyKey = null;
      frameState.directionalShadowCache = null;
      frameState.directionalShadowCacheRecorded = false;
      frameState.currentFrameObservationSource = undefined;
      frameState.currentDirectionalShadowView = null;
      frameState.currentSpotShadowView = null;
      for (const retired of frameState.retiredCompiledFrameGraphs) {
        retired.retire().catch(() => undefined);
      }
      frameState.retiredCompiledFrameGraphs.clear();
      frameState.instanceBuffers.clear();
      frameState.morphBuffers?.clear();
      frameState.transientInstanceBuffers = [];
      frameState.pointShadowAtlas = null;
      // Bind groups retain opaque handles from the lost device. WeakMap roots
      // cannot be cleared, so replace them; the Map-backed caches can be
      // emptied in place. The next frame recreates every binding from the
      // rebuilt PipelineState and fresh residency handles.
      frameState.viewBindGroupCache = new WeakMap();
      frameState.meshBindGroupCache = new WeakMap();
      frameState.materialBgPerEntity.clear();
      frameState.instancesBgPerEntity.clear();
      frameState.materialBgShared.clear();
      frameState.materialBgAssemblyCache.clear();
      frameState.singletonMaterialCache.clear();
      frameState.postProcessBgCache = new WeakMap();
      // Fullscreen PSOs are cached outside frameState because the normal
      // path reuses them across frames. They still carry opaque handles from
      // the lost device, so recovery must invalidate this cache alongside the
      // feature-host declarations and UBOs below.
      postProcessPipelineCache.clear();
      // Logical declarations stay live in the feature host while a replacement
      // device is being requested.
      postProcessParamsBuffers.clear();
      resetRenderFeatureGraphState(internals);
    },
    restorePostProcessResources(): void {
      const declarations = [
        ...builtinPostProcessEntries.entries(),
        ...activeFeaturePostProcessEntries.entries(),
      ];
      for (const [id, entry] of declarations) {
        let buffer: Buffer | undefined;
        if (entry.params !== undefined) {
          const created = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: entry.params.byteSize,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!created.ok) throw created.error;
          buffer = created.value;
          const written = internals.device.queue.writeBuffer(buffer, 0, entry.params.defaultValue);
          if (!written.ok) {
            internals.device.destroyBuffer(buffer);
            throw written.error;
          }
        } else if (entryHasDepthRead(entry)) {
          const created = internals.device.createBuffer({
            label: `post-process-params-${id}`,
            size: DEPTH_MIN_PARAMS_BYTE_SIZE,
            usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
            mappedAtCreation: false,
          });
          if (!created.ok) throw created.error;
          buffer = created.value;
        }
        if (buffer !== undefined && lookupPostProcess(id) === entry) {
          postProcessParamsBuffers.set(id, buffer);
        } else if (buffer !== undefined) {
          internals.device.destroyBuffer(buffer);
        }
      }
    },
  };
}

// @forgeax/engine-render - built-in record context extension.
//
// The public RenderPipelineContext is canonical in render-contract.ts. This
// owner adds only concrete assembly state for built-in record closures.

/**
 * Package-private extension consumed by the built-in record closures only.
 * Custom pipeline authors see the leaf RenderPipelineContext contract and
 * never this surface.
 */
