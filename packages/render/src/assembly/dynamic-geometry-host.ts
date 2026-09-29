import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { FixedTime } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { err, type Handle, ok, type Result } from '@forgeax/engine-types';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { ResidencyLease } from '../device/residency-lifetime';
import {
  createDynamicGeometryLifecycle,
  type DynamicGeometryCandidate,
  DynamicGeometryError,
  type DynamicGeometryLifecycle,
  type DynamicGeometryOrdering,
  type DynamicGeometryPrepareInput,
  type DynamicGeometryReceipt,
  type DynamicGeometryRecordStageLane,
  sameCandidateCredential,
} from '../dynamic-geometry';

export interface DynamicGeometryHostImplementation {
  prepareDynamicGeometry(
    input: DynamicGeometryPrepareInput,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  acceptDynamicGeometry(
    candidate: DynamicGeometryCandidate,
    ordering: DynamicGeometryOrdering,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError>;
  /**
   * Atomically swap distinct entities in one attached World. Returned failures
   * retain old bindings; an uncertain rollback throws to require paired rebuild.
   * Invoke inside PhysicsWorld.admitDerivedShapeCandidates commitGeometry.
   */
  acceptDynamicGeometryCandidates(
    candidates: readonly DynamicGeometryCandidate[],
    ordering: DynamicGeometryOrdering,
  ): Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>;
  dynamicGeometryReceipt(candidate: DynamicGeometryCandidate): DynamicGeometryReceipt | undefined;
  cancelDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  retireDynamicGeometry(candidate: DynamicGeometryCandidate): Result<void, DynamicGeometryError>;
  /** @internal Detach cleanup keeps candidate GPU residency receipt-safe. */
  invalidateDynamicGeometryWorld(world: World): void;
  /** Publish only candidates consumed by the attached ECS render snapshot. */
  publishDynamicGeometry(
    frame: {
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly completed?: Promise<unknown>;
    },
    worlds?: readonly object[],
    fixedStep?: number,
  ): readonly DynamicGeometryReceipt[];
}

interface PhysicsPublicationLike {
  readonly revision: number;
  readonly fixedStep: number;
}

interface HostCandidateRecord {
  candidate: DynamicGeometryCandidate;
  readonly world: World;
  readonly entity: number;
  readonly previousMeshHandle: Handle<'MeshAsset', 'shared'>;
  readonly meshHandle: Handle<'MeshAsset', 'shared'>;
  readonly residency: ResidencyLease | undefined;
  readonly generation: number;
  /** Renderer lease retained while the candidate is staged but not ECS-owned. */
  meshLeaseHeld: boolean;
  /** Previous ECS MeshFilter lease retained until the candidate lifecycle ends. */
  previousMeshLeaseHeld: boolean;
  accepted: boolean;
  published: boolean;
}

function fixedStepOf(world: World): number | undefined {
  try {
    return world.getResource(FixedTime).tick;
  } catch {
    return undefined;
  }
}

function hasRenderableBinding(world: World, entity: number | undefined): boolean {
  if (entity === undefined || !Number.isInteger(entity)) return false;
  const transform = world.get(entity as EntityHandle, Transform);
  const mesh = world.get(entity as EntityHandle, MeshFilter);
  const material = world.get(entity as EntityHandle, MeshRenderer);
  if (!transform.ok || !mesh.ok || !material.ok) return false;
  return true;
}

function meshHandleOf(
  world: World,
  entity: number | undefined,
): Handle<'MeshAsset', 'shared'> | undefined {
  if (entity === undefined || !Number.isInteger(entity)) return undefined;
  const mesh = world.get(entity as EntityHandle, MeshFilter);
  if (!mesh.ok) return undefined;
  return (mesh.value as { readonly assetHandle?: Handle<'MeshAsset', 'shared'> }).assetHandle;
}

function hasMaterialIdentity(
  world: World,
  entity: number | undefined,
  mesh: DynamicGeometryPrepareInput['mesh'],
  identity: string | undefined,
): boolean {
  if (identity === undefined) return true;
  const normalized = identity.trim();
  if (normalized.length === 0 || entity === undefined) return false;
  const material = world.get(entity as EntityHandle, MeshRenderer);
  if (!material.ok) return false;
  const values = (material.value as { readonly materials?: readonly unknown[] }).materials ?? [];
  if (
    mesh.materialSlots.some((slot) => slot.sourceKey === normalized || slot.slotName === normalized)
  )
    return true;
  if (
    mesh.materialSlots.some(
      (slot) =>
        slot.defaultMaterial !== undefined &&
        AssetGuid.format(slot.defaultMaterial).toLowerCase() === normalized.toLowerCase(),
    )
  )
    return true;
  return values.some((value) => {
    if (String(value) === normalized) return true;
    try {
      const resolved = world.sharedRefs.resolve(value as never);
      if (!resolved.ok || typeof resolved.value !== 'object' || resolved.value === null)
        return false;
      const payload = resolved.value as { readonly sourceKey?: unknown; readonly guid?: unknown };
      return payload.sourceKey === normalized || payload.guid === normalized;
    } catch {
      return false;
    }
  });
}

function hasMeshBinding(world: World, handle: number): boolean {
  try {
    const query = world.query({ read: [MeshFilter] }).unwrap();
    for (const row of query) {
      if (Number(row.get(MeshFilter).assetHandle) === handle) return true;
    }
  } catch {
    // An already-detached World cannot own a live binding, so eviction is
    // safe. Normal attached Worlds take the query path above.
  }
  return false;
}

function ownsMeshPayload(
  world: World,
  meshHandle: DynamicGeometryPrepareInput['meshHandle'],
  mesh: DynamicGeometryPrepareInput['mesh'],
): boolean {
  if (meshHandle === undefined) return false;
  try {
    const resolved = world.sharedRefs.resolve(meshHandle);
    return resolved.ok && resolved.value === mesh;
  } catch {
    return false;
  }
}

function physicsPublicationOf(
  world: World,
  entity: number,
  admitting = false,
): PhysicsPublicationLike | undefined {
  try {
    const physics = world.getResource<{
      readonly getDerivedPublication?: (body: number) => PhysicsPublicationLike | undefined;
      readonly getDerivedAdmission?: (body: number) => PhysicsPublicationLike | undefined;
    }>('PhysicsWorld');
    return admitting
      ? physics.getDerivedAdmission?.(entity)
      : physics.getDerivedPublication?.(entity);
  } catch {
    return undefined;
  }
}

export function createDynamicGeometryHost(options: {
  readonly lifecycle: DynamicGeometryLifecycle;
  readonly attachedWorlds: ReadonlySet<World>;
  /** Resolve the store owned by the current Renderer device generation. */
  readonly getGpuStore: () => GpuResidencyCache;
  readonly currentGeneration: () => number;
  /** Renderer record-stage proof for the most recently submitted frame. */
  readonly isConsumedByRenderFrame: (candidate: DynamicGeometryCandidate) => boolean;
  /** Renderer-owned lane fact for the most recently submitted frame. */
  readonly recordStageLane?: (
    candidate: DynamicGeometryCandidate,
  ) => DynamicGeometryRecordStageLane | undefined;
  /** Existing temporal owner discards the old surface history after an ECS swap. */
  readonly onTopologyChanged?: () => void;
}): DynamicGeometryHostImplementation {
  const {
    lifecycle,
    attachedWorlds,
    getGpuStore,
    currentGeneration,
    isConsumedByRenderFrame,
    recordStageLane = () => undefined,
  } = options;
  const hostCandidates = new Map<string, HostCandidateRecord>();
  let observedGeneration = -1;
  const releaseMeshLease = (record: HostCandidateRecord): DynamicGeometryError | undefined => {
    if (!record.meshLeaseHeld) return undefined;
    const released = record.world.sharedRefs.release(record.meshHandle);
    if (!released.ok) {
      return new DynamicGeometryError(
        'dynamic-geometry-invalid',
        'the Renderer candidate lease remains a live World shared reference',
        'retain the MeshAsset handle until candidate cancellation or ECS acceptance completes',
        { candidateId: record.candidate.candidateId, actual: released.error },
      );
    }
    record.meshLeaseHeld = false;
    return undefined;
  };
  const releasePreviousMeshLease = (
    record: HostCandidateRecord,
  ): DynamicGeometryError | undefined => {
    if (!record.previousMeshLeaseHeld) return undefined;
    const released = record.world.sharedRefs.release(record.previousMeshHandle);
    if (!released.ok) {
      return new DynamicGeometryError(
        'dynamic-geometry-invalid',
        'the previous ECS MeshFilter binding remains a live World shared reference',
        'retain the previous MeshAsset until candidate cancellation, retirement, or invalidation completes',
        { candidateId: record.candidate.candidateId, actual: released.error },
      );
    }
    record.previousMeshLeaseHeld = false;
    return undefined;
  };
  const releaseMeshLeases = (record: HostCandidateRecord): DynamicGeometryError | undefined => {
    const candidateError = releaseMeshLease(record);
    const previousError = releasePreviousMeshLease(record);
    return candidateError ?? previousError;
  };
  const synchronizeGeneration = (): number => {
    const generation = currentGeneration();
    lifecycle.invalidateGeneration(generation);
    if (observedGeneration !== generation) {
      for (const [candidateId, record] of hostCandidates) {
        if (record.generation !== generation) {
          hostCandidates.delete(candidateId);
          // The old DeviceScope owns the GPU destruction. The World shared
          // reference is independent and must be released here even when a
          // generation changes before the next explicit cancellation.
          scheduleCandidateCleanup(record, true);
        }
      }
      observedGeneration = generation;
    }
    return generation;
  };
  const candidateRecord = (
    candidate: DynamicGeometryCandidate,
  ): HostCandidateRecord | undefined => {
    const record = hostCandidates.get(candidate.candidateId);
    if (record === undefined || !sameCandidateCredential(candidate, record.candidate))
      return undefined;
    return record;
  };
  const cleanupCandidateResidency = (
    record: HostCandidateRecord,
    force = false,
  ): Promise<void> | undefined =>
    record.residency?.release(force || !hasMeshBinding(record.world, record.meshHandle));
  const scheduleCandidateCleanup = (
    record: HostCandidateRecord,
    force = false,
  ): Promise<void> | undefined => {
    hostCandidates.delete(record.candidate.candidateId);
    const completion = cleanupCandidateResidency(record, force);
    const finish = (): void => {
      releaseMeshLeases(record);
      lifecycle.finalizeRetirement(record.candidate);
      if (hostCandidates.get(record.candidate.candidateId) === record)
        hostCandidates.delete(record.candidate.candidateId);
    };
    if (completion === undefined) finish();
    else void completion.then(finish, finish);
    return completion;
  };
  const acceptCandidate = (
    candidate: DynamicGeometryCandidate,
    ordering: DynamicGeometryOrdering,
    deferredSupersession?: Set<HostCandidateRecord>,
  ): Result<DynamicGeometryCandidate, DynamicGeometryError> => {
    synchronizeGeneration();
    const world = candidate.world as World;
    const hostRecordById = hostCandidates.get(candidate.candidateId);
    const hostRecord = candidateRecord(candidate);
    if (hostRecord === undefined && hostRecordById !== undefined)
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-receipt-mismatch',
          'admission uses the exact host candidate owner and lifecycle credential',
          'discard the altered credential and use the value returned by preparation',
          { candidateId: candidate.candidateId },
        ),
      );
    if (hostRecord !== undefined && candidate.state !== 'prepared')
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-candidate-state',
          'admission consumes a prepared candidate exactly once',
          'retain the accepted or published candidate receipt instead of admitting it again',
          { candidateId: candidate.candidateId },
        ),
      );
    if (ordering === undefined || !attachedWorlds.has(world) || ordering.world !== candidate.world)
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-world-not-attached',
          'candidate and fixed-step ordering belong to the same attached World',
          'attach the World and submit its PhysicsWorld ordering before accepting geometry',
          { candidateId: candidate.candidateId },
        ),
      );
    if (!candidate.gpuReady)
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-gpu-not-ready',
          'candidate has standard GPU residency before acceptance',
          'prepare with an existing MeshAsset shared handle and repair residency failures',
          { candidateId: candidate.candidateId },
        ),
      );
    if (
      hostRecord === undefined ||
      !hasRenderableBinding(world, candidate.entity) ||
      !hasMaterialIdentity(world, candidate.entity, candidate.mesh, candidate.materialIdentity)
    )
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'the candidate is bound to a live ECS MeshFilter and MeshRenderer',
          'keep the candidate MeshFilter binding intact until the consuming draw',
          { candidateId: candidate.candidateId },
        ),
      );
    if (meshHandleOf(world, candidate.entity) !== hostRecord.previousMeshHandle)
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'the old MeshFilter binding remains visible until candidate acceptance',
          'do not replace the live ECS binding while geometry is prepared',
          { candidateId: candidate.candidateId },
        ),
      );
    const currentFixedStep = fixedStepOf(world);
    if (
      currentFixedStep === undefined ||
      candidate.fixedStep === undefined ||
      candidate.fixedStep > currentFixedStep ||
      ordering.fixedStep !== currentFixedStep
    )
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-ordering-required',
          'ordering matches the current World tick, no earlier than preparation',
          'accept a prepared candidate during the current fixed-step admission',
          {
            candidateId: candidate.candidateId,
            actual: {
              candidate: candidate.fixedStep,
              currentFixedStep,
              ordering: ordering.fixedStep,
            },
          },
        ),
      );
    if (candidate.physicsEntity !== undefined) {
      const publication = physicsPublicationOf(world, candidate.physicsEntity, true);
      if (
        publication === undefined ||
        publication.fixedStep !== currentFixedStep ||
        publication.revision !== candidate.revision
      )
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-ordering-required',
            'candidate physicsEntity has the active paired PhysicsWorld admission',
            'accept geometry inside admitDerivedShapeCandidate commitGeometry, before physics step',
            { candidateId: candidate.candidateId, actual: publication },
          ),
        );
    }
    // One ECS MeshFilter has one visible geometry owner.  Once this
    // candidate is accepted, any older prepared/accepted candidate for the
    // same entity can no longer become a receipt-bearing draw. Cancel it
    // after the new ECS swap so its candidate-only residency is no longer
    // protected as the live draw owner. Published candidates stay
    // receipt-bound and are retired independently.
    const superseded = [...hostCandidates.values()].filter(
      (record) =>
        record.candidate.candidateId !== candidate.candidateId &&
        record.world === world &&
        record.entity === candidate.entity &&
        !record.published,
    );
    const accepted = lifecycle.accept(candidate, ordering);
    if (!accepted.ok) return accepted;
    const swapped = world.set(candidate.entity as EntityHandle, MeshFilter, {
      assetHandle: hostRecord.meshHandle,
    });
    if (!swapped.ok) {
      lifecycle.cancel(accepted.value);
      hostCandidates.delete(candidate.candidateId);
      cleanupCandidateResidency(hostRecord);
      const released = releaseMeshLeases(hostRecord);
      if (released !== undefined) return err(released);
      return err(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'the candidate MeshFilter swap commits through the ECS write barrier',
          'restore the live entity and retry from a fresh candidate',
          { candidateId: candidate.candidateId, actual: swapped.error },
        ),
      );
    }
    hostRecord.candidate = accepted.value;
    hostRecord.accepted = true;
    if (deferredSupersession === undefined) options.onTopologyChanged?.();
    // Keep the World handle leased through the final GPU submission; its slot
    // must not be reused while a retired frame still references the old mesh.
    // Cleanup happens only after the new ECS MeshFilter is visible. Before
    // the swap, hasMeshBinding intentionally protects the older candidate's
    // GPU copy because it is still the live draw owner.
    if (deferredSupersession !== undefined) {
      for (const record of superseded) deferredSupersession.add(record);
      return accepted;
    }
    for (const record of superseded) {
      const completion = cleanupCandidateResidency(record);
      const cancelled = lifecycle.cancel(record.candidate, completion);
      if (!cancelled.ok && cancelled.error.code !== 'dynamic-geometry-candidate-not-found') {
        const restored = world.set(candidate.entity as EntityHandle, MeshFilter, {
          assetHandle: hostRecord.previousMeshHandle,
        });
        lifecycle.cancel(accepted.value);
        hostCandidates.delete(candidate.candidateId);
        cleanupCandidateResidency(hostRecord);
        releasePreviousMeshLease(hostRecord);
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'candidate supersession cancels the prior credential atomically',
            'keep the prior ECS binding and candidate lifecycle intact when supersession fails',
            {
              candidateId: candidate.candidateId,
              actual: {
                cancelled: cancelled.error,
                restored: restored.ok ? undefined : restored.error,
              },
            },
          ),
        );
      }
      hostCandidates.delete(record.candidate.candidateId);
      scheduleCandidateCleanup(record);
    }
    return accepted;
  };
  const host: DynamicGeometryHostImplementation = {
    prepareDynamicGeometry(input) {
      const generation = synchronizeGeneration();
      const world = input.world as World;
      if (!attachedWorlds.has(world))
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-world-not-attached',
            'the candidate World is attached to this Renderer',
            'call renderer.attach(world) before preparing dynamic geometry',
          ),
        );
      if (input.entity === undefined || !hasRenderableBinding(world, input.entity)) {
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'the candidate entity and MeshAsset payload belong to the attached World',
            'attach MeshFilter/MeshRenderer and pass the payload resolved by its World shared handle',
            { actual: { entity: input.entity, meshHandle: input.meshHandle } },
          ),
        );
      }
      if (input.meshHandle === undefined)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-gpu-not-ready',
            'the standard MeshAsset shared handle is present before Renderer admission',
            'allocate the MeshAsset through world.allocSharedRef and retry after asset projection',
            { actual: { entity: input.entity, meshHandle: input.meshHandle } },
          ),
        );
      const meshHandle = input.meshHandle;
      if (
        !ownsMeshPayload(world, meshHandle, input.mesh) ||
        !hasMaterialIdentity(world, input.entity, input.mesh, input.materialIdentity)
      ) {
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'the candidate MeshAsset and material identity belong to the attached World',
            'pass the payload resolved by its World shared handle and its live material slot identity',
            { actual: { entity: input.entity, meshHandle } },
          ),
        );
      }
      const fixedStep = fixedStepOf(world);
      if (fixedStep === undefined) {
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-ordering-required',
            'the attached World exposes its ECS FixedTime resource',
            'prepare geometry from an initialized World fixed-step schedule',
          ),
        );
      }
      const previousMeshHandle = meshHandleOf(world, input.entity);
      if (previousMeshHandle === undefined) {
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'the prepared entity retains a live MeshFilter binding',
            'keep the ECS render entity alive while staging geometry',
            { actual: { entity: input.entity } },
          ),
        );
      }
      const previousRetained = world.sharedRefs.retain(previousMeshHandle);
      if (!previousRetained.ok)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'the previous ECS MeshFilter binding remains live for Renderer preparation',
            'retain the current MeshAsset handle before staging replacement geometry',
            { actual: previousRetained.error },
          ),
        );
      const retained = world.sharedRefs.retain(meshHandle);
      if (!retained.ok) {
        const releasedPrevious = world.sharedRefs.release(previousMeshHandle);
        return releasedPrevious.ok
          ? err(
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'the candidate MeshAsset shared reference remains live for Renderer preparation',
                'retain the World-owned MeshAsset handle before staging a candidate',
                { actual: retained.error },
              ),
            )
          : err(
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'candidate preparation leaves both MeshAsset leases recoverable',
                'repair the World shared references before retrying geometry preparation',
                { actual: { candidate: retained.error, previous: releasedPrevious.error } },
              ),
            );
      }
      const releaseRetained = (): DynamicGeometryError | undefined => {
        const releasedCandidate = world.sharedRefs.release(meshHandle);
        const releasedPrevious = world.sharedRefs.release(previousMeshHandle);
        if (!releasedCandidate.ok || !releasedPrevious.ok)
          return new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'failed candidate preparation releases both World shared-reference leases',
            'repair the World shared references before retrying geometry preparation',
            {
              actual: {
                candidate: releasedCandidate.ok ? undefined : releasedCandidate.error,
                previous: releasedPrevious.ok ? undefined : releasedPrevious.error,
              },
            },
          );
        return undefined;
      };
      const prepared = lifecycle.prepare({ ...input, fixedStep }, generation);
      if (!prepared.ok) {
        const released = releaseRetained();
        return released === undefined ? prepared : err(released);
      }
      const residencyStore = getGpuStore();
      const resident = residencyStore.ensureResident(
        meshHandle,
        prepared.value.mesh,
        input.world as World,
      );
      if (!resident.ok) {
        lifecycle.cancel(prepared.value);
        cleanupCandidateResidency({
          candidate: prepared.value,
          world,
          entity: input.entity,
          previousMeshHandle,
          meshHandle,
          residency: undefined,
          generation,
          accepted: false,
          published: false,
          meshLeaseHeld: true,
          previousMeshLeaseHeld: true,
        });
        const released = releaseMeshLeases({
          candidate: prepared.value,
          world,
          entity: input.entity,
          previousMeshHandle,
          meshHandle,
          residency: undefined,
          generation,
          accepted: false,
          published: false,
          meshLeaseHeld: true,
          previousMeshLeaseHeld: true,
        });
        if (released !== undefined) return err(released);
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-gpu-failed',
            'the standard MeshAsset has GPU residency for the active device generation',
            'wait for Renderer.initialization or repair the RHI resource failure before retrying',
            { candidateId: prepared.value.candidateId, actual: resident.error },
          ),
        );
      }
      const residency = residencyStore.retainMeshResidency(meshHandle, world);
      if (residency === undefined) {
        lifecycle.cancel(prepared.value);
        residencyStore.invalidateMesh(meshHandle, world);
        const released = releaseRetained();
        return released === undefined
          ? err(
              new DynamicGeometryError(
                'dynamic-geometry-gpu-failed',
                'the standard MeshAsset retains a shared GPU residency owner',
                'repair the active GPU residency before retrying geometry preparation',
                { candidateId: prepared.value.candidateId },
              ),
            )
          : err(released);
      }
      hostCandidates.set(prepared.value.candidateId, {
        candidate: prepared.value,
        world,
        entity: input.entity as number,
        previousMeshHandle,
        meshHandle,
        residency,
        generation,
        meshLeaseHeld: true,
        previousMeshLeaseHeld: true,
        accepted: false,
        published: false,
      });
      return prepared;
    },
    acceptDynamicGeometry: (candidate, ordering) => acceptCandidate(candidate, ordering),
    acceptDynamicGeometryCandidates(candidates, ordering) {
      synchronizeGeneration();
      // The existing lifecycle's candidate budget bounds this group; there is
      // no second queue or independently tunable batch allocation limit.
      if (
        candidates.length === 0 ||
        candidates.length > hostCandidates.size ||
        new Set(candidates.map((candidate) => candidate.entity)).size !== candidates.length ||
        candidates.some(
          (candidate) =>
            candidate.world !== ordering?.world || candidateRecord(candidate) === undefined,
        )
      )
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'a geometry group contains owned candidates for distinct entities in one World',
            'prepare one candidate per entity and accept the nonempty group in its paired physics admission',
          ),
        );
      const accepted: DynamicGeometryCandidate[] = [];
      const superseded = new Set<HostCandidateRecord>();
      const rollback = (): void => {
        const failures: DynamicGeometryError[] = [];
        for (const candidate of [...accepted].reverse()) {
          const result = host.cancelDynamicGeometry(candidate);
          if (!result.ok) failures.push(result.error);
        }
        // A returned failure promises old state. A throw deliberately routes
        // the paired PhysicsWorld into rebuild-required when that proof fails.
        if (failures.length > 0)
          throw new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'a failed geometry group restores every previous ECS binding',
            'rebuild the paired World and Renderer before rendering or querying physics',
            { actual: failures },
          );
      };
      for (const candidate of candidates) {
        const result = acceptCandidate(candidate, ordering, superseded);
        if (!result.ok) {
          rollback();
          return err(result.error);
        }
        accepted.push(result.value);
      }
      // Keep all previous unpublished credentials and leases until every ECS
      // swap succeeds, so a kth-member rejection can still draw the old group.
      for (const record of superseded) {
        const completion = cleanupCandidateResidency(record);
        const result = lifecycle.cancel(record.candidate, completion);
        if (!result.ok && result.error.code !== 'dynamic-geometry-candidate-not-found')
          throw result.error;
        scheduleCandidateCleanup(record);
      }
      options.onTopologyChanged?.();
      return ok(Object.freeze(accepted));
    },
    dynamicGeometryReceipt(candidate) {
      synchronizeGeneration();
      return lifecycle.receipt(candidate);
    },
    cancelDynamicGeometry(candidate) {
      synchronizeGeneration();
      const record = candidateRecord(candidate);
      if (record === undefined) {
        // A candidate id is not an authority. If this host still has that id,
        // reject the forged owner/lifecycle credential before touching ECS or
        // delegating to the lifecycle state machine.
        if (hostCandidates.has(candidate.candidateId))
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-receipt-mismatch',
              'cancellation uses the exact host candidate owner and lifecycle credential',
              'discard the altered credential and use the value returned by preparation',
              { candidateId: candidate.candidateId },
            ),
          );
        return lifecycle.cancel(candidate);
      }
      if (
        (!record.accepted && candidate.state !== 'prepared') ||
        (record.accepted && !record.published && candidate.state !== 'accepted') ||
        (record.published && candidate.state !== 'accepted' && candidate.state !== 'published')
      )
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-receipt-mismatch',
            'cancellation uses the candidate state issued by the host lifecycle',
            'discard the altered credential and use the value returned by preparation or acceptance',
            { candidateId: candidate.candidateId },
          ),
        );
      if (record.published)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-candidate-state',
            'published geometry remains until its receipt retires',
            'retire the receipt-bound candidate instead of cancelling it',
            { candidateId: candidate.candidateId },
          ),
        );
      if (record.accepted) {
        const currentHandle = meshHandleOf(record.world, record.entity);
        if (currentHandle !== record.meshHandle && currentHandle !== record.previousMeshHandle)
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-invalid',
              'cancel does not overwrite a newer ECS MeshFilter binding',
              'reconcile the live entity before cancelling this candidate',
              { candidateId: candidate.candidateId },
            ),
          );
        if (currentHandle === record.meshHandle) {
          const restored = record.world.set(record.entity as EntityHandle, MeshFilter, {
            assetHandle: record.previousMeshHandle,
          });
          if (!restored.ok)
            return err(
              new DynamicGeometryError(
                'dynamic-geometry-invalid',
                'cancel restores the previous MeshFilter through the ECS write barrier',
                'restore the entity before retrying cancellation',
                { candidateId: candidate.candidateId, actual: restored.error },
              ),
            );
        }
      }
      const completion = cleanupCandidateResidency(record);
      const cancelled = lifecycle.cancel(candidate, completion);
      if (!cancelled.ok) return cancelled;
      hostCandidates.delete(candidate.candidateId);
      scheduleCandidateCleanup(record);
      return cancelled;
    },
    invalidateDynamicGeometryWorld(world) {
      const doomed = [...hostCandidates.values()].filter((record) => record.world === world);
      const completions = doomed
        .map((record) => scheduleCandidateCleanup(record, true))
        .filter((completion): completion is Promise<void> => completion !== undefined);
      lifecycle.invalidateWorld(
        world,
        completions.length === 0 ? undefined : Promise.allSettled(completions),
      );
    },
    retireDynamicGeometry(candidate) {
      synchronizeGeneration();
      const record = candidateRecord(candidate);
      if (record === undefined) {
        if (hostCandidates.has(candidate.candidateId))
          return err(
            new DynamicGeometryError(
              'dynamic-geometry-receipt-mismatch',
              'retirement uses the exact host candidate owner and lifecycle credential',
              'discard the altered credential and use the value returned by acceptance',
              { candidateId: candidate.candidateId },
            ),
          );
        return lifecycle.retire(candidate);
      }
      if (candidate.state !== 'accepted' && candidate.state !== 'published')
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-receipt-mismatch',
            'retirement uses a candidate state issued by the host lifecycle',
            'discard the altered credential and use the value returned by acceptance',
            { candidateId: candidate.candidateId },
          ),
        );
      if (meshHandleOf(record.world, record.entity) === record.meshHandle)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'retirement does not evict the MeshFilter that still consumes the candidate',
            'swap the ECS MeshFilter through its write barrier before retiring this geometry',
            { candidateId: candidate.candidateId },
          ),
        );
      const retired = lifecycle.retire(candidate);
      if (!retired.ok) return retired;
      record.candidate = Object.freeze({ ...record.candidate, state: 'retired' as const });
      const previousReleased = releasePreviousMeshLease(record);
      if (previousReleased !== undefined) return err(previousReleased);
      scheduleCandidateCleanup(record);
      return retired;
    },
    publishDynamicGeometry(frame, worlds, fixedStep) {
      synchronizeGeneration();
      const targetWorlds = new Set<World>();
      for (const candidateWorld of worlds ?? attachedWorlds) {
        const world = candidateWorld as World;
        if (attachedWorlds.has(world)) targetWorlds.add(world);
      }
      const receipts: DynamicGeometryReceipt[] = [];
      for (const world of targetWorlds) {
        const worldFixedStep = fixedStepOf(world);
        if (worldFixedStep === undefined) continue;
        // Derive the lifecycle filter input from the attached World's actual
        // FixedTime before publishFrame can reject an accepted candidate. An
        // omitted host tick therefore publishes the latest fixed-step result
        // instead of silently producing zero receipts.
        const publicationFixedStep = fixedStep ?? worldFixedStep;
        receipts.push(
          ...lifecycle.publishFrame(
            frame,
            [world],
            publicationFixedStep,
            (candidate) => {
              const candidateWorld = candidate.world as World;
              if (candidateWorld !== world || !attachedWorlds.has(candidateWorld)) return false;
              const hostRecord = candidateRecord(candidate);
              if (
                hostRecord === undefined ||
                !hostRecord.accepted ||
                !hasRenderableBinding(candidateWorld, candidate.entity) ||
                meshHandleOf(candidateWorld, candidate.entity) !== candidate.meshHandle ||
                !hasMaterialIdentity(
                  candidateWorld,
                  candidate.entity,
                  candidate.mesh,
                  candidate.materialIdentity,
                )
              )
                return false;
              if (!isConsumedByRenderFrame(candidate)) return false;
              const actualFixedStep = fixedStep ?? worldFixedStep;
              if (candidate.fixedStep === undefined || actualFixedStep === undefined) return false;
              // RenderFrameInput.fixedStep is an assertion from the host, not a
              // second clock. It may name a later World tick in a multi-fixed-step
              // host frame, but it cannot manufacture a step the attached World
              // has not actually published. An explicit mismatch remains a hard
              // rejection; omission uses the World-derived value above.
              if (worldFixedStep !== actualFixedStep || actualFixedStep < candidate.fixedStep)
                return false;
              if (candidate.physicsEntity !== undefined) {
                const publication = physicsPublicationOf(candidateWorld, candidate.physicsEntity);
                if (
                  publication === undefined ||
                  publication.fixedStep < candidate.fixedStep ||
                  publication.revision !== candidate.revision
                )
                  return false;
              }
              return true;
            },
            recordStageLane,
          ),
        );
      }
      for (const receipt of receipts) {
        const record = hostCandidates.get(receipt.candidateId);
        if (record !== undefined) {
          record.published = true;
          if (receipt.frame.completed !== undefined)
            record.residency?.track(receipt.frame.completed);
        }
      }
      return receipts;
    },
  };
  return host;
}

