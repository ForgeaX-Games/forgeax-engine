/**
 * @module @forgeax/engine-ecs
 *
 * Archetype ECS with three-layer error architecture:
 *
 * 1. **Layer 1 (World methods)** — every mutation (`get`/`set`/`spawn`/`despawn`/
 *    `addComponent`/`removeComponent`) returns `Result<T, EcsError>`.
 *    Use `.unwrap()` for quick-and-dirty or `if (!r.ok) ... r.error ...` for programmatic branching.
 *
 * 2. **Layer 2 (ParamValidation)** — system parameter pre-checks (query empty → skipped,
 *    resource missing → invalid). Systems with invalid params do not execute.
 *
 * 3. **Layer 3 (ErrorHandler + Severity)** — system execution errors and Layer 2
 *    `invalid` results are routed to an `ErrorHandler`. Default: `matchSeverity`
 *    (Panic → throw, Error → console.error, ..., Ignore → silent).
 *
 * AI users: import types from this module — `.d.ts` signatures expose
 * `Result<T, EcsError>` on all World methods, making error paths discoverable
 * without reading source. Switch on `.code` for programmatic error branching.
 *
 * **Warning — Result propagation in system bodies**: TypeScript lacks Rust's `?`
 * operator. If your system fn is `void`, an unhandled Result err branch
 * (`r.ok === false`) from World methods will NOT reach the Layer 3
 * ErrorHandler. Either use `.unwrap()` (throws on err, caught by default
 * Panic handler) or return the Result explicitly from your system.
 */

// Layered exports: core API first (World / defineComponent / Entity / Query),
// then Result + error types, then advanced API (Schedule / CommandBuffer),
// then errors, then constants. AI users reading .d.ts see high-frequency
// APIs at the top of the file (charter V1 proposition 1).

// ────────────────────────────────────────────────────────────────────────────
// Result type — the return type of all World mutation methods
// ────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union result type: `ResultOk<T>` or `ResultErr<E>`.
 * All World mutation methods return `Result<T, EcsError>`. The discriminant
 * is `.ok: boolean`; the success branch carries `.value: T`, the failure
 * branch carries `.error: E`. Method chain: `.unwrap()` / `.unwrapOr(d)`.
 *
 * @example
 * ```ts
 * // Plain field-access idiom (charter proposition 5 consistent abstraction):
 * const r = world.get(entity, Position);
 * if (!r.ok) { console.error(r.error.code, r.error.hint); return; }
 * const data = r.value; // ShapeOf<S>
 *
 * // Method-chain idiom (`.unwrap()` throws the original EcsError on err):
 * const data2 = world.get(entity, Position).unwrap();
 *
 * // Defaulted-fallback idiom (charter proposition 4 explicit-failure
 * // boundary — `unwrapOr` silently drops the error):
 * const data3 = world.get(entity, Position).unwrapOr({ x: 0, y: 0 });
 * ```
 */

// ────────────────────────────────────────────────────────────────────────────
// Essential-id forced registration (feat-20260602 M1 / w1; plan-strategy
// D-1 / D-6b; feat-20260611 D-9 SSOT switch to ESSENTIAL_COMPONENT_IDS).
//
// The `Entity` component MUST be the first `defineComponent` evaluated in the
// process so the auto-increment component-id counter assigns it id=0. ESM
// evaluates import bindings in source order before any other statement, so this
// import -- placed textually first among the barrel's module imports -- forces
// `entity.ts` (and thus `defineComponent('Entity', ...)`) to run ahead of
// every downstream component module. The fail-fast assertion below converts
// an import-order regression from a silent runtime mis-id into a structured
// startup throw (charter P3).
//
// The assertion reads `ESSENTIAL_COMPONENT_IDS` (the SSOT for which ids must
// be present and where) rather than hard-coding `Entity.id !== 0` so adding a
// future essential component requires updating exactly one place.
//
// `Entity` is re-exported from the barrel as a value (the id=0 component
// token). The matching type-space handle type is `EntityHandle`, re-exported
// from `./entity-handle` -- the two no longer share a name (feat-20260611 I-1;
// renamed from `./entity` to `./entity-handle` in tweak-20260611-M3 to make
// the file's role explicit; tweak-20260612 then lifted the Entity component
// from the historical `components/entity.ts` back into `./entity` since that
// slot was free).
import { Entity, ESSENTIAL_COMPONENT_IDS, foldEssentials } from './entity';

