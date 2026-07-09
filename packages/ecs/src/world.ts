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
  PackErrorCode,
  PackErrorDetail,
  SceneAsset,
  SceneInstanceMount,
} from '@forgeax/engine-types';
import {
  BUILTIN_BASE,
  err,
  isRetiredSlot,
  ok,
  PACK_ERROR_HINTS,
  pack,
  type Result,
  toShared,
  toUnique,
  unpackSlot,
  unwrapHandle,
} from '@forgeax/engine-types';
import { type Archetype, appendEntity, removeEntity } from './archetype';
import {
  type ArchetypeGraph,
  createArchetypeGraph,
  getAddEdge,
  getOrCreateArchetype,
  getRemoveEdge,
} from './archetype-graph';
import { BufferPool } from './buffer-pool';
import { arrayCountColumnName, type FieldView, normalizeBufferWrite } from './column';
import { createCommandBuffer, flushCommands } from './commands';
import {
  type ArrayMeta,
  bufferFieldByteLength,
  type Component,
  type ComponentSchema,
  fieldTypeToMetaKey,
  type InputShapeOf,
  isEntityField,
  isManagedArrayField,
  isManagedBufferField,
  isManagedField,
  type ManagedArrayElementType,
  type ManagedArrayElementValue,
  parseManagedArraySchema,
  RELATIONSHIP_COMPONENTS,
  resolveComponent,
  type ShapeOf,
  TYPE_METADATA,
} from './component';
import { fillComponentDefaults, validateComponentDataKeys } from './component-default-fallback';
// Value-space id=0 `Entity` component token, aliased to avoid clashing with the
// type-space `Entity` handle imported below from `./entity`.
import { Entity as EntityComponent } from './entity';
import {
  ENTITY_MAX_INDEX,
  ENTITY_NULL_RAW,
  type EntityHandle,
  encodeEntity,
  entityGeneration,
  entityIndex,
} from './entity-handle';
import {
  ArrayPopEmptyError,
  CardinalityExceededError,
  ComponentAlreadyPresentError,
  ComponentNotDefinedError,
  ComponentNotPresentError,
  EntityIndexOverflowError,
  FixedArrayOverflowError,
  FixedSizeMismatchError,
  type ManagedArrayErrorEnvelope,
  type ManagedBufferOutOfBoundsError,
  type ManagedBufferShrinkNotSupportedError,
  RelationshipDetachMismatchError,
  type RelationshipMirrorComponentNotRegisteredError,
  type RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
  RemoveEssentialComponentError,
  type ScheduleMutationError,
  type SpawnLightInvalidBoundsError,
  StaleEntityError,
  type UniqueRefDoubleReleaseError,
  type UniqueRefReleasedError,
} from './errors';
import type { QueryDescriptor } from './query';
import {
  createResourceStore,
  type ResourceStore,
  getResource as resGet,
  hasResource as resHas,
  insertResource as resInsert,
  removeResource as resRemove,
} from './resource';
import {
  createSchedule,
  type ErrorContext,
  type ErrorHandler,
  matchSeverity,
  runSchedule,
  type Schedule,
  Severity,
  type SystemDescriptor,
  addSystem as scheduleAddSystem,
  removeSystem as scheduleRemoveSystem,
  replaceSystem as scheduleReplaceSystem,
} from './schedule';
import { SharedRefStore } from './shared-ref-store';
import { UniqueRefStore } from './unique-ref-store';

/**
 * C-R2 (feat-20260622-s5 / studio-issues): one structured, non-fatal record of
 * a SceneAsset payload field that did NOT match the target component's schema.
 *
 * Scene data is loader-fed and may carry a stale / deprecated / typo'd field
 * (an editor renames a field, an old `.pack.json` lags). `world.instantiateScene`
 * does NOT blank the whole scene over one such field (#478 lesson: a
 * prod-silent strip re-introduced an invisible-entity class) and does NOT abort
 * fatally. Instead it skips the unknown key (no write, no input mutation) and
 * surfaces this record on the success value's `diagnostics[]` — observable in
 * production (NOT NODE_ENV-gated), consumed by property access (no string parse):
 *
 *   const r = world.instantiateScene(handle);
 *   if (r.ok) for (const d of r.value.diagnostics)
 *     console.warn(`unknown field ${d.component}.${d.field} on localId ${d.localId}`);
 *
 * Direct `world.spawn` / `world.addComponent` / `Commands.spawn` stay fail-fast
 * with `SpawnDataUnknownFieldError` — those are explicit API calls where a typo
 * is a programming error, not loader-fed data.
 */
export type SceneInstantiateDiagnostic = {
  /** Component name (schema key) the unknown field appeared under. */
  readonly component: string;
  /** The offending field name not declared in the component schema. */
  readonly field: string;
  /** LocalEntityId (within its owning SceneAsset) of the carrying entity. */
  readonly localId: number;
};

/**
 * Success value of `world.instantiateScene`. `root` is the synthetic scene-root
 * EntityHandle (carries `SceneInstance`); `diagnostics` is the (possibly empty)
 * list of non-fatal unknown-field records aggregated across this scene and every
 * recursively mounted sub-scene (C-R2). Empty array = no diagnostics.
 */
export type SceneInstantiateOk = {
  readonly root: EntityHandle;
  readonly diagnostics: readonly SceneInstantiateDiagnostic[];
};

/**
 * Success value of `world.instantiateSceneFlat` — the "edit the scene itself"
 * primitive. Unlike `instantiateScene`, NO synthetic SceneInstance root is
 * minted and NO `ChildOf` is forced onto top-level members: the scene's own
 * entities become plain top-level world entities whose hierarchy is exactly
 * their authored `ChildOf` (an entity with no `ChildOf` stays a root). `roots`
 * is the set of those top-level handles (own rootless entities + top-level
 * mount carriers). Nested prefabs inside the scene STILL materialise as their
 * own SceneInstance anchors (charter P4: instance == entity-with-SceneInstance)
 * — only THIS scene is flat.
 */
export type SceneInstantiateFlatOk = {
  readonly roots: EntityHandle[];
  readonly diagnostics: readonly SceneInstantiateDiagnostic[];
};

/**
 * @internal Intermediate produced by `_spawnSceneMembers` and consumed by both
 * the anchor finisher (`_instantiateSceneAsset`) and the flat finisher
 * (`_instantiateSceneAssetFlat`). Holds everything the shared member-spawn
 * (mounts recursion + own-entity spawn + deferred owned-parent wiring) computes,
 * before either finisher decides whether to wrap the members in a synthetic
 * SceneInstance root.
 */
export interface SceneMembersSpawn {
  /** LocalEntityId → live Entity u32 (ENTITY_NULL_RAW for unspawned slots). */
  readonly mapping: Uint32Array;
  /** Reverse map live Entity → LocalEntityId for override / detach bookkeeping. */
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  /** Own entities that carried no `ChildOf` — the scene's authored top-level roots. */
  readonly rootEntities: EntityHandle[];
  /** Mount carriers whose `mount.parent === undefined` (default-parented). */
  readonly mountEntitiesNeedingRootParent: EntityHandle[];
  /** `entities.length + mounts + Σ memberCount`, captured at instantiate-time. */
  readonly totalSlots: number;
}

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
  | RemoveEssentialComponentError;

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
   * Minimal per-system summary (M2 — plan-strategy D-3). One entry per
   * registered system, in registration order. The `systemCount` field is
   * preserved as a derived alias of `systems.length` so existing inspector
   * P0 e2e cases that read `systemCount` keep working.
   */
  readonly systems: ReadonlyArray<{ readonly name: string }>;
  /** Keys of all inserted resources. */
  readonly resourceKeys: string[];
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
interface EntityRecord {
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
  /** DAG schedule for system execution. */
  private readonly schedule: Schedule = createSchedule();
  /** Resource store: typed key-value global singletons. */
  private readonly resources: ResourceStore = createResourceStore();
  /** Error handler for Layer 3 (defaults to matchSeverity — Panic throws). */
  private errorHandler: ErrorHandler = matchSeverity;
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
   * world.addSystem({
   *   name: 'read-pos',
   *   queries: [{ with: [Position] }],
   *   fn: (world, queryResults) => { void world; for (const _b of queryResults[0]) { void _b; } },
   * });
   * ```
   */
  addSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    descriptor: SystemDescriptor<Qs>,
  ): void {
    scheduleAddSystem(this.schedule, descriptor);
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
   * const r = world.removeSystem('movement');
   * if (!r.ok) console.error(r.error.code, r.error.detail.candidates);
   * ```
   */
  removeSystem(name: string): Result<void, ScheduleMutationError> {
    return scheduleRemoveSystem(this.schedule, name);
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
   * const r = world.replaceSystem('movement', {
   *   name: 'movement',
   *   queries: [{ with: [Position] }],
   *   fn: (world, queryResults) => { ... },
   * });
   * ```
   */
  replaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    name: string,
    descriptor: SystemDescriptor<Qs>,
  ): Result<void, ScheduleMutationError> {
    return scheduleReplaceSystem(this.schedule, name, descriptor);
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
    this.errorHandler = handler;
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
  update(): void {
    const commands = createCommandBuffer(this);
    runSchedule(this.schedule, this, commands, this.errorHandler);
    flushCommands(commands, this);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Resource CRUD (M3)
  // ──────────────────────────────────────────────────────────────────────────

  /** Insert or overwrite a resource (idempotent, E-13). */
  insertResource<T>(key: string, value: T): void {
    resInsert(this.resources, key, value);
  }

  /**
   * Get a resource by key.
   * @throws ResourceNotFoundError if key not found (E-14).
   */
  getResource<T>(key: string): T {
    return resGet<T>(this.resources, key);
  }

  /** Check if a resource exists. */
  hasResource(key: string): boolean {
    return resHas(this.resources, key);
  }

  /** Remove a resource by key. */
  removeResource(key: string): void {
    resRemove(this.resources, key);
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
    // Build archetype info list, and collect the active component names + the
    // total live-entity count in the same pass. A live entity occupies exactly
    // one archetype row, so summing every archetype's `size` is the live count
    // (feat-20260602 / plan-strategy D-4; the former `records[].alive` scan is
    // gone with the `alive` field). A component is "active" when it appears on
    // at least one archetype that currently holds live entities — so a component
    // defined but never spawned into this World is absent (data source:
    // graph.archetypes, not the registry). Names are deduped via a Set and emitted in
    // first-seen order.
    let entityCount = 0;
    const archetypeInfos: ArchetypeInfo[] = [];
    const activeComponentSet = new Set<string>();
    for (const arch of this.graph.archetypes) {
      if (!arch) continue;
      entityCount += arch.size;
      const componentNames = arch.components.map((c) => c.name);
      archetypeInfos.push({
        key: arch.key,
        componentNames,
        entityCount: arch.size,
        capacity: arch.capacity,
      });
      if (arch.size > 0) {
        for (const name of componentNames) activeComponentSet.add(name);
      }
    }
    const activeComponents = [...activeComponentSet];

    // System count + per-system summary (M2 — plan-strategy D-3).
    // systemCount is a derived alias of systems.length so existing inspector
    // P0 e2e cases that read systemCount keep working.
    const systems: { readonly name: string }[] = [];
    for (const name of this.schedule.systems.keys()) {
      systems.push({ name });
    }
    const systemCount = systems.length;

    // Resource keys.
    const resourceKeys: string[] = [];
    for (const key of this.resources.data.keys()) {
      resourceKeys.push(key);
    }

    return {
      entityCount,
      archetypeCount: archetypeInfos.length,
      archetypes: archetypeInfos,
      activeComponents,
      systemCount,
      systems,
      resourceKeys,
    };
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
    return this.uniqueRefs.alloc(target, payload, onRelease);
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
    return this.sharedRefs.alloc(target, payload, onLastRelease);
  }

  /**
   * Check cardinality bound for a component before archetype mutation
   * (plan-strategy D-3). Returns `CardinalityExceededError` if adding one
   * more instance would exceed the declared `cardinality` of the component.
   * Components without a cardinality bound (undefined) pass instantly.
   */
  private checkCardinality(
    component: Component,
    extraCount: number,
  ): CardinalityExceededError | null {
    const max = component.cardinality;
    if (max === undefined || max <= 0) return null;

    const localId = component.id;
    // Count existing entities carrying this component across all archetypes.
    let existingCount = 0;
    for (const arch of this.graph.archetypes) {
      if (arch.columns.has(localId)) {
        existingCount += arch.size;
      }
    }

    if (existingCount + extraCount > max) {
      return new CardinalityExceededError(component.name, existingCount, max);
    }
    return null;
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
    return this._spawnCore(componentDatas, false);
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
    // Layer-2 + layer-3 silent fallback (fillComponentDefaults) is shared
    // with addComponent / SceneAsset.instantiate. Spawn-time payload
    // validation (feat-20260519 / D-S3 a) runs here -- after defaults fill,
    // before any archetype mutation -- so a validator failure aborts the
    // spawn cleanly without partial state. Components without a validator
    // skip the call entirely.
    //
    // bug-20260615: validateComponentDataKeys runs FIRST, before
    // fillComponentDefaults, so a typo / unknown-key in the caller's raw
    // payload surfaces a SpawnDataUnknownFieldError instead of being silently
    // dropped (the fill helper iterates schema keys and never sees raw keys).
    const filledData: Record<string, unknown>[] = [];
    for (const cd of componentDatas) {
      const keyErr = validateComponentDataKeys(cd.component, cd.data as Record<string, unknown>);
      if (keyErr !== null) {
        return err(keyErr as unknown as EcsError);
      }
      const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
      filledData.push(filled as Record<string, unknown>);
      if (cd.component.validate !== undefined) {
        const validationError = cd.component.validate(filled as Record<string, unknown>);
        if (validationError !== null && validationError !== undefined) {
          return err(validationError as EcsError);
        }
      }
    }

    // Cardinality enforcement (plan-strategy D-3). Check before any
    // archetype mutation so a violation aborts cleanly without partial
    // state. Each component in the spawn bundle increments the count by 1.
    for (const cd of componentDatas) {
      const cardinalityErr = this.checkCardinality(cd.component as Component, 1);
      if (cardinalityErr !== null) {
        return err(cardinalityErr as unknown as EcsError);
      }
    }

    // Allocate entity index slot.
    const indexSlot = this.allocateIndex();
    // biome-ignore lint/style/noNonNullAssertion: allocateIndex guarantees a valid slot with an initialized record
    const record = this.records[indexSlot]!;

    // Find or create target archetype for the full component set using World-local IDs.
    const componentIds = componentDatas.map((cd) => cd.component.id);
    const components = componentDatas.map((cd) => cd.component);
    const arch = getOrCreateArchetype(this.graph, componentIds, components);

    // Append entity row.
    const row = appendEntity(arch, indexSlot);

    for (let i = 0; i < componentDatas.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: filledData populated 1:1 above
      const filled = filledData[i]!;
      // biome-ignore lint/style/noNonNullAssertion: componentDatas index is in-range
      const cd = componentDatas[i]!;
      this.writeRow(arch, cd.component, row, filled as ShapeOf<ComponentSchema>);
    }

    record.archetypeId = arch.id;
    record.row = row;

    const spawnedEntity = encodeEntity(indexSlot, record.generation);

    // Essential id=0 `Entity` column write (feat-20260602 / plan-strategy D-3):
    // store the full packed handle into the row's own `self` slot so it is read
    // back through the uniform query / readRow path (`world.get(e, Entity).self
    // === e`). The user's spawn bundle never carries Entity, so this is written
    // here directly; archetype migration (addComponent / removeComponent) copies
    // the column with the rest of the row, so the handle survives moves.
    this.writeEntitySelf(arch, row, spawnedEntity);

    // M1 hook framework: fire onInsert for each component after all rows
    // are written and the entity is alive (entity handle must be valid).
    for (let i = 0; i < componentDatas.length; i++) {
      const cd = componentDatas[i];
      const filled = filledData[i];
      if (!cd || filled === undefined) continue;
      const onInsert = (cd.component as Component).onInsert;
      if (onInsert) {
        onInsert(spawnedEntity, filled);
      }
      // M2 relationship sync: append to the mirror list on the target.
      if (!internal && (cd.component as Component).relationship) {
        this.relationshipOnInsert(
          spawnedEntity,
          cd.component as Component,
          filled as Record<string, unknown>,
        );
      }
    }

    return ok(spawnedEntity);
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
    return this._despawnCore(entity, false);
  }

