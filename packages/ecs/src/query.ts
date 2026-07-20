// @forgeax/engine-ecs — Query engine.
//
// Per-archetype bitmask matching (D-02). ArchetypeGeneration incremental cache.
// Hot-table returns nested column bundle: { ComponentName: { fieldName: TypedArray }, entityCount }.
// Per-archetype version stamp (D-10) for cache invalidation on grow.

import type { Archetype, ArchetypeId } from './archetype';
import type { ArchetypeGraph } from './archetype-graph';
import type { FieldView, ManagedColumnReader } from './column';
import {
  type Component,
  type ComponentId,
  type ComponentSchema,
  isManagedField,
  type TypedArrayFor,
} from './component';
import { Entity } from './entity';
import type { EntityHandle } from './entity-handle';
import {
  QueryCombinationsEntityRequiredError,
  QueryDescriptorOptionalConflictError,
} from './errors';

/**
 * Runtime field-view union for `ColumnBundle` entries. POD / fixed-inline
 * columns surface as a `FieldView` (writable TypedArray subarray); managed
 * vocab columns surface as a `ManagedColumnReader` (read-only u32 slot id
 * accessor). Wraps the storage-shape split that `TypedArrayFor` projects
 * at the type level (component.ts).
 */
export type ColumnBundleField = FieldView | ManagedColumnReader<string>;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Descriptor for a query: which components to include (With), exclude (Without),
 * and optionally expose (Optional — data-only, never filters).
 *
 * `Cs` is the tuple type of the `with` list; defaults to `readonly Component[]`
 * to keep non-generic call sites zero-modification (KD-5).
 */
export interface QueryDescriptor<
  Cs extends ReadonlyArray<Component> = ReadonlyArray<Component>,
  Os extends ReadonlyArray<Component> = ReadonlyArray<Component>,
> {
  readonly with: Cs;
  readonly without?: ReadonlyArray<Component>;
  /** Components exposed per-archetype but NOT participating in matching/filtering. */
  readonly optional?: Os;
}

/** Helper: convert union to intersection via distributive conditional. */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** Helper: extract a single component's nested bundle entry: { [name]: { field: TypedArray } } */
type ComponentBundleEntry<C> =
  C extends Component<infer N extends string, infer S extends ComponentSchema>
    ? { [K in N]: { [F in keyof S]: TypedArrayFor<S[F]> } }
    : Record<string, never>;

/** Conditional: if Os is empty (length 0), contribute `unknown` (no effect on intersection). */
type OptionalBundleEntry<Os extends ReadonlyArray<Component>> = Os extends readonly []
  ? unknown
  : Partial<UnionToIntersection<ComponentBundleEntry<Os[number]>>>;

/**
 * Compile-time type for a nested column bundle, derived from component schemas.
 * Maps each component's fields to their TypedArray view types.
 *
 * `Cs` = `with` tuple (always present — non-optional).
 * `Os` = `optional` tuple (exposed as `Partial<>` — whole absent per archetype).
 *
 * @example
 * ```ts
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * //    ^? Component<'Position', { x: 'f32'; y: 'f32' }>
 *
 * type Bundle = NestedColumnBundle<readonly [typeof Position]>;
 * //   ^? { Position: { x: Float32Array; y: Float32Array } }
 * ```
 *
 * Row count is read off the always-present `Entity` column —
 * `bundle.Entity.self.length` (the `Entity` component is essential and carried
 * by every archetype). The historical `entityCount: number` field was removed
 * because it duplicated `bundle.Entity.self.length` (architecture-principles.md
 * §2 Derive); add `Entity` to the query's `with` list when row count is needed.
 */
export type NestedColumnBundle<
  Cs extends ReadonlyArray<Component> = ReadonlyArray<Component>,
  Os extends ReadonlyArray<Component> = readonly [],
> = UnionToIntersection<ComponentBundleEntry<Cs[number]>> & OptionalBundleEntry<Os>;

/**
 * Column bundle returned per matched archetype during query iteration.
 * Nested structure: `{ ComponentName: { fieldName: TypedArray } }`.
 *
 * Row count is `bundle.Entity.self.length` (Entity is essential — every
 * archetype carries it). Add Entity to the query's `with` list to expose it.
 */
