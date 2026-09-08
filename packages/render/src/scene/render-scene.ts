import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { componentId } from '@forgeax/engine-ecs/internal';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { box3, frustum, mat4 } from '@forgeax/engine-math';
import type { RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import {
  Camera,
  DirectionalLight,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  PostProcessParams,
  SkyboxBackground,
  Skylight,
  SpotLight,
  SpriteInstances,
  SpriteRegionOverride,
  Visibility,
} from '../components';
import {
  BatchTopology,
  type BatchTopologyInspection,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { GpuScene } from '../gpu-scene';
import type { PersistentRenderSceneInspection } from '../inspection-types';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { CameraSnapshot } from '../render-contract';
import type {
  DispatchEntry,
  ExtractedFrame,
  MaterialSnapshotCachesByWorld,
  RenderableSnapshot,
} from '../render-system-extract';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneDelta,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';

export type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneDelta,
  RenderSceneIdentity,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';

interface PendingIdentity {
  readonly worldId: number;
  readonly entityKey: number;
  readonly initial: RenderSceneSlot | undefined;
  current: RenderableSnapshot | undefined;
  removed: boolean;
}

function identityKey(worldId: number, entityKey: number): string {
  return `${worldId}:${entityKey}`;
}

function ownSnapshot(snapshot: RenderableSnapshot): RenderableSnapshot {
  return {
    ...snapshot,
    transform: { ...snapshot.transform, world: new Float32Array(snapshot.transform.world) },
    ...(snapshot.localAabb === undefined
      ? {}
      : { localAabb: new Float32Array(snapshot.localAabb) }),
    ...(snapshot.instances === undefined
      ? {}
      : {
          instances: {
            ...snapshot.instances,
            transforms: new Float32Array(snapshot.instances.transforms),
          },
        }),
    ...(snapshot.spriteInstances === undefined
      ? {}
      : {
          spriteInstances: {
            ...snapshot.spriteInstances,
            transforms: new Float32Array(snapshot.spriteInstances.transforms),
            regions: new Float32Array(snapshot.spriteInstances.regions),
          },
        }),
    ...(snapshot.pointsLines === undefined
      ? {}
      : { pointsLines: ownPointsLinesSnapshot(snapshot.pointsLines) }),
  };
}

function ownPointsLinesSnapshot(
  snapshot: PointsLinesRetainedSnapshot,
): PointsLinesRetainedSnapshot {
  return {
    ...snapshot,
    style: snapshot.style === undefined ? undefined : { ...snapshot.style },
    sourceBounds: new Float32Array(snapshot.sourceBounds),
    viewport: { ...snapshot.viewport },
    projection: new Float32Array(snapshot.projection),
  };
}

function withWorld(snapshot: RenderableSnapshot, world: Float32Array): RenderableSnapshot {
  return {
    ...snapshot,
    transform: { ...snapshot.transform, world: new Float32Array(world) },
  };
}

function intersects(left: RenderSceneBounds, right: RenderSceneBounds): boolean {
  return (
    left.min[0] <= right.max[0] &&
    left.max[0] >= right.min[0] &&
    left.min[1] <= right.max[1] &&
    left.max[1] >= right.min[1] &&
    left.min[2] <= right.max[2] &&
    left.max[2] >= right.min[2]
  );
}

function worldBounds(snapshot: RenderableSnapshot): RenderSceneBounds | undefined {
  const local = snapshot.localAabb;
  if (local === undefined || local.length < 6) return undefined;
  const world = snapshot.transform.world;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [local[0] ?? 0, local[3] ?? 0]) {
    for (const y of [local[1] ?? 0, local[4] ?? 0]) {
      for (const z of [local[2] ?? 0, local[5] ?? 0]) {
        const tx =
          (world[0] ?? 0) * x + (world[4] ?? 0) * y + (world[8] ?? 0) * z + (world[12] ?? 0);
        const ty =
          (world[1] ?? 0) * x + (world[5] ?? 0) * y + (world[9] ?? 0) * z + (world[13] ?? 0);
        const tz =
          (world[2] ?? 0) * x + (world[6] ?? 0) * y + (world[10] ?? 0) * z + (world[14] ?? 0);
        min[0] = Math.min(min[0], tx);
        min[1] = Math.min(min[1], ty);
        min[2] = Math.min(min[2], tz);
        max[0] = Math.max(max[0], tx);
        max[1] = Math.max(max[1], ty);
        max[2] = Math.max(max[2], tz);
      }
    }
  }
  return { min, max };
}

/**
 * The renderer's single rebuildable CPU scene authority.
 *
 * World/entity identity maps, stable slot generations, material reverse
 * lookup, and spatial facts live together here. Frame-local consumers read
 * snapshots from this owner and never create a second projection ledger.
 */
export class RenderScene {
  private readonly slots: Array<RenderSceneSlot | undefined> = [];
  private readonly generations: number[] = [];
  private readonly freeSlots: number[] = [];
  private readonly slotsByWorld = new Map<number, Map<number, number>>();
  private readonly slotsByMaterial = new Map<number, Set<number>>();
  // World bounds are a pure projection of each immutable snapshot. Cache the
  // derived value by snapshot identity so repeated view queries do not redo
  // the eight-corner transform for every view in the same frame.
  private readonly worldBoundsCache = new WeakMap<RenderableSnapshot, RenderSceneBounds | null>();
  private orderedSlots: number[] = [];
  private materialized: readonly RenderableSnapshot[] | undefined;
  private slotSnapshot: readonly RenderSceneSlot[] | undefined;
  private revision = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private renderableScans = 0;
  private fullRebuilds = 0;
  private resyncs = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;

  apply(operations: readonly RenderSceneOperation[]): RenderSceneApplyResult {
    if (operations.length === 0) {
      this.noChangeFrames += 1;
      this.renderableScans = 0;
      return this.emptyResult();
    }

    this.deltaFrames += 1;
    this.renderableScans = operations.length;
    const pendingByWorld = new Map<number, Map<number, PendingIdentity>>();
    const pendingOrder: PendingIdentity[] = [];
    let ignoredLateUpdates = 0;

    const pendingFor = (worldId: number, entityKey: number): PendingIdentity => {
      let entities = pendingByWorld.get(worldId);
      if (entities === undefined) {
        entities = new Map<number, PendingIdentity>();
        pendingByWorld.set(worldId, entities);
      }
      let pending = entities.get(entityKey);
      if (pending !== undefined) return pending;
      const initial = this.lookup(worldId, entityKey);
      pending = {
        worldId,
        entityKey,
        initial,
        current: initial?.snapshot,
        removed: false,
      };
      entities.set(entityKey, pending);
      pendingOrder.push(pending);
      return pending;
    };

    for (const operation of operations) {
      if (operation.kind === 'create') {
        const { worldId, entityKey } = operation.snapshot;
        const pending = pendingFor(worldId, entityKey);
        pending.current = ownSnapshot(operation.snapshot);
        continue;
      }
      const pending = pendingFor(operation.worldId, operation.entityKey);
      if (operation.kind === 'remove') {
        pending.current = undefined;
        pending.removed = true;
        continue;
      }
      if (pending.current === undefined) {
        ignoredLateUpdates += 1;
        continue;
      }
      pending.current = withWorld(pending.current, operation.world);
    }

    let created = 0;
    let updated = 0;
    let removed = 0;
    let recreated = 0;
    const createdSlots: RenderSceneSlot[] = [];
    const updatedSlots: RenderSceneSlot[] = [];
    const removedSlots: RenderSceneRecord[] = [];
    const recreatedSlots: RenderSceneSlot[] = [];
    for (const pending of pendingOrder) {
      if (pending.initial === undefined) {
        if (pending.current === undefined) continue;
        createdSlots.push(this.allocate(pending.current));
        created += 1;
        continue;
      }
      if (pending.current === undefined) {
        this.release(pending.initial);
        removedSlots.push(pending.initial);
        removed += 1;
        continue;
      }
      if (pending.removed) {
        this.release(pending.initial);
        recreatedSlots.push(this.allocate(pending.current));
        recreated += 1;
        continue;
      }
      const updatedSlot: RenderSceneSlot = {
        ...pending.initial,
        snapshot: pending.current,
      };
      this.unindexMaterials(pending.initial);
      this.slots[pending.initial.slot] = updatedSlot;
      this.indexMaterials(updatedSlot);
      updatedSlots.push(updatedSlot);
      updated += 1;
    }

    const changed = created + updated + removed + recreated > 0;
    if (changed) {
      this.revision += 1;
      this.invalidateSnapshots();
    }
    return {
      created,
      updated,
      removed,
      recreated,
      ignoredLateUpdates,
      createdSlots,
      updatedSlots,
      removedSlots,
      recreatedSlots,
      resynced: 0,
    };
  }

  applyDelta(delta: RenderSceneDelta): RenderSceneApplyResult {
    if (delta.overflowed || delta.resync !== undefined) {
      const snapshots = delta.resync ?? [];
      this.reset(snapshots);
      this.resyncs += 1;
      this.lastResyncReason = delta.reason ?? 'journal-overflow';
      return {
        ...this.emptyResult(),
        created: snapshots.length,
        resynced: 1,
      };
    }
    return this.apply(delta.operations);
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reset(snapshots: readonly RenderableSnapshot[], countAsRebuild = true): void {
    const desired = new Map<string, RenderableSnapshot>();
    for (const snapshot of snapshots) {
      desired.set(identityKey(snapshot.worldId, snapshot.entityKey), snapshot);
    }

    for (const slot of this.slots) {
      if (slot === undefined) continue;
      if (!desired.has(identityKey(slot.worldId, slot.entityKey))) this.release(slot);
    }

    this.orderedSlots = [];
    for (const snapshot of desired.values()) {
      const existing = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (existing === undefined) {
        this.allocate(snapshot);
        continue;
      }
      const updated: RenderSceneSlot = {
        ...existing,
        snapshot: ownSnapshot(snapshot),
      };
      this.unindexMaterials(existing);
      this.slots[existing.slot] = updated;
      this.indexMaterials(updated);
      this.orderedSlots.push(existing.slot);
    }

    this.revision += 1;
    if (countAsRebuild) this.fullRebuilds += 1;
    this.invalidateSnapshots();
  }

  rebuild(snapshots: readonly RenderableSnapshot[]): void {
    this.reset(snapshots);
  }

  materialize(): readonly RenderableSnapshot[] {
    if (this.materialized !== undefined) return this.materialized;
    const snapshots: RenderableSnapshot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record !== undefined) snapshots.push(record.snapshot);
    }
    this.materialized = Object.freeze(snapshots);
    return this.materialized;
  }

  slotsSnapshot(): readonly RenderSceneSlot[] {
    if (this.slotSnapshot !== undefined) return this.slotSnapshot;
    const records: RenderSceneSlot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record !== undefined) records.push(record);
    }
    this.slotSnapshot = Object.freeze(records);
    return this.slotSnapshot;
  }

  slot(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    return this.lookup(worldId, entityKey);
  }

  has(worldId: number, entityKey: number): boolean {
    return this.lookup(worldId, entityKey) !== undefined;
  }

  snapshot(worldId: number, entityKey: number): RenderableSnapshot | undefined {
    return this.lookup(worldId, entityKey)?.snapshot;
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    const snapshots: PointsLinesRetainedSnapshot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      const snapshot = record?.snapshot.pointsLines;
      if (record !== undefined && snapshot !== undefined) {
        snapshots.push(ownPointsLinesSnapshot({ ...snapshot, worldId: record.worldId }));
      }
    }
    return Object.freeze(snapshots);
  }

  slotsForMaterial(materialHandle: number): readonly RenderSceneSlot[] {
    const slots = this.slotsByMaterial.get(materialHandle);
    if (slots === undefined) return [];
    const records: RenderSceneSlot[] = [];
    for (const slot of slots) {
      const record = this.slots[slot];
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  querySpatial(bounds: RenderSceneBounds): readonly RenderSceneSlot[] {
    const records: RenderSceneSlot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record === undefined) continue;
      const snapshot = record.snapshot;
      let candidate = this.worldBoundsCache.get(snapshot);
      if (candidate === undefined && !this.worldBoundsCache.has(snapshot)) {
        candidate = worldBounds(snapshot) ?? null;
        this.worldBoundsCache.set(snapshot, candidate);
      }
      if (candidate === null || candidate === undefined) continue;
      if (intersects(candidate, bounds)) records.push(record);
    }
    return records;
  }

  inspect(): RenderSceneInspection {
    return {
      records: this.slotsSnapshot().map(({ slot, generation, worldId, entityKey }) => ({
        slot,
        generation,
        worldId,
        entityKey,
      })),
      slotCapacity: this.slots.length,
      freeSlots: this.freeSlots.length,
      revision: this.revision,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      renderableScans: this.renderableScans,
      fullRebuilds: this.fullRebuilds,
      resyncs: this.resyncs,
      lastResyncReason: this.lastResyncReason,
    };
  }

  private emptyResult(): RenderSceneApplyResult {
    return {
      created: 0,
      updated: 0,
      removed: 0,
      recreated: 0,
      ignoredLateUpdates: 0,
      createdSlots: [],
      updatedSlots: [],
      removedSlots: [],
      recreatedSlots: [],
      resynced: 0,
    };
  }

  private lookup(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    const slot = this.slotsByWorld.get(worldId)?.get(entityKey);
    return slot === undefined ? undefined : this.slots[slot];
  }

  private allocate(snapshot: RenderableSnapshot): RenderSceneSlot {
    const reused = this.freeSlots.pop();
    const slot = reused ?? this.slots.length;
    const generation = reused === undefined ? 0 : (this.generations[slot] ?? -1) + 1;
    const record: RenderSceneSlot = {
      slot,
      generation,
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      snapshot: ownSnapshot(snapshot),
    };
    this.generations[slot] = generation;
    this.slots[slot] = record;
    let entities = this.slotsByWorld.get(snapshot.worldId);
    if (entities === undefined) {
      entities = new Map<number, number>();
      this.slotsByWorld.set(snapshot.worldId, entities);
    }
    entities.set(snapshot.entityKey, slot);
    this.indexMaterials(record);
    this.orderedSlots.push(slot);
    return record;
  }

  private release(record: RenderSceneSlot): void {
    this.slots[record.slot] = undefined;
    this.unindexMaterials(record);
    const entities = this.slotsByWorld.get(record.worldId);
    entities?.delete(record.entityKey);
    if (entities?.size === 0) this.slotsByWorld.delete(record.worldId);
    const orderIndex = this.orderedSlots.indexOf(record.slot);
    if (orderIndex >= 0) this.orderedSlots.splice(orderIndex, 1);
    this.freeSlots.push(record.slot);
  }

  private indexMaterials(record: RenderSceneSlot): void {
    for (const material of record.snapshot.materials) {
      const handle = material.materialHandle ?? 0;
      let slots = this.slotsByMaterial.get(handle);
      if (slots === undefined) {
        slots = new Set<number>();
        this.slotsByMaterial.set(handle, slots);
      }
      slots.add(record.slot);
    }
  }

  private unindexMaterials(record: RenderSceneSlot): void {
    for (const material of record.snapshot.materials) {
      const handle = material.materialHandle ?? 0;
      const slots = this.slotsByMaterial.get(handle);
      slots?.delete(record.slot);
      if (slots?.size === 0) this.slotsByMaterial.delete(handle);
    }
  }

  private invalidateSnapshots(): void {
    this.materialized = undefined;
    this.slotSnapshot = undefined;
  }
}

