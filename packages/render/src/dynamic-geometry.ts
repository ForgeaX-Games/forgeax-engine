import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

/** A standard MeshAsset candidate prepared for one attached World generation. */
export interface DynamicGeometryPrepareInput {
  readonly world: object;
  /** Live ECS entity carrying MeshFilter + MeshRenderer on the attached World. */
  readonly entity?: number;
  /** Optional derived-physics entity whose fixed-step publication gates draw. */
  readonly physicsEntity?: number;
  readonly mesh: MeshAsset;
  /** Existing World.sharedRefs handle whose standard GPU residency is prepared. */
  readonly meshHandle?: Handle<'MeshAsset', 'shared'>;
  readonly revision: number;
  /** Material identity is a consumer fact; MaterialAsset stays in the World. */
  readonly materialIdentity?: string;
  /** Topology changes invalidate motion/history consumers. */
  readonly topologyRevision?: number;
  /** Captured by the Renderer host from the World FixedTime resource. */
  readonly fixedStep?: number;
}

/** Explicit ECS/fixed-step ordering proof used by Renderer admission. */
export interface DynamicGeometryOrdering {
  readonly world: object;
  readonly fixedStep: number;
}

export type DynamicGeometryCandidateState =
  | 'prepared'
  | 'accepted'
  | 'published'
  | 'cancelled'
  | 'retired';

export interface DynamicGeometryCandidate {
  readonly candidateId: string;
  readonly generation: number;
  readonly owner: object;
  readonly world: object;
  readonly entity?: number;
  readonly physicsEntity?: number;
  /** False when the pure lifecycle was used without a shared MeshAsset handle. */
  readonly gpuReady: boolean;
  /** CPU/GPU geometry bytes reserved by this candidate budget. */
  readonly meshBytes: number;
  readonly revision: number;
  readonly topologyRevision: number;
  readonly materialIdentity?: string;
  readonly meshHandle?: Handle<'MeshAsset', 'shared'>;
  readonly fixedStep?: number;
  readonly mesh: MeshAsset;
  readonly state: DynamicGeometryCandidateState;
}

/** Record-stage lane that consumed a published dynamic-geometry candidate. */
export type DynamicGeometryRecordStageLane = 'cpu' | 'gpu' | 'mixed';

/** Receipt that ties candidate publication to the sole Renderer FrameReceipt. */
export interface DynamicGeometryReceipt {
  readonly candidateId: string;
  readonly generation: number;
  readonly revision: number;
  readonly topologyRevision: number;
  readonly fixedStep?: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly frame: {
    readonly frameId: number;
    readonly deviceGeneration: number;
    readonly completed?: Promise<unknown>;
  };
  /** Whether the Renderer record stage consumed this candidate for this frame. */
  readonly recordStageConsumed: boolean;
  /** Lane evidence from the exact submitted record stage, when attached. */
  readonly recordStageLane?: DynamicGeometryRecordStageLane;
  /** Actual frame fixed step; may be newer than the preparation step. */
  readonly publicationFixedStep?: number;
}

export interface DynamicGeometryInspection {
  readonly generation: number;
  readonly prepared: number;
  readonly accepted: number;
  readonly published: number;
  readonly retired: number;
  readonly latestRevision?: number;
  readonly latestFrameId?: number;
  readonly historyInvalidations: number;
  readonly invalidated: number;
  readonly meshBytes: number;
  readonly maxMeshBytes: number;
}

export type DynamicGeometryErrorCode =
  | 'dynamic-geometry-disposed'
  | 'dynamic-geometry-world-not-attached'
  | 'dynamic-geometry-invalid'
  | 'dynamic-geometry-gpu-failed'
  | 'dynamic-geometry-gpu-not-ready'
  | 'dynamic-geometry-budget-exceeded'
  | 'dynamic-geometry-stale'
  | 'dynamic-geometry-generation-mismatch'
  | 'dynamic-geometry-candidate-not-found'
  | 'dynamic-geometry-candidate-state'
  | 'dynamic-geometry-receipt-mismatch'
  | 'dynamic-geometry-ordering-required';

