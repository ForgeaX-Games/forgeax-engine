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

import type {
  Handle,
  LocalEntityId,
  MountOverride,
  Result,
  SceneAsset,
  SceneEntity,
  SceneInstanceMount,
} from '@forgeax/engine-types';
import type { Archetype } from './archetype';
import { type ArchetypeGraph, createArchetypeGraph } from './archetype-graph';
import { BufferPool } from './buffer-pool';
import type { FieldView } from './column';
import type {
  Component,
  ComponentSchema,
  InputShapeOf,
  ManagedArrayElementType,
  ManagedArrayElementValue,
  ShapeOf,
} from './component';
import type { EntityHandle } from './entity-handle';
import type {
  ArrayPopEmptyError,
  CardinalityExceededError,
  ComponentAlreadyPresentError,
  ComponentNotDefinedError,
  ComponentNotPresentError,
  FixedArrayOverflowError,
  FixedSizeMismatchError,
  ManagedBufferOutOfBoundsError,
  ManagedBufferShrinkNotSupportedError,
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
  RemoveEssentialComponentError,
  ScheduleMutationError,
  ScheduleScopeMismatchError,
  SpawnLightInvalidBoundsError,
  StaleEntityError,
  SystemSetNotRegisteredError,
  TimeConfigInvalidError,
  TimeDeltaInvalidError,
  UniqueRefDoubleReleaseError,
  UniqueRefReleasedError,
} from './errors';
import type { QueryDescriptor } from './query';
import { createResourceStore, type ResourceStore } from './resource';
import {
  createSchedule,
  type ErrorContext,
  type ErrorHandler,
  matchSeverity,
  type Schedule,
  type SystemDescriptor,
  type SystemSet,
} from './schedule';
import { FixedUpdate, Update } from './schedule-token';
import { SharedRefStore } from './shared-ref-store';
import {
  createFixedTimeResource,
  createTimeResource,
  DEFAULT_TIME_POLICY,
  FIXED_TIME_RESOURCE_KEY,
  TIME_RESOURCE_KEY,
  type WorldOptions,
} from './time';
import { UniqueRefStore } from './unique-ref-store';
import { WorldComponentAccess } from './world-component-access';
import {
  despawnCore,
  spawnCore,
  worldAddChild,
  worldIterAncestors,
  worldIterDescendants,
  worldRemoveChild,
  worldReparent,
} from './world-entity-lifecycle';
import {
  initializeWorldScene,
  type SceneAssetResolver,
  type SceneInstanceStatePayload,
  type SceneInstantiateDiagnostic,
  type SceneInstantiateFlatOk,
  type SceneInstantiateOk,
  type SceneMembersSpawn,
  worldApplyMountOverride,
  worldBuildSceneEntityComponentDatas,
  worldDespawnDescendants,
  worldDespawnScene,
  worldDetachSceneMember,
  worldGetSceneAssetForInstance,
  worldGetSceneAssetResolver,
  worldGetSceneInstanceState,
  worldInstantiateScene,
  worldInstantiateSceneAsset,
  worldInstantiateSceneAssetFlat,
  worldInstantiateSceneFlat,
  worldInstantiateSceneRec,
  worldMountOverridesToStateMap,
  worldReattachSceneMember,
  worldRemoveSceneOverride,
  worldResolveMountSource,
  worldResolveSceneAsset,
  worldResolveSceneInstanceStatePayload,
  worldSetSceneAssetResolver,
  worldSetSceneOverride,
  worldSetUniqueRefPayload,
  worldSpawnMountEntity,
  worldSpawnSceneMembers,
  worldValidateMountOverrides,
} from './world-scene';

export type {
  SceneInstanceStatePayload,
  SceneInstantiateDiagnostic,
  SceneInstantiateFlatOk,
  SceneInstantiateOk,
  SceneMembersSpawn,
} from './world-scene';

import {
  worldAddSystem,
  worldAddSystems,
  worldAllocSharedRef,
  worldAllocUniqueRef,
  worldConfigureSets,
  worldGetResource,
  worldHasResource,
  worldInsertResource,
  worldInspect,
  worldRemoveResource,
  worldRemoveSystem,
  worldReplaceSystem,
  worldSetErrorHandler,
  worldUpdate,
} from './world-scheduling';

/**
 * Union of all EcsError types that World methods can return via Result.
 * AI users: switch on `.code` for programmatic branching.
 */