if (ESSENTIAL_COMPONENT_IDS.length !== 1 || ESSENTIAL_COMPONENT_IDS[0] !== 0) {
  throw new Error(
    'forgeax-engine-ecs: ESSENTIAL_COMPONENT_IDS invariant violated ' +
      `(expected [0], got [${ESSENTIAL_COMPONENT_IDS.join(', ')}]). ` +
      'A defineComponent() call evaluated before the @forgeax/engine-ecs barrel forced the id counter ' +
      'past 0. Ensure no module defines a component at import time before importing from the barrel.',
  );
}

// Result<T, E> SSOT lives in `@forgeax/engine-types` (tweak-20260612). The
// barrel re-export keeps the historical `import { err, ok, Result } from
// '@forgeax/engine-ecs'` consumer surface unchanged.
export { err, ok, type Result } from '@forgeax/engine-types';
/**
 * Branded-number handle type identifying a row (24-bit index + 8-bit
 * generation). The `Entity` component token (value-space, id=0) and the
 * `EntityHandle` type (type-space) are deliberately separate names since
 * feat-20260611 -- a single shared name caused repeated AI-user confusion in
 * `: Entity` annotations.
 */
export type { EntityHandle } from './entity-handle';
/**
 * Union of all EcsError types returned by World methods via Result.
 * Switch on `.code` for programmatic branching (e.g. `error.code === 'stale-entity'`).
 */
export type { EcsError } from './world';
/**
 * The id=0 essential `Entity` component token. The matching type-space handle
 * type (the branded number returned by `world.spawn` and accepted by every
 * World method that takes an entity argument) is `EntityHandle`, exported
 * separately from this barrel.
 *
 * @example Handle type + spawn:
 * ```ts
 * const e: EntityHandle = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
 * ```
 * @example Read the handle off its own column / probe liveness:
 * ```ts
 * world.get(e, Entity).unwrap().self === e;
 * ```
 */
export { Entity, ESSENTIAL_COMPONENT_IDS, foldEssentials };

// ────────────────────────────────────────────────────────────────────────────
// Core API — the 80% surface most users need
// ────────────────────────────────────────────────────────────────────────────

/**
 * Two-axis phantom-branded handle: `Handle<TargetTag, Mode>`.
 *
 * - `Mode = 'unique'` — released by ECS on despawn / removeComponent / set
 *   (e.g. derived from schema vocab `ref<T>`).
 * - `Mode = 'shared'` — external owner manages release; ECS treats as
 *   plain id (e.g. derived from schema vocab `handle<T>`,
 *   `MeshFilter.assetHandle: Handle<'MeshAsset','shared'>`).
 *
 * Cross-mode and cross-target assignment is a TS error (AC-02).
 *
 * Re-exported from `@forgeax/engine-types` (single SSOT physical location,
 * feat-20260517-handle-type-unify D-2 / D-3); the ecs barrel forwards a
 * narrow subset so `import { Handle } from '@forgeax/engine-ecs'` keeps
 * working for existing consumers. The `UniqueHandle<T>` alias + the
 * ECS-internal `'String'` tag are deliberately NOT re-exported (AC-15
 * keeps the AI-facing barrel narrow). `TagOf` and `unwrapHandle` are also
 * not on the ecs barrel — they remain available from
 * `@forgeax/engine-types` directly when explicitly needed.
 *
 * @example
 * ```ts
 * import type { Handle } from '@forgeax/engine-ecs';
 *
 * declare const mesh: Handle<'MeshAsset', 'shared'>;
 * // const mat: Handle<'MaterialAsset', 'shared'> = mesh; // TS error
 * ```
 */
