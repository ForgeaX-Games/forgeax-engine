// @forgeax/engine-ecs — world-component-storage: row and resource storage.
//
// Owns the low-level archetype row representation, managed reference lifetime,
// array/buffer byte storage, and archetype migration. WorldComponentAccess owns
// the typed public component operations and composes this state capability.

import {
  BUILTIN_BASE,
  type Handle,
  toShared,
  toUnique,
  unpackSlot,
  unwrapHandle,
} from '@forgeax/engine-types';
import { type Archetype, appendEntity, removeEntity } from './archetype';
import type { BufferPool } from './buffer-pool';
import { arrayCountColumnName, type FieldView, normalizeBufferWrite } from './column';
import {
  type ArrayMeta,
  type Component,
  type ComponentSchema,
  fieldTypeToMetaKey,
  isEntityField,
  isManagedArrayField,
  isManagedBufferField,
  isManagedField,
  type ManagedArrayElementType,
  parseManagedArraySchema,
  type ShapeOf,
  TYPE_METADATA,
} from './component';
import { Entity as EntityComponent } from './entity';
import { ENTITY_NULL_RAW, type EntityHandle } from './entity-handle';
import type { ManagedArrayErrorEnvelope } from './errors';
import type { ErrorContext } from './schedule';
import { Severity } from './schedule';
import type { SharedRefStore } from './shared-ref-store';
import type { UniqueRefStore } from './unique-ref-store';
import type { ComponentData, EntityRecord } from './world';

export interface ComponentStorageState {
  readonly records: EntityRecord[];
  readonly bufferPool: BufferPool;
  readonly uniqueRefs: UniqueRefStore;
  readonly sharedRefs: SharedRefStore;
  routeError(err: unknown, ctx: ErrorContext): void;
}

export class ComponentStorage {
  constructor(private readonly state: ComponentStorageState) {}

  private get records(): EntityRecord[] {
    return this.state.records;
  }

  private get bufferPool(): BufferPool {
    return this.state.bufferPool;
  }

  private get uniqueRefs(): UniqueRefStore {
    return this.state.uniqueRefs;
  }

  private get sharedRefs(): SharedRefStore {
    return this.state.sharedRefs;
  }

  private routeError(err: unknown, ctx: ErrorContext): void {
    this.state.routeError(err, ctx);
  }

