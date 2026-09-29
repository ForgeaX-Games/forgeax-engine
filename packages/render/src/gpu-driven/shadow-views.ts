import type { box3 } from '@forgeax/engine-math';
import { frustum } from '@forgeax/engine-math';
import {
  type GraphAccess,
  type GraphResourceResolver,
  type RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Result, RhiDevice, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { GpuScene } from '../gpu-scene';
import type { ShadowViewIdentity, ShadowViewInvalidationReason } from '../inspection-types';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import {
  buildBatchAlignedSubmission,
  buildSubmissionCandidateMembership,
  type GpuDrivenBatch,
  type GpuDrivenCandidate,
  type SubmissionPlan,
} from './batch-topology';
import type { LodViewCamera } from './lod-projection.wgsl';
import { rasterLodDraws } from './production-raster-lod';
import { GpuDrivenView, type GpuDrivenViewGraphResources } from './view-gpu';

export type { ShadowViewIdentity, ShadowViewKind } from '../inspection-types';

export type ShadowViewCacheState = 'hit' | 'invalidated';

export interface ShadowViewUpdateInput {
  readonly identity: ShadowViewIdentity;
  readonly sourcePlan: SubmissionPlan;
  readonly scene: GpuScene;
  readonly planes: Float32Array;
  /** Light view-projection; a value change invalidates the view as `content-changed`. */
  readonly matrix?: Float32Array;
  /** Shadow target edge; a change invalidates the view as `content-changed`. */
  readonly targetSize?: number | undefined;
  /**
   * Accepted graph generation. A replacement graph imports new resource
   * projections, so the view refreshes its compute inputs once.
   */
  readonly graphGeneration?: number;
  readonly candidatePrimitiveIndices?: readonly number[] | ReadonlySet<number>;
  /** Main camera whose projection selects LOD levels inside the GPU cull. */
  readonly lodCamera?: LodViewCamera;
  /** CPU mirror of the main-camera heights; only drives `lod-changed` invalidation. */
  readonly lodProjectedHeights?: ReadonlyMap<number, number>;
  /**
   * Discrete LOD levels the heights select. Retained depth is re-rastered
   * only when a level changes; continuous height motion inside a level would
   * only move the cross-fade dither and does not invalidate the view.
   */
  readonly lodSelection?: string;
  /**
   * Reference camera the view's selection stays within
   * `SHADOW_LOD_MAX_COARSER` levels of. A clamped static layer keeps finer
   * retained levels and re-rasters only casters now too coarse for it.
   */
  readonly lodClampCamera?: LodViewCamera;
  /**
   * Slots whose changes this view never draws, e.g. dynamic casters for a
   * static layer. Their boxes do not invalidate the view.
   */
  readonly ignoredChangeSlots?: ReadonlySet<number>;
}

export interface ShadowViewUpdate {
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  readonly generation: number;
  readonly sourcePlan: SubmissionPlan;
  readonly plan: SubmissionPlan;
  readonly view: GpuDrivenView;
}

export interface ShadowViewProjection {
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  readonly generation: number;
  readonly plan: SubmissionPlan;
  readonly view: GpuDrivenView;
  readonly passNames: readonly string[];
  readonly graphResources: GpuDrivenViewGraphResources | undefined;
}

export interface ShadowViewSubmission {
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  readonly generation: number;
  readonly plan: SubmissionPlan;
  readonly view: GpuDrivenView;
}

/**
 * The only record-side hook a capable shadow lane needs after the shared
 * groups are bound.  The callback owns material/mesh binding policy and emits
 * the indirect draws for this view; it receives the pool projection rather
 * than rebuilding a candidate list from the frame.
 */
export interface ShadowViewGpuRecordInput {
  readonly identity: ShadowViewIdentity;
  readonly projection: ShadowViewProjection;
  readonly pass: RhiRenderPassEncoder;
  readonly resources: GraphResourceResolver;
}

export type ShadowViewGpuRecorder = (input: ShadowViewGpuRecordInput) => void;

export interface ShadowViewGpuPass {
  readonly projection: ShadowViewProjection;
  readonly resources: GraphResourceResolver;
  readonly record: ShadowViewGpuRecorder;
}

export interface ShadowViewInspection {
  readonly identity: ShadowViewIdentity;
  readonly cache: ShadowViewCacheState;
  /** Present exactly when `cache === 'invalidated'`. */
  readonly invalidationReason?: ShadowViewInvalidationReason;
  readonly generation: number;
  readonly sourceRevision: number;
  readonly candidateCount: number;
  readonly batchCount: number;
  readonly resourceGeneration: number;
  /** World-space caster diameter below which the view skips a caster; 0 disables. */
  readonly minCasterDiameter: number;
  /** In-frustum casters the last observed GPU cull dropped below that diameter. */
  readonly texelCulled?: number;
  /** Present when a static layer's miss re-rasters only these regions. */
  readonly dirtyRects?: readonly ShadowDirtyRect[];
}

/**
 * A region of a static shadow layer to re-raster, in normalized target
 * coordinates: x right and y down, `[x0, x1) x [y0, y1)` within `[0, 1]`.
 */
export interface ShadowDirtyRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface SceneBuffers {
  readonly primitive: GpuScene['primitiveBuffer'];
  readonly instance: GpuScene['instanceBuffer'];
  readonly transform: GpuScene['transformBuffer'];
  readonly material: GpuScene['materialBuffer'];
}

interface ShadowViewRecord {
  readonly identity: ShadowViewIdentity;
  readonly view: GpuDrivenView;
  sourcePlan: SubmissionPlan;
  plan: SubmissionPlan;
  scene: GpuScene;
  matrix: Float32Array | undefined;
  targetSize: number | undefined;
  graphGeneration: number | undefined;
  contentRevision: number;
  planes: Float32Array;
  candidateSource: readonly number[] | ReadonlySet<number> | undefined;
  candidates: readonly number[] | undefined;
  lodSelection: string | undefined;
  lodProjectedHeights: ReadonlyMap<number, number> | undefined;
  /** The plan draws skinned casters, so a skin palette change reaches it. */
  skinned: boolean;
  generation: number;
  cache: ShadowViewCacheState;
  invalidationReason: ShadowViewInvalidationReason | undefined;
  invalidated: boolean;
  published: boolean;
  resourceGeneration: number;
  sceneBuffers: SceneBuffers;
  minCasterDiameter: number;
  texelCulled: number | undefined;
  /** A partial static-layer miss: only these regions re-raster. */
  dirtyRects: readonly ShadowDirtyRect[] | undefined;
}

function identityKey(identity: ShadowViewIdentity): string {
  return `${identity.kind}:${identity.index}:${identity.face ?? ''}${
    identity.layer === undefined ? '' : `:${identity.layer}`
  }`;
}

export function shadowViewIdentityKey(identity: ShadowViewIdentity): string {
  return identityKey(identity);
}

function validateIdentity(identity: ShadowViewIdentity): RhiError | undefined {
  if (!Number.isInteger(identity.index) || identity.index < 0) {
    return new RhiError({
      code: 'internal-error',
      expected: 'shadow view index is a non-negative integer',
      hint: 'publish a stable directional cascade, point face, or spot atlas index',
    });
  }
  if (
    identity.face !== undefined &&
    (!Number.isInteger(identity.face) || identity.face < 0 || identity.face > 5)
  ) {
    return new RhiError({
      code: 'internal-error',
      expected: 'point shadow face is an integer from 0 through 5',
      hint: 'publish a valid cube face for the point shadow view',
    });
  }
  if (identity.layer !== undefined && identity.layer !== 'static') {
    return new RhiError({
      code: 'internal-error',
      expected: "shadow view layer is omitted or 'static'",
      hint: 'publish the final view without a layer and its cached caster layer as static',
    });
  }
  return undefined;
}

const PLANE_FLOATS = 24;
/** Minimum projected caster diameter in texels: settled casters, then moving ones. */
const STATIC_MIN_CASTER_TEXELS = 1;
const DYNAMIC_MIN_CASTER_TEXELS = 2;

/**
 * Casters smaller than a few texels only add aliasing noise to a cascade. The
 * texel edge is exact for an orthographic light; a perspective light has no
 * single texel size, so it keeps every caster.
 */
export function shadowMinCasterDiameter(
  identity: ShadowViewIdentity,
  matrix: Float32Array | undefined,
  targetSize: number | undefined,
): number {
  if (matrix === undefined || targetSize === undefined || targetSize <= 0) return 0;
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) return 0;
  const scaleX = Math.hypot(matrix[0] ?? 0, matrix[4] ?? 0, matrix[8] ?? 0);
  if (!(scaleX > 0)) return 0;
  const texel = 2 / (scaleX * targetSize);
  const texels =
    identity.layer === 'static'
      ? STATIC_MIN_CASTER_TEXELS
      : shadowViewHasStaticLayer(identity)
        ? DYNAMIC_MIN_CASTER_TEXELS
        : STATIC_MIN_CASTER_TEXELS;
  return texel * texels;
}