function readTransformWorld(world: World, entity: EntityHandle): Float32Array | undefined {
  const transform = world.get(entity, Transform);
  return transform.ok ? new Float32Array(transform.value.world) : undefined;
}

export interface PersistentRenderSceneOptions {
  readonly getDevice?: (() => RhiDevice) | undefined;
  readonly onGpuError?: ((error: RhiError) => void) | undefined;
  readonly onSharedRefMutation?: ((worldId: number, handle: number) => void) | undefined;
}

export interface PersistentGpuDrivenState {
  readonly scene: GpuScene;
  readonly plan: SubmissionPlan;
  readonly slots: readonly RenderSceneSlot[];
}

type PersistentGpuSceneInspection = PersistentRenderSceneInspection['gpu'];

interface PersistentCompositionEntry {
  readonly token: object;
  readonly worlds: readonly World[];
  readonly cameraOwner: number;
  readonly resourceOwner: number;
  readonly projection: RenderScene;
  readonly topology: BatchTopology;
  readonly readCursors: number[];
  readonly leaseIdentities: readonly string[];
  catalogEpoch: number;
  readonly rigidOnly: boolean;
  gpuDrivenCoverageKey: string | undefined;
  gpuDrivenOwnsAll: boolean;
}

const RENDER_RELEVANT_COMPONENT_IDS = new Set([
  componentId(Transform),
  componentId(ChildOf),
  componentId(MeshFilter),
  componentId(MeshRenderer),
  componentId(Instances),
  componentId(SpriteInstances),
  componentId(SpriteRegionOverride),
  componentId(Skin),
  componentId(Layer),
  componentId(Visibility),
  componentId(Camera),
  componentId(DirectionalLight),
  componentId(PointLight),
  componentId(PointLightShadow),
  componentId(SpotLight),
  componentId(Skylight),
  componentId(SkyboxBackground),
  componentId(PostProcessParams),
]);

