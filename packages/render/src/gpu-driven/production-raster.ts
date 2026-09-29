import { frustum, mat4 } from '@forgeax/engine-math';
import type {
  GraphAccess,
  GraphBuffer,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  Result,
  RhiDevice,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { requiresProbeBlendRecord } from '../assembly/material/artifact-probe-blend';
import { materialArtifactProgramIdentity } from '../assembly/material/artifact-program-identity';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import {
  gpuDrivenDrawKey,
  gpuDrivenShadowDrawKey,
  gpuDrivenSourceDrawItemIndex,
} from '../extract/gpu-driven';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type {
  GpuDrivenLaneReason,
  GpuDrivenLaneSummary,
  GpuDrivenPreparationFailureInspection,
  GpuDrivenProductionInspection,
  GpuDrivenStructureMetrics,
} from '../inspection-types';
import { isCanonicalStandardPbrMaterialShader, isStandardPbrMaterialShader } from '../pbr-pipeline';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import { getOpaqueResourceIdentity, worldEntityKey } from '../record/frame-snapshot';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import {
  MATERIAL_PER_ENTITY_STRIDE,
  type PipelineState,
  type RecordProfileRunner,
  type RenderSystemInternals,
  runRecordProfilePhase,
} from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type {
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
} from '../render-pipeline';
import type {
  DispatchEntry,
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { OcclusionFrameProjection } from '../scene/visibility/occlusion-runtime';
import type {
  DynamicInputRange,
  ReadonlyDynamicInputPage,
  SurfaceDynamicInputFrame,
} from '../surface/dynamic-input';
import {
  admitSingleLayerMediumSubmission,
  type SurfaceGpuSubmissionAdmission,
} from '../surface/gpu-driven';
import type { SurfaceSubmissionCandidate } from '../surface/submission-observation';
import {
  batchLevelStride,
  batchLodLevelCount,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
  type GpuDrivenBatch,
  inspectResourceClassSplits,
  type SubmissionPlan,
} from './batch-topology';
import type { LodViewCamera } from './lod-projection.wgsl';
import {
  admittedRasterBatchCount,
  gpuDrawEntityCount,
  type LodProjectionState,
  lodProjectionState,
  lodSelectionChangeCount,
  lodViewCameraFromMatrix,
  shadowLodProjectionState,
} from './production-raster-lod';
import { MaterialAbiRasterAdapter } from './production-raster-material';
import {
  artifactForPreparedBatch,
  assemblePreparedPlan,
  EMPTY_SHADOW_KEYS,
  type FilteredProductionPlan,
  filteredPlan,
  ownsAllAdmittedDrawItems,
  type PreparationInputs,
  type PreparedBatch,
  type PreparedBatchRows,
  type PreparedProductionPlan,
  prepareBatchRows,
  type ShadowOwnershipSource,
  sameBatchMeshes,
  shadowArtifactForPreparedBatch,
  shadowCasterMembershipSignature,
  skinLaneReason,
  suppressedPrimitiveWords,
} from './production-raster-prepare';
import { combineGpuResourceAllocationInspections } from './resource-allocation';
import { restrictShadowCasterClasses, ShadowCasterClassifier } from './shadow-caster-classes';
import { buildShadowMembershipIndex, ShadowClaimTable } from './shadow-claims';
import {
  type ShadowViewIdentity,
  type ShadowViewProjection,
  ShadowViewStatePool,
  type ShadowViewUpdate,
  type ShadowViewUpdateInput,
  shadowViewHasStaticLayer,
  shadowViewIdentityKey,
} from './shadow-views';
import {
  type GpuDrivenLodSelectionInspection,
  type GpuDrivenLodSubmitIdentity,
  type GpuDrivenOcclusionCamera,
  GpuDrivenView,
  selectGpuLodLane,
} from './view-gpu';

/** Bind the whole GPU Scene transform table at group(2) binding(0) for every scene-index draw. */
export function resolveGpuDrivenMeshGroup(input: {
  readonly clustered: boolean;
  readonly deformation: 'rigid' | 'skin';
  readonly meshBindGroup: BindGroup;
  readonly sceneTransformBuffer: Buffer;
  readonly sceneTransformBytes: number;
  readonly frameResources: Pick<
    GpuDrivenStandardPbrFrameResources,
    'clusterBindGroup' | 'clusterBindGroupForMesh' | 'clusterBindGroupForSkin'
  >;
  readonly skinPaletteBinding?:
    | { readonly buffer: Buffer; readonly bindingWindowBytes: number }
    | undefined;
}): BindGroup | undefined {
  if (!input.clustered) return input.meshBindGroup;
  if (input.deformation === 'skin') {
    const palette = input.skinPaletteBinding;
    return palette === undefined
      ? undefined
      : input.frameResources.clusterBindGroupForSkin?.(
          input.sceneTransformBuffer,
          input.sceneTransformBytes,
          palette.buffer,
          palette.bindingWindowBytes,
        );
  }
  return input.frameResources.clusterBindGroupForMesh?.(
    input.sceneTransformBuffer,
    input.sceneTransformBytes,
  );
}

export interface GpuDrivenShadowBatchProjection {
  readonly mesh: MeshGpuHandles;
  readonly meshBindGroup: BindGroup;
  /** One visible-segment window per LOD level command, in level order. */
  readonly visibleBindGroups: readonly BindGroup[];
  readonly deformation: 'rigid' | 'skin';
  /** Actual producer-selected shadow-pass artifact for this batch. */
  readonly shadowArtifact: MaterialShaderArtifact;
  /** Pass entry points selected by the authored ShadowCaster dispatch. */
  readonly shadowVertexEntry?: string;
  readonly shadowFragmentEntry?: string;
  readonly shadowRenderState?: MaterialRenderState;
  /** Material snapshot used to assemble the receipt-owned alpha-mask BG. */
  readonly material: MaterialSnapshot;
  /** Composite entity identity used only for video-resource routing. */
  readonly materialEntityKey: number;
  /** Geometry-owned COLOR_0 fact shared by main and shadow ABI variants. */
  readonly vertexColorAvailable: boolean;
}

/**
 * Renderer-owned join between the scene-index candidate rows and a Surface
 * producer range. The user-facing range keeps its formal instance address;
 * the frame row is assigned after the RenderScene plan has been filtered and
 * its visible bases are known.
 */
interface SurfaceFrameRange {
  readonly frameIndex: number;
  readonly range?: DynamicInputRange;
  readonly directMember: {
    readonly worldIdentity: string;
    readonly worldId: number;
    readonly entityKey: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  };
}

interface SurfaceFrameProjection {
  readonly ranges: readonly SurfaceFrameRange[];
  readonly consumptionRanges: readonly DynamicInputRange[];
  readonly capacity: number;
}

function surfaceDynamicInputError(expected: string, hint: string): RhiError {
  return new RhiError({ code: 'rhi-descriptor-invalid', expected, hint });
}

function activeFrustum(camera: CameraSnapshot): Float32Array {
  const projection = mat4.create();
  if (camera.projection === 'orthographic') {
    mat4.orthographicReverseZ(
      projection,
      camera.orthoLeft,
      camera.orthoRight,
      camera.orthoTop,
      camera.orthoBottom,
      camera.near,
      camera.far,
    );
  } else {
    mat4.perspectiveReverseZ(projection, camera.fov, camera.aspect, camera.near, camera.far);
  }
  const view = mat4.invert(mat4.create(), camera.world);
  return frustum.fromViewProjection(
    frustum.create(),
    mat4.multiply(mat4.create(), projection, view),
  );
}

/**
 * Unjittered camera facts for the late HZB test. They derive from the same
 * helpers as the View UBO, so the pyramid and the test share one projection.
 */
function occlusionCamera(camera: CameraSnapshot): GpuDrivenOcclusionCamera {
  const viewProjection = mat4.multiply(
    mat4.create(),
    computeProjectionMatrix(camera),
    computeViewMatrix(camera),
  );
  return {
    viewProjection,
    near: camera.near,
    far: camera.far,
    orthographic: camera.projection === 'orthographic',
    historyKey: `${camera.worldId ?? ''}:${camera.entityKey ?? 0}:${camera.historyVersion ?? 0}:${camera.aspect}`,
  };
}

function isSingleLayerMediumArtifact(artifact: MaterialShaderArtifact): boolean {
  return artifact.receipt?.surface?.model === 'single-layer-medium';
}

function isSingleLayerMediumBatch(batch: PreparedBatch): boolean {
  return isSingleLayerMediumArtifact(batch.artifact);
}

/**
 * Join Surface ranges to the renderer-owned candidate rows in the visible
 * stream. The GPU culler may assign atomic compact slots in any order, but
 * each rigid member carries its view candidate row in `visibleItems.z`; frame
 * rows are keyed by that row rather than by the compact slot or the GPU Scene
 * instance row, which submeshes of one instance share. The producer's
 * `instanceIndex` remains in the range and is copied into the frame record
 * for the Surface ABI.
 */
function buildSurfaceFrameRanges(
  filtered: FilteredProductionPlan,
  ranges: readonly DynamicInputRange[],
  scene: PersistentGpuDrivenState,
): Result<readonly SurfaceFrameRange[], RhiError> {
  const surfaceMembers: Array<{
    readonly frameIndex: number;
    readonly identity: string;
    readonly directMember: SurfaceFrameRange['directMember'];
  }> = [];
  // Candidate rows follow the encoded plan: batches in order, then candidates.
  let candidateRow = 0;
  for (const prepared of filtered.batches) {
    const firstRow = candidateRow;
    candidateRow += prepared.batch.candidates.length;
    if (!isSingleLayerMediumBatch(prepared)) continue;
    for (const [index, candidate] of prepared.batch.candidates.entries()) {
      const slot = scene.slotAt(candidate.primitiveIndex);
      const worldIdentity = slot === undefined ? undefined : scene.worldIdentities?.[slot.worldId];
      const frameIndex = firstRow + index;
      if (slot === undefined || worldIdentity === undefined) {
        return err(
          new RhiError({
            code: 'rhi-descriptor-invalid',
            expected:
              'every admitted medium draw member has a renderer slot and public World identity',
            hint: `rebuild the persistent scene projection before publishing Surface ranges (primitive=${candidate.primitiveIndex})`,
          }),
        );
      }
      surfaceMembers.push({
        frameIndex,
        directMember: {
          worldIdentity,
          worldId: slot.worldId,
          entityKey: slot.entityKey,
          drawItemIndex: candidate.drawItemIndex,
          instanceOrdinal: candidate.instanceOrdinal,
        },
        identity: JSON.stringify([
          worldIdentity,
          slot.entityKey,
          candidate.drawItemIndex,
          candidate.instanceOrdinal,
        ]),
      });
    }
  }
  if (ranges.length === 0) {
    return ok(
      Object.freeze(
        surfaceMembers.map(({ frameIndex, directMember }) => ({ frameIndex, directMember })),
      ),
    );
  }
  const rangeByIdentity = new Map<string, DynamicInputRange>();
  for (const range of ranges) {
    const identity = JSON.stringify([
      range.member.worldIdentity,
      range.member.entityKey,
      range.member.drawItemIndex,
      range.member.instanceOrdinal,
    ]);
    if (rangeByIdentity.has(identity)) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'at most one Surface dynamic range for each stable draw member',
          hint: `remove the duplicate producer range for member ${identity}`,
        }),
      );
    }
    rangeByIdentity.set(identity, range);
  }
  if (ranges.length !== surfaceMembers.length) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'one stable-identity Surface dynamic range for every admitted medium draw member',
        hint: `publish one range per admitted Surface member (ranges=${ranges.length}, members=${surfaceMembers.length})`,
      }),
    );
  }
  const frameRanges: SurfaceFrameRange[] = [];
  for (const member of surfaceMembers) {
    const range = rangeByIdentity.get(member.identity);
    if (range === undefined) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'every admitted medium draw member resolves one stable-identity Surface range',
          hint: `publish the missing producer range for member ${member.identity}`,
        }),
      );
    }
    rangeByIdentity.delete(member.identity);
    frameRanges.push({ frameIndex: member.frameIndex, range, directMember: member.directMember });
  }
  if (rangeByIdentity.size !== 0) {
    return err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'every Surface range identifies an admitted medium draw member',
        hint: `remove ranges for non-admitted members: ${[...rangeByIdentity.keys()].join(', ')}`,
      }),
    );
  }
  return ok(Object.freeze(frameRanges));
}

function sceneRequiresGpuDrivenArtifact(scene: PersistentGpuDrivenState): boolean {
  return scene.plan.batches.some(
    (batch) =>
      batch.candidates.length > 0 &&
      batch.prepared?.receiptIdentity !== undefined &&
      (batch.prepared.identity.deformation === 'rigid' ||
        batch.prepared.identity.deformation === 'skin'),
  );
}

function missingMaterialArtifact(
  scene: PersistentGpuDrivenState,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  rigidFallback: MaterialShaderArtifact | undefined,
  skinFallback: MaterialShaderArtifact | undefined,
): GpuDrivenPreparationError | undefined {
  for (const batch of scene.plan.batches) {
    const prepared = batch.prepared;
    if (batch.candidates.length === 0 || prepared?.receiptIdentity === undefined) continue;
    if (artifactForPreparedBatch(batch, artifacts, rigidFallback, skinFallback) !== undefined)
      continue;
    return new GpuDrivenPreparationError('missing-material-receipt', {
      reason: 'material-receipt-missing',
      owner: 'material',
      expected: `published artifact for ${prepared.identity.material} (${prepared.receiptIdentity}@${prepared.receiptGeneration})`,
    });
  }
  return undefined;
}

function nonCpuPreparationFailure(
  scene: PersistentGpuDrivenState,
): { readonly error: GpuDrivenPreparationError; readonly drawKeys: readonly string[] } | undefined {
  const drawKeys: string[] = [];
  let first: GpuDrivenPreparationError | undefined;
  for (const slot of scene.slots) {
    const draws = slot.snapshot.gpuDrivenDraws ?? [];
    for (const [compactIndex, draw] of draws.entries()) {
      const error = draw.preparationError;
      if (error === undefined || error.detail.recovery === 'route-cpu-lane') continue;
      const material = slot.snapshot.materials[draw.materialSlot] ?? slot.snapshot.material;
      drawKeys.push(
        gpuDrivenDrawKey(
          worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey),
          material.materialHandle ?? -1,
          gpuDrivenSourceDrawItemIndex(draw, compactIndex),
        ),
      );
      first ??= error;
    }
  }
  return first === undefined ? undefined : { error: first, drawKeys };
}

function preparationFailureInspection(
  error: GpuDrivenPreparationError,
): GpuDrivenPreparationFailureInspection {
  return Object.freeze({
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  });
}

function shadowOwnershipFailureInspection(
  viewPass: GpuDrivenLaneSummary['viewPass'],
): GpuDrivenPreparationFailureInspection {
  return preparationFailureInspection(
    new GpuDrivenPreparationError('shadow-ownership', {
      reason: 'shadow-ownership-missing',
      owner: 'shadow',
      expected: 'one GPU-compatible owner for every declared ShadowCaster pass',
      actual: `${viewPass} contains a residual ShadowCaster draw item`,
      recovery: 'route-cpu-lane',
    }),
  );
}

export interface GpuDrivenWorldLodSelectionInspection {
  readonly worldKey: number;
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
  readonly candidateCount: number;
  readonly visible: number;
  readonly occluded: number;
  readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
}