function planesError(): RhiError {
  return new RhiError({
    code: 'internal-error',
    expected: 'shadow view publishes six clipping planes',
    hint: 'provide a 24-float frustum plane array before updating the view',
  });
}

function samePrefix(left: Float32Array, right: Float32Array, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameMatrix(left: Float32Array | undefined, right: Float32Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && samePrefix(left, right, left.length);
}

function sameCandidates(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sceneBuffers(scene: GpuScene): SceneBuffers {
  return {
    primitive: scene.primitiveBuffer,
    instance: scene.instanceBuffer,
    transform: scene.transformBuffer,
    material: scene.materialBuffer,
  };
}

function sameSceneBuffers(left: SceneBuffers, right: GpuScene): boolean {
  return (
    left.primitive === right.primitiveBuffer &&
    left.instance === right.instanceBuffer &&
    left.transform === right.transformBuffer &&
    left.material === right.materialBuffer
  );
}

function candidateIndices(
  values: readonly number[] | ReadonlySet<number> | undefined,
): Result<readonly number[] | undefined, RhiError> {
  if (values === undefined) return ok(undefined);
  const entries = Array.from(values);
  for (const entry of entries) {
    if (!Number.isInteger(entry) || entry < 0) {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'shadow candidate primitive indices are non-negative integers',
          hint: 'derive ShadowCaster membership from the shared BatchTopology channel index',
        }),
      );
    }
  }
  return ok(Object.freeze([...new Set(entries)].sort((left, right) => left - right)));
}

function projectPlan(
  source: SubmissionPlan,
  primitiveIndices: readonly number[] | undefined,
): SubmissionPlan {
  if (primitiveIndices === undefined) return source;
  const membership = buildSubmissionCandidateMembership(source);
  const candidatesByBatch = new Map<number, GpuDrivenCandidate[]>();
  for (const primitiveIndex of primitiveIndices) {
    for (const entry of membership.byPrimitiveIndex.get(primitiveIndex) ?? []) {
      const candidates = candidatesByBatch.get(entry.batchId) ?? [];
      candidates.push(entry.candidate);
      candidatesByBatch.set(entry.batchId, candidates);
    }
  }
  const immutableCandidates = new Map<number, readonly GpuDrivenCandidate[]>();
  for (const [batchId, candidates] of candidatesByBatch) {
    immutableCandidates.set(batchId, Object.freeze(candidates));
  }
  return buildBatchAlignedSubmission(source, immutableCandidates);
}