export type { Handle, SharedHandle } from '@forgeax/engine-types';
export { toShared, toUnique } from '@forgeax/engine-types';
/**
 * Opaque component token carrying name + schema type information.
 *
 * Prefer letting `defineComponent` infer the type — both the literal name `N`
 * and schema `S` flow through, enabling `bundles.<Name>.<field>` inference in
 * queries without `as` assertions.
 *
 * @example
 * ```ts
 * // Recommended — infer both N and S:
 * const Pos = defineComponent('Pos', { x: 'f32', y: 'f32' });
 * //    ^? Component<'Pos', { x: 'f32'; y: 'f32' }>
 *
 * // Only annotate when you must — and use both type parameters:
 * const Vel: Component<'Vel', { dx: 'f32'; dy: 'f32' }> =
 *   defineComponent('Vel', { dx: 'f32', dy: 'f32' });
 * ```
 */
export type {
  Component,
  ComponentSchema,
  DefineComponentOptions,
  FieldInputType,
  FieldValueType,
  InputShapeOf,
  RelationshipMeta,
  ScalarFieldType,
  SchemaFieldType,
  SchemaVocabKeyword,
  ShapeOf,
  TypedArrayFor,
} from './component';
/**
 * Declare a component schema. Returns a frozen opaque token with `.name`, `.schema`, `.id`.
 *
 * @example
 * ```ts
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * ```
 */
/**
 * Global component-name -> token resolver. Returns the live {@link Component}
 * token for a name that has been passed to {@link defineComponent}, or
 * `undefined` when the name was never defined. Engine-internal consumers
 * (render extract / pick / glyph layout / asset-registry scene resolve) use
 * this to gate component lookups without a per-World registration ledger.
 *
 * {@link getRegisteredComponents} returns the read-only name -> token map for
 * enumerating every defined component (mirrors `getRegisteredSystems`).
 */
export { defineComponent, getRegisteredComponents, resolveComponent } from './component';
export type { ManagedArrayErrorEnvelope } from './errors';
/**
 * Query descriptor for With/Without archetype filtering.
 *
 * @example
 * ```ts
 * const desc: QueryDescriptor = { with: [Position, Velocity], without: [Static] };
 * ```
 */
export type { ColumnBundle, NestedColumnBundle, QueryDescriptor, QueryState } from './query';
/**
 * ECS-aware refcount-tracked handle store (M3). Owns the lifecycle of every
 * `Handle<T, 'shared'>` derived from `shared<T>` schema fields. The producer
 * (typically AssetRegistry) calls `alloc` once (alloc-grant rc=1); each
 * additional holder retains; release decrements; rc 1 -> 0 fires the
 * per-handle `onLastRelease` deleter (passed as the third `alloc` argument,
 * mirroring `UniqueRefStore.alloc`) and drops the slot. There is no global
 * listener — the release signal is per-handle (M6 D-10).
 *
 * D-15: the store manages ONLY user-tier slots (`>= BUILTIN_BASE`); builtin
 * asset payloads are process-static in `BuiltinAssetRegistry`
 * (@forgeax/engine-runtime) and never reference-counted. Passing a builtin
 * slot fails fast with `BuiltinSlotNotOwnedError`.
 *
 * `World` owns one `SharedRefStore` per instance, exposed as
 * `world.sharedRefs`. The schema-field write barrier (retain on spawn / set,
 * release on despawn / removeComponent) short-circuits on builtin slots.
 *
 * @example
 * ```ts
 * const world = new World();
 * const handle = world.allocSharedRef('MaterialAsset', payload, (p) => dropGpu(p));
 * const M = defineComponent('M', { asset: 'shared<MaterialAsset>' });
 * world.spawn({ component: M, data: { asset: handle } });
 * // the per-handle deleter fires once when this handle's rc reaches 0.
 * ```
 */
export { SharedRefStore } from './shared-ref-store';
/**
 * ECS-managed handle store (M1). Owns the lifecycle of every
 * `Handle<T, 'unique'>` derived from `ref<T>` schema fields - World hooks
 * `despawn` / `removeComponent` / `set` into `release(handle)`.
 *
 * `World` owns one `UniqueRefStore` per instance, constructed eagerly in the
 * `World` constructor (always-on since feat-20260515-string-managed-collapse).
 * Production code rarely touches the store directly - schema-vocab `ref<T>`
 * fields make `world.get(e, C).<refField>` the canonical access path.
 *
 * @example
 * ```ts
 * const Material = defineComponent('Material', { handle: 'unique<MaterialPayload>' });
 * const world = new World();
 * // World owns the UniqueRefStore internally; AI users do not wire it.
 * ```
 */
