// @forgeax/engine-ecs — Archetype: a set of entities sharing the same component set.
//
// Per-field independent ArrayBuffer columns (D-01). Sorted ComponentId key.
// Swap-pop deletion. Version stamp for query cache invalidation (D-10).

import { arrayCountColumnName, type Column, createColumn, growColumn } from './column';
import {
  bufferFieldByteLength,
  type Component,
  type ComponentId,
  fieldTypeToMetaKey,
  isManagedBufferField,
  parseManagedArraySchema,
  type ScalarFieldType,
  TYPE_METADATA,
} from './component';
import { Entity, foldEssentials } from './entity';

/** Initial archetype capacity. Doubles on demand. */
const INITIAL_CAPACITY = 64;

/** Unique archetype identifier (index into ArchetypeGraph.archetypes array). */
export type ArchetypeId = number;

/**
 * Per-archetype storage.
 *
 * - `key`: sorted ComponentId join, always prefixed by the essential id=0
 *   `Entity` column (e.g. "0+2+5+7")
 * - `columns`: Map<ComponentId, Map<fieldName, Column>>
 * - `version`: incremented on capacity grow (query cache invalidation)
 *
 * `componentIds` is derived from `components.map(c => c.id)` on demand.
 * Entity identity lives in the id=0 `Entity` component's `self` column
 * (read via `columns.get(0)?.get('self')?.view[row] & 0xffffff`).
 */
export interface Archetype {
  readonly id: ArchetypeId;
  readonly key: string;
  readonly components: ReadonlyArray<Component>;
  /** columns.get(componentId)?.get(fieldName) → Column */
  columns: Map<ComponentId, Map<string, Column>>;
  /** Number of live rows. */
  size: number;
  /** Allocated row count. */
  capacity: number;
  /** Version stamp. Incremented on grow. */
  version: number;
  /** Edges cache for addComponent. */
  addEdges: Map<ComponentId, ArchetypeId>;
  /** Edges cache for removeComponent. */
  removeEdges: Map<ComponentId, ArchetypeId>;
}

// Archetype IDs are now allocated by ArchetypeGraph (per-World, O-3).

/**
 * Compute sorted archetype key from ComponentIds.
 *
 * Essential ids (`ESSENTIAL_COMPONENT_IDS`, currently `[Entity.id]`) are folded
 * into the input via `foldEssentials` so the key matches the columns built by
 * `createArchetype` even when the caller's component set omits them (e.g. a
 * bare `world.spawn()` passes no ids). Folding is idempotent -- a set already
 * containing every essential id is returned as-is (deduped). Example:
 * `[2, 5, 7]` -> `"0+2+5+7"`.
 */
export function archetypeKey(componentIds: ReadonlyArray<ComponentId>): string {
  return [...foldEssentials(componentIds)].sort((a, b) => a - b).join('+');
}

/**
 * Create a fresh archetype with INITIAL_CAPACITY rows.
 * @param components - Component tokens whose ids define the archetype.
 *   `componentIds` is derived from `components.map(c => c.id)`.
 *   Essential ids are folded in via `foldEssentials`.
 * @param archId - Archetype ID allocated by ArchetypeGraph (per-World, O-3).
 */
