// @forgeax/engine-ecs — World: top-level ECS container.
//
// World owns entities, archetypes (via ArchetypeGraph), and component registry.
// Supports multi-component spawn, despawn (with generation retirement D-08),
// get/set, addComponent/removeComponent (archetype migration via edges).
// M3: addSystem / update (DAG schedule) + deferred commands + Resource CRUD.
//
// [w6] All 6 public methods return Result<T, EcsError> (AP-8 Layer 1).
// Construction errors (EntityIndexOverflowError) still throw — they are
// build-time / infrastructure failures.

import type { Handle, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import type { BufferPool } from './buffer-pool';
import {
  type Component,
  ComponentCatalog,
  type ComponentSchema,
  componentId,
  type InputShapeOf,
  type ShapeOf,
} from './component';
import { type EntityHandle, encodeEntity, entityGeneration, entityIndex } from './entity-handle';
import type {
  CommandFailedError,
  ComponentAlreadyPresentError,
  ComponentFieldInvalidValueError,
  ComponentNotDefinedError,
  ComponentNotPresentError,
  ComponentNumericValueInvalidError,
  FixedSizeMismatchError,
  ManagedArrayInvalidValueError,
  ManagedBufferOutOfBoundsError,
  ManagedBufferShrinkNotSupportedError,
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
  RemoveEssentialComponentError,
  ScheduleMutationError,
  ScheduleScopeMismatchError,
  SharedKernelEligibilityError,
  SharedKernelFailureError,
  StaleEntityError,
  SystemFailedError,
  SystemSetNotRegisteredError,
  TimeConfigInvalidError,
  TimeDeltaInvalidError,
  UniqueRefDoubleReleaseError,
  UniqueRefReleasedError,
  WorldPoisonedError,
} from './errors';
import { ChangeEpochExhaustedError, RelationshipTargetReadonlyError } from './errors';
import {
  healthyWorldExecutionState,
  poisonedWorldExecutionState,
  type WorldExecutionFault,
  type WorldExecutionState,
} from './execution/shared-kernel';
import type { QueryDescriptor } from './query/query';
import { createQuery, type Query, type QueryCreationError } from './query/query';
import { isRelationshipTarget, type RelationshipTargetComponent } from './relationship-index';
import { createResourceStore, type ResourceStore } from './resource';
import { createSchedule, type Schedule, type SystemDescriptor, type SystemSet } from './schedule';
import { FixedUpdate, Update } from './schedule-token';
import type { SharedRefStore } from './shared-ref-store';
import type { Archetype } from './storage/archetype';
import type { ArchetypeGraph } from './storage/archetype-graph';
import {
  type ChangeTicks,
  markComponentChanged,
  markComponentsAdded,
  readComponentChange,
  readTableEntityRange,
  type WorldChangeRead,
} from './storage/change-detection';
import {
  type ClockWriter,
  createWorldClock,
  DEFAULT_TIME_POLICY,
  FIXED_TIME_RESOURCE_KEY,
  TIME_RESOURCE_KEY,
  type WorldOptions,
} from './time';
import type { UniqueRefStore } from './unique-ref-store';
import { WorldComponentAccess } from './world-component-access';
import { WorldCore } from './world-core';
import {
  despawnCore,
  spawnCore,
  worldAddChild,
  worldIterAncestors,
  worldIterDescendants,
  worldRemoveChild,
  worldReparent,
} from './world-entity-lifecycle';
import { type WorldInternal, worldInternal } from './world-internal';
import {
  worldAddSystem,
  worldAddSystems,
  worldAllocSharedRef,
  worldAllocUniqueRef,
  worldGetResource,
  worldHasResource,
  worldInsertResource,
  worldInspect,
  worldInternSharedRef,
  worldRemoveResource,
  worldRemoveSystem,
  worldReplaceSystem,
  worldScheduleData,
  worldScheduleUsesComponent,
  worldUpdate,
} from './world-scheduling';

/**
 * Union of all EcsError types that World methods can return via Result.
 * AI users: switch on `.code` for programmatic branching.
 */
export type EcsError =
  | CommandFailedError
  | StaleEntityError
  | ComponentNotPresentError
  | ComponentAlreadyPresentError
  | ComponentFieldInvalidValueError
  | ComponentNumericValueInvalidError
  | ManagedArrayInvalidValueError
  | UniqueRefReleasedError
  | UniqueRefDoubleReleaseError
  | ManagedBufferOutOfBoundsError
  | ManagedBufferShrinkNotSupportedError
  | FixedSizeMismatchError
  | RelationshipSelfCycleError
  | RelationshipMirrorComponentNotRegisteredError
  | RelationshipMirrorFieldTypeMismatchError
  | RelationshipDetachMismatchError
  | RelationshipTargetReadonlyError
  | ComponentNotDefinedError
  | RemoveEssentialComponentError
  | SystemSetNotRegisteredError
  | SystemFailedError
  | TimeDeltaInvalidError
  | TimeConfigInvalidError
  | ScheduleScopeMismatchError
  | SharedKernelEligibilityError
  | SharedKernelFailureError
  | WorldPoisonedError;

/** Component data for spawn/addComponent: component token + initial values.
 *
 * `data` is `Partial<InputShapeOf<S>>` (feat-20260517 / M2; tweak-20260616
 * input/output split): spawn / addComponent / SceneAsset.instantiate share the
 * SAME shape contract via the layer-2 + layer-3 silent fallback applied inside
 * `writeRow` (`fillComponentDefaults`). The input shape widens
 * `array<scalar, N>` / `array<scalar>` to also accept `readonly number[]`
 * because writeArrayField copies bytes from either shape — AI users can write
 * `times: [0.5]` instead of `new Float32Array([0.5])` boilerplate. Wrong-VALUE
 * fields (e.g. `{ fov: 'bad' }`) still fire field-level TS2322 — mapped-tuple
 * primary inference does not degrade to the "No overload matches" wall
 * (AC-03 / C-4). */
export interface ComponentData<S extends ComponentSchema = ComponentSchema> {
  component: Component<string, S>;
  data: Partial<InputShapeOf<S>>;
}

type WritableComponent<C extends Component> = C extends RelationshipTargetComponent ? never : C;

/**
 * Per-archetype summary returned by `world.inspect()`. Sorted ComponentId key
 * (always prefixed by the essential id=0 Entity column, e.g. "0+2+5+7"),
 * human-readable component names, live entity count, allocated row capacity.
 */
export interface ArchetypeInfo {
  /** Sorted ComponentId key, always prefixed by the id=0 Entity column (e.g. "0+2+5+7"). */
  readonly key: string;
  /** Human-readable component names in this archetype. */
  readonly componentNames: string[];
  /** Number of live entities in this archetype. */
  readonly entityCount: number;
  readonly tableId: number;
}

export interface TableInfo {
  readonly id: number;
  readonly key: string;
  readonly componentNames: string[];
  readonly entityCount: number;
  readonly capacity: number;
}

/**
 * Typed diagnostic snapshot of the World state.
 * Returned by `world.inspect()` for programmatic introspection by AI users.
 */
export interface WorldInspection {
  /** Total number of live entities. */
  readonly entityCount: number;
  /** Number of archetypes currently allocated. */
  readonly archetypeCount: number;
  /** Per-archetype details. */
  readonly archetypes: ArchetypeInfo[];
  readonly tableCount: number;
  readonly tables: TableInfo[];
  /**
   * Names of components that are currently active in this World — i.e.
   * every distinct component name appearing on at least one non-empty
   * archetype. Collected by walking the archetype graph, so a component
   * that was defined but never spawned into this World does not appear.
   */
  readonly activeComponents: string[];
  /** Number of registered systems. Always equals `systems.length` (M2 derived invariant). */
  readonly systemCount: number;
  /**
   * Per-system summary (M3 — plan-strategy D-8). One entry per
   * registered system, in registration order. The `systemCount` field is
   * preserved as a derived alias of `systems.length` so existing inspector
   * P0 e2e cases that read `systemCount` keep working.
   *
   * `sets` is the list of set names this system belongs to (empty array for
   * systems registered via plain `addSystem` without `addSystems`).
   */
  readonly systems: ReadonlyArray<{ readonly name: string; readonly sets: readonly string[] }>;
  /** Keys of all inserted resources. */
  readonly resourceKeys: string[];
  /** Systems grouped by their schedule token. */
  readonly schedules: ReadonlyArray<{
    readonly schedule: import('./schedule-token').ScheduleToken;
    readonly systems: ReadonlyArray<{ readonly name: string; readonly sets: readonly string[] }>;
  }>;
  /** Count systems in one explicit schedule. */
  scheduleSystemCount(schedule: import('./schedule-token').ScheduleToken): number;
}

/** JSON-safe schedule graph and access metadata returned by `world.scheduleData()`. */
export interface WorldScheduleQueryData {
  readonly with: readonly string[];
  readonly without: readonly string[];
  readonly optional: readonly string[];
  readonly changed: readonly string[];
  readonly added: readonly string[];
}

/** JSON-safe system registration and access metadata. */
export interface WorldScheduleSystemData {
  readonly name: string;
  readonly sets: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly queries: readonly WorldScheduleQueryData[];
  readonly resources: readonly string[];
}

/** JSON-safe system-set membership and ordering metadata. */
export interface WorldScheduleSetData {
  readonly name: string;
  readonly members: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly chained: boolean;
}

/** JSON-safe projection of one explicit World schedule. */
export interface WorldScheduleData {
  readonly name: string;
  readonly systems: readonly WorldScheduleSystemData[];
  readonly systemSets: readonly WorldScheduleSetData[];
  readonly dependencies: readonly (readonly [string, string])[];
}

/**
 * Internal record describing where an entity lives.
 *
 * Liveness (feat-20260602 / plan-strategy D-4): the former `alive` boolean was
 * absorbed into `generation`. A despawn unconditionally bumps `generation` (so a
 * stale handle's `gen` no longer matches), and `gen > 255` retires the slot
 * permanently (it is never pushed back to `freeIndices`). The single liveness
 * predicate is therefore "handle gen matches AND archetypeId !== -1" -- see
 * `World.recordIsLive`. A deferred-spawn allocation is "pending" when
 * archetypeId === -1 (not yet materialized into an archetype row); no separate
 * boolean is needed.
 */
export interface EntityRecord {
  generation: number;
  archetypeId: number; // -1 if no archetype (pending / despawned)
  archetypeRow: number;
}

/**
 * The World owns:
 *   - the registry of known component schemas;
 *   - all archetypes (via ArchetypeGraph);
 *   - the entity index table (records by index slot);
 *   - the free-list of recyclable entity slots.
 */
export class World {
  /** Package-internal implementation seam; not exported from any entry point. */
  readonly [worldInternal]: WorldInternal;
  // ── Internal state ──

  /** The single package-private owner of storage, epochs, and change evidence. */
  private readonly core: WorldCore;
  get identity() {
    return this.core.identity;
  }
  /** Plugin-owned component discovery scoped to this World and removed through leases. */
  readonly components = new ComponentCatalog((component) => this.componentIsInUse(component));
  private executionState: WorldExecutionState;
  /** Monotonic clock advanced exactly once per successful mutation. */
  /** Monotonic revision for successful entity/component structure writes. */
  /** Last mutation epoch for each component id, used by component-owned projections. */
  /** Ordered, bounded evidence consumed by persistent engine-owned projections. */
  private get mutationEpoch() {
    return this.core.mutationEpoch;
  }
  private set mutationEpoch(value: number) {
    this.core.mutationEpoch = value;
  }
  private get structureEpoch() {
    return this.core.structureEpoch;
  }
  private set structureEpoch(value: number) {
    this.core.structureEpoch = value;
  }
  private get componentMutationEpochs() {
    return this.core.componentMutationEpochs;
  }
  private get changeJournal() {
    return this.core.changeJournal;
  }
  /** Free index slots (LIFO stack). */
  private get records() {
    return this.core.records;
  }
  private get freeIndices() {
    return this.core.freeIndices;
  }
  /**
   * Relationship-sync reentry guard (feat-20260531 M2 / plan-strategy D-7).
   /** The archetype graph: manages all archetypes + edge caching. */
  private get graph(): ArchetypeGraph {
    return this.core.graph;
  }
  /** DAG schedules for the two built-in execution scopes. */
  private readonly schedules = new Map([
    [Update, createSchedule(Update)],
    [FixedUpdate, createSchedule(FixedUpdate)],
  ]);
  /** Resource store: typed key-value global singletons. */
  private readonly resources: ResourceStore = createResourceStore();
  private readonly clock: ReturnType<typeof createWorldClock>;
  /** Remainder carried between fixed-step runs. */
  private fixedAccumulator = 0;
  /**
   * ECS-managed handle store (M1). Owned by the World - constructed eagerly
   * so every spawn / despawn / set path can dispatch managed-ref releases
   * without caller-side wiring. AI users obtain `Handle<T,'unique'>` values
   * by accessing the store through internal channels (the surface is
   * private; managed-ref-bearing fields read through `world.get`).
   */
  // UniqueRefStore is type-erased at the storage layer (alloc/resolve are
  // method-generic over `T`); World holds the single per-instance store and
  // routes payload-agnostic release calls. Typed access flows through
  // `UniqueRefStore.resolve<T>` at the consumer layer.
  private get uniqueRefs(): UniqueRefStore {
    return this.core.uniqueRefs;
  }
  /**
   * Per-World `SharedRefStore` (feat-20260614 M3). Backs every `shared<T>`
   * schema field + the `world.allocSharedRef` facade. Public read-only so AI
   * users can `retain` / `release` / `resolve` user-tier handles directly off
   * the world (the surface is small enough that hiding it behind another
   * facade would be a phantom indirection - charter F1 single-entry
   * indexability).
   *
   * Final release publishes structured evidence; there is no callback surface.
   * M6 D-15: the store manages only user-tier slots
   * (`>= BUILTIN_BASE`); builtin handles are process-static in their
   * authoring package and never reference-counted.
   */
  get sharedRefs(): SharedRefStore {
    return this.core.sharedRefs;
  }
  /**
   * BufferPool backing every `buffer:<N>` schema-vocab field (M2). Eagerly
   * constructed (per-World, D-2). `spawn` allocs slots for buffer fields and
   * stores the slot id in the u32 column; `despawn` / `removeComponent`
   * release the slots; `set(e, C, { field: Uint8Array })` copies bytes into
   * the live view without re-allocating (schema-declared byteLength is
   * fixed in v1; runtime grow is reserved for the M4 carry-over path).
   */
  private get bufferPool() {
    return this.core.bufferPool;
  }
  private readonly componentAccess: WorldComponentAccess;

  constructor(options: WorldOptions = {}) {
    this.core = new WorldCore(options.storage === 'shared');
    this.executionState = healthyWorldExecutionState(this.identity);
    this.componentAccess = new WorldComponentAccess({
      graph: this.graph,
      records: this.records,
      freeIndices: this.freeIndices,
      bufferPool: this.bufferPool,
      uniqueRefs: this.uniqueRefs,
      sharedRefs: this.sharedRefs,
      relationshipIndexes: this.core.relationshipIndexes,
      markComponentAdded: (entity, component) => this.internalmarkComponentAdded(entity, component),
      markComponentsAdded: (entity, components) =>
        this.internalmarkComponentsAdded(entity, components),
      markComponentChanged: (entity, component) =>
        this.internalmarkComponentChanged(entity, component),
      removeComponentChange: (entity, component) =>
        this.internalremoveComponentChange(entity, component),
      markStructureChanged: () => this.internalmarkStructureChanged(),
      routeError: (error, context) => this.internalrouteError(error as EcsError, context),
    });
    this.clock = createWorldClock({ ...DEFAULT_TIME_POLICY, ...options.time });
    this.resources.entries.set(TIME_RESOURCE_KEY, {
      value: this.clock.time,
      added: 0,
      changed: 0,
    });
    this.resources.entries.set(FIXED_TIME_RESOURCE_KEY, {
      value: this.clock.fixed,
      added: 0,
      changed: 0,
    });
    this[worldInternal] = {
      addComponentCore: this.internaladdComponentCore.bind(this),
      allocateIndex: this.internalallocateIndex.bind(this),
      allocatePendingEntity: this.internalallocatePendingEntity.bind(this),
      cancelPendingEntity: this.internalcancelPendingEntity.bind(this),
      despawnCore: this.internaldespawnCore.bind(this),
      getArrayView: this.internalgetArrayView.bind(this),
      getBufferPool: this.internalgetBufferPool.bind(this),
      getChangeCursor: this.internalgetChangeCursor.bind(this),
      getClockWriter: this.internalgetClockWriter.bind(this),
      getComponentChange: this.internalgetComponentChange.bind(this),
      getComponentMutationEpoch: this.internalgetComponentMutationEpoch.bind(this),
      getEntityArchetype: this.internalgetEntityArchetype.bind(this),
      getFixedAccumulator: this.internalgetFixedAccumulator.bind(this),
      getFreeIndices: this.internalgetFreeIndices.bind(this),
      getGraph: this.internalgetGraph.bind(this),
      getMutationEpoch: this.internalgetMutationEpoch.bind(this),
      getQueryRow: this.internalgetQueryRow.bind(this),
      getRecords: this.internalgetRecords.bind(this),
      getRelationshipEpoch: this.internalgetRelationshipEpoch.bind(this),
      getRelationshipTargetEntities: this.internalgetRelationshipTargetEntities.bind(this),
      getResources: this.internalgetResources.bind(this),
      getSchedule: this.internalgetSchedule.bind(this),
      getSchedules: this.internalgetSchedules.bind(this),
      getSharedRefs: this.internalgetSharedRefs.bind(this),
      getStructureEpoch: this.internalgetStructureEpoch.bind(this),
      getUniqueRefs: this.internalgetUniqueRefs.bind(this),
      lookupAlive: this.internallookupAlive.bind(this),
      markComponentAdded: this.internalmarkComponentAdded.bind(this),
      markComponentChanged: this.internalmarkComponentChanged.bind(this),
      markComponentRangeChanged: this.internalmarkComponentRangeChanged.bind(this),
      markComponentsAdded: this.internalmarkComponentsAdded.bind(this),
      markDerivedComponentChanges: this.internalmarkDerivedComponentChanges.bind(this),
      markStructureChanged: this.internalmarkStructureChanged.bind(this),
      materializePendingEntity: this.internalmaterializePendingEntity.bind(this),
      nextMutationEpoch: this.internalnextMutationEpoch.bind(this),
      poisonExecution: this.internalpoisonExecution.bind(this),
      preflightComponentData: this.internalpreflightComponentData.bind(this),
      readChangesSince: this.internalreadChangesSince.bind(this),
      readRow: this.internalreadRow.bind(this),
      recordIsLive: this.internalrecordIsLive.bind(this),
      relationshipOnInsert: this.internalrelationshipOnInsert.bind(this),
      relationshipOnRemove: this.internalrelationshipOnRemove.bind(this),
      releaseManagedRefsOnRow: this.internalreleaseManagedRefsOnRow.bind(this),
      removeComponentChange: this.internalremoveComponentChange.bind(this),
      removeComponentCore: this.internalremoveComponentCore.bind(this),
      removeEntityChanges: this.internalremoveEntityChanges.bind(this),
      routeError: this.internalrouteError.bind(this),
      setFixedAccumulator: this.internalsetFixedAccumulator.bind(this),
      setQueryRow: this.internalsetQueryRow.bind(this),
      spawnCore: this.internalspawnCore.bind(this),
      writeEntitySelf: this.internalwriteEntitySelf.bind(this),
      writeRow: this.internalwriteRow.bind(this),
    };
  }

  /** Immutable integrity state for execution coordinators and headless callers. */
  get execution(): WorldExecutionState {
    return this.executionState;
  }

  /** Resolve a schedule token owned by this World realm without package singleton identity. */
  scheduleToken(
    name: import('./schedule-token').ScheduleName,
  ): import('./schedule-token').ScheduleToken {
    if (name === 'Update') return Update;
    if (name === 'FixedUpdate') return FixedUpdate;
    return FixedUpdate;
  }

  /** SharedKernel is the only writer; application code recovers by constructing a new World. */
  private internalpoisonExecution(fault: WorldExecutionFault): void {
    if (this.executionState.health === 'healthy') {
      this.executionState = poisonedWorldExecutionState(this.identity, fault);
    }
  }

  query<
    const R extends readonly Component[] = readonly [],
    const W extends readonly Component[] = readonly [],
    const O extends readonly Component[] = readonly [],
  >(descriptor: QueryDescriptor<R, W, O>): Result<Query<R, W, O>, QueryCreationError> {
    return createQuery(this, descriptor);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal access — query engine
  // ──────────────────────────────────────────────────────────────────────────

  /** Expose archetype graph for query engine. Not part of public API. */
  private internalgetGraph(): ArchetypeGraph {
    return this.graph;
  }

  private componentIsInUse(component: Component): boolean {
    if (
      this.graph.archetypes.some(
        (archetype) =>
          archetype.size > 0 && archetype.components.some((candidate) => candidate === component),
      )
    ) {
      return true;
    }
    return worldScheduleUsesComponent(this, component);
  }

  /** Current upper bound for mutation observation. */
  private internalgetMutationEpoch(): number {
    return this.mutationEpoch;
  }

  /** Current cursor for a persistent projection subscriber. */
  private internalgetChangeCursor(): number {
    return this.changeJournal.cursor();
  }

  /** Read complete mutation evidence or an explicit rebuild signal. */
  private internalreadChangesSince(cursor: number): WorldChangeRead {
    return this.changeJournal.readAfter(cursor);
  }

  /** Structure snapshot used to invalidate borrowed query facades. */
  private internalgetStructureEpoch(): number {
    return this.structureEpoch;
  }

  /** Resolve current logical identity for a packed entity handle. */
  private internalgetEntityArchetype(entity: EntityHandle): Archetype | undefined {
    const record = this.records[entityIndex(entity)];
    if (!this.internalrecordIsLive(record, entityGeneration(entity))) return undefined;
    return this.graph.archetypes[record.archetypeId];
  }

  /** Component change state for query filters. */
  private internalgetComponentChange(
    entity: EntityHandle,
    componentId: number,
  ): ChangeTicks | undefined {
    const record = this.records[entityIndex(entity)];
    if (!this.internalrecordIsLive(record, entityGeneration(entity))) return undefined;
    return readComponentChange(this.graph, record, entity, componentId);
  }

  /** Allocate one epoch after a mutation has succeeded. */
  private internalnextMutationEpoch(): number {
    if (this.mutationEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new ChangeEpochExhaustedError(this.mutationEpoch);
    }
    this.mutationEpoch += 1;
    return this.mutationEpoch;
  }

  /** Record one successful structural mutation. */
  private internalmarkStructureChanged(): void {
    this.structureEpoch += 1;
  }

  /** Current structural revision for mounted World projections. */
  getStructureEpoch(): number {
    return this.structureEpoch;
  }

  /** Mark a component as both added and changed at the current tick. */
  private internalmarkComponentAdded(entity: EntityHandle, componentId: number): void {
    this.internalmarkComponentsAdded(entity, [componentId]);
  }

  /** Mark one mutation's component instances with a shared epoch. */
  private internalmarkComponentsAdded(entity: EntityHandle, componentIds: readonly number[]): void {
    const record = this.records[entityIndex(entity)];
    if (!this.internalrecordIsLive(record, entityGeneration(entity))) return;
    const epoch = this.internalnextMutationEpoch();
    markComponentsAdded(this.graph, record, entity, componentIds, epoch);
    for (const componentId of componentIds) {
      this.componentMutationEpochs[componentId] = epoch;
      this.changeJournal.append({ kind: 'component-added', entity, componentId });
    }
  }

  /** Mark an existing component as changed at the current tick. */
  private internalmarkComponentChanged(entity: EntityHandle, componentId: number): void {
    const record = this.records[entityIndex(entity)];
    if (!this.internalrecordIsLive(record, entityGeneration(entity))) return;
    let epoch: number | undefined;
    markComponentChanged(this.graph, record, entity, componentId, () => {
      epoch = this.internalnextMutationEpoch();
      return epoch;
    });
    if (epoch !== undefined) {
      this.componentMutationEpochs[componentId] = epoch;
      this.changeJournal.append({ kind: 'component-changed', entity, componentId });
    }
  }

  /** Mark one contiguous component range with a single epoch. */
  private internalmarkComponentRangeChanged(
    table: ArchetypeGraph['tables'][number],
    componentId: number,
    rowStart: number,
    rowCount: number,
  ): void {
    const epochs = table.storage.get(componentId)?.epochs;
    if (epochs === undefined || rowCount === 0) return;
    const epoch = this.internalnextMutationEpoch();
    epochs.changed.fill(epoch, rowStart, rowStart + rowCount);
    this.componentMutationEpochs[componentId] = epoch;
    for (const entity of readTableEntityRange(table, rowStart, rowCount)) {
      this.changeJournal.append({
        kind: 'component-changed',
        entity,
        componentId,
      });
    }
  }

  /** Latest mutation token for one component-owned projection. */
  private internalgetComponentMutationEpoch(componentId: number): number {
    return this.componentMutationEpochs[componentId] ?? 0;
  }

  /** Read a materialized relationship target in O(1 + k). */
  private internalgetRelationshipTargetEntities(
    source: Component,
    target: EntityHandle,
  ): readonly EntityHandle[] {
    return this.componentAccess.relationshipTargetEntries(source, target);
  }

  /** Monotonic epoch for the materialized relationship index. */
  private internalgetRelationshipEpoch(source: Component): number {
    return this.core.relationshipIndexes.get(componentId(source))?.epoch ?? 0;
  }

  /** Publish changes to a value derived without an authored mutation epoch. */
  private internalmarkDerivedComponentChanges(
    componentId: number,
    entities: Iterable<EntityHandle>,
  ): void {
    for (const entity of entities) {
      this.changeJournal.append({ kind: 'derived-component-changed', entity, componentId });
    }
  }

  /** Query facade write after the facade has already marked evidence. */
  private internalsetQueryRow(
    entity: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
  ): Result<void, EcsError> {
    return this.componentAccess.set(entity, component, value as never, false);
  }

  /** Query facade read that does not re-enter the public World API. */
  private internalgetQueryRow(
    entity: EntityHandle,
    component: Component,
  ): Result<Record<string, unknown>, EcsError> {
    return this.componentAccess.get(entity, component) as Result<Record<string, unknown>, EcsError>;
  }

  /** Remove one component's change state after archetype removal. */
  private internalremoveComponentChange(entity: EntityHandle, componentId: number): void {
    this.changeJournal.append({ kind: 'component-removed', entity, componentId });
  }

  /** Remove all change state before an entity handle is retired. */
  private internalremoveEntityChanges(entity: EntityHandle): void {
    this.changeJournal.append({ kind: 'entity-removed', entity });
  }

  /** Return resource change ticks for diagnostics and resource-driven systems. */
  getResourceChange(name: string): ChangeTicks | undefined {
    const entry = this.resources.entries.get(name);
    return entry === undefined ? undefined : { added: entry.added, changed: entry.changed };
  }

  /**
   * Route a structured error from
   * an engine-internal subsystem (e.g. RenderSystem extract stage, w15).
   *
   * Mirrors the private `errorHandler(err, ctx)` call sites inside `World`
   * itself; the dedicated accessor avoids exposing `errorHandler` directly
   * and keeps the routing contract under the `_xxx` `@internal` umbrella so
   * AI users do not discover it through IDE autocomplete on `World`.
   *
   * Not part of the public API.
   */
  private internalrouteError(err: EcsError, ctx?: { readonly systemName: string }): void {
    // Internal expected failures are reported without becoming a second
    // schedule or terminal hook. The host owns fatal frame policy.
    console.error(`[${ctx?.systemName ?? 'World'}]`, err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // accessors — M1 extraction seam
  // ──────────────────────────────────────────────────────────────────────────

  /** */ private internalgetRecords(): EntityRecord[] {
    return this.records;
  }
  /** */ private internalgetFreeIndices(): number[] {
    return this.freeIndices;
  }
  /** */ private internalgetResources(): ResourceStore {
    return this.resources;
  }
  /** */ private internalgetFixedAccumulator(): number {
    return this.fixedAccumulator;
  }
  /** */ private internalsetFixedAccumulator(value: number): void {
    this.fixedAccumulator = value;
  }
  /** */ private internalgetUniqueRefs(): UniqueRefStore {
    return this.uniqueRefs;
  }
  /** */ private internalgetBufferPool(): BufferPool {
    return this.bufferPool;
  }
  /** Scheduler-owned mutable clock capability. */
  private internalgetClockWriter(): ClockWriter {
    return this.clock.writer;
  }
  /** */ private internalgetSchedule(
    token: import('./schedule-token').ScheduleToken,
  ): Schedule | undefined {
    return this.schedules.get(token);
  }
  /** */ private internalgetSchedules(): ReadonlyMap<
    import('./schedule-token').ScheduleToken,
    Schedule
  > {
    return this.schedules;
  }
  /** */ private internalgetSharedRefs(): SharedRefStore {
    return this.sharedRefs;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // System registration + update (M3)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a system with query descriptor and optional ordering constraints.
   *
   * `const Qs` mirrors the free `addSystem` signature so the call-site
   * `queries` tuple is locked literal-form, letting `descriptor.fn`'s first
   * parameter recover per-query row access shapes (S-5, KD-3 — class method
   * generic, not free function double track).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.addSystem(Update, {
   *   name: 'read-pos',
   *   queries: [{ with: [Position] }],
   *   fn: (world, queries) => { void world; for (const row of queries[0]) { void row.entity; } },
   * });
   * ```
   */
  addSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    descriptor: SystemDescriptor<Qs>,
  ): Result<void, ScheduleScopeMismatchError> {
    return worldAddSystem(this, schedule, descriptor);
  }

  /**
   * Remove a registered system by name (M2 — plan-strategy D-3).
   *
   * Returns `Result<void, ScheduleMutationError>`:
   * - ok branch: the slot is dropped and the schedule will rebuild on the
   *   next `update()`.
   * - err branch with `.code === 'system-before-unknown'`: no system carries
   *   this name; `.detail.candidates` lists the registered names.
   *
   * Designed to support `@forgeax/engine-remote`'s typed `injectSystem` /
   * `removeSystem` channel and the WS-disconnect reverse-remove path.
   *
   * @example
   * ```ts
   * const r = world.removeSystem(Update, 'movement');
   * if (!r.ok) console.error(r.error.code, r.error.detail.candidates);
   * ```
   */
  removeSystem(
    schedule: import('./schedule-token').ScheduleToken,
    name: string,
  ): Result<void, ScheduleMutationError | ScheduleScopeMismatchError> {
    return worldRemoveSystem(this, schedule, name);
  }

  /**
   * Replace a registered system in-place (M2 — plan-strategy D-3 atomic semantics).
   *
   * Overwrites the descriptor stored under `name` while preserving the
   * registration slot — `before / after` references that target this name
   * remain bound.
   *
   * Returns `Result<void, ScheduleMutationError>`:
   * - ok branch: descriptor swapped, schedule marked dirty.
   * - err branch with `.code === 'system-before-unknown'`: no system carries
   *   this name; use `addSystem(descriptor)` to register a new one instead.
   *
   * @example
   * ```ts
   * const r = world.replaceSystem(Update, 'movement', {
   *   name: 'movement',
   *   queries: [{ with: [Position] }],
   *   fn: (world, queryResults) => { ... },
   * });
   * ```
   */
  replaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    name: string,
    descriptor: SystemDescriptor<Qs>,
  ): Result<void, ScheduleMutationError | ScheduleScopeMismatchError> {
    return worldReplaceSystem(this, schedule, name, descriptor);
  }

  /**
   * Batch-register systems to a set. Validates the set token before writing.
   *
   * - First call for a system name: registers it via the existing `addSystem` path.
   * - Subsequent calls: only adds the system name to the set's members (dedup).
   *
   * Returns `Result.err` with `SystemSetNotRegisteredError` if the set token
   * fails identity validation.
   *
   * @example
   * ```ts
   * const GameplaySet = defineSystemSet({ name: 'gameplay' });
   * const world = new World();
   * const r = world.addSystems(Update, GameplaySet, [movement, collision]);
   * if (!r.ok) console.error(r.error.code, r.error.hint);
   * ```
   */
  addSystems<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    set: SystemSet,
    systems: ReadonlyArray<SystemDescriptor<Qs>>,
  ): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
    return worldAddSystems(this, schedule, set, systems);
  }

  /**
   * Execute one frame: run all systems in DAG order, then flush deferred commands.
   * Empty world (no systems) completes silently (E-09).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * world.update(); // run all systems + flush commands
   * ```
   */
  update(
    deltaSeconds = 0,
  ): Result<
    void,
    | TimeDeltaInvalidError
    | TimeConfigInvalidError
    | ScheduleScopeMismatchError
    | WorldPoisonedError
    | CommandFailedError
    | SystemFailedError
    | import('./errors').CyclicDependencyError
    | SharedKernelFailureError
  > {
    return worldUpdate(this, deltaSeconds);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Resource CRUD (M3)
  // ──────────────────────────────────────────────────────────────────────────

  /** Insert or overwrite a resource (idempotent, E-13). */
  insertResource<T>(key: string | { readonly name: string }, value: T): void {
    worldInsertResource(this, key, value);
  }

  /**
   * Get a resource by key.
   * @throws ResourceNotFoundError if key not found (E-14).
   */
  getResource(key: typeof import('./time').Time): import('./time').TimeResource;
  getResource(key: typeof import('./time').FixedTime): import('./time').FixedTimeResource;
  getResource<T>(key: string | { readonly name: string }): T;
  getResource<T>(key: string | { readonly name: string }): T {
    return worldGetResource<T>(this, key);
  }

  /** Check if a resource exists. */
  hasResource(key: string | { readonly name: string }): boolean {
    return worldHasResource(this, key);
  }

  /** Remove a resource by key. */
  removeResource(key: string | { readonly name: string }): void {
    worldRemoveResource(this, key);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Inspection / diagnostics (M4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Return a typed diagnostic snapshot of the World state.
   * All fields are non-undefined. Useful for AI users to programmatically
   * introspect entity count, archetypes, registered components, systems,
   * and resources without console.log or a debugger.
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const snap = world.inspect();
   * console.log(snap.entityCount, snap.activeComponents);
   * ```
   */
  inspect(): WorldInspection {
    return detachWorldInspection(worldInspect(this));
  }

  /** Return the registered schedule graphs and their declared access metadata. */
  scheduleData(): ReadonlyArray<WorldScheduleData> {
    return worldScheduleData(this);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Managed-ref public API (feat-20260528-rapier-physics M1 / t4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Allocate a standalone managed reference handle with an optional release
   * callback. Returns a branded {@link Handle}<Target, 'unique'> that can be
   * stored in schema-vocab `ref<T>` fields or resolved through
   * {@link UniqueRefStore.resolve} (via `world.get` on a component with
   * `ref<T>` fields).
   *
   * When the handle is released (despawn / removeComponent / set-overwrite),
   * the `onRelease` callback fires with the payload (captured on the stack);
   * by then the slot's bookkeeping (callback table, payload map, freelist) is
   * already cleared, so a *throwing* `onRelease` re-propagates from the first
   * `release` call without leaving the store inconsistent — a second `release`
   * of the same handle returns `UniqueRefDoubleReleaseError` as expected. RAII
   * cleanup semantics preserved (plan-strategy D-5; throw-safety AC-01/02).
   *
   * Handles are *operational, not persistent*: caching them across release
   * boundaries (despawn / removeComponent / set-overwrite) is undefined
   * behavior — the same `u32` may silently resolve to a freshly allocated
   * payload after slot reuse. See `packages/ecs/README.md` § "Managed handles
   * are operational, not persistent" and `docs/specs/2026-06-14-ecs-managed-
   * lifecycle-ssot-design.md` § 3.3.
   *
   * @typeParam Target - phantom string branding the handle (type-level only).
   * @typeParam T - the payload type stored alongside the handle.
   * @param target - phantom target string (type-level discriminant).
   * @param payload - the value to store. Identity-stable until release.
   * @param onRelease - optional cleanup hook called with the payload on release.
   * @returns a branded `Handle<Target, 'unique'>` u32.
   *
   * @example
   * ```ts
   * const world = new World();
   * const handle = world.allocUniqueRef<'PhysicsBody', RigidBodyHandle>(
   *   'PhysicsBody',
   *   rapierHandle,
   *   (h) => rapierWorld.removeRigidBody(h),
   * );
   * const Holder = defineComponent('Holder', { body: 'unique<PhysicsBody>' });
   * world.spawn(Holder, { body: handle });
   * // Despawn triggers onRelease -> Rapier body is cleaned up.
   * ```
   */
  allocUniqueRef<Target extends string, T>(
    target: Target,
    payload: T,
    onRelease?: (payload: T) => void,
  ): Handle<Target, 'unique'> {
    return worldAllocUniqueRef(this, target, payload, onRelease);
  }

  /**
   * Allocate a shared (refcount-tracked) handle through the per-World
   * {@link SharedRefStore}. Returns a `Handle<Target, 'shared'>` u32 with
   * rc=1 (the alloc-grant). Consumers retain/release via `world.sharedRefs`.
   *
   * Final release publishes structured evidence through the owning
   * {@link SharedRefStore}; payload disposal remains with the
   * renderer/assets/plugin owner and is not a user callback.
   *
   * Intended for asset-registry-style producers — anything whose lifecycle
   * is shared across multiple holders (ECS components + external systems).
   * The single-holder one-shot release pattern stays on
   * {@link World.allocUniqueRef} (`Handle<T, 'unique'>`).
   *
   * @typeParam Target - phantom string branding the handle (type-level only).
   * @typeParam T - the payload type stored alongside the handle.
   * @param target - phantom target string (type-level discriminant).
   * @param payload - the value to store. Identity-stable until final release.
   * @returns a branded `Handle<Target, 'shared'>` u32 with rc=1.
   *
   * @example
   * ```ts
   * const world = new World();
   * const handle = world.allocSharedRef<'MaterialAsset', MaterialPayload>(
   *   'MaterialAsset',
   *   payload,
   * );
   * const M = defineComponent('M', { asset: 'shared<MaterialAsset>' });
   * world.spawn({ component: M, data: { asset: handle } });
   * // The write-barrier dispatch retains/releases automatically on spawn / despawn.
   * ```
   */
  allocSharedRef<Target extends string, T>(target: Target, payload: T): Handle<Target, 'shared'> {
    return worldAllocSharedRef(this, target, payload);
  }

  /**
   * Return one producer-owned shared handle per `(target, payload object)` in
   * this World. Repeated discovery does not retain; ECS holders still retain
   * and release through the normal write barrier. Asset catalogues use this
   * when repeated scene instantiation resolves the same catalogued payload.
   * Use {@link World.allocSharedRef} for independent resources or deleters.
   */
  internSharedRef<Target extends string, T extends object>(
    target: Target,
    payload: T,
  ): Handle<Target, 'shared'> {
    return worldInternSharedRef(this, target, payload);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Component access facade — storage ownership is world-component-access.
  // ──────────────────────────────────────────────────────────────────────────

  private relationshipTargetWriteError(
    component: Component,
    operation: string,
  ): Result<never, EcsError> {
    return err(new RelationshipTargetReadonlyError(component.name, operation));
  }

  private relationshipTargetPayloadWrites(data: Readonly<Record<string, unknown>>): boolean {
    return Object.values(data).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      if (ArrayBuffer.isView(value)) return value.byteLength > 0;
      return true;
    });
  }

  get<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<ShapeOf<S>, EcsError> {
    return this.componentAccess.get(entity, component);
  }

  /**
   * Test live component presence without constructing a Result error.
   *
   * Read projections commonly need to branch on optional components for many
   * entities. Calling `get` for that branch allocates a structured
   * ComponentNotPresentError on every ordinary miss (and StaleEntityError for
   * a dangling handle). This predicate is deliberately non-throwing and
   * returns false for both cases; callers that need the detailed error should
   * continue to use `get`.
   */
  hasComponent(entity: EntityHandle, component: Component): boolean {
    const archetype = this.internalgetEntityArchetype(entity);
    return (
      archetype?.components.some(
        (candidate) => componentId(candidate) === componentId(component),
      ) === true
    );
  }

  private internalgetArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): ArrayLike<number> | undefined {
    return this.componentAccess._getArrayView(entity, component, fieldName);
  }

  set<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    component: C & WritableComponent<C>,
    value: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    if (isRelationshipTarget(component)) return this.relationshipTargetWriteError(component, 'set');
    return this.componentAccess.set(entity, component, value);
  }

  addComponent<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    componentData: ComponentData<S> & { component: C & WritableComponent<C> },
  ): Result<void, EcsError> {
    if (
      isRelationshipTarget(componentData.component) &&
      this.relationshipTargetPayloadWrites(componentData.data as Record<string, unknown>)
    )
      return this.relationshipTargetWriteError(componentData.component, 'addComponent');
    return this.componentAccess.addComponent(entity, componentData);
  }

  private internaladdComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
    internal: boolean,
  ): Result<void, EcsError> {
    return this.componentAccess._addComponentCore(entity, componentData, internal);
  }

  removeComponent<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    component: C & WritableComponent<C>,
  ): Result<void, EcsError> {
    if (isRelationshipTarget(component))
      return this.relationshipTargetWriteError(component, 'removeComponent');
    return this.componentAccess.removeComponent(entity, component);
  }

  private internalremoveComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    internal: boolean,
  ): Result<void, EcsError> {
    return this.componentAccess._removeComponentCore(entity, component, internal);
  }

  private internalallocatePendingEntity(): EntityHandle {
    return this.componentAccess._allocatePendingEntity();
  }
  /** */ private internalcancelPendingEntity(entity: EntityHandle): void {
    this.componentAccess._cancelPendingEntity(entity);
  }

  private internalmaterializePendingEntity(
    entity: EntityHandle,
    componentDatas: ComponentData[],
  ): Result<void, EcsError> {
    return this.componentAccess._materializePendingEntity(entity, componentDatas);
  }

  /** Shared structural preflight for direct and deferred writes. */
  private internalpreflightComponentData(
    holder: EntityHandle | null,
    componentData: ComponentData,
    pendingEntities?: ReadonlySet<number>,
    unavailableEntities?: ReadonlySet<number>,
  ): Result<void, EcsError> {
    return this.componentAccess.preflightComponentData(
      holder,
      componentData,
      pendingEntities,
      unavailableEntities,
    );
  }

  /** */ private internalallocateIndex(): number {
    return this.componentAccess.allocateIndex();
  }
  /** */ private internalrecordIsLive(r: EntityRecord | undefined, g: number): r is EntityRecord {
    return this.componentAccess.recordIsLive(r, g);
  }
  /** */ private internallookupAlive(
    e: EntityHandle,
    op: string,
    c?: string,
  ): Result<EntityRecord, EcsError> {
    return this.componentAccess.lookupAlive(e, op, c);
  }
  /** */ private internalreadRow<S extends ComponentSchema>(
    a: Archetype,
    c: Component<string, S>,
    r: number,
  ): ShapeOf<S> {
    return this.componentAccess.readRow(a, c, r);
  }
  /** */ private internalwriteEntitySelf(a: Archetype, r: number, h: EntityHandle): void {
    this.componentAccess.writeEntitySelf(a, r, h);
  }
  /** */ private internalwriteRow<S extends ComponentSchema>(
    a: Archetype,
    c: Component<string, S>,
    r: number,
    v: ShapeOf<S>,
  ): void {
    this.componentAccess.writeRow(a, c, r, v);
  }
  /** */ private internalreleaseManagedRefsOnRow(a: Archetype, c: Component, r: number): void {
    this.componentAccess.releaseManagedRefsOnRow(a, c, r);
  }
  /** */ private internalrelationshipOnInsert(
    h: EntityHandle,
    c: Component,
    v: Record<string, unknown>,
  ): Result<void, EcsError> {
    return this.componentAccess.relationshipOnInsert(h, c, v);
  }
  /** */ private internalrelationshipOnRemove(
    h: EntityHandle,
    c: Component,
    v: Record<string, unknown>,
  ): Result<void, EcsError> {
    return this.componentAccess.relationshipOnRemove(h, c, v);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Spawn
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Spawn an entity with one or more components.
   * Multi-component spawn directly targets the correct archetype (AC-06).
   *
   * @returns `Result<Entity, EcsError>` — `ok(Entity)` on success.
   *   EntityIndexOverflowError still throws (build-time / infrastructure failure).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const r = world.spawn({ component: Position, data: { x: 0, y: 0 } });
   * if (!r.ok) { console.error(r.error.code); return; }
   * const entity = r.value;
   * ```
   */
  spawn<const SArr extends readonly ComponentSchema[]>(
    ...componentDatas: {
      [K in keyof SArr]: {
        component: Component<string, SArr[K]>;
        data: Partial<InputShapeOf<SArr[K]>>;
      };
    }
  ): Result<EntityHandle, EcsError>;
  spawn(...componentDatas: ComponentData[]): Result<EntityHandle, EcsError> {
    const target = componentDatas.find(
      (data) =>
        isRelationshipTarget(data.component) &&
        this.relationshipTargetPayloadWrites(data.data as Record<string, unknown>),
    );
    if (target !== undefined) return this.relationshipTargetWriteError(target.component, 'spawn');
    return spawnCore(this, componentDatas, false);
  }

  /**
   * Core implementation of `spawn` with reentry guard.
   *
   * @param internal — `true` when called from relationship maintenance
   *   (lazy mirror create or exclusive reparent).
   */
  private internalspawnCore(
    componentDatas: ComponentData[],
    internal: boolean,
  ): Result<EntityHandle, EcsError> {
    return spawnCore(this, componentDatas, internal);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Despawn (D-08: generation retirement)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Despawn an entity. Stale handles are silently ignored (E-01, AC-17).
   * Generation retirement: gen=255 → index permanently retired (D-08/E-08).
   *
   * @returns `Result<void, EcsError>` — `ok(void)` always (idempotent on stale handles).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.despawn(e);
   * r.unwrap(); // idempotent: ok(void) even on stale handle
   * ```
   */
  despawn(entity: EntityHandle): Result<void, EcsError> {
    return despawnCore(this, entity, false);
  }

  /** Despawn every live entity through the normal lifecycle and ref cleanup path. */
  despawnAll(): Result<void, EcsError> {
    const entities: EntityHandle[] = [];
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      if (record !== undefined && record.archetypeId >= 0) {
        entities.push(encodeEntity(index, record.generation));
      }
    }
    for (const entity of entities) {
      const result = this.despawn(entity);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }

  /**
   * Core implementation of `despawn` with reentry guard.
   *
   * @param internal — `true` when called from within linkedSpawn cascade.
   *   Nested despawn skips relationship pruning after the parent is retired;
   *   the linkedSpawn collection still walks the subtree so grandchildren
   *   cascade correctly (tweak-20260714 M2, R-6).
   */
  private internaldespawnCore(entity: EntityHandle, internal: boolean): Result<void, EcsError> {
    return despawnCore(this, entity, internal);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hierarchy facade — lifecycle orchestration lives in world-entity-lifecycle.
  // Component storage still owns typed relationship mutation primitives.
  // ──────────────────────────────────────────────────────────────────────────

  addChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    return worldAddChild(this, parent, child, component, data);
  }

  removeChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError> {
    return worldRemoveChild(this, parent, child, component);
  }

  reparent<S extends ComponentSchema>(
    child: EntityHandle,
    newParent: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    return worldReparent(this, child, newParent, component, data);
  }

  iterAncestors(entity: EntityHandle): Iterable<EntityHandle> {
    return worldIterAncestors(this, entity);
  }

  iterDescendants(entity: EntityHandle): Iterable<EntityHandle> {
    return worldIterDescendants(this, entity);
  }
}

/** Freeze the detached POD produced by World.inspect(). */
function detachWorldInspection<T extends object>(snapshot: T): Readonly<T> {
  return freezeInspection(snapshot);
}

function freezeInspection<T>(value: T): Readonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as Readonly<T>;
  }
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
      freezeInspection(child);
    }
  }
  return Object.freeze(value) as Readonly<T>;
}