function planDrawsSkin(plan: SubmissionPlan): boolean {
  return plan.batches.some((batch) => batch.prepared?.identity.deformation === 'skin');
}

export function shadowViewLabelPrefix(identity: ShadowViewIdentity): string {
  const prefix = shadowViewKindLabelPrefix(identity);
  return identity.layer === undefined ? prefix : `${prefix}.${identity.layer}`;
}

function shadowViewKindLabelPrefix(identity: ShadowViewIdentity): string {
  switch (identity.kind) {
    case 'directional':
      return `gpu-driven.shadow.directional-cascade-${identity.index}`;
    case 'point':
      return `gpu-driven.shadow.point-cube-face-${identity.index}${
        identity.face === undefined ? '' : `-${identity.face}`
      }`;
    case 'spot':
      return `gpu-driven.shadow.spot-atlas-${identity.index}`;
  }
}

/**
 * Accesses consumed by a shadow raster adapter.  These are the same imported
 * scene and view-local resources written by GpuDrivenView.addPasses(...), so
 * the graph inserts the compute-to-raster dependency without a second graph
 * or a manual barrier owner.
 */
export function shadowViewRasterAccesses(
  resources: GpuDrivenViewGraphResources,
): readonly GraphAccess[] {
  return Object.freeze([
    { resource: resources.primitive, usage: 'storage-read' },
    { resource: resources.instance, usage: 'storage-read' },
    { resource: resources.transform, usage: 'storage-read' },
    { resource: resources.material, usage: 'storage-read' },
    { resource: resources.visible, usage: 'storage-read' },
    { resource: resources.indirect, usage: 'indirect-read' },
  ] satisfies GraphAccess[]);
}

function invalidateRecord(record: ShadowViewRecord, reason: ShadowViewInvalidationReason): void {
  record.dirtyRects = undefined;
  record.invalidated = true;
  record.cache = 'invalidated';
  record.invalidationReason = reason;
}

const boxScratch = new Float32Array(6);

/** No box touches the frustum; an unproven box set touches everything. */
function boundsMissView(
  planes: Float32Array,
  bounds: ReturnType<GpuScene['changedBoundsSince']>,
): boolean {
  if (bounds === 'unbounded') return false;
  const view = planes as unknown as frustum.Frustum;
  for (let offset = 0; offset < bounds.length; offset += 6) {
    boxScratch.set(bounds.subarray(offset, offset + 6));
    if (frustum.intersectsBox(view, boxScratch as unknown as box3.Box3Like)) return false;
  }
  return true;
}

/**
 * Scene content changed after the retained revision only matters when an old
 * or new world box of a changed slot touches this view's retained frustum.
 */
function sceneChangesMissView(previous: ShadowViewRecord, input: ShadowViewUpdateInput): boolean {
  const current = input.scene.contentRevision;
  if (previous.contentRevision === current) return true;
  const changed = input.scene.changedBoundsSince(
    previous.contentRevision,
    input.ignoredChangeSlots,
  );
  if (!boundsMissView(previous.planes, changed)) return false;
  previous.contentRevision = current;
  return true;
}

interface PrimitiveDraw {
  readonly batch: GpuDrivenBatch;
  readonly candidate: GpuDrivenCandidate;
}

const drawsByPlan = new WeakMap<SubmissionPlan, ReadonlyMap<number, readonly PrimitiveDraw[]>>();

function primitiveDraws(plan: SubmissionPlan): ReadonlyMap<number, readonly PrimitiveDraw[]> {
  const cached = drawsByPlan.get(plan);
  if (cached !== undefined) return cached;
  const draws = new Map<number, PrimitiveDraw[]>();
  for (const batch of plan.batches) {
    for (const candidate of batch.candidates) {
      const list = draws.get(candidate.primitiveIndex);
      if (list === undefined) draws.set(candidate.primitiveIndex, [{ batch, candidate }]);
      else list.push({ batch, candidate });
    }
  }
  drawsByPlan.set(plan, draws);
  return draws;
}

function sameCandidate(left: GpuDrivenCandidate, right: GpuDrivenCandidate): boolean {
  return (
    left === right ||
    (left.primitiveIndex === right.primitiveIndex &&
      left.generation === right.generation &&
      left.drawItemIndex === right.drawItemIndex &&
      left.instanceOrdinal === right.instanceOrdinal)
  );
}

function sameList<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  same: (a: T, b: T) => boolean,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!same(left[index] as T, right[index] as T)) return false;
  }
  return true;
}

function sameShallow(left: object | undefined, right: object | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every((key) => leftRecord[key] === rightRecord[key]);
}

function samePrepared(
  left: GpuDrivenBatch['prepared'],
  right: GpuDrivenBatch['prepared'],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const { identity: leftIdentity, ...leftRest } = left;
  const { identity: rightIdentity, ...rightRest } = right;
  return sameShallow(leftIdentity, rightIdentity) && sameShallow(leftRest, rightRest);
}

function sameLod(left: GpuDrivenBatch['lod'], right: GpuDrivenBatch['lod']): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.hysteresis === right.hysteresis &&
    sameList(left.coverages, right.coverages, Object.is) &&
    sameList(left.ranges, right.ranges, sameShallow)
  );
}