export interface DynamicGeometryErrorDetail {
  readonly code: DynamicGeometryErrorCode;
  readonly candidateId?: string;
  readonly revision?: number;
  readonly generation?: number;
  readonly actual?: unknown;
}

export class DynamicGeometryError extends Error {
  readonly code: DynamicGeometryErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DynamicGeometryErrorDetail;

  constructor(
    code: DynamicGeometryErrorCode,
    expected: string,
    hint: string,
    detail: Omit<DynamicGeometryErrorDetail, 'code'> = {},
  ) {
    super(`${code}: ${expected}`);
    this.name = 'DynamicGeometryError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = Object.freeze({ code, ...detail });
  }
}

interface CandidateRecord {
  readonly world: object;
  candidate: DynamicGeometryCandidate;
  /** Published history remains queryable for its completion fence, but a
   * newer topology must prevent that history from being consumed again. */
  historyInvalidated: boolean;
  acceptedFrame?: { readonly frameId: number; readonly deviceGeneration: number };
}

/**
 * A public candidate is a credential, not a mutable state object. Keep the
 * owner/world check in `current` cheap, then compare every scalar admission
 * fact before a caller can cancel, retire, or inspect another record by
 * copying its candidate id. The renderer-owned MeshAsset copy remains the
 * content source for the actual draw.
 */
export function sameCandidateCredential(
  candidate: DynamicGeometryCandidate,
  committed: DynamicGeometryCandidate,
): boolean {
  return (
    candidate.candidateId === committed.candidateId &&
    candidate.owner === committed.owner &&
    candidate.world === committed.world &&
    candidate.generation === committed.generation &&
    candidate.entity === committed.entity &&
    candidate.physicsEntity === committed.physicsEntity &&
    candidate.gpuReady === committed.gpuReady &&
    candidate.meshBytes === committed.meshBytes &&
    candidate.revision === committed.revision &&
    candidate.topologyRevision === committed.topologyRevision &&
    candidate.materialIdentity === committed.materialIdentity &&
    candidate.meshHandle === committed.meshHandle &&
    candidate.fixedStep === committed.fixedStep
  );
}

function cloneTypedArray<T extends Float32Array | Uint16Array | Uint32Array>(value: T): T {
  return new (value.constructor as new (source: T) => T)(value);
}

function cloneMesh(mesh: MeshAsset): MeshAsset {
  const attributes = Object.fromEntries(
    Object.entries(mesh.attributes).map(([key, value]) => [
      key,
      value instanceof ArrayBuffer
        ? value.slice(0)
        : value === undefined
          ? undefined
          : cloneTypedArray(value as never),
    ]),
  ) as MeshAsset['attributes'];
  return Object.freeze({
    ...mesh,
    vertices: new Float32Array(mesh.vertices),
    ...(mesh.indices === undefined ? {} : { indices: cloneTypedArray(mesh.indices) }),
    attributes,
    ...(mesh.aabb === undefined ? {} : { aabb: new Float32Array(mesh.aabb) }),
    submeshes: Object.freeze(mesh.submeshes.map((submesh) => Object.freeze({ ...submesh }))),
    materialSlots: Object.freeze(mesh.materialSlots.map((slot) => Object.freeze({ ...slot }))),
  });
}

function cloneCandidate(candidate: DynamicGeometryCandidate): DynamicGeometryCandidate {
  return Object.freeze({ ...candidate, mesh: cloneMesh(candidate.mesh) });
}