function sameEntityKeySet(
  left: ReadonlySet<number> | undefined,
  right: ReadonlySet<number> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

type MaterialPipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;

function materialArtifactSignature(
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  rigidFallback: MaterialShaderArtifact | undefined,
  skinFallback: MaterialShaderArtifact | undefined,
): string {
  const rows =
    artifacts === undefined
      ? []
      : [...artifacts.entries()]
          .map(([key, artifact]) => [
            key,
            artifact.material,
            artifact.layoutIdentity,
            artifact.receipt?.receiptIdentity ?? '',
            artifact.receipt?.generation ?? 0,
            artifact.variantSet ?? '',
            materialArtifactProgramIdentity(artifact),
            artifact.vertexEntry ?? artifact.receipt?.sceneIndexEntry ?? '',
            artifact.fragmentEntry ?? '',
          ])
          .sort((left, right) => String(left[0] ?? '').localeCompare(String(right[0] ?? '')));
  return JSON.stringify({
    rows,
    rigid:
      rigidFallback === undefined
        ? undefined
        : [
            rigidFallback.material,
            rigidFallback.layoutIdentity,
            rigidFallback.receipt?.receiptIdentity ?? '',
            rigidFallback.receipt?.generation ?? 0,
            rigidFallback.variantSet ?? '',
            materialArtifactProgramIdentity(rigidFallback),
            rigidFallback.vertexEntry ?? rigidFallback.receipt?.sceneIndexEntry ?? '',
            rigidFallback.fragmentEntry ?? '',
          ],
    skin:
      skinFallback === undefined
        ? undefined
        : [
            skinFallback.material,
            skinFallback.layoutIdentity,
            skinFallback.receipt?.receiptIdentity ?? '',
            skinFallback.receipt?.generation ?? 0,
            skinFallback.variantSet ?? '',
            materialArtifactProgramIdentity(skinFallback),
            skinFallback.vertexEntry ?? skinFallback.receipt?.sceneIndexEntry ?? '',
            skinFallback.fragmentEntry ?? '',
          ],
  });
}

/** The GPU-driven bridge to the existing four-group Standard PBR pipeline. */

export interface PreparedGpuDrivenFrame {
  readonly topologySignature: string;
  /** Composition-local world indices mapped to the stable identities used by draw keys. */
  readonly worldKeys: readonly number[];
  /** True when every source draw item/instance is claimed by the GPU lane. */
  readonly ownsAllDrawItems: boolean;
  /** True only when the extracted ShadowCaster channel is fully represented. */
  readonly ownsAllShadowCasters?: boolean;
  /** Concrete main-pass draw identities claimed by the GPU projection. */
  readonly drawKeys?: ReadonlySet<string>;
  readonly standardPbrFrameResources: GpuDrivenStandardPbrFrameResources;
  /** Published Surface admission and its pass lane decision. */
  readonly surfaceSubmission?: SurfaceGpuSubmissionAdmission;
  readonly occlusion?: OcclusionFrameProjection;
  /** @internal Commits a replacement generation only after graph promotion. */
  readonly _commitResourceReplacement: () => void;
  /** @internal Retires superseded view buffers when graph compilation promotes them. */
  readonly _commitGpuResourceReplacement?: () => void;
  /** @internal Discards staged shadow cache publication after a failed frame. */
  readonly _abortResourceReplacement?: () => void;
  /** @internal Marks validated dynamic ranges consumed only after queue submit. */
  readonly _consumeSurfaceDynamicInput?: (frameNumber: number) => Result<void, RhiError>;
  /** Concrete ShadowCaster keys claimed by the GPU subset for this frame. */
  readonly shadowDrawKeys?: ReadonlySet<string>;
  /** View-scoped ShadowCaster claims consumed by each shadow record pass. */
  readonly shadowDrawKeysByView?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly projectShadow?: (
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    identity: ShadowViewIdentity,
    forceCompute?: boolean,
  ) => Result<ShadowViewProjection | undefined, RenderGraphError>;
  readonly updateShadowViews?: (
    views: readonly Omit<ShadowViewUpdateInput, 'sourcePlan' | 'scene'>[],
  ) => Result<void, RhiError>;
  readonly shadowViewPool?: ShadowViewStatePool;
  readonly shadowBatchProjections?: ReadonlyMap<
    string,
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>
  >;
  project(
    graph: RenderGraphBuilder<RenderPipelineFrame>,
    format: TextureFormat,
    sampleCount: 1 | 4,
    surfaceSubmissionObservation?: () => SurfaceSubmissionCandidate | undefined,
    additionalColorFormats?: readonly TextureFormat[],
    lateOcclusion?: boolean,
  ): Result<RenderPipelineGpuDrivenProjection, RenderGraphError | RhiError>;
}

/**
 * Renderer-owned identity token for the validation that resolves renderable
 * assets to GPU meshes. The token is deliberately narrower than a frame
 * number: unchanged persistent scene snapshots can reuse the resolved rows,
 * while a mesh/device/pipeline generation change forces a fresh producer read.
 */
export interface GpuDrivenResidencyValidationInput {
  /** Opaque renderer-computed world/source identity and generation fence. */
  readonly cacheKey: string;
  readonly renderables: readonly RenderableSnapshot[];
  readonly transparentDispatch: readonly DispatchEntry[];
  readonly pipelineState: PipelineState;
  readonly pipelineHandle: number;
  readonly meshResidencyEpoch: number;
  readonly deviceGeneration: number;
  readonly assetCatalogEpoch: number;
}

interface GpuDrivenResidencyValidationCache extends GpuDrivenResidencyValidationInput {
  readonly value: readonly ValidatedRenderable[];
  readonly dispatchRenderableIndices: readonly (number | undefined)[];
  readonly renderableIdentities: readonly RenderableSnapshot[];
  readonly dispatchIdentities: readonly DispatchEntry[];
}

interface GpuDrivenCpuValidationTelemetryCache {
  readonly cacheKey: string;
  readonly validatedSources: readonly RenderableSnapshot[];
  readonly gpuOwnedDrawKeys: ReadonlySet<string>;
  readonly worldKeys: readonly number[] | undefined;
  readonly gpuOwnedDrawCount: number;
  readonly totalDrawItems: number;
  readonly gpuOwnedRows: number;
  readonly cpuFallbackDrawItems: number;
  readonly cpuSemanticFallbackDrawItems: number;
  readonly cpuDeformationFallbackDrawItems: number;
  readonly cpuDeformationReasons: ReadonlyMap<
    'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    number
  >;
  readonly blockedDrawItems: number;
}

function sameValidatedSourceSequence(
  expected: readonly RenderableSnapshot[],
  actual: readonly { readonly source: RenderableSnapshot }[],
): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]?.source) return false;
  }
  return true;
}

function sameIdentitySequence<T extends object>(
  expected: readonly T[],
  actual: readonly T[],
): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) return false;
  }
  return true;
}

function sameDispatchRenderableIndices(
  expected: readonly (number | undefined)[],
  actual: readonly DispatchEntry[],
): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]?.renderableIndex) return false;
  }
  return true;
}

export interface RecoveryCapabilityFacts {
  readonly generation: number;
  readonly shaderCompilation: boolean;
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  readonly indirectDrawing: boolean;
  readonly multisample: boolean;
}

export type RecoveryCapabilityOutcome =
  | {
      readonly status: 'ready' | 'fallback';
      readonly generation: number;
      readonly disabled: readonly string[];
    }
  | {
      readonly status: 'disabled';
      readonly generation: number;
      readonly disabled: readonly string[];
      readonly allocations: 0;
    }
  | {
      readonly status: 'refused';
      readonly generation: number;
      readonly failedOwner: 'shader-material-pipeline';
      readonly resourceKind: 'pipeline';
    };

export function classifyRecoveryCapability(
  facts: RecoveryCapabilityFacts,
): RecoveryCapabilityOutcome {
  if (!facts.shaderCompilation) {
    return {
      status: 'refused',
      generation: facts.generation,
      failedOwner: 'shader-material-pipeline',
      resourceKind: 'pipeline',
    };
  }
  if (!facts.compute || !facts.storageBuffer || !facts.indirectDrawing) {
    return {
      status: 'disabled',
      generation: facts.generation,
      disabled: ['gpu-driven'],
      allocations: 0,
    };
  }
  return {
    status: facts.multisample ? 'ready' : 'fallback',
    generation: facts.generation,
    disabled: [],
  };
}

/** One filtered batch as the compiled raster encoder reads it on each frame. */
interface LiveRasterBatch {
  readonly batch: GpuDrivenBatch;
  readonly classKey: string;
  /**
   * Entity identity of every candidate, in candidate order. The plan holds all
   * resident candidates, so the frame material table may omit any one of them;
   * the batch shares one material slot, so any listed entity names it.
   */
  readonly materialEntityKeys: readonly number[];
}

/**
 * Pipeline and resource identity of a batch: everything a compiled raster
 * encoder captures. Candidate membership, visible windows, indirect offsets,
 * LOD ranges and material slots stay out; they are read live per frame.
 */
function rasterClassKey(prepared: PreparedBatch): string {
  const { batch, mesh, artifact } = prepared;
  const key = batch.key;
  return JSON.stringify([
    prepared.worldKey,
    key.assetHandle,
    key.drawKind,
    key.topology,
    key.pipelineClass,
    key.materialResourceClass,
    key.preparedIdentity ?? '',
    key.resourceIdentity ?? '',
    key.admission ?? '',
    key.materialPass ?? '',
    batch.prepared?.identity.deformation ?? 'rigid',
    prepared.standardTextureMask ?? -1,
    prepared.renderState ?? null,
    mesh.vboBytes,
    mesh.iboBytes,
    mesh.indexFormat,
    mesh.uvSetCount,
    artifact.material,
    artifact.layoutIdentity,
    artifact.receipt?.receiptIdentity ?? '',
    artifact.receipt?.generation ?? 0,
    artifact.variantSet ?? '',
    materialArtifactProgramIdentity(artifact),
  ]);
}