export type EcsError =
  | StaleEntityError
  | ComponentNotPresentError
  | ComponentAlreadyPresentError
  | UniqueRefReleasedError
  | UniqueRefDoubleReleaseError
  | ManagedBufferOutOfBoundsError
  | ManagedBufferShrinkNotSupportedError
  | FixedArrayOverflowError
  | FixedSizeMismatchError
  | ArrayPopEmptyError
  | SpawnLightInvalidBoundsError
  | RelationshipSelfCycleError
  | RelationshipMirrorComponentNotRegisteredError
  | RelationshipMirrorFieldTypeMismatchError
  | RelationshipDetachMismatchError
  | ComponentNotDefinedError
  | RemoveEssentialComponentError
  | SystemSetNotRegisteredError
  | TimeDeltaInvalidError
  | TimeConfigInvalidError
  | ScheduleScopeMismatchError;

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

/**
 * Filter `S` down to keys whose value type is a managed-array keyword
 * (`array<T>` or `array<T, N>`). Drives the `world.push` / `world.pop` /
 * `world.capacity` `fieldName` parameter so cross-shape access (entity /
 * buffer / string / scalar field names) is a TypeScript compile-time error
 * (plan-strategy §2.1).
 */
export type ArrayFieldsOf<S extends ComponentSchema> = {
  [K in keyof S]: S[K] extends
    | `array<${ManagedArrayElementType}>`
    | `array<${ManagedArrayElementType}, ${number}>`
    ? K
    : never;
}[keyof S];

/**
 * Resolve the element value type for an `array<T>` / `array<T, N>` field
 * key. `entity` element fields surface the `Entity` opaque type; every
 * scalar element folds to `number` (bool included; the slot view stores 0/1).
 */
export type ArrayFieldElementValue<
  S extends ComponentSchema,
  K extends keyof S,
> = S[K] extends `array<${infer Elem extends ManagedArrayElementType}>`
  ? ManagedArrayElementValue<Elem>
  : S[K] extends `array<${infer Elem extends ManagedArrayElementType}, ${number}>`
    ? ManagedArrayElementValue<Elem>
    : never;

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
  /** Allocated row capacity. */
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
  row: number;
}

/**
 * The World owns:
 *   - the registry of known component schemas;
 *   - all archetypes (via ArchetypeGraph);
 *   - the entity index table (records by index slot);
 *   - the free-list of recyclable entity slots.
 */
export class World {
  // ── Internal state ──

  /** Entity records: index slot → record. */
  private readonly records: EntityRecord[] = [];
  /** Free index slots (LIFO stack). */
  private readonly freeIndices: number[] = [];
  /**
   * Relationship-sync reentry guard (feat-20260531 M2 / plan-strategy D-7).
   /** The archetype graph: manages all archetypes + edge caching. */
  private readonly graph: ArchetypeGraph = createArchetypeGraph();
  /** DAG schedules for the two built-in execution scopes. */
  private readonly schedules = new Map([
    [Update, createSchedule(Update)],
    [FixedUpdate, createSchedule(FixedUpdate)],
  ]);
  /** Resource store: typed key-value global singletons. */
  private readonly resources: ResourceStore = createResourceStore();
  /** Error handler for Layer 3 (defaults to matchSeverity — Panic throws). */
  private errorHandler: ErrorHandler = matchSeverity;
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
  private uniqueRefs: UniqueRefStore = new UniqueRefStore();
  /**
   * Per-World `SharedRefStore` (feat-20260614 M3). Backs every `shared<T>`
   * schema field + the `world.allocSharedRef` facade. Public read-only so AI
   * users can `retain` / `release` / `resolve` user-tier handles directly off
   * the world (the surface is small enough that hiding it behind another
   * facade would be a phantom indirection - charter F1 single-entry
   * indexability).
   *
   * M6 D-10: the release signal is the per-handle `onLastRelease` deleter
   * passed as the third argument to `allocSharedRef` — there is no global
   * listener. M6 D-15: the store manages only user-tier slots
   * (`>= BUILTIN_BASE`); builtin handles are process-static in
   * `BuiltinAssetRegistry` and never reference-counted.
   */
  readonly sharedRefs: SharedRefStore = new SharedRefStore();
  /**
   * BufferPool backing every `buffer:<N>` schema-vocab field (M2). Eagerly
   * constructed (per-World, D-2). `spawn` allocs slots for buffer fields and
   * stores the slot id in the u32 column; `despawn` / `removeComponent`
   * release the slots; `set(e, C, { field: Uint8Array })` copies bytes into
   * the live view without re-allocating (schema-declared byteLength is
   * fixed in v1; runtime grow is reserved for the M4 carry-over path).
   */
  private readonly bufferPool: BufferPool = new BufferPool();
  private readonly componentAccess = new WorldComponentAccess({
    graph: this.graph,
    records: this.records,
    freeIndices: this.freeIndices,
    bufferPool: this.bufferPool,
    uniqueRefs: this.uniqueRefs,
    sharedRefs: this.sharedRefs,
    routeError: (err, ctx) => this._routeError(err as EcsError, ctx),
  });