export interface ColumnBundle {
  readonly [componentName: string]: Record<string, ColumnBundleField>;
}

/** Cached column bundle + version + size stamps for one matched archetype. */
interface CachedBundle {
  bundle: ColumnBundle;
  version: number;
  size: number;
}

/**
 * Query state: holds cached matched archetypes and column bundles.
 * Reuse across frames for incremental cache updates.
 *
 * `Cs` / `Os` are forwarded from the descriptor for downstream callback
 * inference (S-2, KD-2). Defaults to `readonly Component[]` (KD-5). `Os`
 * flows structurally through `descriptor: QueryDescriptor<Cs, Os>` — no
 * phantom brand field is needed (the historical `__optionalBrand?: Os`
 * intersection was retired once the type-parameter was carried by the
 * descriptor field directly; architecture-principles.md §1 SSOT).
 */
export interface QueryState<
  Cs extends ReadonlyArray<Component> = ReadonlyArray<Component>,
  Os extends ReadonlyArray<Component> = ReadonlyArray<Component>,
> {
  /** The query descriptor (immutable after creation). */
  readonly descriptor: QueryDescriptor<Cs, Os>;
  /** ComponentIds from the `with` list, for bitmask matching. */
  readonly withIds: ReadonlyArray<ComponentId>;
  /** ComponentIds from the `without` list, for bitmask exclusion. */
  readonly withoutIds: ReadonlyArray<ComponentId>;
  /** ComponentIds from the `optional` list — data-only, never used in matching. */
  readonly optionalIds: ReadonlyArray<ComponentId>;
  /** IDs of matched archetypes (incrementally maintained). */
  matchedArchetypes: ArchetypeId[];
  /** Last seen archetype generation (for incremental update). */
  lastGeneration: number;
  /** Cached column bundles keyed by ArchetypeId. */
  cachedBundles: Map<ArchetypeId, CachedBundle>;
}

// ────────────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a fresh QueryState; `const Cs` lifts the `with` literal so downstream
 * `queryRun` callbacks recover per-component TypedArray field types — no
 * `as const` annotations required.
 *
 * Resolves Component tokens to their global `component.id` directly; no World
 * reference is needed at setup — matching happens lazily in `queryRun`.
 *
 * `const Cs` locks the `with` array literal as a tuple so downstream
 * `queryRun` callbacks recover per-component field types from the schema (KD-2).
 *
 * @example
 * ```ts
 * import { defineComponent, Entity, World, createQueryState, queryRun } from '@forgeax/engine-ecs';
 *
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * const Velocity = defineComponent('Velocity', { dx: 'f32', dy: 'f32' });
 * const Glyph = defineComponent('Glyph', { text: 'string', size: 'f32' });
 *
 * const world = new World();
 * // Inferred as QueryState<readonly [typeof Position, typeof Velocity, typeof Entity]>
 * const state = createQueryState({ with: [Position, Velocity, Glyph, Entity] });
 *
 * queryRun(state, world, (bundle) => {
 *   // POD columns (f32 / u8 / fixed array<T,N> / fixed buffer<N>) surface as
 *   // writable TypedArray -- direct index assignment is fine.
 *   const xs = bundle.Position.x;
 *   const dxs = bundle.Velocity.dx;
 *   for (let i = 0; i < bundle.Entity.self.length; i++) {
 *     // strict `noUncheckedIndexedAccess`: TypedArray index returns number | undefined
 *     xs[i] = (xs[i] ?? 0) + (dxs[i] ?? 0);
 *   }
 *
 *   // Managed-vocab columns (string / ref<T> / variable buffer / variable
 *   // array<T>) surface as ManagedColumnReader<T> -- direct index assignment
 *   // is a TypeScript compile error. Read slot ids via .get(i); write
 *   // through the public dispatch.
 *   for (let i = 0; i < bundle.Entity.self.length; i++) {
 *     const slotId = bundle.Glyph.text.get(i);
 *     void slotId;
 *     const e = bundle.Entity.self[i];
 *     if (e !== undefined) world.set(e, Glyph, { text: 'updated' });
 *   }
 * });
 * ```
 */
