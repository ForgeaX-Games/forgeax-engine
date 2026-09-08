// @forgeax/engine-runtime - RenderSystem record stage: frame.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import { HANDLE_NINESLICE_QUAD, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  type CurrentFrameObservationLease,
  createCurrentFrameObservationLease,
} from '@forgeax/engine-render-graph';
import {
  err,
  ok,
  type Result,
  type RhiCommandEncoder,
  RhiError,
  type TextureFormat,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { MaterialRenderState, MeshAsset } from '@forgeax/engine-types';
import { handleSlot, toShared } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { ObservationUnavailableError, type ObservationUnavailableReason } from '../errors/render';
import type { GpuDrivenProduction, PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import { disposeTransientInstanceBuffers } from '../instance-buffer-cache';
import type { CameraSnapshot, RenderRecordPhase } from '../render-contract';
import type {
  DispatchEntry,
  ExtractedLights,
  MaterialSnapshot,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../systems/transparent-sort-config';
import {
  buildPerFrameBindGroups,
  prepareFrameLighting,
  resolveSkyboxActive,
  warnZeroLightStandard,
  writeHdrpClusterAndSsaoBuffers,
  writePointSpotLightBuffers,
  writeShadowParamsBuffer,
} from './frame-lighting';
import {
  type BindGroupCounts,
  type DirectionalShadowCache,
  type DirectionalShadowWorldState,
  type DispatchCounts,
  type FrameObservationSource,
  makeZeroCameraFallbackSnapshot,
  type RenderFrameState,
  type ValidatedRenderable,
  worldEntityKey,
} from './frame-snapshot';
// feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 (D-1 record-stage
// fold operator). Pure linear-scan helper that groups transparent-dispatch
// entries with equal (Layer.value, sortKey, materialHandle) into FoldBucket
// descriptors. The drawIndexed swap (1 instanced draw per bucket vs N
// per-entity draws) hooks into the sprite-pass dispatch loop below
// (w4-record-swap), using {@link buildFoldDispatchPlan} to translate
// renderableIndex-keyed buckets into validatedOrdered-index-keyed
// head/skip maps.
import {
  buildFoldDispatchPlan,
  evaluateFoldBucketUniformCap,
  type FoldBucket,
  type FoldDispatchPlan,
  foldDispatchBuckets,
  incrementFoldedDrawsMetric,
} from './mesh-ssbo';
import type {
  _InternalRenderPipelineContext,
  PipelineState,
  RenderSystemInternals,
} from './render-context';

export type { FrameObservationSource } from './frame-snapshot';

export type FrameObservationReadback = (
  lease: CurrentFrameObservationLease,
) => Promise<Result<Uint8Array, Error>>;

export interface FrameObservationOptions {
  readonly semantic: 'linear-hdr';
  readonly readback: FrameObservationReadback;
}

export interface FrameObservationMetadata {
  readonly format: TextureFormat;
  readonly size: { readonly width: number; readonly height: number };
  readonly usage: number;
  readonly sample: number;
  readonly frameId: number;
  readonly lifetime: { readonly frameId: number; readonly state: 'active' | 'retired' };
  readonly pipelineId: 'forgeax::standard';
  readonly backendId: string;
}

export interface FrameObservation {
  readonly bytes: Uint8Array;
  readonly metadata: FrameObservationMetadata;
}

function unavailable(
  reason: ObservationUnavailableReason,
  hint: string,
): Result<never, ObservationUnavailableError> {
  return err(new ObservationUnavailableError(reason, hint));
}

function mapLeaseFailure(code: string, hint: string): Result<never, ObservationUnavailableError> {
  let reason: ObservationUnavailableReason = 'resource';
  if (code === 'observation-stale') reason = 'stale';
  else if (code === 'observation-invalid-format') reason = 'format';
  else if (code === 'observation-missing-copy-src') reason = 'copy-src';
  return unavailable(reason, hint);
}

export async function observeCurrentFrame(
  options: FrameObservationOptions,
  source: FrameObservationSource | undefined,
  currentFrameId: number,
): Promise<Result<FrameObservation, ObservationUnavailableError>> {
  if (options.semantic !== 'linear-hdr') {
    return unavailable('identity', 'request the producer-owned linear-hdr semantic');
  }
  if (source === undefined) {
    return unavailable(
      'no-frame',
      'draw a frame through the Standard producer before requesting observation',
    );
  }
  if (source.pipelineId !== 'forgeax::standard' || source.backendId.length === 0) {
    return unavailable(
      'identity',
      'observe a producer with explicit pipeline and backend identity',
    );
  }

  const leaseResult = createCurrentFrameObservationLease(
    { ...source.descriptor, texture: source.texture, frameId: source.frameId },
    currentFrameId,
  );
  if (!leaseResult.ok) {
    return mapLeaseFailure(leaseResult.error.code, leaseResult.error.hint);
  }

  let bytesResult: Result<Uint8Array, Error>;
  try {
    bytesResult = await options.readback(leaseResult.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return unavailable('readback-failed', `retry the current-frame readback after: ${message}`);
  }
  if (!bytesResult.ok) {
    return unavailable('readback-failed', bytesResult.error.message);
  }

  const activeResult = leaseResult.value.beginReadback();
  if (!activeResult.ok) {
    return mapLeaseFailure(activeResult.error.code, activeResult.error.hint);
  }

  return ok({
    bytes: bytesResult.value,
    metadata: {
      format: leaseResult.value.descriptor.format,
      size: leaseResult.value.descriptor.size,
      usage: leaseResult.value.descriptor.usage,
      sample: source.descriptor.sample,
      frameId: source.frameId,
      lifetime: leaseResult.value.lifetime,
      pipelineId: source.pipelineId,
      backendId: source.backendId,
    },
  });
}

import {
  acquireSwapChainTarget,
  graphExecutionPhase,
  resolveShadowMapSize,
  resolveSpotShadowMapSize,
} from './frame-targets';
import {
  computeViewMatrix,
  driveLazyEquirectProjection,
  selectLazyEquirectHandle,
  variantSetFromDefines,
  warnMultiSkybox,
  warnMultiSkylight,
} from './helpers';
import { computeSplitLdrSprite } from './main-pass-sprite-draws';
import { cleanPerEntityCache, ensureMeshSsboCapacity, uploadMeshSsboBatch } from './mesh-ssbo';
import { writeShadowCasterUniforms } from './shadow-pass';
import {
  ensureCompiledFrameGraph,
  executeCompiledFrameGraph,
  type RenderFeatureGraphCandidate,
} from './typed-frame-graph';
import { writePointsLinesViewUbo, writeViewUbo } from './view-ubo';

/**
 * A frame-local material table. Repeated snapshot objects share one UBO slot;
 * each renderable keeps only the slot index used by each authored material.
 */
export interface MaterialSlotPlan<T extends object> {
  readonly slotIndices: readonly (readonly number[])[];
  readonly slots: readonly T[];
  /** Index of the first renderable that referenced each slot. */
  readonly slotOwners: readonly number[];
}

/**
 * Intern identical material snapshots into one frame-local slot table.
 * Snapshot identity is the extract layer's invalidation token, so this keeps
 * the same correctness boundary while avoiding duplicate payload assembly and
 * upload for repeated scene instances.
 */
export function buildMaterialSlotPlan<T extends object>(
  materialGroups: readonly (readonly T[])[],
): MaterialSlotPlan<T> {
  const slotByMaterial = new Map<T, number>();
  const slots: T[] = [];
  const slotOwners: number[] = [];
  const slotIndices = materialGroups.map((materials, ownerIndex) =>
    materials.map((material) => {
      const cached = slotByMaterial.get(material);
      if (cached !== undefined) return cached;
      const slot = slots.length;
      slots.push(material);
      slotOwners.push(ownerIndex);
      slotByMaterial.set(material, slot);
      return slot;
    }),
  );
  return { slotIndices, slots, slotOwners };
}

/**
 * Return the largest complete renderable prefix supported by a shared
 * mesh/material capacity. Mesh rows consume one slot per renderable; material
 * rows use the deduplicated slot indices assigned in first-seen order.
 */
export function findRenderablePrefixForSlotCapacity(
  materialSlotIndices: readonly (readonly number[])[],
  slotCapacity: number,
): number {
  const capacity = Math.max(0, Math.floor(slotCapacity));
  const maxRenderableCount = Math.min(materialSlotIndices.length, capacity);
  let renderableCount = 0;
  while (renderableCount < maxRenderableCount) {
    const slots = materialSlotIndices[renderableCount] ?? [];
    if (slots.some((slot) => slot >= capacity)) break;
    renderableCount += 1;
  }
  return renderableCount;
}

/** Count material slots reachable from a prefix of a first-seen slot plan. */
export function materialSlotCountForPrefix(
  materialSlotIndices: readonly (readonly number[])[],
  renderableCount: number,
): number {
  let maxSlot = -1;
  for (let index = 0; index < renderableCount; index += 1) {
    for (const slot of materialSlotIndices[index] ?? []) maxSlot = Math.max(maxSlot, slot);
  }
  return maxSlot + 1;
}

export type RecordProfileRunner = <T>(phase: RenderRecordPhase, action: () => T) => T;

const EMPTY_ENTITY_KEYS: ReadonlySet<number> = new Set<number>();

function runRecordProfilePhase<T>(
  runner: RecordProfileRunner | undefined,
  phase: RenderRecordPhase,
  action: () => T,
): T {
  return runner === undefined ? action() : runner(phase, action);
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
  // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2): the
  // full worlds[] list passed to `renderer.draw`, indexed by
  // RenderableSnapshot.worldId so the record stage resolves each renderable's
  // mesh + material textures against the world it was extracted from (mirroring
  // the per-world extract stage). Optional + defaulting to `[world]` keeps the
  // pre-split single-world identity path (worldId always 0) byte-for-byte and
  // the existing unit-test callers (which pass a single mock world) valid.
  worlds: readonly World[] = [world],
  profilePhase?: RecordProfileRunner,
  gpuDriven?: {
    readonly owner: GpuDrivenProduction;
    readonly scene: PersistentGpuDrivenState | undefined;
    readonly onCoverage: (ownsAll: boolean) => void;
  },
  renderReadLeases?: readonly RenderReadLease[],
  featureGraphCandidate?: RenderFeatureGraphCandidate,
  pointsLinesOwner?: import('./render-context').PointsLinesRecordOwner,
): boolean {
  // The `try / finally` wrapper advances `frameState.frameNumber` exactly
  // once per `recordFrame` invocation regardless of which early-return
  // branch is taken (camera missing, cap exceeded, pipeline pending,
  // swap-chain unavailable, etc).
  // The boolean result reports whether the shared frame encoder reached queue
  // submission; prepared graphics uses it to distinguish in-flight from
  // unsubmitted buffer leases.
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
        hint: 'world.spawn({ component: Transform, data: { pos: [x, y, z], quat: [x, y, z, w], scale: [x, y, z] } }, { component: Camera, data: { fov, aspect, near, far, clearColor: [r, g, b, a] } }) before renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })',
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
    if (!camera) return false;
    const pipelineState = internals.getPipelineState();
    if (pipelineState === null) return false;
    frameState.currentFrameObservationSource = undefined;
    frameState.currentDirectionalShadowView = null;
    frameState.currentSpotShadowView = null;

    // Record-stage fold operator linear scan (groups transparent-sort entries
    // into fold buckets + records the fold-eligible count metric). Extracted to
    // computeFoldBuckets (M3/w18).
    const { foldBuckets, light } = runRecordProfilePhase(profilePhase, 'record/scene-state', () => {
      const foldBuckets = runRecordProfilePhase(
        profilePhase,
        'record/scene-state/fold-buckets',
        () => computeFoldBuckets(world, frameState, transparentDispatch, renderables),
      );

      // Multi-light warnings + point/spot shadow-snapshot pin + point-shadow atlas
      // ensure + ExtractedLights three-arm destructure (directional fallback,
      // point/spot arrays, totalLightCount). Extracted to prepareFrameLighting
      // (M3/w18) so recordFrame stays a skeleton.
      const { light, pointLights, spotLights, totalLightCount } = runRecordProfilePhase(
        profilePhase,
        'record/scene-state/lighting-prep',
        () => prepareFrameLighting(internals, frameState, lights),
      );

      runRecordProfilePhase(profilePhase, 'record/scene-state/ambient-resolution', () => {
        // feat-20260520-skylight-ibl-cubemap M4 / t27 (AC-10 + F-4 nit):
        // 0-light three-condition conjunction (plan-strategy D-5):
        //   no Skylight (skylight === undefined)
        //   AND 0 direct light (totalLightCount === 0)
        //   AND StandardMaterial (renderables.some materialShaderId !== 'forgeax::default-unlit')
        // All three true -> black + warn. A single false -> no warn.
        //
        // Multi-Skylight warn (F-4 nit + feat-20260630 M3 / w19): >1 Skylight
        // entity -> warn ONCE per RenderSystem lifetime (not per frame), naming the
        // winning entity handle so the scene author can tell which Skylight is used
        // (F-8: warn carries conflicting entity info). First Skylight (by archetype
        // order) wins.
        warnMultiSkylight(frameState, skylightCount, skylight?.entityHandle ?? 0);

        // Multi-SkyboxBackground warn (feat-20260630 M3 / w19): mirror the Skylight
        // once-warn + winning-entity-handle pattern. First SkyboxBackground (by
        // archetype order) wins.
        warnMultiSkybox(frameState, skyboxCount, skybox?.entityHandle ?? 0);

        // feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
        // lazy equirect-to-cubemap projection trigger (the single per-frame driver;
        // plan-strategy D-4 + sequence diagram). The Skylight (or, when present
        // without one, the SkyboxBackground) supplies the equirect handle; both
        // reuse the same handle so a single projection serves IBL ambient + skybox.
        //   - handle 0          -> no equirect (solid-color ambient); skip
        //   - caps.rgba16float
        //     Renderable false  -> permanent white fallback; never project (AC-06,
        //                          the only IBL gate; no UA guard)
        //   - status undefined  -> first sight: resolve POD + fire-and-forget launch
        //                          (does NOT await; the store writes status:'pending'
        //                          synchronously so this launches exactly once)
        //   - status pending    -> projection in flight; white fallback this frame
        //                          (normal transition, not an error -- no fire)
        //   - status ready      -> real IBL bound by the recordMainPass cache check
        //   - status failed     -> fire EquirectProjectionFailedError ONCE per
        //                          handle (R-2/AC-09: store records failed
        //                          permanently and never retries; the latch keeps
        //                          the channel from flooding)
        const lazyEquirectHandle = selectLazyEquirectHandle(skylight, skybox);
        if (lazyEquirectHandle !== 0) {
          driveLazyEquirectProjection(internals, world, frameState, lazyEquirectHandle);
        }
      });

      // feat-20260608-cluster-lighting M5 / w21 + M6 / w23: HDRP per-frame CPU
      // cluster binning + light-data / cluster-grid / SSAO buffer uploads. Runs
      // only when the HDRP pipeline is active and there is at least one punctual
      // light. Extracted to a sub-function (M3/w18) so recordFrame stays a
      // skeleton; fail-soft error semantics are preserved verbatim.
      runRecordProfilePhase(profilePhase, 'record/scene-state/hdrp-cluster', () => {
        writeHdrpClusterAndSsaoBuffers(
          internals,
          frameState,
          camera,
          pointLights,
          spotLights,
          profilePhase,
          pipelineState.hdrpClusterMembershipPipeline !== null &&
            internals.device.caps?.compute === true,
          pipelineState.hdrpClusterMembershipBindGroupLayout,
        );
      });

      // Zero-light standard-material once-warn (no Skylight + 0 direct light +
      // >=1 lit material -> black). Extracted to warnZeroLightStandard (M3/w18).
      warnZeroLightStandard(frameState, renderables, skylight, totalLightCount);

      return { foldBuckets, light };
    });

    // Case E (this commit): 0 renderables = legitimate scene (LO §1.1
    // hello-window minimum semantic). Mirrors the Case C softening for
    // 0 DirectionalLight (line 134 above; D-Q7). recordFrame() falls
    // through to encode + submit a clear-pass-only render pass so the
    // canvas is painted with `clearColor` even when no entity carries
    // MeshFilter + MeshRenderer. Geometry submission (mat4 uploads,
    // bind-group construction, vertex/index binding, drawIndexed) is
    // conditional on `validatedOrdered.length > 0` further down.

    // Point-shadow params UBO write (per-layer near/far/invSpan). Extracted to
    // writeShadowParamsBuffer (M3/w18).
    writeShadowParamsBuffer(internals, frameState, pipelineState);

    // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
    // the per-spot perspective `lightViewProj` matrices fold into the View UBO
    // tail (`view.spotLightViewProj`, floats 132..195 / bytes 528..784) and are
    // written as part of the per-frame viewPayload below — no standalone binding
    // 9 uniform buffer (it overflowed the WebGL2 fallback fragment uniform-buffer
    // budget). See the viewPayload construction (VIEW_PAYLOAD_FLOATS = 196).

    const effectiveShadowMapSize = resolveShadowMapSize(internals, lights);
    const effectiveSpotShadowMapSize = resolveSpotShadowMapSize(internals, lights);
    const graphShadowMapSize = effectiveShadowMapSize ?? effectiveSpotShadowMapSize;

    let preparedGpuDriven: PreparedGpuDrivenFrame | undefined;
    if (gpuDriven !== undefined) {
      const prepared = gpuDriven.owner.prepare({
        scene: gpuDriven.scene,
        camera,
        meshes: pipelineState.meshes,
        viewBindGroupLayout: pipelineState.viewBindGroupLayout,
        meshResidencyEpoch: internals.gpuStore.meshResidencyEpoch,
        hdrp: frameState.isHdrpActive,
      });
      if (prepared.ok) preparedGpuDriven = prepared.value;
      else if (prepared.error.code !== 'rhi-not-available')
        internals.errorRegistry.fire(prepared.error);
    }

    // The GPU lane owns only the primary opaque raster today. Directional,
    // point, and spot shadow views still consume the CPU-validated draw plan.
    const cpuShadowCastersActive =
      (effectiveShadowMapSize ?? 0) > 0 ||
      lights.pointShadow.length > 0 ||
      lights.spot.some((spot) => spot.castShadow);
    const gpuOwnsAllPrimaryRaster = preparedGpuDriven?.ownsAllRenderables === true;
    gpuDriven?.onCoverage(gpuOwnsAllPrimaryRaster && !cpuShadowCastersActive);

    const preflightGraph = runRecordProfilePhase(profilePhase, 'record/render-graph', () =>
      ensureCompiledFrameGraph(
        internals,
        frameState,
        pipelineState,
        camera,
        lights,
        Math.max(1, internals.canvas.width),
        Math.max(1, internals.canvas.height),
        graphShadowMapSize,
        preparedGpuDriven,
        featureGraphCandidate,
      ),
    );
    if (preflightGraph === null) return false;

    // Acquire the swap-chain texture + colour view + target dimensions (with
    // one reconfigure-and-retry on surface-outdated). Extracted to
    // acquireSwapChainTarget (M3/w18); returns null on unrecoverable failure
    // (context null / double getCurrentTexture fail / view creation fail), in
    // which case recordFrame bails after the finally-block frame advance.
    const swapTarget = runRecordProfilePhase(profilePhase, 'record/swapchain', () =>
      acquireSwapChainTarget(internals, pipelineState),
    );
    if (swapTarget === null) return false;
    const currentTexture = swapTarget.currentTexture;
    const view = swapTarget.view;
    const targetW = swapTarget.targetW;
    const targetH = swapTarget.targetH;

    const depthView: TextureView | null = null;
    // feat-20260709 M3 / D-3: clear-color read from the active CameraSnapshot's
    // single `clearColor` array field (first-archetype-hit per OOS-2). When the
    // world had zero Camera entities, `camera` here is the synthetic fallback
    // snapshot built above (Case B), which carries
    // `ZERO_CAMERA_CLEAR_FALLBACK = [0, 0, 0, 1]`.
    const clear: readonly [number, number, number, number] = [
      camera.clearColor[0],
      camera.clearColor[1],
      camera.clearColor[2],
      camera.clearColor[3],
    ];

    pipelineState.perPassResources.shadowMapSize = graphShadowMapSize ?? 0;
    pipelineState.perPassResources.shadowCascadeCount = lights.cascadeCount ?? 0;
    const firstDirectionalShadowMatrix = lights.lightViewProj?.[0];
    pipelineState.perPassResources.shadowLightSpaceMatrix =
      firstDirectionalShadowMatrix === undefined
        ? null
        : new Float32Array(firstDirectionalShadowMatrix);
    if (lights.lightViewProj === undefined) {
      pipelineState.perPassResources.shadowCsmLightViewProj = null;
      pipelineState.perPassResources.shadowCsmSelection = null;
    } else {
      const csmMatrices = new Float32Array(64);
      for (let cascade = 0; cascade < 4; cascade += 1) {
        const matrix = lights.lightViewProj[cascade];
        if (matrix !== undefined) csmMatrices.set(matrix, cascade * 16);
      }
      pipelineState.perPassResources.shadowCsmLightViewProj = csmMatrices;
      pipelineState.perPassResources.shadowCsmSelection =
        lights.splitPlanes === undefined
          ? null
          : {
              viewMatrix: new Float32Array(computeViewMatrix(camera)),
              splitPlanes: new Float32Array(lights.splitPlanes),
            };
    }

    // Tonemap + skybox-active resolution (skybox requires tonemap HDR target +
    // a resident cubemap view). Extracted to resolveSkyboxActive (M3/w18).
    const { tonemapActive, skyboxActive } = resolveSkyboxActive(
      internals,
      frameState,
      camera,
      skybox,
    );

    // feat-20260604-learn-render-4.10-anti-aliasing-msaa M2 / w9 (D-6, C-9):
    // MSAA is a per-Camera switch derived from `camera.antialias`, never
    // stored separately. When active the geometry pass writes a count=4
    // multisample colour target and resolves to a single-sample output; the
    // record stage selects the `*Msaa` pipeline variants and the geometry
    // pass attaches the resolve target. When inactive every attachment +
    // pipeline stays single-sample (the pre-MSAA path is byte-for-byte
    // unchanged).
    // Geometry colour / depth / resolve / sprite-split target view resolution
    // (MSAA + tonemap routing) + MSAA writeback to perPassResources. Extracted
    // to resolveGeometryTargetViews (M3/w18) so recordFrame stays a skeleton.
    const msaaActive =
      camera.antialias === 'msaa' && internals.device.caps.backendKind !== 'wgpu-webgl2';
    const geometryColorView = view;
    const geometryDepthView = depthView;
    const geometryDepthKey: string | null = null;
    const geometryColorResolveView: TextureView | null = null;
    const ldrSpriteColorView: TextureView | null = null;

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
    const gpuOwnedEntityKeys = preparedGpuDriven?.entityKeys ?? EMPTY_ENTITY_KEYS;
    const validated = runRecordProfilePhase(profilePhase, 'record/validation', () =>
      gpuOwnsAllPrimaryRaster && !cpuShadowCastersActive
        ? []
        : validateRenderables(
            internals,
            world,
            worlds,
            pipelineState,
            frameState,
            renderables,
            transparentDispatch,
            cpuShadowCastersActive ? EMPTY_ENTITY_KEYS : gpuOwnedEntityKeys,
          ),
    );
    gpuDriven?.owner.recordCpuValidation(validated, gpuOwnedEntityKeys);

    // Per-frame cache clean-up: drop per-entity BG cache entries + instance
    // buffers whose entityKey is absent from the current validated set (despawn
    // eviction). Extracted to cleanPerFrameCaches (M3/w18).
    cleanPerFrameCaches(internals, frameState, validated, gpuOwnedEntityKeys);

    // Dispatch-ordered render plan: reorder validated renderables to dispatch
    // order, run the mesh-SSBO capacity gate (graceful truncation), and build
    // the fold dispatch plan. Extracted to buildDispatchPlan (M3/w18).
    const dispatchPlan = runRecordProfilePhase(profilePhase, 'record/dispatch-plan', () =>
      buildDispatchPlan(internals, validated, transparentDispatch, foldBuckets),
    );
    const validatedOrdered = dispatchPlan.validatedOrdered;
    const foldDispatchPlan = dispatchPlan.foldDispatchPlan;
    const materialSlotIndices = dispatchPlan.materialSlotIndices;
    const materialSlots = dispatchPlan.materialSlots;
    const materialSlotOwners = dispatchPlan.materialSlotOwners;
    const materialSlotCount = dispatchPlan.materialSlotCount;

    // D-2 (bug-20260527): LDR sprite pass split, generalised feat-20260625
    // M2 / w7 via {@link computeSplitLdrSprite}; M3 w13 finalised by deleting
    // the legacy shadingModel arm — transparent is the single SSOT. AC-05
    // (non-sprite shader carrying transparent:true) trips the split too;
    // the unit suite render-system-record.test.ts 'transparent decouples
    // from sprite shader' locks the contract.
    //
    // When the LDR path (tonemapActive=false) has transparent entities in
    // the validated draw list, the render is split into two serial passes
    // sharing one color attachment. The transparent pass format is resolved
    // by transparentPassColorFormat: native linear-LDR frames use the
    // graph-owned `ldrColor` attachment (which may be rgba16float), while
    // the swap-chain fallback uses its raw storage view. The encoder and
    // sprite PSO must use the same resolved format because WebGPU requires
    // attachment and pipeline target formats to match.
    const splitLdrSprite = computeSplitLdrSprite(validatedOrdered, tonemapActive);
    let ldrSpritePassView: TextureView | null = null;
    if (splitLdrSprite) {
      const unormViewRes = internals.device.createTextureView(currentTexture, {});
      if (!unormViewRes.ok) {
        internals.errorRegistry.fire(unormViewRes.error);
        return false;
      }
      ldrSpritePassView = unormViewRes.value;
    }

    // View / mesh uniform uploads are only needed when geometry will be drawn,
    // OR when a skybox is active (skybox pass reads inverseViewProj from
    // the View UBO). Skip the writeBuffer round-trips on the Case E
    // (clear-pass-only) path only when neither condition is met.
    // feat-20260531-skybox-env-background M2 / w6: gate relaxed from
    // `validatedOrdered.length > 0` to include skybox-only frames
    // (plan-strategy D-3, R-3).
    if (validatedOrdered.length > 0 || skyboxActive) {
      runRecordProfilePhase(profilePhase, 'record/uploads', () => {
        // View UBO + CSM/spot-shadow matrix pack: assembled + uploaded in one
        // queue.writeBuffer round-trip. Extracted to view-ubo.ts (M3/w18) so
        // recordFrame stays an orchestration skeleton (D-2).
        writeViewUbo(
          internals.device.queue,
          pipelineState.viewUniformBuffer,
          camera,
          light,
          lights,
          frameState.spotShadowSnapshots,
        );
        if (pipelineState.pointsLinesViewBuffer !== undefined) {
          writePointsLinesViewUbo(
            internals.device.queue,
            pipelineState.pointsLinesViewBuffer,
            camera,
            targetW,
            targetH,
          );
        }
        writeShadowCasterUniforms(
          internals.device.queue,
          pipelineState.shadowCasterCascadeBuffer,
          lights,
        );

        // Per-frame full rewrite of the PointLight + SpotLight std430 storage
        // buffers (header + first-slice cap N=4 slots). Extracted to
        // writePointSpotLightBuffers (M3/w18).
        writePointSpotLightBuffers(internals, pipelineState, lights);

        // Per-renderable entity_world upload (batched): all N mat4+normalMatrix
        // slots assembled into a single contiguous scratch buffer, then flushed
        // as one writeBuffer call. Extracted to mesh-ssbo.ts (M3/w21) so its
        // module-scoped scratch buffer co-locates with the other mesh-SSBO lets.
        uploadMeshSsboBatch(
          internals.device.queue,
          pipelineState.meshStorageBuffer,
          validatedOrdered,
          foldDispatchPlan,
        );
      });
    }

    const directionalShadowCache = runRecordProfilePhase(
      profilePhase,
      'record/scene-state/directional-shadow-cache',
      () =>
        prepareDirectionalShadowCache(
          internals,
          frameState,
          worlds,
          renderReadLeases,
          lights,
          effectiveShadowMapSize,
          validatedOrdered,
        ),
    );
    frameState.directionalShadowCacheRecorded = false;

    const encoderResult = internals.device.createCommandEncoder({ label: 'render-system-frame' });
    if (!encoderResult.ok) {
      internals.errorRegistry.fire(encoderResult.error);
      return false;
    }
    const encoder: RhiCommandEncoder = encoderResult.value;

    // Per-frame bind group cache resolution (view / mesh / HDRP-cluster).
    // Extracted to buildPerFrameBindGroups (M3/w18) so recordFrame stays a
    // skeleton; returns null groups on the Case E (0-validated) path.
    const { viewBindGroup, meshBindGroup, hdrpClusterBindGroup, hdrpClusterMembershipBindGroup } =
      runRecordProfilePhase(profilePhase, 'record/bind-groups', () =>
        buildPerFrameBindGroups(
          internals,
          frameState,
          pipelineState,
          validated.length > 0 || preparedGpuDriven !== undefined,
          bindGroupCounts,
          undefined,
          false,
        ),
      );

    // ── feat-20260529-rendergraph-pass-abstraction M4 / w13b ───────────
    // The compiled typed graph is the sole per-frame pass owner.
    //
    // Every pass records into the shared encoder. The graph owns ordering and
    // the renderer finishes and submits exactly once after graph execution.
    // feat-20260601 M2 / w12: the per-frame shared state is the clean
    // `RenderPipelineContext` - `internals` is replaced by the named `assets`
    // (CPU POD) / `store` (GPU residency) / `pipelineState` / `runtime` (device +
    // errorRegistry + shader-cache lookups) surfaces (`internals` itself satisfies
    // `RenderSystemRuntime` so `runtime: internals` is a zero-cost reference). The
    // 0-consumed `skyboxCount` residual is dropped.
    const passCtx: _InternalRenderPipelineContext = {
      assets: internals.assets,
      world,
      gpuDrivenEntityKeys: gpuOwnedEntityKeys,
      store: internals.gpuStore,
      pipelineState,
      runtime: internals,
      encoder,
      view,
      clear,
      targetW,
      targetH,
      currentTexture,
      camera,
      tonemapActive,
      geometryColorView,
      geometryDepthView,
      geometryDepthKey,
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
      ldrSpritePassView,
      msaaActive,
      geometryColorResolveView,
      ldrSpriteColorView,
      postProcessParams,
      dispatch: transparentDispatch,
      hdrpClusterBindGroup,
      hdrpClusterMembershipBindGroup,
      foldDispatchPlan,
      materialSlotIndices,
      materialSlots,
      materialSlotOwners,
      materialSlotCount,
      pointsLines: pointsLinesOwner,
      materialBgAssemblyCache: frameState.materialBgAssemblyCache,
      directionalShadowCacheReuse: directionalShadowCache.reuse,
      ...(profilePhase !== undefined ? { profilePhase } : {}),
    };
    const submitted = runRecordProfilePhase(profilePhase, 'record/graph-execute', () =>
      executeCompiledFrameGraph(
        internals,
        frameState,
        passCtx,
        encoder,
        profilePhase === undefined
          ? undefined
          : (pass, encode) => profilePhase(graphExecutionPhase(pass.name), encode),
      ),
    );
    if (submitted && !directionalShadowCache.reuse) {
      frameState.directionalShadowCache = frameState.directionalShadowCacheRecorded
        ? directionalShadowCache.next
        : null;
    }
    return submitted;
  } finally {
    frameState.frameNumber += 1;
    // feat-20260608-cluster-lighting M5 / w22: clear HDRP once-per-frame fired
    // set so the next frame re-fires if the condition persists.
    frameState.hdrpOncePerFrameFired.clear();
  }
}

interface DirectionalShadowCacheDecision {
  readonly reuse: boolean;
  readonly next: DirectionalShadowCache | null;
}

function readWorldState(lease: RenderReadLease): DirectionalShadowWorldState {
  return {
    worldIdentity: lease.worldIdentity,
    changeCursor: lease.inspectCursor(),
  };
}

function sameWorldState(
  cached: DirectionalShadowCache,
  worlds: readonly World[],
  leases: readonly RenderReadLease[] | undefined,
): boolean {
  if (leases === undefined || leases.length !== worlds.length) return false;
  if (cached.worlds.length !== worlds.length || cached.worldStateTokens.length !== leases.length) {
    return false;
  }
  for (let index = 0; index < worlds.length; index += 1) {
    const world = worlds[index];
    const lease = leases[index];
    if (world === undefined || lease === undefined || cached.worlds[index] !== world) return false;
    const cachedState = cached.worldStateTokens[index];
    if (cachedState === undefined) return false;
    if (cachedState.worldIdentity !== lease.worldIdentity) return false;
    let changes: ReturnType<RenderReadLease['readChanges']>;
    try {
      changes = lease.readChanges(cachedState.changeCursor);
    } catch {
      // A lease may have evicted an old cursor after another owner consumed
      // its bounded cursor window. Treat that as stale render evidence and
      // rebuild the atlas from the current lease rather than reaching into
      // World for a second mutation clock.
      return false;
    }
    if (changes.status !== 'ok') return false;
    if (changes.world.records.length !== 0 || changes.sharedRefs.records.length !== 0) {
      return false;
    }
  }
  return true;
}

function sameLightViewProj(
  cached: DirectionalShadowCache,
  current: readonly Float32Array[],
): boolean {
  if (cached.lightViewProj.length !== current.length) return false;
  for (let matrixIndex = 0; matrixIndex < current.length; matrixIndex += 1) {
    const previous = cached.lightViewProj[matrixIndex];
    const next = current[matrixIndex];
    if (previous === undefined || next === undefined || previous.length !== next.length) {
      return false;
    }
    for (let valueIndex = 0; valueIndex < next.length; valueIndex += 1) {
      if (previous[valueIndex] !== next[valueIndex]) return false;
    }
  }
  return true;
}

function prepareDirectionalShadowCache(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  worlds: readonly World[],
  leases: readonly RenderReadLease[] | undefined,
  lights: ExtractedLights,
  shadowMapSize: number | undefined,
  validatedOrdered: readonly ValidatedRenderable[],
): DirectionalShadowCacheDecision {
  const cascadeCount = lights.cascadeCount;
  const lightViewProj = lights.lightViewProj;
  if (
    frameState.compiledFrameGraph === null ||
    frameState.compiledFrameGraphTopologyKey === null ||
    shadowMapSize === undefined ||
    shadowMapSize <= 0 ||
    cascadeCount === undefined ||
    cascadeCount <= 0 ||
    lightViewProj === undefined ||
    validatedOrdered.length === 0
  ) {
    return { reuse: false, next: null };
  }

  const cached = frameState.directionalShadowCache;
  const assetCatalogEpoch = internals.assets.catalogEpoch;
  const meshResidencyEpoch = internals.gpuStore.meshResidencyEpoch;
  if (
    cached !== null &&
    cached.shadowMapSize === shadowMapSize &&
    cached.cascadeCount === cascadeCount &&
    cached.pipelineHandle === frameState.installedPipelineHandle &&
    cached.graphTopologyKey === frameState.compiledFrameGraphTopologyKey &&
    cached.assetCatalogEpoch === assetCatalogEpoch &&
    cached.meshResidencyEpoch === meshResidencyEpoch &&
    sameWorldState(cached, worlds, leases) &&
    sameLightViewProj(cached, lightViewProj)
  ) {
    return { reuse: true, next: null };
  }

  if (leases === undefined || leases.length !== worlds.length) {
    // Direct record-stage test harnesses may omit the host-owned leases. They
    // still exercise the real shadow encoder, but without the ECS read owner
    // they must conservatively rebuild rather than inspect World internals.
    return { reuse: false, next: null };
  }
  const worldStateTokens = leases.map(readWorldState);

  return {
    reuse: false,
    next: {
      worlds: worlds.slice(),
      worldStateTokens: worldStateTokens as DirectionalShadowWorldState[],
      assetCatalogEpoch,
      pipelineHandle: frameState.installedPipelineHandle,
      graphTopologyKey: frameState.compiledFrameGraphTopologyKey,
      shadowMapSize,
      cascadeCount,
      lightViewProj: lightViewProj.map((matrix) => new Float32Array(matrix)),
      meshResidencyEpoch,
    },
  };
}

/**
 * feat-20260704 M3/w18: validate renderable handles + collect the render plan,
 * extracted verbatim from `recordFrame`. Empty `renderables` input or all-
 * unregistered handles both yield an empty result (the Case E clear-pass-only
 * path). Builds per-entry renderState / stencilReference overlays from the
 * transparent-dispatch entries, resolves each MeshFilter.assetHandle through
 * the AssetRegistry + GPU store (with the sprite 9-slice mesh swap), and fires
 * structured `asset-not-registered` errors for handles that fail to resolve.
 *
 * @internal
 */
function validateRenderables(
  internals: RenderSystemInternals,
  world: World,
  // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2): the full
  // worlds[] list. Each renderable's mesh handle is a user-tier slot in its OWN
  // world's sharedRefs; resolving against a foreign world either misses
  // (asset-not-registered) or resolves the wrong slot payload. `world` (the
  // resource-owner) is retained as the fallback for renderables whose worldId
  // is out of range (defensive; extractFrames always stamps a valid index).
  worlds: readonly World[],
  pipelineState: PipelineState,
  frameState: RenderFrameState,
  renderables: readonly RenderableSnapshot[],
  transparentDispatch: readonly DispatchEntry[],
  excludedEntityKeys: ReadonlySet<number> = new Set<number>(),
): ValidatedRenderable[] {
  // bug-20260527-renderstate-pipeline-dispatch-gap D-4:
  // build a renderableIndex -> renderState map from dispatch entries
  // so each ValidatedRenderable carries its per-material renderState
  // override without an O(n^2) back-scan in the draw loop.
  const renderStateByRenderableIdx = new Map<number, MaterialRenderState | undefined>();
  // w10: also build a renderableIndex -> stencilReference map from
  // dispatch entries for per-draw setStencilReference calls.
  const stencilRefByRenderableIdx = new Map<number, number | undefined>();
  const variantSetByRenderableIdx = new Map<number, string | undefined>();
  // Keep these three independent maps because each overlay has its own
  // consumer and the last dispatch entry remains authoritative.  Populate
  // them in one pass: the old code walked the same dispatch list three times
  // and repeated the same renderableIndex branch / hash writes.
  for (const de of transparentDispatch) {
    const renderableIndex = de.renderableIndex;
    if (renderableIndex === undefined) continue;
    renderStateByRenderableIdx.set(renderableIndex, de.renderState);
    stencilRefByRenderableIdx.set(renderableIndex, de.stencilReference);
    variantSetByRenderableIdx.set(renderableIndex, variantSetFromDefines(de.defines));
  }
  const validated: ValidatedRenderable[] = [];
  for (let rIdx = 0; rIdx < renderables.length; rIdx++) {
    const r = renderables[rIdx];
    if (r === undefined) continue;
    if (excludedEntityKeys.has(worldEntityKey(r.worldId, r.entityKey))) continue;
    // feat-20260709-editor-world-partition ENGINE-fix-round2 (defect 2): resolve
    // this renderable's mesh against the world it was EXTRACTED from
    // (worlds[r.worldId]) — NOT the single resource-owner `world`. Builtin mesh
    // slots (< BUILTIN_BASE) resolve process-statically regardless of world, so
    // the per-world pick only matters for user-tier handles, but selecting it
    // unconditionally keeps a single code path. Falls back to the resource-owner
    // world if worldId is out of range (defensive; extractFrames always stamps
    // a valid index into worlds[]).
    const renderableWorld = worlds[r.worldId] ?? world;
    const assetRes = resolveAssetHandle<MeshAsset>(
      renderableWorld,
      toShared<'MeshAsset'>(r.assetHandle),
    );
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
    // feat-20260601-device/gpu-residency-extraction M1 (D-1): builtin meshes
    // (slots through HANDLE_NINESLICE_QUAD) keep the createRenderer step-3
    // direct-upload + `pipelineState.meshes` path -- they are NOT routed
    // through `ensureResident`. User-registered meshes pull through the store
    // on first access (the register->upload push was severed in this M1);
    // the POD fetched above (assetRes.value) is passed in, store holds no
    // registry ref (D-2). A first-access miss builds the GPU buffers; later
    // frames hit the O(1) cache.
    const meshAssetHandle = toShared<'MeshAsset'>(r.assetHandle);
    let meshHandles = internals.gpuStore.getMeshGpuHandles(meshAssetHandle, renderableWorld);
    if (meshHandles === undefined && r.assetHandle > handleSlot(HANDLE_NINESLICE_QUAD)) {
      const residentRes = internals.gpuStore.ensureResident(
        meshAssetHandle,
        assetRes.value,
        renderableWorld,
      );
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
          hint: 'await renderer.initialization before draw([world], { cameraOwner: 0, resourceOwner: 0 }); ensure AssetRegistry.configureGpuDevice ran so user meshes are uploaded',
          detail: { assetHandle: r.assetHandle },
        }),
      );
      continue;
    }
    // feat-20260527-sprite-nineslice M2 / w11 (plan-strategy section D-2):
    // sprite branch with non-zero `slicesAndMode` (post-w12 paramSnapshot
    // entry name) overrides the user-supplied mesh handle (typically
    // HANDLE_QUAD = 3) with the 16-vertex / 54-index HANDLE_NINESLICE_QUAD
    // (id=5) topology so the vertex shader sees the 4x4 grid required for
    // 9-region anchor mapping. Default slicesAndMode ([0, 0, 0, 0]) keeps
    // the legacy HANDLE_QUAD path; a flip from zero to non-zero on the
    // same entity routes here per-frame so AI users can toggle 9-slice
    // on the fly without re-spawning the entity (charter F1 minimum
    // surface). The HANDLE_NINESLICE_QUAD GPU buffers are seeded by
    // createRenderer step-3.
    //
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13: judgement
    // key migrated from `shadingModel === 'sprite'` to
    // `materialShaderId === 'forgeax::sprite'` (plan-strategy D-10); slices
    // sourced from `paramSnapshot.slicesAndMode` (post-w12 UBO-aligned
    // overlay path).
    //
    // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7:
    // sprite-lit shares the sprite paramSchema (5 fields, t4 mirror) so
    // the 9-slices mesh swap applies identically.
    let effectiveMeshHandles = meshHandles;
    if (
      r.material.materialShaderId === 'forgeax::sprite' ||
      r.material.materialShaderId === 'forgeax::sprite-lit'
    ) {
      const slicesArr = r.material.paramSnapshot?.slicesAndMode as readonly number[] | undefined;
      if (
        slicesArr !== undefined &&
        slicesArr.length >= 4 &&
        (slicesArr[0] !== 0 || slicesArr[1] !== 0 || slicesArr[2] !== 0 || slicesArr[3] !== 0)
      ) {
        const nineSliceHandles = pipelineState.meshes.get(handleSlot(HANDLE_NINESLICE_QUAD));
        if (nineSliceHandles !== undefined) {
          effectiveMeshHandles = nineSliceHandles;
        }
      }
    }
    if (r.morph !== undefined) {
      const morphed = prepareMorphMesh(
        internals,
        frameState,
        worldEntityKey(r.worldId, r.entityKey),
        effectiveMeshHandles,
        assetRes.value,
        r.morph,
      );
      if (morphed !== undefined) effectiveMeshHandles = morphed;
    }
    validated.push({
      source: r,
      world: renderableWorld,
      mesh: effectiveMeshHandles,
      renderableIndex: rIdx,
      renderState: renderStateByRenderableIdx.get(rIdx),
      variantSet: variantSetByRenderableIdx.get(rIdx),
      stencilReference: stencilRefByRenderableIdx.get(rIdx),
    });
  }
  return validated;
}