const NON_RENDERABLE_TRANSFORM_CONSUMERS = [
  Camera,
  DirectionalLight,
  PointLight,
  SpotLight,
] as const;

function cameraFrusta(cameras: readonly CameraSnapshot[]): readonly Float32Array[] {
  const planes: Float32Array[] = [];
  for (const camera of cameras) {
    if (
      (camera.projection === 'perspective' && (camera.fov <= 0 || camera.aspect <= 0)) ||
      camera.near >= camera.far
    ) {
      planes.push(new Float32Array(0));
      continue;
    }
    const projection = mat4.create();
    if (camera.projection === 'orthographic') {
      mat4.orthographic(
        projection,
        camera.orthoLeft,
        camera.orthoRight,
        camera.orthoBottom,
        camera.orthoTop,
        camera.near,
        camera.far,
      );
    } else {
      mat4.perspective(projection, camera.fov, camera.aspect, camera.near, camera.far);
    }
    const view = mat4.create();
    mat4.invert(view, camera.world);
    const viewProjection = mat4.create();
    mat4.multiply(viewProjection, projection, view);
    const cameraPlanes = frustum.create();
    frustum.fromViewProjection(cameraPlanes, viewProjection);
    planes.push(cameraPlanes);
  }
  return planes;
}

function cullPersistentFrame(
  frame: ExtractedFrame,
  candidates: readonly RenderableSnapshot[],
): ExtractedFrame {
  const planes = cameraFrusta(frame.cameras);
  const visible: RenderableSnapshot[] = [];
  const projectedIndex = new Int32Array(candidates.length);
  projectedIndex.fill(-1);
  let total = 0;
  let culled = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    let isVisible = true;
    if (candidate.localAabb !== undefined) {
      total += 1;
      const worldAabb = box3.create();
      box3.transformBox3(worldAabb, candidate.localAabb, candidate.transform.world);
      isVisible = planes.length === 0;
      for (const cameraPlanes of planes) {
        if (
          cameraPlanes.length === 0 ||
          frustum.intersectsBox(cameraPlanes as frustum.Frustum, worldAabb as box3.Box3Like)
        ) {
          isVisible = true;
          break;
        }
      }
    }
    if (!isVisible) {
      culled += 1;
      continue;
    }
    projectedIndex[index] = visible.length;
    visible.push(candidate);
  }

  const dispatch: DispatchEntry[] = [];
  for (const entry of frame.dispatch) {
    const candidateIndex = entry.renderableIndex;
    const renderableIndex = projectedIndex[candidateIndex];
    if (renderableIndex === undefined || renderableIndex < 0) continue;
    dispatch.push({ ...entry, renderableIndex });
  }
  return {
    ...frame,
    renderables: visible,
    dispatch,
    frustumStats: { culled, total },
  };
}