export function createQueryState<
  const Cs extends ReadonlyArray<Component> = ReadonlyArray<Component>,
  const Os extends ReadonlyArray<Component> = ReadonlyArray<Component>,
>(descriptor: QueryDescriptor<Cs, Os>): QueryState<Cs, Os> {
  const optionalComponents = descriptor.optional ?? [];

  // Descriptor self-consistency, fail-fast at setup: `with` ∩ `optional` must
  // be empty (the two roles contradict).
  if (optionalComponents.length > 0) {
    const withTokenSet = new Set(descriptor.with);
    for (const optComp of optionalComponents) {
      if (withTokenSet.has(optComp)) {
        throw new QueryDescriptorOptionalConflictError(optComp.name);
      }
    }
  }

  return {
    descriptor,
    withIds: descriptor.with.map((c) => c.id),
    withoutIds: descriptor.without ? descriptor.without.map((c) => c.id) : [],
    optionalIds: optionalComponents.map((c) => c.id),
    matchedArchetypes: [],
    lastGeneration: 0,
    cachedBundles: new Map(),
  } as QueryState<Cs, Os>;
}

// ────────────────────────────────────────────────────────────────────────────
// Matching
// ────────────────────────────────────────────────────────────────────────────

/**
 * Check if an archetype matches the query descriptor.
 * With: archetype must contain ALL with-component IDs.
 * Without: archetype must contain NONE of the without-component IDs.
 *
 * `archetype.columns` carries an entry for every component in the archetype,
 * tag included (the entry is an empty per-field Map for zero-field schemas —
 * see `createArchetype` in archetype.ts). So `columns.has(id)` is the single
 * source of truth for membership; the historical `components.some(c => c.id)`
 * fallback was redundant.
 */