  constructor(options: WorldOptions = {}) {
    const policy = { ...DEFAULT_TIME_POLICY, ...options.time };
    this.resources.data.set(TIME_RESOURCE_KEY, createTimeResource(policy));
    this.resources.data.set(FIXED_TIME_RESOURCE_KEY, createFixedTimeResource(policy));
    initializeWorldScene(this);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal access — query engine
  // ──────────────────────────────────────────────────────────────────────────

  /** @internal Expose archetype graph for query engine. Not part of public API. */
  _getGraph(): ArchetypeGraph {
    return this.graph;
  }

  /**
   * @internal Route a structured error through the Layer-3 ErrorHandler from
   * an engine-internal subsystem (e.g. RenderSystem extract stage, w15).
   *
   * Mirrors the private `errorHandler(err, ctx)` call sites inside `World`
   * itself; the dedicated accessor avoids exposing `errorHandler` directly
   * and keeps the routing contract under the `_xxx` `@internal` umbrella so
   * AI users do not discover it through IDE autocomplete on `World`.
   *
   * Not part of the public API.
   */
  _routeError(err: EcsError, ctx: ErrorContext): void {
    this.errorHandler(err, ctx);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // @internal accessors — M1 extraction seam
  // ──────────────────────────────────────────────────────────────────────────

  /** @internal */ _getRecords(): EntityRecord[] {
    return this.records;
  }
  /** @internal */ _getFreeIndices(): number[] {
    return this.freeIndices;
  }
  /** @internal */ _getResources(): ResourceStore {
    return this.resources;
  }
  /** @internal */ _getErrorHandler(): ErrorHandler {
    return this.errorHandler;
  }
  /** @internal */ _setErrHandler(h: ErrorHandler): void {
    this.errorHandler = h;
  }
  /** @internal */ _getFixedAccumulator(): number {
    return this.fixedAccumulator;
  }
  /** @internal */ _setFixedAccumulator(value: number): void {
    this.fixedAccumulator = value;
  }
  /** @internal */ _getUniqueRefs(): UniqueRefStore {
    return this.uniqueRefs;
  }
  /** @internal */ _getBufferPool(): BufferPool {
    return this.bufferPool;
  }
  /** @internal */ _getSchedule(
    token: import('./schedule-token').ScheduleToken,
  ): Schedule | undefined {
    return this.schedules.get(token);
  }
  /** @internal */ _getSchedules(): ReadonlyMap<
    import('./schedule-token').ScheduleToken,
    Schedule
  > {
    return this.schedules;
  }
  /** @internal */ _getSharedRefs(): SharedRefStore {
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
   * parameter recover per-query bundle shapes (S-5, KD-3 — class method
   * generic, not free function double track).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.addSystem(Update, {
   *   name: 'read-pos',
   *   queries: [{ with: [Position] }],
   *   fn: (world, queryResults) => { void world; for (const _b of queryResults[0]) { void _b; } },
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
   * Record set-level ordering constraints (M1 record layer only).
   *
   * Validates all input tokens (main set + before/after members) before
   * writing. Returns `Result.err` with `SystemSetNotRegisteredError` if any
   * token fails identity validation.
   *
   * @example
   * ```ts
   * const setA = defineSystemSet({ name: 'a' });
   * const setB = defineSystemSet({ name: 'b' });
   * const r = world.configureSets(Update, { set: setA, before: [setB] });
   * if (!r.ok) console.error(r.error.code, r.error.hint);
   * ```
   */
  configureSets(
    schedule: import('./schedule-token').ScheduleToken,
    opts: {
      readonly set: SystemSet;
      readonly before?: readonly SystemSet[];
      readonly after?: readonly SystemSet[];
    },
  ): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
    return worldConfigureSets(this, schedule, opts);
  }

  /**
   * Set a custom error handler for Layer 3 (ErrorHandler + Severity).
   * Default is `matchSeverity` (Panic → throw, Error → console.error, etc.).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.setErrorHandler((err, _ctx) => { console.error(err); });
   * world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * ```
   */
  setErrorHandler(handler: ErrorHandler): void {
    worldSetErrorHandler(this, handler);
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
  ): Result<void, TimeDeltaInvalidError | TimeConfigInvalidError | ScheduleScopeMismatchError> {
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
    return worldInspect(this);
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
   * D-10: pass `onLastRelease` as the third argument — a per-handle deleter
   * that fires once when this handle's rc transitions 1 -> 0 (mirrors
   * {@link World.allocUniqueRef}'s `onRelease`). There is no global release
   * listener; the signal is per-handle. Phase-1 producers (AssetRegistry)
   * pass no deleter (the alloc-grant rc never reaches 0 during normal use).
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
   * @param onLastRelease - optional per-handle deleter fired once at rc 1 -> 0.
   * @returns a branded `Handle<Target, 'shared'>` u32 with rc=1.
   *
   * @example
   * ```ts
   * const world = new World();
   * const handle = world.allocSharedRef<'MaterialAsset', MaterialPayload>(
   *   'MaterialAsset',
   *   payload,
   *   (p) => releaseGpuResources(p),
   * );
   * const M = defineComponent('M', { asset: 'shared<MaterialAsset>' });
   * world.spawn({ component: M, data: { asset: handle } });
   * // The write-barrier dispatch retains/releases automatically on spawn / despawn.
   * ```
   */
  allocSharedRef<Target extends string, T>(
    target: Target,
    payload: T,
    onLastRelease?: (payload: T) => void,
  ): Handle<Target, 'shared'> {
    return worldAllocSharedRef(this, target, payload, onLastRelease);
  }

  /**
   * Check cardinality bound for a component before archetype mutation
   * (plan-strategy D-3). Returns `CardinalityExceededError` if adding one
   * more instance would exceed the declared `cardinality` of the component.
   * Components without a cardinality bound (undefined) pass instantly.
   */

  // ──────────────────────────────────────────────────────────────────────────
  // Component access facade — storage ownership is world-component-access.
  // ──────────────────────────────────────────────────────────────────────────

  get<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<ShapeOf<S>, EcsError> {
    return this.componentAccess.get(entity, component);
  }

  _getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): FieldView | undefined {
    return this.componentAccess._getArrayView(entity, component, fieldName);
  }

  set<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    value: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    return this.componentAccess.set(entity, component, value);
  }

  push<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
    value: ArrayFieldElementValue<S, K>,
  ): Result<void, EcsError> {
    return this.componentAccess.push(entity, component, fieldName, value);
  }

  pop<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
  ): Result<ArrayFieldElementValue<S, K>, EcsError> {
    return this.componentAccess.pop(entity, component, fieldName);
  }

  capacity<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
  ): Result<number, EcsError> {
    return this.componentAccess.capacity(entity, component, fieldName);
  }