/**
 * Drawn content of one candidate: its batch's shared key, prepared receipt and
 * LOD facts plus the candidate row. A member's own preparation facts change
 * only with a scene update of its slot, which the change-log check judges.
 */
function sameDraw(left: PrimitiveDraw, right: PrimitiveDraw): boolean {
  const a = left.batch;
  const b = right.batch;
  return (
    (a === b ||
      (sameShallow(a.key, b.key) &&
        samePrepared(a.prepared, b.prepared) &&
        sameLod(a.lod, b.lod))) &&
    sameCandidate(left.candidate, right.candidate)
  );
}

/** Primitives whose drawn content differs between two plans: added, removed, or changed. */
function changedPrimitives(previous: SubmissionPlan, next: SubmissionPlan, out: Set<number>): void {
  const before = primitiveDraws(previous);
  const after = primitiveDraws(next);
  for (const [primitive, draws] of before) {
    if (!sameList(draws, after.get(primitive), sameDraw)) out.add(primitive);
  }
  for (const primitive of after.keys()) if (!before.has(primitive)) out.add(primitive);
}

/**
 * Two plans with the same draws also share every buffer offset, so a view may
 * keep the retained plan object and its uploaded candidate rows.
 */
function sameSubmissionLayout(left: SubmissionPlan, right: SubmissionPlan): boolean {
  if (
    left.candidateCount !== right.candidateCount ||
    left.visibleCapacity !== right.visibleCapacity ||
    left.batches.length !== right.batches.length
  ) {
    return false;
  }
  for (let index = 0; index < left.batches.length; index += 1) {
    const a = left.batches[index];
    const b = right.batches[index];
    if (
      a === undefined ||
      b === undefined ||
      a.batchId !== b.batchId ||
      a.generation !== b.generation ||
      a.visibleBase !== b.visibleBase ||
      a.visibleCapacity !== b.visibleCapacity ||
      a.indirectOffset !== b.indirectOffset ||
      a.candidates.length !== b.candidates.length
    ) {
      return false;
    }
    for (let row = 0; row < a.candidates.length; row += 1) {
      if (a.candidates[row]?.primitiveIndex !== b.candidates[row]?.primitiveIndex) return false;
    }
  }
  return true;
}

/** Discrete raster LOD levels per primitive; primitives without LOD levels are omitted. */
function lodLevels(
  plan: SubmissionPlan,
  heights: ReadonlyMap<number, number> | undefined,
): ReadonlyMap<number, string> {
  const levels = new Map<number, string>();
  for (const batch of plan.batches) {
    if ((batch.lod?.coverages.length ?? 0) <= 1) continue;
    for (const candidate of batch.candidates) {
      const key = rasterLodDraws(
        batch,
        batch.lod,
        heights?.get(candidate.primitiveIndex) ?? Number.NaN,
      )
        .map((draw) => draw.level)
        .join(',');
      const previous = levels.get(candidate.primitiveIndex);
      levels.set(candidate.primitiveIndex, previous === undefined ? key : `${previous}|${key}`);
    }
  }
  return levels;
}

function finestLodLevel(levels: string): number {
  return Math.min(...levels.split(/[,|]/).map(Number));
}

/**
 * Primitives whose retained LOD levels no longer serve the next selection.
 * With `keepFiner` a retained level finer than the next one still serves it,
 * so only a caster now drawn finer than retained is stale.
 */
function changedLodPrimitives(
  previous: ShadowViewRecord,
  plan: SubmissionPlan,
  heights: ReadonlyMap<number, number> | undefined,
  keepFiner: boolean,
  out: Set<number>,
): void {
  const before = lodLevels(previous.plan, previous.lodProjectedHeights);
  const after = lodLevels(plan, heights);
  for (const [primitive, level] of after) {
    const retained = before.get(primitive);
    if (retained === level) continue;
    if (keepFiner && retained !== undefined && finestLodLevel(level) >= finestLodLevel(retained)) {
      continue;
    }
    out.add(primitive);
  }
  for (const primitive of before.keys()) if (!after.has(primitive)) out.add(primitive);
}

/** A clamped static layer keeps retained levels finer than it now selects. */
function keepsFinerLod(input: ShadowViewUpdateInput): boolean {
  return input.identity.layer === 'static' && input.lodClampCamera !== undefined;
}

/** Most regions one partial static redraw clears and re-rasters. */
const MAX_DIRTY_RECTS = 4;
/** Above this share of the layer a full redraw is cheaper than scissored regions. */
const MAX_DIRTY_COVERAGE = 0.5;
/** Changed boxes beyond this count fall back to a full redraw. */
const MAX_DIRTY_BOXES = 64;
/** Normalized margin around each projected box, covering raster rounding. */
const DIRTY_RECT_MARGIN = 1 / 256;

type MutableRect = { x0: number; y0: number; x1: number; y1: number };

const cornerScratch = new Float32Array(4);