/**
 * Renderer assembly adapter for the host's temporal geometry owner.
 *
 * Keeping the render-system callback at this boundary prevents the concrete
 * WebGPU assembly from growing another owner-specific block while preserving
 * the same lifecycle and residency contracts.
 */
export function createRendererDynamicGeometryHost(options: {
  readonly lifecycle: DynamicGeometryLifecycle;
  readonly attachedWorlds: ReadonlySet<World>;
  readonly getGpuStore: () => GpuResidencyCache;
  readonly currentGeneration: () => number;
  readonly renderSystem: {
    readonly invalidateGeometryHistory: () => void;
    readonly isDynamicGeometryConsumed: (
      world: World,
      entity: number,
      meshHandle: DynamicGeometryCandidate['meshHandle'],
    ) => boolean;
    readonly dynamicGeometryRecordStageLane: (
      world: World,
      entity: number,
      meshHandle: DynamicGeometryCandidate['meshHandle'],
    ) => DynamicGeometryRecordStageLane | undefined;
  };
}): DynamicGeometryHostImplementation {
  const { renderSystem, ...hostOptions } = options;
  return createDynamicGeometryHost({
    ...hostOptions,
    onTopologyChanged: () => renderSystem.invalidateGeometryHistory(),
    isConsumedByRenderFrame: (candidate) =>
      renderSystem.isDynamicGeometryConsumed(
        candidate.world as World,
        candidate.entity ?? -1,
        candidate.meshHandle,
      ),
    recordStageLane: (candidate) =>
      renderSystem.dynamicGeometryRecordStageLane(
        candidate.world as World,
        candidate.entity ?? -1,
        candidate.meshHandle,
      ),
  });
}

export function createRendererDynamicGeometryController(
  options: Omit<Parameters<typeof createRendererDynamicGeometryHost>[0], 'lifecycle'>,
): {
  readonly lifecycle: DynamicGeometryLifecycle;
  readonly host: DynamicGeometryHostImplementation;
} {
  const lifecycle = createDynamicGeometryLifecycle();
  return {
    lifecycle,
    host: createRendererDynamicGeometryHost({ ...options, lifecycle }),
  };
}