  _removeArrayElementByValue<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
    value: ArrayFieldElementValue<S, K>,
  ): Result<void, EcsError> {
    return this.componentAccess._removeArrayElementByValue(entity, component, fieldName, value);
  }

  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): Result<void, EcsError> {
    return this.componentAccess.addComponent(entity, componentData);
  }

  _addComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
    internal: boolean,
  ): Result<void, EcsError> {
    return this.componentAccess._addComponentCore(entity, componentData, internal);
  }

  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError> {
    return this.componentAccess.removeComponent(entity, component);
  }

  _removeComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    internal: boolean,
  ): Result<void, EcsError> {
    return this.componentAccess._removeComponentCore(entity, component, internal);
  }

  _allocatePendingEntity(): EntityHandle {
    return this.componentAccess._allocatePendingEntity();
  }

  _materializePendingEntity(entity: EntityHandle, componentDatas: ComponentData[]): void {
    this.componentAccess._materializePendingEntity(entity, componentDatas);
  }

  /** @internal */ _checkCardinality(c: Component, n: number): CardinalityExceededError | null {
    return this.componentAccess.checkCardinality(c, n);
  }
  /** @internal */ _allocateIndex(): number {
    return this.componentAccess.allocateIndex();
  }
  /** @internal */ _recordIsLive(r: EntityRecord | undefined, g: number): r is EntityRecord {
    return this.componentAccess.recordIsLive(r, g);
  }
  /** @internal */ _lookupAlive(
    e: EntityHandle,
    op: string,
    c?: string,
  ): Result<EntityRecord, EcsError> {
    return this.componentAccess.lookupAlive(e, op, c);
  }
  /** @internal */ _readRow<S extends ComponentSchema>(
    a: Archetype,
    c: Component<string, S>,
    r: number,
  ): ShapeOf<S> {
    return this.componentAccess.readRow(a, c, r);
  }
  /** @internal */ _writeEntitySelf(a: Archetype, r: number, h: EntityHandle): void {
    this.componentAccess.writeEntitySelf(a, r, h);
  }
  /** @internal */ _writeRow<S extends ComponentSchema>(
    a: Archetype,
    c: Component<string, S>,
    r: number,
    v: ShapeOf<S>,
  ): void {
    this.componentAccess.writeRow(a, c, r, v);
  }
  /** @internal */ _releaseManagedRefsOnRow(a: Archetype, c: Component, r: number): void {
    this.componentAccess.releaseManagedRefsOnRow(a, c, r);
  }
  /** @internal */ _relationshipOnInsert(
    h: EntityHandle,
    c: Component,
    v: Record<string, unknown>,
  ): void {
    this.componentAccess.relationshipOnInsert(h, c, v);
  }
  /** @internal */ _relationshipOnRemove(
    h: EntityHandle,
    c: Component,
    v: Record<string, unknown>,
  ): void {
    this.componentAccess.relationshipOnRemove(h, c, v);
  }
  /** @internal */ _expandCoAttach(cds: ComponentData[]): ComponentData[] {
    return this.componentAccess.expandCoAttach(cds);
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
    return spawnCore(this, componentDatas, false);
  }

  /**
   * Core implementation of `spawn` with reentry guard.
   *
   * @param internal — `true` when called from within relationship hook
   *   machinery (lazy mirror create, exclusive reparent). Relationship
   *   handling is suppressed in this path to prevent infinite mirror
   *   recursion; user-declared onInsert callbacks still fire.
   * @internal
   */
  _spawnCore(componentDatas: ComponentData[], internal: boolean): Result<EntityHandle, EcsError> {
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

  /**
   * Core implementation of `despawn` with reentry guard.
   *
   * @param internal — `true` when called from within linkedSpawn cascade.
   *   Nested despawn skips the `relationshipOnRemove` mirror-prune for
   *   `linkedSpawn`-target components (the parent is already retired, so
   *   pruning its Children list would fail); user-declared onRemove
   *   callbacks still fire and the linkedSpawn collection still walks the
   *   subtree so grandchildren cascade correctly (tweak-20260714 M2, R-6).
   * @internal
   */
  _despawnCore(entity: EntityHandle, internal: boolean): Result<void, EcsError> {
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

  // ──────────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  // Scene facade — implementation and per-World scene state live in world-scene.
  // ──────────────────────────────────────────────────────────────────────────

  /** @internal */
  _setSceneAssetResolver(resolver: SceneAssetResolver): void {
    worldSetSceneAssetResolver(this, resolver);
  }
  /** @internal */
  _getSceneAssetResolver(): SceneAssetResolver | null {
    return worldGetSceneAssetResolver(this);
  }
  instantiateScene(
    handle: Handle<'SceneAsset', 'shared'>,
    parent?: EntityHandle,
  ): Result<SceneInstantiateOk, EcsError> {
    return worldInstantiateScene(this, handle, parent);
  }
  instantiateSceneFlat(
    handle: Handle<'SceneAsset', 'shared'>,
  ): Result<SceneInstantiateFlatOk, EcsError> {
    return worldInstantiateSceneFlat(this, handle);
  }
  /** @internal */
  _instantiateSceneRec(
    handle: Handle<'SceneAsset', 'shared'>,
    parent: EntityHandle | undefined,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle, EcsError> {
    return worldInstantiateSceneRec(this, handle, parent, stack, diagnostics);
  }
  /** @internal */
  _resolveSceneAsset(handle: Handle<'SceneAsset', 'shared'>): Result<SceneAsset, EcsError> {
    return worldResolveSceneAsset(this, handle);
  }
  /** @internal */
  _spawnSceneMembers(
    handle: Handle<'SceneAsset', 'shared'>,
    asset: SceneAsset,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<SceneMembersSpawn, EcsError> {
    return worldSpawnSceneMembers(this, handle, asset, stack, diagnostics);
  }
  /** @internal */
  _instantiateSceneAsset(
    handle: Handle<'SceneAsset', 'shared'>,
    asset: SceneAsset,
    parent: EntityHandle | undefined,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle, EcsError> {
    return worldInstantiateSceneAsset(this, handle, asset, parent, stack, diagnostics);
  }
  /** @internal */
  _instantiateSceneAssetFlat(
    handle: Handle<'SceneAsset', 'shared'>,
    asset: SceneAsset,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle[], EcsError> {
    return worldInstantiateSceneAssetFlat(this, handle, asset, stack, diagnostics);
  }
  /** @internal */
  _buildSceneEntityComponentDatas(
    node: SceneEntity,
    mapping: Uint32Array,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<ComponentData[], EcsError> {
    return worldBuildSceneEntityComponentDatas(node, mapping, diagnostics);
  }
  /** @internal */
  _applyMountOverride(member: EntityHandle, ov: MountOverride): Result<void, EcsError> {
    return worldApplyMountOverride(this, member, ov);
  }
  /** @internal */
  _validateMountOverrides(mount: SceneInstanceMount): Result<void, EcsError> {
    return worldValidateMountOverrides(mount);
  }
  /** @internal */
  _spawnMountEntity(
    mount: SceneInstanceMount,
    mapping: Uint32Array,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle, EcsError> {
    return worldSpawnMountEntity(this, mount, mapping, diagnostics);
  }
  /** @internal */
  _resolveMountSource(
    source: number | string,
    parentHandle: Handle<'SceneAsset', 'shared'>,
  ): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
    return worldResolveMountSource(this, source, parentHandle);
  }
  /** @internal */
  _mountOverridesToStateMap(
    src: Map<LocalEntityId, Map<string, MountOverride>>,
  ): Map<LocalEntityId, Map<string, { comp: string; field?: string; value: unknown }>> {
    return worldMountOverridesToStateMap(src);
  }
  /** @internal */
  _setUniqueRefPayload<T>(handle: Handle<string, 'unique'>, payload: T): void {
    worldSetUniqueRefPayload(this, handle, payload);
  }
  /** @internal */
  _resolveSceneInstanceStatePayload(
    root: EntityHandle,
  ): Result<SceneInstanceStatePayload, EcsError> {
    return worldResolveSceneInstanceStatePayload(this, root);
  }
  getSceneInstanceState(root: EntityHandle): Result<SceneInstanceStatePayload, EcsError> {
    return worldGetSceneInstanceState(this, root);
  }
  despawnScene(root: EntityHandle, opts?: { keepDetached?: boolean }): Result<number, EcsError> {
    return worldDespawnScene(this, root, opts);
  }
  despawnDescendants(
    root: EntityHandle,
    opts?: { keepDetached?: boolean },
  ): Result<number, EcsError> {
    return worldDespawnDescendants(this, root, opts);
  }
  setSceneOverride<S extends ComponentSchema>(
    root: EntityHandle,
    member: EntityHandle,
    component: Component<string, S>,
    field: keyof ShapeOf<S> & string,
    value: unknown,
  ): Result<void, EcsError> {
    return worldSetSceneOverride(this, root, member, component, field, value);
  }
  removeSceneOverride<S extends ComponentSchema>(
    root: EntityHandle,
    member: EntityHandle,
    component: Component<string, S>,
    field: keyof ShapeOf<S> & string,
  ): Result<void, EcsError> {
    return worldRemoveSceneOverride(this, root, member, component, field);
  }
  detachSceneMember(root: EntityHandle, member: EntityHandle): Result<void, EcsError> {
    return worldDetachSceneMember(this, root, member);
  }
  reattachSceneMember(root: EntityHandle, member: EntityHandle): Result<void, EcsError> {
    return worldReattachSceneMember(this, root, member);
  }
  getSceneAssetForInstance(root: EntityHandle): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
    return worldGetSceneAssetForInstance(this, root);
  }
}