function archetypeMatches(
  arch: Archetype,
  withIds: ReadonlyArray<ComponentId>,
  withoutIds: ReadonlyArray<ComponentId>,
): boolean {
  for (const id of withIds) {
    if (!arch.columns.has(id)) return false;
  }
  for (const id of withoutIds) {
    if (arch.columns.has(id)) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Column bundle building
// ────────────────────────────────────────────────────────────────────────────

/**
 * `true` when the schema field type is a variable-capacity managed-vocab
 * keyword whose column carries u32 slot ids (`UniqueRefStore` /
 * `BufferPool`) -- direct index assignment would corrupt the slot table,
 * so the bundle wraps the column as a `ManagedColumnReader` (D-4 / D-7).
 *
 * Covers: `'string'`, `` `ref<T>` ``, variable `'buffer'`, variable
 * `` `array<T>` ``. Fixed `'buffer<N>'` / `` `array<T,N>` `` are inline
 * TypedArray rows -- not wrapped. `` `handle<X>` `` carries an unmanaged
 * AssetRegistry id (OOS-5) -- not wrapped, surfaces as `Uint32Array`.
 *
 * Reuses TYPE_METADATA via `isManagedField` (unique-ref-store keywords =
 * `'string'` + `` `ref<T>` ``); the buffer / array variable arms are
 * detected by exact-match on `'buffer'` and absent-comma on `'array<...>'`
 * (the comma form is fixed-capacity inline). Single source: the type
 * metadata column installed by feat-20260611.
 */
function isManagedVocabBundleField(fieldType: string): boolean {
  if (isManagedField(fieldType)) return true;
  if (fieldType === 'buffer') return true;
  if (fieldType.startsWith('array<') && !fieldType.includes(',')) return true;
  return false;
}

/**
 * Build the runtime `ManagedColumnReader` literal for a managed-vocab
 * column. Frozen on construction so consumers cannot patch in an index
 * setter; the reader caches the row-window subarray so `.get(i)` is one
 * indexed read with no per-call subarray allocation.
 *
 * The bundle cache (`state.cachedBundles`) invalidates on archetype version
 * change, so the reader is re-built once per archetype version transition --
 * not per frame, not per row.
 */
function makeManagedColumnReader(
  view: FieldView,
  length: number,
  fieldType: string,
): ManagedColumnReader<string> {
  const slots = view.subarray(0, length);
  return Object.freeze({
    length,
    get(i: number): number {
      return slots[i] ?? 0;
    },
    __managed: fieldType,
  });
}

/**
 * Append per-component column views into `bundle`. Shared by both the `with`
 * and `optional` passes — the only behavioural difference is which list is
 * walked. Tag / absent components are skipped (key absent in bundle).
 *
 * Slice length is `arch.size * col.arity`: scalar / variable columns have
 * `arity = 1` so the slice is `[row0, row1, ...]`; inline `array<T,N>` /
 * `buffer<N>` columns (feat-20260602) have `arity = N` so the slice exposes
 * the full stride-N flat data, with row `i` at `view.subarray(i*N, (i+1)*N)`.
 * Arity-aware slicing was retrofitted in bug-20260612 — prior versions
 * truncated inline columns to `arch.size` elements, exposing only column 0
 * of each row.
 *
 * Managed-vocab fields (the 4 `'string'` / `` `ref<T>` `` / variable
 * `'buffer'` / variable `` `array<T>` `` keywords, feat-20260614 M4 / D-4)
 * wrap the column slice as a frozen `ManagedColumnReader` literal: direct
 * index assignment is a TypeScript compile error (`TypedArrayFor<T>`
 * resolves to `ManagedColumnReader<T>` for these arms) and the runtime
 * shape (no index setter) backs the type-level guarantee. Mutation MUST
 * flow through `world.set` / `world.push` / `world.allocUniqueRef`.
 *
 * `comp.id` is the SSOT for column lookup; ids passed alongside `comp` would
 * be a derivable parallel array.
 */
function appendComponentColumns(
  bundle: Record<string, Record<string, FieldView | ManagedColumnReader<string>>>,
  components: ReadonlyArray<Component>,
  arch: Archetype,
): void {
  for (let i = 0; i < components.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounded by array length
    const comp = components[i]!;
    const fieldCols = arch.columns.get(comp.id);
    if (!fieldCols || fieldCols.size === 0) {
      // Tag component (empty schema) or component not in this archetype → skip
      continue;
    }
    const componentFields: Record<string, FieldView | ManagedColumnReader<string>> = {};
    for (const [fieldName, col] of fieldCols) {
      const sliceLen = arch.size * col.arity;
      const fieldType = comp.schema[fieldName];
      if (fieldType !== undefined && isManagedVocabBundleField(fieldType)) {
        componentFields[fieldName] = makeManagedColumnReader(col.view, sliceLen, fieldType);
      } else {
        componentFields[fieldName] = col.view.subarray(0, sliceLen);
      }
    }
    bundle[comp.name] = componentFields;
  }
}

/**
 * Build a nested column bundle for a matched archetype.
 * Structure: `{ ComponentName: { fieldName: TypedArray.subarray(0, size * arity) } }`.
 * Row count is `bundle.Entity.self.length` (Entity is essential).
 */
function buildColumnBundle(
  arch: Archetype,
  withComponents: ReadonlyArray<Component>,
  optionalComponents: ReadonlyArray<Component>,
): ColumnBundle {
  const bundle: Record<string, Record<string, ColumnBundleField>> = {};
  appendComponentColumns(bundle, withComponents, arch);
  appendComponentColumns(bundle, optionalComponents, arch);
  return bundle as ColumnBundle;
}

// ────────────────────────────────────────────────────────────────────────────
// Query execution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run a query and infer per-component bundle field types into `callback` —
 * `bundle.Comp.field` is a concrete TypedArray, not `unknown`.
 *
 * Uses incremental caching:
 *   - ArchetypeGeneration: only checks newly added archetypes since last run.
 *   - Per-archetype version stamp: rebuilds column bundle if archetype grew.
 *
 * `Cs` is inferred from `state` only; `NoInfer<Cs>` on the callback parameter
 * keeps callback bodies from feeding back into `Cs` inference (KD-2).
 *
 * @param state The QueryState (mutable — caches are updated in place).
 * @param world The World instance (provides access to archetype graph).
 * @param callback Called once per matched archetype with its column bundle.
 *
 * @example
 * ```ts
 * import { defineComponent, Entity, World, createQueryState, queryRun } from '@forgeax/engine-ecs';
 *
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * const Velocity = defineComponent('Velocity', { dx: 'f32', dy: 'f32' });
 *
 * const world = new World();
 * const state = createQueryState({ with: [Position, Velocity, Entity] });
 *
 * queryRun(state, world, (bundle) => {
 *   // bundle.Position.x: Float32Array — directly usable, no `as` cast.
 *   const xs = bundle.Position.x;
 *   const dxs = bundle.Velocity.dx;
 *   for (let i = 0; i < bundle.Entity.self.length; i++) {
 *     // strict `noUncheckedIndexedAccess`: TypedArray index returns number | undefined
 *     xs[i] = (xs[i] ?? 0) + (dxs[i] ?? 0);
 *   }
 * });
 * ```
 *
 * Managed-vocab field columns (`'string'` / `` `ref<T>` `` / variable
 * `'buffer'` / variable `` `array<T>` ``) expose `ManagedColumnReader<T>`
 * (read-only `length` + `get(i)`); direct index write is a TypeScript error.
 * Mutate via `world.set` / `world.push` / `world.allocUniqueRef`.
 */
export function queryRun<
  Cs extends ReadonlyArray<Component>,
  Os extends ReadonlyArray<Component> = readonly [],
>(
  state: QueryState<Cs, Os>,
  world: { /** @internal */ _getGraph(): ArchetypeGraph },
  callback: (bundle: NestedColumnBundle<NoInfer<Cs>, NoInfer<Os>>) => void,
): void {
  const graph = world._getGraph();

  // ── Incremental update: check new archetypes since last generation ──
  if (graph.generation > state.lastGeneration) {
    // Archetype count is typically 10-100 — re-scanning all is cheap enough
    // that tracking deltas would not pay back its bookkeeping cost.
    const newMatched: ArchetypeId[] = [];
    for (const arch of graph.archetypes) {
      if (!arch) continue;
      if (archetypeMatches(arch, state.withIds, state.withoutIds)) {
        newMatched.push(arch.id);
      }
    }
    state.matchedArchetypes = newMatched;
    state.lastGeneration = graph.generation;
  }

  // ── Iterate matched archetypes ──
  // Cache hit is valid iff version (column-buffer identity) AND size (live row
  // count, may shift without grow on add/remove) both match. Anything else
  // rebuilds. trusted-cast at the callback edge: F-R2 single-direction;
  // runtime correctness guaranteed by buildColumnBundle.
  const optionalComponents = state.descriptor.optional ?? [];
  const withComponents = state.descriptor.with;
  for (const archId of state.matchedArchetypes) {
    const arch = graph.archetypes[archId];
    if (!arch || arch.size === 0) continue;

    const cached = state.cachedBundles.get(archId);
    let bundle: ColumnBundle;
    if (cached && cached.version === arch.version && cached.size === arch.size) {
      bundle = cached.bundle;
    } else {
      bundle = buildColumnBundle(arch, withComponents, optionalComponents);
      state.cachedBundles.set(archId, { bundle, version: arch.version, size: arch.size });
    }
    callback(bundle as unknown as NestedColumnBundle<NoInfer<Cs>, NoInfer<Os>>);
  }
}

/**
 * Visit every unordered K-combination of the entities matched by `state`,
 * invoking `callback` once per combination with a K-tuple of `EntityHandle`s.
 *
 * This is the combinatorial counterpart of {@link queryRun} (single entities):
 * the canonical use is pairwise interaction — N-body gravity, collision
 * broadphase, flocking — where each unordered PAIR is processed exactly once.
 * It maps Bevy's `Query::iter_combinations[_mut]`, but is simpler: forgeax reads
 * and writes component data through handle-keyed `world.get` / `world.set`, so
 * there is no mutable-aliasing constraint (Bevy's `iter_combinations_mut` cursor
 * exists only to satisfy Rust's borrow checker — irrelevant here). The callback
 * receives handles; read each entity's components with `world.get(handle, Comp)`.
 *
 * `k` defaults to `2` (the pair case). Ordering is lexicographic over the
 * matched-entity order (ascending indices `i0 < i1 < ... < i(k-1)`); no self-
 * pairs, no ordered duplicates. `C(N, k)` combinations are yielded for `N`
 * matched entities; `k > N` (or `N === 0`) yields none. The `Entity` component
 * MUST be in the query's `with` list (the handle is the unit yielded) — omitting
 * it throws {@link QueryCombinationsEntityRequiredError} at the entry.
 *
 * The handle tuple passed to `callback` is REUSED across invocations (no per-
 * combination allocation, matching the hot-path no-GC idiom). Destructure it
 * (`([a, b]) => ...`) or copy it if you need to retain it past the callback.
 *
 * @param state The QueryState (mutable — caches are updated in place, same as queryRun).
 * @param world The World instance (provides access to the archetype graph).
 * @param k Combination size; defaults to 2.
 * @param callback Called once per unordered K-combination with the handle tuple.
 *
 * @example
 * ```ts
 * import { defineComponent, Entity, World, createQueryState, queryCombinations } from '@forgeax/engine-ecs';
 *
 * const Body = defineComponent('Body', { mass: 'f32' });
 * const state = createQueryState({ with: [Body, Transform, Entity] });
 *
 * // Apply each pair's mutual gravitational force once (Bevy's interact_bodies):
 * queryCombinations(state, world, 2, ([a, b]) => {
 *   const ta = world.get(a, Transform);
 *   const tb = world.get(b, Transform);
 *   if (!ta.ok || !tb.ok) return;
 *   // ... compute force from (tb.pos - ta.pos), accumulate into both bodies via world.set
 * });
 * ```
 */
export function queryCombinations<
  Cs extends ReadonlyArray<Component>,
  Os extends ReadonlyArray<Component> = readonly [],
>(
  state: QueryState<Cs, Os>,
  world: { /** @internal */ _getGraph(): ArchetypeGraph },
  k: number,
  callback: (handles: ReadonlyArray<EntityHandle>) => void,
): void {
  // Fail-fast: the yielded unit is the entity handle, read from bundle.Entity.self,
  // so Entity must be in `with` (mirrors the queryRun `bundle.Entity.self` contract).
  if (!state.descriptor.with.includes(Entity)) {
    throw new QueryCombinationsEntityRequiredError(state.descriptor.with.map((c) => c.name));
  }

  // Collect matched entity handles once (reuses queryRun's archetype walk + cache;
  // no duplicated matching logic — architecture-principles §1 SSOT). Entity is
  // runtime-guaranteed present (fail-fast above), so the bundle carries the
  // `Entity.self` column; the generic `Cs` can't prove it statically, hence the
  // narrow cast to the always-present shape.
  const handles: EntityHandle[] = [];
  queryRun(state, world, (bundle) => {
    const selfCol = (bundle as unknown as { Entity: { self: ArrayLike<number> } }).Entity.self;
    for (let i = 0; i < selfCol.length; i++) {
      handles.push((selfCol[i] ?? 0) as EntityHandle);
    }
  });

  const n = handles.length;
  if (k <= 0 || k > n) return;

  // Emit unordered K-combinations by ascending index (i0 < i1 < ... < i(k-1)).
  // An index-cursor walk — no per-combination allocation beyond the yielded tuple.
  const idx = new Array<number>(k);
  for (let j = 0; j < k; j++) idx[j] = j;
  const tuple = new Array<EntityHandle>(k);
  for (;;) {
    for (let j = 0; j < k; j++) tuple[j] = handles[idx[j] as number] as EntityHandle;
    callback(tuple);
    // Advance the rightmost cursor that can still move (standard combination step).
    let p = k - 1;
    while (p >= 0 && (idx[p] as number) === n - k + p) p--;
    if (p < 0) break;
    idx[p] = (idx[p] as number) + 1;
    for (let j = p + 1; j < k; j++) idx[j] = (idx[j - 1] as number) + 1;
  }
}