/** Persistent scene projection used by the renderer's multi-World composition path. */
export class PersistentRenderScene {
  private readonly materialSnapshotCaches: MaterialSnapshotCachesByWorld = new WeakMap();
  private fullRebuilds = 0;
  private worldEntitiesScanned = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private transformUpdates = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;
  private composition: PersistentCompositionEntry | undefined;
  private gpuScene: GpuScene | undefined;
  private gpuOwner: object | undefined;
  private gpuDevice: RhiDevice | undefined;
  private gpuStatus: 'inactive' | 'unsupported' | 'resident' | 'rebuild-pending' | 'error' =
    'inactive';
  private pointsLinesInspections: readonly PointsLinesInspection[] = [];

  constructor(private readonly options: PersistentRenderSceneOptions = {}) {}

  /** RenderScene owns the per-World material fact cache used during extraction. */
  materialSnapshotCacheStore(): MaterialSnapshotCachesByWorld {
    return this.materialSnapshotCaches;
  }

  extractComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    catalogEpoch: number,
    buildCandidateFrame: () => ExtractedFrame,
    leases?: readonly RenderReadLease[],
  ): ExtractedFrame {
    this.worldEntitiesScanned = 0;
    const entry = this.composition;
    if (
      entry === undefined ||
      entry.catalogEpoch !== catalogEpoch ||
      entry.cameraOwner !== owner.cameraOwner ||
      entry.resourceOwner !== owner.resourceOwner ||
      entry.worlds.length !== worlds.length ||
      entry.worlds.some((world, index) => world !== worlds[index]) ||
      leases === undefined ||
      leases.length !== worlds.length
    ) {
      return this.rebuildComposition(worlds, owner, catalogEpoch, buildCandidateFrame, leases);
    }
    if (!entry.rigidOnly) {
      return this.rebuildComposition(worlds, owner, catalogEpoch, buildCandidateFrame, leases);
    }

    const operations: RenderSceneOperation[] = [];
    let requiresRebuild = false;
    for (let worldId = 0; worldId < worlds.length; worldId += 1) {
      const world = worlds[worldId];
      if (world === undefined) continue;
      const lease = leases?.[worldId];
      if (lease === undefined || entry.leaseIdentities[worldId] !== lease.worldIdentity) {
        requiresRebuild = true;
        break;
      }
      let read: ReturnType<RenderReadLease['readChanges']>;
      try {
        read = lease.readChanges(entry.readCursors[worldId] ?? 0);
      } catch {
        requiresRebuild = true;
        break;
      }
      if (read.status === 'overflow') {
        requiresRebuild = true;
        break;
      }
      const changes = read.world;
      const shared = read.sharedRefs;
      if (shared.records.length > 0) {
        for (const record of shared.records) {
          this.options.onSharedRefMutation?.(worldId, record.handle);
        }
        requiresRebuild = true;
        break;
      }
      const derivedTransforms = new Set<EntityHandle>();
      for (const record of changes.records) {
        if (
          record.kind === 'derived-component-changed' &&
          record.componentId === componentId(Transform)
        ) {
          derivedTransforms.add(record.entity as EntityHandle);
        }
      }
      for (const record of changes.records) {
        if (
          record.kind !== 'entity-removed' &&
          record.componentId !== undefined &&
          !RENDER_RELEVANT_COMPONENT_IDS.has(record.componentId)
        ) {
          continue;
        }
        const authoredTransform =
          record.kind === 'component-changed' && record.componentId === componentId(Transform);
        const derivedTransform =
          record.kind === 'derived-component-changed' &&
          record.componentId === componentId(Transform);
        if (derivedTransform) continue;
        if (authoredTransform && derivedTransforms.has(record.entity as EntityHandle)) continue;
        if (
          (authoredTransform || record.componentId === componentId(Transform)) &&
          entry.projection.has(worldId, record.entity)
        ) {
          const worldView = readTransformWorld(world, record.entity as EntityHandle);
          if (worldView === undefined) {
            requiresRebuild = true;
            break;
          }
          operations.push({
            kind: 'update-transform',
            worldId,
            entityKey: record.entity,
            world: new Float32Array(worldView),
          });
          continue;
        }
        requiresRebuild = true;
        break;
      }
      if (!requiresRebuild) {
        for (const entity of derivedTransforms) {
          if (entry.projection.has(worldId, entity)) {
            const worldView = readTransformWorld(world, entity);
            if (worldView === undefined) {
              requiresRebuild = true;
              break;
            }
            operations.push({
              kind: 'update-transform',
              worldId,
              entityKey: entity,
              world: new Float32Array(worldView),
            });
            continue;
          }
          if (
            NON_RENDERABLE_TRANSFORM_CONSUMERS.some((component) =>
              world.hasComponent(entity, component),
            )
          ) {
            requiresRebuild = true;
            break;
          }
        }
      }
      if (requiresRebuild) break;
      entry.readCursors[worldId] = read.cursor;
    }
    if (requiresRebuild) {
      return this.rebuildComposition(worlds, owner, catalogEpoch, buildCandidateFrame, leases);
    }
    if (operations.length === 0) {
      this.noChangeFrames += 1;
      this.syncGpuOwner(entry.token, entry.projection);
      return this.deriveFramePlan(entry, buildCandidateFrame);
    }
    const delta = entry.projection.apply(operations);
    entry.topology.apply(delta);
    this.syncGpuOwner(entry.token, entry.projection, delta);
    this.deltaFrames += 1;
    this.transformUpdates += operations.length;
    return this.deriveFramePlan(entry, buildCandidateFrame);
  }

  invalidate(): void {
    this.composition = undefined;
    this.lastResyncReason = 'explicit-invalidate';
  }

  setCompositionGpuDrivenCoverage(key: string, ownsAll: boolean): void {
    const entry = this.composition;
    if (entry === undefined) return;
    entry.gpuDrivenCoverageKey = key;
    entry.gpuDrivenOwnsAll = ownsAll;
  }

  detach(world: World): void {
    this.materialSnapshotCaches.delete(world);
    const detachedComposition = this.composition?.worlds.includes(world)
      ? this.composition
      : undefined;
    if (detachedComposition !== undefined) this.composition = undefined;
    if (this.gpuOwner !== world && this.gpuOwner !== detachedComposition?.token) return;
    this.gpuScene?.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
  }

  /** Drop only device-owned tables; the CPU projection remains the recovery authority. */
  resetGpuForRecover(): void {
    if (this.composition !== undefined) this.composition.gpuDrivenOwnsAll = false;
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
  }

  setPointsLinesInspections(inspections: readonly PointsLinesInspection[]): void {
    this.pointsLinesInspections = inspections.map((inspection) => ({
      ...inspection,
      cache: { ...inspection.cache },
      ...(inspection.refusal === undefined ? {} : { refusal: { ...inspection.refusal } }),
    }));
  }

  dispose(): void {
    this.gpuScene?.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
    this.composition = undefined;
    this.pointsLinesInspections = [];
  }

  inspect(): PersistentRenderSceneInspection {
    const entry = this.composition;
    const pointsLines = this.pointsLinesInspections;
    return {
      worldEntitiesScanned: this.worldEntitiesScanned,
      fullRebuilds: this.fullRebuilds,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      transformUpdates: this.transformUpdates,
      lastResyncReason: this.lastResyncReason,
      projectionRecords: entry?.projection.inspect().records.length ?? 0,
      topology:
        entry?.topology.inspect() ??
        ({
          revision: 0,
          batchCount: 0,
          candidateCount: 0,
          rebuilds: 0,
          patches: 0,
          ineligible: 0,
        } satisfies BatchTopologyInspection),
      gpu: this.inspectGpu(),
      pointsLines,
    };
  }

  compositionGpuDrivenState(): PersistentGpuDrivenState | undefined {
    const entry = this.composition;
    if (entry === undefined || this.gpuOwner !== entry.token || this.gpuScene === undefined) {
      return undefined;
    }
    return {
      scene: this.gpuScene,
      plan: entry.topology.plan(),
      slots: entry.projection.slotsSnapshot(),
    };
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    return this.composition?.projection.pointsLinesSnapshots() ?? [];
  }

  private inspectGpu(): PersistentGpuSceneInspection {
    if (this.gpuStatus === 'resident' && this.gpuScene !== undefined) {
      return { status: 'resident', ...this.gpuScene.inspect() };
    }
    if (this.gpuStatus === 'unsupported') {
      return { status: 'unsupported', reason: 'storage-buffer-unavailable' };
    }
    if (this.gpuStatus === 'rebuild-pending') return { status: 'rebuild-pending' };
    if (this.gpuStatus === 'error') return { status: 'error' };
    return { status: 'inactive' };
  }

  private rebuildComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    catalogEpoch: number,
    buildCandidateFrame: () => ExtractedFrame,
    leases?: readonly RenderReadLease[],
  ): ExtractedFrame {
    const candidateFrame = buildCandidateFrame();
    this.worldEntitiesScanned = candidateFrame.renderables.length;
    const projection = new RenderScene();
    projection.reset(candidateFrame.renderables);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const token = {};
    const entry: PersistentCompositionEntry = {
      token,
      worlds: [...worlds],
      cameraOwner: owner.cameraOwner,
      resourceOwner: owner.resourceOwner,
      projection,
      topology,
      readCursors:
        leases === undefined || leases.length !== worlds.length
          ? []
          : leases.map((lease) => lease.inspectCursor()),
      leaseIdentities:
        leases === undefined || leases.length !== worlds.length
          ? []
          : leases.map((lease) => lease.worldIdentity),
      catalogEpoch,
      rigidOnly: candidateFrame.renderables.every((renderable) => renderable.skin === undefined),
      gpuDrivenCoverageKey: undefined,
      gpuDrivenOwnsAll: false,
    };
    this.composition = entry;
    this.syncGpuOwner(token, projection, undefined, true);
    this.fullRebuilds += 1;
    this.lastResyncReason = 'attach';
    return cullPersistentFrame(candidateFrame, projection.materialize());
  }

  /**
   * Derive an ephemeral frame plan from persistent scene facts. The scene
   * retains identity/topology/cursors; no prior frame object is an authority.
   */
  private deriveFramePlan(
    entry: PersistentCompositionEntry,
    buildCandidateFrame: () => ExtractedFrame,
  ): ExtractedFrame {
    const candidateFrame = buildCandidateFrame();
    const candidates = entry.projection.materialize();
    return cullPersistentFrame({ ...candidateFrame, renderables: [...candidates] }, candidates);
  }

  private syncGpuOwner(
    owner: object,
    projection: RenderScene,
    delta?: RenderSceneApplyResult,
    full = false,
  ): void {
    const acquired = this.acquireGpuScene(owner, projection);
    if (acquired === undefined || acquired.rebuilt) return;
    const result = full
      ? acquired.scene.rebuild(projection.slotsSnapshot())
      : delta === undefined
        ? acquired.scene.sync({
            created: 0,
            updated: 0,
            removed: 0,
            recreated: 0,
            ignoredLateUpdates: 0,
            createdSlots: [],
            updatedSlots: [],
            removedSlots: [],
            recreatedSlots: [],
            resynced: 0,
          })
        : acquired.scene.sync(delta);
    if (!result.ok) this.failGpu(result.error);
  }

  private acquireGpuScene(
    owner: object,
    projection: RenderScene,
  ): { readonly scene: GpuScene; readonly rebuilt: boolean } | undefined {
    const getDevice = this.options.getDevice;
    if (getDevice === undefined) return undefined;
    const device = getDevice();
    if (this.gpuDevice !== undefined && this.gpuDevice !== device) {
      this.gpuScene = undefined;
      this.gpuOwner = undefined;
      this.gpuStatus = 'rebuild-pending';
    }
    if (this.gpuStatus === 'error' && this.gpuDevice === device) return undefined;
    if (this.gpuStatus === 'unsupported' && this.gpuDevice === device) return undefined;
    if (this.gpuScene !== undefined && this.gpuOwner === owner) {
      return { scene: this.gpuScene, rebuilt: false };
    }
    if (this.gpuScene !== undefined) this.gpuScene.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = device;
    const created = GpuScene.create(device, Math.max(256, projection.inspect().slotCapacity));
    if (!created.ok) {
      this.failGpu(created.error);
      return undefined;
    }
    if (created.value.status === 'unavailable') {
      this.gpuStatus = 'unsupported';
      return undefined;
    }
    const scene = created.value.scene;
    const rebuilt = scene.rebuild(projection.slotsSnapshot());
    if (!rebuilt.ok) {
      scene.dispose();
      this.failGpu(rebuilt.error);
      return undefined;
    }
    this.gpuScene = scene;
    this.gpuOwner = owner;
    this.gpuStatus = 'resident';
    return { scene, rebuilt: true };
  }

  private failGpu(error: RhiError): void {
    this.gpuScene?.dispose();
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuStatus = 'error';
    this.options.onGpuError?.(error);
  }
}