function validateMesh(mesh: MeshAsset): string | undefined {
  if (mesh.kind !== 'mesh') return 'MeshAsset.kind must be mesh';
  if (!(mesh.vertices instanceof Float32Array) || mesh.vertices.length === 0) {
    return 'MeshAsset.vertices must be a non-empty Float32Array';
  }
  // vertices may be interleaved. Attribute layout validation belongs to the
  // mesh producer/residency path; this gate must not assume an xyz-only stride.
  if (
    mesh.indices !== undefined &&
    !(mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array)
  ) {
    return 'MeshAsset.indices must be Uint16Array or Uint32Array';
  }
  if (mesh.submeshes.length === 0)
    return 'MeshAsset.submeshes must contain at least one topology range';
  if (
    mesh.submeshes.some(
      (submesh) =>
        !Number.isSafeInteger(submesh.materialSlot) ||
        submesh.materialSlot < 0 ||
        submesh.materialSlot >= mesh.materialSlots.length,
    )
  ) {
    return 'MeshAsset.materialSlots must cover every referenced materialSlot';
  }
  if (mesh.vertices.some((value) => !Number.isFinite(value)))
    return 'MeshAsset.vertices must be finite';
  return undefined;
}

function meshByteSize(mesh: MeshAsset): number {
  let bytes = mesh.vertices.byteLength + (mesh.indices?.byteLength ?? 0);
  for (const value of Object.values(mesh.attributes)) {
    if (value instanceof ArrayBuffer) bytes += value.byteLength;
    else if (value !== undefined && ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  if (mesh.aabb !== undefined) bytes += mesh.aabb.byteLength;
  // Submesh/material metadata is intentionally bounded by the candidate
  // count. The reserved byte budget is for typed geometry and GPU upload
  // inputs, which are the resources that can exhaust the renderer.
  return bytes;
}

/**
 * Renderer-owned lifecycle for standard MeshAsset candidates. It deliberately
 * has no device, buffer, queue, or frame clock; the host supplies generation
 * and FrameReceipt facts at the boundaries below.
 */
export interface DynamicGeometryLifecycle {
  prepare(
    input: DynamicGeometryPrepareInput,
    generation: number,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  accept(
    candidate: DynamicGeometryCandidate,
    ordering?: DynamicGeometryOrdering,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  cancel(
    candidate: DynamicGeometryCandidate,
    completion?: Promise<unknown>,
  ): Result<void, DynamicGeometryError>;
  retire(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  /** Release the count/byte budget after receipt-bound GPU cleanup completes. */
  finalizeRetirement(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  receipt(candidate: DynamicGeometryCandidate): DynamicGeometryReceipt | undefined;
  publishFrame(
    frame: {
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly completed?: Promise<unknown>;
    },
    worlds?: readonly object[],
    fixedStep?: number,
    canPublish?: (candidate: DynamicGeometryCandidate) => boolean,
    recordStageLane?: (
      candidate: DynamicGeometryCandidate,
    ) => DynamicGeometryRecordStageLane | undefined,
  ): readonly DynamicGeometryReceipt[];
  invalidateWorld(world: object, completion?: Promise<unknown>): void;
  invalidateGeneration(generation: number): void;
  inspect(): DynamicGeometryInspection;
  dispose(): void;
}

export function createDynamicGeometryLifecycle(
  maxCandidates = 32,
  maxMeshBytes = 64 * 1024 * 1024,
): DynamicGeometryLifecycle {
  const records = new Map<string, CandidateRecord>();
  const owner = {};
  let sequence = 0;
  let currentGeneration = 0;
  let disposed = false;
  let historyInvalidations = 0;
  let latestRevision: number | undefined;
  let latestFrameId: number | undefined;
  let retired = 0;
  let invalidated = 0;
  let meshBytes = 0;
  const latestRevisionByWorld = new WeakMap<object, Map<number | undefined, number>>();
  const latestTopologyRevisionByWorld = new WeakMap<object, Map<number | undefined, number>>();
  const publishedReceipts = new Map<string, DynamicGeometryReceipt>();

  const failure = (
    code: DynamicGeometryErrorCode,
    expected: string,
    hint: string,
    detail: Omit<DynamicGeometryErrorDetail, 'code'> = {},
  ): Result<never, DynamicGeometryError> =>
    err(new DynamicGeometryError(code, expected, hint, detail));

  const current = (candidate: DynamicGeometryCandidate): CandidateRecord | undefined => {
    const record = records.get(candidate.candidateId);
    if (
      record === undefined ||
      candidate.owner !== owner ||
      record.candidate.owner !== candidate.owner ||
      record.candidate.world !== candidate.world ||
      record.candidate.generation !== candidate.generation
    )
      return undefined;
    return record;
  };

  return {
    prepare(input, generation) {
      if (disposed)
        return failure('dynamic-geometry-disposed', 'renderer is alive', 'rebuild the Renderer');
      if (input.world === null || typeof input.world !== 'object') {
        return failure(
          'dynamic-geometry-world-not-attached',
          'candidate belongs to an attached World',
          'attach the World before preparing geometry',
        );
      }
      if (!Number.isInteger(input.revision) || input.revision < 0) {
        return failure(
          'dynamic-geometry-invalid',
          'geometry revision is a non-negative integer',
          'advance the consumer revision monotonically',
          { revision: input.revision },
        );
      }
      if (generation !== currentGeneration && currentGeneration !== 0) {
        return failure(
          'dynamic-geometry-generation-mismatch',
          'candidate uses the active renderer generation',
          'discard stale generation work and prepare again',
          { generation, actual: currentGeneration },
        );
      }
      const inFlight = [...records.values()].reduce(
        (count, record) => count + (record.candidate.state === 'published' ? 0 : 1),
        0,
      );
      if (inFlight >= maxCandidates) {
        return failure(
          'dynamic-geometry-budget-exceeded',
          'candidate count remains within the bounded renderer budget',
          'cancel or retire an earlier candidate before retrying',
          { actual: inFlight },
        );
      }
      const invalid = validateMesh(input.mesh);
      if (invalid !== undefined)
        return failure(
          'dynamic-geometry-invalid',
          'MeshAsset satisfies the standard geometry contract',
          invalid,
        );
      const candidateBytes = meshByteSize(input.mesh);
      if (
        !Number.isSafeInteger(candidateBytes) ||
        candidateBytes < 0 ||
        meshBytes > maxMeshBytes - candidateBytes
      ) {
        return failure(
          'dynamic-geometry-budget-exceeded',
          'candidate mesh bytes remain within the bounded renderer resource budget',
          'cancel or retire an earlier candidate before retrying',
          { actual: { meshBytes, candidateBytes, maxMeshBytes } },
        );
      }
      const candidateId = `mesh:${generation}:${++sequence}:${input.revision}`;
      const candidate: DynamicGeometryCandidate = Object.freeze({
        candidateId,
        generation,
        owner,
        world: input.world,
        ...(input.entity === undefined ? {} : { entity: input.entity }),
        ...(input.physicsEntity === undefined ? {} : { physicsEntity: input.physicsEntity }),
        gpuReady: input.meshHandle !== undefined,
        meshBytes: candidateBytes,
        revision: input.revision,
        topologyRevision: input.topologyRevision ?? input.revision,
        ...(input.materialIdentity === undefined
          ? {}
          : { materialIdentity: input.materialIdentity }),
        ...(input.meshHandle === undefined ? {} : { meshHandle: input.meshHandle }),
        ...(input.fixedStep === undefined ? {} : { fixedStep: input.fixedStep }),
        mesh: cloneMesh(input.mesh),
        state: 'prepared',
      });
      records.set(candidateId, {
        world: input.world,
        candidate,
        historyInvalidated: false,
      });
      meshBytes += candidateBytes;
      currentGeneration = generation;
      // Keep the credential handed to the consumer separate from the
      // renderer-owned copy. Mesh typed arrays remain mutable at runtime even
      // when exposed through a readonly TypeScript field.
      return ok(cloneCandidate(candidate));
    },
    accept(candidate, ordering) {
      if (disposed)
        return failure('dynamic-geometry-disposed', 'renderer is alive', 'rebuild the Renderer');
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'candidate is owned by this renderer',
          'discard the stale credential',
        );
      if (candidate.generation !== currentGeneration) {
        return failure(
          'dynamic-geometry-generation-mismatch',
          'candidate generation matches the active renderer generation',
          'prepare against the current renderer generation',
          { candidateId: candidate.candidateId },
        );
      }
      if (record.candidate.state !== 'prepared') {
        return failure(
          'dynamic-geometry-candidate-state',
          'candidate is prepared exactly once before acceptance',
          'retain the accepted or published receipt',
          { candidateId: candidate.candidateId },
        );
      }
      if (!sameCandidateCredential(candidate, record.candidate)) {
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'acceptance uses the exact prepared candidate credential',
          'discard the altered credential and use the value returned by prepare',
          { candidateId: candidate.candidateId },
        );
      }
      if (ordering !== undefined) {
        if (
          ordering.world !== record.world ||
          !Number.isInteger(ordering.fixedStep) ||
          ordering.fixedStep < 0
        ) {
          return failure(
            'dynamic-geometry-ordering-required',
            'acceptance ordering names the candidate World and a non-negative fixed step',
            'submit the PhysicsWorld publication ordering for the same attached World',
            { candidateId: candidate.candidateId, actual: ordering },
          );
        }
      }
      const newest = [...records.values()]
        .filter(
          (entry) =>
            entry.candidate.candidateId !== candidate.candidateId &&
            entry.world === record.world &&
            entry.candidate.entity === record.candidate.entity &&
            (entry.candidate.state === 'prepared' || entry.candidate.state === 'accepted'),
        )
        .map((entry) => entry.candidate.revision)
        .concat(latestRevisionByWorld.get(record.world)?.get(record.candidate.entity) ?? -1)
        .sort((a, b) => b - a)[0];
      if (newest !== undefined && record.candidate.revision <= newest) {
        return failure(
          'dynamic-geometry-stale',
          'accepted geometry revision is newer than the active candidate',
          'advance topology revision before accepting',
          { candidateId: candidate.candidateId },
        );
      }
      const accepted = Object.freeze({
        ...record.candidate,
        ...(ordering === undefined ? {} : { fixedStep: ordering.fixedStep }),
        state: 'accepted' as const,
      });
      const previousTopologies = [...records.values()]
        .filter(
          (entry) =>
            entry.candidate.candidateId !== candidate.candidateId &&
            entry.world === record.world &&
            entry.candidate.entity === record.candidate.entity,
        )
        .map((entry) => entry.candidate.topologyRevision);
      const previousLatestTopology = latestTopologyRevisionByWorld
        .get(record.world)
        ?.get(record.candidate.entity);
      const newestTopology = previousTopologies
        .concat(previousLatestTopology === undefined ? [] : [previousLatestTopology])
        .sort((a, b) => b - a)[0];
      if (newestTopology !== undefined && accepted.topologyRevision < newestTopology) {
        return failure(
          'dynamic-geometry-stale',
          'accepted topology revision is not older than the active geometry history',
          'advance topology revision before accepting a replacement candidate',
          { candidateId: candidate.candidateId },
        );
      }
      if (newestTopology !== undefined && accepted.topologyRevision > newestTopology) {
        historyInvalidations += 1;
        // Invalidate publication eligibility, not resource ownership. The host
        // cancels superseded candidates with their allocation completion fence.
        for (const previous of records.values()) {
          if (
            previous.world !== record.world ||
            previous.candidate.entity !== record.candidate.entity ||
            previous.candidate.candidateId === candidate.candidateId ||
            previous.candidate.topologyRevision >= accepted.topologyRevision
          )
            continue;
          if (!previous.historyInvalidated) {
            previous.historyInvalidated = true;
            invalidated += 1;
          }
        }
      }
      record.candidate = accepted;
      return ok(cloneCandidate(accepted));
    },
    cancel(candidate, completion) {
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'candidate is owned by this renderer',
          'discard the stale credential',
        );
      if (!sameCandidateCredential(candidate, record.candidate))
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'cancellation uses the exact prepared candidate credential',
          'discard the altered credential and use the value returned by prepare',
          { candidateId: candidate.candidateId },
        );
      if (record.candidate.state !== 'prepared' && record.candidate.state !== 'accepted') {
        return failure(
          'dynamic-geometry-candidate-state',
          'only prepared or accepted geometry can be cancelled once',
          'retire published geometry or await the existing terminal cleanup',
        );
      }
      record.candidate = Object.freeze({ ...record.candidate, state: 'cancelled' as const });
      const release = (): void => {
        if (records.get(candidate.candidateId) !== record) return;
        records.delete(candidate.candidateId);
        meshBytes = Math.max(0, meshBytes - record.candidate.meshBytes);
      };
      if (completion === undefined) release();
      else void completion.then(release, release);
      return ok(undefined);
    },
    retire(candidate) {
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'retirement uses a published candidate owned by this renderer',
          'discard the stale credential and do not evict any unrelated mesh',
          { candidateId: candidate.candidateId },
        );
      if (!sameCandidateCredential(candidate, record.candidate))
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'retirement uses the exact published candidate credential',
          'discard the altered credential and use the value returned by publish',
          { candidateId: candidate.candidateId },
        );
      if (record.candidate.state !== 'published') {
        return failure(
          'dynamic-geometry-candidate-state',
          'only published geometry can enter receipt-bound retirement',
          'publish the candidate from a submitted frame first',
        );
      }
      record.candidate = Object.freeze({ ...record.candidate, state: 'retired' as const });
      publishedReceipts.delete(candidate.candidateId);
      retired += 1;
      // Retiring is the logical state transition. Keep the candidate record
      // and its typed bytes until the owner calls `finalizeRetirement` after
      // every record-stage completion fence and GPU lease are gone. This is
      // what makes the transient count and total byte budgets include this work.
      return ok(undefined);
    },
    finalizeRetirement(candidate) {
      const record = current(candidate);
      if (record === undefined)
        return failure(
          'dynamic-geometry-candidate-not-found',
          'retirement finalization uses a candidate retained by this lifecycle',
          'discard the stale credential or finish the current receipt-bound retirement',
        );
      if (!sameCandidateCredential(candidate, record.candidate))
        return failure(
          'dynamic-geometry-receipt-mismatch',
          'retirement finalization uses the exact published candidate credential',
          'discard the altered credential and use the value returned by publication',
          { candidateId: candidate.candidateId },
        );
      if (record.candidate.state !== 'retired')
        return failure(
          'dynamic-geometry-candidate-state',
          'only a retired candidate can release its deferred budget',
          'retire the published candidate before finalizing its receipt-bound cleanup',
          { candidateId: candidate.candidateId },
        );
      records.delete(candidate.candidateId);
      meshBytes = Math.max(0, meshBytes - record.candidate.meshBytes);
      return ok(undefined);
    },
    publishFrame(frame, worlds, fixedStep, canPublish, recordStageLane) {
      if (disposed || frame.deviceGeneration !== currentGeneration) return [];
      const receipts: DynamicGeometryReceipt[] = [];
      for (const record of records.values()) {
        const canRepeatPublished =
          record.candidate.state === 'published' &&
          // Attached Renderer publication revalidates the entity binding in
          // `canPublish`, so a history-invalidated candidate can still record
          // a real draw for its live entity. Detached lifecycle publication
          // remains one-shot once that history is invalidated.
          (canPublish !== undefined || !record.historyInvalidated);
        if (record.candidate.state !== 'accepted' && !canRepeatPublished) continue;
        if (worlds !== undefined && !worlds.includes(record.world)) continue;
        if (
          record.candidate.fixedStep !== undefined &&
          (fixedStep === undefined || record.candidate.fixedStep > fixedStep)
        ) {
          continue;
        }
        if (canPublish !== undefined && !canPublish(record.candidate)) continue;
        const consumedLane =
          canPublish === undefined ? undefined : recordStageLane?.(record.candidate);
        record.candidate = Object.freeze({ ...record.candidate, state: 'published' as const });
        const receipt = Object.freeze({
          candidateId: record.candidate.candidateId,
          generation: record.candidate.generation,
          revision: record.candidate.revision,
          topologyRevision: record.candidate.topologyRevision,
          ...(record.candidate.fixedStep === undefined
            ? {}
            : { fixedStep: record.candidate.fixedStep }),
          frameId: frame.frameId,
          deviceGeneration: frame.deviceGeneration,
          recordStageConsumed: canPublish !== undefined,
          ...(consumedLane === undefined ? {} : { recordStageLane: consumedLane }),
          ...(fixedStep === undefined ? {} : { publicationFixedStep: fixedStep }),
          frame: Object.freeze({ ...frame }),
        });
        receipts.push(receipt);
        publishedReceipts.set(record.candidate.candidateId, receipt);
        latestRevision = record.candidate.revision;
        latestFrameId = frame.frameId;
        if (!latestRevisionByWorld.has(record.world))
          latestRevisionByWorld.set(record.world, new Map());
        latestRevisionByWorld
          .get(record.world)
          ?.set(record.candidate.entity, record.candidate.revision);
        if (!latestTopologyRevisionByWorld.has(record.world))
          latestTopologyRevisionByWorld.set(record.world, new Map());
        latestTopologyRevisionByWorld
          .get(record.world)
          ?.set(record.candidate.entity, record.candidate.topologyRevision);
      }
      return receipts;
    },
    invalidateWorld(world, completion) {
      for (const [id, record] of records) {
        if (record.world !== world) continue;
        // An earlier terminal operation already owns this reservation's fence.
        if (record.candidate.state === 'cancelled' || record.candidate.state === 'retired')
          continue;
        publishedReceipts.delete(id);
        record.candidate = Object.freeze({ ...record.candidate, state: 'cancelled' as const });
        const release = (): void => {
          if (records.get(id) !== record) return;
          records.delete(id);
          meshBytes = Math.max(0, meshBytes - record.candidate.meshBytes);
        };
        if (completion === undefined) release();
        else void completion.then(release, release);
        invalidated += 1;
      }
      latestRevisionByWorld.delete(world);
      latestTopologyRevisionByWorld.delete(world);
    },
    invalidateGeneration(generation) {
      if (generation === currentGeneration) return;
      currentGeneration = generation;
      const invalidatedWorlds = new Set<object>();
      for (const [id, record] of records) {
        if (record.candidate.generation !== generation) {
          records.delete(id);
          publishedReceipts.delete(id);
          meshBytes = Math.max(0, meshBytes - record.candidate.meshBytes);
          invalidatedWorlds.add(record.world);
          invalidated += 1;
        }
      }
      for (const world of invalidatedWorlds) {
        latestRevisionByWorld.delete(world);
        latestTopologyRevisionByWorld.delete(world);
      }
    },
    receipt(candidate) {
      const receipt = publishedReceipts.get(candidate.candidateId);
      const record = records.get(candidate.candidateId);
      if (record === undefined || !sameCandidateCredential(candidate, record.candidate)) {
        return undefined;
      }
      return receipt?.generation === candidate.generation ? receipt : undefined;
    },
    inspect() {
      let prepared = 0;
      let accepted = 0;
      let published = 0;
      for (const record of records.values()) {
        if (record.candidate.state === 'prepared') prepared += 1;
        else if (record.candidate.state === 'accepted') accepted += 1;
        else if (record.candidate.state === 'published') published += 1;
      }
      return Object.freeze({
        generation: currentGeneration,
        prepared,
        accepted,
        published,
        retired,
        ...(latestRevision === undefined ? {} : { latestRevision }),
        ...(latestFrameId === undefined ? {} : { latestFrameId }),
        historyInvalidations,
        invalidated,
        meshBytes,
        maxMeshBytes,
      });
    },
    dispose() {
      disposed = true;
      records.clear();
      publishedReceipts.clear();
      meshBytes = 0;
    },
  };
}