/** The normalized target rect a world box projects to; undefined when it crosses the eye plane. */
function projectBox(
  matrix: Float32Array,
  boxes: Float32Array,
  offset: number,
): MutableRect | null | undefined {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 8; corner += 1) {
    const x = boxes[offset + (corner & 1 ? 3 : 0)] as number;
    const y = boxes[offset + (corner & 2 ? 4 : 1)] as number;
    const z = boxes[offset + (corner & 4 ? 5 : 2)] as number;
    for (let row = 0; row < 4; row += 1) {
      cornerScratch[row] =
        (matrix[row] as number) * x +
        (matrix[4 + row] as number) * y +
        (matrix[8 + row] as number) * z +
        (matrix[12 + row] as number);
    }
    const w = cornerScratch[3] as number;
    if (!(w > 1e-6)) return undefined;
    const u = ((cornerScratch[0] as number) / w) * 0.5 + 0.5;
    const v = 0.5 - ((cornerScratch[1] as number) / w) * 0.5;
    x0 = Math.min(x0, u);
    y0 = Math.min(y0, v);
    x1 = Math.max(x1, u);
    y1 = Math.max(y1, v);
  }
  if (!Number.isFinite(x0 + y0 + x1 + y1)) return undefined;
  const rect = {
    x0: Math.max(0, x0 - DIRTY_RECT_MARGIN),
    y0: Math.max(0, y0 - DIRTY_RECT_MARGIN),
    x1: Math.min(1, x1 + DIRTY_RECT_MARGIN),
    y1: Math.min(1, y1 + DIRTY_RECT_MARGIN),
  };
  return rect.x0 >= rect.x1 || rect.y0 >= rect.y1 ? null : rect;
}

const rectArea = (rect: MutableRect): number => (rect.x1 - rect.x0) * (rect.y1 - rect.y0);

/**
 * Merges projected boxes into at most {@link MAX_DIRTY_RECTS} rects, each step
 * joining the pair whose union adds the least area. Undefined asks for a full
 * redraw: too many boxes, a box crossing the eye plane, or too much coverage.
 */
export function shadowDirtyRects(
  matrix: Float32Array,
  boxSets: readonly Float32Array[],
): readonly ShadowDirtyRect[] | undefined {
  let boxCount = 0;
  for (const boxes of boxSets) boxCount += boxes.length / 6;
  if (boxCount > MAX_DIRTY_BOXES) return undefined;
  const rects: MutableRect[] = [];
  for (const boxes of boxSets) {
    for (let offset = 0; offset < boxes.length; offset += 6) {
      const rect = projectBox(matrix, boxes, offset);
      if (rect === undefined) return undefined;
      if (rect !== null) rects.push(rect);
    }
  }
  const union = (a: MutableRect, b: MutableRect): MutableRect => ({
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  });
  const overlaps = (a: MutableRect, b: MutableRect): boolean =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (;;) {
    let best: [number, number] | undefined;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i] as MutableRect;
        const b = rects[j] as MutableRect;
        // Overlapping rects always merge so no texel is drawn twice.
        const cost = overlaps(a, b)
          ? Number.NEGATIVE_INFINITY
          : rectArea(union(a, b)) - rectArea(a) - rectArea(b);
        if (cost < bestCost) {
          bestCost = cost;
          best = [i, j];
        }
      }
    }
    if (
      best === undefined ||
      (rects.length <= MAX_DIRTY_RECTS && bestCost !== Number.NEGATIVE_INFINITY)
    ) {
      break;
    }
    const [i, j] = best;
    rects[i] = union(rects[i] as MutableRect, rects[j] as MutableRect);
    rects.splice(j, 1);
  }
  let coverage = 0;
  for (const rect of rects) coverage += rectArea(rect);
  if (coverage > MAX_DIRTY_COVERAGE) return undefined;
  return Object.freeze(rects.map((rect) => Object.freeze(rect)));
}

/**
 * A retained static layer whose only miss is scene or membership content
 * re-rasters just the regions every changed box projects to. The view, its
 * target and matrix must be unchanged; the boxes are the scene changes the
 * layer draws plus every box of a primitive whose drawn content changed.
 */
function partialStaticRects(
  previous: ShadowViewRecord,
  input: ShadowViewUpdateInput,
  reason: ShadowViewInvalidationReason,
  retainedRevision: number,
  plan: SubmissionPlan,
): readonly ShadowDirtyRect[] | undefined {
  if (
    input.identity.layer !== 'static' ||
    (reason !== 'content-changed' && reason !== 'membership-changed' && reason !== 'lod-changed') ||
    previous.invalidated ||
    !previous.published ||
    previous.matrix === undefined ||
    input.matrix === undefined ||
    previous.scene !== input.scene ||
    !sameSceneBuffers(previous.sceneBuffers, input.scene) ||
    previous.resourceGeneration !== previous.view.inspect().resourceGeneration ||
    previous.targetSize !== input.targetSize ||
    previous.graphGeneration !== input.graphGeneration ||
    !sameMatrix(previous.matrix, input.matrix) ||
    !samePrefix(previous.planes, input.planes, PLANE_FLOATS)
  ) {
    return undefined;
  }
  const scene = input.scene;
  const changedContent = scene.changedBoundsSince(retainedRevision, input.ignoredChangeSlots);
  if (changedContent === 'unbounded') return undefined;
  const changed = new Set<number>();
  changedPrimitives(previous.plan, plan, changed);
  if (previous.lodSelection !== input.lodSelection) {
    changedLodPrimitives(previous, plan, input.lodProjectedHeights, keepsFinerLod(input), changed);
  }
  const changedDraws = scene.slotBoundsSince(retainedRevision, changed);
  if (changedDraws === 'unbounded') return undefined;
  return shadowDirtyRects(input.matrix, [changedContent, changedDraws]);
}

function structureInvalidationReason(
  previous: ShadowViewRecord | undefined,
  input: ShadowViewUpdateInput,
): ShadowViewInvalidationReason | undefined {
  if (previous === undefined) return 'first-publication';
  if (previous.invalidated) return previous.invalidationReason ?? 'first-publication';
  if (!previous.published) return 'first-publication';
  if (
    previous.scene !== input.scene ||
    !sameSceneBuffers(previous.sceneBuffers, input.scene) ||
    previous.resourceGeneration !== previous.view.inspect().resourceGeneration
  ) {
    return 'source-changed';
  }
  if (
    !sceneChangesMissView(previous, input) ||
    previous.targetSize !== input.targetSize ||
    previous.graphGeneration !== input.graphGeneration ||
    !sameMatrix(previous.matrix, input.matrix)
  ) {
    return 'content-changed';
  }
  return undefined;
}