  /**
   * Core implementation of `despawn` with reentry guard.
   *
   * @param internal — `true` when called from within linkedSpawn cascade.
   *   nested despawn skips relationship-linkedSpawn collection to prevent
   *   unbounded recursion; user-declared onRemove callbacks still fire.
   * @internal
   */
  _despawnCore(entity: EntityHandle, internal: boolean): Result<void, EcsError> {
    const slot = entityIndex(entity);
    const gen = entityGeneration(entity);
    const record = this.records[slot];
    if (!this.recordIsLive(record, gen)) {
      return ok(undefined); // stale, already dead, or not materialized — idempotent
    }

    // M1 release loop: release every `ref<T>` field on every component the
    // entity carries. Failures route to Layer 3 ErrorHandler and never
    // abort the despawn chain (charter: explicit-failure boundary).
    const arch = this.graph.archetypes[record.archetypeId];
    // M2 linkedSpawn (D-1 skeleton): if this entity is the target of a
    // linkedSpawn relationship, collect the holders to cascade-despawn AFTER
    // this entity is fully retired. Read the mirror list now while the row is
    // still live. Default ChildOf ships linkedSpawn=false, so this is empty
    // for the standard hierarchy.
    const linkedChildren: EntityHandle[] =
      arch && !internal ? this.relationshipLinkedSpawnChildren(entity, arch) : [];
    if (arch) {
      for (const comp of arch.components) {
        // M1 hook framework: fire onRemove before column release (D-6, AC-04).
        // The old value snapshot is captured so callbacks can inspect the
        // removed component's data before archetype migration. M2 reuses the
        // snapshot to prune the relationship target's mirror list (AC-09).
        const onRemove = comp.onRemove;
        const rel = comp.relationship;
        const needsOldValue = onRemove !== undefined || (rel !== undefined && !internal);
        if (needsOldValue) {
          const oldValue = this.readRow(arch, comp, record.row) as Record<string, unknown>;
          if (onRemove) {
            onRemove(entity, oldValue);
          }
          if (rel !== undefined && !internal) {
            this.relationshipOnRemove(entity, comp, oldValue);
          }
        }
        this.releaseManagedRefsOnRow(arch, comp, record.row);
      }
      const swapResult = removeEntity(arch, record.row);
      if (swapResult) {
        // Update the swapped entity's record to point to the new row.
        const swappedRecord = this.records[swapResult.movedEntity];
        if (swappedRecord) {
          swappedRecord.row = swapResult.newRow;
        }
      }
    }

    record.archetypeId = -1;
    record.row = -1;

    // Liveness absorbed into generation (feat-20260602 / plan-strategy D-4):
    // bump generation UNCONDITIONALLY so any outstanding handle for this slot
    // (gen) stops matching -- this is what marks the entity dead now that the
    // `alive` boolean is gone. Recycle the slot only while the post-bump
    // generation still fits the 8-bit field (<= 255); once a despawn pushes
    // generation past 255 (e.g. 255 -> 256) the slot is permanently retired
    // (never re-pushed to freeIndices) to prevent handle aliasing (D-08). A
    // retired slot keeps gen > 255 forever, so its records[] entry is dead but
    // intact.
    record.generation += 1;
    if (!isRetiredSlot(record.generation)) {
      this.freeIndices.push(slot);
    }
    // else: index permanently retired (D-08).

    // M2 linkedSpawn cascade (D-1): recursively despawn the collected holders
    // now that this target is fully retired. Each child despawn fires its own
    // onRemove arm, which tries to prune this (already-dead) target's mirror
    // list -- relationshipOnRemove no-ops on a dead target, so there is no
    // dangling write. Stale handles are idempotent, so a child already gone
    // (e.g. listed twice) is harmless.
    for (const child of linkedChildren) {
      this._despawnCore(child, true);
    }
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Relationship bidirectional sync (feat-20260531 M2 / plan-strategy D-1/3/7)
  //
  // A relationship component (e.g. ChildOf) carries a single `entity`-typed
  // field pointing at its target (the parent). The engine mirrors the reverse
  // reference into the named mirror component's `array<entity>` field (e.g.
  // Children.entities) at the three hook sites. These helpers are invoked from
  // spawn / addComponent (onInsert arm) + removeComponent / despawn (onRemove
  // arm), gated by `component.relationship !== undefined` and the
  // `internal` boolean parameter on _xxxCore methods (reentry guard).
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Locate the single `entity`-typed field on a relationship component's
   * schema (the holder -> target pointer, e.g. `ChildOf.parent`) and return the
   * target Entity carried by `value`, or `null` when the field is unset.
   */
  private relationshipTargetEntity(
    component: Component,
    value: Record<string, unknown>,
  ): EntityHandle | null {
    for (const [fieldName, fieldType] of Object.entries(component.schema)) {
      if (isEntityField(fieldType)) {
        const raw = value[fieldName];
        if (raw === null || raw === undefined) return null;
        const asNum = raw as number;
        if (asNum === ENTITY_NULL_RAW) return null;
        return asNum as EntityHandle;
      }
    }
    return null;
  }

  /**
   * onInsert arm: append `holder` to the mirror list on the relationship
   * target. Lazily creates the mirror component on the target when absent
   * (D-3c). When the relationship is `exclusive` and `holder` already carried
   * the component pointing at a different target, the caller (addComponent)
   * has already pruned the old side; here we only append the new side.
   * All mirror mutations run under the reentry guard.
   */
  private relationshipOnInsert(
    holder: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
  ): void {
    const rel = component.relationship;
    if (rel === undefined) return;
    const target = this.relationshipTargetEntity(component, value);
    if (target === null) return;
    const mirror = resolveComponent(rel.mirror);
    /* istanbul ignore next -- defineComponent relationship validation guarantees mirror exists */
    if (mirror === undefined) return;

    // Lazy-create the mirror component on the target when absent (D-3c).
    const targetSlot = entityIndex(target);
    const targetRec = this.records[targetSlot];
    if (!this.recordIsLive(targetRec, entityGeneration(target))) return;
    const targetArch = this.graph.archetypes[targetRec.archetypeId];
    const mirrorLocalId = mirror.id;
    const hasMirror = targetArch?.columns.has(mirrorLocalId) ?? false;
    if (!hasMirror) {
      this._addComponentCore(
        target,
        {
          component: mirror,
          data: {} as Partial<ShapeOf<ComponentSchema>>,
        },
        true,
      );
    }
    this.push(
      target,
      mirror as Component<string, ComponentSchema>,
      rel.field as never,
      holder as never,
    );
  }

  /**
   * onRemove arm: prune `holder` from the relationship target's mirror list
   * (AC-08 removeComponent / AC-09 despawn). Reads the old value snapshot to
   * locate the target. No-op when the target is already gone. All mirror
   * mutations run under the reentry guard.
   */
  private relationshipOnRemove(
    holder: EntityHandle,
    component: Component,
    oldValue: Record<string, unknown>,
  ): void {
    const rel = component.relationship;
    if (rel === undefined) return;
    const target = this.relationshipTargetEntity(component, oldValue);
    if (target === null) return;
    const mirror = resolveComponent(rel.mirror);
    /* istanbul ignore next -- defineComponent relationship validation guarantees mirror exists */
    if (mirror === undefined) return;
    const targetSlot = entityIndex(target);
    const targetRec = this.records[targetSlot];
    if (!this.recordIsLive(targetRec, entityGeneration(target))) return;

    this._removeArrayElementByValue(
      target,
      mirror as Component<string, ComponentSchema>,
      rel.field as never,
      holder as never,
    );
  }

  /**
   * linkedSpawn arm (D-1 skeleton): when `entity` (about to be despawned)
   * carries a component that is the mirror of some `linkedSpawn: true`
   * relationship, collect the holders listed in that mirror field and return
   * them for recursive despawn. Read before the entity's row is removed so the
   * mirror list is still live. ChildOf ships `linkedSpawn: false` by default,
   * so this returns an empty list for the standard hierarchy; the branch
   * exists so the default can be flipped (judgment gate) without a rewrite.
   */
  private relationshipLinkedSpawnChildren(entity: EntityHandle, arch: Archetype): EntityHandle[] {
    const row = this.records[entityIndex(entity)]?.row ?? -1;
    const collected: EntityHandle[] = [];
    for (const comp of arch.components) {
      const mirrorField = this.linkedSpawnMirrorField(comp.name);
      if (mirrorField === undefined) continue;
      const snapshot = this.readRow(arch, comp, row) as Record<string, unknown>;
      const list = snapshot[mirrorField];
      if (!(list instanceof Uint32Array)) continue;
      for (const raw of list) {
        if (raw !== ENTITY_NULL_RAW) collected.push(raw as EntityHandle);
      }
    }
    return collected;
  }

  /**
   * If some registered relationship has `linkedSpawn: true` and names
   * `mirrorName` as its mirror, return that relationship's mirror field name
   * (the `array<entity>` holding the holders); otherwise `undefined`. Used by
   * the despawn cascade to discover, from the target side, which field lists
   * the holders to recursively despawn.
   */
  private linkedSpawnMirrorField(mirrorName: string): string | undefined {
    for (const holderComp of RELATIONSHIP_COMPONENTS) {
      const rel = holderComp.relationship;
      if (rel?.linkedSpawn === true && rel.mirror === mirrorName) return rel.field;
    }
    return undefined;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Get / Set
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Read component data from an entity.
   *
   * **Transient view contract (feat-20260602):** for fixed-capacity
   * `array<T,N>` and `buffer<N>` fields, the returned `TypedArray` (and any
   * subarray of it) aliases the archetype column buffer directly. The view is
   * valid only until the next structural change (`spawn` / `despawn` /
   * `addComponent` / `removeComponent`). Holding a view across a structural
   * change is undefined behaviour -- the backing `ArrayBuffer` is detached on
   * column growth, and swap-remove at the same row index points to the wrong
   * entity. **Re-fetch `world.get(e, C)` on every access.** See
   * `packages/ecs/README.md` Transient view contract section.
   *
   * @returns `Result<ShapeOf<S>, EcsError>` —
   *   `ok(ShapeOf<S>)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentNotPresentError)` (`.code = 'component-not-present'`) if
   *   the entity does not have the component (a never-present component on
   *   this entity degrades to the same `component-not-present` path — there is
   *   no separate "not registered" failure; components are global at
   *   `defineComponent` time).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
   * const r = world.get(e, Position);
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * const pos = r.value;
   * ```
   */
  get<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<ShapeOf<S>, EcsError> {
    const record = this.lookupAlive(entity, 'get', component.name);
    if (!record.ok) return record;

    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'get',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }

    // Check if this archetype has the component (using World-local ID).
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    if (!fieldCols) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    return ok(this.readRow(arch, component, rec.row));
  }

  /**
   * Column-level zero-copy view of an `array<T, N>` / `array<T>` field.
   *
   * Resolves the live byte region for `(entity, component, fieldName)`
   * directly at the column level and returns the element-typed TypedArray
   * aliasing it (`view.buffer` is the SSOT byte region; mutations route
   * through `world.set` / `world.push`). Unlike `get`, this does NOT build the
   * `{}` whole-component object nor walk every schema field. Per-frame
   * consumers that need one column (the resolved world mat4) take this path to
   * avoid the `get` overhead (1 `{}` alloc + N-field readRow walk).
   *
   * Fixed `array<T,N>` columns (feat-20260602) store their elements inline, so
   * the view aliases the archetype column buffer directly (no BufferPool
   * indirection); variable `array<T>` columns still alias the BufferPool slot.
   * The returned view's element type follows the schema element type
   * (`array<entity,N>` -> `Uint32Array`, `array<f32,N>` -> `Float32Array`,
   * etc.) -- the prior f32-only early-return gate is removed.
   *
   * **Transient view contract:** the returned `TypedArray` aliases the column
   * buffer and is valid only until the next structural change (`spawn` /
   * `despawn` / `addComponent` / `removeComponent`). Column growth
   * (`growColumn`) detaches the old `ArrayBuffer` via `transfer()`; a
   * swap-remove at the same row index leaves the view pointing to the wrong
   * entity. **Callers must re-fetch `_getArrayView` on every access** and must
   * not hold the view across any operation that may cause archetype migration.
   * All existing per-frame consumers (`propagateTransforms` / `render-extract`
   * / `pick`) already conform -- they fetch the view inside a single pass with
   * no intervening structural changes.
   *
   * Returns `undefined` when the entity is dead, the component is absent, the
   * field does not exist, or the field is not an `array<...>` column.
   *
   * @internal Engine-internal fast path; AI users read the typed view through
   *   `world.get(e, Transform).world`. The accessor is the zero-materialization
   *   route the propagate kernel and render walk use.
   */
  _getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): FieldView | undefined {
    const record = this.lookupAlive(entity, '_getArrayView', component.name);
    if (!record.ok) return undefined;

    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    if (!arch) return undefined;

    const fieldCols = arch.columns.get(component.id);
    if (!fieldCols) return undefined;

    const fieldType = component.schema[fieldName];
    if (fieldType === undefined) return undefined;
    const arrayMeta = parseManagedArraySchema(fieldType);
    if (arrayMeta === null) return undefined;

    const col = fieldCols.get(fieldName);
    if (!col) return undefined;

    if (arrayMeta.length !== undefined) {
      // Fixed inline column: reinterpret the row's stride-N byte window.
      const elementBytes = elementByteSize(arrayMeta.elementType);
      const arity = col.arity;
      const rowByteOffset = col.view.byteOffset + rec.row * arity * elementBytes;
      const rowBytes = new Uint8Array(col.view.buffer, rowByteOffset, arity * elementBytes);
      return reinterpretSlotBytes(rowBytes, arrayMeta.elementType, arrayMeta.length);
    }

    // Variable column: alias the live BufferPool slot bytes; element count
    // comes from the sidecar `:count` column.
    const slotId = col.view[rec.row] as number;
    const liveBytes = this.bufferPool.view(slotId);
    const countCol = fieldCols.get(arrayCountColumnName(fieldName));
    const elementCount = (countCol?.view[rec.row] as number | undefined) ?? 0;
    return reinterpretSlotBytes(liveBytes, arrayMeta.elementType, elementCount);
  }

  /**
   * Write (partial) component data to an entity.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentNotPresentError)` (`.code = 'component-not-present'`) if
   *   entity does not have the component (F-02: no longer silently ignores).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.set(e, Position, { x: 10 });
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * r.unwrap();
   * ```
   */
  set<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    value: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'set', component.name);
    if (!record.ok) return record;

    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'set',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    if (!fieldCols) {
      // F-02: set on missing component returns err instead of silent ignore
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    for (const fieldName of Object.keys(value)) {
      const col = fieldCols.get(fieldName);
      if (!col) {
        continue;
      }
      const fieldType = (component.schema as Record<string, string>)[fieldName] ?? '';
      // M1/M2 release loop (set path): release the prior managed value
      // BEFORE writing the new one. Single SSOT helper `releaseManagedFieldOnRow`
      // (feat-20260614 D-2) covers every managed-field family (`ref<T>` /
      // `string` / `buffer` / variable `array<T>`); it self-skips fields that
      // do not match `isManagedField` here, but for set-ref/string we already
      // gated on it so the call is hot. Zeroes the column when applicable.
      if (isManagedField(fieldType)) {
        this.releaseManagedFieldOnRow(arch, component, rec.row, fieldName);
      }
      const raw = (value as Record<string, unknown>)[fieldName];
      if (fieldType === 'bool') {
        col.view[rec.row] = raw ? 1 : 0;
      } else if (isEntityField(fieldType)) {
        // M3 entity field overwrite: encode null as ENTITY_NULL_RAW;
        // otherwise store the Entity bit pattern (slot+gen).
        col.view[rec.row] = raw === null || raw === undefined ? ENTITY_NULL_RAW : (raw as number);
      } else if (isManagedBufferField(fieldType)) {
        // M2 set path: collapsed-vocab keyword family `'buffer'` (variable) +
        // `'buffer<N>'` (fixed). The two shapes diverge here:
        //   - `buffer<N>` — schema-declared byteLength is fixed; raw must be a
        //     `Uint8Array` whose `byteLength === N`. Mismatched payloads route
        //     `FixedSizeMismatchError` via Result.err so AI users observe an
        //     explicit failure instead of silent truncation (verify round 1
        //     B1 fix; charter P3 — explicit failure > silent acceptance).
        //   - `'buffer'`  — variable capacity; release the prior slot then
        //     alloc a fresh one sized to the new payload's byteLength (mirrors
        //     the `array<T>` set path's release-then-alloc D-5 ordering).
        //   raw is normalized from any AllowSharedBufferSource view to a
        //   Uint8Array over its bytes (feat-20260621 V2 / AC-A4). Non-buffer
        //   raw (a forced cast feeding e.g. a number) normalizes to null and
        //   is treated as a no-op (column slot stays unchanged).
        const isFixedBuffer = fieldType !== 'buffer';
        const bytes = normalizeBufferWrite(raw);
        if (bytes !== null) {
          if (isFixedBuffer) {
            // feat-20260602: fixed `buffer<N>` lives inline as a stride-N u8
            // column (arity = N bytes). Write the payload straight into the
            // row window -- no BufferPool slot.
            const expected = bufferFieldByteLength(fieldType);
            if (bytes.byteLength !== expected) {
              return err(new FixedSizeMismatchError(fieldName, expected, bytes.byteLength));
            }
            const arity = col.arity;
            (col.view as Uint8Array).set(bytes.subarray(0, arity), rec.row * arity);
          } else {
            // Variable `'buffer'` set: release prior slot via SSOT helper
            // (feat-20260614 D-2) then alloc fresh sized to the new payload
            // (verify round 1 B2 fix path). The helper zeroes the column on
            // release; sentinel slot id 0 is a no-op.
            this.releaseManagedFieldOnRow(arch, component, rec.row, fieldName);
            const allocR = this.bufferPool.alloc(bytes.byteLength);
            if (!allocR.ok) {
              const ctx: ErrorContext = {
                severity: Severity.Error,
                systemName: `World.set (${component.name}.${fieldName})`,
              };
              this.errorHandler(allocR.error, ctx);
              col.view[rec.row] = 0;
              continue;
            }
            const slot = allocR.value;
            slot.view.set(bytes);
            col.view[rec.row] = slot.id;
          }
        }
      } else if (fieldType === 'string') {
        // M1 string-field set path (AC-05 path 3): the prior handle was
        // already released by the unified `isManagedField` pre-write block
        // above (D-R3) -- here we just alloc the new handle and store the
        // u32. Mirrors the array<T> release-then-alloc pattern (D-5) so AI
        // users observe the UniqueRefStore _liveCount net-zero invariant
        // on field overwrite. Missing / non-string raw -> '' fallback
        // (AC-06).
        const text = typeof raw === 'string' ? raw : '';
        const handle = this.uniqueRefs.alloc<'String'>('String', text);
        col.view[rec.row] = unwrapHandle(handle);
      } else {
        const arrayMeta = component.fields[fieldName]?.arrayMeta;
        if (arrayMeta !== undefined) {
          // M1 set path for array<T> / array<T,N> fields (feat-20260614 D-3
          // calling convention). The set semantics mirror spawn: release the
          // prior slot via the SSOT helper, then alloc a fresh one sized to
          // the new value, copy bytes verbatim, store slot id (+ count for
          // variable). Fixed `array<T,N>` is inline — the helper short-
          // circuits and writeArrayField writes directly into the row's
          // stride window with no pool traffic.
          this.releaseManagedFieldOnRow(arch, component, rec.row, fieldName);
          this.writeArrayField(arch, component, rec.row, fieldName, fieldType, arrayMeta, raw);
        } else {
          // The pre-write `releaseManagedFieldOnRow` block above already
          // released the prior `'shared<T>'` rc via SharedRefStore.release;
          // here we retain the new value so net rc delta is +1 / 0 / -1 per
          // M4 invariant (set: -1+1=0; spawn: 0+1=+1; despawn: -1).
          col.view[rec.row] = raw as number;
          if (fieldType.startsWith('shared<') && (raw as number) !== 0) {
            this.retainSharedScalarHandle(raw as number, component.name, fieldName);
          }
        }
      }
    }
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // push / pop / capacity (array<T> / array<T,N> element-granular ops, w8)
  //
  // The three commands form the array-only mutation surface introduced by
  // feat-20260515-buffer-array-vocab-collapse plan-strategy §2.1 + §2.3:
  //   - `push`     append one element to a variable `array<T>`; on a fixed
  //                `array<T, N>` returns `fixed-array-overflow` when
  //                count == N (capacity == N == N).
  //   - `pop`      remove and return the last element from a variable
  //                `array<T>`; returns `array-pop-empty` when count == 0.
  //                Calling on a fixed `array<T, N>` is a TS compile-time
  //                error (the `fieldName: ArrayFieldsOf<S>` filter still
  //                accepts it but the contract treats fixed arrays as
  //                non-shrinkable; pop on fixed routes pop-empty when the
  //                fixed length itself is 0).
  //   - `capacity` query the live byte capacity expressed in elements.
  //                Variable -> `pool.view(slotId).byteLength / elementBytes`;
  //                fixed -> the schema-declared `N` literal.
  //
  // The `fieldName` parameter is typed `ArrayFieldsOf<S>` so cross-shape
  // access (entity / buffer / string / scalar field names) is rejected at
  // compile time -- AI users see a TS error well before any runtime path.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Append `value` to the variable `array<T>` field `fieldName` on `entity`.
   *
   * BufferPool grow is amortized O(1) via the size-class freelist (research
   * Finding 5). Variable arrays grow byte-wise; fixed arrays return
   * `fixed-array-overflow` when count has reached the schema-declared `N`.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) for dead handles;
   *   `err(ComponentNotPresentError)` (`.code = 'component-not-present'`)
   *   when the entity does not carry `component`;
   *   `err(FixedArrayOverflowError)` (`.code = 'fixed-array-overflow'`) for
   *   `array<T, N>` push at count == N.
   *
   * @example
   * ```ts
   * const Children = defineComponent('Children', { entities: 'array<entity>' });
   * world.push(parent, Children, 'entities', child).unwrap();
   * ```
   */
  push<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
    value: ArrayFieldElementValue<S, K>,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'push', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- alive record always has a valid archetype */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'push',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    if (!fieldCols) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const fieldNameStr = fieldName as string;
    const col = fieldCols.get(fieldNameStr);
    /* istanbul ignore next -- ArrayFieldsOf filter ensures the column exists */
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = component.fields[fieldNameStr]?.arrayMeta;
    /* istanbul ignore next -- ArrayFieldsOf filter guarantees array<*> */
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const meta = TYPE_METADATA[arrayMeta.elementType];
    /* istanbul ignore next -- arrayMeta.elementType is guaranteed in TYPE_METADATA */
    if (!meta) return err(new ComponentNotPresentError(entity as number, component.name));
    // biome-ignore lint/style/noNonNullAssertion: ManagedArrayElementType always scalar -> byteSize present
    const elementBytes = meta.byteSize!;

    const isVariable = arrayMeta.length === undefined;
    const slotId = col.view[rec.row] as number;

    if (!isVariable) {
      // Fixed-capacity array: count is anchored at the schema-declared N
      // (no sidecar count column). Any push overflows by construction --
      // fixed arrays are written whole-row via `world.set` / spawn, not
      // grown element-wise.
      const capacity = arrayMeta.length ?? 0;
      return err(
        new FixedArrayOverflowError(fieldNameStr, capacity, capacity, arrayMeta.elementType),
      );
    }

    const countCol = fieldCols.get(arrayCountColumnName(fieldNameStr));
    /* istanbul ignore next -- variable arrays always allocate the count column */
    if (countCol === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const count = countCol.view[rec.row] as number;
    const newCount = count + 1;
    const newByteLength = newCount * elementBytes;

    let liveSlotId = slotId;
    if (liveSlotId === 0) {
      // Empty/unallocated slot — alloc fresh.
      const allocR = this.bufferPool.alloc(newByteLength);
      if (!allocR.ok) return err(allocR.error);
      liveSlotId = allocR.value.id;
      col.view[rec.row] = liveSlotId;
    } else {
      const growR = this.bufferPool.grow(liveSlotId, newByteLength);
      if (!growR.ok) return err(growR.error);
    }
    const liveBytes = this.bufferPool.view(liveSlotId);
    // Reinterpret the slot bytes as the element-typed view and write at the
    // tail index. Entity values are stored as their u32 bit pattern.
    writeArrayElementAt(liveBytes, count, arrayMeta.elementType, value as number);
    countCol.view[rec.row] = newCount;
    return ok(undefined);
  }

  /**
   * Remove and return the last element of the variable `array<T>` field
   * `fieldName` on `entity`. Empty arrays return `array-pop-empty`. Fixed
   * `array<T, N>` is non-shrinkable; calling pop on a fixed field returns
   * `array-pop-empty` regardless of state (the contract is "fixed arrays
   * never shrink"; AI users use `array<T>` if element-wise removal is
   * needed).
   *
   * @returns `Result<ArrayFieldElementValue<S, K>, EcsError>` —
   *   `ok(value)` on success;
   *   `err(StaleEntityError)` for dead handles;
   *   `err(ComponentNotPresentError)` when entity lacks the component;
   *   `err(ArrayPopEmptyError)` (`.code = 'array-pop-empty'`) for empty.
   */
  pop<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
  ): Result<ArrayFieldElementValue<S, K>, EcsError> {
    const record = this.lookupAlive(entity, 'pop', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- alive record always has a valid archetype */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'pop',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    if (!fieldCols) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const fieldNameStr = fieldName as string;
    const col = fieldCols.get(fieldNameStr);
    /* istanbul ignore next -- ArrayFieldsOf filter ensures the column exists */
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = component.fields[fieldNameStr]?.arrayMeta;
    /* istanbul ignore next -- ArrayFieldsOf filter guarantees array<*> */
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const isVariable = arrayMeta.length === undefined;
    if (!isVariable) {
      // Fixed-capacity arrays do not shrink (plan-strategy §2.1 contract).
      return err(new ArrayPopEmptyError(fieldNameStr));
    }
    const countCol = fieldCols.get(arrayCountColumnName(fieldNameStr));
    /* istanbul ignore next -- variable arrays always allocate the count column */
    if (countCol === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const count = countCol.view[rec.row] as number;
    if (count === 0) return err(new ArrayPopEmptyError(fieldNameStr));
    const slotId = col.view[rec.row] as number;
    const liveBytes = this.bufferPool.view(slotId);
    const value = readArrayElementAt(liveBytes, count - 1, arrayMeta.elementType);
    countCol.view[rec.row] = count - 1;
    return ok(value as ArrayFieldElementValue<S, K>);
  }

  /**
   * Query the live element capacity of an `array<T>` / `array<T, N>` field.
   *
   * - `array<T>`: live capacity = `pool.view(slotId).byteLength / elementBytes`
   *   (BufferPool size-class bucket capacity, may exceed the live count).
   * - `array<T, N>`: schema-declared `N` literal (constant for the lifetime
   *   of the entity).
   *
   * @returns `Result<number, EcsError>` —
   *   `ok(capacity)` on success; element-bytes carved out of the byte
   *   capacity, never short-changed by the live count.
   */
  capacity<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
  ): Result<number, EcsError> {
    const record = this.lookupAlive(entity, 'capacity', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- alive record always has a valid archetype */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'capacity',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    if (!fieldCols) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const fieldNameStr = fieldName as string;
    const col = fieldCols.get(fieldNameStr);
    /* istanbul ignore next -- ArrayFieldsOf filter ensures the column exists */
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = component.fields[fieldNameStr]?.arrayMeta;
    /* istanbul ignore next -- ArrayFieldsOf filter guarantees array<*> */
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    if (arrayMeta.length !== undefined) return ok(arrayMeta.length);
    const meta = TYPE_METADATA[arrayMeta.elementType];
    /* istanbul ignore next -- arrayMeta.elementType is guaranteed in TYPE_METADATA */
    if (!meta) return ok(0);
    // biome-ignore lint/style/noNonNullAssertion: ManagedArrayElementType always scalar -> byteSize present
    const elementBytes = meta.byteSize!;

    const slotId = col.view[rec.row] as number;
    if (slotId === 0) return ok(0);
    const liveBytes = this.bufferPool.view(slotId);
    return ok(Math.floor(liveBytes.byteLength / elementBytes));
  }

  /**
   * Remove the first element equal to `value` from the variable `array<T>`
   * field `fieldName` on `entity`, by swap-remove (move the tail element into
   * the vacated slot, then decrement the count). Idempotent: a value that is
   * absent (or an empty / unallocated list) leaves the array untouched and
   * returns `ok`. Order is NOT preserved (swap-remove) — relationship mirror
   * lists are unordered sets, so this is the cheapest correct primitive.
   *
   * This is the mid-array counterpart to `pop` (tail-only): the relationship
   * bidirectional sync (AC-08 / AC-09) needs to prune an arbitrary child from
   * a parent's mirror list, which `pop` cannot express.
   *
   * @internal Engine-internal storage primitive (feat-20260531 M2 /
   *   plan-strategy D-3b). Not part of the public README surface; the relation-
   *   ship hook is its only intended caller. Fixed `array<T, N>` fields do not
   *   shrink, so this is a no-op (returns `ok`) on them.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success or no-op (value absent / fixed array);
   *   `err(StaleEntityError)` for dead handles;
   *   `err(ComponentNotPresentError)` when entity lacks the component.
   */
  _removeArrayElementByValue<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
    value: ArrayFieldElementValue<S, K>,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, '_removeArrayElementByValue', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- alive record always has a valid archetype */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'removeArrayElementByValue',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    if (!fieldCols) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const fieldNameStr = fieldName as string;
    const col = fieldCols.get(fieldNameStr);
    /* istanbul ignore next -- ArrayFieldsOf filter ensures the column exists */
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = component.fields[fieldNameStr]?.arrayMeta;
    /* istanbul ignore next -- ArrayFieldsOf filter guarantees array<*> */
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    // Fixed-capacity arrays do not shrink (same contract as `pop`); no-op.
    if (arrayMeta.length !== undefined) return ok(undefined);
    const countCol = fieldCols.get(arrayCountColumnName(fieldNameStr));
    /* istanbul ignore next -- variable arrays always allocate the count column */
    if (countCol === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const count = countCol.view[rec.row] as number;
    if (count === 0) return ok(undefined);
    const slotId = col.view[rec.row] as number;
    if (slotId === 0) return ok(undefined);
    const liveBytes = this.bufferPool.view(slotId);
    const target = value as number;
    for (let i = 0; i < count; i++) {
      if (readArrayElementAt(liveBytes, i, arrayMeta.elementType) === target) {
        const last = count - 1;
        if (i !== last) {
          const tail = readArrayElementAt(liveBytes, last, arrayMeta.elementType);
          writeArrayElementAt(liveBytes, i, arrayMeta.elementType, tail);
        }
        countCol.view[rec.row] = last;
        return ok(undefined);
      }
    }
    // Value not present: idempotent no-op.
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // addComponent / removeComponent (archetype migration via edges, AC-07)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Add a component to an existing entity, triggering archetype migration.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentAlreadyPresentError)` (`.code = 'component-already-present'`)
   *   if entity already has the component (E-03).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const Velocity = defineComponent('Velocity', { dx: 'f32', dy: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.addComponent(e, { component: Velocity, data: { dx: 1, dy: 0 } });
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * r.unwrap();
   * ```
   */
  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): Result<void, EcsError> {
    return this._addComponentCore(entity, componentData, false);
  }

  /**
   * Core implementation of `addComponent` with reentry guard.
   *
   * @param internal — `true` when called from relationship hook machinery
   *   (lazy mirror create, exclusive reparent). Relationship handling is
   *   suppressed in this path; user-declared onInsert callbacks still fire.
   * @internal
   */
  _addComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
    internal: boolean,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'addComponent', componentData.component.name);
    if (!record.ok) return record;

    const rec = record.value;
    const srcArch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!srcArch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'addComponent',
          component: componentData.component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }

    // bug-20260615: unknown-key fail-fast BEFORE archetype mutation so a
    // typo aborts cleanly without partial state (mirrors _spawnCore).
    const keyErr = validateComponentDataKeys(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    if (keyErr !== null) {
      return err(keyErr as unknown as EcsError);
    }

    // Check if entity already has this component (using World-local ID).
    const localId = componentData.component.id;
    if (srcArch.columns.has(localId)) {
      // M2 exclusive relationship: re-adding the holder with a (possibly new)
      // target auto-reparents instead of failing (AC-12). Prune the old side
      // first (removeComponent fires the onRemove arm -> old mirror pruned),
      // then fall through to the normal add (onInsert arm -> new mirror
      // appended). The two steps keep both mirror lists consistent (AC-13);
      // removeComponent + addComponent each touch the mirror exactly once and
      // the mirror component carries no relationship of its own, so there is
      // no recursion. Reparent only fires for top-level user calls
      // (!internal); engine-internal lazy create / append
      // never re-add an existing relationship component.
      const rel = (componentData.component as Component).relationship;
      if (rel?.exclusive && !internal) {
        const removeR = this._removeComponentCore(
          entity,
          componentData.component as Component,
          false,
        );
        if (!removeR.ok) return removeR;
        return this._addComponentCore(entity, componentData, false);
      }
      return err(new ComponentAlreadyPresentError(entity as number, componentData.component.name));
    }

    // Cardinality enforcement (plan-strategy D-3). Check before any
    // archetype mutation. This entity does not already have the component
    // (guarded above), so we are adding 1 instance.
    const cardinalityErr = this.checkCardinality(componentData.component as Component, 1);
    if (cardinalityErr !== null) {
      return err(cardinalityErr as unknown as EcsError);
    }

    // Get target archetype via edge cache.
    const targetArch = getAddEdge(
      this.graph,
      srcArch,
      localId,
      componentData.component as Component,
    );

    // Migrate entity: copy existing data + add new component data.
    this.migrateEntity(rec, srcArch, targetArch);

    // Write the new component's data. Apply layer-2 + layer-3 silent
    // fallback so addComponent shares the SAME default-resolution path
    // as spawn / SceneAsset.instantiate (feat-20260517 / M2 / AC-04
    // research §F4 auto-symmetry; ComponentData<S>['data'] is the
    // physical bridge).
    const filled = fillComponentDefaults(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    this.writeRow(targetArch, componentData.component, rec.row, filled as ShapeOf<S>);

    // M1 hook framework: fire onInsert after writeRow completes (D-6).
    // onInsert fires with the entity and the written value as context.
    const onInsert = (componentData.component as Component).onInsert;
    if (onInsert) {
      onInsert(entity, filled as Record<string, unknown>);
    }
    // M2 relationship sync: append to the mirror list on the target.
    if (!internal && (componentData.component as Component).relationship) {
      this.relationshipOnInsert(
        entity,
        componentData.component as Component,
        filled as Record<string, unknown>,
      );
    }

    return ok(undefined);
  }

  /**
   * Remove a component from an existing entity, triggering archetype migration.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentNotPresentError)` (`.code = 'component-not-present'`)
   *   if entity doesn't have the component (E-04).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.removeComponent(e, Position);
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * r.unwrap();
   * ```
   */
  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError> {
    return this._removeComponentCore(entity, component, false);
  }

  /**
   * Core implementation of `removeComponent` with reentry guard.
   *
   * @param internal — `true` when called from relationship hook machinery
   *   (exclusive reparent). Relationship handling is suppressed in this
   *   path; user-declared onRemove callbacks still fire.
   * @internal
   */
  _removeComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    internal: boolean,
  ): Result<void, EcsError> {
    // Essential-component hard reject (feat-20260602 / plan-strategy D-3): the
    // id=0 `Entity` component is carried by every archetype unconditionally (it
    // is the row's own packed handle) and cannot be removed. Reject before any
    // liveness lookup so the rejection is structural, not entity-state-dependent.
    if (component.id === EntityComponent.id) {
      return err(new RemoveEssentialComponentError(component.name));
    }

    const record = this.lookupAlive(entity, 'removeComponent', component.name);
    if (!record.ok) return record;

    const rec = record.value;
    const srcArch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!srcArch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'removeComponent',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }

    // Check if entity has this component (using World-local ID).
    const localId = component.id;
    if (!srcArch.columns.has(localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    // M1 hook framework: fire onRemove before column removal, capturing the
    // old value snapshot so callbacks can inspect it (D-6, AC-03). M2 reuses
    // the same snapshot to locate the relationship target for mirror pruning.
    const onRemove = (component as Component).onRemove;
    const rel = (component as Component).relationship;
    const needsOldValue = onRemove !== undefined || (rel !== undefined && !internal);
    if (needsOldValue) {
      const oldValue = this.readRow(srcArch, component as Component, rec.row) as Record<
        string,
        unknown
      >;
      if (onRemove) {
        onRemove(entity, oldValue);
      }
      // M2 relationship sync: prune the holder from the target's mirror list.
      if (rel !== undefined && !internal) {
        this.relationshipOnRemove(entity, component as Component, oldValue);
      }
    }

    // M1 release loop (removeComponent path): release every `ref<T>` field
    // on the component being removed before migration drops the row.
    this.releaseManagedRefsOnRow(srcArch, component as Component, rec.row);

    // Get target archetype via edge cache.
    const targetArch = getRemoveEdge(this.graph, srcArch, localId);

    // Migrate entity: copy all data except the removed component.
    this.migrateEntity(rec, srcArch, targetArch);
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hierarchy Commands API (feat-20260531 M3 / plan-strategy D-4)
  //
  // addChild / removeChild / reparent are synchronous World methods that wrap
  // the existing addComponent / removeComponent paths with:
  //   - O(depth) ancestor-walk cycle detection (shared relationshipChainCycleHit)
  //   - parent-match verification for removeChild
  //   - atomic detach-then-attach for reparent
  //
  // The caller provides the holder relationship component (e.g. ChildOf) as a
  // Component token. The relationship hook (M2) handles bidirectional mirror
  // maintenance on addComponent / removeComponent.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Attach a child entity to a parent via a relationship component.
   *
   * Before writing, walks the ancestor chain of `parent` to detect cycles:
   * if `child === parent` (self-cycle) or `parent` is a descendant of `child`
   * (would close a loop), returns `Result.err` with `.code = 'relationship-
   * self-cycle'`. Otherwise calls `addComponent(child, { component, data })`
   * which triggers the relationship hook (M2) to maintain the bidirectional
   * mirror list atomically.
   *
   * The `parent` entity need not already carry the mirror component -- the
   * relationship hook lazy-creates it on first use.
   *
   * @returns `Result<void, EcsError>` -- `ok(void)` on success, or
   *   `err(StaleEntityError)` / `err(RelationshipSelfCycleError)` / etc.
   */
  addChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    const holderComp = component as Component;
    const rel = holderComp.relationship;
    if (rel === undefined) {
      return err(new ComponentNotPresentError(child as number, component.name));
    }

    // Cycle detection happens after the stale-entity guards below, via the
    // shared relationshipChainCycleHit() helper (also used by reparent). The
    // trivial self-cycle (child === parent) is checked inline first.
    const parentSlot = entityIndex(parent);
    const parentGen = entityGeneration(parent);
    const parentRec = this.records[parentSlot];
    if (!this.recordIsLive(parentRec, parentGen)) {
      return err(
        new StaleEntityError(parent as number, parentSlot, parentGen, {
          operation: 'addChild',
          component: component.name,
          expectedGeneration: parentGen,
          actualGeneration: this.records[parentSlot]?.generation ?? -1,
        }),
      );
    }

    const childSlot = entityIndex(child);
    const childGen = entityGeneration(child);
    const childRec = this.records[childSlot];
    if (!this.recordIsLive(childRec, childGen)) {
      return err(
        new StaleEntityError(child as number, childSlot, childGen, {
          operation: 'addChild',
          component: component.name,
          expectedGeneration: childGen,
          actualGeneration: this.records[childSlot]?.generation ?? -1,
        }),
      );
    }

    // Self-cycle: child === parent
    if (child === parent) {
      return err(new RelationshipSelfCycleError(component.name, child as number, child as number));
    }

    // Ancestor walk: if `child` appears in `parent`'s ancestor chain, adding
    // child->parent would close a cycle. Shared with reparent().
    const cycleHit = this.relationshipChainCycleHit(holderComp, parentSlot, parentGen, childSlot);
    if (cycleHit !== null) {
      return err(
        new RelationshipSelfCycleError(component.name, child as number, cycleHit as number),
      );
    }

    return this.addComponent(child, {
      component: component,
      data: data as Partial<InputShapeOf<S>>,
    });
  }

  /**
   * Detach a child entity from its parent via a relationship component.
   *
   * Reads the child's relationship component to locate the current parent.
   * Returns `Result.err` with `.code = 'relationship-detach-mismatch'` when
   * the child lacks the relationship component or the stored parent does not
   * match `parent` (AC-18). Otherwise calls `removeComponent(child, component)`
   * which triggers the relationship hook (M2) to prune the mirror list.
   *
   * The child entity survives the detach (only the relationship is removed);
   * this is distinct from `despawn` which destroys the whole entity.
   *
   * @returns `Result<void, EcsError>` -- `ok(void)` on success, or
   *   `err(StaleEntityError)` / `err(RelationshipDetachMismatchError)` / etc.
   */
  removeChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError> {
    const holderComp = component as Component;

    const childRec = this.lookupAlive(child, 'removeChild', component.name);
    if (!childRec.ok) return childRec;

    const childRecord = childRec.value;
    const childArch = this.graph.archetypes[childRecord.archetypeId];
    if (!childArch) {
      return err(
        new StaleEntityError(child as number, entityIndex(child), entityGeneration(child), {
          operation: 'removeChild',
          component: component.name,
          expectedGeneration: entityGeneration(child),
          actualGeneration: childRecord.generation,
        }),
      );
    }

    // Read the current relationship value to verify parent match.
    if (!childArch.columns.has(holderComp.id)) {
      return err(
        new RelationshipDetachMismatchError(
          component.name,
          child as number,
          parent as number,
          0, // actualParent = 0 signals no relationship
        ),
      );
    }

    const oldValue = this.readRow(childArch, holderComp, childRecord.row) as Record<
      string,
      unknown
    >;
    const currentTarget = this.relationshipTargetEntity(holderComp, oldValue);

    if (currentTarget !== parent) {
      return err(
        new RelationshipDetachMismatchError(
          component.name,
          child as number,
          parent as number,
          currentTarget ?? 0,
        ),
      );
    }

    return this.removeComponent(child, component as Component<string, S>);
  }

  /**
   * Reparent a child entity from its current parent to a new parent.
   *
   * Before writing, walks the ancestor chain of `newParent` to detect cycles.
   * If clean, performs an atomic detach-then-attach:
   *   1. Reads the child's current relationship to locate the old parent.
   *   2. Calls `removeComponent` (triggers M2 hook to prune old mirror).
   *   3. Calls `addComponent` (triggers M2 hook to append to new mirror).
   *
   * Both steps use the existing relationship infrastructure; each touches its
   * mirror exactly once and the mirror component carries no relationship of its
   * own, so there is no recursion hazard.
   *
   * @returns `Result<void, EcsError>` -- `ok(void)` on success, or
   *   `err(StaleEntityError)` / `err(RelationshipSelfCycleError)` /
   *   `err(RelationshipDetachMismatchError)` / etc.
   */
  reparent<S extends ComponentSchema>(
    child: EntityHandle,
    newParent: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    const holderComp = component as Component;
    const rel = holderComp.relationship;
    if (rel === undefined) {
      return err(new ComponentNotPresentError(child as number, component.name));
    }

    // Cycle detection: if `child` appears in newParent's ancestor chain,
    // reparenting would close a cycle. Shared with addChild().
    if (child === newParent) {
      return err(
        new RelationshipSelfCycleError(component.name, child as number, newParent as number),
      );
    }
    const cycleHit = this.relationshipChainCycleHit(
      holderComp,
      entityIndex(newParent),
      entityGeneration(newParent),
      entityIndex(child),
    );
    if (cycleHit !== null) {
      return err(
        new RelationshipSelfCycleError(component.name, child as number, cycleHit as number),
      );
    }

    // Read child's current parent (for the detach).
    const childRec = this.lookupAlive(child, 'reparent', component.name);
    if (!childRec.ok) return childRec;

    const childRecord = childRec.value;
    const childArch = this.graph.archetypes[childRecord.archetypeId];
    if (!childArch) {
      return err(
        new StaleEntityError(child as number, entityIndex(child), entityGeneration(child), {
          operation: 'reparent',
          component: component.name,
          expectedGeneration: entityGeneration(child),
          actualGeneration: childRecord.generation,
        }),
      );
    }

    if (childArch.columns.has(holderComp.id)) {
      // Remove the old relationship first (fires onRemove hook -> old mirror pruned).
      const removeR = this.removeComponent(child, component as Component<string, S>);
      if (!removeR.ok) return removeR;
    }
    // else: child has no relationship yet -- just attach (same as addChild on a
    // root entity).

    // Attach the new relationship (fires onInsert hook -> new mirror appended).
    return this.addComponent(child, {
      component: component,
      data: data as Partial<InputShapeOf<S>>,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hierarchy traversal API (feat-20260531 M3 / plan-strategy D-4)
  //
  // iterAncestors: walk ChildOf chain upward, child->root order.
  // iterDescendants: DFS over Children mirror lists, covering the full subtree.
  // Both return Iterable<Entity> for standard for...of consumption.
  // Cycle detection (AC-23): visited-set guards prevent infinite loops on
  // corrupt data. The traversal is read-only and does not mutate state.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Walk the relationship chain upward from (`startSlot`, `startGen`) looking
   * for `targetSlot`. Returns the matching ancestor Entity (the cycle hit) if
   * `targetSlot` appears in the chain, else `null`. Used by addChild/reparent
   * for O(depth) cycle detection before a write. A visited-set guards against
   * pre-existing corrupt cycles (terminates instead of looping).
   */
  private relationshipChainCycleHit(
    holderComp: Component,
    startSlot: number,
    startGen: number,
    targetSlot: number,
  ): EntityHandle | null {
    const visited = new Set<number>();
    let cur: number = startSlot;
    let curGen: number = startGen;
    while (true) {
      const key = pack(cur, curGen);
      if (visited.has(key)) return null; // corrupt pre-existing cycle: terminate
      visited.add(key);

      const curRec = this.records[cur];
      if (!this.recordIsLive(curRec, curGen)) return null;
      const curArch = this.graph.archetypes[curRec.archetypeId];
      if (!curArch) return null;

      if (!curArch.columns.has(holderComp.id)) return null;
      const value = this.readRow(curArch, holderComp, curRec.row) as Record<string, unknown>;
      const target = this.relationshipTargetEntity(holderComp, value);
      if (target === null) return null;
      const tgtSlot = entityIndex(target);
      if (tgtSlot === targetSlot) return target;
      cur = tgtSlot;
      curGen = entityGeneration(target);
    }
  }

  /**
   * Iterate the ancestor chain of `entity` in child->root order.
   *
   * Walks the relationship chain upward from `entity`'s parent to the root,
   * yielding each ancestor Entity. The root entity (which has no parent) is
   * yielded last; `entity` itself is not yielded. Entities without a
   * relationship component yield an empty iterable.
   *
   * Cycle protection: a visited-set prevents infinite looping on corrupt data
   * that contains a cycle in the relationship chain (AC-23).
   *
   * @returns An `Iterable<Entity>` over ancestors in child->root order.
   */
  iterAncestors(entity: EntityHandle): Iterable<EntityHandle> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      *[Symbol.iterator]() {
        const slot = entityIndex(entity);
        const gen = entityGeneration(entity);
        const rec = self.records[slot];
        if (!self.recordIsLive(rec, gen)) return;

        const visited = new Set<number>();
        let cur: number = slot;
        let curGen: number = gen;

        // Read the current entity's parent, then walk upward.
        // We start from entity, read its parent, then ascend.
        while (true) {
          const key = pack(cur, curGen);
          if (visited.has(key)) return; // cycle detected, terminate
          visited.add(key);

          const curRec = self.records[cur];
          if (!self.recordIsLive(curRec, curGen)) return;
          const curArch = self.graph.archetypes[curRec.archetypeId];
          if (!curArch) return;

          // Find any relationship component on this entity to walk upward.
          // We iterate all components: any component with a relationship
          // meta and an entity field that points non-null is the parent link.
          let foundParent = false;
          for (const comp of curArch.components) {
            const rel = comp.relationship;
            if (rel === undefined) continue;
            if (!curArch.columns.has(comp.id)) continue;
            const value = self.readRow(curArch, comp, curRec.row) as Record<string, unknown>;
            const target = self.relationshipTargetEntity(comp, value);
            if (target !== null) {
              // Yield the parent entity
              yield target;
              // Ascend: walk from the parent next
              const nextSlot = entityIndex(target);
              const nextGen = entityGeneration(target);
              const nextRec = self.records[nextSlot];
              if (!self.recordIsLive(nextRec, nextGen)) return;
              cur = nextSlot;
              curGen = nextGen;
              foundParent = true;
              break;
            }
          }
          if (!foundParent) return; // no parent found, root reached
        }
      },
    };
  }

  /**
   * Iterate all descendants of `entity` via DFS traversal.
   *
   * Reads the mirror component (e.g. Children.entities) on `entity` and
   * recursively yields each child and all of its descendants. The traversal
   * is depth-first: each child is yielded, then its subtree is explored before
   * moving to the next sibling.
   *
   * Cycle protection: a visited-set prevents re-visiting entities already
   * yielded in the current traversal, guarding against infinite loops when the
   * data contains circular Children entries (AC-23).
   *
   * @returns An `Iterable<Entity>` over all descendants in DFS order.
   */
  iterDescendants(entity: EntityHandle): Iterable<EntityHandle> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      *[Symbol.iterator]() {
        const slot = entityIndex(entity);
        const gen = entityGeneration(entity);
        const rec = self.records[slot];
        if (!self.recordIsLive(rec, gen)) return;

        const visited = new Set<number>();
        const stack: number[] = [slot];

        while (stack.length > 0) {
          const cur = stack.pop();
          if (cur === undefined) break;
          const curRec = self.records[cur];
          // Stack entries are gen-validated before being pushed (see the child
          // loop below) and the traversal is synchronous + read-only, so the
          // only liveness facet left to confirm is "still materialized into an
          // archetype row" (archetypeId !== -1; the `alive` boolean is
          // gone; feat-20260602 D-4). The `!curArch` guard below covers the
          // archetypeId < 0 case.
          if (!curRec || curRec.archetypeId === -1) continue;
          const curArch = self.graph.archetypes[curRec.archetypeId];
          if (!curArch) continue;

          // Find mirror components (any component with an array<entity> field)
          for (const comp of curArch.components) {
            // Only components that are mirror targets carry children lists.
            // Check if this component has schema fields that are array<entity>.
            for (const [fieldName, fieldType] of Object.entries(comp.schema)) {
              if (fieldType !== 'array<entity>') continue;
              if (!curArch.columns.has(comp.id)) continue;
              const value = self.readRow(curArch, comp, curRec.row) as Record<string, unknown>;
              const list = value[fieldName];
              if (!(list instanceof Uint32Array)) continue;
              for (const raw of list) {
                const childSlot = entityIndex(raw as EntityHandle);
                const childGen = entityGeneration(raw as EntityHandle);
                const key = pack(childSlot, childGen);
                if (visited.has(key)) continue;
                const childRec = self.records[childSlot];
                if (!self.recordIsLive(childRec, childGen)) continue;
                visited.add(key);
                yield raw as EntityHandle;
                stack.push(childSlot);
              }
            }
          }
        }
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — deferred command support (CommandBuffer interface)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @internal Allocate a pending entity for deferred spawn.
   * Returns an Entity handle. The entity is "pending" because
   * archetypeId === -1 (set by allocateIndex); no separate flag needed.
   */
  _allocatePendingEntity(): EntityHandle {
    const indexSlot = this.allocateIndex();
    // biome-ignore lint/style/noNonNullAssertion: allocateIndex guarantees a valid slot with an initialized record
    return encodeEntity(indexSlot, this.records[indexSlot]!.generation);
  }

  /**
   * @internal Materialize a pending entity: actually place it into an archetype.
   * Idempotent: a record with archetypeId !== -1 is already materialized.
   */
  _materializePendingEntity(entity: EntityHandle, componentDatas: ComponentData[]): void {
    const slot = entityIndex(entity);
    const record = this.records[slot];
    if (!record || record.archetypeId !== -1) return;

    // Find or create target archetype (using World-local IDs).
    const componentIds = componentDatas.map((cd) => cd.component.id);
    const components = componentDatas.map((cd) => cd.component);
    const arch = getOrCreateArchetype(this.graph, componentIds, components);

    // Append entity row.
    const row = appendEntity(arch, slot);

    // Write initial data. Apply layer-2 + layer-3 silent fallback so
    // deferred-spawn (Commands.spawn) shares the SAME default-resolution
    // path as the synchronous `world.spawn` / `addComponent` /
    // SceneAsset.instantiate (feat-20260517 / M2 / AC-04 + AC-09).
    for (const cd of componentDatas) {
      const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
      this.writeRow(arch, cd.component, row, filled as ShapeOf<ComponentSchema>);
    }

    // Essential id=0 `Entity` column write (feat-20260602 / plan-strategy D-3),
    // mirroring the synchronous `spawn` path: the deferred handle was minted at
    // `_allocatePendingEntity` time and is passed in here.
    this.writeEntitySelf(arch, row, entity);

    record.archetypeId = arch.id;
    record.row = row;

    // M1 hook framework: fire onInsert + M2 relationship sync after all
    // rows are written (mirrors `_spawnCore` hook firing, internal=false
    // since flush is a public-facing path).
    for (const cd of componentDatas) {
      const onInsert = (cd.component as Component).onInsert;
      if (onInsert) {
        const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
        onInsert(entity, filled as Record<string, unknown>);
      }
      if ((cd.component as Component).relationship) {
        const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
        this.relationshipOnInsert(
          entity,
          cd.component as Component,
          filled as Record<string, unknown>,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — entity index allocation
  // ──────────────────────────────────────────────────────────────────────────

  private allocateIndex(): number {
    const recycled = this.freeIndices.pop();
    if (recycled !== undefined) {
      return recycled;
    }
    const slot = this.records.length;
    if (slot > ENTITY_MAX_INDEX) {
      throw new EntityIndexOverflowError(slot);
    }
    this.records.push({ generation: 0, archetypeId: -1, row: -1 });
    return slot;
  }

  /**
   * Single liveness predicate (feat-20260602 / plan-strategy D-4): a slot is
   * live for a given handle generation iff the record exists, its generation
   * still matches the handle (despawn bumps generation, so a stale or recycled
   * handle fails here), and the slot is materialized into an archetype
   * (archetypeId !== -1). Replaces the former `record.alive && record.generation
   * === gen` conjunction and the intermediate `!record.pending` clause.
   */
  private recordIsLive(record: EntityRecord | undefined, gen: number): record is EntityRecord {
    return record !== undefined && record.generation === gen && record.archetypeId !== -1;
  }

  private lookupAlive(
    entity: EntityHandle,
    operation: string,
    component?: string,
  ): Result<EntityRecord, EcsError> {
    const slot = entityIndex(entity);
    const gen = entityGeneration(entity);
    const record = this.records[slot];
    if (!this.recordIsLive(record, gen)) {
      return err(
        new StaleEntityError(entity as number, slot, gen, {
          operation,
          ...(component !== undefined ? { component } : {}),
          expectedGeneration: gen,
          actualGeneration: this.records[slot]?.generation ?? -1,
        }),
      );
    }
    return ok(record);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — archetype data read/write
  // ──────────────────────────────────────────────────────────────────────────

  private readRow<S extends ComponentSchema>(
    arch: Archetype,
    component: Component<string, S>,
    row: number,
  ): ShapeOf<S> {
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    const out = {} as ShapeOf<S>;
    /* istanbul ignore next -- defensive: component is registered and arch has it */
    if (!fieldCols) {
      return out;
    }
    for (const [fieldName, fieldType] of Object.entries(component.schema)) {
      const col = fieldCols.get(fieldName);
      if (!col) {
        continue;
      }
      const raw = col.view[row];
      if (fieldType === 'bool') {
        (out as Record<string, unknown>)[fieldName] = raw === 1;
      } else if (isEntityField(fieldType)) {
        // Entity field: decode the stored raw u32 verbatim back to Entity
        // (or null when the slot carries the ENTITY_NULL_RAW sentinel). No
        // liveness validation happens here -- a slot referencing a despawned
        // target returns its original raw encoding unchanged; the consumer is
        // responsible for checking liveness (e.g. `world.get(ref, Entity)`).
        (out as Record<string, unknown>)[fieldName] = raw === ENTITY_NULL_RAW ? null : raw;
      } else if (isManagedBufferField(fieldType)) {
        if (fieldType !== 'buffer') {
          // feat-20260602: fixed `buffer<N>` lives inline (stride-N u8 column,
          // arity = N). Return the row's byte window directly -- no pool slot.
          const arity = col.arity;
          (out as Record<string, unknown>)[fieldName] = (col.view as Uint8Array).subarray(
            row * arity,
            row * arity + arity,
          );
        } else {
          // Variable `'buffer'`: column stores slot id; the live view is
          // resolved on demand so post-grow callers always see the refreshed
          // Uint8Array.
          (out as Record<string, unknown>)[fieldName] = this.bufferPool.view(raw as number);
        }
      } else if (fieldType === 'string') {
        // M1 string-field read path (AC-03 / AC-09): resolve the column
        // u32 handle through UniqueRefStore -- same dispatch arm as the
        // 'unique<T>' read (D-R3). Returns the native JS string payload by
        // strong reference; identity is stable across reads until the
        // next set or release (AC-03 read-side identity contract).
        // Released / sentinel handles surface as unique-ref-released via
        // resolve; we fall back to '' rather than propagate the error so
        // the read shape (`out.value: string`) stays total -- AI users
        // never see undefined or wrapper objects.
        const resolveR = this.uniqueRefs.resolve<'String'>(toUnique<'String'>(raw as number));
        (out as Record<string, unknown>)[fieldName] = resolveR.ok ? resolveR.value : '';
      } else {
        const arrayMeta = component.fields[fieldName]?.arrayMeta;
        if (arrayMeta !== undefined) {
          // M1 read path: materialise a fresh TypedArray snapshot each call
          // (D-4 no cache; plan-strategy §2.2 read-only contract). The
          // snapshot aliases the BufferPool slot bytes; mutations route
          // through `world.set` / `world.push` / `world.pop`.
          (out as Record<string, unknown>)[fieldName] = this.materializeArrayView(
            arch,
            component,
            row,
            fieldName,
            arrayMeta.elementType,
            arrayMeta.length,
            raw as number,
          );
        } else {
          (out as Record<string, unknown>)[fieldName] = raw;
        }
      }
    }
    return out;
  }

  /**
   * Write the full packed entity handle into the row's essential id=0 `Entity`
   * column (`self` field). Called by `spawn` / `_materializePendingEntity`
   * after the row is appended (feat-20260602 / plan-strategy D-3). The column
   * always exists -- `createArchetype` folds the Entity column into every
   * archetype -- so this is a direct u32 store, no readRow/writeRow walk.
   */
  private writeEntitySelf(arch: Archetype, row: number, handle: EntityHandle): void {
    const col = arch.columns.get(EntityComponent.id)?.get('self');
    /* istanbul ignore next -- defensive: Entity column is folded into every archetype */
    if (!col) return;
    col.view[row] = handle as unknown as number;
  }

  private writeRow<S extends ComponentSchema>(
    arch: Archetype,
    component: Component<string, S>,
    row: number,
    value: ShapeOf<S>,
  ): void {
    const localId = component.id;
    const fieldCols = arch.columns.get(localId);
    /* istanbul ignore next -- defensive: component is registered and arch has it */
    if (!fieldCols) {
      return;
    }
    for (const [fieldName, fieldType] of Object.entries(component.schema)) {
      const col = fieldCols.get(fieldName);
      /* istanbul ignore next -- defensive: schema fields always have columns */
      if (!col) {
        continue;
      }
      const raw = (value as Record<string, unknown>)[fieldName];
      if (fieldType === 'bool') {
        col.view[row] = raw ? 1 : 0;
      } else if (isEntityField(fieldType)) {
        // M3 entity field: encode (slot, gen) into u32 column. `null`
        // / undefined map to ENTITY_NULL_RAW sentinel.
        col.view[row] = raw === null || raw === undefined ? ENTITY_NULL_RAW : (raw as number);
      } else if (isManagedBufferField(fieldType)) {
        // M2 spawn path: collapsed-vocab keyword family `'buffer'` (variable)
        // + `'buffer<N>'` (fixed):
        //   - `buffer<N>` (feat-20260602) — lives inline as a stride-N u8
        //     column (arity = N). Copy any provided payload straight into the
        //     row window (truncate to N); no BufferPool slot.
        //   - `'buffer'`  — variable capacity; alloc one BufferPool slot sized
        //     to the provided payload's byteLength. Missing / non-buffer raw
        //     -> alloc(0) zero-length live view (verify round 1 B2 fix path;
        //     pre-fix the bare keyword routed `bufferFieldByteLength('buffer')`
        //     -> NaN -> alloc(NaN) -> managed-buffer-out-of-bounds, dropping
        //     the payload bytes silently). Failures route to Layer 3
        //     ErrorHandler; column slot stays at 0 (sentinel) so subsequent
        //     release short-circuits.
        //   raw is normalized from any AllowSharedBufferSource view to a
        //   Uint8Array over its bytes (feat-20260621 V2 / AC-A4).
        const bytes = normalizeBufferWrite(raw);
        if (fieldType !== 'buffer') {
          const arity = col.arity;
          if (bytes !== null) {
            const copyLen = Math.min(bytes.byteLength, arity);
            (col.view as Uint8Array).set(bytes.subarray(0, copyLen), row * arity);
          }
        } else {
          const allocBytes = bytes !== null ? bytes.byteLength : 0;
          const allocR = this.bufferPool.alloc(allocBytes);
          if (!allocR.ok) {
            const ctx: ErrorContext = {
              severity: Severity.Error,
              systemName: `World.spawn (${component.name}.${fieldName})`,
            };
            this.errorHandler(allocR.error, ctx);
            col.view[row] = 0;
            continue;
          }
          const slot = allocR.value;
          if (bytes !== null) {
            // allocBytes is the payload's exact byteLength so no truncation.
            const copyLen = Math.min(bytes.byteLength, slot.view.byteLength);
            slot.view.set(bytes.subarray(0, copyLen));
          }
          col.view[row] = slot.id;
        }
      } else if (fieldType === 'string') {
        // M1 string-field spawn path (AC-04 / AC-06): route the JS string
        // payload through `uniqueRefs.alloc('String', text)` -- the same
        // UniqueRefStore the `ref<T>` arm uses (D-R3 single-arm dispatch).
        // The store holds the immutable string by strong reference so
        // identity is stable across reads (AC-03). Missing / non-string raw
        // falls back to '' so AI users always see a readable string on
        // get (no nullable handling).
        const text = typeof raw === 'string' ? raw : '';
        const handle = this.uniqueRefs.alloc<'String'>('String', text);
        col.view[row] = unwrapHandle(handle);
      } else {
        const arrayMeta = component.fields[fieldName]?.arrayMeta;
        if (arrayMeta !== undefined) {
          // M1 spawn path for array<T> / array<T,N> fields (D-3 double-
          // column for variable; single column for fixed).
          // Spawn path: no prior-slot release (fresh rows carry stale debris
          // owned by the migrated entity in the new archetype) — feat-20260614
          // D-3 calling convention.
          this.writeArrayField(arch, component, row, fieldName, fieldType, arrayMeta, raw);
        } else {
          col.view[row] = raw as number;
          // feat-20260614 M5 / D-5: scalar 'shared<T>' spawn retain. The
          // alloc-grant rc=1 stays held by the producer (e.g. AssetRegistry);
          // each ECS holder bumps rc via this retain so despawn / overwrite
          // releases bring rc back symmetrically. Sentinel slot 0 is a no-op.
          if (fieldType.startsWith('shared<') && (raw as number) !== 0) {
            this.retainSharedScalarHandle(raw as number, component.name, fieldName);
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — managed-ref + managed-buffer release loop (M1 / M2)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Release every managed-resource field on `component` for the row at
   * `row` in `arch`. Walks the schema once and delegates each field to
   * `releaseManagedFieldOnRow` (feat-20260614 M2 SSOT). Family coverage
   * (per-field) lives in that helper's JSDoc.
   *
   * Naming note (D-6 whitelist): the prefix `managed` here means
   * `managed = ECS-tracked` — i.e. fields whose lifecycle the ECS
   * actively releases on despawn / overwrite / removeComponent. It does
   * NOT refer to the retired `'managed' | 'unmanaged'` Handle brand
   * (renamed to `'unique' | 'shared'` in feat-20260614 M1). The helper
   * walks BOTH `'unique<T>'` and `'shared<T>'` fields because both are
   * ECS-tracked from the column's perspective; the per-field dispatch
   * inside `releaseManagedFieldOnRow` distinguishes drop-on-despawn
   * (unique) vs ref-counted release (shared).
   *
   * Skips sentinel slots (handle / id 0) and missing stores. Failures
   * (double release / lookup mismatch) route to the Layer 3 ErrorHandler so
   * the despawn / removeComponent chain never aborts (charter: explicit-
   * failure boundary; the chain is total).
   *
   * Four release paths route through this helper (AC-11, plan §6 M2):
   *   1. `world.despawn(e)`             - every component on `e`.
   *   2. `world.removeComponent(e, C)`  - the removed component only.
   *   3. `world.set` ref/string/buffer overwrite - per-field, before the new
   *                                                value lands in the column.
   *   4. `writeArrayField` set arm prior-slot release (variable array<T>).
   *
   * After feat-20260614 M2 SSOT collapse the schema-field 3-arm dispatch
   * lives in `releaseManagedFieldOnRow` (one site); this method walks the
   * component schema and delegates per field.
   *
   * BufferPool slot id is reusable post-release: same-bucket free-list LIFO
   * (D-7) returns the freed id on the next `alloc(byteLength)`. Tests:
   * `__tests__/managed-array-release.test.ts` (w10) +
   * `__tests__/world-managed-roundtrip.unit.test.ts` (w3 net-zero matrix).
   */
  private releaseManagedRefsOnRow(arch: Archetype, component: Component, row: number): void {
    const fieldCols = arch.columns.get(component.id);
    if (!fieldCols) return;
    for (const fieldName of Object.keys(component.schema)) {
      this.releaseManagedFieldOnRow(arch, component, row, fieldName);
    }
  }

  /**
   * SSOT release dispatch for a single managed field on a row (feat-20260614
   * M2 / D-2). Inspects the component schema's field type and routes to the
   * matching release path:
   *
   *   - `'unique<T>'` / `'string'` (`isManagedField`)         — release the
   *     UniqueRefStore handle u32 stored in the column.
   *   - `'buffer'` variable     (`isManagedBufferField`)   — release the
   *     BufferPool slot id stored in the column. Fixed `'buffer<N>'` is
   *     inline stride-N (feat-20260602) and has no slot to release.
   *   - `array<T>` variable     (`isManagedArrayField`)    — release the
   *     BufferPool slot id in the primary column + zero the column and the
   *     `<fieldName>:count` sidecar so post-recycle reads observe count=0
   *     (defense-in-depth; the swap-pop row migration overwrites both
   *     columns anyway). Fixed `array<T,N>` is inline stride-N — nothing to
   *     release.
   *
   * Sentinel handle / slot id 0 short-circuits silently. Double-release /
   * lookup mismatch routes via Layer 3 ErrorHandler so the despawn /
   * removeComponent / set chain never aborts (charter explicit-failure
   * boundary; the chain is total).
   *
   * SceneInstance state alloc/release rollback at world.ts:3494/3522 stays
   * a direct `uniqueRefs.release(stateRef)` (research Finding 1.8 / D-5):
   * those two sites are alloc-pair rollback, not schema-field dispatch.
   *
   * Naming note (D-6 whitelist): `releaseManagedFieldOnRow` uses
   * `managed = ECS-tracked` — every field family this dispatcher knows
   * (`'unique<T>'`, `'shared<T>'`, `'string'`, variable `'buffer'`,
   * variable `'array<T>'`) is one whose lifecycle the ECS owns. The
   * `'managed' | 'unmanaged'` Handle brand is gone (M1 renamed to
   * `'unique' | 'shared'`); the helper name was deliberately kept
   * because `managed` here is a column-side semantic, not a brand label.
   */
  private releaseManagedFieldOnRow(
    arch: Archetype,
    component: Component,
    row: number,
    fieldName: string,
  ): void {
    const fieldCols = arch.columns.get(component.id);
    if (!fieldCols) return;
    const col = fieldCols.get(fieldName);
    if (!col) return;
    const fieldType = (component.schema as Record<string, string>)[fieldName] ?? '';
    if (isManagedField(fieldType)) {
      // Sub-dispatch by the schema-vocab keyword (feat-20260614 M4 / AC-08):
      //   - 'shared<T>' scalar    -> SharedRefStore.release (rc--; drop on rc=0)
      //   - 'unique<T>' / 'string' -> UniqueRefStore.release (direct slot drop)
      // Both column shapes are u32 handles; the lookup store differs.
      // Keeping both arms inside the unified `isManagedField` block is
      // intentional: meta key (TYPE_METADATA `'shared'` vs `'ref'`) decides
      // the store, not a separate top-level branch (architecture-principles
      // §1 SSOT — meta key = release semantics).
      const handleU32 = col.view[row] as number;
      if (fieldType.startsWith('shared<')) {
        this.releaseSharedRefHandle(handleU32, component.name, fieldName);
        return;
      }
      this.releaseManagedRefHandle(handleU32, component.name, fieldName);
      return;
    }
    if (isManagedBufferField(fieldType)) {
      if (fieldType === 'buffer') {
        const slotId = col.view[row] as number;
        this.releaseManagedBufferSlot(slotId, component.name, fieldName);
        col.view[row] = 0;
      }
      return;
    }
    if (isManagedArrayField(fieldType)) {
      // Use the pre-parsed arrayMeta cached on the component descriptor at
      // registration (AC-03c parse-free hot path); reaching for
      // `parseManagedArraySchema` here would violate the parse-free
      // invariant exercised by hierarchy.unit.test.ts §w5 AC-03(a).
      const arrayMeta = component.fields[fieldName]?.arrayMeta;
      if (arrayMeta === undefined) return;
      const isSharedElement = arrayMeta.elementType.startsWith('shared<');
      if (arrayMeta.length === undefined) {
        // Variable `array<T>`: BufferPool slot id in primary column + live
        // count in `<fieldName>:count` sidecar. For `array<shared<T>>`,
        // walk live elements and release each shared handle BEFORE
        // releasing the slot bytes (feat-20260614 M4 / D-3 — slot bytes
        // are only valid until the slot is recycled).
        const slotId = col.view[row] as number;
        const countCol = fieldCols.get(arrayCountColumnName(fieldName));
        if (isSharedElement && slotId !== 0) {
          const liveCount = countCol !== undefined ? (countCol.view[row] as number) : 0;
          const slotView = liveCount > 0 ? this.bufferPool.view(slotId) : null;
          if (slotView !== null && slotView.byteLength > 0) {
            this.releaseSharedArrayElements(slotView, liveCount);
          }
        }
        this.releaseManagedBufferSlot(slotId, component.name, fieldName);
        col.view[row] = 0;
        if (countCol !== undefined) countCol.view[row] = 0;
        return;
      }
      // Fixed `array<T,N>` (feat-20260602): inline stride-N column, no
      // BufferPool slot to release. For `array<shared<T>,N>`, walk the N
      // inline elements and release each shared handle. Zero the row
      // window so subsequent writes do not double-release.
      if (isSharedElement) {
        const arity = col.arity;
        const elementBytes = (TYPE_METADATA.shared?.byteSize ?? 4) as number;
        const rowByteOffset = col.view.byteOffset + row * arity * elementBytes;
        const rowBytes = new Uint8Array(col.view.buffer, rowByteOffset, arity * elementBytes);
        this.releaseSharedArrayElements(rowBytes, arity);
        rowBytes.fill(0);
      }
    }
  }

  /**
   * Release a single managed handle u32. Routes failures through Layer 3.
   * Slot-0 sentinel short-circuits silently (no error); already-released
   * slots surface `unique-ref-double-release` through the ErrorHandler so
   * AI users see the structured payload (`.code` / `.hint` / `.expected` /
   * `.detail`) - charter explicit-failure boundary.
   *
   * Helper-internal only after feat-20260614 M2 (AC-03 grep gate). External
   * callers route via `releaseManagedFieldOnRow`.
   */
  private releaseManagedRefHandle(
    handleU32: number,
    componentName: string,
    fieldName: string,
  ): void {
    if (handleU32 === 0) return; // sentinel: skip silently.
    const r = this.uniqueRefs.release(handleU32 as Handle<string, 'unique'>);
    if (r.ok) return;
    // Layer 3 routing: surface double-release as a structured error so AI
    // users see {code, hint, expected, detail} on their handler. Severity
    // defaults to Error so the chain continues; matchSeverity prints to
    // console.error rather than throw.
    const ctx: ErrorContext = {
      severity: Severity.Error,
      systemName: `World.release (${componentName}.${fieldName})`,
    };
    this.errorHandler(r.error, ctx);
  }

  /**
   * Release a single shared-ref handle u32 (feat-20260614 M4 / AC-08).
   * Decrements the SharedRefStore refcount; the slot drops on rc 1 -> 0.
   * Slot-0 sentinel short-circuits silently. Already-released slots route
   * `shared-ref-double-release` through Layer 3 ErrorHandler so AI users
   * see structured payloads (charter explicit-failure boundary).
   *
   * Mirrors `releaseManagedRefHandle` in shape; the store + error code are
   * the only differences. Helper-internal — external callers route via
   * `releaseManagedFieldOnRow` (D-2 SSOT).
   */
  private releaseSharedRefHandle(
    handleU32: number,
    componentName: string,
    fieldName: string,
  ): void {
    // feat-20260614 M6 D-15 / R-14: builtin slots (< BUILTIN_BASE, including the
    // sentinel 0) are process-static and never reference-counted -> short-circuit
    // before touching SharedRefStore. This single guard is the SSOT for both the
    // scalar arm (here) and the array-element arm (releaseSharedArrayElements).
    if (handleU32 < BUILTIN_BASE) return;
    const r = this.sharedRefs.release(toShared<string>(handleU32));
    if (r.ok) return;
    const ctx: ErrorContext = {
      severity: Severity.Error,
      systemName: `World.release (${componentName}.${fieldName})`,
    };
    this.errorHandler(r.error, ctx);
  }

  /**
   * Retain a single `shared<T>` scalar slot id (feat-20260614 M5 / D-5).
   * Mirrors `releaseSharedRefHandle`; called from spawn / set scalar write
   * paths so each ECS holder participates in the SharedRefStore rc.
   * Sentinel slot 0 is a no-op. Failures (handle already released) route
   * via Layer 3 ErrorHandler so the spawn / set chain stays total.
   */
  private retainSharedScalarHandle(
    handleU32: number,
    componentName: string,
    fieldName: string,
  ): void {
    // feat-20260614 M6 D-15 / R-14: builtin slots (< BUILTIN_BASE, including the
    // sentinel 0) short-circuit — process-static, never reference-counted. SSOT
    // guard shared with the array-element arm (retainSharedArrayElements).
    if (handleU32 < BUILTIN_BASE) return;
    const r = this.sharedRefs.retain(toShared<string>(handleU32));
    if (r.ok) return;
    const ctx: ErrorContext = {
      severity: Severity.Error,
      systemName: `World.write (${componentName}.${fieldName} shared scalar retain)`,
    };
    this.errorHandler(r.error, ctx);
  }

  /**
   * Release a single managed buffer slot id. Routes failures through Layer 3.
   * Slot id 0 (sentinel for unallocated buffer fields) short-circuits
   * silently. M2 v1 release surface is total - `BufferPool.release` returns
   * `Result<void, never>` for unknown ids, so the chain stays noise-free.
   *
   * Helper-internal only after feat-20260614 M2 (AC-03 grep gate). External
   * callers route via `releaseManagedFieldOnRow`.
   */
  private releaseManagedBufferSlot(slotId: number, componentName: string, fieldName: string): void {
    if (slotId === 0) return; // sentinel: skip silently.
    const r = this.bufferPool.release(slotId);
    /* istanbul ignore if -- BufferPool.release is total in v1 (Result<void, never>); branch reserved for future fail-fast extension. */
    if (!r.ok) {
      const ctx: ErrorContext = {
        severity: Severity.Error,
        systemName: `World.release (${componentName}.${fieldName})`,
      };
      this.errorHandler(r.error, ctx);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — array<T> / array<T,N> spawn / set helpers (M1 / w7)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Bridge a Layer-3 ErrorHandler call from a `ManagedArrayErrorEnvelope`.
   * The envelope shape (`code / hint / expected / detail`) already mirrors
   * the EcsError contract; this helper only attaches the systemName context
   * so AI users can correlate the error with the holder component / field.
   */
  private routeArrayError(
    err: ManagedArrayErrorEnvelope,
    componentName: string,
    fieldName: string,
  ): void {
    const ctx: ErrorContext = {
      severity: Severity.Error,
      systemName: `World.write (${componentName}.${fieldName})`,
    };
    this.errorHandler(err, ctx);
  }

  /**
   * Write the value of an `array<T>` / `array<T,N>` field at `row` (D-3 +
  /**
   * Write an `array<T>` / `array<T,N>` field's payload at `row` (M1 / w7,
   * D-1; feat-20260614 M2 / D-3). Spawn and set both delegate here without
   * an `operation` parameter — the caller's calling convention encodes the
   * difference:
   *   - Set path: caller invokes `releaseManagedFieldOnRow(arch, comp, row,
   *     fieldName)` BEFORE this method to release the prior slot (variable
   *     `array<T>`). Fixed `array<T,N>` is inline stride-N (feat-20260602)
   *     and has no slot to release on either path.
   *   - Spawn path: caller does NOT call the helper — fresh rows treat any
   *     non-zero u32 in the column as stale swap-pop debris owned by the
   *     migrated entity in the new archetype.
   *
   * Body:
   *   - Alloc a fresh BufferPool slot of `payload.length * elementBytes`.
   *   - Copy bytes from the payload's typed-array buffer into the slot view.
   *   - Persist slot id in the primary u32 column. For `array<T>` (variable),
   *     persist the live count in the sidecar `<fieldName>:count` column.
   *
   * Errors flow through `routeArrayError` with a uniform `World.write` label.
   */
  private writeArrayField(
    arch: Archetype,
    component: Component,
    row: number,
    fieldName: string,
    _fieldType: string,
    arrayMeta: ArrayMeta,
    raw: unknown,
  ): void {
    const fieldCols = arch.columns.get(component.id);
    /* istanbul ignore next -- writeArrayField caller validated the column map */
    if (!fieldCols) return;
    const col = fieldCols.get(fieldName);
    /* istanbul ignore next -- writeArrayField caller validated the column */
    if (!col) return;

    const elementType = arrayMeta.elementType;
    // Normalize parametrised element-type template literals to the family
    // key for TYPE_METADATA lookup; the column stores plain u32 handles
    // either way:
    //   - `shared<X>` -> 'shared' (feat-20260614 M4 / D-3 -- element-level
    //     retain/release semantics route via the dedicated `'shared'` arm
    //     below)
    const metaKey = elementType.startsWith('shared<') ? 'shared' : (elementType as string);
    const meta = TYPE_METADATA[metaKey];
    /* istanbul ignore next -- arrayMeta.elementType is guaranteed in TYPE_METADATA */
    if (!meta) return;
    // biome-ignore lint/style/noNonNullAssertion: ManagedArrayElementType always scalar -> byteSize present
    const elementBytes = meta.byteSize!;

    const isVariable = arrayMeta.length === undefined;
    const fixedLength = arrayMeta.length ?? 0;

    // Determine the payload's logical element count. Accept any TypedArray
    // (Float32Array / Uint32Array / etc.) plus plain numeric arrays; an
    // undefined / missing payload is treated as a length-0 init. Bytes are
    // copied from the source's underlying ArrayBuffer when present.
    let payloadCount = 0;
    let payloadBytes: Uint8Array | null = null;
    if (raw !== null && raw !== undefined) {
      if (
        raw instanceof Float32Array ||
        raw instanceof Float64Array ||
        raw instanceof Int32Array ||
        raw instanceof Uint32Array ||
        raw instanceof Int16Array ||
        raw instanceof Uint16Array ||
        raw instanceof Int8Array ||
        raw instanceof Uint8Array
      ) {
        payloadCount = raw.length;
        payloadBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else if (Array.isArray(raw)) {
        payloadCount = raw.length;
        // Plain JS array: pack each element through the declared element
        // type's TypedArray constructor (`meta.viewCtor`) so the numeric
        // VALUE is encoded, not its integer bit pattern. Dispatching on
        // `viewCtor` (the type SSOT) rather than byte size is what keeps
        // `array<f32,N>` distinct from `array<u32,N>` -- both are 4 bytes,
        // so a size-keyed setter would store an f32 `1.0` as the u32 bits
        // `0x00000001` (reads back ~1.4e-45). The TypedArray then exposes
        // its little-endian bytes for the shared copy path below.
        if (payloadCount > 0 && meta.viewCtor !== undefined) {
          const typed = new meta.viewCtor(payloadCount);
          for (let i = 0; i < payloadCount; i++) {
            const val = raw[i];
            typed[i] = typeof val === 'number' ? val : 0;
          }
          payloadBytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
        }
      }
    }

    // Effective count for variable arrays = payload count; for fixed
    // arrays = schema-declared N (the payload's length is advisory — we
    // copy up to N elements and pad the rest with zero).
    const effectiveCount = isVariable ? payloadCount : fixedLength;

    // Fixed `array<T,N>` (feat-20260602): the column is an inline stride-N
    // view (`col.arity === N`), so write the payload bytes directly into the
    // row's stride window — no BufferPool slot, no slot-id store, no
    // prior-slot release. The byte window starts at `row * arity * elementBytes`
    // and spans N elements; payloads shorter than N copy a prefix and leave
    // the tail at its current value (spawn rows are zero-initialised by the
    // fresh column buffer; the swap-pop migration copies the whole block).
    if (!isVariable) {
      const arity = col.arity;
      const rowByteOffset = col.view.byteOffset + row * arity * elementBytes;
      const rowBytes = new Uint8Array(col.view.buffer, rowByteOffset, arity * elementBytes);
      const copyLen =
        payloadBytes === null ? 0 : Math.min(payloadBytes.byteLength, rowBytes.byteLength);
      if (copyLen > 0 && payloadBytes !== null) {
        rowBytes.set(payloadBytes.subarray(0, copyLen));
      }
      // Zero the tail past the copied prefix so a short / missing payload
      // matches the prior fresh-slot semantics (the old pool path always
      // alloc'd a zeroed slot, so unwritten elements read back as 0).
      if (copyLen < rowBytes.byteLength) {
        rowBytes.fill(0, copyLen);
      }
      // feat-20260614 M4 / D-3: `array<shared<T>,N>` element-level retain.
      // Walk the copied prefix as u32 handles and retain each non-sentinel
      // element. Caller releases priors via `releaseManagedFieldOnRow` on
      // the set path (D-3 calling convention); the spawn path's fresh row
      // is zero-initialised so no priors exist.
      if (metaKey === 'shared' && copyLen > 0) {
        this.retainSharedArrayElements(rowBytes, copyLen >>> 2);
      }
      return;
    }

    // Variable `array<T>`: prior-slot release lives at the caller (set path)
    // — D-3 calling convention. Spawn path's fresh rows carry stale swap-pop
    // debris which MUST NOT be released here.
    const byteLength = effectiveCount * elementBytes;
    const allocR = this.bufferPool.alloc(byteLength);
    if (!allocR.ok) {
      this.routeArrayError(
        {
          code: allocR.error.code,
          hint: allocR.error.hint,
          expected: allocR.error.expected,
          detail: allocR.error.detail,
        } as ManagedArrayErrorEnvelope,
        component.name,
        fieldName,
      );
      col.view[row] = 0;
      if (isVariable) {
        const countCol = fieldCols.get(arrayCountColumnName(fieldName));
        if (countCol !== undefined) countCol.view[row] = 0;
      }
      return;
    }
    const slot = allocR.value;
    if (payloadBytes !== null) {
      const copyLen = Math.min(payloadBytes.byteLength, slot.view.byteLength);
      slot.view.set(payloadBytes.subarray(0, copyLen));
    }
    col.view[row] = slot.id;
    if (isVariable) {
      const countCol = fieldCols.get(arrayCountColumnName(fieldName));
      /* istanbul ignore else -- count column allocated by createArchetype */
      if (countCol !== undefined) countCol.view[row] = effectiveCount;
    }
    // feat-20260614 M4 / D-3: variable `array<shared<T>>` element-level
    // retain. Walk the live element prefix (effectiveCount u32 handles) and
    // retain each non-sentinel handle. Prior elements were released by the
    // caller via `releaseManagedFieldOnRow` on the set path (D-3 calling
    // convention); the spawn path has no priors.
    if (metaKey === 'shared' && effectiveCount > 0) {
      this.retainSharedArrayElements(slot.view, effectiveCount);
    }
  }

  /**
   * Walk the first `count` u32 handles in `bytes` and call
   * `SharedRefStore.retain` on each non-sentinel slot id (feat-20260614 M4 /
   * D-3). Failures route via Layer 3 ErrorHandler so the write chain stays
   * total; charter explicit-failure boundary lets AI users see structured
   * `shared-ref-released` payloads when retaining a stale handle.
   *
   * Helper-internal -- only called from `writeArrayField`'s `'shared'` arm.
   */
  private retainSharedArrayElements(bytes: Uint8Array, count: number): void {
    const view = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    for (let i = 0; i < count; i++) {
      const raw = view[i];
      if (raw === undefined) continue;
      // R-14: route through the scalar SSOT helper so the `< BUILTIN_BASE`
      // short-circuit (builtin slots + sentinel 0) lives in exactly one place.
      this.retainSharedScalarHandle(raw, 'array<shared<T>>', 'element');
    }
  }

  /**
   * Walk the first `count` u32 handles in `bytes` and call
   * `SharedRefStore.release` on each non-sentinel slot id (feat-20260614 M4 /
   * D-3). Mirrors `retainSharedArrayElements`; called from
   * `releaseManagedFieldOnRow`'s array arm BEFORE the BufferPool slot is
   * released so the underlying bytes are still valid.
   */
  private releaseSharedArrayElements(bytes: Uint8Array, count: number): void {
    const view = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    for (let i = 0; i < count; i++) {
      const raw = view[i];
      if (raw === undefined) continue;
      // R-14: route through the scalar SSOT helper so the `< BUILTIN_BASE`
      // short-circuit (builtin slots + sentinel 0) lives in exactly one place.
      this.releaseSharedRefHandle(raw, 'array<shared<T>>', 'element');
    }
  }

  /**
   * Materialise a fresh `TypedArray` snapshot for an `array<T,N>` /
   * `array<T>` field at `row` (plan-strategy §2.2 -- read-only snapshot
   * contract; mutations route through `world.set` / `world.push` /
   * `world.pop`).
   *
   * **Transient view contract (feat-20260602):** for fixed `array<T,N>`
   * columns the returned `TypedArray` aliases the inline column buffer
   * directly (`col.view.subarray(row * arity, ...)`); for variable
   * `array<T>` columns it aliases the live `BufferPool` slot bytes
   * (zero-copy; `pool.view(slotId)` is the SSOT byte region). In both
   * cases the view is valid only until the next structural change. Writing
   * into the snapshot is undefined behaviour -- the contract is read-only
   * and the implementation may switch to a copy in the future without
   * breaking AI users who consume only `length` / index reads.
   *
   * For variable arrays the typed-array length matches the live count from
   * the sidecar `<fieldName>:count` column; for fixed arrays it matches the
   * schema-declared `N`. `entity` element fields surface as a `Uint32Array`
   * view (Entity packs slot+gen into u32).
   */
  private materializeArrayView(
    arch: Archetype,
    component: Component,
    row: number,
    fieldName: string,
    elementType: ManagedArrayElementType,
    fixedLength: number | undefined,
    slotId: number,
  ):
    | Float32Array
    | Float64Array
    | Int32Array
    | Uint32Array
    | Int16Array
    | Uint16Array
    | Int8Array
    | Uint8Array {
    const fieldCols = arch.columns.get(component.id);
    if (fixedLength !== undefined) {
      // Fixed `array<T,N>` (feat-20260602): the elements live INLINE in the
      // stride-N column. Reinterpret the row's byte window directly — no
      // BufferPool indirection (`slotId` is unused for fixed arrays).
      const col = fieldCols?.get(fieldName);
      /* istanbul ignore next -- caller validated the column exists */
      if (col === undefined) return reinterpretSlotBytes(new Uint8Array(0), elementType, 0);
      const elementBytes = elementByteSize(elementType);
      const arity = col.arity;
      const rowByteOffset = col.view.byteOffset + row * arity * elementBytes;
      const rowBytes = new Uint8Array(col.view.buffer, rowByteOffset, arity * elementBytes);
      return reinterpretSlotBytes(rowBytes, elementType, fixedLength);
    }
    const liveBytes = this.bufferPool.view(slotId);
    const countCol = fieldCols?.get(arrayCountColumnName(fieldName));
    const elementCount = (countCol?.view[row] as number | undefined) ?? 0;
    return reinterpretSlotBytes(liveBytes, elementType, elementCount);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — archetype migration
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Migrate an entity from srcArch to targetArch.
   * Copies all shared component data, then removes from src via swap-pop.
   *
   * AC-04 carry-over contract (M4): for every component that survives the
   * migration (i.e. the target archetype carries the same `compId`), every
   * field column's u32 value is copied verbatim from src to target. This
   * preserves every managed resource handle in place:
   *
   *   - `ref<T>` field   - the u32 (managed handle = (slot << 8) | gen) is
   *                        bit-equal across migrate, so `Object.is` on the
   *                        handle holds and `UniqueRefStore.resolve` returns
   *                        the same payload object reference (per-(slot, gen)
   *                        wrapper singleton, D-3).
   *   - `buffer<N>` field - fixed-capacity inline stride-N `u8` column
   *                          (feat-20260602): the N bytes are copied verbatim
   *                          by the generic per-column row copy, so the live
   *                          bytes survive byte-for-byte. No BufferPool slot
   *                          (only variable `buffer` carries a pool slot id).
   *   - `entity` field   - the u32 (encoded slot+gen) is bit-equal across
   *                        migrate.
   *   - `array<T,N>` field - fixed-capacity inline stride-N column
   *                          (feat-20260602): the N elements live contiguously
   *                          in the column row and are copied verbatim by the
   *                          generic per-column row copy, so they survive
   *                          byte-for-byte (no BufferPool slot). The TypedArray
   *                          snapshot is rematerialised on every `world.get`
   *                          (D-4 no cache); we do NOT guarantee `Object.is` on
   *                          the wrapper — only the underlying bytes (D-R7 weak
   *                          carry-over).
   *   - `array<T>` field   - dual u32 columns: primary slot id + sidecar
   *                          `<fieldName>:count`. Both columns are copied via
   *                          the generic per-column loop below, so count and
   *                          slot id stay in lock-step. Capacity is derived
   *                          from `BufferPool.view(slotId).byteLength /
   *                          elementBytes` and is therefore preserved by the
   *                          slot-id carry-over alone (no separate column).
   *
   * Negative invariant: this routine MUST NOT call UniqueRefStore.release /
   * BufferPool.release for surviving components. The pre-migrate release
   * loop lives at `removeComponent` (only for the component being removed)
   * and `despawn` (every component); migrate is only a column copy. The
   * array-field release-loop split (D-3 / D-5) further guarantees that
   * spawn into a vacated row treats stale slot-id debris as no-op (the slot
   * is owned by the migrated entity in the new archetype) — see
   * `writeArrayField`'s `operation: 'spawn' | 'set'` discriminant.
   * Tests: `__tests__/managed-carry-over.test.ts` (w16),
   * `__tests__/managed-array-carry-over.test.ts` (w8).
   */
  private migrateEntity(record: EntityRecord, srcArch: Archetype, targetArch: Archetype): void {
    const oldRow = record.row;
    // Read entity slot from id=0 self column (not a separate entities array).
    const selfCol = srcArch.columns.get(EntityComponent.id)?.get('self');
    const entitySlot = unpackSlot(selfCol?.view[oldRow] ?? 0);

    // Append a new row in the target archetype.
    const newRow = appendEntity(targetArch, entitySlot);

    // Copy shared component data.
    for (const [compId, srcFieldCols] of srcArch.columns) {
      const targetFieldCols = targetArch.columns.get(compId);
      if (!targetFieldCols) {
        continue; // Component was removed — skip.
      }
      for (const [fieldName, srcCol] of srcFieldCols) {
        const targetCol = targetFieldCols.get(fieldName);
        if (!targetCol) {
          continue;
        }
        // Copy the whole stride-N block per row. Scalar / variable / `:count`
        // columns have arity 1 (single-element copy, byte-identical to the
        // prior `view[newRow] = view[oldRow]` form); fixed inline
        // `array<T,N>` / `buffer<N>` columns carry their N elements inline and
        // must migrate the entire block (feat-20260602).
        const arity = srcCol.arity;
        targetCol.view.set(
          srcCol.view.subarray(oldRow * arity, oldRow * arity + arity),
          newRow * arity,
        );
      }
    }

    // Remove entity from source archetype via swap-pop.
    const swapResult = removeEntity(srcArch, oldRow);
    if (swapResult) {
      // Update the swapped entity's record.
      const swappedRecord = this.records[swapResult.movedEntity];
      if (swappedRecord) {
        swappedRecord.row = swapResult.newRow;
      }
    }

    // Update record to point to new archetype and row.
    record.archetypeId = targetArch.id;
    record.row = newRow;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Scene-nesting World API (feat-20260608-scene-nesting-ecs-fication M2 / w24)
  //
  // 8 new methods + 1 SceneAsset resolver hook. The SceneInstance ECS
  // component (defined in @forgeax/engine-runtime) is resolved here by name
  // string via `resolveComponent('SceneInstance')`, keeping engine-ecs
  // value-import-free of engine-runtime (AC-29 grep gate
  // `scripts/check-ecs-no-runtime-import.mjs`).
  //
  // The recursive cycle stack lives in `_instantiateSceneRec(handle, parent,
  // stack)`; the public `instantiateScene` constructs the empty stack so the
  // sugar layer never sees the recursion mechanics (D-3 / charter P1).
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Pluggable resolver: SceneAsset Handle -> child SceneAsset payload via the
   * mount.source integer index relative to the parent SceneAsset's refs[].
   * Wired by the runtime sugar (see `@forgeax/engine-runtime` AssetRegistry)
   * during `Engine.create`. Unit tests can wire one directly.
   *
   * The arg shape is `(source, parentHandle)` so the resolver can scope
   * the lookup to the parent; for `number` sources (at-rest refs[] index)
   * the resolver maps through parent.refs[]; for `string` sources (post-parse
   * / post-collect GUID) the resolver does identity lookup.
   *
   * Encapsulated by `private` keyword (no underscore prefix per
   * lint-naming.md: only package-internal `_xxx` needs `@internal`; `private`
   * fields must NOT start with `_`). Consumers go through `_setSceneAssetResolver` /
   * `_getSceneAssetResolver` (underscore-prefix + `@internal` JSDoc applies
   * to those public methods, not to this storage field). The resolver is
   * auto-wired by `@forgeax/engine-runtime`'s `AssetRegistry.instantiate`
   * so AI users normally never touch it.
   */
  private sceneAssetResolver:
    | ((
        source: number | string,
        parentHandle: Handle<'SceneAsset', 'shared'>,
      ) => Result<Handle<'SceneAsset', 'shared'>, unknown>)
    | null = null;

  /**
   * @internal Wire the SceneAsset resolver. Called by
   * `@forgeax/engine-runtime` during `Engine.create` so
   * `world.instantiateScene(handle)` can lift child SceneAsset handles
   * through `mount.source -> parent.refs[source]` without ECS depending
   * on runtime. AI users using `engine.assets.instantiate(...)` get this
   * wired automatically; only unit tests and engine-internal sugar call
   * it directly.
   */
  _setSceneAssetResolver(
    resolver: (
      source: number | string,
      parentHandle: Handle<'SceneAsset', 'shared'>,
    ) => Result<Handle<'SceneAsset', 'shared'>, unknown>,
  ): void {
    this.sceneAssetResolver = resolver;
  }

  /** @internal Read the wired SceneAsset resolver (or null when no runtime is attached). */
  _getSceneAssetResolver(): typeof this.sceneAssetResolver {
    return this.sceneAssetResolver;
  }

  /**
   * Materialise a SceneAsset (and any nested SceneAsset references via
   * `mounts[]`) into live entities. Returns the synthetic root Entity that
   * carries the `SceneInstance` ECS component (charter P4: instance ==
   * entity-with-SceneInstance).
   *
   * Recursion path is closed inside `_instantiateSceneRec(handle, parent,
   * stack)` (D-3); cycle detection is fail-fast `pack-cyclic-reference +
   * detail.kind:'mount-asset'` (D-1 mirror, plan-strategy §D-3). The
   * caller-supplied `parent` flows to the synthetic root's `ChildOf` so the
   * full sub-tree attaches under the AI user's host entity.
   *
   * @example
   *   const r = world.instantiateScene(handle);
   *   if (!r.ok) return r;
   *   const { root, diagnostics } = r.value;
   *   for (const d of diagnostics) // C-R2: unknown-field records, non-fatal
   *     console.warn(`unknown field ${d.component}.${d.field} on localId ${d.localId}`);
   *   const inst = world.get(root, SceneInstance).value;
   *   const member = inst.mapping[0]; // first member entity
   */
  instantiateScene(
    handle: Handle<'SceneAsset', 'shared'>,
    parent?: EntityHandle,
  ): Result<SceneInstantiateOk, EcsError> {
    const stack = new Set<number>();
    // C-R2: collect non-fatal unknown-field diagnostics across this scene and
    // every recursively mounted sub-scene. The internal recursion writes into
    // this accumulator; only the public entry packages it onto the success value.
    const diagnostics: SceneInstantiateDiagnostic[] = [];
    const r = this._instantiateSceneRec(handle, parent, stack, diagnostics);
    if (!r.ok) return r;
    return ok({ root: r.value, diagnostics });
  }

  /**
   * Materialise a SceneAsset FLAT — the "edit the scene itself" primitive.
   * Unlike `instantiateScene`, this mints NO synthetic SceneInstance root and
   * forces NO `ChildOf` onto top-level members: the scene's own entities become
   * plain top-level world entities whose hierarchy is exactly their authored
   * `ChildOf` (an entity with no `ChildOf` is a root). Use this to OPEN a scene
   * for editing; use `instantiateScene` (anchor) at runtime / for nested
   * prefabs where an instance boundary + override isolation is wanted.
   *
   * Nested prefabs referenced via `mounts[]` STILL materialise as their own
   * SceneInstance anchors (charter P4 preserved) — only THIS top scene is flat.
   *
   * @example
   *   const r = world.instantiateSceneFlat(handle);
   *   if (!r.ok) return r;
   *   const { roots, diagnostics } = r.value; // roots = top-level handles
   */
  instantiateSceneFlat(
    handle: Handle<'SceneAsset', 'shared'>,
  ): Result<SceneInstantiateFlatOk, EcsError> {
    const stack = new Set<number>();
    const diagnostics: SceneInstantiateDiagnostic[] = [];
    const handleKey = unwrapHandle(handle);
    const resolved = this._resolveSceneAsset(handle);
    if (!resolved.ok) return resolved;
    stack.add(handleKey);
    let r: Result<EntityHandle[], EcsError>;
    try {
      r = this._instantiateSceneAssetFlat(handle, resolved.value, stack, diagnostics);
    } finally {
      stack.delete(handleKey);
    }
    if (!r.ok) return r;
    return ok({ roots: r.value, diagnostics });
  }

  /**
   * @internal Recursive helper carrying the cycle-detection stack. Sugar /
   * other public callers must not see this mechanic — use `instantiateScene`
   * (D-3 / charter P1).
   */
  _instantiateSceneRec(
    handle: Handle<'SceneAsset', 'shared'>,
    parent: EntityHandle | undefined,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle, EcsError> {
    const handleKey = unwrapHandle(handle);
    if (stack.has(handleKey)) {
      const cycleArr: string[] = [];
      for (const k of stack) cycleArr.push(String(k));
      cycleArr.push(String(handleKey));
      const detail: PackErrorDetail = {
        code: 'pack-cyclic-reference',
        kind: 'mount-asset',
        cycle: cycleArr,
      };
      return err({
        code: 'pack-cyclic-reference' as PackErrorCode,
        expected: 'acyclic SceneAsset mount graph',
        hint: PACK_ERROR_HINTS['pack-cyclic-reference'],
        detail,
      } as unknown as EcsError);
    }
    const resolved = this._resolveSceneAsset(handle);
    if (!resolved.ok) return resolved;
    const asset = resolved.value;
    stack.add(handleKey);
    try {
      return this._instantiateSceneAsset(handle, asset, parent, stack, diagnostics);
    } finally {
      stack.delete(handleKey);
    }
  }

  /**
   * @internal Resolve a SceneAsset handle through the SharedRefStore.
   * The handle u32 is the SharedRefStore slot id (`world.allocSharedRef
   * ('SceneAsset', asset)` is the producer; rc starts at 1, the SceneInstance
   * spawn retains to rc=2 in M4 / w13). Errors propagate as EcsError so the
   * instantiateScene chain returns a single closed union.
   */
  _resolveSceneAsset(handle: Handle<'SceneAsset', 'shared'>): Result<SceneAsset, EcsError> {
    const r = this.sharedRefs.resolve(handle);
    if (!r.ok) {
      return err(r.error as unknown as EcsError);
    }
    return ok(r.value as SceneAsset);
  }

  /**
   * @internal Spawn one SceneAsset's members — the shared body of both scene
   * finishers. Recurses into `mounts[]` (each nested prefab becomes its own
   * SceneInstance anchor), spawns `entities[]` honouring their authored
   * `ChildOf`, and wires deferred owned-parent mount edges. Does NOT create a
   * synthetic root or force any `ChildOf` — that is the caller's (finisher's)
   * job. `_instantiateSceneRec` owns cycle bookkeeping.
   */
  _spawnSceneMembers(
    handle: Handle<'SceneAsset', 'shared'>,
    asset: SceneAsset,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<SceneMembersSpawn, EcsError> {
    const sceneInstanceToken = resolveComponent('SceneInstance');
    if (sceneInstanceToken === undefined) {
      return err(new ComponentNotDefinedError('SceneInstance'));
    }
    const childOfToken = resolveComponent('ChildOf');
    // ChildOf is optional — only needed if the asset declares ChildOf or a
    // caller-supplied parent must be wired. If absent and we need it, we
    // fail-fast at the wiring site below.

    const ownEntities = asset.entities;
    const ownMounts = asset.mounts ?? [];
    const memberSum = ownMounts.reduce((s, m) => s + m.memberCount, 0);
    const countBaseline = ownEntities.length + ownMounts.length + memberSum;
    // C-R1 (studio-issues #6): mapping table must be sized to maxLocalId+1,
    // not to the entity count. An editor scene may have non-contiguous
    // localIds (deleted entities leave gaps); sizing to count means any
    // localId >= count is a silent Uint32Array OOB no-op -> entity spawns
    // but is unreachable by localId -> users report "character can't move".
    // Take the max of count-baseline and id-range so both packed and
    // sparse scenes work without over-allocation in the common case.
    let maxLocalId = ownEntities.reduce((m, e) => Math.max(m, e.localId as unknown as number), -1);
    for (const mount of ownMounts) {
      maxLocalId = Math.max(maxLocalId, mount.localId as unknown as number);
      const last = (mount.memberFirst as unknown as number) + mount.memberCount - 1;
      maxLocalId = Math.max(maxLocalId, last);
    }
    const totalSlots = Math.max(countBaseline, maxLocalId + 1);

    // R2/Bonus: namespace-overlap fail-fast (AC-05 /
    // pack-mount-localid-overlap). Each LocalEntityId in
    // [0, totalSlots) must be claimed by exactly one of:
    //   - entities[i].localId
    //   - mounts[i].localId
    //   - mounts[i] window slot (memberFirst .. memberFirst+memberCount-1)
    // Overlap or duplicate claim => fail-fast with the offending localIds
    // and human-readable origin labels.
    {
      const claims = new Map<number, string>();
      const overlapLids = new Set<number>();
      const overlapSources: string[] = [];
      const claim = (lid: number, src: string): void => {
        const prior = claims.get(lid);
        if (prior !== undefined) {
          if (!overlapLids.has(lid)) {
            overlapLids.add(lid);
            overlapSources.push(prior);
            overlapSources.push(src);
          } else {
            overlapSources.push(src);
          }
          return;
        }
        claims.set(lid, src);
      };
      for (const ent of ownEntities) {
        claim(ent.localId as unknown as number, `entities[${ent.localId as unknown as number}]`);
      }
      for (const mount of ownMounts) {
        const mLid = mount.localId as unknown as number;
        claim(mLid, `mount[${mLid}]`);
        const first = mount.memberFirst as unknown as number;
        for (let k = 0; k < mount.memberCount; k += 1) {
          claim(first + k, `mount[${mLid}].member[${k}]`);
        }
      }
      if (overlapLids.size > 0) {
        const overlapping = Array.from(overlapLids).sort((a, b) => a - b);
        return err({
          code: 'pack-mount-localid-overlap' as PackErrorCode,
          expected: 'each LocalEntityId claimed by exactly one entity or mount slot',
          hint: PACK_ERROR_HINTS['pack-mount-localid-overlap'],
          detail: {
            code: 'pack-mount-localid-overlap',
            overlapping,
            sources: overlapSources,
          } as PackErrorDetail,
        } as unknown as EcsError);
      }
    }

    // Slot table: indexed by LocalEntityId; populated as entities / mounts /
    // members are spawned. mapping[localId] = encoded Entity u32. Unspawned
    // slots hold ENTITY_NULL_RAW (0xffffffff) — NOT 0, because a fresh World's
    // first spawn encodes to gen=0+idx=0=raw 0, which is a valid Entity. The
    // remap path in `_buildSceneEntityComponentDatas` distinguishes the two
    // (live=ENTITY_NULL_RAW => parent unspawned at remap time => surface as
    // null sentinel; live=any other u32 => valid live Entity, including 0).
    const mapping = new Uint32Array(totalSlots).fill(ENTITY_NULL_RAW);
    const entityToLocalId = new Map<EntityHandle, LocalEntityId>();
    const rootEntities: EntityHandle[] = [];
    // R2/B-1: mount entities whose `mount.parent === undefined` need their
    // ChildOf wired to the outer synthetic root (this scene's root). Step 5
    // does the wiring once the synthetic root entity is materialised; we
    // collect them here in step 1.
    const mountEntitiesNeedingRootParent: EntityHandle[] = [];
    // D-8 (feat-20260707): mount entities whose `mount.parent` points at an
    // OWNED entity slot are wired AFTER step 2 spawns the owned entities —
    // mounts are processed first (step 1), so the owned parent slot is still
    // ENTITY_NULL_RAW at mount-processing time. Same deferred-wiring shape as
    // mountEntitiesNeedingRootParent: register [mountEntity, parentSlot] here,
    // wire ChildOf once the slot is live. Without this the edge was silently
    // dropped, and the mount carrier stayed unreachable from its owned parent.
    const mountEntitiesNeedingDeferredParent: Array<[EntityHandle, number]> = [];

    // 1. Recurse into mounts[] FIRST so the mount-window slots
    //    (`mount.localId` + `[memberFirst, memberFirst+memberCount)`) are
    //    populated before any owned entity tries to remap a LocalEntityId
    //    pointing into the mount window (AC-24 cross-boundary reference).
    for (const mount of ownMounts) {
      // R2/B-3 + R2/B-4: validate overrides BEFORE child resolution so a
      // malformed override fails fast without observable side-effects.
      const overrideValidationRes = this._validateMountOverrides(mount);
      if (!overrideValidationRes.ok) {
        return overrideValidationRes;
      }

      // Spawn the mount entity (carries mount.components).
      const mountLid = mount.localId as unknown as number;
      const mountSpawnRes = this._spawnMountEntity(mount, mapping, diagnostics);
      if (!mountSpawnRes.ok) return mountSpawnRes;
      const mountEntity = mountSpawnRes.value;
      mapping[mountLid] = mountEntity as unknown as number;

      // Resolve mount.source -> child SceneAsset handle.
      const childHandleRes = this._resolveMountSource(mount.source, handle);
      if (!childHandleRes.ok) return childHandleRes;
      const childHandle = childHandleRes.value;

      // Recursively instantiate the child. Its synthetic root attaches as a
      // child of the mount entity. The child writes its own unknown-field
      // diagnostics into the SAME accumulator, so they bubble to the top-level
      // instantiateScene result (C-R2 recursive aggregation).
      const childRes = this._instantiateSceneRec(childHandle, mountEntity, stack, diagnostics);
      if (!childRes.ok) return childRes;

      // R2/B-2: cross-check mount.memberCount === child.totalSlots BEFORE
      // copying the mount window. The child SceneInstance.mapping length is
      // the authoritative `totalSlots` of the child. AC-04 / requirements
      // S-5 mandate fail-fast at runtime for this disagreement.
      const childInstRes = this.get(childRes.value, sceneInstanceToken);
      if (!childInstRes.ok) return childInstRes;
      const childMapping = (childInstRes.value as unknown as { mapping: Uint32Array }).mapping;
      if (childMapping.length !== mount.memberCount) {
        return err({
          code: 'pack-mount-count-mismatch' as PackErrorCode,
          expected: 'mount.memberCount === child SceneAsset totalSlots',
          hint: PACK_ERROR_HINTS['pack-mount-count-mismatch'],
          detail: {
            code: 'pack-mount-count-mismatch',
            mountLocalId: mountLid,
            declared: mount.memberCount,
            actual: childMapping.length,
          } as PackErrorDetail,
        } as unknown as EcsError);
      }

      // Pull the child's mapping into our parent window. Default unset slots
      // to ENTITY_NULL_RAW so downstream "live" checks distinguish them from
      // the first Entity (gen=0+idx=0 encodes to raw u32 0).
      const window = mount.memberCount;
      for (let k = 0; k < window; k += 1) {
        mapping[(mount.memberFirst as unknown as number) + k] = childMapping[k] ?? ENTITY_NULL_RAW;
      }

      // Apply mount.overrides at instantiate-time (AC-19).
      // Each override.localId addresses a slot in *this* (parent) namespace
      // (R2/F-8 cement: parent-namespace + memberFirst+offset addressing).
      // The state map will be populated below with these overrides — but we
      // must also write the value through to the live entity column so the
      // readback invariant holds.
      // Mount-entity itself never has children attached by the caller other
      // than via the recursive child; nothing else to wire here.
      if (childOfToken !== undefined) {
        if (mount.parent !== undefined) {
          // Reparent the mount-entity ChildOf to the caller-specified parent.
          const parentSlot = mount.parent as unknown as number;
          const parentEntity = mapping[parentSlot];
          if (parentEntity !== undefined && parentEntity !== ENTITY_NULL_RAW) {
            const r = this.addComponent(mountEntity, {
              component: childOfToken,
              data: { parent: parentEntity } as never,
            });
            if (!r.ok) {
              // ChildOf may already be present from layer-1; reparent via set.
              const set = this.set(mountEntity, childOfToken, {
                parent: parentEntity,
              } as never);
              if (!set.ok) return set as Result<SceneMembersSpawn, EcsError>;
            }
          } else {
            // D-8: the owned parent slot is not spawned yet (owned entities
            // spawn in step 2, after this mount loop). Defer the ChildOf wire
            // to step 2's tail once mapping[parentSlot] is live.
            mountEntitiesNeedingDeferredParent.push([mountEntity, parentSlot]);
          }
        } else {
          // R2/B-1: default semantic — mount.parent === undefined wires the
          // mount entity ChildOf to *this* scene's synthetic root (created
          // in step 3 below). Defer the actual wire to step 5 after the
          // synthetic root spawn; record the mount entity here.
          mountEntitiesNeedingRootParent.push(mountEntity);
        }
      }
    }

    // 2. Spawn entities[] entities. Topo-sort by ChildOf so parents are
    //    spawned before children (so localId remap can read mapping live).
    //    This runs AFTER mount processing (step 1) so cross-boundary
    //    `ChildOf {parent: <mount-window-localId>}` references resolve
    //    correctly (AC-24).
    const order = sceneTopoSort(ownEntities);
    for (const idx of order) {
      const node = ownEntities[idx];
      if (node === undefined) continue;
      const lid = node.localId as unknown as number;
      const compDataRes = this._buildSceneEntityComponentDatas(node, mapping, diagnostics);
      if (!compDataRes.ok) return compDataRes;
      const sp = (this.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(
        ...compDataRes.value,
      );
      if (!sp.ok) return sp as Result<SceneMembersSpawn, EcsError>;
      const e = sp.value;
      mapping[lid] = e as unknown as number;
      entityToLocalId.set(e, lid as unknown as LocalEntityId);
      if (node.components.ChildOf === undefined) {
        rootEntities.push(e);
      }
    }

    // 2b. D-8 (feat-20260707): wire deferred owned-parent mount ChildOf edges.
    //     Owned entities are now live (step 2 above), so mapping[parentSlot]
    //     resolves. Same shape as the mountEntitiesNeedingRootParent wiring in
    //     step 5. The relationship mirror hook (relationshipOnInsert) pushes the
    //     carrier into the owned parent's Children mirror automatically.
    if (childOfToken !== undefined) {
      for (const [mountEntity, parentSlot] of mountEntitiesNeedingDeferredParent) {
        const parentEntity = mapping[parentSlot];
        if (parentEntity === undefined || parentEntity === ENTITY_NULL_RAW) continue;
        const set = this.set(mountEntity, childOfToken, { parent: parentEntity } as never);
        if (!set.ok) {
          const r = this.addComponent(mountEntity, {
            component: childOfToken,
            data: { parent: parentEntity } as never,
          });
          if (!r.ok) return r as Result<SceneMembersSpawn, EcsError>;
        }
      }
    }

    return ok({
      mapping,
      entityToLocalId,
      rootEntities,
      mountEntitiesNeedingRootParent,
      totalSlots,
    });
  }

  /**
   * @internal Spawn one SceneAsset's entities + apply mounts recursively, then
   * wrap them in a synthetic SceneInstance root (the anchor). This is the
   * runtime / Play / nested-mount finisher (charter P4: instance ==
   * entity-with-SceneInstance). Caller (`_instantiateSceneRec`) owns cycle
   * bookkeeping.
   */
  _instantiateSceneAsset(
    handle: Handle<'SceneAsset', 'shared'>,
    asset: SceneAsset,
    parent: EntityHandle | undefined,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle, EcsError> {
    const sceneInstanceToken = resolveComponent('SceneInstance');
    if (sceneInstanceToken === undefined) {
      return err(new ComponentNotDefinedError('SceneInstance'));
    }
    const childOfToken = resolveComponent('ChildOf');

    const membersRes = this._spawnSceneMembers(handle, asset, stack, diagnostics);
    if (!membersRes.ok) return membersRes;
    const { mapping, entityToLocalId, rootEntities, mountEntitiesNeedingRootParent, totalSlots } =
      membersRes.value;
    const ownMounts = asset.mounts ?? [];

    // 3. Spawn the synthetic root entity carrying SceneInstance.
    //    First alloc the state ref so the SceneInstance.state column has a
    //    live u32; then attach SceneInstance to a fresh entity.
    const stateRef = this.uniqueRefs.alloc<'SceneInstanceState'>('SceneInstanceState', null, () => {
      // released by despawn / despawnScene; no caller-side cleanup needed
    });
    // Spawn the root with SceneInstance component, mapping snapshot, and
    // state ref. The mapping is a Uint32Array (array<entity> field shape).
    // Convert mapping Uint32Array to plain number[] for spawn write — the
    // ECS array<entity> arm copies element-by-element and accepts both, but
    // the plain-array form sidesteps a Uint32Array.length=0 corner case
    // observed during M2 testing where a non-empty Uint32Array was written
    // as if empty (suspect: archetype write-array dispatch on instanceof
    // Array vs TypedArray).
    const mappingPlain: number[] = Array.from(mapping);
    // The synthetic root is the ChildOf parent of every owned root entity
    // (step 5 below) and may itself become a ChildOf parent of a caller-
    // supplied `parent` chain. propagateTransforms walks ChildOf parents
    // through the Transform liveMap and treats a parent missing Transform
    // as `hierarchy-broken`, so the synthetic root must carry Transform
    // (identity TRS via layer-2 defaults) when Transform is defined.
    const rootComponents: ComponentData[] = [
      {
        component: sceneInstanceToken,
        data: {
          source: handle,
          mapping: mappingPlain,
          state: stateRef,
        } as never,
      },
    ];
    const transformToken = resolveComponent('Transform');
    if (transformToken !== undefined) {
      rootComponents.push({
        component: transformToken,
        data: {} as never,
      });
    }
    const rootSpawn = (this.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(
      ...rootComponents,
    );
    if (!rootSpawn.ok) {
      this.uniqueRefs.release(stateRef);
      return rootSpawn;
    }
    const rootEntity = rootSpawn.value;

    // 4. Build SceneInstanceState payload + register it in the UniqueRefStore
    //    under the same handle. We use the public `_setUniqueRefPayload`
    //    helper (added below) so the alloc -> populate sequence stays atomic.
    const overrides = new Map<LocalEntityId, Map<string, MountOverride>>();
    for (const mount of ownMounts) {
      for (const ov of mount.overrides ?? []) {
        const lid = ov.localId as unknown as LocalEntityId;
        let fieldMap = overrides.get(lid);
        if (fieldMap === undefined) {
          fieldMap = new Map();
          overrides.set(lid, fieldMap);
        }
        fieldMap.set(`${ov.comp}:${ov.field}`, ov);
        // Apply override to the live member entity column.
        const memberEntityRaw = mapping[lid as unknown as number];
        if (memberEntityRaw !== undefined && memberEntityRaw !== ENTITY_NULL_RAW) {
          const memberEntity = memberEntityRaw as unknown as EntityHandle;
          const ovToken = resolveComponent(ov.comp);
          if (ovToken !== undefined) {
            const setRes = this.set(memberEntity, ovToken, {
              [ov.field]: ov.value,
            } as never);
            if (!setRes.ok) {
              this.uniqueRefs.release(stateRef);
              return setRes as Result<EntityHandle, EcsError>;
            }
          }
        }
      }
    }

    const detached = new Set<LocalEntityId>();
    const state: Record<string, unknown> = {
      source: handle,
      entityToLocalId,
      detachedLocalIds: detached,
      // Convert overrides Map<LocalEntityId, Map<string, MountOverride>>
      // into Map<LocalEntityId, Map<string, SceneInstanceOverrideRecord>>
      overrides: this._mountOverridesToStateMap(overrides),
      rootEntities,
      totalSlots,
      mountTimeOverrides: ownMounts.flatMap((m) => m.overrides ?? []),
    };
    // Stuff the state into the UniqueRefStore under the existing slot. We
    // re-use the slot we allocated above by writing directly into the
    // payloads map via a `_setUniqueRefPayload` shim.
    this._setUniqueRefPayload(stateRef, state);

    // 5. Wire ChildOf for every owned root entity (no ChildOf at layer-1)
    //    to the synthetic root.
    if (childOfToken !== undefined) {
      for (const rootE of rootEntities) {
        const has = this.get(rootE, childOfToken);
        if (!has.ok) {
          // No ChildOf yet — attach to synthetic root.
          const r = this.addComponent(rootE, {
            component: childOfToken,
            data: { parent: rootEntity } as never,
          });
          if (!r.ok) return r as Result<EntityHandle, EcsError>;
        }
      }
      // R2/B-1: wire mount entities with default `mount.parent === undefined`
      // to this scene's synthetic root. _spawnMountEntity may have attached a
      // placeholder ChildOf {parent: ENTITY_NULL_RAW} when mount.components
      // was empty; overwrite via set so the ChildOf chain meshRenderer ->
      // childSyntheticRoot -> mountEntity -> outerSyntheticRoot resolves
      // through Transform-bearing parents (AC-16 / requirements S-7).
      for (const mountE of mountEntitiesNeedingRootParent) {
        const set = this.set(mountE, childOfToken, { parent: rootEntity } as never);
        if (!set.ok) {
          const r = this.addComponent(mountE, {
            component: childOfToken,
            data: { parent: rootEntity } as never,
          });
          if (!r.ok) return r as Result<EntityHandle, EcsError>;
        }
      }
      // Caller-supplied parent: synthetic root's ChildOf -> parent.
      if (parent !== undefined) {
        const r = this.addComponent(rootEntity, {
          component: childOfToken,
          data: { parent } as never,
        });
        if (!r.ok) return r as Result<EntityHandle, EcsError>;
      }
    }

    return ok(rootEntity);
  }

  /**
   * @internal Flat finisher — spawn one SceneAsset's members WITHOUT wrapping
   * them in a synthetic SceneInstance root and WITHOUT forcing `ChildOf` onto
   * top-level members. Used for "opening a scene to edit": the scene's own
   * entities become plain top-level world entities whose hierarchy is exactly
   * their authored `ChildOf`. Nested prefabs inside still materialise as their
   * own SceneInstance anchors (the mount recursion in `_spawnSceneMembers` is
   * always anchored). Returns the top-level handles (own rootless entities +
   * top-level mount carriers).
   */
  _instantiateSceneAssetFlat(
    handle: Handle<'SceneAsset', 'shared'>,
    asset: SceneAsset,
    stack: Set<number>,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle[], EcsError> {
    const membersRes = this._spawnSceneMembers(handle, asset, stack, diagnostics);
    if (!membersRes.ok) return membersRes;
    const { mapping, rootEntities, mountEntitiesNeedingRootParent } = membersRes.value;
    const childOfToken = resolveComponent('ChildOf');
    const ownMounts = asset.mounts ?? [];

    // Apply mount-time overrides through to the live member entity columns so a
    // hand-authored pack's `mounts[].overrides` still take visual effect. There
    // is no parent SceneInstanceState to record them in (flat = no anchor for
    // THIS scene); the nested prefab keeps its OWN anchor for round-trip.
    for (const mount of ownMounts) {
      for (const ov of mount.overrides ?? []) {
        const memberEntityRaw = mapping[ov.localId as unknown as number];
        if (memberEntityRaw !== undefined && memberEntityRaw !== ENTITY_NULL_RAW) {
          const ovToken = resolveComponent(ov.comp);
          if (ovToken !== undefined) {
            const setRes = this.set(memberEntityRaw as unknown as EntityHandle, ovToken, {
              [ov.field]: ov.value,
            } as never);
            if (!setRes.ok) return setRes as Result<EntityHandle[], EcsError>;
          }
        }
      }
    }

    // Default-parented mount carriers (`mount.parent === undefined`) would, in
    // anchor mode, attach to the synthetic root. Flat mode has none, so they
    // stay top-level. `_spawnMountEntity` may have left a placeholder
    // `ChildOf {parent: ENTITY_NULL_RAW}` (rare: mount with no components AND
    // Transform unregistered) — strip it so the carrier is a genuine root.
    if (childOfToken !== undefined) {
      for (const mountE of mountEntitiesNeedingRootParent) {
        const co = this.get(mountE, childOfToken);
        if (co.ok && (co.value as { parent: number }).parent === ENTITY_NULL_RAW) {
          this._removeComponentCore(mountE, childOfToken, false);
        }
      }
    }

    return ok([...rootEntities, ...mountEntitiesNeedingRootParent]);
  }

  /** @internal Build ComponentData[] for one SceneEntity, remapping localIds.
   *
   * C-R2 (feat-20260622-s5 M6): unknown fields on a SceneAsset payload are NOT
   * fatal. Unlike `world.spawn` (an explicit API call where a typo is a
   * programming error -> `SpawnDataUnknownFieldError`), scene data is loader-fed
   * and may carry a stale / deprecated / typo'd field. The remap below builds a
   * fresh `remappedRaw` and simply SKIPS keys absent from the schema (no input
   * mutation — the source `raw` is never deleted-from), recording each skipped
   * key as a non-fatal `SceneInstantiateDiagnostic` into the passed accumulator.
   * All known fields still write through, so one bad field cannot blank the
   * entity or the scene (C-AC-02/03/04).
   */
  _buildSceneEntityComponentDatas(
    node: import('@forgeax/engine-types').SceneEntity,
    mapping: Uint32Array,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<ComponentData[], EcsError> {
    const out: ComponentData[] = [];
    const nodeLocalId = node.localId as unknown as number;
    for (const compName of Object.keys(node.components)) {
      const token = resolveComponent(compName);
      if (token === undefined) {
        return err(new ComponentNotDefinedError(compName));
      }
      const raw = node.components[compName] ?? {};
      const schema = token.schema as Record<string, string>;
      const remappedRaw: Record<string, unknown> = {};
      for (const fieldName of Object.keys(raw)) {
        const fieldType = schema[fieldName];
        // C-R2: unknown key -> skip (do not copy into remappedRaw, do not
        // mutate the source `raw`) and record a structured diagnostic. The
        // downstream `spawn` only sees schema-valid keys, so its own
        // validateComponentDataKeys gate stays green.
        if (fieldType === undefined) {
          diagnostics.push({ component: compName, field: fieldName, localId: nodeLocalId });
          continue;
        }
        const value = (raw as Record<string, unknown>)[fieldName];
        if (fieldType === 'entity' && typeof value === 'number') {
          // localId -> live Entity. Slots not yet spawned hold ENTITY_NULL_RAW
          // (mapping init in _instantiateSceneAsset). Comparing to 0 here
          // would mis-treat the first Entity (gen=0+idx=0=raw 0) as missing.
          const live = mapping[value];
          remappedRaw[fieldName] =
            live === undefined || live === ENTITY_NULL_RAW ? ENTITY_NULL_RAW : live;
        } else if (fieldType === 'array<entity>' && Array.isArray(value)) {
          const arr: number[] = [];
          for (const v of value) {
            if (typeof v === 'number') {
              const live = mapping[v];
              arr.push(
                live === undefined || live === ENTITY_NULL_RAW ? (ENTITY_NULL_RAW as number) : live,
              );
            } else {
              arr.push(v as number);
            }
          }
          remappedRaw[fieldName] = arr;
        } else {
          remappedRaw[fieldName] = value;
        }
      }
      const filled = fillComponentDefaults(token, remappedRaw);
      out.push({ component: token, data: filled as never });
    }
    return ok(out);
  }

  /**
   * @internal R2/B-3 + R2/B-4: validate `mount.overrides[]` BEFORE any
   * spawn so a malformed override fails fast with no observable side
   * effects (charter P3 explicit-failure). Two checks:
   *
   * 1. `override.localId` must address a slot inside the parent-namespace
   *    member window `[memberFirst, memberFirst + memberCount)` (AC-06).
   * 2. `override.field` must exist in the resolved component schema
   *    (AC-07). When the component is unregistered we cannot validate the
   *    field shape; let the existing fall-through path proceed (the
   *    `resolveComponent` guard inside the override-application loop
   *    will skip the write).
   */
  _validateMountOverrides(mount: SceneInstanceMount): Result<void, EcsError> {
    const overrides = mount.overrides;
    if (overrides === undefined) return ok(undefined);
    const memberFirst = mount.memberFirst as unknown as number;
    const memberCount = mount.memberCount;
    const memberLast = memberFirst + memberCount;
    const mountLid = mount.localId as unknown as number;
    for (const ov of overrides) {
      const ovLid = ov.localId as unknown as number;
      // R2/B-3: parent-namespace check — override.localId must lie in the
      // member window [memberFirst, memberFirst + memberCount).
      if (ovLid < memberFirst || ovLid >= memberLast) {
        return err({
          code: 'pack-mount-override-localid-out-of-range' as PackErrorCode,
          expected: `override.localId in [${memberFirst}, ${memberLast})`,
          hint: PACK_ERROR_HINTS['pack-mount-override-localid-out-of-range'],
          detail: {
            code: 'pack-mount-override-localid-out-of-range',
            overrideLocalId: ovLid,
            mountLocalId: mountLid,
            memberCount,
          } as PackErrorDetail,
        } as unknown as EcsError);
      }
      // R2/B-4: field schema check — component must be defined and the
      // override.field must exist in its schema.
      const ovToken = resolveComponent(ov.comp);
      if (ovToken !== undefined) {
        const schema = ovToken.schema as Record<string, unknown>;
        if (!(ov.field in schema)) {
          return err({
            code: 'pack-mount-override-unknown-field' as PackErrorCode,
            expected: `override.field defined on component '${ov.comp}'`,
            hint: PACK_ERROR_HINTS['pack-mount-override-unknown-field'],
            detail: {
              code: 'pack-mount-override-unknown-field',
              comp: ov.comp,
              field: ov.field,
              mountLocalId: mountLid,
            } as PackErrorDetail,
          } as unknown as EcsError);
        }
      }
    }
    return ok(undefined);
  }

  /** @internal Spawn the mount-entity slot carrying mount.components (if any).
   *
   * R2/B-1: the mount entity is a structural intermediate in the ChildOf
   * chain `cube -> innerSyntheticRoot -> mountEntity -> outerSyntheticRoot`,
   * so it MUST carry Transform whenever Transform is registered (mirrors
   * the D-V-0 synthetic-root invariant). Otherwise propagateTransforms
   * walking the chain hits a Transform-less parent and emits per-frame
   * `RhiError(hierarchy-broken)` (verify R1 root cause of the
   * hello-scene-nesting demo black frames).
   */
  _spawnMountEntity(
    mount: SceneInstanceMount,
    mapping: Uint32Array,
    diagnostics: SceneInstantiateDiagnostic[],
  ): Result<EntityHandle, EcsError> {
    const fakeNode: import('@forgeax/engine-types').SceneEntity = {
      localId: mount.localId,
      components: mount.components ?? {},
    };
    const cdRes = this._buildSceneEntityComponentDatas(fakeNode, mapping, diagnostics);
    if (!cdRes.ok) return cdRes;
    // R2/B-1: ensure Transform is attached so propagateTransforms can walk
    // through this entity. Layer-2 defaults supply identity TRS; the
    // mount.components overlay (when present and including Transform) takes
    // precedence and is already in cdRes.value.
    const transformToken = resolveComponent('Transform');
    if (transformToken !== undefined) {
      const hasTransform = cdRes.value.some((c) => c.component === transformToken);
      if (!hasTransform) {
        cdRes.value.push({ component: transformToken, data: {} as never });
      }
    }
    if (cdRes.value.length === 0) {
      // Mount has no components AND Transform is unregistered (rare unit-
      // test path). Fall back to the placeholder ChildOf so the spawn has
      // a real archetype. Step 5 overwrites this placeholder.
      const childOfToken = resolveComponent('ChildOf');
      if (childOfToken === undefined) {
        return err(new ComponentNotDefinedError('ChildOf'));
      }
      cdRes.value.push({
        component: childOfToken,
        data: { parent: ENTITY_NULL_RAW } as never,
      });
    }
    return (this.spawn as (...c: ComponentData[]) => Result<EntityHandle, EcsError>)(
      ...cdRes.value,
    );
  }

  /** @internal Resolve mount.source through the wired SceneAssetResolver. */
  _resolveMountSource(
    source: number | string,
    parentHandle: Handle<'SceneAsset', 'shared'>,
  ): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
    if (this.sceneAssetResolver === null) {
      return err({
        code: 'stale-entity' as const,
        expected: 'wired SceneAssetResolver (auto-wired by engine.assets.instantiate)',
        hint:
          'engine.assets.instantiate sugar wires this for you; ' +
          'unit tests can call world._setSceneAssetResolver (@internal) directly.',
        detail: { entity: 0, slot: 0, generation: 0 },
      } as unknown as EcsError);
    }
    const r = this.sceneAssetResolver(source, parentHandle);
    if (!r.ok) {
      // Resolver carries `unknown` err (loose contract — engine-runtime may
      // wire any shape); narrow back to EcsError here at the boundary.
      return err(r.error as EcsError);
    }
    return ok(r.value);
  }

  /** @internal Convert mount.overrides Map shape to the SceneInstanceState shape. */
  _mountOverridesToStateMap(
    src: Map<LocalEntityId, Map<string, MountOverride>>,
  ): Map<LocalEntityId, Map<string, { comp: string; field: string; value: unknown }>> {
    const out = new Map<
      LocalEntityId,
      Map<string, { comp: string; field: string; value: unknown }>
    >();
    for (const [lid, fields] of src) {
      const m = new Map<string, { comp: string; field: string; value: unknown }>();
      for (const [k, v] of fields) {
        m.set(k, { comp: v.comp, field: v.field, value: v.value });
      }
      out.set(lid, m);
    }
    return out;
  }

  /** @internal Set the payload of an already-allocated managed ref slot. */
  _setUniqueRefPayload<T>(handle: Handle<string, 'unique'>, payload: T): void {
    const raw = unwrapHandle(handle);
    // biome-ignore lint/suspicious/noExplicitAny: store is erased
    const store = this.uniqueRefs as unknown as { payloads: Map<number, any> };
    store.payloads.set(raw, payload);
  }

  /**
   * @internal Resolve the SceneInstanceState payload behind the
   * `SceneInstance.state` ref column on `root`. Returns Err when `root`
   * does not carry SceneInstance or the ref slot is dead.
   */
  _resolveSceneInstanceStatePayload(
    root: EntityHandle,
  ): Result<SceneInstanceStatePayload, EcsError> {
    const sceneInstanceToken = resolveComponent('SceneInstance');
    if (sceneInstanceToken === undefined) {
      return err(new ComponentNotDefinedError('SceneInstance'));
    }
    const r = this.get(root, sceneInstanceToken);
    if (!r.ok) return r;
    const stateRefRaw = (r.value as unknown as { state: number }).state;
    const stateRefHandle = toUnique<'SceneInstanceState'>(stateRefRaw);
    const payloadRes = this.uniqueRefs.resolve(stateRefHandle);
    if (!payloadRes.ok) {
      return err(payloadRes.error as unknown as EcsError);
    }
    return ok(payloadRes.value as SceneInstanceStatePayload);
  }

  /**
   * Public sugar — get the SceneInstanceState payload (Map / Set view) for
   * `root`. Equivalent to `world.get(root, SceneInstance)` followed by a
   * managed-ref resolution; provided so AI users do not have to learn the
   * `ref<T>` slot resolution mechanic for the common read path.
   */
  getSceneInstanceState(root: EntityHandle): Result<SceneInstanceStatePayload, EcsError> {
    return this._resolveSceneInstanceStatePayload(root);
  }

  /**
   * Despawn a SceneInstance root + all its members. `opts.keepDetached`
   * preserves members marked via `world.detachSceneMember` (plan-strategy
   * §D-5). Returns the count of entities actually despawned (root + each
   * non-detached member).
   *
   * For a plain entity (no SceneInstance), behaviour matches
   * `world.despawn(entity)` followed by `despawnDescendants(entity)` — i.e.
   * `keepDetached` is a no-op.
   */
  despawnScene(root: EntityHandle, opts?: { keepDetached?: boolean }): Result<number, EcsError> {
    const dRes = this.despawnDescendants(root, opts);
    if (!dRes.ok) return dRes;
    const drop = this.despawn(root);
    if (!drop.ok) return drop;
    return ok(dRes.value + 1);
  }

  /**
   * Despawn every descendant of `root` reachable through Children mirror /
   * SceneInstance.mapping. `opts.keepDetached` is honoured only when `root`
   * carries a SceneInstance (otherwise the option is ignored — there is no
   * detached set on a plain entity).
   *
   * Returns the count of entities despawned. The `root` itself is NOT
   * despawned (that is `despawnScene`'s extra step).
   */
  despawnDescendants(
    root: EntityHandle,
    opts?: { keepDetached?: boolean },
  ): Result<number, EcsError> {
    let detached: Set<LocalEntityId> | null = null;
    let entityToLocalId: Map<EntityHandle, LocalEntityId> | null = null;
    if (opts?.keepDetached === true) {
      const stateRes = this._resolveSceneInstanceStatePayload(root);
      if (stateRes.ok) {
        detached = stateRes.value.detachedLocalIds;
        entityToLocalId = stateRes.value.entityToLocalId;
      }
    }
    let count = 0;
    // Collect descendants first (DFS via iterDescendants) to avoid mutating
    // while iterating.
    const list: EntityHandle[] = [];
    for (const e of this.iterDescendants(root)) list.push(e);
    const childOfToken = resolveComponent('ChildOf');
    for (const e of list) {
      if (detached !== null) {
        const lid = entityToLocalId?.get(e);
        if (lid !== undefined && detached.has(lid)) {
          if (childOfToken !== undefined) {
            this._removeComponentCore(e, childOfToken, false);
          }
          continue;
        }
      }
      const r = this.despawn(e);
      if (!r.ok) return r;
      count += 1;
    }
    return ok(count);
  }

  /**
   * Write a runtime override to a member entity belonging to `root`. Routes
   * through `world.set(member, comp, { [field]: value })` after an entity-
   * scope guard so cross-instance writes fail-fast. Type-mismatch surfaces
   * `EcsErrorCode = 'scene-override-type-mismatch'` (D-9).
   */
  setSceneOverride<S extends ComponentSchema>(
    root: EntityHandle,
    member: EntityHandle,
    component: Component<string, S>,
    field: keyof ShapeOf<S> & string,
    value: unknown,
  ): Result<void, EcsError> {
    const stateRes = this._resolveSceneInstanceStatePayload(root);
    if (!stateRes.ok) return stateRes;
    const state = stateRes.value;
    const lid = state.entityToLocalId.get(member);
    if (lid === undefined) {
      return err(
        new StaleEntityError(
          member as unknown as number,
          entityIndex(member),
          entityGeneration(member),
          {
            operation: 'setSceneOverride',
            component: component.name,
            expectedGeneration: entityGeneration(member),
            actualGeneration: entityGeneration(member),
          },
        ),
      );
    }
    // Type guard: only check primitive scalar field types where we can
    // narrow `typeof`; ref / handle / entity / array / buffer fields skip
    // (write would surface a deeper error from set).
    const schemaType = (component.schema as Record<string, string>)[field];
    if (schemaType !== undefined && isPrimitiveScalarFieldType(schemaType)) {
      const expectJsType = primitiveJsType(schemaType);
      const actualJsType = typeof value;
      if (expectJsType !== actualJsType) {
        return err({
          code: 'scene-override-type-mismatch' as const,
          expected: `value typeof === ${expectJsType}`,
          hint:
            `setSceneOverride(${component.name}.${field}) expected ${expectJsType}, ` +
            `got ${actualJsType}; coerce or pick a different override path.`,
          detail: {
            code: 'scene-override-type-mismatch' as const,
            comp: component.name,
            field: field as string,
            expectedType: schemaType,
            actualType: actualJsType,
          },
        } as unknown as EcsError);
      }
    }
    const setRes = this.set(member, component, { [field]: value } as Partial<InputShapeOf<S>>);
    if (!setRes.ok) return setRes;
    // Record into state.overrides
    let fieldMap = state.overrides.get(lid);
    if (fieldMap === undefined) {
      fieldMap = new Map();
      state.overrides.set(lid, fieldMap);
    }
    fieldMap.set(`${component.name}:${field}`, {
      comp: component.name,
      field: field as string,
      value,
    });
    return ok(undefined);
  }

  /**
   * Drop a runtime override (and any mount-time override for the same
   * (member, comp, field) triple); roll the live column value back to the
   * source SceneAsset's layer-1 explicit value (M2 v1 — M3+ widens to layer
   * 2/3 defaults via fillComponentDefaults).
   */
  removeSceneOverride<S extends ComponentSchema>(
    root: EntityHandle,
    member: EntityHandle,
    component: Component<string, S>,
    field: keyof ShapeOf<S> & string,
  ): Result<void, EcsError> {
    const stateRes = this._resolveSceneInstanceStatePayload(root);
    if (!stateRes.ok) return stateRes;
    const state = stateRes.value;
    const lid = state.entityToLocalId.get(member);
    if (lid === undefined) return ok(undefined);
    const fieldMap = state.overrides.get(lid);
    if (fieldMap !== undefined) {
      fieldMap.delete(`${component.name}:${field}`);
      if (fieldMap.size === 0) state.overrides.delete(lid);
    }
    // Look up the source SceneAsset layer-1 value.
    const assetRes = this._resolveSceneAsset(state.source);
    if (!assetRes.ok) return assetRes;
    const node = assetRes.value.entities.find(
      (n) => (n.localId as unknown as number) === (lid as unknown as number),
    );
    const layer1 = node?.components[component.name] as Record<string, unknown> | undefined;
    if (layer1 !== undefined && field in layer1) {
      const r = this.set(member, component, { [field]: layer1[field] } as Partial<InputShapeOf<S>>);
      if (!r.ok) return r;
    }
    return ok(undefined);
  }

  /** Mark a member entity detached. Idempotent (set semantics). */
  detachSceneMember(root: EntityHandle, member: EntityHandle): Result<void, EcsError> {
    const sceneInstanceToken = resolveComponent('SceneInstance');
    if (sceneInstanceToken === undefined) {
      return err(new ComponentNotDefinedError('SceneInstance'));
    }
    const stateRes = this._resolveSceneInstanceStatePayload(root);
    if (!stateRes.ok) return stateRes;
    const state = stateRes.value;
    const lid = state.entityToLocalId.get(member);
    if (lid === undefined) return ok(undefined);
    state.detachedLocalIds.add(lid);
    return ok(undefined);
  }

  /** Clear a detached mark. Idempotent (set semantics). */
  reattachSceneMember(root: EntityHandle, member: EntityHandle): Result<void, EcsError> {
    const stateRes = this._resolveSceneInstanceStatePayload(root);
    if (!stateRes.ok) return stateRes;
    const state = stateRes.value;
    const lid = state.entityToLocalId.get(member);
    if (lid === undefined) return ok(undefined);
    state.detachedLocalIds.delete(lid);
    return ok(undefined);
  }

  /**
   * Get the SceneAsset handle a SceneInstance root was instantiated from.
   * Returns Err on a plain entity (no SceneInstance component).
   */
  getSceneAssetForInstance(root: EntityHandle): Result<Handle<'SceneAsset', 'shared'>, EcsError> {
    const stateRes = this._resolveSceneInstanceStatePayload(root);
    if (!stateRes.ok) return stateRes;
    return ok(stateRes.value.source);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SceneInstanceStatePayload — internal echo of the runtime
// `SceneInstanceState` interface for ECS-side consumption (engine-ecs cannot
// value-import engine-runtime by AC-29; structural shape only).
// ────────────────────────────────────────────────────────────────────────────

/** @internal Structural payload behind `SceneInstance.state` ref column. */
interface SceneInstanceStatePayload {
  readonly source: Handle<'SceneAsset', 'shared'>;
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  readonly detachedLocalIds: Set<LocalEntityId>;
  readonly overrides: Map<
    LocalEntityId,
    Map<string, { readonly comp: string; readonly field: string; readonly value: unknown }>
  >;
  readonly rootEntities: EntityHandle[];
  readonly totalSlots: number;
  readonly mountTimeOverrides: readonly MountOverride[];
}

// ────────────────────────────────────────────────────────────────────────────
// Scene-nesting standalone helpers (M2 / w24).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Topological sort over the implicit ChildOf graph (parents before children).
 * Cycle-free input always covers all n nodes; cyclic input emits whatever was
 * reachable from indegree-0 (the fallback caller handles cycle reporting via
 * `pack-cyclic-reference` at the upstream scanner / runtime path).
 */
function sceneTopoSort(
  nodes: readonly import('@forgeax/engine-types').SceneEntity[],
): readonly number[] {
  const n = nodes.length;
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Uint32Array(n);
  const localIdToIdx = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    localIdToIdx.set(node.localId as unknown as number, i);
  }
  for (let i = 0; i < n; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const child = node.components.ChildOf;
    if (child === undefined) continue;
    const p = (child as Record<string, unknown>).parent;
    if (typeof p === 'number') {
      const parentIdx = localIdToIdx.get(p);
      if (parentIdx !== undefined && parentIdx !== i) {
        childrenOf[parentIdx]?.push(i);
        indeg[i] = (indeg[i] ?? 0) + 1;
      }
    }
  }
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) if ((indeg[i] ?? 0) === 0) queue.push(i);
  while (queue.length > 0) {
    const head = queue.shift();
    if (head === undefined) break;
    order.push(head);
    for (const c of childrenOf[head] ?? []) {
      indeg[c] = (indeg[c] ?? 0) - 1;
      if ((indeg[c] ?? 0) === 0) queue.push(c);
    }
  }
  // Append any nodes left unvisited (defensive — cycle would surface here).
  for (let i = 0; i < n; i += 1) {
    if (!order.includes(i) && nodes[i] !== undefined) order.push(i);
  }
  return order;
}

/** Schema field types that are JS primitives (typeof checkable). */
function isPrimitiveScalarFieldType(fieldType: string): boolean {
  if (
    fieldType === 'f32' ||
    fieldType === 'f64' ||
    fieldType === 'u32' ||
    fieldType === 'i32' ||
    fieldType === 'u8' ||
    fieldType === 'i8' ||
    fieldType === 'u16' ||
    fieldType === 'i16' ||
    fieldType === 'bool' ||
    fieldType === 'string'
  ) {
    return true;
  }
  if (fieldType.startsWith('enum<')) return true;
  return false;
}

/** Map a primitive scalar field type to the runtime `typeof` it should narrow to. */
function primitiveJsType(fieldType: string): string {
  if (fieldType === 'bool') return 'boolean';
  if (fieldType === 'string') return 'string';
  return 'number';
}

/**
 * Reinterpret a `BufferPool` slot's `Uint8Array` byte region as the typed
 * view for `elementType`, sliced to `elementCount` elements. Backs the
 * `world.get(e, C).<arrayField>` read path: the returned typed array
 * aliases live slot bytes (zero-copy) but is contractually a read-only
 * snapshot (plan-strategy §2.2). `entity` element fields surface as
 * `Uint32Array` (Entity packs slot+gen into u32).
 */
/**
 * Element-byte-width for a managed-array element type, read off the global
 * TYPE_METADATA table (single SSOT). `entity` stores as `u32` (4 bytes); every
 * scalar maps to its own key. `fieldTypeToMetaKey` always resolves a key for a
 * ManagedArrayElementType, and every such row carries a concrete `byteSize`.
 */
function elementByteSize(elementType: ManagedArrayElementType): number {
  const key = fieldTypeToMetaKey(elementType);
  // biome-ignore lint/style/noNonNullAssertion: every ManagedArrayElementType resolves to a row with a concrete byteSize
  return TYPE_METADATA[key!]!.byteSize!;
}

function reinterpretSlotBytes(
  bytes: Uint8Array,
  elementType: ManagedArrayElementType,
  elementCount: number,
):
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array {
  const buf = bytes.buffer;
  const offset = bytes.byteOffset;
  // shared<X> template literals: column-stored as u32 handles, reinterpret
  // as Uint32Array. The brand is applied at the FieldValueType level;
  // runtime storage is plain u32 (feat-20260614 M5; replaces the retired
  // 'handle<X>' arm).
  if (elementType.startsWith('shared<')) {
    return new Uint32Array(buf, offset, elementCount);
  }
  switch (elementType) {
    case 'f32':
      return new Float32Array(buf, offset, elementCount);
    case 'f64':
      return new Float64Array(buf, offset, elementCount);
    case 'i32':
      return new Int32Array(buf, offset, elementCount);
    case 'u32':
    case 'enum':
    case 'ref':
    case 'entity':
      return new Uint32Array(buf, offset, elementCount);
    case 'i16':
      return new Int16Array(buf, offset, elementCount);
    case 'u16':
      return new Uint16Array(buf, offset, elementCount);
    case 'i8':
      return new Int8Array(buf, offset, elementCount);
    case 'u8':
    case 'bool':
      return new Uint8Array(buf, offset, elementCount);
  }
  // Exhaustiveness fallthrough: TypeScript template-literal type
  // (`shared<${string}>`) is structurally not narrowed away by the
  // `startsWith` guard above, so this branch is unreachable yet TS still
  // requires a return path.
  return new Uint32Array(buf, offset, elementCount);
}

/**
 * Reinterpret `bytes` as the typed view for `elementType` and write `value`
 * at element index `idx`. Mirrors the `array<T>` storage law (4/8/2/1-byte
 * element widths per TYPE_METADATA.byteSize) and is used by `world.push`
 * to land a new tail element into BufferPool slot bytes after a `grow`.
 */
function writeArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
  value: number,
): void {
  const buf = bytes.buffer;
  const offset = bytes.byteOffset;
  const byteLen = bytes.byteLength;
  switch (elementType) {
    case 'f32':
      new Float32Array(buf, offset, byteLen >>> 2)[idx] = value;
      return;
    case 'f64':
      new Float64Array(buf, offset, byteLen >>> 3)[idx] = value;
      return;
    case 'i32':
      new Int32Array(buf, offset, byteLen >>> 2)[idx] = value;
      return;
    case 'u32':
    case 'enum':
    case 'ref':
    case 'entity':
      new Uint32Array(buf, offset, byteLen >>> 2)[idx] = value;
      return;
    case 'i16':
      new Int16Array(buf, offset, byteLen >>> 1)[idx] = value;
      return;
    case 'u16':
      new Uint16Array(buf, offset, byteLen >>> 1)[idx] = value;
      return;
    case 'i8':
      new Int8Array(buf, offset, byteLen)[idx] = value;
      return;
    case 'u8':
    case 'bool':
      new Uint8Array(buf, offset, byteLen)[idx] = value;
      return;
  }
}

/**
 * Reinterpret `bytes` as the typed view for `elementType` and read element
 * `idx`. Mirrors `writeArrayElementAt` -- consumed by `world.pop` to materialise
 * the tail value before the count is decremented.
 */
function readArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
): number {
  const buf = bytes.buffer;
  const offset = bytes.byteOffset;
  const byteLen = bytes.byteLength;
  // shared<X> template literals: column-stored as u32 handles, read as
  // Uint32Array. (feat-20260614 M5; replaces retired 'handle<X>' arm.)
  if (elementType.startsWith('shared<')) {
    return new Uint32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
  }
  switch (elementType) {
    case 'f32':
      return new Float32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
    case 'f64':
      return new Float64Array(buf, offset, byteLen >>> 3)[idx] ?? 0;
    case 'i32':
      return new Int32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
    case 'u32':
    case 'enum':
    case 'ref':
    case 'entity':
      return new Uint32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
    case 'i16':
      return new Int16Array(buf, offset, byteLen >>> 1)[idx] ?? 0;
    case 'u16':
      return new Uint16Array(buf, offset, byteLen >>> 1)[idx] ?? 0;
    case 'i8':
      return new Int8Array(buf, offset, byteLen)[idx] ?? 0;
    case 'u8':
    case 'bool':
      return new Uint8Array(buf, offset, byteLen)[idx] ?? 0;
  }
  return 0;
}