function prepareMorphMesh(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  cacheKey: number,
  base: MeshGpuHandles,
  mesh: MeshAsset,
  morph: RenderableSnapshot['morph'],
): MeshGpuHandles | undefined {
  if (morph === undefined || frameState.morphBuffers === undefined) return undefined;
  const targets = mesh.morphTargets;
  if (targets === undefined || targets.length !== morph.targetCount) return undefined;
  if (base.layoutProjection.arrayStride !== 48 || base.vertexCount <= 0) return undefined;
  const stride = mesh.vertices.length / base.vertexCount;
  if (!Number.isInteger(stride) || stride < 3) return undefined;

  let active = false;
  for (const weight of morph.weights) {
    if (weight !== 0) {
      active = true;
      break;
    }
  }
  if (!active) {
    frameState.morphBuffers.get(cacheKey)?.buffer.destroy();
    frameState.morphBuffers.delete(cacheKey);
    return undefined;
  }

  const vertices = new Float32Array(mesh.vertices);
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const weight = morph.weights[targetIndex] ?? 0;
    const positions = targets[targetIndex]?.position;
    if (positions === undefined || positions.length !== base.vertexCount * 3) return undefined;
    for (let vertex = 0; vertex < base.vertexCount; vertex += 1) {
      const vertexBase = vertex * stride;
      const positionBase = vertex * 3;
      vertices[vertexBase] = (vertices[vertexBase] ?? 0) + (positions[positionBase] ?? 0) * weight;
      vertices[vertexBase + 1] =
        (vertices[vertexBase + 1] ?? 0) + (positions[positionBase + 1] ?? 0) * weight;
      vertices[vertexBase + 2] =
        (vertices[vertexBase + 2] ?? 0) + (positions[positionBase + 2] ?? 0) * weight;
    }
  }

  let cached = frameState.morphBuffers.get(cacheKey);
  if (cached === undefined || cached.byteLength !== vertices.byteLength) {
    if (cached !== undefined && !cached.buffer.isDestroyed) {
      const destroyed = cached.buffer.destroy();
      if (!destroyed.ok) internals.errorRegistry.fire(destroyed.error);
    }
    const created = internals.device.createBuffer({
      label: `morph-${cacheKey}-vbo`,
      size: vertices.byteLength,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!created.ok) {
      internals.errorRegistry.fire(created.error);
      frameState.morphBuffers.delete(cacheKey);
      return undefined;
    }
    cached = {
      buffer: new GpuBuffer(internals.device, created.value),
      byteLength: vertices.byteLength,
    };
    frameState.morphBuffers.set(cacheKey, cached);
  }
  const written = internals.device.queue.writeBuffer(cached.buffer.handle, 0, vertices);
  if (!written.ok) {
    internals.errorRegistry.fire(written.error);
    return undefined;
  }
  return { ...base, vertexBuffer: cached.buffer };
}