function passNames(identity: ShadowViewIdentity): readonly string[] {
  const prefix = shadowViewLabelPrefix(identity);
  return Object.freeze([
    `${prefix}.view-reset`,
    `${prefix}.frustum-compact`,
    `${prefix}.finalize-indirect`,
  ]);
}

function graphStateError(identity: ShadowViewIdentity): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-descriptor-invalid',
    expected: 'ShadowViewStatePool.update(...) precedes project(...)',
    hint: 'publish the shared scene, topology channel, and view planes before graph projection',
    detail: {
      resourceLabel: identityKey(identity),
      field: 'state',
      expected: 'updated',
      actual: 'not-updated',
    },
  });
}

/**
 * Renderer-owned shadow view state. The pool shares one scene/topology source;
 * each directional, point, or spot entry owns only view constants, visibility,
 * counters, indirect arguments, and its cache decision.
 */
export class ShadowViewStatePool {
  private readonly records = new Map<string, ShadowViewRecord>();
  private readonly activeKeys = new Set<string>();
  private readonly retiring = new Map<string, ShadowViewRecord>();
  private readonly pendingPublication = new Set<string>();

  private constructor(
    private readonly device: RhiDevice,
    private readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory,
  ) {}

  static create(input: {
    readonly device: RhiDevice;
    readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  }): Result<ShadowViewStatePool, RhiError> {
    return ok(new ShadowViewStatePool(input.device, input.shaderModuleFactory));
  }

  update(input: ShadowViewUpdateInput): Result<ShadowViewUpdate, RhiError> {
    const identityError = validateIdentity(input.identity);
    if (identityError !== undefined) return err(identityError);
    if (input.planes.length < PLANE_FLOATS) return err(planesError());
    const key = identityKey(input.identity);
    const previous = this.records.get(key);
    const candidateSource = input.candidatePrimitiveIndices;
    let candidates = previous?.candidates;
    if (previous === undefined || previous.candidateSource !== candidateSource) {
      const normalized = candidateIndices(candidateSource);
      if (!normalized.ok) return normalized;
      candidates = normalized.value;
    }
    this.activeKeys.add(key);
    this.retiring.delete(key);
    const retainedRevision = previous?.contentRevision;
    const structureMiss = structureInvalidationReason(previous, input);
    let invalidationReason =
      structureMiss ??
      (previous !== undefined && !samePrefix(previous.planes, input.planes, PLANE_FLOATS)
        ? 'view-changed'
        : undefined);
    const sameSource =
      previous !== undefined &&
      previous.sourcePlan === input.sourcePlan &&
      sameCandidates(previous.candidates, candidates);
    // A structural miss re-projects so an aborted or replaced view uploads afresh.
    const selectedPlan =
      structureMiss === undefined && sameSource && previous !== undefined
        ? previous.plan
        : projectPlan(input.sourcePlan, candidates);
    if (invalidationReason === undefined && previous !== undefined) {
      invalidationReason = this.retainedContentReason(
        previous,
        input,
        retainedRevision ?? previous.contentRevision,
        selectedPlan,
        sameSource,
      );
    }
    if (invalidationReason === undefined && previous !== undefined) {
      previous.cache = 'hit';
      previous.invalidationReason = undefined;
      previous.candidateSource = candidateSource;
      previous.candidates = candidates;
      return ok({
        identity: previous.identity,
        cache: 'hit',
        generation: previous.generation,
        sourcePlan: previous.sourcePlan,
        plan: previous.plan,
        view: previous.view,
      });
    }

    const dirtyRects =
      previous === undefined || invalidationReason === undefined
        ? undefined
        : partialStaticRects(
            previous,
            input,
            invalidationReason,
            retainedRevision ?? previous.contentRevision,
            selectedPlan,
          );
    const planes = new Float32Array(input.planes.subarray(0, PLANE_FLOATS));
    let view = previous?.view;
    if (view === undefined) {
      const created = GpuDrivenView.create({
        device: this.device,
        shaderModuleFactory: this.shaderModuleFactory,
        labelPrefix: `${shadowViewLabelPrefix(input.identity)}.view`,
      });
      if (!created.ok) return created;
      view = created.value;
    }
    const minCasterDiameter = shadowMinCasterDiameter(
      input.identity,
      input.matrix,
      input.targetSize,
    );
    const updated = view.update(
      selectedPlan,
      input.scene,
      planes,
      input.lodCamera,
      minCasterDiameter,
      undefined,
      input.lodClampCamera,
    );
    if (!updated.ok) return updated;
    const generation = (previous?.generation ?? 0) + 1;
    const record: ShadowViewRecord = {
      identity: Object.freeze({ ...input.identity }),
      view,
      sourcePlan: input.sourcePlan,
      plan: selectedPlan,
      scene: input.scene,
      matrix: input.matrix === undefined ? undefined : new Float32Array(input.matrix),
      targetSize: input.targetSize,
      graphGeneration: input.graphGeneration,
      contentRevision: input.scene.contentRevision,
      planes,
      candidateSource,
      candidates,
      lodSelection: input.lodSelection,
      lodProjectedHeights: input.lodProjectedHeights,
      skinned: planDrawsSkin(selectedPlan),
      generation,
      cache: 'invalidated',
      invalidationReason,
      invalidated: false,
      published: false,
      resourceGeneration: view.inspect().resourceGeneration,
      sceneBuffers: sceneBuffers(input.scene),
      minCasterDiameter,
      texelCulled: previous?.texelCulled,
      dirtyRects,
    };
    this.records.set(key, record);
    this.pendingPublication.add(key);
    return ok({
      identity: record.identity,
      cache: 'invalidated',
      generation,
      sourcePlan: record.sourcePlan,
      plan: record.plan,
      view: record.view,
    });
  }

