// @forgeax/engine-ecs — world-component-access: component storage and access.
//
// This module owns component rows, managed storage, array operations, archetype
// migration, and the relationship callbacks that mutate component storage. World
// remains the typed facade and supplies one narrow per-World state capability.

import { err, ok, type Result, unwrapHandle } from '@forgeax/engine-types';
import { type Archetype, appendEntity } from './archetype';
import {
  type ArchetypeGraph,
  getAddEdge,
  getOrCreateArchetype,
  getRemoveEdge,
} from './archetype-graph';
import type { BufferPool } from './buffer-pool';
import { arrayCountColumnName, type FieldView, normalizeBufferWrite } from './column';
import {
  bufferFieldByteLength,
  type Component,
  type ComponentSchema,
  type InputShapeOf,
  isEntityField,
  isManagedBufferField,
  isManagedField,
  resolveComponent,
  type ShapeOf,
  TYPE_METADATA,
} from './component';
import { fillComponentDefaults, validateComponentDataKeys } from './component-default-fallback';
import { validateSharedFieldValues } from './component-value-validate';
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
  ComponentNotPresentError,
  EntityIndexOverflowError,
  FixedArrayOverflowError,
  FixedSizeMismatchError,
  RemoveEssentialComponentError,
  StaleEntityError,
} from './errors';
import type { ErrorContext } from './schedule';
import { Severity } from './schedule';
import type { SharedRefStore } from './shared-ref-store';
import type { UniqueRefStore } from './unique-ref-store';
import type {
  ArrayFieldElementValue,
  ArrayFieldsOf,
  ComponentData,
  EcsError,
  EntityRecord,
} from './world';
import { ComponentStorage } from './world-component-storage';

export interface ComponentAccessState {
  readonly graph: ArchetypeGraph;
  readonly records: EntityRecord[];
  readonly freeIndices: number[];
  readonly bufferPool: BufferPool;
  readonly uniqueRefs: UniqueRefStore;
  readonly sharedRefs: SharedRefStore;
  routeError(err: unknown, ctx: ErrorContext): void;
}

export class WorldComponentAccess {
  private readonly storage: ComponentStorage;

  constructor(private readonly state: ComponentAccessState) {
    this.storage = new ComponentStorage(state);
  }

  private get graph(): ArchetypeGraph {
    return this.state.graph;
  }

  private get records(): EntityRecord[] {
    return this.state.records;
  }

  private get freeIndices(): number[] {
    return this.state.freeIndices;
  }

  private get bufferPool(): BufferPool {
    return this.state.bufferPool;
  }

  private get uniqueRefs(): UniqueRefStore {
    return this.state.uniqueRefs;
  }

  private routeError(err: unknown, ctx: ErrorContext): void {
    this.state.routeError(err, ctx);
  }