/**
 * feat-20260704 M3/w18: build the dispatch-ordered render plan, extracted
 * verbatim from `recordFrame`. (1) M3/w26 dispatch-ordered reorder: reorder
 * `validated` to follow the transparent-dispatch order (extract-order fallback
 * for unmatched entries). (2) feat-20260608 mesh-SSBO capacity gate: size the
 * mesh-SSBO + material-UBO pair to the larger of entity vs cumulative
 * material-slot count, truncating on ceiling (graceful degradation). (3)
 * feat-20260622 fold dispatch plan: build + apply the WebGL2 uniform-cap
 * fallback + bump the folded-draws metric.
 *
 * @internal
 */
function buildDispatchPlan(
  internals: RenderSystemInternals,
  validated: readonly ValidatedRenderable[],
  transparentDispatch: readonly DispatchEntry[],
  foldBuckets: readonly FoldBucket[],
): {
  validatedOrdered: readonly ValidatedRenderable[];
  foldDispatchPlan: FoldDispatchPlan | null;
  materialSlotIndices: readonly (readonly number[])[];
  materialSlots: readonly MaterialSnapshot[];
  materialSlotOwners: readonly number[];
  materialSlotCount: number;
} {
  // M3 / w26: dispatch-ordered render. The dispatch list is pre-sorted
  // by queue (ascending, stable) by the extract stage per plan-strategy D-3.
  // Reorder validated renderables to follow the dispatch order, falling
  // back to extract order for renderables with no matching dispatch entry.
  let dispatchOrderMatchesValidated = transparentDispatch.length === validated.length;
  if (dispatchOrderMatchesValidated) {
    for (let i = 0; i < validated.length; i++) {
      if (transparentDispatch[i]?.renderableIndex !== validated[i]?.renderableIndex) {
        dispatchOrderMatchesValidated = false;
        break;
      }
    }
  }
  let validatedOrdered: readonly ValidatedRenderable[] = dispatchOrderMatchesValidated
    ? validated
    : [...validated];
  if (transparentDispatch.length > 0 && !dispatchOrderMatchesValidated) {
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
    // Append renderables not in the dispatch list (e.g. default-material entities)
    for (const v of validated) {
      if (!seen.has(v.renderableIndex)) {
        ordered.push(v);
      }
    }
    validatedOrdered = ordered;
  }

  const materialGroups = validatedOrdered.map((entry): readonly MaterialSnapshot[] => {
    const shaderId = entry.source.material.materialShaderId;
    if (shaderId === 'forgeax::sprite' || shaderId === 'forgeax::sprite-lit') {
      return [entry.source.material];
    }
    return entry.source.materials.length > 0 ? entry.source.materials : [entry.source.material];
  });
  const materialSlotPlan = buildMaterialSlotPlan(materialGroups);
  let materialSlotIndices = materialSlotPlan.slotIndices;
  let materialSlots = materialSlotPlan.slots;
  let materialSlotOwners = materialSlotPlan.slotOwners;
  let materialSlotCount = materialSlots.length;

  // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M3 / T-M3-04:
  // ensure the mesh-SSBO + material-UBO buffer pair is large enough to hold
  // the render plan BEFORE the first per-entity writeBuffer.
  // On `ok:false` the controller has already fired a structured RuntimeError
  // (`mesh-ssbo-ceiling-reached` / `mesh-ssbo-capacity-exceeded`); we truncate
  // the draw list to the largest complete entity prefix whose cumulative
  // material slots fit `degradedToSlotCount` (graceful degradation per
  // plan-strategy D-2): render the subset that fits, discard overflow, no
  // black frame. The helper is idempotent across same-frame re-calls (AC-09)
  // and short-circuits on length=0 / length<=slotCount (boundary table).
  //
  // bug-20260609: feat-20260608 M5 amend made the material UBO indexed by
  // cumulative *material-slot* count (one slot per submesh material),
  // which is >= entity count once an entity carries `materials.length>1`.
  // The mesh + material buffer pair share `slotCount` (single allocator),
  // so we size against the larger of the two requirements: entity count
  // (mesh-SSBO consumer) vs cumulative material-slot count (material-UBO
  // consumer). Sprite entities collapse to 1 slot in the material table,
  // mirroring the same rule (sprite per-submesh OOS-1;
  // post-w13 judgement key migrated to materialShaderId).
  //
  // feat-20260624 M1' / t7: sprite-lit treated identically to sprite
  // for material-slot accounting (paramSchema mirror, t4).
  const neededSlots = Math.max(validatedOrdered.length, materialSlotCount);
  const meshSsboCapResult = ensureMeshSsboCapacity(internals, neededSlots);
  if (!meshSsboCapResult.ok) {
    // Graceful degradation: the controller reports slots, but this stage
    // consumes entities. Find a complete prefix instead of slicing at the
    // numeric slot count; a multi-material entity can consume several slots.
    const degradedRenderableCount = findRenderablePrefixForSlotCapacity(
      materialSlotIndices,
      meshSsboCapResult.degradedToSlotCount,
    );
    materialSlotCount = materialSlotCountForPrefix(materialSlotIndices, degradedRenderableCount);
    materialSlotIndices = materialSlotIndices.slice(0, degradedRenderableCount);
    materialSlots = materialSlots.slice(0, materialSlotCount);
    materialSlotOwners = materialSlotOwners.slice(0, materialSlotCount);
    validatedOrdered = validatedOrdered.slice(0, degradedRenderableCount);
  }

  // feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4-record-swap
  // (D-1): build the fold dispatch plan once `validatedOrdered` is final
  // (post truncation by mesh-SSBO capacity gate). The plan re-keys each
  // non-singleton bucket from `renderableIndex` to the validated-ordered
  // index `i` consumed by the dispatch loops; the loops use it to skip
  // non-head bucket members and emit one instanced drawIndexed per
  // bucket head. Empty plan (no fold-eligible buckets) is a byte-
  // identical no-op for the dispatch loops below (charter P3: silent
  // pass-through, no error path).
  let renderableToValidatedIdx: Map<number, number> | null = null;
  let foldDispatchPlan: FoldDispatchPlan | null = null;
  if (foldBuckets.length > 0) {
    renderableToValidatedIdx = new Map<number, number>();
    for (let i = 0; i < validatedOrdered.length; i++) {
      const e = validatedOrdered[i];
      if (e === undefined) continue;
      renderableToValidatedIdx.set(e.renderableIndex, i);
    }
    foldDispatchPlan = buildFoldDispatchPlan(foldBuckets, renderableToValidatedIdx);

    // feat-20260622 M2 / w11 (D-2 + D-9 + AC-05): WebGL2 uniform-fallback
    // per-bucket instance-count cap. When caps.storageBuffer===false AND
    // a fold bucket carries more than FOLD_UNIFORM_INSTANCE_CAP (128)
    // instances, fire RhiError({code:'instancing-exceeds-uniform-cap'})
    // AND remove the bucket from the dispatch plan so its members fall
    // through to the per-entity drawIndexed exit (the same exit the
    // mode-gate bypass uses — D-9 "shared fallback exit"). The frame
    // stays visually correct (charter proposition 9 graceful
    // degradation: no identity-collapse / black screen) while the cap
    // event surfaces structurally for AI users (proposition 4 explicit
    // failure on .code).
    //
    // Scope discrimination: tilemap-chunk-extract-system encodes
    // Layer.value = (layerOrder<<20) | (chunkIndex & 0xfffff), so a
    // bucket whose head entry carries non-zero low-20-bits is
    // definitively a tilemap-chunk dispatch site. Plain sprite buckets
    // use SPRITE_LAYER_VALUE = layerOrder<<20 (low-20 zero) by the
    // documented convention (apps/hello/asi-world main.ts pattern).
    // The chunkIndex===0 edge case maps to 'sprite' (the helper's
    // default branch) — a one-bucket ambiguity per layerOrder that is
    // acceptable for the AI-user affordance level (the error semantics
    // — "this bucket exceeded the cap" — is the actionable signal;
    // scope=sprite vs tilemap-chunk only refines the recovery hint).
    if (foldDispatchPlan.headBuckets.size > 0 && !internals.device.caps.storageBuffer) {
      const filteredHeads = new Map<number, FoldBucket>(foldDispatchPlan.headBuckets);
      const filteredSkips = new Set<number>(foldDispatchPlan.skipIndices);
      let filteredCount = foldDispatchPlan.foldedBucketCount;
      for (const [headIdx, bucket] of foldDispatchPlan.headBuckets) {
        const scope: 'sprite' | 'tilemap-chunk' =
          (bucket.layer & 0xfffff) !== 0 ? 'tilemap-chunk' : 'sprite';
        const decision = evaluateFoldBucketUniformCap(bucket, internals.device.caps, scope);
        if (decision.fallback && decision.error !== undefined) {
          internals.errorRegistry.fire(decision.error);
          filteredHeads.delete(headIdx);
          filteredCount -= 1;
          for (let j = 1; j < bucket.entries.length; j++) {
            const memberEntry = bucket.entries[j];
            if (memberEntry === undefined) continue;
            const memberValidatedIdx = renderableToValidatedIdx.get(memberEntry.renderableIndex);
            if (memberValidatedIdx !== undefined) {
              filteredSkips.delete(memberValidatedIdx);
            }
          }
        }
      }
      if (filteredCount !== foldDispatchPlan.foldedBucketCount) {
        foldDispatchPlan = {
          headBuckets: filteredHeads,
          skipIndices: filteredSkips,
          foldedBucketCount: filteredCount,
        };
      }
    }

    // feat-20260622-chunk-gpu-instancing-sprite-tilemap M3 / w13 (D-3 +
    // AC-06): increment `render.instancing.foldedDraws` once per fold-
    // eligible head bucket retained after the cap-fallback filter above.
    // The metric tracks instanced drawIndexed call count for this frame
    // — cap-overrun buckets routed through the per-entity fallback exit
    // are removed from `foldDispatchPlan` and therefore not counted, by
    // construction (M2 / w11 cap-fallback + plan-strategy D-3 semantics).
    // Singleton buckets (mode-bypass under D-5, or non-foldable under
    // mode 0) carry `bucketSize === 1` and never enter `headBuckets`, so
    // the per-entity drawIndexed path correctly does not count.
    // SSOT helper lives in this record owner — engine code never
    // hardcodes the metric key string.
    incrementFoldedDrawsMetric(foldDispatchPlan, internals.metrics);
  }

  return {
    validatedOrdered,
    foldDispatchPlan,
    materialSlotIndices,
    materialSlots,
    materialSlotOwners,
    materialSlotCount,
  };
}