  /**
   * A retained view re-rasters only when a primitive whose drawn content or
   * discrete LOD level differs between the retained plan and the next plan
   * touches the retained frustum, judged by every box the primitive occupied
   * since the retained revision. Otherwise the record adopts the next plan so
   * later compute and recording stay consistent with the scene, and stays a hit.
   */
  private retainedContentReason(
    previous: ShadowViewRecord,
    input: ShadowViewUpdateInput,
    retainedRevision: number,
    plan: SubmissionPlan,
    sameSource: boolean,
  ): ShadowViewInvalidationReason | undefined {
    const sameLod = previous.lodSelection === input.lodSelection;
    if (sameSource && sameLod) return undefined;
    const scene = input.scene;
    if (!sameLod) {
      const lodChanged = new Set<number>();
      changedLodPrimitives(
        previous,
        plan,
        input.lodProjectedHeights,
        keepsFinerLod(input),
        lodChanged,
      );
      if (!boundsMissView(previous.planes, scene.slotBoundsSince(retainedRevision, lodChanged))) {
        return 'lod-changed';
      }
    }
    let adopted = previous.plan;
    if (plan !== previous.plan) {
      const changed = new Set<number>();
      changedPrimitives(previous.plan, plan, changed);
      if (!boundsMissView(previous.planes, scene.slotBoundsSince(retainedRevision, changed))) {
        return previous.sourcePlan === input.sourcePlan ? 'membership-changed' : 'source-changed';
      }
      adopted =
        changed.size === 0 && sameSubmissionLayout(previous.plan, plan) ? previous.plan : plan;
    }
    const resourceGeneration = previous.view.inspect().resourceGeneration;
    const updated = previous.view.update(
      adopted,
      scene,
      previous.planes,
      input.lodCamera,
      previous.minCasterDiameter,
      undefined,
      input.lodClampCamera,
    );
    if (!updated.ok || previous.view.inspect().resourceGeneration !== resourceGeneration) {
      return 'source-changed';
    }
    previous.sourcePlan = input.sourcePlan;
    previous.plan = adopted;
    // Kept finer levels stay the retained reference until a re-raster.
    if (!keepsFinerLod(input)) previous.lodProjectedHeights = input.lodProjectedHeights;
    previous.lodSelection = input.lodSelection;
    previous.skinned = planDrawsSkin(adopted);
    return undefined;
  }

  project<FrameCtx extends RenderGraphFrame>(
    builder: RenderGraphBuilder<FrameCtx>,
    identity: ShadowViewIdentity,
    forceCompute = false,
  ): Result<ShadowViewProjection, RenderGraphError> {
    const record = this.records.get(identityKey(identity));
    if (record === undefined) return err(graphStateError(identity));
    const cacheHit = record.cache === 'hit' && !record.invalidated;
    // A graph replacement must carry the shadow compute passes even when the
    // view itself is a cache hit. The graph owns the pass list, so omitting
    // compute work while importing a replacement graph would leave its
    // indirect arguments stale. The normal pool contract still skips work on
    // a cache hit; graph projection opts in explicitly at that boundary.
    const includeCompute = forceCompute || !cacheHit;
    let forceComputePending = forceCompute;
    let lastFrame: FrameCtx | undefined;
    let executeForFrame = false;
    const executeCompute = (frame: FrameCtx): boolean => {
      if (frame !== lastFrame) {
        lastFrame = frame;
        const currentRecord = this.records.get(identityKey(record.identity));
        executeForFrame =
          forceComputePending ||
          currentRecord === undefined ||
          currentRecord.cache !== 'hit' ||
          currentRecord.invalidated;
        forceComputePending = false;
      }
      return executeForFrame;
    };
    const projected = record.view.addPasses(
      builder,
      shadowViewLabelPrefix(record.identity),
      includeCompute,
      undefined,
      includeCompute ? executeCompute : undefined,
    );
    if (!projected.ok) return projected;
    return ok({
      identity: record.identity,
      cache: cacheHit ? 'hit' : 'invalidated',
      generation: record.generation,
      plan: record.plan,
      view: record.view,
      passNames: includeCompute ? passNames(record.identity) : Object.freeze([]),
      graphResources: projected.value,
    });
  }

  invalidate(reason: ShadowViewInvalidationReason, identity?: ShadowViewIdentity): void {
    if (identity === undefined) {
      for (const record of this.records.values()) invalidateRecord(record, reason);
      return;
    }
    const record = this.records.get(identityKey(identity));
    if (record !== undefined) invalidateRecord(record, reason);
  }

  /** A skin palette change reaches only views whose plan draws skinned casters. */
  invalidateSkinned(): void {
    for (const record of this.records.values()) {
      if (record.skinned) invalidateRecord(record, 'skin-palette-changed');
    }
  }

  cacheState(identity: ShadowViewIdentity): ShadowViewCacheState | undefined {
    const record = this.records.get(identityKey(identity));
    if (record === undefined) return undefined;
    return record.invalidated ? 'invalidated' : record.cache;
  }