  checkCardinality(component: Component, extraCount: number): CardinalityExceededError | null {
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

  relationshipTargetEntity(
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
  relationshipOnInsert(
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
  relationshipOnRemove(
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

    return ok(this.storage.readRow(arch, component, rec.row));
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
    return this.storage.readArrayView(arch, component, rec.row, fieldName);
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
    // feat-20260713 M2 / w9: P3 shared-field value gate (see _spawnCore). Runs
    // before any column write so a mis-bound GUID aborts before the scalar /
    // array packer would zero the field — the set never partially lands.
    const sharedErr = validateSharedFieldValues(component, value as Record<string, unknown>);
    if (sharedErr !== null) {
      return err(sharedErr as unknown as EcsError);
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
        this.storage.releaseManagedFieldOnRow(arch, component, rec.row, fieldName);
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
            this.storage.releaseManagedFieldOnRow(arch, component, rec.row, fieldName);
            const allocR = this.bufferPool.alloc(bytes.byteLength);
            if (!allocR.ok) {
              const ctx: ErrorContext = {
                severity: Severity.Error,
                systemName: `World.set (${component.name}.${fieldName})`,
              };
              this.routeError(allocR.error, ctx);
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
          this.storage.releaseManagedFieldOnRow(arch, component, rec.row, fieldName);
          this.storage.writeArrayField(
            arch,
            component,
            rec.row,
            fieldName,
            fieldType,
            arrayMeta,
            raw,
          );
        } else {
          // The pre-write `releaseManagedFieldOnRow` block above already
          // released the prior `'shared<T>'` rc via SharedRefStore.release;
          // here we retain the new value so net rc delta is +1 / 0 / -1 per
          // M4 invariant (set: -1+1=0; spawn: 0+1=+1; despawn: -1).
          col.view[rec.row] = raw as number;
          if (fieldType.startsWith('shared<') && (raw as number) !== 0) {
            this.storage.retainSharedScalarHandle(raw as number, component.name, fieldName);
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
      // A previously-allocated slot may have drained below its high-water
      // mark: swap-remove (`_removeArrayElementByValue`) and `pop` only lower
      // the count column, never shrink the managed buffer. When the refilled
      // length still fits inside the slot's current logical length, reuse the
      // buffer in place -- routing through `grow` would hit the (correct, but
      // here irrelevant) shrink-not-supported guard and strand the field
      // (e.g. `Children.entities` never repopulating after a full drain).
      if (newByteLength > this.bufferPool.view(liveSlotId).byteLength) {
        const growR = this.bufferPool.grow(liveSlotId, newByteLength);
        if (!growR.ok) return err(growR.error);
      }
    }
    const liveBytes = this.bufferPool.view(liveSlotId);
    // Reinterpret the slot bytes as the element-typed view and write at the
    // tail index. Entity values are stored as their u32 bit pattern.
    this.storage.writeArrayElementAt(liveBytes, count, arrayMeta.elementType, value as number);
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
    const value = this.storage.readArrayElementAt(liveBytes, count - 1, arrayMeta.elementType);
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
      if (this.storage.readArrayElementAt(liveBytes, i, arrayMeta.elementType) === target) {
        const last = count - 1;
        if (i !== last) {
          const tail = this.storage.readArrayElementAt(liveBytes, last, arrayMeta.elementType);
          this.storage.writeArrayElementAt(liveBytes, i, arrayMeta.elementType, tail);
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
    // feat-20260713 M2 / w9: P3 shared-field value gate (see _spawnCore). Runs
    // before archetype mutation so a mis-bound GUID aborts cleanly.
    const sharedErr = validateSharedFieldValues(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    if (sharedErr !== null) {
      return err(sharedErr as unknown as EcsError);
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
    this.storage.migrateEntity(rec, srcArch, targetArch);

    // Write the new component's data. Apply layer-2 + layer-3 silent
    // fallback so addComponent shares the SAME default-resolution path
    // as spawn / SceneAsset.instantiate (feat-20260517 / M2 / AC-04
    // research §F4 auto-symmetry; ComponentData<S>['data'] is the
    // physical bridge).
    const filled = fillComponentDefaults(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    this.storage.writeRow(targetArch, componentData.component, rec.row, filled as ShapeOf<S>);

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
      const oldValue = this.storage.readRow(srcArch, component as Component, rec.row) as Record<
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
    this.storage.releaseManagedRefsOnRow(srcArch, component as Component, rec.row);

    // Get target archetype via edge cache.
    const targetArch = getRemoveEdge(this.graph, srcArch, localId);

    // Migrate entity: copy all data except the removed component.
    this.storage.migrateEntity(rec, srcArch, targetArch);
    return ok(undefined);
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
      this.storage.writeRow(arch, cd.component, row, filled as ShapeOf<ComponentSchema>);
    }

    // Essential id=0 `Entity` column write (feat-20260602 / plan-strategy D-3),
    // mirroring the synchronous `spawn` path: the deferred handle was minted at
    // `_allocatePendingEntity` time and is passed in here.
    this.storage.writeEntitySelf(arch, row, entity);

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

  allocateIndex(): number {
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
  recordIsLive(record: EntityRecord | undefined, gen: number): record is EntityRecord {
    return record !== undefined && record.generation === gen && record.archetypeId !== -1;
  }

  lookupAlive(
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

  readRow<S extends ComponentSchema>(
    arch: Archetype,
    component: Component<string, S>,
    row: number,
  ): ShapeOf<S> {
    return this.storage.readRow(arch, component, row);
  }

  writeEntitySelf(arch: Archetype, row: number, handle: EntityHandle): void {
    this.storage.writeEntitySelf(arch, row, handle);
  }

  writeRow<S extends ComponentSchema>(
    arch: Archetype,
    component: Component<string, S>,
    row: number,
    value: ShapeOf<S>,
  ): void {
    this.storage.writeRow(arch, component, row, value);
  }

  releaseManagedRefsOnRow(arch: Archetype, component: Component, row: number): void {
    this.storage.releaseManagedRefsOnRow(arch, component, row);
  }

  expandCoAttach(componentDatas: ComponentData[]): ComponentData[] {
    return this.storage.expandCoAttach(componentDatas);
  }
}