/**
 * feat-20260704 M3/w18: per-frame cache clean-up (despawn eviction), extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260531-per-frame-bind-group-cache M4 / w14 (D-5): drop per-entity BG
 * cache entries (materialBgPerEntity / instancesBgPerEntity) + instance buffers
 * whose outer-Map entityKey (packed Entity u32) is absent from the current
 * validated set, preventing unbounded growth after entity despawn. view + mesh
 * caches are frame-shared (keyed by GPU resource handle objects, WeakMap chains
 * naturally bounded) and are not touched. feat-20260619 M4 / F11: destroy the
 * GPU instance buffer before Map.delete (D-6 symmetric release); failure fires
 * errorRegistry + continues the sweep.
 *
 * @internal
 */
function cleanPerFrameCaches(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  validated: readonly ValidatedRenderable[],
  retainedEntityKeys: ReadonlySet<number> = new Set<number>(),
): void {
  if (frameState.transientInstanceBuffers !== undefined) {
    disposeTransientInstanceBuffers(frameState.transientInstanceBuffers, internals.errorRegistry);
  }
  // Build a Set<number> of worldEntityKey composites from the validated
  // renderables. D-1a #4: validatedEntityKeys are worldEntityKey(worldId, entityKey)
  // composites matching the write-side keys of #1-#3 — cross-world false eviction
  // is prevented because worldEntityKey(0, k) !== worldEntityKey(1, k).
  const validatedEntityKeys = new Set<number>(retainedEntityKeys);
  for (const v of validated) {
    validatedEntityKeys.add(worldEntityKey(v.source.worldId, v.source.entityKey));
  }

  // Clean per-entity material BG cache: drop outer-Map entries whose
  // entityKey is absent from the current validated set. The shared and
  // singleton material caches have no entityKey and are not touched here.
  cleanPerEntityCache(frameState.materialBgPerEntity, validatedEntityKeys);

  // Clean per-entity instances BG cache.
  cleanPerEntityCache(frameState.instancesBgPerEntity, validatedEntityKeys);

  // D-5 retrofit: instanceBuffers clean-up. The instanceBuffers Map is
  // keyed by cacheKey (packed Entity u32, same as entityKey on
  // RenderableSnapshot). Drop entries whose key is no longer in the
  // validated set (OQ-3 / R-4). feat-20260619 M4 / F11: destroy the GPU
  // buffer before Map.delete so despawned entities release their
  // instance-buffer backing memory symmetrically (D-6).
  //
  // D-1a #1: instanceBuffers keys on the positive half (>= 0) are
  // worldEntityKey composites matching the write side. Negative half
  // fold-bucket keys (< 0) are NOT worldEntityKey; they are
  // material-handle-based and cross-world collision is semantically
  // correct (same material renders in same fold bucket).
  for (const [key, entry] of frameState.instanceBuffers.entries()) {
    if (!validatedEntityKeys.has(key)) {
      if (!entry.buffer.isDestroyed) {
        const r = entry.buffer.destroy();
        if (!r.ok) internals.errorRegistry.fire(r.error);
      }
      frameState.instanceBuffers.delete(key);
    }
  }

  if (frameState.morphBuffers !== undefined) {
    for (const [key, entry] of frameState.morphBuffers.entries()) {
      if (validatedEntityKeys.has(key)) continue;
      if (!entry.buffer.isDestroyed) {
        const result = entry.buffer.destroy();
        if (!result.ok) internals.errorRegistry.fire(result.error);
      }
      frameState.morphBuffers.delete(key);
    }
  }
}