export { UniqueRefStore } from './unique-ref-store';

/**
 * Component data bundle for spawn/addComponent: pairs a component token with initial values.
 *
 * @example
 * ```ts
 * const data: ComponentData = { component: Position, data: { x: 1, y: 2 } };
 * ```
 */
export type { ComponentData } from './world';
/**
 * Top-level ECS container. Owns entities, archetypes, systems, and resources.
 *
 * @example
 * ```ts
 * const world = new World();
 * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } });
 * world.update();
 * ```
 */
export { World } from './world';

// ────────────────────────────────────────────────────────────────────────────
// Advanced API — system scheduling, commands, resources, inspection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Deferred command buffer passed to system functions. Queues structural changes
 * (spawn/despawn/addComponent/removeComponent) for end-of-frame flush.
 *
 * @example
 * ```ts
 * fn: (world, results, commands) => {
 *   const e = commands.spawn({ component: Bullet, data: { dmg: 10 } });
 *   commands.despawn(oldEntity);
 * }
 * ```
 */
export type { CommandBuffer } from './commands';
/**
 * System descriptor for `world.addSystem()`. Declares queries, execution function,
 * and optional before/after ordering constraints.
 *
 * @example
 * ```ts
 * world.addSystem({
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (world, results, commands) => { ... },
 * });
 * ```
 */
export type { SystemDescriptor, SystemHandle } from './schedule';

/**
 * Define a system at module level + register it globally ("define ==
 * register"). Returns a {@link SystemHandle} token consumed directly by
 * `world.addSystem(token)`. {@link getRegisteredSystems} enumerates all
 * defined systems by name.
 *
 * @example
 * ```ts
 * const Move = defineSystem({
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (world, results) => { ... },
 * });
 * world.addSystem(Move);
 * ```
 */
export { defineSystem, getRegisteredSystems } from './schedule';

/**
 * Type alias for the `fn` field of `SystemDescriptor`. Lets typed console
 * sugar (`@forgeax/engine-remote/defineSugar` / `injectSystem`) reference
 * the system function shape without the verbose
 * `SystemDescriptor<Qs>['fn']` indexed-access form.
 *
 * @example
 * ```ts
 * import type { SystemFn } from '@forgeax/engine-ecs';
 * const move: SystemFn = (world, results, commands) => { ... };
 * ```
 */
export type SystemFn<
  Qs extends ReadonlyArray<import('./query').QueryDescriptor> = ReadonlyArray<
    import('./query').QueryDescriptor
  >,
> = import('./schedule').SystemDescriptor<Qs>['fn'];

/**
 * Inspection snapshot returned by `world.inspect()`. Contains entity count,
 * archetype info, active components, system count, and resource keys.
 *
 * @example
 * ```ts
 * const info = world.inspect();
 * console.log(info.entityCount, info.archetypeCount);
 * ```
 */
// C-R2 (feat-20260622-s5): non-fatal SceneAsset unknown-field diagnostics +
// the instantiateScene success envelope ({ root, diagnostics }).
export type {
  ArchetypeInfo,
  SceneInstantiateDiagnostic,
  SceneInstantiateOk,
  WorldInspection,
} from './world';

// ────────────────────────────────────────────────────────────────────────────
// Entity encoding utilities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Encode/decode entity handles for serialization or debugging.
 *
 * @example
 * ```ts
 * const { index, generation } = decodeEntity(entity);
 * const rebuilt = encodeEntity(index, generation);
 * ```
 */
export { decodeEntity, encodeEntity } from './entity-handle';

// ────────────────────────────────────────────────────────────────────────────
// Query engine utilities
// ────────────────────────────────────────────────────────────────────────────

export { createQueryState, queryRun } from './query';

// ────────────────────────────────────────────────────────────────────────────
// Component internals (for advanced use: custom storage, tooling)
// ────────────────────────────────────────────────────────────────────────────

export type {
  ArrayMeta,
  ComponentId,
  FieldDescriptor,
  FieldReflection,
  SchemaOf,
  TypeMetadataRow,
} from './component';
export {
  isEntityField,
  isManagedArrayField,
  isManagedBufferField,
  isManagedField,
  TYPE_METADATA,
} from './component';