export function createArchetype(components: ReadonlyArray<Component>, archId: number): Archetype {
  const capacity = INITIAL_CAPACITY;
  const componentIds = components.map((c) => c.id);
  // Essential id=0 `Entity` column (feat-20260602 / plan-strategy D-3): every
  // archetype carries the Entity column unconditionally so the row stores its
  // own packed handle (read via the same query / readRow path as any column).
  // Fold the essential id list (`ESSENTIAL_COMPONENT_IDS`, currently just
  // `Entity.id`) into the input ids via `foldEssentials` -- idempotently, so a
  // set that already includes Entity (the addComponent edge path inherits it
  // from the source archetype) does not duplicate the column. The matching
  // key fold lives in `archetypeKey`. The `components` array is then aligned
  // to the folded ids: we keep the caller-supplied components in order and
  // prepend the `Entity` component token only when fold actually inserted
  // `Entity.id` (i.e. the input did NOT already include it).
  const baseIds = foldEssentials(componentIds);
  const baseComponents = componentIds.includes(Entity.id)
    ? components
    : [Entity as unknown as Component, ...components];
  // Sort the (id, component) PAIRS together so the stored `componentIds` and
  // `components` arrays stay positionally aligned. Callers (`getAddEdge`) zip
  // `[...src.componentIds, newId]` with `[...src.components, newComp]`; because
  // `src.componentIds` is sorted but the incoming `components` are in insertion
  // order, the two arrays can be positionally misaligned. Sorting the pairs
  // here makes alignment a local invariant of every archetype, so the column
  // build loop below pairs each `compId` with its OWN component schema (a
  // misaligned pair builds the column for one component from another's schema,
  // silently dropping the field and losing the migrated data — the chained
  // `addComponent` column-loss bug surfaced by feat-20260531 layout-system).
  const pairs = baseIds.map((id, i) => [id, baseComponents[i]] as const);
  pairs.sort((a, b) => a[0] - b[0]);
  const sortedIds = pairs.map((p) => p[0]);
  const sortedComponents = pairs.map((p) => p[1] as Component);
  const key = sortedIds.join('+');
  const id = archId;

  // Build per-component, per-field columns.
  // Use the provided componentIds (global component.id values) as column keys.
  const columns = new Map<ComponentId, Map<string, Column>>();
  for (let i = 0; i < sortedComponents.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounded by sortedComponents.length
    const comp = sortedComponents[i]!;
    // biome-ignore lint/style/noNonNullAssertion: sortedIds and sortedComponents arrays are same length
    const compId = sortedIds[i]!;
    const fieldCols = new Map<string, Column>();
    for (const [fieldName, fieldType] of Object.entries(comp.schema)) {
      // Vocabulary fork (feat-20260602): fixed-capacity `array<T,N>` /
      // `buffer<N>` fields store their elements INLINE in a stride-N column
      // (arity = N), never a BufferPool slot id. Variable-capacity
      // `array<T>` / `buffer` and scalar fields keep the slot-id / scalar u32
      // column (arity = 1). The two families use DIFFERENT fixed predicates:
      //   - array: `parseManagedArraySchema(t).length !== undefined`
      //   - buffer: `isManagedBufferField(t) && t !== 'buffer'`
      //     (`parseManagedArraySchema('buffer<64>')` is null, so the array
      //      predicate never fires for buffers).
      const arrayMeta = parseManagedArraySchema(fieldType);
      if (arrayMeta !== null && arrayMeta.length !== undefined) {
        // Fixed `array<T,N>`: inline stride-N column. The element-typed
        // storage (TYPE_METADATA[key].storage; `entity` -> `u32`, scalars
        // identity) holds the elements themselves; no slot-id indirection
        // and no `:count` sidecar (count === N is implicit).
        const elemKey = fieldTypeToMetaKey(arrayMeta.elementType);
        const elemStorage: ScalarFieldType | null =
          elemKey === null ? null : (TYPE_METADATA[elemKey]?.storage ?? null);
        if (elemStorage === null) continue;
        fieldCols.set(fieldName, createColumn(elemStorage, capacity, arrayMeta.length));
        continue;
      }
      if (isManagedBufferField(fieldType) && fieldType !== 'buffer') {
        // Fixed `buffer<N>`: inline stride-N column of raw bytes. Buffer has
        // no element-type concept, so the storage is always `u8` and arity is
        // the schema-declared byte count N. No `:count` sidecar (N is fixed).
        fieldCols.set(fieldName, createColumn('u8', capacity, bufferFieldByteLength(fieldType)));
        continue;
      }

      // Schema-vocab keywords (`ref<T>` / `handle<T>` / `entity`) and
      // variable `array<T>` / `buffer` route to a u32 slot-id / scalar
      // column via the global TYPE_METADATA table (replaces the retired
      // storageFieldType). Vocab family keywords normalise to their family
      // key; legacy scalars are direct keys.
      const metaKey = fieldTypeToMetaKey(fieldType);
      if (metaKey === null) continue;
      const storage: ScalarFieldType | null = TYPE_METADATA[metaKey]?.storage ?? null;
      if (storage === null) continue;
      fieldCols.set(fieldName, createColumn(storage, capacity));
      // D-3 double-column for `array<T>` variable-capacity fields: a
      // sidecar u32 column carries the live element count alongside the
      // primary slot-id column. `array<T,N>` fixed-capacity fields skip
      // this branch (count === capacity === N is implicit). Capacity is
      // never stored independently — it is derived from the BufferPool
      // slot's byteLength on demand (F-4).
      if (arrayMeta !== null && arrayMeta.length === undefined) {
        fieldCols.set(arrayCountColumnName(fieldName), createColumn('u32', capacity));
      }
    }
    columns.set(compId, fieldCols);
  }

  return {
    id,
    key,
    components: sortedComponents,
    columns,
    size: 0,
    capacity,
    version: 0,
    addEdges: new Map(),
    removeEdges: new Map(),
  };
}