export class GpuDrivenProduction {
  private disposed = false;
  private view: GpuDrivenView | undefined;
  private materialRaster: MaterialAbiRasterAdapter | undefined;
  private skinRaster: MaterialAbiRasterAdapter | undefined;
  private readonly sceneIdentities = new WeakMap<object, number>();
  private nextSceneIdentity = 1;
  /** Per-source-batch preparation, valid while its global inputs hold. */
  private readonly preparedBatches = new Map<
    number,
    {
      readonly generation: number;
      readonly contentEpoch: number;
      readonly value: PreparedBatchRows;
    }
  >();
  private preparedCache:
    | {
        readonly plan: SubmissionPlan;
        readonly slotAt: PersistentGpuDrivenState['slotAt'];
        readonly worldKeys: readonly number[] | undefined;
        readonly scene: PersistentGpuDrivenState['scene'];
        readonly meshResidencyEpoch: number;
        readonly materialArtifactSignature: string;
        readonly batchRows: readonly PreparedBatchRows[];
        readonly value: PreparedProductionPlan;
      }
    | undefined;
  private filteredCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly materialArtifactSignature: string;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  /** Live draw facts of the latest prepared frame, read by compiled raster encoders. */
  private liveRasterBatches: readonly LiveRasterBatch[] = [];
  private liveRasterCache:
    | { readonly filtered: FilteredProductionPlan; readonly value: readonly LiveRasterBatch[] }
    | undefined;
  /** Per-frame admission facts; recomputed only when the active entity set changes. */
  private admissionCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly sceneCapacity: number;
        readonly activeEntityRevision?: number;
        readonly activeEntityKeys?: ReadonlySet<number>;
        readonly suppressed?: Uint32Array;
        readonly ownsAllDrawItems: boolean;
      }
    | undefined;
  private surfaceFrameRangeCache:
    | {
        readonly filtered: FilteredProductionPlan;
        readonly slots: PersistentGpuDrivenState['slots'];
        readonly allocationRevision: number;
        readonly page: ReadonlyDynamicInputPage | undefined;
        readonly projectionRevision: number;
        readonly value: SurfaceFrameProjection;
      }
    | undefined;
  private consumedSurfaceInput:
    | {
        readonly page: ReadonlyDynamicInputPage;
        readonly projectionRevision: number;
        readonly contentRevision: number;
        readonly bufferGeneration: number;
        readonly deviceGeneration: number;
      }
    | undefined;
  private surfaceFrameRangeBuilds = 0;
  private surfaceFrameRangeMemberScans = 0;
  private shadowFilteredCache:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly membership: string;
        readonly materialArtifactSignature: string;
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  private gpuOwnedSnapshotsMaterialized = 0;
  private filteredPlanBuilds = 0;
  private preparedBatchBuilds = 0;
  private filteredBatchBuilds = 0;
  private planRebuildBatches = 0;
  private planRebuildCandidates = 0;
  private lodSelectionChanges = 0;
  private lodSelectionBaseline:
    | {
        readonly prepared: PreparedProductionPlan;
        readonly selections: readonly (readonly number[])[];
      }
    | undefined;
  private gpuOwnedEntityCount = 0;
  private batchBindGroupCreates = 0;
  private validatedGpuOwnedRows = 0;
  private cpuFallbackDrawItems = 0;
  private cpuSemanticFallbackDrawItems = 0;
  private cpuDeformationFallbackDrawItems = 0;
  private readonly cpuDeformationReasons = new Map<
    'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    number
  >();
  private blockedDrawItems = 0;
  private preparationFailure: GpuDrivenPreparationFailureInspection | undefined;
  private encodedIndirectDraws = 0;
  private telemetryPrepared = false;
  private telemetryCandidateCount = 0;
  private telemetryGeometryWork = 0;
  private telemetryRootGeometryWork = 0;
  private telemetryOverflow = false;
  private indirectDrawCount = 0;
  private gpuOwnedDrawItems = 0;
  private mainTotalDrawItems = 0;
  private lane: 'gpu' | 'cpu-semantic' | 'cpu-deformation' | 'blocked' = 'cpu-semantic';
  private laneReason: GpuDrivenLaneReason = 'capability';
  private submissionState: 'idle' | 'pending' | 'submitted' | 'aborted' = 'idle';
  private retryCount = 0;
  private lastKnownGoodGeneration: number | undefined;
  private overflowRecoveryRequired = false;
  private shadowViews: ShadowViewStatePool | undefined;
  private shadowSourcePlan: SubmissionPlan | undefined;
  private shadowScene: PersistentGpuDrivenState['scene'] | undefined;
  private shadowBatchProjections = new Map<
    string,
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>
  >();
  private shadowDrawKeysByView = new Map<string, ReadonlySet<string>>();
  /** The view plan each retained projection map was built from. */
  private readonly shadowProjectedPlans = new WeakMap<
    ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
    SubmissionPlan
  >();
  private readonly shadowCasterClasses = new ShadowCasterClassifier();
  private shadowMeshResidencyEpoch: number | undefined;
  private shadowExpectedDrawKeys: ReadonlySet<string> = EMPTY_SHADOW_KEYS;
  private shadowOwnershipCache: ShadowOwnershipSource | undefined;
  private surfaceSubmission: SurfaceGpuSubmissionAdmission | undefined;
  private surfaceArtifactInspection: GpuDrivenProductionInspection['surfaceArtifact'];
  private shadowBatchProjectionSource: SubmissionPlan | undefined;
  private skinPaletteBuffer: Buffer | undefined;
  private committedPaletteContentRevision: number | undefined;
  private committedArtifactSignature: string | undefined;
  private validatedResidencyCache: GpuDrivenResidencyValidationCache | undefined;
  private residencyValidationCacheHits = 0;
  private residencyValidationScans = 0;
  private cpuValidationTelemetryCache: GpuDrivenCpuValidationTelemetryCache | undefined;
  private cpuValidationCacheHits = 0;
  private cpuValidationScans = 0;
  private structureMetrics: GpuDrivenStructureMetrics = {
    worldEntitiesScanned: 0,
    sceneTableUploadBytes: 0,
    paletteUploadBytes: 0,
  };
  private signatureCache:
    | {
        readonly filtered: FilteredProductionPlan;
        readonly sceneIdentity: number;
        readonly viewResourceGeneration: number;
        readonly meshResidencyEpoch: number;
        readonly value: string;
      }
    | undefined;

  constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
    private readonly recoveryCount = 0,
  ) {}

  private resolveSurfaceFrameRanges(
    filtered: FilteredProductionPlan,
    frame: SurfaceDynamicInputFrame | undefined,
    scene: PersistentGpuDrivenState,
  ): Result<SurfaceFrameProjection, RhiError> {
    const ranges = frame?.ranges ?? [];
    const projectionRevision = frame?.projectionRevision ?? 0;
    if (!Number.isSafeInteger(projectionRevision) || projectionRevision < 0) {
      return err(
        surfaceDynamicInputError(
          'the Surface projection revision is a non-negative safe integer',
          'advance the producer-owned projection revision only when membership or addresses change',
        ),
      );
    }
    const cached = this.surfaceFrameRangeCache;
    if (
      cached?.filtered === filtered &&
      cached.slots === scene.slots &&
      cached.allocationRevision === scene.scene.allocationRevision &&
      cached.page === frame?.page &&
      cached.projectionRevision === projectionRevision
    ) {
      return ok(cached.value);
    }
    this.surfaceFrameRangeBuilds += 1;
    for (const prepared of filtered.batches) {
      if (!isSingleLayerMediumBatch(prepared)) continue;
      this.surfaceFrameRangeMemberScans += prepared.batch.candidates.length;
    }
    const built = buildSurfaceFrameRanges(filtered, ranges, scene);
    if (!built.ok) return built;
    let capacity = 1;
    const consumptionRanges: DynamicInputRange[] = [];
    for (const entry of built.value) {
      capacity = Math.max(capacity, entry.frameIndex + 1);
      if (entry.range !== undefined) consumptionRanges.push(entry.range);
    }
    const value = {
      ranges: built.value,
      consumptionRanges: Object.freeze(consumptionRanges),
      capacity,
    };
    return ok(value);
  }

  private rememberSurfaceFrameProjection(
    filtered: FilteredProductionPlan,
    frame: SurfaceDynamicInputFrame | undefined,
    scene: PersistentGpuDrivenState,
    value: SurfaceFrameProjection,
  ): void {
    this.surfaceFrameRangeCache = {
      filtered,
      slots: scene.slots,
      allocationRevision: scene.scene.allocationRevision,
      page: frame?.page,
      projectionRevision: frame?.projectionRevision ?? 0,
      value,
    };
  }

  private consumeSurfaceDynamicInput(
    page: ReadonlyDynamicInputPage,
    ranges: readonly DynamicInputRange[],
    projectionRevision: number,
    frameNumber: number,
  ): Result<void, RhiError> {
    const consumed = this.consumedSurfaceInput;
    if (
      consumed?.page === page &&
      consumed.projectionRevision === projectionRevision &&
      consumed.contentRevision === page.contentRevision &&
      consumed.bufferGeneration === page.bufferGeneration &&
      consumed.deviceGeneration === page.deviceGeneration
    ) {
      return ok(undefined);
    }
    for (const range of ranges) {
      const receipt = page.consume(range, frameNumber);
      if (!receipt.ok) {
        return err(
          surfaceDynamicInputError(
            'each submitted Surface dynamic range was uploaded before graph consumption',
            receipt.error.hint,
          ),
        );
      }
    }
    this.consumedSurfaceInput = {
      page,
      projectionRevision,
      contentRevision: page.contentRevision,
      bufferGeneration: page.bufferGeneration,
      deviceGeneration: page.deviceGeneration,
    };
    return ok(undefined);
  }

  /**
   * Reuse the last producer-resolved residency rows when all source identity
   * and generation fences still match. Renderables and dispatch entries are
   * checked element-by-element as well as by their stable object identities so
   * an accidental in-place mutation cannot reuse stale renderable indices.
   */
  reuseResidencyValidation(
    input: GpuDrivenResidencyValidationInput,
  ): readonly ValidatedRenderable[] | undefined {
    const cached = this.validatedResidencyCache;
    if (
      cached === undefined ||
      cached.cacheKey !== input.cacheKey ||
      cached.pipelineState !== input.pipelineState ||
      cached.pipelineState.device !== this.device ||
      cached.pipelineHandle !== input.pipelineHandle ||
      cached.meshResidencyEpoch !== input.meshResidencyEpoch ||
      cached.deviceGeneration !== input.deviceGeneration ||
      cached.assetCatalogEpoch !== input.assetCatalogEpoch ||
      !sameIdentitySequence(cached.renderableIdentities, input.renderables) ||
      !sameIdentitySequence(cached.dispatchIdentities, input.transparentDispatch) ||
      !sameDispatchRenderableIndices(cached.dispatchRenderableIndices, input.transparentDispatch)
    ) {
      return undefined;
    }
    this.residencyValidationCacheHits += 1;
    return cached.value;
  }

  /** Publish the producer-owned rows after a completed residency validation. */
  rememberResidencyValidation(
    input: GpuDrivenResidencyValidationInput,
    value: readonly ValidatedRenderable[],
  ): void {
    this.validatedResidencyCache = {
      ...input,
      value,
      renderableIdentities: input.renderables,
      dispatchIdentities: input.transparentDispatch,
      dispatchRenderableIndices: input.transparentDispatch.map((entry) => entry.renderableIndex),
    };
    this.residencyValidationScans += 1;
  }

  private applyCpuValidationTelemetry(cache: GpuDrivenCpuValidationTelemetryCache): void {
    this.gpuOwnedDrawItems = cache.gpuOwnedDrawCount;
    this.mainTotalDrawItems = cache.totalDrawItems;
    this.validatedGpuOwnedRows = cache.gpuOwnedRows;
    this.cpuFallbackDrawItems = cache.cpuFallbackDrawItems;
    this.cpuSemanticFallbackDrawItems = cache.cpuSemanticFallbackDrawItems;
    this.cpuDeformationFallbackDrawItems = cache.cpuDeformationFallbackDrawItems;
    this.cpuDeformationReasons.clear();
    for (const [reason, count] of cache.cpuDeformationReasons) {
      this.cpuDeformationReasons.set(reason, count);
    }
    this.blockedDrawItems = cache.blockedDrawItems;
  }

  static forDevice(
    device: RhiDevice,
    shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ): GpuDrivenProduction {
    return new GpuDrivenProduction(device, shaderModuleFactory);
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'scene-table',
      create: () => {
        if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
        // Keep the actual detached production owner in the generation
        // aggregate. The recovery transaction, not a marker object, is the
        // owner that is published or discarded exactly once.
        return this;
      },
      cleanup: () => undefined,
    };
  }

  prepare(input: {
    readonly scene: PersistentGpuDrivenState | undefined;
    readonly visibleSurface?: import('../raytracing/visible-surface').VisibleSurfaceProjection;
    readonly temporalSources?: readonly ValidatedRenderable[];
    readonly camera: CameraSnapshot;
    /** GPU meshes projected by retained RenderScene slot, never raw asset handle. */
    readonly meshBySlot: ReadonlyMap<number, MeshGpuHandles>;
    readonly viewBindGroupLayout: BindGroupLayout;
    readonly meshResidencyEpoch: number;
    /** Optional for legacy Standard callers; omitted means non-HDRP. */
    readonly hdrp?: boolean;
    /** Explicit Standard topology; cluster resources are bound by main-pass. */
    readonly clustered?: boolean;
    readonly materialBindingClasses?: ReadonlyMap<string, string>;
    /** Cooked producer artifact selected from the frame material catalog. */
    readonly materialArtifact?: MaterialShaderArtifact;
    /** Compatibility input for callers that have not migrated their name. */
    readonly standardPbrArtifact?: MaterialShaderArtifact;
    /** Cooked producer artifact for the GPU skinning variant. */
    readonly materialSkinArtifact?: MaterialShaderArtifact;
    /** Compatibility input for callers that have not migrated their name. */
    readonly standardPbrSkinArtifact?: MaterialShaderArtifact;
    /** Per-draw producer artifacts keyed by prepared identity and receipt. */
    readonly materialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
    /** Per-draw shadow-pass artifacts keyed by the same prepared identity. */
    readonly shadowMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>;
    /** Retained ProbeBlend record page; slot N is addressed at aligned lane N+1. */
    readonly probeBlendRecordBuffer?: Buffer;
    readonly materialPipelineState?: PipelineState;
    readonly standardPbrPipelineState?: PipelineState;
    /** Existing renderer owner that builds the selected artifact PSO/BGL. */
    readonly materialPipelineFactory?: MaterialPipelineFactory;
    /** Extracted ShadowCaster ownership keyed by concrete draw item and pass. */
    readonly shadowCasterDrawKeys?: ReadonlySet<string>;
    /** Structured ShadowCaster ownership facts for exact pass admission. */
    readonly shadowCasterMembership?: readonly ShadowCasterMembership[];
    /** Capsule-ready casters leave the directional cascades (Deferred lane only). */
    readonly capsuleShadowDirectional?: boolean;
    /** Entity keys admitted by the persistent visibility facet for this view. */
    readonly activeEntityKeys?: ReadonlySet<number>;
    /** Collision-free renderer-owned revision for the active visibility set. */
    readonly activeEntityRevision?: number;
    /** Total extracted candidates, including facet-suppressed rows. */
    readonly telemetryCandidateCount?: number;
    /** Public receipt identity for the GPU telemetry copy encoded this frame. */
    readonly telemetrySubmit?: GpuDrivenLodSubmitIdentity;
    readonly occlusion?: OcclusionFrameProjection;
    /** Per-frame deltas from the existing RenderScene/GPU Scene/palette owners. */
    readonly structureMetrics?: GpuDrivenStructureMetrics;
    /** World/App frame-time snapshot consumed by authored Surface code. */
    readonly frameTime?: number;
    /** Current RHI device generation used for Surface admission. */
    readonly deviceGeneration?: number;
    /** Renderer-owned generic read-only Surface page and instance ranges. */
    readonly surfaceDynamicInput?: SurfaceDynamicInputFrame;
    /** Optional profiler seam for the `record/gpu-driven-prepare/*` phases. */
    readonly profilePhase?: RecordProfileRunner;
  }): Result<PreparedGpuDrivenFrame | undefined, RhiError | GpuDrivenPreparationError> {
    this.surfaceArtifactInspection = undefined;
    this.gpuOwnedSnapshotsMaterialized = 0;
    this.filteredPlanBuilds = 0;
    this.preparedBatchBuilds = 0;
    this.filteredBatchBuilds = 0;
    this.planRebuildBatches = 0;
    this.planRebuildCandidates = 0;
    this.lodSelectionChanges = 0;
    this.batchBindGroupCreates = 0;
    this.validatedGpuOwnedRows = 0;
    this.cpuFallbackDrawItems = 0;
    this.cpuSemanticFallbackDrawItems = 0;
    this.cpuDeformationFallbackDrawItems = 0;
    this.cpuDeformationReasons.clear();
    this.blockedDrawItems = 0;
    this.preparationFailure = undefined;
    this.encodedIndirectDraws = 0;
    this.telemetryPrepared = false;
    this.telemetryCandidateCount = input.telemetryCandidateCount ?? 0;
    this.telemetryGeometryWork = 0;
    this.telemetryRootGeometryWork = 0;
    this.telemetryOverflow = false;
    this.indirectDrawCount = 0;
    this.gpuOwnedDrawItems = 0;
    this.mainTotalDrawItems = 0;
    this.structureMetrics = input.structureMetrics ?? {
      worldEntitiesScanned: 0,
      sceneTableUploadBytes: 0,
      paletteUploadBytes: 0,
    };
    this.lane = 'cpu-semantic';
    this.laneReason = 'capability';
    this.submissionState = 'idle';
    this.shadowExpectedDrawKeys = EMPTY_SHADOW_KEYS;
    this.surfaceSubmission = undefined;
    const capability = classifyRecoveryCapability({
      generation: 0,
      shaderCompilation: true,
      compute: this.device.caps.compute,
      storageBuffer: this.device.caps.storageBuffer,
      indirectDrawing: this.device.caps.indirectDrawing,
      multisample: true,
    });
    if (
      input.scene === undefined ||
      (input.hdrp === true && input.clustered !== true) ||
      selectGpuLodLane(this.device.caps) === 'cpu' ||
      capability.status === 'disabled'
    ) {
      this.gpuOwnedEntityCount = 0;
      return ok(undefined);
    }
    if (this.overflowRecoveryRequired && this.view !== undefined) {
      const recovered = this.view._recoverFromOverflow();
      if (!recovered.ok) {
        this.gpuOwnedEntityCount = 0;
        this.lane = 'blocked';
        this.laneReason = 'capacity';
        return recovered;
      }
      this.overflowRecoveryRequired = false;
    }
    const scene = input.scene;
    const preparationFailure = nonCpuPreparationFailure(scene);
    if (preparationFailure !== undefined) {
      this.gpuOwnedEntityCount = 0;
      // A capable candidate that cannot be prepared is a stopped promotion,
      // not a CPU-semantic lane. Keep the concrete rejected draw count in the
      // detached channel so an inspector can repair the producer and retry the
      // same view-pass without guessing from an error string.
      this.blockedDrawItems = preparationFailure.drawKeys.length;
      this.mainTotalDrawItems = Math.max(
        this.mainTotalDrawItems,
        scene.plan.batches.reduce((total, batch) => total + batch.candidates.length, 0),
      );
      this.lane = 'blocked';
      this.laneReason = 'resource-not-ready';
      this.preparationFailure = preparationFailureInspection(preparationFailure.error);
      return err(preparationFailure.error);
    }
    const materialArtifact = input.materialArtifact ?? input.standardPbrArtifact;
    const skinArtifact = input.materialSkinArtifact ?? input.standardPbrSkinArtifact;
    const materialPipelineState = input.materialPipelineState ?? input.standardPbrPipelineState;
    const surfaceArtifact = [
      materialArtifact,
      skinArtifact,
      ...(input.materialArtifacts === undefined ? [] : input.materialArtifacts.values()),
    ].find((artifact) => artifact?.receipt?.surface?.model === 'single-layer-medium');
    this.surfaceArtifactInspection =
      surfaceArtifact?.receipt === undefined
        ? undefined
        : Object.freeze({
            material: surfaceArtifact.material,
            specializationKey: surfaceArtifact.specializationKey,
            variantSet: surfaceArtifact.variantSet,
            layoutIdentity: surfaceArtifact.layoutIdentity,
            receiptIdentity: surfaceArtifact.receipt.receiptIdentity,
            receiptGeneration: surfaceArtifact.receipt.generation,
            directEntry: surfaceArtifact.receipt.directEntry,
            sceneIndexEntry: surfaceArtifact.receipt.sceneIndexEntry,
          });
    const surfaceDynamicInputLayout = surfaceArtifact?.receipt?.surface?.dynamicInput?.layout;
    if (surfaceArtifact?.receipt?.surface !== undefined) {
      const deviceGeneration = input.deviceGeneration ?? 1;
      const admitted = admitSingleLayerMediumSubmission({
        abi: surfaceArtifact.receipt,
        caps: {
          compute: this.device.caps.compute,
          storageBuffer: this.device.caps.storageBuffer,
          indirectDrawing: this.device.caps.indirectDrawing,
        },
        sceneIndexReady: surfaceArtifact.receipt.sceneIndexEntry.length > 0,
        resourcesReady:
          surfaceArtifact.receipt.reflection.layoutIdentity === surfaceArtifact.layoutIdentity,
        dynamicInputReady:
          surfaceArtifact.receipt.surface.dynamicInput === undefined ||
          input.surfaceDynamicInput !== undefined,
        deviceGeneration,
        preparedDeviceGeneration: deviceGeneration,
      });
      if (!admitted.ok) {
        this.lane = 'blocked';
        this.laneReason = 'resource-not-ready';
        const failure = new GpuDrivenPreparationError('resource-not-ready', {
          reason: 'material-resource-missing',
          owner: 'material',
          expected: admitted.error.expected,
          actual: JSON.stringify(admitted.error.actual),
        });
        this.preparationFailure = preparationFailureInspection(failure);
        return err(failure);
      }
      this.surfaceSubmission = admitted.value;
    }
    const preparedArtifactSignature = materialArtifactSignature(
      input.materialArtifacts,
      materialArtifact,
      skinArtifact,
    );
    const shadowArtifactSignature = `${preparedArtifactSignature}|shadow=${materialArtifactSignature(input.shadowMaterialArtifacts, undefined, undefined)}`;
    const artifactSignature = `${shadowArtifactSignature}|bindings=${JSON.stringify([...(input.materialBindingClasses ?? [])])}`;
    if (
      (materialArtifact === undefined && input.materialArtifacts === undefined) ||
      materialPipelineState === undefined
    ) {
      this.gpuOwnedEntityCount = 0;
      this.laneReason = 'resource-not-ready';
      if (sceneRequiresGpuDrivenArtifact(input.scene)) {
        this.blockedDrawItems = input.scene.plan.batches.reduce(
          (total, batch) => total + batch.candidates.length,
          0,
        );
        this.mainTotalDrawItems = Math.max(this.mainTotalDrawItems, this.blockedDrawItems);
        this.lane = 'blocked';
        const failure =
          materialArtifact === undefined && input.materialArtifacts === undefined
            ? new GpuDrivenPreparationError('missing-material-receipt', {
                reason: 'material-receipt-missing',
                owner: 'material',
                expected: 'producer-owned MaterialProgramAbi GPU-driven artifact',
              })
            : new GpuDrivenPreparationError('resource-not-ready', {
                reason: 'material-resource-missing',
                owner: 'material',
                expected: 'producer-owned GPU-driven material pipeline state',
              });
        this.preparationFailure = preparationFailureInspection(failure);
        return err(failure);
      }
      return ok(undefined);
    }
    const rebuilt = runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/plan',
      () => {
        const missingArtifact = missingMaterialArtifact(
          scene,
          input.materialArtifacts,
          materialArtifact,
          skinArtifact,
        );
        if (missingArtifact !== undefined) return err(missingArtifact);
        return ok(
          this.assemblePrepared(
            scene,
            input.meshBySlot,
            input.meshResidencyEpoch,
            materialArtifact,
            skinArtifact,
            input.materialArtifacts,
            preparedArtifactSignature,
          ),
        );
      },
    );
    if (!rebuilt.ok) {
      this.gpuOwnedEntityCount = 0;
      this.lane = 'blocked';
      this.laneReason = 'resource-not-ready';
      this.blockedDrawItems = scene.plan.batches.reduce(
        (total, batch) => total + batch.candidates.length,
        0,
      );
      this.preparationFailure = preparationFailureInspection(rebuilt.error);
      return rebuilt;
    }
    const preparedPlan = rebuilt.value;
    const filterStage = runRecordProfilePhase(
      input.profilePhase,
      'record/gpu-driven-prepare/filter',
      () => {
        const lodProjection = lodProjectionState(preparedPlan, input.camera, scene.slotAt);
        const lodBaseline = this.lodSelectionBaseline;
        this.lodSelectionChanges =
          lodBaseline?.prepared === preparedPlan
            ? lodSelectionChangeCount(lodBaseline.selections, lodProjection.selections)
            : 0;
        this.lodSelectionBaseline = {
          prepared: preparedPlan,
          selections: lodProjection.selections,
        };
        let filtered = this.filteredCache?.value;
        if (
          filtered === undefined ||
          this.filteredCache?.prepared !== preparedPlan ||
          this.filteredCache.materialArtifactSignature !== artifactSignature
        ) {
          filtered = filteredPlan(preparedPlan, undefined, input.materialBindingClasses);
          this.filteredCache = {
            prepared: preparedPlan,
            materialArtifactSignature: artifactSignature,
            value: filtered,
          };
          this.filteredPlanBuilds = 1;
          this.filteredBatchBuilds += preparedPlan.source.batches.length;
        }
        this.gpuOwnedEntityCount = gpuDrawEntityCount(filtered.drawKeys);
        this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
        if (filtered.batches.length === 0) return undefined;
        const shadowOwnership = this.shadowOwnershipSource(
          input.shadowCasterDrawKeys,
          input.shadowCasterMembership,
        );
        const shadowMembership = shadowOwnership.signature;
        const shadowArtifactChanged =
          this.shadowFilteredCache !== undefined &&
          this.shadowFilteredCache.materialArtifactSignature !== shadowArtifactSignature;
        let shadowFiltered = this.shadowFilteredCache?.value;
        if (
          shadowFiltered === undefined ||
          this.shadowFilteredCache?.prepared !== preparedPlan ||
          this.shadowFilteredCache.membership !== shadowMembership ||
          this.shadowFilteredCache.materialArtifactSignature !== shadowArtifactSignature
        ) {
          shadowFiltered = filteredPlan(preparedPlan, shadowOwnership.claims);
          this.filteredBatchBuilds += preparedPlan.source.batches.length;
          this.shadowFilteredCache = {
            prepared: preparedPlan,
            membership: shadowMembership,
            materialArtifactSignature: shadowArtifactSignature,
            value: shadowFiltered,
          };
        }
        const sceneCapacity = scene.scene.rowCapacity;
        const cachedAdmission = this.admissionCache;
        const admissionMatches =
          cachedAdmission !== undefined &&
          cachedAdmission.prepared === preparedPlan &&
          cachedAdmission.sceneCapacity === sceneCapacity &&
          (input.activeEntityRevision !== undefined &&
          cachedAdmission.activeEntityRevision !== undefined
            ? input.activeEntityRevision === cachedAdmission.activeEntityRevision
            : sameEntityKeySet(cachedAdmission.activeEntityKeys, input.activeEntityKeys));
        const admission = admissionMatches
          ? cachedAdmission
          : {
              prepared: preparedPlan,
              sceneCapacity,
              ...(input.activeEntityRevision === undefined
                ? {}
                : { activeEntityRevision: input.activeEntityRevision }),
              ...(input.activeEntityKeys === undefined
                ? {}
                : { activeEntityKeys: input.activeEntityKeys }),
              ...(input.activeEntityKeys === undefined
                ? {}
                : {
                    suppressed: suppressedPrimitiveWords(
                      preparedPlan,
                      input.activeEntityKeys,
                      sceneCapacity,
                    ),
                  }),
              ownsAllDrawItems: ownsAllAdmittedDrawItems(preparedPlan, input.activeEntityKeys),
            };
        this.admissionCache = admission;
        return {
          lodProjection,
          filtered,
          admission,
          shadowOwnership,
          shadowArtifactChanged,
          shadowFiltered,
        };
      },
    );
    if (filterStage === undefined) {
      this.laneReason = 'unsupported';
      return ok(undefined);
    }
    const {
      lodProjection,
      filtered,
      admission,
      shadowOwnership,
      shadowArtifactChanged,
      shadowFiltered,
    } = filterStage;
    this.lane = 'gpu';
    this.laneReason = 'none';
    this.submissionState = 'pending';
    this.shadowSourcePlan = shadowFiltered.plan;
    this.shadowScene = scene.scene;
    const shadowCasterKeys = shadowOwnership.casterKeys;
    this.shadowExpectedDrawKeys = shadowCasterKeys ?? EMPTY_SHADOW_KEYS;
    if (shadowOwnership.ownsAllFor !== shadowFiltered) {
      shadowOwnership.ownsAllFor = shadowFiltered;
      shadowOwnership.ownsAll =
        shadowCasterKeys === undefined ||
        [...shadowCasterKeys].every((key) => shadowFiltered.shadowDrawKeys.has(key));
    }
    const ownsAllShadowCasters = shadowOwnership.ownsAll;
    if (this.shadowViews === undefined) {
      const created = ShadowViewStatePool.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
      });
      if (!created.ok) return created;
      this.shadowViews = created.value;
    }
    if (this.view === undefined) {
      const created = GpuDrivenView.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
      });
      if (!created.ok) return created;
      this.view = created.value;
    }
    // Candidate order is the same address carried in rigid visibleItems.z.
    // The shared GPU Scene owns transforms; this projection carries identity only.
    const surfaceRows =
      input.visibleSurface === undefined
        ? undefined
        : new Uint32Array(filtered.plan.candidateCount);
    if (surfaceRows !== undefined) {
      let row = 0;
      for (const batch of filtered.plan.batches) {
        for (const candidate of batch.candidates) {
          const slot = scene.slotAt(candidate.primitiveIndex);
          const base = input.visibleSurface?.slotBases.get(candidate.primitiveIndex) ?? 0;
          const instanceCount = slot?.snapshot.instances?.instanceCount ?? 1;
          surfaceRows[row++] =
            base === 0
              ? 0
              : base + candidate.drawItemIndex * instanceCount + candidate.instanceOrdinal;
        }
      }
    }
    const updated = this.view.update(
      filtered.plan,
      scene.scene,
      activeFrustum(input.camera),
      input.camera,
      0,
      admission.suppressed,
      undefined,
      occlusionCamera(input.camera),
      surfaceRows,
    );
    if (!updated.ok) return updated;
    this.view.setTelemetrySubmit(input.telemetrySubmit);
    this.telemetryPrepared = true;
    const view = this.view;
    const visibleBuffer = view.visibleBuffer;
    if (visibleBuffer === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'GpuDrivenView visible buffer after update',
          hint: 'keep the visible-index binding request on the updated GPU scene view',
        }),
      );
    }
    const representativeArtifact = materialArtifact ?? filtered.batches[0]?.artifact;
    if (representativeArtifact === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'one selected MaterialProgramAbi artifact for GPU-driven batches',
          hint: 'keep receipt-backed draws blocked until Catalog/load publishes their artifact',
        }),
      );
    }
    const probeBlendRequested = filtered.batches.some(({ artifact }) =>
      requiresProbeBlendRecord(artifact),
    );
    if (probeBlendRequested && input.probeBlendRecordBuffer === undefined) {
      return err(
        new GpuDrivenPreparationError('resource-not-ready', {
          reason: 'material-resource-missing',
          owner: 'material',
          expected: 'the retained ProbeBlend record page for every scene-index probe draw',
          actual: 'the prepared frame did not publish its ProbeBlend record page',
          recovery: 'retry-same-draw',
        }),
      );
    }
    if (shadowArtifactChanged) {
      // ShadowViewStatePool's cache token is light/view scoped and cannot see
      // a material publication replacement. Drop the retained projections at
      // the same boundary as the main PSO cache so a cache hit cannot replay
      // the previous shadow program or BGL with the new receipt.
      this.shadowBatchProjections.clear();
      this.shadowBatchProjectionSource = undefined;
      this.shadowViews?.invalidate('artifact-changed');
    }
    // Mesh geometry can change under an unchanged draw; retained depth cannot prove otherwise.
    if (this.shadowMeshResidencyEpoch !== input.meshResidencyEpoch) {
      if (this.shadowMeshResidencyEpoch !== undefined)
        this.shadowViews?.invalidate('content-changed');
      this.shadowMeshResidencyEpoch = input.meshResidencyEpoch;
    }
    if (this.committedArtifactSignature !== artifactSignature) {
      this.materialRaster?.invalidatePipelineCache();
      this.skinRaster?.invalidatePipelineCache();
    }
    if (this.materialRaster === undefined) {
      const created = MaterialAbiRasterAdapter.create({
        device: this.device,
        pipelineState: materialPipelineState,
        artifact: representativeArtifact,
        visibleBuffer,
        ...(input.materialPipelineFactory === undefined
          ? {}
          : { pipelineFactory: input.materialPipelineFactory }),
        ...(input.probeBlendRecordBuffer === undefined
          ? {}
          : { probeBlendRecordBuffer: input.probeBlendRecordBuffer }),
      });
      if (!created.ok) return created;
      this.materialRaster = created.value;
    } else {
      const probe = this.materialRaster.ensureProbeBlendRecordBuffer(input.probeBlendRecordBuffer);
      if (!probe.ok) return probe;
      const rebound = this.materialRaster.ensureVisibleBuffer(visibleBuffer);
      if (!rebound.ok) return rebound;
    }
    const materialRaster = this.materialRaster;
    if (materialRaster === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'material ABI raster adapter after prepared artifact admission',
          hint: 'keep the selected material artifact and PipelineState on one frame identity',
        }),
      );
    }
    const skinBatch = filtered.batches.find(
      ({ batch }) => batch.prepared?.identity.deformation === 'skin',
    );
    if (skinBatch !== undefined) {
      const skinPrimitive = skinBatch.batch.candidates[0]?.primitiveIndex;
      const skinSnapshot =
        skinPrimitive === undefined ? undefined : scene.slotAt(skinPrimitive)?.snapshot.skin;
      const skinAllocator = materialPipelineState.skinPaletteAllocator;
      const selectedSkinArtifact = skinArtifact ?? skinBatch.artifact;
      if (
        selectedSkinArtifact === undefined ||
        skinSnapshot === undefined ||
        skinAllocator === null ||
        skinAllocator === undefined
      ) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'skinned material artifact and persistent palette owner',
            hint: 'keep missing skin producer resources on the CPU deformation path',
          }),
        );
      }
      if (this.skinRaster === undefined) {
        const created = MaterialAbiRasterAdapter.create({
          device: this.device,
          pipelineState: materialPipelineState,
          artifact: selectedSkinArtifact,
          visibleBuffer,
          deformation: 'skin',
          paletteBuffer: skinSnapshot.buffer,
          paletteBindingWindowBytes: skinAllocator.bindingWindowBytes,
          sharedSurfaceFrame: materialRaster.surfaceDynamicSharedFrameState,
          ...(input.probeBlendRecordBuffer === undefined
            ? {}
            : { probeBlendRecordBuffer: input.probeBlendRecordBuffer }),
          ...(input.materialPipelineFactory === undefined
            ? {}
            : { pipelineFactory: input.materialPipelineFactory }),
        });
        if (!created.ok) return created;
        this.skinRaster = created.value;
      } else {
        const probe = this.skinRaster.ensureProbeBlendRecordBuffer(input.probeBlendRecordBuffer);
        if (!probe.ok) return probe;
        const rebound = this.skinRaster.ensureVisibleBuffer(visibleBuffer);
        if (!rebound.ok) return rebound;
        const palette = this.skinRaster.ensurePaletteBuffer(
          skinSnapshot.buffer,
          skinAllocator.bindingWindowBytes,
        );
        if (!palette.ok) return palette;
      }
      if (this.skinPaletteBuffer !== skinSnapshot.buffer) {
        this.skinPaletteBuffer = skinSnapshot.buffer;
        this.shadowBatchProjections.clear();
        this.shadowBatchProjectionSource = undefined;
        this.shadowViews?.invalidateSkinned();
      }
    }
    const skinRaster = this.skinRaster;
    // Visible windows bind the whole GPU Scene instance and primitive tables;
    // rebinding follows table growth, never per-frame row content.
    const sceneRowCapacity = input.scene.scene.rowCapacity;
    for (const sceneRaster of [materialRaster, skinRaster]) {
      sceneRaster?.ensureSceneTables(
        input.scene.scene.instanceBuffer,
        sceneRowCapacity * GPU_SCENE_LAYOUTS.instance.stride,
        input.scene.scene.primitiveBuffer,
        sceneRowCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
        view.visibleSurfaceRowsBuffer,
      );
    }
    if (this.surfaceSubmission !== undefined) {
      const surfaceFrameRangesResult = this.resolveSurfaceFrameRanges(
        filtered,
        input.surfaceDynamicInput,
        input.scene,
      );
      if (!surfaceFrameRangesResult.ok) return surfaceFrameRangesResult;
      const surfaceFrameProjection = surfaceFrameRangesResult.value;
      const surfaceFrameRanges = surfaceFrameProjection.ranges;
      // Frame rows are keyed by GPU Scene instance row and bound whole.
      const surfaceFrameCapacity = Math.max(
        input.scene.scene.rowCapacity,
        surfaceFrameProjection.capacity,
      );
      const surfaceInput = materialRaster.ensureSurfaceDynamicInput(
        input.surfaceDynamicInput,
        surfaceFrameCapacity,
        input.surfaceDynamicInput?.frameTime ?? input.frameTime ?? 0,
        surfaceDynamicInputLayout,
        input.deviceGeneration ?? 1,
        surfaceFrameRanges,
      );
      if (!surfaceInput.ok) return surfaceInput;
      if (skinRaster !== undefined) {
        const skinSurfaceInput = skinRaster.ensureSurfaceDynamicInput(
          input.surfaceDynamicInput,
          surfaceFrameCapacity,
          input.surfaceDynamicInput?.frameTime ?? input.frameTime ?? 0,
          surfaceDynamicInputLayout,
          input.deviceGeneration ?? 1,
          surfaceFrameRanges,
        );
        if (!skinSurfaceInput.ok) return skinSurfaceInput;
      }
      const committedSurfaceInput = materialRaster.commitSurfaceDynamicInput();
      if (!committedSurfaceInput.ok) return committedSurfaceInput;
      if (skinRaster !== undefined) {
        const committedSkinSurfaceInput = skinRaster.commitSurfaceDynamicInput();
        if (!committedSkinSurfaceInput.ok) return committedSkinSurfaceInput;
      }
      this.rememberSurfaceFrameProjection(
        filtered,
        input.surfaceDynamicInput,
        input.scene,
        surfaceFrameProjection,
      );
    }
    const shadowViewPool = this.shadowViews;
    if (shadowViewPool === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'ShadowViewStatePool after GPU-driven preparation',
          hint: 'publish view-keyed shadow state with the prepared frame',
        }),
      );
    }
    // A pose can change while conservative bounds, allocation and scene rows
    // remain unchanged. Read the palette owner, never optional telemetry.
    const paletteContentRevision = materialPipelineState.skinPaletteAllocator?.contentRevision;
    if (paletteContentRevision !== this.committedPaletteContentRevision)
      shadowViewPool.invalidateSkinned();
    // Visible items address GPU Scene instance rows directly: the vertex
    // stage reads current/previous transforms, temporal flags and material
    // rows from the scene tables, so no per-batch row projection exists.
    if (this.shadowBatchProjectionSource !== shadowFiltered.plan) {
      this.shadowBatchProjections.clear();
      this.shadowBatchProjectionSource = shadowFiltered.plan;
    }
    const sceneIdentity = this.sceneIdentity(scene.scene);
    const viewInspection = view.inspect();
    const liveRaster = this.liveRaster(filtered, scene);
    if (!liveRaster.ok) return liveRaster;
    this.liveRasterBatches = liveRaster.value;
    let signature = this.signatureCache?.value;
    if (
      signature === undefined ||
      this.signatureCache?.filtered !== filtered ||
      this.signatureCache.sceneIdentity !== sceneIdentity ||
      this.signatureCache.viewResourceGeneration !== viewInspection.resourceGeneration ||
      this.signatureCache.meshResidencyEpoch !== input.meshResidencyEpoch
    ) {
      // Resource and capacity facts only: plan revisions, candidate
      // membership, batch windows and LOD regrouping are live data read at
      // encode, so spawn churn and LOD switches reuse the compiled graph
      // (and every shadow target it owns).
      signature = JSON.stringify({
        sceneIdentity,
        meshResidencyEpoch: input.meshResidencyEpoch,
        materialArtifactSignature: artifactSignature,
        viewResourceGeneration: viewInspection.resourceGeneration,
        rasterClasses: [...new Set(liveRaster.value.map(({ classKey }) => classKey))].sort(),
        capacities: [
          viewInspection.candidateCapacity,
          viewInspection.batchCapacity,
          viewInspection.indirectCapacity,
        ],
      });
      this.signatureCache = {
        filtered,
        sceneIdentity,
        viewResourceGeneration: viewInspection.resourceGeneration,
        meshResidencyEpoch: input.meshResidencyEpoch,
        value: signature,
      };
    }
    const shadowTopologySignature = () =>
      this.shadowViews
        ?.inspect()
        .map(
          (entry) =>
            // Cache decisions, logical update generations and source-plan
            // revisions are frame-local producer state. They must not feed
            // the compiled graph key: shadow encode reads the submitted plan
            // and batch projections from the frame, compute dispatch sizes
            // follow the uploaded plan, and a recompile allocates fresh
            // shadow targets that miss every view. Only the view's resource
            // generation (buffer capacity replacement) is a graph dependency.
            `${shadowViewIdentityKey(entry.identity)}:${entry.resourceGeneration}`,
        )
        .join('|') ?? '';
    const production = this;
    const surfaceDynamicInputForCommit =
      this.surfaceSubmission !== undefined && input.surfaceDynamicInput !== undefined
        ? {
            page: input.surfaceDynamicInput.page,
            ranges: this.surfaceFrameRangeCache?.value.consumptionRanges ?? [],
            projectionRevision: input.surfaceDynamicInput.projectionRevision,
          }
        : undefined;
    return ok({
      get topologySignature() {
        const shadow = shadowTopologySignature();
        return shadow.length === 0 ? signature : `${signature}|shadow=${shadow}`;
      },
      ownsAllDrawItems: admission.ownsAllDrawItems,
      worldKeys: scene.worldKeys ?? [],
      ...(input.occlusion === undefined ? {} : { occlusion: input.occlusion }),
      ownsAllShadowCasters,
      drawKeys: filtered.drawKeys,
      shadowDrawKeys: shadowFiltered.shadowDrawKeys,
      ...(this.surfaceSubmission === undefined
        ? {}
        : { surfaceSubmission: this.surfaceSubmission }),
      get shadowDrawKeysByView() {
        return new Map(production.shadowDrawKeysByView);
      },
      standardPbrFrameResources: {
        resourceGeneration: viewInspection.resourceGeneration,
        materialBindGroups: [],
        materialSlotIndicesByEntity: new Map(),
        instancesBindGroup: materialRaster.instancesFrameGroup,
        materialStride: MATERIAL_PER_ENTITY_STRIDE,
        sceneMaterialBuffer: scene.scene.materialBuffer,
        ...(this.surfaceSubmission === undefined
          ? {}
          : {
              surfaceDynamicInput: {
                page: materialRaster.surfaceDynamicInputBuffer,
                frame: materialRaster.surfaceDynamicFrameBuffer,
                sharedFrame: materialRaster.surfaceDynamicSharedFrameBuffer,
                pageBytes: materialRaster.surfaceDynamicInputBufferSize,
                frameBytes: materialRaster.surfaceDynamicFrameBufferSize,
                sharedFrameBytes: materialRaster.surfaceDynamicSharedFrameBufferSize,
              },
              surfaceDirectInstances: (directInput) => {
                const resolved = materialRaster.directSurfaceInstances(directInput);
                if (!resolved.ok) return resolved;
                const firstInstanceOrdinal = directInput.firstInstanceOrdinal ?? 0;
                const memberIds: string[] = [];
                for (let index = 0; index < directInput.instanceCount; index += 1) {
                  const instanceOrdinal = firstInstanceOrdinal + index;
                  const frameRange = this.surfaceFrameRangeCache?.value.ranges.find(
                    ({ directMember }) =>
                      directMember.worldId === directInput.worldId &&
                      directMember.entityKey === directInput.entityKey &&
                      directMember.drawItemIndex === directInput.drawItemIndex &&
                      directMember.instanceOrdinal === instanceOrdinal,
                  );
                  if (frameRange === undefined) {
                    return err(
                      surfaceDynamicInputError(
                        'every direct Surface command resolves the retained public member identity',
                        `rebuild the Surface projection for world=${directInput.worldId}, entity=${directInput.entityKey}, draw=${directInput.drawItemIndex}, instance=${instanceOrdinal}`,
                      ),
                    );
                  }
                  memberIds.push(
                    JSON.stringify([
                      frameRange.directMember.worldIdentity,
                      frameRange.directMember.entityKey,
                      frameRange.directMember.drawItemIndex,
                      frameRange.directMember.instanceOrdinal,
                    ]),
                  );
                }
                return ok({ ...resolved.value, memberIds: Object.freeze(memberIds) });
              },
            }),
      },
      _commitGpuResourceReplacement: () => {
        view._commitResourceReplacement();
      },
      _commitResourceReplacement: () => {
        view._commitResourceReplacement();
        shadowViewPool._commitResourceReplacement();
        this.committedArtifactSignature = artifactSignature;
        this.committedPaletteContentRevision = paletteContentRevision;
        this.submissionState = 'submitted';
        this.lastKnownGoodGeneration = view.inspect().resourceGeneration;
      },
      _abortResourceReplacement: () => {
        materialRaster.abortSurfaceDynamicInput();
        skinRaster?.abortSurfaceDynamicInput();
        shadowViewPool._abortResourceReplacement();
        this.committedArtifactSignature = undefined;
        this.submissionState = 'aborted';
        this.retryCount += 1;
      },
      ...(surfaceDynamicInputForCommit === undefined ||
      surfaceDynamicInputForCommit.ranges.length === 0
        ? {}
        : {
            _consumeSurfaceDynamicInput: (frameNumber: number) =>
              this.consumeSurfaceDynamicInput(
                surfaceDynamicInputForCommit.page,
                surfaceDynamicInputForCommit.ranges,
                surfaceDynamicInputForCommit.projectionRevision,
                frameNumber,
              ),
          }),
      projectShadow: (graph, identity, forceCompute = false) => {
        if (!shadowViewPool.isActive(identity) || shadowViewPool.submission(identity) === undefined)
          return ok(undefined);
        return shadowViewPool.project(graph, identity, forceCompute);
      },
      updateShadowViews: (views) =>
        shadowFiltered.plan.batches.length > 0
          ? this.updateShadowViews(
              views,
              input.shadowMaterialArtifacts,
              shadowFiltered,
              scene,
              input.shadowCasterDrawKeys,
              input.shadowCasterMembership,
              lodProjection,
              preparedPlan,
              input.camera,
              input.capsuleShadowDirectional === true,
            )
          : this.disableShadowViews(),
      shadowViewPool,
      get shadowBatchProjections() {
        return new Map(
          [...production.shadowBatchProjections].map(
            ([key, projections]) => [key, new Map(projections)] as const,
          ),
        );
      },
      project: (
        graph,
        format,
        sampleCount,
        surfaceSubmissionObservation,
        additionalColorFormats,
        lateOcclusion = false,
      ) => {
        this.indirectDrawCount = admittedRasterBatchCount(filtered.plan);
        // The late phase draws from a second indirect region that starts at
        // each command's own firstInstance; without that capability the
        // early phase stays the complete visible set.
        const twoPhase = lateOcclusion && this.device.caps.firstInstanceIndirect === true;
        const outputs = view.addPasses(
          graph,
          'gpu-driven',
          true,
          surfaceSubmissionObservation,
          undefined,
          twoPhase,
        );
        if (!outputs.ok) return outputs;
        let lateIndirectByteOffset: number | undefined;
        const addLateOcclusion =
          outputs.value.addLateOcclusion === undefined
            ? undefined
            : (pyramid: GraphTextureView) => {
                const late = outputs.value.addLateOcclusion?.(pyramid);
                if (late === undefined || !late.ok) return late ?? ok([]);
                lateIndirectByteOffset = late.value.lateIndirectByteOffset;
                return ok(late.value.passNames);
              };
        if (materialRaster !== undefined && filtered.batches.length > 0) {
          let surfacePage: GraphBuffer | undefined;
          let surfaceFrame: GraphBuffer | undefined;
          let surfaceSharedFrame: GraphBuffer | undefined;
          if (this.surfaceSubmission !== undefined) {
            const importedPage = graph.importBuffer(
              'gpu-driven.surface.dynamic-input',
              {
                size: materialRaster.surfaceDynamicInputBufferSize,
                usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
              },
              () => materialRaster.surfaceDynamicInputBuffer,
            );
            if (!importedPage.ok) return importedPage;
            const importedFrame = graph.importBuffer(
              'gpu-driven.surface.frame-input',
              {
                size: materialRaster.surfaceDynamicFrameBufferSize,
                usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
              },
              () => materialRaster.surfaceDynamicFrameBuffer,
            );
            if (!importedFrame.ok) return importedFrame;
            const importedSharedFrame = graph.importBuffer(
              'gpu-driven.surface.shared-frame-input',
              {
                size: materialRaster.surfaceDynamicSharedFrameBufferSize,
                usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
              },
              () => materialRaster.surfaceDynamicSharedFrameBuffer,
            );
            if (!importedSharedFrame.ok) return importedSharedFrame;
            surfacePage = importedPage.value;
            surfaceFrame = importedFrame.value;
            surfaceSharedFrame = importedSharedFrame.value;
          }
          const sceneTransformBuffer = scene.scene.transformBuffer;
          const sceneTransformBytes = scene.scene.rowCapacity * GPU_SCENE_LAYOUTS.transform.stride;
          // Raster classes are the compiled graph's resource facts: pipelines,
          // mesh buffers and bind groups. Batch windows, indirect offsets and
          // representatives are live per-frame facts read at encode.
          const standardProjected: Array<{
            readonly artifact: MaterialShaderArtifact;
            readonly mesh: MeshGpuHandles;
            readonly vertex: GraphBuffer;
            readonly index?: GraphBuffer;
            readonly meshBindGroup: BindGroup;
            readonly sceneTransformBuffer: Buffer;
            readonly sceneTransformBytes: number;
            readonly raster: MaterialAbiRasterAdapter;
            readonly deformation: 'rigid' | 'skin';
            readonly clustered: boolean;
            readonly pipelineFor: (
              formats: readonly TextureFormat[],
              selectedArtifact?: MaterialShaderArtifact,
            ) => Result<RenderPipeline, RhiError>;
            readonly temporalPipelineFor: (
              formats: readonly TextureFormat[],
            ) => Result<RenderPipeline, RhiError>;
            readonly coveragePipelineFor: (
              formats: readonly TextureFormat[],
            ) => Result<RenderPipeline, RhiError>;
            readonly gbufferPipelineFor: (
              formats: readonly TextureFormat[],
            ) => Result<RenderPipeline, RhiError>;
            readonly nearestPipelineFor?: (
              formats: readonly TextureFormat[],
            ) => Result<RenderPipeline, RhiError>;
            readonly colorPipelineFor?: (
              formats: readonly TextureFormat[],
            ) => Result<RenderPipeline, RhiError>;
          }> = [];
          const standardAccesses: GraphAccess[] = [
            { resource: outputs.value.primitive, usage: 'storage-read' },
            { resource: outputs.value.instance, usage: 'storage-read' },
            { resource: outputs.value.material, usage: 'storage-read' },
            { resource: outputs.value.visible, usage: 'storage-read' },
            ...(outputs.value.visibleSurfaceRows === undefined
              ? []
              : [
                  {
                    resource: outputs.value.visibleSurfaceRows,
                    usage: 'storage-read' as const,
                  },
                ]),
            { resource: outputs.value.transform, usage: 'storage-read' },
            { resource: outputs.value.indirect, usage: 'indirect-read' },
            ...(surfacePage === undefined
              ? []
              : [{ resource: surfacePage, usage: 'storage-read' as const }]),
            ...(surfaceFrame === undefined
              ? []
              : [{ resource: surfaceFrame, usage: 'storage-read' as const }]),
            ...(surfaceSharedFrame === undefined
              ? []
              : [{ resource: surfaceSharedFrame, usage: 'uniform-read' as const }]),
          ];
          const meshBuffers = new Map<
            MeshGpuHandles,
            { readonly vertex: GraphBuffer; readonly index?: GraphBuffer }
          >();
          const rasterClasses = new Map<string, (typeof standardProjected)[number]>();
          for (const [liveIndex, prepared] of filtered.batches.entries()) {
            const classKey = liveRaster.value[liveIndex]?.classKey;
            if (classKey === undefined || rasterClasses.has(classKey)) continue;
            const deformation = prepared.batch.prepared?.identity.deformation ?? 'rigid';
            const raster = deformation === 'skin' ? skinRaster : materialRaster;
            const artifact = prepared.artifact;
            if (raster === undefined) {
              return err(
                new RhiError({
                  code: 'rhi-not-available',
                  expected: `${deformation === 'skin' ? 'skinned ' : ''}published material ABI raster owner`,
                  hint: 'publish the selected material artifact before entering the GPU lane',
                }),
              );
            }
            // Mesh rows are the shared GPU Scene transform table: visible.x
            // names the scene instance row and the vertex stage resolves the
            // primitive root and instance-local transforms itself.
            const meshBindGroup = raster.sceneMeshBindGroup(
              sceneTransformBuffer,
              sceneTransformBytes,
            );
            if (!meshBindGroup.ok) return meshBindGroup;
            let buffers = meshBuffers.get(prepared.mesh);
            if (buffers === undefined) {
              const vertex = graph.importBuffer(
                `gpu-driven.standard.${prepared.worldKey}.${prepared.batch.key.assetHandle}.vertex`,
                {
                  size: prepared.mesh.vboBytes,
                  usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
                },
                () => prepared.mesh.vertexBuffer.handle,
              );
              if (!vertex.ok) return vertex;
              let index: GraphBuffer | undefined;
              if (prepared.mesh.indexBuffer !== null) {
                const indexHandle = prepared.mesh.indexBuffer;
                const imported = graph.importBuffer(
                  `gpu-driven.standard.${prepared.worldKey}.${prepared.batch.key.assetHandle}.index`,
                  {
                    size: prepared.mesh.iboBytes,
                    usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
                  },
                  () => indexHandle.handle,
                );
                if (!imported.ok) return imported;
                index = imported.value;
              }
              buffers = { vertex: vertex.value, ...(index === undefined ? {} : { index }) };
              meshBuffers.set(prepared.mesh, buffers);
              standardAccesses.push({ resource: buffers.vertex, usage: 'vertex-read' });
              if (buffers.index !== undefined) {
                standardAccesses.push({ resource: buffers.index, usage: 'index-read' });
              }
            }
            const shaderUvSetCount = isCanonicalStandardPbrMaterialShader(artifact.material)
              ? materialPipelineState.standardPbrShaderUvSetCount
              : (artifact.uvSetCount ?? materialPipelineState.standardPbrShaderUvSetCount);
            const stripIndexFormat =
              prepared.batch.key.drawKind === 'indexed' &&
              (prepared.batch.key.topology === 'line-strip' ||
                prepared.batch.key.topology === 'triangle-strip')
                ? prepared.mesh.indexFormat
                : undefined;
            // A projected batch outlives one frame and its raster pipeline is
            // independent of camera/view constants. MaterialAbiRasterAdapter
            // already caches the final pipeline, but entering it still derives
            // the vertex layout and builds the complete cache key. Keep the
            // successful projection beside this graph batch so steady and
            // moving-camera frames both skip that repeated CPU work. The key
            // mirrors every selected-artifact field that can alter the final
            // pipeline; graph retirement bounds the cache lifetime.
            const projectedPipelines = new Map<string, RenderPipeline>();
            const pipelineFor = (
              formats: readonly TextureFormat[],
              selectedArtifact: MaterialShaderArtifact = artifact,
              coverageOnly = false,
            ): Result<RenderPipeline, RhiError> => {
              const receipt = selectedArtifact.receipt;
              const selectedUvSetCount = isCanonicalStandardPbrMaterialShader(
                selectedArtifact.material,
              )
                ? shaderUvSetCount
                : (selectedArtifact.uvSetCount ?? shaderUvSetCount);
              const projectionKey = [
                formats.join(','),
                selectedArtifact.material,
                selectedArtifact.layoutIdentity,
                receipt?.receiptIdentity ?? '',
                receipt?.generation ?? 0,
                selectedArtifact.variantSet ?? '',
                materialArtifactProgramIdentity(selectedArtifact),
                selectedArtifact.vertexEntry ?? receipt?.sceneIndexEntry ?? '',
                selectedArtifact.fragmentEntry ?? '',
                selectedUvSetCount,
              ].join('|');
              const projected = projectedPipelines.get(projectionKey);
              if (projected !== undefined) return ok(projected);
              const selected = raster.pipeline(
                formats[0] ?? format,
                sampleCount,
                prepared.mesh.layoutProjection,
                // The producer receipt owns the selected shader's UV ABI. The
                // Standard count is only a fallback for legacy synthetic
                // fixtures; using it for a custom program would add aliases
                // the shader never declares (or omit a declared custom set).
                shaderUvSetCount,
                prepared.batch.key.topology,
                stripIndexFormat,
                selectedArtifact.fragmentEntry === 'fs_temporal'
                  ? geometryRenderStateForPass(prepared.renderState, 'temporal', coverageOnly)
                  : prepared.renderState,
                selectedArtifact,
                formats.slice(1),
                prepared.standardTextureMask,
              );
              if (selected.ok) projectedPipelines.set(projectionKey, selected.value);
              return selected;
            };
            const initialPipeline = pipelineFor([format, ...(additionalColorFormats ?? [])]);
            if (!initialPipeline.ok) return initialPipeline;
            // A fragment entry is part of the retained graph projection, not a
            // per-encode artifact. Keep one identity so the pipeline/ABI lookup
            // can be reused across moving-camera frames and G-buffer draws.
            const pipelineForFragment = (fragmentEntry: string, coverageOnly = false) => {
              const selectedArtifact = {
                ...artifact,
                fragmentEntry,
                ...(fragmentEntry === 'fs_temporal' ? { vertexEntry: 'vs_temporal' } : {}),
                ...(coverageOnly
                  ? { variantSet: variantSetForCoveragePass(artifact.variantSet, true) ?? '' }
                  : {}),
              };
              return (formats: readonly TextureFormat[]) =>
                pipelineFor(formats, selectedArtifact, coverageOnly);
            };
            const gbufferPipelineFor = pipelineForFragment('fs_gbuffer');
            const temporalPipelineFor = pipelineForFragment('fs_temporal');
            // Output-domain TAAU coverage reuses the culled/LOD-selected
            // indirect rows; only the binary variant and depth writes differ.
            const coveragePipelineFor = pipelineForFragment('fs_temporal', true);
            let nearestPipelineFor:
              | ((formats: readonly TextureFormat[]) => Result<RenderPipeline, RhiError>)
              | undefined;
            let colorPipelineFor:
              | ((formats: readonly TextureFormat[]) => Result<RenderPipeline, RhiError>)
              | undefined;
            if (isSingleLayerMediumArtifact(artifact)) {
              nearestPipelineFor = pipelineForFragment('fs_nearest_layer');
              colorPipelineFor = pipelineForFragment('fs_color');
            }
            const projectedClass = {
              artifact,
              mesh: prepared.mesh,
              ...buffers,
              pipelineFor,
              gbufferPipelineFor,
              temporalPipelineFor,
              coveragePipelineFor,
              ...(nearestPipelineFor === undefined ? {} : { nearestPipelineFor }),
              ...(colorPipelineFor === undefined ? {} : { colorPipelineFor }),
              meshBindGroup: meshBindGroup.value,
              sceneTransformBuffer,
              sceneTransformBytes,
              raster,
              deformation,
              clustered:
                artifact.program.group2 === 'cluster' || artifact.program.group2 === 'skin-cluster',
            };
            standardProjected.push(projectedClass);
            rasterClasses.set(classKey, projectedClass);
          }
          if (standardProjected.length === 0) {
            return err(
              new RhiError({
                code: 'internal-error',
                expected: 'one material ABI raster class for the eligible batches',
                hint: 'repair the receipt-backed batch projection before encoding the frame',
              }),
            );
          }
          return ok({
            accesses: standardAccesses,
            ...(addLateOcclusion === undefined ? {} : { addLateOcclusion }),
            encode: (
              viewBindGroup,
              pass,
              resources: GraphResourceResolver,
              frameResources: GpuDrivenStandardPbrFrameResources,
              filter,
              fragmentEntryPoint,
              coverageOnly = false,
              phase = 'all',
            ) => {
              let regionOffset = 0;
              if (phase === 'late') {
                if (lateIndirectByteOffset === undefined) {
                  throw new RhiError({
                    code: 'internal-error',
                    expected: 'addLateOcclusion(...) before a late-phase GPU-driven encode',
                    hint: 'add the late HZB cull between the early and late geometry passes',
                  });
                }
                regionOffset = lateIndirectByteOffset;
              }
              // The shared Standard view BGL carries two dynamic buffers:
              // the frame view UBO and the per-frame shadow/light table. GPU
              // indirect draws use the same zero offsets as direct draws;
              // supplying only one offset makes Dawn reject the command
              // buffer before the indirect work can reach the rasterizer.
              pass.setBindGroup(0, viewBindGroup, [0, 0]);
              let currentPipeline: RenderPipeline | undefined;
              let currentVertex: GraphBuffer | undefined;
              let currentIndex: GraphBuffer | undefined;
              for (const live of production.liveRasterBatches) {
                if (live.batch.visibleCapacity === 0) continue;
                const batch = rasterClasses.get(live.classKey);
                if (batch === undefined) {
                  throw new RhiError({
                    code: 'internal-error',
                    expected: `compiled raster class for live GPU batch ${live.batch.batchId}`,
                    hint: 'derive the graph signature from the same raster class set as the live batches',
                  });
                }
                if (
                  fragmentEntryPoint === 'fs_temporal' &&
                  (!isStandardPbrMaterialShader(batch.artifact.material) ||
                    batch.deformation !== 'rigid' ||
                    (live.batch.lod?.coverages.length ?? 0) <= 1)
                )
                  continue;
                const isMedium = isSingleLayerMediumArtifact(batch.artifact);
                if (
                  (filter === 'single-layer-medium' && !isMedium) ||
                  ((filter === 'opaque' ||
                    filter === 'deferred-opaque' ||
                    filter === 'forward-only-opaque') &&
                    isMedium) ||
                  (filter === 'deferred-opaque' && live.batch.key.materialPass !== 'deferred') ||
                  (filter === 'forward-only-opaque' && live.batch.key.materialPass === 'deferred')
                ) {
                  continue;
                }
                const slotsByEntity = frameResources.materialSlotIndicesByEntity;
                let globalMaterialSlot =
                  slotsByEntity.size === 0 ? live.batch.key.materialSlot : undefined;
                for (const entityKey of live.materialEntityKeys) {
                  if (globalMaterialSlot !== undefined) break;
                  globalMaterialSlot = slotsByEntity.get(entityKey)?.[live.batch.key.materialSlot];
                }
                // No candidate reached this frame's material producer, so the
                // view admitted none of them and the indirect count is zero.
                if (globalMaterialSlot === undefined) continue;
                if (
                  frameResources.selectedMaterialSlots !== undefined &&
                  !frameResources.selectedMaterialSlots.has(globalMaterialSlot)
                )
                  continue;
                const pipelineFor =
                  fragmentEntryPoint === 'fs_temporal'
                    ? coverageOnly
                      ? batch.coveragePipelineFor
                      : batch.temporalPipelineFor
                    : fragmentEntryPoint === 'fs_gbuffer'
                      ? batch.gbufferPipelineFor
                      : fragmentEntryPoint === 'fs_nearest_layer'
                        ? (batch.nearestPipelineFor ?? batch.pipelineFor)
                        : fragmentEntryPoint === 'fs_color'
                          ? (batch.colorPipelineFor ?? batch.pipelineFor)
                          : batch.pipelineFor;
                const selectedPipeline = pipelineFor(
                  frameResources.colorFormats ?? [format, ...(additionalColorFormats ?? [])],
                );
                if (!selectedPipeline.ok) throw selectedPipeline.error;
                if (currentPipeline !== selectedPipeline.value) {
                  pass.setPipeline(selectedPipeline.value);
                  currentPipeline = selectedPipeline.value;
                }
                const materialBindGroup = frameResources.materialBindGroups[globalMaterialSlot];
                if (materialBindGroup === undefined) {
                  throw new RhiError({
                    code: 'rhi-not-available',
                    expected: `material bind group for global slot ${globalMaterialSlot}`,
                    hint: 'keep GPU-driven material selection on the main-pass producer contract',
                  });
                }
                pass.setBindGroup(1, materialBindGroup, [
                  globalMaterialSlot * frameResources.materialStride,
                ]);
                const group2 = resolveGpuDrivenMeshGroup({
                  clustered: batch.clustered,
                  deformation: batch.deformation,
                  meshBindGroup: batch.meshBindGroup,
                  sceneTransformBuffer: batch.sceneTransformBuffer,
                  sceneTransformBytes: batch.sceneTransformBytes,
                  frameResources,
                  skinPaletteBinding: batch.raster.skinPaletteBinding(),
                });
                if (group2 === undefined) {
                  throw new RhiError({
                    code: 'rhi-not-available',
                    expected: 'clustered Standard group(2) BindGroup for GPU-driven batch',
                    hint: 'publish the frame-owned cluster lighting resources before indirect encode',
                  });
                }
                pass.setBindGroup(2, group2, batch.deformation === 'skin' ? [0, 0, 0] : [0]);
                if (currentVertex !== batch.vertex) {
                  const vertex = resources.buffer(batch.vertex);
                  if (!vertex.ok) throw vertex.error;
                  pass.setVertexBuffer(0, vertex.value);
                  currentVertex = batch.vertex;
                }
                if (batch.index !== undefined && currentIndex !== batch.index) {
                  const index = resources.buffer(batch.index);
                  if (!index.ok) throw index.error;
                  pass.setIndexBuffer(index.value, batch.mesh.indexFormat);
                  currentIndex = batch.index;
                }
                const indirect = resources.buffer(outputs.value.indirect);
                if (!indirect.ok) throw indirect.error;
                // One indirect command per LOD level slot: the GPU cull
                // compacts each member into its selected level's segment.
                const levelStride = batchLevelStride(live.batch);
                const levelCount = batchLodLevelCount(live.batch);
                for (let level = 0; level < levelCount; level += 1) {
                  const commandOffset =
                    regionOffset +
                    live.batch.indirectOffset +
                    level * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
                  const visibleWindow = batch.raster.visibleWindowBindGroup(
                    live.batch.visibleBase + level * levelStride,
                    live.batch.visibleCapacity,
                  );
                  if (!visibleWindow.ok) throw visibleWindow.error;
                  pass.setBindGroup(3, visibleWindow.value);
                  if (live.batch.key.drawKind === 'indexed') {
                    pass.drawIndexedIndirect(indirect.value, commandOffset);
                  } else {
                    pass.drawIndirect(indirect.value, commandOffset);
                  }
                  const surfacePass =
                    isMedium && fragmentEntryPoint === 'fs_nearest_layer'
                      ? 'nearest-layer'
                      : isMedium && fragmentEntryPoint === 'fs_color'
                        ? 'color'
                        : undefined;
                  if (surfacePass !== undefined) {
                    frameResources.surfaceSubmissionObservation?.record(surfacePass, {
                      kind:
                        live.batch.key.drawKind === 'indexed'
                          ? 'draw-indexed-indirect'
                          : 'draw-indirect',
                      indirectBufferIdentity: getOpaqueResourceIdentity(indirect.value as object),
                      indirectOffset: commandOffset,
                      pipelineIdentity: getOpaqueResourceIdentity(selectedPipeline as object),
                      ...(batch.artifact.receipt === undefined
                        ? {}
                        : {
                            receiptIdentity: batch.artifact.receipt.receiptIdentity,
                            receiptGeneration: batch.artifact.receipt.generation,
                          }),
                    });
                  }
                  this.encodedIndirectDraws += 1;
                }
              }
            },
          });
        }
        return err(
          new RhiError({
            code: 'internal-error',
            expected: 'material ABI raster projection branch',
            hint: 'preserve the selected-artifact branch as the only raster owner',
          }),
        );
      },
    });
  }

  /**
   * Retained ownership inputs keep their identity across unchanged frames, so
   * the signature and expected-key set are derived only when the identity
   * changes. A new identity with equal content keeps the previous signature
   * and therefore the previous shadow plan.
   */
  /**
   * Re-derive only source batches whose `(generation, contentEpoch)` or
   * resident meshes moved. Every other input is global: any change drops the
   * whole per-batch memo. Artifacts compare by program signature, since hosts
   * re-resolve equal fallbacks as fresh objects.
   */
  /** Bind each filtered batch to its raster class and material representative. */
  private liveRaster(
    filtered: FilteredProductionPlan,
    scene: PersistentGpuDrivenState,
  ): Result<readonly LiveRasterBatch[], RhiError> {
    const cached = this.liveRasterCache;
    if (cached?.filtered === filtered) return ok(cached.value);
    const value: LiveRasterBatch[] = [];
    for (const prepared of filtered.batches) {
      const materialEntityKeys: number[] = [];
      let previous = -1;
      for (const candidate of prepared.batch.candidates) {
        if (candidate.primitiveIndex === previous) continue;
        previous = candidate.primitiveIndex;
        const slot = scene.slotAt(candidate.primitiveIndex);
        if (slot === undefined) {
          return err(
            new RhiError({
              code: 'internal-error',
              expected: 'batch candidate entity for global material slot projection',
              hint: 'preserve the retained scene identity when projecting the GPU batch',
            }),
          );
        }
        materialEntityKeys.push(worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey));
      }
      value.push({
        batch: prepared.batch,
        classKey: rasterClassKey(prepared),
        materialEntityKeys,
      });
    }
    const frozen = Object.freeze(value);
    this.liveRasterCache = { filtered, value: frozen };
    return ok(frozen);
  }

  private assemblePrepared(
    scene: PersistentGpuDrivenState,
    meshBySlot: ReadonlyMap<number, MeshGpuHandles>,
    meshResidencyEpoch: number,
    materialArtifact: MaterialShaderArtifact | undefined,
    skinArtifact: MaterialShaderArtifact | undefined,
    materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
    materialArtifactSignature: string,
  ): PreparedProductionPlan {
    const previous = this.preparedCache;
    const sameInputs =
      previous !== undefined &&
      previous.slotAt === scene.slotAt &&
      previous.worldKeys === scene.worldKeys &&
      previous.scene === scene.scene &&
      previous.meshResidencyEpoch === meshResidencyEpoch &&
      previous.materialArtifactSignature === materialArtifactSignature;
    if (!sameInputs) this.preparedBatches.clear();
    const inputs: PreparationInputs = {
      slotAt: scene.slotAt,
      meshBySlot,
      worldKeys: scene.worldKeys,
      materialArtifact,
      skinArtifact,
      materialArtifacts,
    };
    const live = new Set<number>();
    let rebuiltBatches = 0;
    let rebuiltCandidates = 0;
    const batchRows = scene.plan.batches.map((batch) => {
      live.add(batch.batchId);
      const cached = this.preparedBatches.get(batch.batchId);
      if (
        cached !== undefined &&
        cached.generation === batch.generation &&
        cached.contentEpoch === batch.contentEpoch &&
        sameBatchMeshes(cached.value, meshBySlot)
      ) {
        if (cached.value.source === batch) return cached.value;
        // Only the aligned visible window moved; rows keep their facts.
        const rebased = Object.freeze({
          ...cached.value,
          source: batch,
          rows: Object.freeze(
            cached.value.rows.map((row) => Object.freeze({ ...row, source: batch })),
          ),
        });
        this.preparedBatches.set(batch.batchId, { ...cached, value: rebased });
        return rebased;
      }
      const value = prepareBatchRows(batch, inputs);
      this.preparedBatches.set(batch.batchId, {
        generation: batch.generation,
        contentEpoch: batch.contentEpoch,
        value,
      });
      rebuiltBatches += 1;
      rebuiltCandidates += batch.candidates.length;
      return value;
    });
    for (const batchId of this.preparedBatches.keys()) {
      if (!live.has(batchId)) this.preparedBatches.delete(batchId);
    }
    this.preparedBatchBuilds += rebuiltBatches;
    this.planRebuildBatches = rebuiltBatches;
    this.planRebuildCandidates = rebuiltCandidates;
    if (
      sameInputs &&
      previous.plan === scene.plan &&
      batchRows.every((rows, index) => rows === previous.batchRows[index])
    ) {
      return previous.value;
    }
    this.gpuOwnedSnapshotsMaterialized = scene.slots.length;
    const value = assemblePreparedPlan(scene.plan, batchRows, scene.slots, scene.worldKeys);
    this.preparedCache = {
      plan: scene.plan,
      slotAt: scene.slotAt,
      worldKeys: scene.worldKeys,
      scene: scene.scene,
      meshResidencyEpoch,
      materialArtifactSignature,
      batchRows,
      value,
    };
    return value;
  }

  private shadowOwnershipSource(
    drawKeys: ReadonlySet<string> | undefined,
    membership: readonly ShadowCasterMembership[] | undefined,
  ): ShadowOwnershipSource {
    const cached = this.shadowOwnershipCache;
    if (cached !== undefined && cached.drawKeys === drawKeys && cached.membership === membership) {
      return cached;
    }
    const signature = shadowCasterMembershipSignature(drawKeys, membership);
    const casterKeys =
      cached !== undefined && cached.signature === signature
        ? cached.casterKeys
        : membership === undefined
          ? drawKeys
          : new Set(
              membership.map((entry) =>
                gpuDrivenShadowDrawKey(
                  entry.worldEntity,
                  entry.materialHandle,
                  entry.drawItemIndex,
                  entry.passIndex,
                ),
              ),
            );
    const source: ShadowOwnershipSource = {
      drawKeys,
      membership,
      signature,
      casterKeys,
      ownsAllFor: cached?.signature === signature ? cached.ownsAllFor : undefined,
      ownsAll: cached?.signature === signature ? cached.ownsAll : false,
      claims:
        drawKeys === undefined && membership === undefined
          ? undefined
          : new ShadowClaimTable(
              drawKeys,
              membership,
              buildShadowMembershipIndex(drawKeys, membership),
            ),
    };
    this.shadowOwnershipCache = source;
    return source;
  }

  updateShadowViews(
    views: readonly Omit<ShadowViewUpdateInput, 'sourcePlan' | 'scene'>[],
    shadowMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
    filtered: FilteredProductionPlan,
    scene: PersistentGpuDrivenState,
    shadowCasterDrawKeys: ReadonlySet<string> | undefined,
    shadowCasterMembership: readonly ShadowCasterMembership[] | undefined,
    lod: LodProjectionState,
    lodPrepared: Parameters<typeof shadowLodProjectionState>[0],
    lodCamera: LodViewCamera,
    capsuleShadowDirectional: boolean,
  ): Result<void, RhiError> {
    // A light view ranks casters by their footprint in its own projection,
    // bounded by the main camera; a view without a matrix follows the main
    // camera. Views sharing a matrix (static and dynamic layers) share one
    // projection.
    const lodByMatrix = new Map<string, Partial<ShadowViewUpdateInput>>();
    const shadowViewLod = (matrix: Float32Array | undefined): Partial<ShadowViewUpdateInput> => {
      if (lod.projectedHeights === undefined) return { lodCamera };
      if (matrix === undefined) {
        return {
          lodCamera,
          lodProjectedHeights: lod.projectedHeights,
          lodSelection: lod.selectionFingerprint,
        };
      }
      const key = matrix.join(',');
      const cached = lodByMatrix.get(key);
      if (cached !== undefined) return cached;
      const projection = shadowLodProjectionState(lodPrepared, matrix, lod, scene.slotAt);
      const entry: Partial<ShadowViewUpdateInput> = {
        lodCamera: lodViewCameraFromMatrix(matrix),
        lodClampCamera: lodCamera,
        ...(projection.projectedHeights === undefined
          ? {}
          : {
              lodProjectedHeights: projection.projectedHeights,
              lodSelection: projection.selectionFingerprint,
            }),
      };
      lodByMatrix.set(key, entry);
      return entry;
    };
    if (
      this.shadowViews === undefined ||
      this.shadowSourcePlan === undefined ||
      this.shadowScene === undefined
    ) {
      return ok(undefined);
    }
    const nextProjections = new Map<string, ReadonlyMap<number, GpuDrivenShadowBatchProjection>>();
    const nextShadowDrawKeysByView = new Map<string, ReadonlySet<string>>();
    const materialRaster = this.materialRaster;
    if (materialRaster === undefined) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'material ABI raster adapter for shadow projection',
          hint: 'prepare the selected-artifact raster owner before updating shadow views',
        }),
      );
    }
    const ownership = this.shadowOwnershipSource(shadowCasterDrawKeys, shadowCasterMembership);
    const shadowClaims = ownership.claims;
    const shadowMembershipIndex = shadowClaims?.index;
    const preparedByBatch = new Map(filtered.batches.map((entry) => [entry.batch.batchId, entry]));
    const sceneTransformBuffer = scene.scene.transformBuffer;
    const sceneTransformBytes = scene.scene.rowCapacity * GPU_SCENE_LAYOUTS.transform.stride;
    const shadowViews = this.shadowViews;
    const shadowSourcePlan = this.shadowSourcePlan;
    const shadowScene = this.shadowScene;
    const classes = this.shadowCasterClasses.update(
      scene.slots,
      shadowScene,
      capsuleShadowDirectional,
    );
    const projectView = (
      input: Omit<ShadowViewUpdateInput, 'sourcePlan' | 'scene'>,
      inheritedClaims: ReadonlySet<string> | undefined,
      inheritedSource: ReadonlySet<string> | undefined,
    ): Result<ShadowViewUpdate['cache'], RhiError> => {
      const viewLod = shadowViewLod(input.matrix);
      const updated = shadowViews.update({
        ...input,
        sourcePlan: shadowSourcePlan,
        scene: shadowScene,
        ...viewLod,
      });
      if (!updated.ok) return updated;
      const identityKey = shadowViewIdentityKey(input.identity);
      const previousProjections = this.shadowBatchProjections.get(identityKey);
      const previousClaims = this.shadowDrawKeysByView.get(identityKey);
      // A hit may adopt a new plan whose changes miss the retained depth; its
      // claims and projections still follow the adopted plan.
      if (
        updated.value.cache === 'hit' &&
        previousProjections !== undefined &&
        previousClaims !== undefined &&
        this.shadowProjectedPlans.get(previousProjections) === updated.value.plan &&
        inheritedClaims === inheritedSource
      ) {
        nextShadowDrawKeysByView.set(identityKey, previousClaims);
        nextProjections.set(identityKey, previousProjections);
        return ok('hit');
      }
      const viewClaimedKeys = new Set<string>();
      for (const batch of updated.value.plan.batches) {
        for (const candidate of batch.candidates) {
          const slot = scene.slotAt(candidate.primitiveIndex);
          if (slot === undefined) continue;
          const claim = shadowClaims?.claim(slot, candidate);
          if (claim === undefined || !claim.compatible) continue;
          for (const key of claim.keys) {
            if (filtered.shadowDrawKeys.has(key)) viewClaimedKeys.add(key);
          }
        }
      }
      for (const key of inheritedClaims ?? []) viewClaimedKeys.add(key);
      nextShadowDrawKeysByView.set(identityKey, Object.freeze(viewClaimedKeys));
      const submission = shadowViews.submission(input.identity);
      const visibleBuffer = submission?.view.visibleBuffer;
      if (submission === undefined || visibleBuffer === undefined) {
        return err(
          new RhiError({
            code: 'internal-error',
            expected: 'shadow view visible buffer after update',
            hint: 'publish the per-view visible window before recording indirect shadow draws',
          }),
        );
      }
      const projections = new Map<number, GpuDrivenShadowBatchProjection>();
      for (const batch of submission.plan.batches) {
        const prepared = preparedByBatch.get(batch.batchId);
        if (prepared === undefined) {
          return err(
            new RhiError({
              code: 'internal-error',
              expected: `prepared shadow mesh batch ${batch.batchId}`,
              hint: 'keep filtered shadow topology and per-view projection on one frame identity',
            }),
          );
        }
        const deformation = batch.prepared?.identity.deformation ?? 'rigid';
        const raster = deformation === 'skin' ? this.skinRaster : materialRaster;
        const batchArtifact = prepared.artifact;
        const shadowArtifact = shadowArtifactForPreparedBatch(
          batch,
          shadowMaterialArtifacts,
          batchArtifact,
        );
        if (raster === undefined || batchArtifact === undefined || shadowArtifact === undefined) {
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: `${deformation === 'skin' ? 'skinned ' : ''}selected shadow MaterialProgramAbi artifact`,
              hint: 'publish a matching shadow-pass program before entering the capable shadow lane',
            }),
          );
        }
        const meshBindGroup = raster.sceneMeshBindGroup(sceneTransformBuffer, sceneTransformBytes);
        if (!meshBindGroup.ok) return meshBindGroup;
        const visibleBindGroups: BindGroup[] = [];
        const levelStride = batchLevelStride(batch);
        for (let level = 0; level < batchLodLevelCount(batch); level += 1) {
          const visibleBindGroup = raster.shadowVisibleWindowBindGroupForBuffer(
            visibleBuffer,
            batch.visibleBase + level * levelStride,
            batch.visibleCapacity,
          );
          if (!visibleBindGroup.ok) return visibleBindGroup;
          visibleBindGroups.push(visibleBindGroup.value);
        }
        const firstCandidate = batch.candidates[0];
        const firstSlot =
          firstCandidate === undefined ? undefined : scene.slotAt(firstCandidate.primitiveIndex);
        const material =
          firstSlot?.snapshot.materials[batch.key.materialSlot] ?? firstSlot?.snapshot.material;
        if (firstSlot === undefined || material === undefined) {
          return err(
            new RhiError({
              code: 'internal-error',
              expected: `material snapshot for shadow batch ${batch.batchId}`,
              hint: 'keep the GPU-driven shadow material projection aligned with the retained slot',
            }),
          );
        }
        const firstWorldEntity = worldEntityKey(
          firstSlot.snapshot.worldId,
          firstSlot.snapshot.entityKey,
        );
        const shadowEntry =
          firstCandidate === undefined
            ? undefined
            : shadowMembershipIndex?.get(
                gpuDrivenDrawKey(
                  firstWorldEntity,
                  material.materialHandle ?? -1,
                  firstCandidate.drawItemIndex,
                ),
              )?.memberships[0];
        projections.set(batch.batchId, {
          mesh: prepared.mesh,
          meshBindGroup: meshBindGroup.value,
          visibleBindGroups,
          deformation,
          shadowArtifact,
          ...(shadowEntry?.renderState === undefined
            ? {}
            : { shadowRenderState: shadowEntry.renderState }),
          ...(shadowEntry?.vertexEntry === undefined
            ? {}
            : { shadowVertexEntry: shadowEntry.vertexEntry }),
          ...(shadowEntry?.fragmentEntry === undefined
            ? {}
            : { shadowFragmentEntry: shadowEntry.fragmentEntry }),
          material,
          materialEntityKey: worldEntityKey(
            firstSlot.snapshot.worldId,
            firstSlot.snapshot.entityKey,
          ),
          vertexColorAvailable: prepared.mesh.layoutProjection.attributes.some(
            (attribute) => attribute.key === 'color',
          ),
        });
      }
      nextProjections.set(identityKey, projections);
      this.shadowProjectedPlans.set(projections, submission.plan);
      return ok(updated.value.cache);
    };
    const retained: ShadowViewIdentity[] = [];
    for (const input of views) {
      retained.push(input.identity);
      if (!shadowViewHasStaticLayer(input.identity)) {
        const projected = projectView(input, undefined, undefined);
        if (!projected.ok) return projected;
        continue;
      }
      // The static layer holds settled casters and is re-rastered only when
      // one of them changes; the final layer copies it and adds the rest.
      const staticIdentity: ShadowViewIdentity = { ...input.identity, layer: 'static' };
      const viewClasses = restrictShadowCasterClasses(classes, input.candidatePrimitiveIndices);
      retained.push(staticIdentity);
      const staticProjected = projectView(
        {
          ...input,
          identity: staticIdentity,
          candidatePrimitiveIndices: viewClasses.staticSlots,
          ignoredChangeSlots: viewClasses.dynamicSet,
        },
        undefined,
        undefined,
      );
      if (!staticProjected.ok) return staticProjected;
      if (staticProjected.value === 'invalidated') {
        shadowViews.invalidate('static-layer-changed', input.identity);
      }
      const finalProjected = projectView(
        {
          ...input,
          candidatePrimitiveIndices:
            input.identity.kind === 'directional'
              ? viewClasses.directionalDynamicSlots
              : viewClasses.dynamicSlots,
        },
        nextShadowDrawKeysByView.get(shadowViewIdentityKey(staticIdentity)),
        this.shadowDrawKeysByView.get(shadowViewIdentityKey(staticIdentity)),
      );
      if (!finalProjected.ok) return finalProjected;
    }
    shadowViews.retain(retained);
    this.shadowBatchProjections = nextProjections;
    this.shadowDrawKeysByView = nextShadowDrawKeysByView;
    return ok(undefined);
  }

  private disableShadowViews(): Result<void, RhiError> {
    this.shadowViews?.retain([]);
    this.shadowBatchProjections = new Map();
    this.shadowDrawKeysByView = new Map();
    return ok(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view?.dispose();
    this.view = undefined;
    this.materialRaster?.dispose();
    this.materialRaster = undefined;
    this.committedArtifactSignature = undefined;
    this.skinRaster?.dispose();
    this.skinRaster = undefined;
    this.preparedCache = undefined;
    this.filteredCache = undefined;
    this.shadowFilteredCache = undefined;
    this.shadowOwnershipCache = undefined;
    this.surfaceFrameRangeCache = undefined;
    this.consumedSurfaceInput = undefined;
    this.signatureCache = undefined;
    this.validatedResidencyCache = undefined;
    this.cpuValidationTelemetryCache = undefined;
    this.shadowViews?.dispose();
    this.shadowViews = undefined;
    this.shadowSourcePlan = undefined;
    this.shadowScene = undefined;
    this.shadowBatchProjections = new Map();
    this.shadowDrawKeysByView = new Map();
    this.shadowExpectedDrawKeys = EMPTY_SHADOW_KEYS;
    this.shadowBatchProjectionSource = undefined;
    this.skinPaletteBuffer = undefined;
    this.committedPaletteContentRevision = undefined;
    this.preparationFailure = undefined;
    this.surfaceArtifactInspection = undefined;
    this.overflowRecoveryRequired = false;
  }

  inspect(): GpuDrivenProductionInspection {
    const view = this.view?.inspect();
    const filtered = this.filteredCache?.value;
    const resourceAllocation = combineGpuResourceAllocationInspections([
      ...(view === undefined ? [] : [view.resourceAllocation]),
      ...(this.materialRaster === undefined ? [] : [this.materialRaster.resourceAllocation]),
      ...(this.skinRaster === undefined ? [] : [this.skinRaster.resourceAllocation]),
    ]);
    const resourceClasses =
      filtered === undefined
        ? undefined
        : inspectResourceClassSplits({ batches: filtered.batches.map(({ batch }) => batch) });
    const channels: GpuDrivenLaneSummary[] = [];
    const mainTotalDrawCount = this.mainTotalDrawItems;
    const mainClaimedDrawCount = this.telemetryOverflow
      ? 0
      : Math.min(this.gpuOwnedDrawItems, mainTotalDrawCount);
    const mainResidualDrawCount = Math.max(0, mainTotalDrawCount - mainClaimedDrawCount);
    const mainFacts = {
      totalDrawCount: mainTotalDrawCount,
      claimedDrawCount: mainClaimedDrawCount,
      residualDrawCount: mainResidualDrawCount,
    };
    if (mainClaimedDrawCount > 0 || (this.lane !== 'gpu' && this.lane !== 'blocked')) {
      channels.push({
        viewPass: 'main',
        viewIndex: 0,
        lane: this.lane,
        reason: this.laneReason,
        drawCount: mainClaimedDrawCount,
        ...mainFacts,
      });
    }
    if (this.cpuSemanticFallbackDrawItems > 0) {
      channels.push({
        viewPass: 'main',
        viewIndex: 0,
        lane: 'cpu-semantic',
        reason: 'unsupported',
        drawCount: this.cpuSemanticFallbackDrawItems,
        ...mainFacts,
      });
    }
    if (this.cpuDeformationFallbackDrawItems > 0) {
      const reasons =
        this.cpuDeformationReasons.size === 0
          ? ([['resource-not-ready', this.cpuDeformationFallbackDrawItems]] as const)
          : this.cpuDeformationReasons.entries();
      for (const [reason, drawCount] of reasons) {
        channels.push({
          viewPass: 'main',
          viewIndex: 0,
          lane: 'cpu-deformation',
          reason,
          drawCount,
          ...mainFacts,
        });
      }
    }
    if (this.blockedDrawItems > 0) {
      channels.push({
        viewPass: 'main',
        viewIndex: 0,
        lane: 'blocked',
        reason: 'resource-not-ready',
        drawCount: this.blockedDrawItems,
        ...mainFacts,
        ...(this.preparationFailure === undefined ? {} : { failure: this.preparationFailure }),
      });
    }
    for (const entry of this.shadowViews?.inspect() ?? []) {
      // Retained view resources outlive admission. An idle frame has no
      // current GPU projection and must not publish last frame's channels.
      if (this.submissionState === 'idle' || channels.length >= 32) break;
      if (entry.identity.layer !== undefined) continue;
      const key = shadowViewIdentityKey(entry.identity);
      const claimed = this.shadowDrawKeysByView.get(key)?.size ?? 0;
      const total = Math.max(this.shadowExpectedDrawKeys.size, claimed);
      const effectiveClaimed = this.telemetryOverflow ? 0 : Math.min(claimed, total);
      const residual = Math.max(0, total - effectiveClaimed);
      if (total === 0) continue;
      const projected = this.shadowBatchProjections.has(key) && entry.batchCount > 0;
      const viewPass =
        entry.identity.kind === 'directional'
          ? 'directional-shadow'
          : entry.identity.kind === 'point'
            ? 'point-shadow'
            : 'spot-shadow';
      if (projected && effectiveClaimed > 0) {
        channels.push({
          viewPass,
          viewIndex: entry.identity.index,
          ...(entry.identity.face === undefined ? {} : { face: entry.identity.face }),
          lane: this.telemetryOverflow ? 'blocked' : 'gpu',
          reason: this.telemetryOverflow ? 'overflow' : 'none',
          drawCount: effectiveClaimed,
          totalDrawCount: total,
          claimedDrawCount: effectiveClaimed,
          residualDrawCount: residual,
        });
      }
      if (residual > 0) {
        const failure = shadowOwnershipFailureInspection(viewPass);
        channels.push({
          viewPass,
          viewIndex: entry.identity.index,
          ...(entry.identity.face === undefined ? {} : { face: entry.identity.face }),
          lane: 'blocked',
          reason: this.telemetryOverflow ? 'overflow' : 'shadow-ownership',
          drawCount: residual,
          totalDrawCount: total,
          claimedDrawCount: effectiveClaimed,
          residualDrawCount: residual,
          failure,
        });
      }
    }
    return {
      ...(this.surfaceArtifactInspection === undefined
        ? {}
        : { surfaceArtifact: this.surfaceArtifactInspection }),
      residencyValidationScans: this.residencyValidationScans,
      residencyValidationCacheHits: this.residencyValidationCacheHits,
      cpuValidationScans: this.cpuValidationScans,
      cpuValidationCacheHits: this.cpuValidationCacheHits,
      ...this.structureMetrics,
      surfaceFrameRangeBuilds: this.surfaceFrameRangeBuilds,
      surfaceFrameMemberScans:
        this.surfaceFrameRangeMemberScans +
        (this.materialRaster?.surfaceDynamicFrameMemberScans ?? 0) +
        (this.skinRaster?.surfaceDynamicFrameMemberScans ?? 0),
      surfaceFrameRowAllocations:
        (this.materialRaster?.surfaceDynamicFrameRowAllocations ?? 0) +
        (this.skinRaster?.surfaceDynamicFrameRowAllocations ?? 0),
      surfaceFrameTimeWrites: this.materialRaster?.surfaceDynamicFrameTimeWrites ?? 0,
      gpuOwnedSnapshotsMaterialized: this.gpuOwnedSnapshotsMaterialized,
      filteredPlanBuilds: this.filteredPlanBuilds,
      preparedBatchBuilds: this.preparedBatchBuilds,
      filteredBatchBuilds: this.filteredBatchBuilds,
      planRebuildBatches: this.planRebuildBatches,
      planRebuildCandidates: this.planRebuildCandidates,
      lodSelectionChanges: this.lodSelectionChanges,
      shadowCasterFlips: this.shadowCasterClasses.inspect().flips,
      shadowCasterPendingPromotions: this.shadowCasterClasses.inspect().pendingPromotions,
      gpuOwnedEntityCount: this.gpuOwnedEntityCount,
      candidateUploadBytes: view?.candidateUploadBytes ?? 0,
      suppressionUploadBytes: view?.suppressionUploadBytes ?? 0,
      batchUploadBytes: view?.batchUploadBytes ?? 0,
      viewConstantsUploadBytes: view?.viewConstantsUploadBytes ?? 0,
      batchBindGroupCreates: this.batchBindGroupCreates,
      viewBindGroupCreates: view?.bindGroupCreates ?? 0,
      topologyRevision: view?.topologyRevision,
      validatedGpuOwnedRows: this.validatedGpuOwnedRows,
      cpuFallbackDrawItems: this.cpuFallbackDrawItems,
      geometryWork: this.telemetryGeometryWork,
      rootGeometryWork: this.telemetryRootGeometryWork,
      geometryWorkReduction:
        this.telemetryRootGeometryWork > 0
          ? 1 - this.telemetryGeometryWork / this.telemetryRootGeometryWork
          : 0,
      batchCount: view?.batchCount ?? 0,
      indirectDrawCount: this.indirectDrawCount,
      encodedIndirectDraws: this.encodedIndirectDraws,
      channels: Object.freeze(channels.map((channel) => Object.freeze(channel))),
      resourceGeneration: view?.resourceGeneration,
      candidateCapacity: view?.candidateCapacity ?? 0,
      batchCapacity: view?.batchCapacity ?? 0,
      indirectCapacity: view?.indirectCapacity ?? 0,
      overflow: this.telemetryOverflow,
      submitted: this.submissionState === 'submitted',
      recoveryCount: this.recoveryCount,
      retryCount: this.retryCount,
      lastKnownGoodGeneration: this.lastKnownGoodGeneration,
      ...(resourceAllocation === undefined ? {} : { resourceAllocation }),
      resourceAllocationOwners: Object.freeze({
        ...(view === undefined ? {} : { gpuDrivenView: view.resourceAllocation }),
        ...(this.materialRaster === undefined
          ? {}
          : { materialRaster: this.materialRaster.resourceAllocation }),
        ...(this.skinRaster === undefined
          ? {}
          : { skinRaster: this.skinRaster.resourceAllocation }),
      }),
      ...(resourceClasses === undefined
        ? {}
        : {
            resourceClassCount: resourceClasses.resourceClassCount,
            resourceClassSplits: resourceClasses.resourceClassSplits,
            resourceClassSplitReasons: resourceClasses.resourceClassSplitReasons,
          }),
    };
  }

  /** Read renderer-owned LOD counters copied by the last GPU submission. */
  readLodSelection(): Promise<GpuDrivenLodSelectionInspection | undefined> {
    if (!this.telemetryPrepared) return Promise.resolve(undefined);
    const view = this.view;
    const filtered = this.filteredCache?.value;
    const telemetryCandidateCount = this.telemetryCandidateCount;
    if (view === undefined) return Promise.resolve(undefined);
    return view.readLodSelection().then((selection) => {
      // The observer is asynchronous and prepare() may have published a new
      // filtered plan while mapAsync was pending. Do not attach old counters to
      // the new world/primitive cache; the next real copy will be observed on
      // its own generation.
      if (
        !this.telemetryPrepared ||
        this.view !== view ||
        this.filteredCache?.value !== filtered ||
        this.telemetryCandidateCount !== telemetryCandidateCount
      ) {
        return undefined;
      }
      if (selection !== undefined) {
        this.telemetryGeometryWork = selection.geometryWork;
        this.telemetryRootGeometryWork = selection.rootGeometryWork;
        this.telemetryOverflow = selection.overflow;
        if (selection.overflow) {
          if (!this.overflowRecoveryRequired) this.retryCount += 1;
          this.overflowRecoveryRequired = true;
          this.submissionState = 'aborted';
          this.lastKnownGoodGeneration = undefined;
          this.lane = 'blocked';
          this.laneReason = 'overflow';
        }
      }
      if (selection === undefined) return selection;
      if (filtered === undefined) return selection;
      type LodBatchAttribution = {
        readonly batch: GpuDrivenBatch;
        readonly worldKey: number;
        readonly primitiveSlot: number;
        readonly slotGeneration: number;
        readonly artifact?: MaterialShaderArtifact;
      };
      const preparedByBatchId = new Map<number, LodBatchAttribution>(
        filtered.batches.map((prepared) => [
          prepared.batch.batchId,
          {
            batch: prepared.batch,
            worldKey: prepared.worldKey,
            primitiveSlot: prepared.primitiveSlot,
            slotGeneration: prepared.slotGeneration,
            artifact: prepared.artifact,
          },
        ]),
      );
      const projectedCandidateCount =
        telemetryCandidateCount > 0 ? telemetryCandidateCount : selection.candidateCount;
      // Selector-only batches remain in filtered.plan so their GPU counters
      // can describe candidates suppressed from the raster admission lane.
      // They have no PreparedBatch entry because no draw is encoded, but they
      // still need the same World join for receipt attribution. Recover that
      // metadata from the stable primitive slot instead of dropping the whole
      // readback when the first such batch is encountered.
      const slotAt = this.preparedCache?.slotAt;
      const filteredWorldKeys = this.filteredCache?.prepared.worldKeys;
      if (slotAt !== undefined) {
        for (const batch of filtered.plan.batches) {
          if (preparedByBatchId.has(batch.batchId)) continue;
          const candidate = batch.candidates[0];
          const slot = candidate === undefined ? undefined : slotAt(candidate.primitiveIndex);
          if (slot === undefined) continue;
          preparedByBatchId.set(batch.batchId, {
            batch,
            worldKey: filteredWorldKeys?.[slot.snapshot.worldId] ?? slot.snapshot.worldId,
            primitiveSlot: slot.slot,
            slotGeneration: slot.generation,
          });
        }
      }
      const worldSelections = new Map<
        number,
        {
          readonly worldKey: number;
          readonly primitiveSlot: number;
          readonly slotGeneration: number;
          candidateCount: number;
          visible: number;
          occluded: number;
          readonly lodHistogram: Map<number, number>;
        }
      >();
      const lodHistogram = new Map<number, number>();
      // The selector visits the full captured plan, including candidates that
      // the CPU visibility projection suppressed. Use that same plan for the
      // LOD denominator so World attribution cannot fail merely because the
      // two lanes have different frustum scopes.
      let lodCandidateCount = 0;
      let lodVisible = 0;
      for (const batchSelection of selection.batches) {
        const prepared = preparedByBatchId.get(batchSelection.batchId);
        // Selector-only or otherwise non-raster batches remain in the GPU
        // telemetry plan. They have no material producer row and therefore do
        // not invalidate readback evidence for the prepared Surface batches.
        if (prepared === undefined) continue;
        // The GPU selector also visits ordinary GPU-driven meshes so one
        // compact compute path can populate their indirect args. Those rows
        // are level-0 by construction, but they are not LOD candidates and
        // must not enter receipt-bound LOD attribution. Batch topology keeps
        // LOD coverage/ranges in the grouping key, so a batch is expected to
        // be homogeneous; fail closed if a producer violates that invariant
        // instead of guessing a split for aggregate counters.
        const lodCandidateRows =
          (prepared.batch.lod?.coverages.length ?? 0) > 1 ? prepared.batch.candidates : [];
        if (lodCandidateRows.length === 0) continue;
        if (lodCandidateRows.length !== batchSelection.candidateCount) return undefined;
        lodCandidateCount += batchSelection.candidateCount;
        lodVisible += batchSelection.visible;
        for (const row of batchSelection.lodHistogram) {
          lodHistogram.set(row.level, (lodHistogram.get(row.level) ?? 0) + row.count);
        }
        let aggregate = worldSelections.get(prepared.worldKey);
        if (aggregate === undefined) {
          aggregate = {
            worldKey: prepared.worldKey,
            primitiveSlot: prepared.primitiveSlot,
            slotGeneration: prepared.slotGeneration,
            candidateCount: 0,
            visible: 0,
            occluded: 0,
            lodHistogram: new Map(),
          };
          worldSelections.set(prepared.worldKey, aggregate);
        }
        aggregate.candidateCount += batchSelection.candidateCount;
        aggregate.visible += batchSelection.visible;
        aggregate.occluded += batchSelection.occluded;
        for (const row of batchSelection.lodHistogram) {
          aggregate.lodHistogram.set(
            row.level,
            (aggregate.lodHistogram.get(row.level) ?? 0) + row.count,
          );
        }
      }
      return {
        ...selection,
        candidateCount: lodCandidateCount > 0 ? lodCandidateCount : projectedCandidateCount,
        visible: lodCandidateCount > 0 ? lodVisible : selection.visible,
        occluded: Math.max(
          0,
          (lodCandidateCount > 0 ? lodCandidateCount : projectedCandidateCount) -
            (lodCandidateCount > 0 ? lodVisible : selection.visible),
        ),
        lodHistogram: Object.freeze(
          [...lodHistogram.entries()]
            .sort(([left], [right]) => left - right)
            .map(([level, count]) => Object.freeze({ level, count })),
        ),
        surfaceActualMemberIds: Object.freeze(
          selection.actualMembers.flatMap((member) => {
            const prepared = preparedByBatchId.get(member.batchId);
            if (
              prepared === undefined ||
              prepared.artifact === undefined ||
              !isSingleLayerMediumArtifact(prepared.artifact)
            ) {
              return [];
            }
            const slot = this.preparedCache?.slotAt(member.primitiveIndex);
            if (slot === undefined) return [];
            const frameRange = this.surfaceFrameRangeCache?.value.ranges.find(
              ({ directMember }) =>
                directMember.worldId === slot.worldId &&
                directMember.entityKey === slot.entityKey &&
                directMember.drawItemIndex === member.drawItemIndex &&
                directMember.instanceOrdinal === member.instanceOrdinal,
            );
            if (frameRange === undefined) return [];
            return [
              JSON.stringify([
                frameRange.directMember.worldIdentity,
                frameRange.directMember.entityKey,
                frameRange.directMember.drawItemIndex,
                frameRange.directMember.instanceOrdinal,
              ]),
            ];
          }),
        ),
        worldSelections: Object.freeze(
          [...worldSelections.values()].map((aggregate) =>
            Object.freeze({
              worldKey: aggregate.worldKey,
              primitiveSlot: aggregate.primitiveSlot,
              slotGeneration: aggregate.slotGeneration,
              candidateCount: aggregate.candidateCount,
              visible: aggregate.visible,
              occluded: aggregate.occluded,
              lodHistogram: Object.freeze(
                [...aggregate.lodHistogram.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([level, count]) => Object.freeze({ level, count })),
              ),
            } satisfies GpuDrivenWorldLodSelectionInspection),
          ),
        ),
      };
    });
  }

  recordCpuValidation(
    validated: readonly { readonly source: RenderableSnapshot }[],
    gpuOwnedDrawKeys: ReadonlySet<string>,
    cacheKey?: string,
    worldKeys?: readonly number[],
  ): void {
    const cached = this.cpuValidationTelemetryCache;
    if (
      cacheKey !== undefined &&
      cached !== undefined &&
      cached.cacheKey === cacheKey &&
      sameValidatedSourceSequence(cached.validatedSources, validated) &&
      cached.gpuOwnedDrawKeys === gpuOwnedDrawKeys &&
      cached.worldKeys === worldKeys
    ) {
      this.applyCpuValidationTelemetry(cached);
      this.cpuValidationCacheHits += 1;
      return;
    }
    this.cpuFallbackDrawItems = 0;
    this.cpuSemanticFallbackDrawItems = 0;
    this.cpuDeformationFallbackDrawItems = 0;
    this.cpuDeformationReasons.clear();
    this.blockedDrawItems = 0;
    let gpuOwnedRows = 0;
    let totalDrawItems = 0;
    const addDeformationReason = (
      reason: 'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    ): void => {
      this.cpuDeformationReasons.set(reason, (this.cpuDeformationReasons.get(reason) ?? 0) + 1);
    };
    for (const row of validated) {
      const draws = row.source.gpuDrivenDraws ?? [];
      if (draws.length === 0) {
        totalDrawItems += 1;
        this.cpuFallbackDrawItems += 1;
        const skinReason = skinLaneReason(row.source);
        if (skinReason !== undefined) {
          this.cpuDeformationFallbackDrawItems += 1;
          addDeformationReason(skinReason);
        } else {
          this.cpuSemanticFallbackDrawItems += 1;
        }
        continue;
      }
      totalDrawItems += draws.length;
      let gpuOwned = false;
      let cpuResidual = false;
      for (const [compactIndex, draw] of draws.entries()) {
        const material = row.source.materials[draw.materialSlot] ?? row.source.material;
        const key = gpuDrivenDrawKey(
          worldEntityKey(
            worldKeys?.[row.source.worldId] ?? row.source.worldId,
            row.source.entityKey,
          ),
          material.materialHandle ?? -1,
          gpuDrivenSourceDrawItemIndex(draw, compactIndex),
        );
        if (gpuOwnedDrawKeys.has(key)) {
          gpuOwned = true;
          continue;
        }
        this.cpuFallbackDrawItems += 1;
        cpuResidual = true;
        const skinReason = skinLaneReason(row.source);
        if (skinReason !== undefined) {
          this.cpuDeformationFallbackDrawItems += 1;
          addDeformationReason(skinReason);
        } else if (draw.preparationError?.detail.recovery === 'route-cpu-lane') {
          // Geometry/UV incompatibility is an explicit semantic CPU lane,
          // not a failed capable submission.
          this.cpuSemanticFallbackDrawItems += 1;
        } else if (draw.preparationError?.detail.owner === 'skin') {
          this.cpuDeformationFallbackDrawItems += 1;
          addDeformationReason(
            draw.preparationError.detail.reason === 'skin-address-missing'
              ? 'skin-address-missing'
              : 'resource-not-ready',
          );
        } else if (draw.preparationError !== undefined) {
          this.blockedDrawItems += 1;
        } else {
          this.cpuSemanticFallbackDrawItems += 1;
        }
      }
      // A row is only CPU-validated when it still has a CPU residual. GPU-only
      // rows are already admitted by the concrete draw-key set and must not
      // inflate the per-frame CPU validation budget.
      if (gpuOwned && cpuResidual) gpuOwnedRows += 1;
    }
    this.gpuOwnedDrawItems = gpuOwnedDrawKeys.size;
    this.mainTotalDrawItems = totalDrawItems;
    this.validatedGpuOwnedRows = gpuOwnedRows;
    this.cpuValidationScans += 1;
    if (cacheKey !== undefined) {
      this.cpuValidationTelemetryCache = {
        cacheKey,
        validatedSources: validated.map((row) => row.source),
        gpuOwnedDrawKeys,
        worldKeys,
        gpuOwnedDrawCount: this.gpuOwnedDrawItems,
        totalDrawItems: this.mainTotalDrawItems,
        gpuOwnedRows: this.validatedGpuOwnedRows,
        cpuFallbackDrawItems: this.cpuFallbackDrawItems,
        cpuSemanticFallbackDrawItems: this.cpuSemanticFallbackDrawItems,
        cpuDeformationFallbackDrawItems: this.cpuDeformationFallbackDrawItems,
        cpuDeformationReasons: new Map(this.cpuDeformationReasons),
        blockedDrawItems: this.blockedDrawItems,
      };
    }
  }

  private sceneIdentity(scene: object): number {
    const existing = this.sceneIdentities.get(scene);
    if (existing !== undefined) return existing;
    const identity = this.nextSceneIdentity;
    this.nextSceneIdentity += 1;
    this.sceneIdentities.set(scene, identity);
    return identity;
  }
}