// ────────────────────────────────────────────────────────────────────────────
// Layer-3 default-value SSOT helper (feat-20260517-spawn-default-fallback / M1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fill missing schema fields on a partial spawn-data raw with their
 * layer-2 / layer-3 defaults. Single SSOT helper consumed by two
 * write paths: `World.spawn` / `World.addComponent`. See
 * `component-default-fallback.ts` head JSDoc for the closed 14-vocab
 * default-value table + two-layer split (layer-3 raw / layer-4 column).
 */
export {
  fillComponentDefaults,
  validateComponentDataKeys,
} from './component-default-fallback';

// ────────────────────────────────────────────────────────────────────────────
// Column / storage internals (for advanced use: custom archetype tooling)
// ────────────────────────────────────────────────────────────────────────────

export type { Column, FieldView, ManagedColumnReader } from './column';
export { createColumn, growColumn, isHotSchema } from './column';

// ────────────────────────────────────────────────────────────────────────────
// Archetype internals
// ────────────────────────────────────────────────────────────────────────────

export type { Archetype, ArchetypeId } from './archetype';

// ────────────────────────────────────────────────────────────────────────────
// Schedule internals
// ────────────────────────────────────────────────────────────────────────────

export type { Schedule } from './schedule';

// ────────────────────────────────────────────────────────────────────────────
// Error architecture — Layer 2 (ParamValidation) + Layer 3 (ErrorHandler)
// ────────────────────────────────────────────────────────────────────────────

/**
 * ErrorHandler function signature + ErrorContext metadata.
 * Set via `world.setErrorHandler(handler)`.
 */
/**
 * Three-state param validation result: ok / skipped / invalid.
 * Used by Layer 2 to decide whether a system body executes.
 */
export type { ErrorContext, ErrorHandler, ParamValidation, SeverityLevel } from './schedule';
/**
 * Seven-level severity enum. Default is `Panic` (fail-fast).
 * Ordered: Ignore < Trace < Debug < Info < Warning < Error < Panic.
 */
export { matchSeverity, Severity } from './schedule';

// ────────────────────────────────────────────────────────────────────────────
// Error classes — typed errors with context + hint for AI-friendly self-repair
// ────────────────────────────────────────────────────────────────────────────

export type {
  EcsErrorCode,
  EcsErrorDetail,
  ScheduleMutationErrorCode,
  ScheduleMutationErrorDetail,
} from './errors';
export {
  ArrayPopEmptyError,
  BuiltinSlotNotOwnedError,
  CardinalityExceededError,
  ComponentAlreadyPresentError,
  ComponentNotDefinedError,
  ComponentNotPresentError,
  CyclicDependencyError,
  EntityIndexOverflowError,
  FixedArrayOverflowError,
  FixedSizeMismatchError,
  InstanceTransformsStrideMismatchError,
  ManagedArrayElementTypeNotAllowedError,
  ManagedBufferOutOfBoundsError,
  ManagedBufferShrinkNotSupportedError,
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
  RemoveEssentialComponentError,
  ResourceInvalidValueError,
  ResourceNotFoundError,
  ScheduleMutationError,
  SchemaUnsupportedFieldError,
  SharedRefDoubleReleaseError,
  SharedRefReleasedError,
  SharedRefStaleError,
  SpawnDataUnknownFieldError,
  SpawnLightInvalidBoundsError,
  SpriteAnimationInvalidError,
  // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M3 / w10 —
  // surface the 3 sprite-instances error classes declared in M1 / w2 so the
  // runtime extract path can route them via worldInternal._routeError.
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
  StaleEntityError,
  UniqueRefDoubleReleaseError,
  UniqueRefReleasedError,
  UniqueRefStaleError,
} from './errors';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

export { ENTITY_MAX_GENERATION, ENTITY_MAX_INDEX, ENTITY_NULL_RAW } from './entity-handle';

// w8: Inspector contributor (registerEcsInspector + RegisterEcsInspectorResult)
// deleted — routing layer (Registry / sandbox) is removed; eval is the sole
// command channel.
// w9: ECS_MUTATING_METHODS export deleted — sandbox dismantled; mutating-methods.ts removed.
