// @forgeax/engine-ecs — world-component-access: component storage and access.
//
// This module owns component rows, managed storage, array operations, archetype
// migration, and the relationship callbacks that mutate component storage. World
// remains the typed facade and supplies one narrow per-World state capability.

import { err, isRetiredSlot, ok, type Result, unwrapHandle } from '@forgeax/engine-types';
import type { BufferPool } from './buffer-pool';
import {
  bufferFieldByteLength,
  type Component,
  type ComponentSchema,
  componentId,
  componentSchema,
  type InputShapeOf,
  isEntityField,
  isManagedBufferField,
  isManagedField,
  type ManagedArrayElementType,
  type ManagedArrayElementValue,
  type ShapeOf,
  TYPE_METADATA,
} from './component';
import { fillComponentDefaults, validateComponentDataKeys } from './component-default-fallback';
import { componentDefinition } from './component-schema';
import { validateManagedArrayValues, validateSharedFieldValues } from './component-value-validate';
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
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  EntityIndexOverflowError,
  FixedSizeMismatchError,
  ManagedBufferOutOfBoundsError,
  RelationshipSelfCycleError,
  RelationshipTargetReadonlyError,
  RemoveEssentialComponentError,
  StaleEntityError,
  validateEnumFieldValues,
  validateNumericFieldValues,
} from './errors';
import {
  isRelationshipTarget,
  RelationshipIndex,
  relationshipMirror,
  relationshipRole,
} from './relationship-index';
import type { SharedRefStore } from './shared-ref-store';
import { type Archetype, appendArchetypeRow } from './storage/archetype';
import {
  type ArchetypeGraph,
  getAddEdge,
  getOrCreateArchetype,
  getRemoveEdge,
  getTable,
} from './storage/archetype-graph';
import { removeSparseTag } from './storage/change-detection';
import { arrayCountColumnName, type FieldView, normalizeBufferWrite } from './storage/column';
import { appendTableRow, type Table } from './storage/table';
import type { UniqueRefStore } from './unique-ref-store';
import type { ComponentData, EcsError, EntityRecord } from './world';
import { ComponentStorage } from './world-component-storage';

type ErrorContext = { readonly systemName: string };

type ArrayFieldsOf<S extends ComponentSchema> = {
  [K in keyof S]: S[K] extends
    | `array<${ManagedArrayElementType}>`
    | `array<${ManagedArrayElementType}, ${number}>`
    ? K
    : never;
}[keyof S];

type ArrayFieldElementValue<
  S extends ComponentSchema,
  K extends keyof S,
> = S[K] extends `array<${infer Elem extends ManagedArrayElementType}>`
  ? ManagedArrayElementValue<Elem>
  : S[K] extends `array<${infer Elem extends ManagedArrayElementType}, ${number}>`
    ? ManagedArrayElementValue<Elem>
    : never;

function relationshipPayloadWrites(data: Readonly<Record<string, unknown>>): boolean {
  return Object.values(data).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (ArrayBuffer.isView(value)) return value.byteLength > 0;
    return true;
  });
}

export interface ComponentAccessState {
  readonly graph: ArchetypeGraph;
  readonly records: EntityRecord[];
  readonly freeIndices: number[];
  readonly bufferPool: BufferPool;
  readonly uniqueRefs: UniqueRefStore;
  readonly sharedRefs: SharedRefStore;
  readonly relationshipIndexes: Map<number, RelationshipIndex>;
  readonly markComponentAdded: (entity: EntityHandle, componentId: number) => void;
  readonly markComponentsAdded: (entity: EntityHandle, componentIds: readonly number[]) => void;
  readonly markComponentChanged: (entity: EntityHandle, componentId: number) => void;
  readonly removeComponentChange: (entity: EntityHandle, componentId: number) => void;
  readonly markStructureChanged: () => void;
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

  private table(archetype: Archetype): Table {
    return getTable(this.graph, archetype.tableId);
  }