  /** The reason an active view misses this frame; undefined on a hit. */
  invalidationReason(identity: ShadowViewIdentity): ShadowViewInvalidationReason | undefined {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (record === undefined || !this.activeKeys.has(key)) return 'uncached';
    if (!record.invalidated && record.cache === 'hit') return undefined;
    return record.invalidationReason ?? 'first-publication';
  }

  /**
   * The regions a missed static layer re-rasters; undefined for a full redraw.
   * Only meaningful while {@link invalidationReason} reports a miss.
   */
  dirtyRects(identity: ShadowViewIdentity): readonly ShadowDirtyRect[] | undefined {
    const key = identityKey(identity);
    const record = this.records.get(key);
    if (record === undefined || !this.activeKeys.has(key) || record.invalidated) return undefined;
    return record.cache === 'invalidated' ? record.dirtyRects : undefined;
  }

  /** Casters the view's last observed GPU cull dropped below its minimum diameter. */
  texelCulled(identity: ShadowViewIdentity): number | undefined {
    const key = identityKey(identity);
    return this.activeKeys.has(key) ? this.records.get(key)?.texelCulled : undefined;
  }

  isActive(identity: ShadowViewIdentity): boolean {
    return this.activeKeys.has(identityKey(identity));
  }

  submission(identity: ShadowViewIdentity): ShadowViewSubmission | undefined {
    const key = identityKey(identity);
    if (!this.activeKeys.has(key)) return undefined;
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    return {
      identity: record.identity,
      cache: record.cache,
      generation: record.generation,
      plan: record.plan,
      view: record.view,
    };
  }

  /**
   * Keep only the active view identities for the current frame. Removed light
   * views are disposed through their own queue-fenced resource owner instead
   * of remaining in inspection or changing the compiled topology forever.
   */
  retain(identities: readonly ShadowViewIdentity[]): void {
    const active = new Set(identities.map(identityKey));
    for (const [key, record] of this.records) {
      if (active.has(key)) continue;
      this.activeKeys.delete(key);
      this.retiring.set(key, record);
    }
  }

  /** @internal Commit every view resource replacement after a successful submit. */
  _commitResourceReplacement(): void {
    for (const record of this.records.values()) record.view._commitResourceReplacement();
    for (const key of this.pendingPublication) {
      const record = this.records.get(key);
      if (record === undefined) continue;
      record.published = true;
      // A palette-only re-cull keeps the same candidates and view, so its
      // texel count cannot change and does not deserve a readback.
      const recount =
        record.texelCulled === undefined || record.invalidationReason !== 'skin-palette-changed';
      if (record.minCasterDiameter > 0 && recount) void this.observeTexelCulling(key, record);
    }
    this.pendingPublication.clear();
    for (const [key, record] of this.retiring) {
      record.view.dispose();
      this.records.delete(key);
      this.retiring.delete(key);
    }
  }

  /**
   * Abort a staged frame before its queue submit barrier. A candidate view
   * must not become a cache hit merely because graph encoding succeeded: the
   * next frame has to rebuild it after any submit/finish failure.
   */
  _abortResourceReplacement(): void {
    for (const key of this.pendingPublication) {
      const record = this.records.get(key);
      if (record === undefined) continue;
      record.published = false;
      invalidateRecord(record, 'submit-aborted');
    }
    this.pendingPublication.clear();
  }

  /**
   * Read the cull counters a view copied on the compute that was just
   * submitted. Only re-culled views pay a readback; a retained layer keeps
   * the count of the cull that produced it. A pending map makes the next
   * frame skip its telemetry copy, never its raster work.
   */
  private observeTexelCulling(key: string, record: ShadowViewRecord): Promise<void> {
    return record.view.readLodSelection().then((selection) => {
      if (selection !== undefined && this.records.get(key) === record) {
        record.texelCulled = selection.texelCulled;
      }
    });
  }

  inspect(): readonly ShadowViewInspection[] {
    return Object.freeze(
      [...this.records.values()]
        .filter((record) => this.activeKeys.has(identityKey(record.identity)))
        .sort((left, right) =>
          identityKey(left.identity).localeCompare(identityKey(right.identity)),
        )
        .map((record) => {
          const view = record.view.inspect();
          return Object.freeze({
            identity: record.identity,
            cache: record.cache,
            ...(record.cache === 'hit' || record.invalidationReason === undefined
              ? {}
              : { invalidationReason: record.invalidationReason }),
            generation: record.generation,
            sourceRevision: record.sourcePlan.revision,
            candidateCount: record.plan.candidateCount,
            batchCount: record.plan.batches.length,
            resourceGeneration: view.resourceGeneration,
            minCasterDiameter: record.minCasterDiameter,
            ...(record.texelCulled === undefined ? {} : { texelCulled: record.texelCulled }),
            ...(record.cache === 'invalidated' && record.dirtyRects !== undefined
              ? { dirtyRects: record.dirtyRects }
              : {}),
          });
        }),
    );
  }

  dispose(): void {
    const views = new Set([...this.records.values()].map((record) => record.view));
    for (const view of views) view.dispose();
    this.records.clear();
    this.activeKeys.clear();
    this.retiring.clear();
    this.pendingPublication.clear();
  }
}

export { ShadowViewStatePool as GpuDrivenShadowViewPool };

/**
 * Caster classes are renderer-global, so every final view of every light kind
 * retains a static layer; only the static layer itself has none.
 */
export function shadowViewHasStaticLayer(identity: ShadowViewIdentity): boolean {
  return identity.layer === undefined;
}