/**
 * Append an entity to the archetype. Returns the row index.
 * Automatically grows if at capacity.
 * Entity index is stored in the id=0 `Entity` column's `self` field.
 */
export function appendEntity(arch: Archetype, entityIndexSlot: number): number {
  if (arch.size === arch.capacity) {
    growArchetype(arch, arch.capacity * 2);
  }
  const row = arch.size;
  // Write entity index into the id=0 self column (Entity component).
  const selfCol = arch.columns.get(Entity.id)?.get('self');
  if (selfCol) {
    selfCol.view[row] = entityIndexSlot;
  }
  arch.size = row + 1;
  return row;
}

/**
 * Remove entity at `row` via swap-pop.
 * Returns info about the swapped entity, or null if the removed row was the last.
 *
 * The moved entity index is read from the id=0 `Entity` column's `self` field
 * (not a separate `entities` array — feat-20260611 D-2 single-field Archetype).
 */
export function removeEntity(
  arch: Archetype,
  row: number,
): { movedEntity: number; newRow: number } | null {
  const lastRow = arch.size - 1;

  if (row !== lastRow) {
    // Swap last row into the removed row.
    // Read moved entity index from the id=0 self column (lower 24 bits).
    const selfCol = arch.columns.get(Entity.id)?.get('self');
    const movedEntity = (selfCol?.view[lastRow] ?? 0) & 0xffffff;
    // Write moved entity index to the new row in the self column
    if (selfCol) {
      // biome-ignore lint/style/noNonNullAssertion: selfCol is defined in this branch
      const v = selfCol.view[lastRow]!;
      selfCol.view[row] = v;
    }

    // Swap column data. Every column carries `arity` elements per row
    // (stride): scalar / variable / `:count` columns have arity 1; fixed
    // inline `array<T,N>` / `buffer<N>` columns have arity N. The stride-N
    // block is migrated whole via `set` + `subarray`; arity 1 degenerates to
    // a single-element copy, byte-identical to the prior `view[row]` form.
    for (const [_compId, fieldCols] of arch.columns) {
      for (const [_fieldName, col] of fieldCols) {
        const arity = col.arity;
        col.view.set(col.view.subarray(lastRow * arity, lastRow * arity + arity), row * arity);
      }
    }

    arch.size = lastRow;
    return { movedEntity, newRow: row };
  }

  // Removing the last row: just decrement size.
  arch.size = lastRow;
  return null;
}

/**
 * Grow archetype to at least `targetCapacity`. Doubles capacity.
 * Increments version stamp.
 */
export function growArchetype(arch: Archetype, targetCapacity: number): void {
  let newCap = arch.capacity;
  while (newCap < targetCapacity) {
    newCap *= 2;
  }
  if (newCap === arch.capacity) {
    return;
  }

  // Grow each column independently (D-01: per-field buffer).
  for (const [compId, fieldCols] of arch.columns) {
    const newFieldCols = new Map<string, Column>();
    for (const [fieldName, col] of fieldCols) {
      newFieldCols.set(fieldName, growColumn(col, newCap));
    }
    arch.columns.set(compId, newFieldCols);
  }

  arch.capacity = newCap;
  arch.version += 1;
}