  private tableRow(record: EntityRecord): number {
    return this.graph.archetypes[record.archetypeId]?.rows[record.archetypeRow] ?? -1;
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

  private relationshipIndex(component: Component): RelationshipIndex | undefined {
    if (relationshipRole(component)?.kind !== 'source') return undefined;
    let index = this.state.relationshipIndexes.get(componentId(component));
    if (index === undefined) {
      index = new RelationshipIndex();
      this.state.relationshipIndexes.set(componentId(component), index);
    }
    return index;
  }

  /** Read the World-owned materialized target array; never consults a shadow list. */
  relationshipTargetEntries(source: Component, target: EntityHandle): readonly EntityHandle[] {
    const role = relationshipRole(source);
    if (role?.kind !== 'source') return [];
    const mirror = relationshipMirror(source);
    if (mirror === undefined) return [];
    const result = this.get(target, mirror);
    if (!result.ok) return [];
    const entries = (result.value as Record<string, unknown>)[role.targetField];
    return entries !== undefined && typeof entries === 'object' ? (entries as EntityHandle[]) : [];
  }

  private markComponentAdded(entity: EntityHandle, component: Component): void {
    this.state.markComponentAdded(entity, componentId(component));
  }

  private markComponentChanged(entity: EntityHandle, component: Component): void {
    this.state.markComponentChanged(entity, componentId(component));
  }

  private markStructureChanged(): void {
    this.state.markStructureChanged();
  }

  relationshipTargetEntity(
    component: Component,
    value: Record<string, unknown>,
  ): EntityHandle | null {
    for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
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

  private preflightComponentFieldValues(
    holder: EntityHandle | null,
    componentData: ComponentData,
  ): Result<void, EcsError> {
    const data = componentData.data as Record<string, unknown>;
    const arrayError = validateManagedArrayValues(componentData.component, data);
    if (arrayError !== null) return err(arrayError as unknown as EcsError);
    const sharedError = validateSharedFieldValues(componentData.component, data);
    if (sharedError !== null) return err(sharedError as unknown as EcsError);
    const numericError = validateNumericFieldValues(
      componentData.component,
      data,
      holder === null ? undefined : (holder as number),
    );
    if (numericError !== null) return err(numericError as unknown as EcsError);
    return ok(undefined);
  }

  /**
   * Validate one structural component payload without touching archetypes,
   * columns, relationship mirrors, epochs, or managed-reference stores.
   * CommandBuffer uses this same owner-level gate as the direct World facade;
   * the optional pending set lets a batch refer to an entity reserved earlier
   * in that batch without mistaking it for a stale live handle.
   */
  preflightComponentData(
    holder: EntityHandle | null,
    componentData: ComponentData,
    pendingEntities?: ReadonlySet<number>,
    unavailableEntities?: ReadonlySet<number>,
  ): Result<void, EcsError> {
    const data = componentData.data as Record<string, unknown>;
    const keyError = validateComponentDataKeys(componentData.component, data);
    if (keyError !== null) return err(keyError as unknown as EcsError);
    const valuePreflight = this.preflightComponentFieldValues(holder, componentData);
    if (!valuePreflight.ok) return valuePreflight;
    if (isRelationshipTarget(componentData.component) && relationshipPayloadWrites(data)) {
      return err(new RelationshipTargetReadonlyError(componentData.component.name, 'command'));
    }

    const filled = fillComponentDefaults(componentData.component, data);
    const enumError = validateEnumFieldValues(
      componentData.component,
      filled,
      holder === null ? undefined : (holder as number),
    );
    if (enumError !== null) return err(enumError as unknown as EcsError);

    const role = relationshipRole(componentData.component as Component);
    if (role?.kind !== 'source') return ok(undefined);
    const target = this.relationshipTargetEntity(componentData.component as Component, filled);
    if (target === null) return ok(undefined);

    const targetRaw = target as unknown as number;
    if (unavailableEntities?.has(targetRaw) === true) {
      const targetRecord = this.records[entityIndex(target)];
      return err(
        new StaleEntityError(target as number, entityIndex(target), entityGeneration(target), {
          operation: 'relationship-insert',
          component: componentData.component.name,
          expectedGeneration: entityGeneration(target),
          actualGeneration: targetRecord?.generation ?? -1,
        }),
      );
    }
    const targetIsPending = pendingEntities?.has(targetRaw) === true;
    const targetRecord = this.records[entityIndex(target)];
    const actualGeneration = targetRecord?.generation ?? -1;
    const targetLive = this.recordIsLive(targetRecord, entityGeneration(target));
    const holderIsPending =
      holder === null || pendingEntities?.has(holder as unknown as number) === true;
    if (!targetIsPending && !targetLive && !holderIsPending) {
      return err(
        new StaleEntityError(target as number, entityIndex(target), entityGeneration(target), {
          operation: 'relationship-insert',
          component: componentData.component.name,
          expectedGeneration: entityGeneration(target),
          actualGeneration,
        }),
      );
    }

    // A pending holder has no row to walk yet. Once materialized, its target
    // is still checked by the same source-side relationship callback.
    if (holder === null || pendingEntities?.has(holder as unknown as number) === true) {
      return ok(undefined);
    }
    const roleAllowsSelf = role?.kind === 'source' && role.allowSelf;
    if (holder === target && !roleAllowsSelf) {
      return err(
        new RelationshipSelfCycleError(
          componentData.component.name,
          holder as number,
          target as number,
        ),
      );
    }

    const cycleHit =
      holder === target && roleAllowsSelf
        ? null
        : this.relationshipCycleHit(componentData.component as Component, target, holder);
    if (cycleHit !== null) {
      return err(
        new RelationshipSelfCycleError(
          componentData.component.name,
          holder as number,
          cycleHit as number,
        ),
      );
    }
    return ok(undefined);
  }

  private relationshipCycleHit(
    holderComponent: Component,
    start: EntityHandle,
    holder: EntityHandle,
  ): EntityHandle | null {
    const visited = new Set<number>();
    let current = start;
    while (true) {
      if (current === holder) return current;
      const raw = current as unknown as number;
      if (visited.has(raw)) return null;
      visited.add(raw);
      const record = this.records[entityIndex(current)];
      if (!this.recordIsLive(record, entityGeneration(current))) return null;
      const archetype = this.graph.archetypes[record.archetypeId];
      if (
        !archetype?.components.some(
          (candidate) => componentId(candidate) === componentId(holderComponent),
        )
      ) {
        return null;
      }
      const value = this.readRow(archetype, holderComponent, this.tableRow(record)) as Record<
        string,
        unknown
      >;
      const next = this.relationshipTargetEntity(holderComponent, value);
      if (next === null) return null;
      current = next;
    }
  }

  /** Prepare the target side before a source archetype mutation commits. */
  private prepareRelationshipInsert(
    component: Component,
    value: Record<string, unknown>,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);
    const target = this.relationshipTargetEntity(component, value);
    if (target === null) return ok(undefined);
    const mirror = relationshipMirror(component);
    if (mirror === undefined) return ok(undefined);
    const targetRec = this.records[entityIndex(target)];
    const actualGeneration = targetRec?.generation ?? -1;
    if (!this.recordIsLive(targetRec, entityGeneration(target))) {
      return err(
        new StaleEntityError(target as number, entityIndex(target), entityGeneration(target), {
          operation: 'relationship-insert',
          component: component.name,
          expectedGeneration: entityGeneration(target),
          actualGeneration,
        }),
      );
    }
    const targetArch = this.graph.archetypes[targetRec.archetypeId];
    const hasMirror =
      targetArch?.components.some((candidate) => componentId(candidate) === componentId(mirror)) ??
      false;
    if (!hasMirror) {
      const added = this._addComponentCore(
        target,
        { component: mirror, data: {} as Partial<ShapeOf<ComponentSchema>> },
        true,
      );
      if (!added.ok) return added;
    }
    const length = this.relationshipTargetEntries(component, target).length;
    return this.ensureArrayCapacity(target, mirror, role.targetField as never, length + 1);
  }

  /** Append `holder` to the materialized target list. */
  relationshipOnInsert(
    holder: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);
    const target = this.relationshipTargetEntity(component, value);
    if (target === null) return ok(undefined);
    const mirror = relationshipMirror(component);
    /* istanbul ignore next -- defineComponent relationship validation guarantees mirror exists */
    if (mirror === undefined) return ok(undefined);

    const prepared = this.prepareRelationshipInsert(component, value);
    if (!prepared.ok) {
      // A dangling source edge is still useful state: hierarchy/animation
      // projections report the missing target. The target mirror cannot be
      // updated, but insertion itself remains atomic and successful.
      if (prepared.error.code === 'stale-entity') return ok(undefined);
      return prepared;
    }

    // Lazy-create the mirror component on the target when absent (D-3c).
    const targetSlot = entityIndex(target);
    const targetRec = this.records[targetSlot];
    if (!this.recordIsLive(targetRec, entityGeneration(target))) return ok(undefined);
    const targetArch = this.graph.archetypes[targetRec.archetypeId];
    const mirrorLocalId = componentId(mirror);
    const hasMirror =
      targetArch?.components.some((component) => componentId(component) === mirrorLocalId) ?? false;
    if (!hasMirror) {
      const added = this._addComponentCore(
        target,
        {
          component: mirror,
          data: {} as Partial<ShapeOf<ComponentSchema>>,
        },
        true,
      );
      if (!added.ok) return added;
    }
    const targetEntries = this.relationshipTargetEntries(component, target);
    const slot = targetEntries.length;
    const mirrored = this.appendArrayElement(
      target,
      mirror as Component<string, ComponentSchema>,
      role.targetField as never,
      holder as never,
    );
    if (!mirrored.ok) return mirrored;
    this.relationshipIndex(component)?.attach(holder, target, slot);
    return ok(undefined);
  }