  readArrayView(
    arch: Archetype,
    component: Component,
    row: number,
    fieldName: string,
  ): FieldView | undefined {
    const fieldCols = arch.columns.get(component.id);
    if (!fieldCols) return undefined;

    const fieldType = component.schema[fieldName];
    if (fieldType === undefined) return undefined;
    const arrayMeta = parseManagedArraySchema(fieldType);
    if (arrayMeta === null) return undefined;

    const col = fieldCols.get(fieldName);
    if (!col) return undefined;

    if (arrayMeta.length !== undefined) {
      const elementBytes = elementByteSize(arrayMeta.elementType);
      const arity = col.arity;
      const rowByteOffset = col.view.byteOffset + row * arity * elementBytes;
      const rowBytes = new Uint8Array(col.view.buffer, rowByteOffset, arity * elementBytes);
      return reinterpretSlotBytes(rowBytes, arrayMeta.elementType, arrayMeta.length);
    }

    const slotId = col.view[row] as number;
    const liveBytes = this.bufferPool.view(slotId);
    const countCol = fieldCols.get(arrayCountColumnName(fieldName));
    const elementCount = (countCol?.view[row] as number | undefined) ?? 0;
    return reinterpretSlotBytes(liveBytes, arrayMeta.elementType, elementCount);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — archetype data read/write
  // ──────────────────────────────────────────────────────────────────────────

  readRow<S extends ComponentSchema>(
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
  writeEntitySelf(arch: Archetype, row: number, handle: EntityHandle): void {
    const col = arch.columns.get(EntityComponent.id)?.get('self');
    /* istanbul ignore next -- defensive: Entity column is folded into every archetype */
    if (!col) return;
    col.view[row] = handle as unknown as number;
  }

  writeRow<S extends ComponentSchema>(
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
            this.routeError(allocR.error, ctx);
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
  releaseManagedRefsOnRow(arch: Archetype, component: Component, row: number): void {
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
  releaseManagedFieldOnRow(
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
  releaseManagedRefHandle(handleU32: number, componentName: string, fieldName: string): void {
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
    this.routeError(r.error, ctx);
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
  releaseSharedRefHandle(handleU32: number, componentName: string, fieldName: string): void {
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
    this.routeError(r.error, ctx);
  }

  /**
   * Retain a single `shared<T>` scalar slot id (feat-20260614 M5 / D-5).
   * Mirrors `releaseSharedRefHandle`; called from spawn / set scalar write
   * paths so each ECS holder participates in the SharedRefStore rc.
   * Sentinel slot 0 is a no-op. Failures (handle already released) route
   * via Layer 3 ErrorHandler so the spawn / set chain stays total.
   */
  retainSharedScalarHandle(handleU32: number, componentName: string, fieldName: string): void {
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
    this.routeError(r.error, ctx);
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
  releaseManagedBufferSlot(slotId: number, componentName: string, fieldName: string): void {
    if (slotId === 0) return; // sentinel: skip silently.
    const r = this.bufferPool.release(slotId);
    /* istanbul ignore if -- BufferPool.release is total in v1 (Result<void, never>); branch reserved for future fail-fast extension. */
    if (!r.ok) {
      const ctx: ErrorContext = {
        severity: Severity.Error,
        systemName: `World.release (${componentName}.${fieldName})`,
      };
      this.routeError(r.error, ctx);
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
  routeArrayError(err: ManagedArrayErrorEnvelope, componentName: string, fieldName: string): void {
    const ctx: ErrorContext = {
      severity: Severity.Error,
      systemName: `World.write (${componentName}.${fieldName})`,
    };
    this.routeError(err, ctx);
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
  writeArrayField(
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
  retainSharedArrayElements(bytes: Uint8Array, count: number): void {
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
  releaseSharedArrayElements(bytes: Uint8Array, count: number): void {
    const view = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    for (let i = 0; i < count; i++) {
      const raw = view[i];
      if (raw === undefined) continue;
      // R-14: route through the scalar SSOT helper so the `< BUILTIN_BASE`
      // short-circuit (builtin slots + sentinel 0) lives in exactly one place.
      this.releaseSharedRefHandle(raw, 'array<shared<T>>', 'element');
    }
  }

  writeArrayElementAt(
    bytes: Uint8Array,
    idx: number,
    elementType: ManagedArrayElementType,
    value: number,
  ): void {
    writeArrayElementAt(bytes, idx, elementType, value);
  }

  readArrayElementAt(bytes: Uint8Array, idx: number, elementType: ManagedArrayElementType): number {
    return readArrayElementAt(bytes, idx, elementType);
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
  materializeArrayView(
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
  migrateEntity(record: EntityRecord, srcArch: Archetype, targetArch: Archetype): void {
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

  expandCoAttach(componentDatas: ComponentData[]): ComponentData[] {
    return expandCoAttach(componentDatas);
  }
}

/**
 * Expand a caller-supplied `world.spawn` bundle with any `coAttach` companion
 * components declared on the caller's tokens
 * (tweak-20260714-tilemap-layer-childed-render-entities M1). Layer-1 wins: if
 * the caller already names a coAttach-declared component in the bundle, that
 * caller entry is preserved and the coAttach entry is skipped. Chain-isolated:
 * only the caller's original tokens contribute; auto-added companions do NOT
 * recursively add their own coAttach (charter P4 — bounded expansion +
 * deterministic archetype hash).
 *
 * @internal
 */
function expandCoAttach(componentDatas: ComponentData[]): ComponentData[] {
  // Fast path: nothing declares coAttach → return caller bundle unchanged.
  let hasCoAttach = false;
  for (const cd of componentDatas) {
    if ((cd.component as Component).coAttach !== undefined) {
      hasCoAttach = true;
      break;
    }
  }
  if (!hasCoAttach) return componentDatas;

  // Track which component ids the caller already supplied; layer-1 wins.
  const present = new Set<number>();
  for (const cd of componentDatas) {
    present.add((cd.component as Component).id);
  }

  const expanded: ComponentData[] = componentDatas.slice();
  for (const cd of componentDatas) {
    const coAttach = (cd.component as Component).coAttach;
    if (coAttach === undefined) continue;
    for (const entry of coAttach) {
      const compId = (entry.component as Component).id;
      if (present.has(compId)) continue;
      present.add(compId);
      expanded.push({
        component: entry.component as unknown as ComponentData['component'],
        data: entry.data as unknown as ComponentData['data'],
      });
    }
  }
  return expanded;
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