/**
 * feat-20260704 M3/w18: record-stage fold operator linear scan, extracted
 * verbatim from `recordFrame`.
 *
 * feat-20260622-chunk-gpu-instancing-sprite-tilemap M1 / w4 + w5 (D-1, D-5):
 * groups transparent-sort-ordered dispatch entries with equal (Layer.value,
 * sortKey, materialHandle) into fold buckets. Mode-gate (D-5 extended): modes 0
 * (LAYER_Z) and 1 (LAYER_Y) fold using the pos z/y lanes; modes 2/3 bypass per-entity
 * (each entry a singleton bucket). Records `frameState.lastFoldBucketCount` =
 * fold-eligible buckets (bucketSize > 1) for the AC-06 metric. Empty dispatch
 * short-circuits (test fixtures pass null world).
 *
 * @internal
 */
function computeFoldBuckets(
  world: World,
  frameState: RenderFrameState,
  transparentDispatch: readonly DispatchEntry[],
  renderables: readonly RenderableSnapshot[],
): readonly FoldBucket[] {
  if (transparentDispatch.length === 0) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }
  const transparentSortCfg = getTransparentSortConfig(world);

  // Only layer-Z / layer-Y modes can produce non-singleton fold buckets.
  // The other modes make one inert singleton per entry, which is discarded by
  // buildFoldDispatchPlan. Returning the same empty plan here avoids allocating
  // a transform matrix for every renderable when folding is disabled by mode.
  if (
    transparentSortCfg.mode !== TRANSPARENT_SORT_MODE_LAYER_Z &&
    transparentSortCfg.mode !== TRANSPARENT_SORT_MODE_LAYER_Y
  ) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }

  // `transparentDispatch` is the legacy name for the complete sorted dispatch
  // list. Opaque entries can never participate in the transparent-only fold
  // plan, yet foldDispatchBuckets must preserve its general helper contract and
  // therefore materializes an inert singleton (including a Float32Array(16))
  // for each one. Filter only at this private production call site so the fold
  // helper keeps its testable semantics while record avoids work whose result
  // is provably discarded.
  let transparentCount = 0;
  for (const entry of transparentDispatch) {
    if (renderables[entry.renderableIndex]?.material.transparent === true) {
      transparentCount += 1;
    }
  }
  if (transparentCount === 0) {
    frameState.lastFoldBucketCount = 0;
    return [];
  }
  const foldCandidates =
    transparentCount === transparentDispatch.length
      ? transparentDispatch
      : transparentDispatch.filter(
          (entry) => renderables[entry.renderableIndex]?.material.transparent === true,
        );
  const foldBuckets = foldDispatchBuckets(foldCandidates, transparentSortCfg.mode, renderables);
  // Count only fold-eligible buckets (bucketSize > 1) so the metric
  // surfaces fold actually reducing draws — singleton buckets under
  // mode bypass do not change draw count, so they do not contribute.
  let foldEligibleCount = 0;
  for (const b of foldBuckets) {
    if (b.bucketSize > 1) foldEligibleCount += 1;
  }
  frameState.lastFoldBucketCount = foldEligibleCount;
  return foldBuckets;
}