  /** Remove `holder` from the materialized target list. */
  relationshipOnRemove(
    holder: EntityHandle,
    component: Component,
    oldValue: Record<string, unknown>,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);
    const target = this.relationshipTargetEntity(component, oldValue);
    if (target === null) return ok(undefined);
    const mirror = relationshipMirror(component);
    /* istanbul ignore next -- defineComponent relationship validation guarantees mirror exists */
    if (mirror === undefined) return ok(undefined);
    const targetSlot = entityIndex(target);
    const targetRec = this.records[targetSlot];
    if (!this.recordIsLive(targetRec, entityGeneration(target))) return ok(undefined);

    const index = this.relationshipIndex(component);
    if (index === undefined) return ok(undefined);
    const slot = index.slotOf(holder);
    if (slot === undefined || index.targetOf(holder) !== target) return ok(undefined);
    const mirrored = this.removeArrayElementAt(
      target,
      mirror as Component<string, ComponentSchema>,
      role.targetField as never,
      slot,
    );
    if (!mirrored.ok) return mirrored;
    index.detach(holder);
    if (mirrored.value !== undefined) index.updateSlot(mirrored.value, target, slot);
    return ok(undefined);
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
    const localId = componentId(component);
    if (!arch.components.some((candidate) => componentId(candidate) === localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    return ok(this.storage.readRow(arch, component, this.tableRow(rec)));
  }

  /**
   * Column-level zero-copy view of an `array<T, N>` / `array<T>` field.
   *
   * Resolves the live byte region for `(entity, component, fieldName)`
   * directly at the column level and returns the element-typed TypedArray
   * aliasing it (`view.buffer` is the SSOT byte region; mutations route
   * through `world.set`). Unlike `get`, this does NOT build the
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
    return this.storage.readArrayView(arch, component, this.tableRow(rec), fieldName);
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
    markChanged = true,
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
    const localId = componentId(component);
    if (!arch.components.some((candidate) => componentId(candidate) === localId)) {
      // F-02: set on missing component returns err instead of silent ignore
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const valuePreflight = this.preflightComponentFieldValues(entity, {
      component,
      data: value,
    });
    if (!valuePreflight.ok) return valuePreflight;
    const currentValue = this.storage.readRow(arch, component, this.tableRow(rec)) as Record<
      string,
      unknown
    >;
    const enumError = validateEnumFieldValues(
      component,
      { ...currentValue, ...(value as Record<string, unknown>) },
      entity as number,
    );
    if (enumError !== null) return err(enumError as unknown as EcsError);
    if (component.storage === 'sparse') {
      if (markChanged) this.markComponentChanged(entity, component);
      return ok(undefined);
    }
    const fieldCols = this.table(arch).storage.get(localId)?.fields;
    if (fieldCols === undefined) {
      throw new Error(`Table storage for ${component.name} does not exist.`);
    }
    for (const fieldName of Object.keys(value)) {
      const col = fieldCols.get(fieldName);
      if (!col) {
        continue;
      }
      const fieldType = (componentSchema(component) as Record<string, string>)[fieldName] ?? '';
      // M1/M2 release loop (set path): release the prior managed value
      // BEFORE writing the new one. Single SSOT helper `releaseManagedFieldOnRow`
      // (feat-20260614 D-2) covers every managed-field family (`ref<T>` /
      // `string` / `buffer` / variable `array<T>`); it self-skips fields that
      // do not match `isManagedField` here, but for set-ref/string we already
      // gated on it so the call is hot. Zeroes the column when applicable.
      if (isManagedField(fieldType)) {
        this.storage.releaseManagedFieldOnRow(arch, component, this.tableRow(rec), fieldName);
      }
      const raw = (value as Record<string, unknown>)[fieldName];
      if (fieldType === 'bool') {
        col.view[this.tableRow(rec)] = raw ? 1 : 0;
      } else if (isEntityField(fieldType)) {
        // M3 entity field overwrite: encode null as ENTITY_NULL_RAW;
        // otherwise store the Entity bit pattern (slot+gen).
        col.view[this.tableRow(rec)] =
          raw === null || raw === undefined ? ENTITY_NULL_RAW : (raw as number);
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
            (col.view as Uint8Array).set(bytes.subarray(0, arity), this.tableRow(rec) * arity);
          } else {
            // Variable `'buffer'` set: release prior slot via SSOT helper
            // (feat-20260614 D-2) then alloc fresh sized to the new payload
            // (verify round 1 B2 fix path). The helper zeroes the column on
            // release; sentinel slot id 0 is a no-op.
            this.storage.releaseManagedFieldOnRow(arch, component, this.tableRow(rec), fieldName);
            const allocR = this.bufferPool.alloc(bytes.byteLength);
            if (!allocR.ok) {
              const ctx: ErrorContext = {
                systemName: `World.set (${component.name}.${fieldName})`,
              };
              this.routeError(allocR.error, ctx);
              col.view[this.tableRow(rec)] = 0;
              continue;
            }
            const slot = allocR.value;
            slot.view.set(bytes);
            col.view[this.tableRow(rec)] = slot.id;
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
        col.view[this.tableRow(rec)] = unwrapHandle(handle);
      } else {
        const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
        if (arrayMeta !== undefined) {
          // M1 set path for array<T> / array<T,N> fields (feat-20260614 D-3
          // calling convention). The set semantics mirror spawn: release the
          // prior slot via the SSOT helper, then alloc a fresh one sized to
          // the new value, copy bytes verbatim, store slot id (+ count for
          // variable). Fixed `array<T,N>` is inline — the helper short-
          // circuits and writeArrayField writes directly into the row's
          // stride window with no pool traffic.
          this.storage.releaseManagedFieldOnRow(arch, component, this.tableRow(rec), fieldName);
          this.storage.writeArrayField(
            arch,
            component,
            this.tableRow(rec),
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
          col.view[this.tableRow(rec)] = raw as number;
          if (fieldType.startsWith('shared<') && (raw as number) !== 0) {
            this.storage.retainSharedScalarHandle(raw as number, component.name, fieldName);
          }
        }
      }
    }
    if (markChanged) this.markComponentChanged(entity, component);
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal relationship array maintenance. Public array mutation is always
  // expressed as one `world.set` payload; these helpers only implement the
  // engine-owned target projection and backpointer swap-remove path.
  //
  // Append/remove are engine-owned relationship maintenance only.
  //
  // The `fieldName` parameter is typed `ArrayFieldsOf<S>` so cross-shape
  // access (entity / buffer / string / scalar field names) is rejected at
  // compile time -- AI users see a TS error well before any runtime path.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Append `value` to the variable `array<T>` field `fieldName` on `entity`.
   *
   * BufferPool grow is amortized O(1) via the size-class freelist (research
   * Finding 5). Relationship target arrays grow byte-wise.
   *
   * @returns `Result<void, EcsError>` with the normal stale/component errors.
   *
   * The helper is called only by relationship synchronization.
   */
  private appendArrayElement<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
    value: ArrayFieldElementValue<S, K>,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'relationship-append', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- alive record always has a valid archetype */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'relationship-append',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const localId = componentId(component);
    const fieldCols = this.table(arch).storage.get(localId)?.fields;
    if (!fieldCols) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const fieldNameStr = fieldName as string;
    const col = fieldCols.get(fieldNameStr);
    /* istanbul ignore next -- ArrayFieldsOf filter ensures the column exists */
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = componentDefinition(component).fields[fieldNameStr]?.arrayMeta;
    /* istanbul ignore next -- ArrayFieldsOf filter guarantees array<*> */
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const meta = TYPE_METADATA[arrayMeta.elementType];
    /* istanbul ignore next -- arrayMeta.elementType is guaranteed in TYPE_METADATA */
    if (!meta) return err(new ComponentNotPresentError(entity as number, component.name));
    // biome-ignore lint/style/noNonNullAssertion: ManagedArrayElementType always scalar -> byteSize present
    const elementBytes = meta.byteSize!;
    const slotId = col.view[this.tableRow(rec)] as number;

    const countCol = fieldCols.get(arrayCountColumnName(fieldNameStr));
    /* istanbul ignore next -- variable arrays always allocate the count column */
    if (countCol === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const count = countCol.view[this.tableRow(rec)] as number;
    const newCount = count + 1;
    const newByteLength = newCount * elementBytes;

    let liveSlotId = slotId;
    if (liveSlotId === 0) {
      // Empty/unallocated slot — alloc fresh.
      const allocR = this.bufferPool.alloc(newByteLength);
      if (!allocR.ok) return err(allocR.error);
      liveSlotId = allocR.value.id;
      col.view[this.tableRow(rec)] = liveSlotId;
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
    countCol.view[this.tableRow(rec)] = newCount;
    this.markComponentChanged(entity, component);
    return ok(undefined);
  }

  private ensureArrayCapacity<S extends ComponentSchema, K extends ArrayFieldsOf<S>>(
    entity: EntityHandle,
    component: Component<string, S>,
    fieldName: K,
    minimum: number,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'relationship-capacity', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'relationship-capacity',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (!fieldCols) return err(new ComponentNotPresentError(entity as number, component.name));
    const fieldNameStr = fieldName as string;
    const col = fieldCols.get(fieldNameStr);
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = componentDefinition(component).fields[fieldNameStr]?.arrayMeta;
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const meta = TYPE_METADATA[arrayMeta.elementType];
    if (!meta?.byteSize) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const maximum = Math.floor(262_144 / meta.byteSize);
    if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > maximum) {
      return err(new ManagedBufferOutOfBoundsError(minimum, maximum));
    }

    const byteLength = minimum * meta.byteSize;
    const slotId = col.view[this.tableRow(rec)] as number;
    if (slotId === 0) {
      if (minimum === 0) return ok(undefined);
      const allocated = this.bufferPool.alloc(byteLength);
      if (!allocated.ok) return allocated;
      col.view[this.tableRow(rec)] = allocated.value.id;
      return ok(undefined);
    }
    if (this.bufferPool.view(slotId).byteLength >= byteLength) return ok(undefined);
    const grown = this.bufferPool.grow(slotId, byteLength);
    return grown.ok ? ok(undefined) : grown;
  }

  /**
   * Remove one variable-array element at a known slot. Relationship holders
   * supply the slot from their backpointer, so this is O(1) and never scans
   * the materialized target array.
   */
  private removeArrayElementAt(
    entity: EntityHandle,
    component: Component<string, ComponentSchema>,
    fieldName: string,
    slot: number,
  ): Result<EntityHandle | undefined, EcsError> {
    const record = this.lookupAlive(entity, 'removeArrayElementAt', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    if (!arch) return err(new ComponentNotPresentError(entity as number, component.name));
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (!fieldCols) return err(new ComponentNotPresentError(entity as number, component.name));
    const col = fieldCols.get(fieldName);
    const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
    const countCol = fieldCols.get(arrayCountColumnName(fieldName));
    if (!col || !arrayMeta || arrayMeta.length !== undefined || !countCol) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const row = this.tableRow(rec);
    const count = countCol.view[row] as number;
    if (slot < 0 || slot >= count) return ok(undefined);
    const slotId = col.view[row] as number;
    if (slotId === 0) return ok(undefined);
    const liveBytes = this.bufferPool.view(slotId);
    const last = count - 1;
    const moved =
      slot === last
        ? undefined
        : (this.storage.readArrayElementAt(liveBytes, last, arrayMeta.elementType) as EntityHandle);
    if (slot !== last) {
      this.storage.writeArrayElementAt(liveBytes, slot, arrayMeta.elementType, moved as number);
    }
    countCol.view[row] = last;
    this.markComponentChanged(entity, component);
    return ok(moved);
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
   * @param internal — `true` when called from relationship maintenance
   *   (lazy mirror create or exclusive reparent).
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

    const preflight = this.preflightComponentData(entity, componentData);
    if (!preflight.ok) return preflight;

    // bug-20260615: unknown-key fail-fast BEFORE archetype mutation so a
    // typo aborts cleanly without partial state (mirrors _spawnCore).
    const keyErr = validateComponentDataKeys(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    if (keyErr !== null) {
      return err(keyErr as unknown as EcsError);
    }
    const arrayErr = validateManagedArrayValues(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    if (arrayErr !== null) {
      return err(arrayErr as unknown as EcsError);
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
    const filled = fillComponentDefaults(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );
    const enumErr = validateEnumFieldValues(componentData.component, filled, entity as number);
    if (enumErr !== null) {
      return err(enumErr as unknown as EcsError);
    }

    // Check if entity already has this component (using World-local ID).
    const localId = componentId(componentData.component);
    if (srcArch.components.some((candidate) => componentId(candidate) === localId)) {
      // M2 exclusive relationship: re-adding the holder with a (possibly new)
      // target auto-reparents instead of failing (AC-12). Prune the old side
      // first (removeComponent prunes the old target), then fall through to
      // the normal add (which appends the new target). The two steps keep the
      // materialized target list consistent (AC-13);
      // removeComponent + addComponent each touch the mirror exactly once and
      // the mirror component carries no relationship of its own, so there is
      // no recursion. Reparent only fires for top-level user calls
      // (!internal); engine-internal lazy create / append
      // never re-add an existing relationship component.
      const role = relationshipRole(componentData.component as Component);
      if (role?.kind === 'source' && role.exclusive && !internal) {
        const prepared = this.prepareRelationshipInsert(
          componentData.component as Component,
          filled as Record<string, unknown>,
        );
        if (!prepared.ok) return prepared;
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

    if (!internal && relationshipRole(componentData.component as Component)?.kind === 'source') {
      const prepared = this.prepareRelationshipInsert(
        componentData.component as Component,
        filled as Record<string, unknown>,
      );
      if (!prepared.ok) return prepared;
    }

    // Get target archetype via edge cache.
    const targetArch = getAddEdge(
      this.graph,
      srcArch,
      localId,
      componentData.component as Component,
    );

    if (componentData.component.storage === 'sparse') {
      this.storage.moveEntityArchetype(rec, srcArch, targetArch);
    } else {
      this.storage.migrateEntity(rec, srcArch, targetArch);
    }

    // Write the new component's data. Apply layer-2 + layer-3 silent
    // fallback so addComponent shares the SAME default-resolution path
    // as spawn / SceneAsset.instantiate (feat-20260517 / M2 / AC-04
    // research §F4 auto-symmetry; ComponentData<S>['data'] is the
    // physical bridge).
    if (componentData.component.storage === 'table') {
      this.storage.writeRow(
        targetArch,
        componentData.component,
        this.tableRow(rec),
        filled as ShapeOf<S>,
      );
    }
    this.markComponentAdded(entity, componentData.component as Component);
    // Relationship sync: append to the materialized target list.
    if (!internal && relationshipRole(componentData.component as Component)?.kind === 'source') {
      const relationshipResult = this.relationshipOnInsert(
        entity,
        componentData.component as Component,
        filled as Record<string, unknown>,
      );
      if (!relationshipResult.ok) return relationshipResult;
    }

    this.markStructureChanged();
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
   * @param internal — `true` when called from relationship maintenance
   *   (exclusive reparent).
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
    if (componentId(component) === componentId(EntityComponent)) {
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
    const localId = componentId(component);
    if (!srcArch.components.some((candidate) => componentId(candidate) === localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    // Capture the old relationship value before column removal so the
    // materialized target list can be pruned.
    const role = relationshipRole(component as Component);
    const needsOldValue = role?.kind === 'source' && !internal;
    if (needsOldValue) {
      const oldValue = this.storage.readRow(
        srcArch,
        component as Component,
        this.tableRow(rec),
      ) as Record<string, unknown>;
      // Relationship sync: prune the holder from the target's materialized list.
      if (role?.kind === 'source' && !internal) {
        const relation = this.relationshipOnRemove(entity, component as Component, oldValue);
        if (!relation.ok) return relation;
      }
    }

    // M1 release loop (removeComponent path): release every `ref<T>` field
    // on the component being removed before migration drops the row.
    if (component.storage === 'table') {
      this.storage.releaseManagedRefsOnRow(srcArch, component as Component, this.tableRow(rec));
    }

    // Get target archetype via edge cache.
    const targetArch = getRemoveEdge(this.graph, srcArch, localId);

    if (component.storage === 'sparse') {
      this.storage.moveEntityArchetype(rec, srcArch, targetArch);
      const set = this.graph.sparseTags.get(componentId(component));
      if (set !== undefined) removeSparseTag(set, entity);
    } else {
      this.storage.migrateEntity(rec, srcArch, targetArch);
    }
    this.state.removeComponentChange(entity, componentId(component));
    this.markStructureChanged();
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
   * Return a deferred-spawn reservation to the free-list without publishing a
   * row or advancing an epoch.  CommandBuffer.abort is the sole caller; a
   * materialized entity is intentionally left untouched so an unexpected
   * post-write failure poisons the World instead of attempting an unsafe undo.
   */
  _cancelPendingEntity(entity: EntityHandle): void {
    const slot = entityIndex(entity);
    const record = this.records[slot];
    if (record === undefined || record.generation !== entityGeneration(entity)) return;
    if (record.archetypeId !== -1 || record.archetypeRow !== -1) return;
    record.generation += 1;
    if (!isRetiredSlot(record.generation)) this.freeIndices.push(slot);
  }

  /**
   * @internal Materialize a pending entity: actually place it into an archetype.
   * Idempotent: a record with archetypeId !== -1 is already materialized.
   */
  _materializePendingEntity(
    entity: EntityHandle,
    componentDatas: ComponentData[],
  ): Result<void, EcsError> {
    const slot = entityIndex(entity);
    const record = this.records[slot];
    if (!record || record.archetypeId !== -1) return ok(undefined);

    // Find or create target archetype (using World-local IDs).
    const componentIds = componentDatas.map((cd) => componentId(cd.component));
    const components = componentDatas.map((cd) => cd.component);
    const arch = getOrCreateArchetype(this.graph, componentIds, components);

    // Append entity row.
    const table = this.table(arch);
    const tableRow = appendTableRow(table, entity);
    const archetypeRow = appendArchetypeRow(arch, tableRow);
    record.archetypeId = arch.id;
    record.archetypeRow = archetypeRow;

    // Write initial data. Apply layer-2 + layer-3 silent fallback so
    // deferred-spawn (Commands.spawn) shares the SAME default-resolution
    // path as the synchronous `world.spawn` / `addComponent` /
    // SceneAsset.instantiate (feat-20260517 / M2 / AC-04 + AC-09).
    this.state.markComponentsAdded(entity, [
      componentId(EntityComponent),
      ...componentDatas.map((cd) => componentId(cd.component)),
    ]);
    for (const cd of componentDatas) {
      const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
      this.storage.writeRow(arch, cd.component, tableRow, filled as ShapeOf<ComponentSchema>);
    }

    // Essential id=0 `Entity` column write (feat-20260602 / plan-strategy D-3),
    // mirroring the synchronous `spawn` path: the deferred handle was minted at
    // `_allocatePendingEntity` time and is passed in here.
    this.storage.writeEntitySelf(arch, tableRow, entity);

    // Publish relationship targets after all rows are written.
    for (const cd of componentDatas) {
      if (relationshipRole(cd.component as Component)?.kind === 'source') {
        const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
        const relationshipResult = this.relationshipOnInsert(
          entity,
          cd.component as Component,
          filled as Record<string, unknown>,
        );
        if (!relationshipResult.ok) {
          return relationshipResult;
        }
      }
    }
    this.markStructureChanged();
    return ok(undefined);
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
    this.records.push({ generation: 0, archetypeId: -1, archetypeRow: -1 });
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
}
