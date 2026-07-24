// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=10):
//   - packages/ecs/src/__tests__/archetype-storage.test.ts
//   - packages/ecs/src/__tests__/buffer-pool.test.ts
//   - packages/ecs/src/__tests__/buffer-vocab-fixup.test.ts
//   - packages/ecs/src/__tests__/chained-add-component-column-loss.test.ts
//   - packages/ecs/src/__tests__/column.test.ts
//   - packages/ecs/src/__tests__/entity-column.test.ts
//   - packages/ecs/src/__tests__/fixed-array-inline.test.ts
//   - packages/ecs/src/__tests__/query-preregister.test.ts
//   - packages/ecs/src/__tests__/query.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Archetype } from '../archetype';
import { appendEntity, createArchetype, growArchetype, removeEntity } from '../archetype';
import {
  createArchetypeGraph,
  getAddEdge,
  getOrCreateArchetype,
  getRemoveEdge,
} from '../archetype-graph';
import { BufferPool, SIZE_CLASSES } from '../buffer-pool';
import { createColumn, growColumn, HAS_TRANSFER, isHotSchema } from '../column';
import type { ComponentSchema, ScalarFieldType } from '../component';
import {
  defineComponent,
  fieldTypeToMetaKey,
  isEntityField,
  isManagedArrayField,
  isManagedBufferField,
  isManagedField,
  TYPE_METADATA,
} from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { createQueryState, type QueryDescriptor, type QueryState, queryRun } from '../query';
import { World } from '../world';

{
  // ─── from archetype-storage.test.ts ───
  /** Auto-incrementing archetype ID for test isolation. */
  let testArchId = 0;

  describe('archetype-storage.test.ts', () => {
    describe('Archetype creation', () => {
      it('creates archetype with sorted component-set key', () => {
        const B = defineComponent('B', { b: { type: 'f32' } });
        const A = defineComponent('A', { a: { type: 'f32' } });
        const arch = createArchetype([B, A], testArchId++);
        const ids = [Entity.id, A.id, B.id].sort((a, b) => a - b);
        expect(arch.key).toBe(ids.join('+'));
      });

      it('creates archetype with correct initial capacity', () => {
        const C = defineComponent('Cap', { x: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);
        expect(arch.capacity).toBeGreaterThanOrEqual(1);
        expect(arch.size).toBe(0);
      });

      it('creates columns for each component field', () => {
        const Pos = defineComponent('Pos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const arch = createArchetype([Pos], testArchId++);
        expect(arch.columns.has(Pos.id)).toBe(true);
        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees Pos.id exists in columns
        const compCols = arch.columns.get(Pos.id)!;
        expect(compCols.has('x')).toBe(true);
        expect(compCols.has('y')).toBe(true);
      });

      it('tag component creates archetype with no data columns', () => {
        const Tag = defineComponent('ArchetypeStorageTag', {});
        const arch = createArchetype([Tag], testArchId++);
        const compCols = arch.columns.get(Tag.id);
        expect(compCols === undefined || compCols.size === 0).toBe(true);
      });
    });

    describe('appendEntity / removeEntity (swap-pop)', () => {
      it('appends entity and increments size', () => {
        const C = defineComponent('SwapTest', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);
        const row = appendEntity(arch, 42);
        expect(row).toBe(0);
        expect(arch.size).toBe(1);
        // Entity index stored in id=0 self column (not a separate entities array)
        const selfVal = arch.columns.get(Entity.id)?.get('self')?.view[0];
        expect(selfVal).toBe(42);
      });

      it('swap-pop removes entity correctly', () => {
        const C = defineComponent('SwapPop', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);

        appendEntity(arch, 10);
        appendEntity(arch, 20);
        appendEntity(arch, 30);

        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees C.id exists in columns
        const cols = arch.columns.get(C.id)!;
        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees 'v' field exists
        const vCol = cols.get('v')!;
        vCol.view[0] = 100;
        vCol.view[1] = 200;
        vCol.view[2] = 300;

        const swapped = removeEntity(arch, 0);
        expect(arch.size).toBe(2);

        // Entity identity now read from id=0 self column
        const selfCol = arch.columns.get(Entity.id)?.get('self');
        expect(selfCol).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect
        expect(selfCol!.view[0]! & 0xffffff).toBe(30);
        expect(vCol.view[0]).toBe(300);

        // biome-ignore lint/style/noNonNullAssertion: guarded by expect
        expect(selfCol!.view[1]! & 0xffffff).toBe(20);
        expect(vCol.view[1]).toBe(200);

        expect(swapped).toEqual({ movedEntity: 30, newRow: 0 });
      });

      it('swap-pop on last row does not swap', () => {
        const C = defineComponent('LastRow', { v: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);
        appendEntity(arch, 10);
        appendEntity(arch, 20);

        const swapped = removeEntity(arch, 1);
        expect(arch.size).toBe(1);
        // Entity identity from self column
        const selfVal = arch.columns.get(Entity.id)?.get('self')?.view[0];
        expect(selfVal).toBe(10);
        expect(swapped).toBeNull();
      });
    });

    describe('growArchetype', () => {
      it('doubles capacity and preserves data', () => {
        const C = defineComponent('Grow', { x: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);
        const initialCap = arch.capacity;

        for (let i = 0; i < initialCap; i++) {
          appendEntity(arch, i);
          // biome-ignore lint/style/noNonNullAssertion: test setup guarantees C.id exists in columns
          const cols = arch.columns.get(C.id)!;
          // biome-ignore lint/style/noNonNullAssertion: field 'x' guaranteed to exist
          cols.get('x')!.view[i] = i * 1.5;
        }

        growArchetype(arch, initialCap * 2);
        expect(arch.capacity).toBe(initialCap * 2);

        // biome-ignore lint/style/noNonNullAssertion: test setup guarantees C.id exists in columns
        const cols = arch.columns.get(C.id)!;
        for (let i = 0; i < initialCap; i++) {
          expect(cols.get('x')?.view[i]).toBeCloseTo(i * 1.5);
        }
      });

      it('increments version on grow', () => {
        const C = defineComponent('GrowVer', { x: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);
        const v0 = arch.version;
        growArchetype(arch, arch.capacity * 2);
        expect(arch.version).toBe(v0 + 1);
      });

      it('growArchetype is a no-op when targetCapacity <= current capacity', () => {
        const C = defineComponent('GrowNoop', { x: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);
        const capBefore = arch.capacity;
        const versionBefore = arch.version;
        growArchetype(arch, capBefore);
        expect(arch.capacity).toBe(capBefore);
        expect(arch.version).toBe(versionBefore);
        growArchetype(arch, capBefore - 1);
        expect(arch.capacity).toBe(capBefore);
        expect(arch.version).toBe(versionBefore);
      });
    });

    describe('ArchetypeGraph', () => {
      it('getOrCreateArchetype returns same archetype for same component set', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('GA', { a: { type: 'f32' } });
        const B = defineComponent('GB', { b: { type: 'f32' } });

        const arch1 = getOrCreateArchetype(graph, [A.id, B.id], [A, B]);
        const arch2 = getOrCreateArchetype(graph, [B.id, A.id], [B, A]);
        expect(arch1).toBe(arch2);
      });

      it('getAddEdge caches edge (O(1) on second call)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('EA', { a: { type: 'f32' } });
        const B = defineComponent('EB', { b: { type: 'f32' } });

        const archA = getOrCreateArchetype(graph, [A.id], [A]);
        const archAB1 = getAddEdge(graph, archA, B.id, B);
        const archAB2 = getAddEdge(graph, archA, B.id, B);
        expect(archAB1).toBe(archAB2);
      });

      it('getRemoveEdge caches edge (O(1) on second call)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RA', { a: { type: 'f32' } });
        const B = defineComponent('RB', { b: { type: 'f32' } });

        const archAB = getOrCreateArchetype(graph, [A.id, B.id], [A, B]);
        const archA1 = getRemoveEdge(graph, archAB, B.id);
        const archA2 = getRemoveEdge(graph, archAB, B.id);
        expect(archA1).toBe(archA2);
      });

      it('multi-component spawn targets correct archetype directly', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('MA', { a: { type: 'f32' } });
        const B = defineComponent('MB', { b: { type: 'f32' } });
        const C = defineComponent('MC', { c: { type: 'f32' } });

        const arch = getOrCreateArchetype(graph, [A.id, B.id, C.id], [A, B, C]);
        const ids = [Entity.id, A.id, B.id, C.id].sort((a, b) => a - b);
        expect(arch.key).toBe(ids.join('+'));
      });

      it('increments global archetype generation on new archetype creation', () => {
        const graph = createArchetypeGraph();
        const gen0 = graph.generation;
        const X = defineComponent('GenX', { x: { type: 'f32' } });
        getOrCreateArchetype(graph, [X.id], [X]);
        expect(graph.generation).toBe(gen0 + 1);

        getOrCreateArchetype(graph, [X.id], [X]);
        expect(graph.generation).toBe(gen0 + 1);
      });
    });
  });
}

{
  // ─── from buffer-pool.test.ts ───
  describe('buffer-pool.test.ts', () => {
    describe('w10 - BufferPool size-class allocation', () => {
      it('alloc(128) returns a view of byteLength === 128 (bucket 256B)', () => {
        const pool = new BufferPool();
        const r = pool.alloc(128);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.view.byteLength).toBe(128);
        expect(r.value.id).toBeGreaterThan(0);
      });

      it('alloc(0) is legal and returns a zero-length view (no bucket)', () => {
        const pool = new BufferPool();
        const r = pool.alloc(0);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok');
        expect(r.value.view.byteLength).toBe(0);
      });

      it('release then alloc(128) reuses a slot from the free-list', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const idA = a.value.id;
        const rel = pool.release(idA);
        expect(rel.ok).toBe(true);
        const b = pool.alloc(128);
        if (!b.ok) throw new Error('expected ok b');
        expect(b.value.id).toBe(idA);
        expect(b.value.view.byteLength).toBe(128);
      });
    });

    describe('w10 - BufferPool.grow (D-6 Result semantics, D-7 no-shrink)', () => {
      it('grow preserves prior content byte-equal across same-bucket growth', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const view0 = a.value.view;
        for (let i = 0; i < 128; i++) view0[i] = (i * 7) & 0xff;
        const r = pool.grow(a.value.id, 200);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok grow');
        const view1 = r.value;
        expect(view1.byteLength).toBe(200);
        for (let i = 0; i < 128; i++) expect(view1[i]).toBe((i * 7) & 0xff);
      });

      it('grow(view, byteLength === current) returns ok no-op view', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const r = pool.grow(a.value.id, 128);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok grow');
        expect(r.value.byteLength).toBe(128);
      });

      it('grow(view, smaller) returns err(managed-buffer-shrink-not-supported)', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const r = pool.grow(a.value.id, 100);
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected err grow');
        expect(r.error.code).toBe('managed-buffer-shrink-not-supported');
        if (r.error.code !== 'managed-buffer-shrink-not-supported') throw new Error('narrow');
        expect(r.error.detail.requested).toBe(100);
        expect(r.error.detail.current).toBe(128);
      });

      it('cross-bucket grow (128 -> 4096) preserves prior content byte-equal', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        if (!a.ok) throw new Error('expected ok a');
        const view0 = a.value.view;
        for (let i = 0; i < 128; i++) view0[i] = (i + 1) & 0xff;
        const r = pool.grow(a.value.id, 4096);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('expected ok grow');
        const view1 = r.value;
        expect(view1.byteLength).toBe(4096);
        for (let i = 0; i < 128; i++) expect(view1[i]).toBe((i + 1) & 0xff);
        const refreshed = pool.view(a.value.id);
        expect(refreshed.byteLength).toBe(4096);
      });

      it('alloc(beyond max bucket) returns err(managed-buffer-out-of-bounds)', () => {
        const pool = new BufferPool();
        const top = SIZE_CLASSES[SIZE_CLASSES.length - 1];
        if (top === undefined) throw new Error('SIZE_CLASSES empty');
        const overshoot = top + 1;
        const r = pool.alloc(overshoot);
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected err alloc');
        expect(r.error.code).toBe('managed-buffer-out-of-bounds');
        if (r.error.code !== 'managed-buffer-out-of-bounds') throw new Error('narrow');
        expect(r.error.detail.index).toBe(overshoot);
      });

      it('M4 prelude: distinct ids on consecutive alloc with no release in between', () => {
        const pool = new BufferPool();
        const a = pool.alloc(128);
        const b = pool.alloc(128);
        if (!a.ok || !b.ok) throw new Error('expected ok x2');
        expect(a.value.id).not.toBe(b.value.id);
      });
    });
  });
}

{
  // ─── from buffer-vocab-fixup.test.ts ───
  describe('buffer-vocab-fixup.test.ts', () => {
    describe('verify round 1 fix-up — B1: world.set on buffer<N> validates byteLength', () => {
      it('returns Result.err with code "fixed-size-mismatch" when M < N', () => {
        const Print = defineComponent('Print', { fp: { type: 'buffer<16>' } });
        const w = new World();
        const e = w.spawn({ component: Print, data: { fp: new Uint8Array(16) } }).unwrap();
        const r = w.set(e, Print, { fp: new Uint8Array(12) });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('fixed-size-mismatch');
          if (r.error.code === 'fixed-size-mismatch') {
            expect(r.error.detail).toEqual({ expected: 16, actual: 12 });
            expect(r.error.hint).toContain('buffer<16>');
            expect(r.error.hint).toContain('byteLength 12');
          }
        }
      });

      it('returns Result.err with code "fixed-size-mismatch" when M > N', () => {
        const PrintBuf8 = defineComponent('PrintBuf8', { fp: { type: 'buffer<8>' } });
        const w = new World();
        const e = w.spawn({ component: PrintBuf8, data: { fp: new Uint8Array(8) } }).unwrap();
        const r = w.set(e, PrintBuf8, { fp: new Uint8Array(20) });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('fixed-size-mismatch');
          if (r.error.code === 'fixed-size-mismatch') {
            expect(r.error.detail).toEqual({ expected: 8, actual: 20 });
          }
        }
      });

      it('matching byteLength still succeeds and writes through to world.get snapshot', () => {
        const Print = defineComponent('PrintBuf4', { fp: { type: 'buffer<4>' } });
        const w = new World();
        const e = w.spawn({ component: Print, data: { fp: new Uint8Array(4) } }).unwrap();
        const r = w.set(e, Print, { fp: new Uint8Array([1, 2, 3, 4]) });
        expect(r.ok).toBe(true);
        const snapshot = w.get(e, Print).unwrap().fp;
        expect(snapshot.byteLength).toBe(4);
        expect(Array.from(snapshot)).toEqual([1, 2, 3, 4]);
      });
    });

    describe('verify round 1 fix-up — B2: bare "buffer" (variable) spawn + set round-trip', () => {
      it('spawn with payload bytes round-trips through world.get without data loss', () => {
        const Blob = defineComponent('BlobVocab', { b: { type: 'buffer' } });
        const errors: string[] = [];
        const w = new World();
        w.setErrorHandler((err) => {
          errors.push((err as { code: string }).code);
        });
        const payload = new Uint8Array([7, 8, 9]);
        const e = w.spawn({ component: Blob, data: { b: payload } }).unwrap();
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(3);
        expect(Array.from(snapshot)).toEqual([7, 8, 9]);
        expect(errors).toEqual([]);
      });

      it('world.set after spawn replaces variable-buffer bytes (no fixed-size constraint)', () => {
        const Blob = defineComponent('BlobVocab2', { b: { type: 'buffer' } });
        const w = new World();
        const e = w.spawn({ component: Blob, data: { b: new Uint8Array([1]) } }).unwrap();
        const r = w.set(e, Blob, { b: new Uint8Array([10, 20, 30, 40, 50]) });
        expect(r.ok).toBe(true);
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(5);
        expect(Array.from(snapshot)).toEqual([10, 20, 30, 40, 50]);
      });

      it('spawn with an empty Uint8Array yields a zero-length live view (no error)', () => {
        const Blob = defineComponent('BlobVocab3', { b: { type: 'buffer' } });
        const errors: string[] = [];
        const w = new World();
        w.setErrorHandler((err) => {
          errors.push((err as { code: string }).code);
        });
        const e = w.spawn({ component: Blob, data: { b: new Uint8Array(0) } }).unwrap();
        const snapshot = w.get(e, Blob).unwrap().b;
        expect(snapshot.byteLength).toBe(0);
        expect(errors).toEqual([]);
      });

      it('ManagedBufferOutOfBoundsError hint references the new buffer keyword forms (no legacy "buffer:<bytes>")', () => {
        const Blob = defineComponent('BlobVocab4', { b: { type: 'buffer' } });
        const errors: { code: string; hint: string }[] = [];
        const w = new World();
        w.setErrorHandler((err) => {
          const e = err as { code: string; hint: string };
          errors.push({ code: e.code, hint: e.hint });
        });
        const oversized = new Uint8Array(262_145);
        w.spawn({ component: Blob, data: { b: oversized } });
        const overflow = errors.find((e) => e.code === 'managed-buffer-out-of-bounds');
        expect(overflow).toBeDefined();
        if (overflow !== undefined) {
          expect(overflow.hint).not.toContain('buffer:<bytes>');
          expect(overflow.hint).not.toContain('buffer:<N>');
        }
      });
    });
  });
}

{
  // ─── from chained-add-component-column-loss.test.ts ───
  describe('chained-add-component-column-loss.test.ts', () => {
    describe('chained addComponent preserves earlier-added column data (F-2)', () => {
      it('two chained single addComponent on a >=2-component entity preserves both columns', () => {
        const C = defineComponent('C', { a: { type: 'u32' } });
        const D = defineComponent('D', { b: { type: 'u32' } });
        const Base1 = defineComponent('Base1', { s: { type: 'string' } });
        const Base2 = defineComponent('Base2', { x: { type: 'f32' } });

        const w = new World();

        const e = w
          .spawn({ component: Base1, data: { s: 'hi' } }, { component: Base2, data: { x: 1.5 } })
          .unwrap();

        w.addComponent(e, { component: C, data: { a: 1033 } }).unwrap();
        w.addComponent(e, { component: D, data: { b: 55 } }).unwrap();

        const cGet = w.get(e, C);
        const dGet = w.get(e, D);
        if (!cGet.ok) throw new Error('expected ok get C');
        if (!dGet.ok) throw new Error('expected ok get D');
        expect(cGet.value.a).toBe(1033);
        expect(dGet.value.b).toBe(55);

        const b1 = w.get(e, Base1);
        const b2 = w.get(e, Base2);
        if (!b1.ok || !b2.ok) throw new Error('expected ok get base');
        expect(b1.value.s).toBe('hi');
        expect(b2.value.x).toBeCloseTo(1.5);
      });

      it('single-component base + two chained adds (registration adds-first)', () => {
        const C = defineComponent('SC', { a: { type: 'u32' } });
        const D = defineComponent('SD', { b: { type: 'u32' } });
        const Base = defineComponent('SBase', { s: { type: 'string' } });

        const w = new World();

        const e = w.spawn({ component: Base, data: { s: 'hi' } }).unwrap();
        w.addComponent(e, { component: C, data: { a: 1033 } }).unwrap();
        w.addComponent(e, { component: D, data: { b: 55 } }).unwrap();

        const cGet = w.get(e, C);
        if (!cGet.ok) throw new Error('expected ok get C');
        expect(cGet.value.a).toBe(1033);
      });
    });
  });
}

{
  // ─── from column.test.ts ───
  describe('column.test.ts', () => {
    describe('Column.arity', () => {
      it('scalar column arity defaults to 1 (AC-01)', () => {
        const col = createColumn('f32', 64);
        expect(col.arity).toBe(1);
      });

      it('all 11 scalar field types default arity to 1', () => {
        const types: ScalarFieldType[] = [
          'f32',
          'f64',
          'i32',
          'u32',
          'i16',
          'u16',
          'i8',
          'u8',
          'bool',
          'enum',
          'ref',
        ];
        for (const t of types) {
          const col = createColumn(t, 16);
          expect(col.arity, `Column.arity for ${t} should be 1`).toBe(1);
        }
      });

      it('empty column (capacity=0) growColumn does not divide by zero', () => {
        const col = createColumn('f32', 0, 1);
        expect(col.capacity).toBe(0);
        expect(col.arity).toBe(1);
        const grown = growColumn(col, 8);
        expect(grown.capacity).toBe(8);
        expect(grown.arity).toBe(1);
        expect(grown.buffer.byteLength).toBe(32);
      });
    });

    describe('createColumn', () => {
      it('creates a column with correct capacity', () => {
        const col = createColumn('f32', 64);
        expect(col.capacity).toBe(64);
      });

      it('creates an ArrayBuffer of correct byte length', () => {
        const col = createColumn('f32', 64);
        expect(col.buffer.byteLength).toBe(64 * 4);
      });

      it('creates a TypedArray view of correct type for f32', () => {
        const col = createColumn('f32', 16);
        expect(col.view).toBeInstanceOf(Float32Array);
        expect(col.view.length).toBe(16);
      });

      it('creates correct TypedArray view for each of the 11 scalar types', () => {
        const typeToView: Record<ScalarFieldType, unknown> = {
          f32: Float32Array,
          f64: Float64Array,
          i32: Int32Array,
          u32: Uint32Array,
          i16: Int16Array,
          u16: Uint16Array,
          i8: Int8Array,
          u8: Uint8Array,
          bool: Uint8Array,
          enum: Uint32Array,
          ref: Uint32Array,
        };
        for (const [fieldType, ViewCtor] of Object.entries(typeToView)) {
          const col = createColumn(fieldType as ScalarFieldType, 8);
          // biome-ignore lint/complexity/noBannedTypes: ViewCtor is a constructor from Object.entries, Function is the correct generic type here
          expect(col.view).toBeInstanceOf(ViewCtor as Function);
        }
      });

      it('each field has an independent ArrayBuffer (not shared)', () => {
        const col1 = createColumn('f32', 16);
        const col2 = createColumn('f32', 16);
        expect(col1.buffer).not.toBe(col2.buffer);
      });
    });

    describe('growColumn', () => {
      it('grows column to new capacity with data intact', () => {
        const col = createColumn('f32', 4);
        col.view[0] = 1.5;
        col.view[1] = 2.5;
        col.view[2] = 3.5;

        const grown = growColumn(col, 8);
        expect(grown.capacity).toBe(8);
        expect(grown.view[0]).toBeCloseTo(1.5);
        expect(grown.view[1]).toBeCloseTo(2.5);
        expect(grown.view[2]).toBeCloseTo(3.5);
      });

      it('old column is not affected by grow (fallback path)', () => {
        if (HAS_TRANSFER) {
          const col = createColumn('i32', 4);
          col.view[0] = 42;
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(42);
          expect(col.buffer.byteLength).toBe(0);
        } else {
          const col = createColumn('i32', 4);
          col.view[0] = 42;
          const grown = growColumn(col, 8);
          grown.view[0] = 99;
          expect(col.view[0]).toBe(42);
        }
      });

      it('works for all scalar field types', () => {
        const types: ScalarFieldType[] = [
          'f32',
          'f64',
          'i32',
          'u32',
          'i16',
          'u16',
          'i8',
          'u8',
          'bool',
          'enum',
          'ref',
        ];
        for (const t of types) {
          const col = createColumn(t, 4);
          col.view[0] = 1;
          const grown = growColumn(col, 8);
          expect(grown.view[0]).toBe(1);
          expect(grown.capacity).toBe(8);
        }
      });
    });

    describe('growColumn transfer() / fallback equivalence', () => {
      function fallbackGrow(
        col: {
          buffer: ArrayBuffer;
          fieldType: ScalarFieldType;
          capacity: number;
          view: { BYTES_PER_ELEMENT: number };
        },
        newCapacity: number,
      ) {
        const byteLen = col.view.BYTES_PER_ELEMENT * newCapacity;
        const buf = new ArrayBuffer(byteLen);
        new Uint8Array(buf).set(new Uint8Array(col.buffer));
        return buf;
      }

      it('both paths produce identical data for f32', () => {
        const col = createColumn('f32', 4);
        col.view[0] = 1.5;
        col.view[1] = -3.14;
        col.view[2] = 0;
        col.view[3] = 999.999;

        const fallbackBuf = fallbackGrow(col, 8);

        const grown = growColumn(col, 8);
        const grownBytes = new Uint8Array(grown.buffer, 0, 16);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 16);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
        expect(grown.view[0]).toBeCloseTo(1.5);
        expect(grown.view[1]).toBeCloseTo(-3.14);
        expect(grown.view[3]).toBeCloseTo(999.999);
      });

      it('both paths produce identical data for i32', () => {
        const col = createColumn('i32', 4);
        col.view[0] = -2147483648;
        col.view[1] = 2147483647;
        col.view[2] = 0;
        col.view[3] = 42;

        const fallbackBuf = fallbackGrow(col, 8);

        const grown = growColumn(col, 8);
        const grownBytes = new Uint8Array(grown.buffer, 0, 16);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 16);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
        expect(grown.view[0]).toBe(-2147483648);
        expect(grown.view[1]).toBe(2147483647);
        expect(grown.view[3]).toBe(42);
      });

      it('both paths produce identical data for u8 (bool backing)', () => {
        const col = createColumn('u8', 4);
        col.view[0] = 0;
        col.view[1] = 1;
        col.view[2] = 255;
        col.view[3] = 128;

        const fallbackBuf = fallbackGrow(col, 16);

        const grown = growColumn(col, 16);
        const grownBytes = new Uint8Array(grown.buffer, 0, 4);
        const fallbackBytes = new Uint8Array(fallbackBuf, 0, 4);
        expect(Array.from(grownBytes)).toEqual(Array.from(fallbackBytes));
      });

      it('data is not lost after growing to 2x, 4x, 8x capacity', () => {
        let col = createColumn('f64', 2);
        col.view[0] = Math.PI;
        col.view[1] = Math.E;

        col = growColumn(col, 4);
        expect(col.view[0]).toBeCloseTo(Math.PI, 14);
        expect(col.view[1]).toBeCloseTo(Math.E, 14);

        col = growColumn(col, 8);
        expect(col.view[0]).toBeCloseTo(Math.PI, 14);
        expect(col.view[1]).toBeCloseTo(Math.E, 14);

        col = growColumn(col, 16);
        expect(col.view[0]).toBeCloseTo(Math.PI, 14);
        expect(col.view[1]).toBeCloseTo(Math.E, 14);
        expect(col.capacity).toBe(16);
      });

      it('new capacity region is zeroed', () => {
        const col = createColumn('i32', 4);
        col.view[0] = 100;
        col.view[1] = 200;

        const grown = growColumn(col, 8);
        for (let i = 4; i < 8; i++) {
          expect(grown.view[i]).toBe(0);
        }
      });

      it('HAS_TRANSFER is a boolean', () => {
        expect(typeof HAS_TRANSFER).toBe('boolean');
      });
    });

    describe('growColumn stride-N data fidelity (AC-05)', () => {
      const ARITY = 16;
      const PATTERN = Array.from({ length: ARITY }, (_, i) => i * 1.5 + 0.1);

      function writeRow0(col: ReturnType<typeof createColumn>, vals: ReadonlyArray<number>) {
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          if (v === undefined) throw new Error('unexpected');
          col.view[i] = v;
        }
      }

      function expectRow0Unchanged(col: ReturnType<typeof createColumn>) {
        for (let i = 0; i < ARITY; i++) {
          const expected = PATTERN[i];
          if (expected === undefined) throw new Error('unexpected');
          expect(col.view[i], `row[0][${i}] after capacity ${col.capacity}`).toBeCloseTo(
            expected,
            6,
          );
        }
      }

      it('grow 0->4->8->16->32->64 preserves row 0 stride-16 data', () => {
        let col = createColumn('f32', 0, ARITY);
        expect(col.arity).toBe(ARITY);
        expect(col.capacity).toBe(0);

        const stages = [4, 8, 16, 32, 64];
        for (const cap of stages) {
          col = growColumn(col, cap);
          expect(col.capacity).toBe(cap);
          expect(col.arity).toBe(ARITY);

          if (cap === 4) {
            writeRow0(col, PATTERN);
          }

          expectRow0Unchanged(col);
        }
      });

      it('grow from nonzero capacity preserves row 0 for arity=16', () => {
        let col = createColumn('f32', 8, ARITY);
        writeRow0(col, PATTERN);

        const stages = [16, 32, 64, 128];
        for (const cap of stages) {
          col = growColumn(col, cap);
          expect(col.capacity).toBe(cap);
          expect(col.arity).toBe(ARITY);
          expectRow0Unchanged(col);
        }
      });

      it('grow from capacity 1 preserves arity=4 f64 row', () => {
        const f64pattern = [Math.PI, Math.E, Math.LN2, Math.SQRT2];
        let col = createColumn('f64', 1, 4);
        expect(col.arity).toBe(4);
        for (let i = 0; i < 4; i++) {
          const v = f64pattern[i];
          if (v === undefined) throw new Error('unexpected');
          col.view[i] = v;
        }

        const stages = [2, 4, 8, 16, 32];
        for (const cap of stages) {
          col = growColumn(col, cap);
          for (let i = 0; i < 4; i++) {
            const v = f64pattern[i];
            if (v === undefined) throw new Error('unexpected');
            expect(col.view[i], `f64[${i}] at capacity ${cap}`).toBeCloseTo(v, 14);
          }
        }
      });

      it('new capacity tail rows are zeroed for arity>1', () => {
        const AR = 3;
        const col = createColumn('u32', 2, AR);
        col.view[0] = 0xdeadbeef;
        col.view[1] = 0xcafebabe;
        col.view[2] = 0x12345678;

        const grown = growColumn(col, 4);
        for (let i = 3; i < 6; i++) {
          expect(grown.view[i], `tail row[${i}]`).toBe(0);
        }
        expect(grown.view[0]).toBe(0xdeadbeef);
        expect(grown.view[1]).toBe(0xcafebabe);
        expect(grown.view[2]).toBe(0x12345678);
      });
    });

    describe('isHotSchema', () => {
      it('returns true for all-scalar schema', () => {
        const schema: ComponentSchema = { x: 'f32', y: 'f32', z: 'f32' };
        expect(isHotSchema(schema)).toBe(true);
      });

      it('returns true for single scalar field', () => {
        expect(isHotSchema({ hp: 'i32' })).toBe(true);
      });

      it('returns true for all 11 scalar types mixed', () => {
        const schema: ComponentSchema = {
          a: 'f32',
          b: 'f64',
          c: 'i32',
          d: 'u32',
          e: 'i16',
          f: 'u16',
          g: 'i8',
          h: 'u8',
          i: 'bool',
          j: 'enum',
          k: 'ref',
        };
        expect(isHotSchema(schema)).toBe(true);
      });

      it('returns true for empty schema (tag component)', () => {
        expect(isHotSchema({})).toBe(true);
      });

      it('returns false for schema with unsupported field type (cold-table path)', () => {
        const nonScalarSchema = { data: 'string' as unknown as 'f32' };
        expect(isHotSchema(nonScalarSchema)).toBe(false);
      });
    });
  });
}

{
  // ─── from entity-column.test.ts ───
  let dummyCounter = 0;
  function defineSpawnComponent(prefix: string) {
    dummyCounter += 1;
    return defineComponent(`${prefix}_${dummyCounter}`, { x: 'f32', y: 'f32' });
  }

  function archetypeOf(world: World, e: EntityHandle): Archetype {
    const graph = (world as unknown as { graph: { archetypes: Archetype[] } }).graph;
    const records = (world as unknown as { records: { archetypeId: number }[] }).records;
    const indexSlot = (e as unknown as number) & 0xffffff;
    const archId = records[indexSlot]?.archetypeId ?? -1;
    const arch = graph.archetypes[archId];
    if (!arch) throw new Error('archetype not found for entity');
    return arch;
  }

  describe('entity-column.test.ts', () => {
    describe('Entity id=0 structural guarantee (AC-01)', () => {
      it('assigns the Entity component id=0', () => {
        expect(Entity.id).toBe(0);
      });

      it('names the single field self with the entity field type', () => {
        expect(Entity.name).toBe('Entity');
        expect(Entity.schema).toEqual({ self: 'entity' });
      });
    });

    describe('Entity barrel forced-registration fail-fast (AC-01)', () => {
      afterEach(() => {
        vi.resetModules();
      });

      it('throws at barrel eval when a component registers before Entity', async () => {
        vi.resetModules();
        const { defineComponent: freshDefine } = await import('../component');
        freshDefine('TamperOrderDummy', { x: 'f32' });
        // feat-20260611 D-9: assertion text switched from `expected id=0` to
        // `ESSENTIAL_COMPONENT_IDS invariant violated` (SSOT-driven contract).
        await expect(import('../index')).rejects.toThrow(/ESSENTIAL_COMPONENT_IDS/);
      });

      it('does not throw at barrel eval under the normal import order', async () => {
        vi.resetModules();
        await expect(import('../index')).resolves.toBeDefined();
      });
    });

    describe('archetype unconditionally carries the id=0 column (AC-02)', () => {
      it('includes the Entity column in a single-component spawn archetype', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC02_Pos');
        const e = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
        const arch = archetypeOf(world, e);
        expect(arch.columns.has(Entity.id)).toBe(true);
        expect(arch.columns.get(Entity.id)?.has('self')).toBe(true);
      });

      it('includes the Entity column in a bare (zero-component) spawn archetype', () => {
        const world = new World();
        const e = world.spawn().unwrap();
        const arch = archetypeOf(world, e);
        expect(arch.columns.has(Entity.id)).toBe(true);
        expect(arch.columns.get(Entity.id)?.has('self')).toBe(true);
      });

      it('includes the Entity column after addComponent migration', () => {
        const world = new World();
        const A = defineSpawnComponent('AC02_A');
        const B = defineSpawnComponent('AC02_B');
        const e = world.spawn({ component: A, data: { x: 0, y: 0 } }).unwrap();
        world.addComponent(e, { component: B, data: { x: 0, y: 0 } }).unwrap();
        const arch = archetypeOf(world, e);
        expect(arch.columns.has(Entity.id)).toBe(true);
        expect(arch.columns.get(Entity.id)?.has('self')).toBe(true);
      });
    });

    describe('world.get(e, Entity).self carries the row handle (AC-03)', () => {
      it('reads the full packed handle off the id=0 column for a single-component entity', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC03_Pos');
        const e = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
        const got = world.get(e, Entity).unwrap();
        const self: EntityHandle | null = got.self;
        expect(self).toBe(e);
      });

      it('reads the handle off a bare (zero-component) entity', () => {
        const world = new World();
        const e = world.spawn().unwrap();
        expect(world.get(e, Entity).unwrap().self).toBe(e);
      });

      it('preserves the handle across an addComponent archetype migration', () => {
        const world = new World();
        const A = defineSpawnComponent('AC03_A');
        const B = defineSpawnComponent('AC03_B');
        const e = world.spawn({ component: A, data: { x: 0, y: 0 } }).unwrap();
        world.addComponent(e, { component: B, data: { x: 0, y: 0 } }).unwrap();
        expect(world.get(e, Entity).unwrap().self).toBe(e);
      });
    });

    describe('world.get(e, Entity) as a liveness probe (AC-04)', () => {
      it('returns stale-entity for a despawned handle', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC04_Pos');
        const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
        world.despawn(e).unwrap();
        const r = world.get(e, Entity);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('stale-entity');
        }
      });
    });

    describe('removeComponent(e, Entity) is rejected (AC-05)', () => {
      it('returns remove-essential-component and leaves the Entity column intact', () => {
        const world = new World();
        const Position = defineSpawnComponent('AC05_Pos');
        const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
        const r = world.removeComponent(e, Entity);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('remove-essential-component');
          if (r.error.code === 'remove-essential-component') {
            expect(r.error.detail.componentName).toBe('Entity');
          }
        }
        const arch = archetypeOf(world, e);
        expect(arch.columns.has(Entity.id)).toBe(true);
        expect(world.get(e, Entity).unwrap().self).toBe(e);
      });
    });
  });
}

{
  // ─── from fixed-array-inline.test.ts ───
  describe('fixed-array-inline.test.ts', () => {
    describe('fixed array<f32, 16> inline column (AC-02 / w5)', () => {
      it('spawn->get round-trips all 16 f32 elements', () => {
        const Mat = defineComponent('Mat16', { m: 'array<f32, 16>' });
        const world = new World();
        const values = Float32Array.from({ length: 16 }, (_, i) => (i + 1) * 1.5);
        const e = world.spawn({ component: Mat, data: { m: values } }).unwrap();

        const read = world.get(e, Mat).unwrap().m;
        expect(read).toBeInstanceOf(Float32Array);
        expect(read.length).toBe(16);
        for (let i = 0; i < 16; i++) {
          expect(read[i]).toBe(values[i]);
        }
      });

      // Regression (downstream template integration #2): the plain-JS-array
      // convenience path used to pack elements by byte SIZE, so a 4-byte f32
      // went through setUint32 -- storing `1` as the integer bits 0x00000001
      // (reads back ~1.4e-45 ~ 0). AnimationPlayer.speeds=[1] froze on frame 0.
      // Packing must dispatch on the declared element TYPE, not byte size.
      it('plain-JS-array write to array<f32,4> stores f32 VALUES, not u32 bits', () => {
        const C = defineComponent('PlainF32Fixed', { v: 'array<f32, 4>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { v: [1, 0.5, -2, 3.25] } }).unwrap();

        const read = world.get(e, C).unwrap().v;
        expect(read).toBeInstanceOf(Float32Array);
        expect(read[0]).toBe(1);
        expect(read[1]).toBe(0.5);
        expect(read[2]).toBe(-2);
        expect(read[3]).toBe(3.25);
      });

      it('plain-JS-array write to variable array<f32> stores f32 VALUES', () => {
        const C = defineComponent('PlainF32Var', { v: 'array<f32>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { v: [1, 2.5] } }).unwrap();

        const read = world.get(e, C).unwrap().v;
        expect(read).toBeInstanceOf(Float32Array);
        expect(read.length).toBe(2);
        expect(read[0]).toBe(1);
        expect(read[1]).toBe(2.5);
      });

      // Control: u32 elements are genuinely integers -- the type-keyed packer
      // must keep storing them verbatim (no regression in the handle/u32 path).
      it('plain-JS-array write to array<u32,3> still stores integer values verbatim', () => {
        const C = defineComponent('PlainU32Fixed', { v: 'array<u32, 3>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { v: [7, 42, 1000] } }).unwrap();

        const read = world.get(e, C).unwrap().v;
        expect(read).toBeInstanceOf(Uint32Array);
        expect(read[0]).toBe(7);
        expect(read[1]).toBe(42);
        expect(read[2]).toBe(1000);
      });
    });

    describe('fixed buffer<64> inline column (AC-03 / w6)', () => {
      it('spawn->get round-trips all 64 bytes', () => {
        const Blob = defineComponent('Blob64', { b: 'buffer<64>' });
        const world = new World();
        const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
        const e = world.spawn({ component: Blob, data: { b: bytes } }).unwrap();

        const read = world.get(e, Blob).unwrap().b;
        expect(read).toBeInstanceOf(Uint8Array);
        expect(read.length).toBe(64);
        for (let i = 0; i < 64; i++) {
          expect(read[i]).toBe(bytes[i]);
        }
      });
    });

    describe('fixed array<entity, 4> inline column (AC-04 / w7)', () => {
      it('spawn->get reinterprets the 4 entity ids as Uint32Array', () => {
        const Refs = defineComponent('EntRefs4', { targets: 'array<entity, 4>' });
        const world = new World();
        const Tag = defineComponent('FixedArrTag', {});
        const t0 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t1 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t2 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t3 = world.spawn({ component: Tag, data: {} }).unwrap();
        const ids = Uint32Array.of(t0 as number, t1 as number, t2 as number, t3 as number);

        const holder = world.spawn({ component: Refs, data: { targets: ids } }).unwrap();
        const read = world.get(holder, Refs).unwrap().targets;
        expect(read).toBeInstanceOf(Uint32Array);
        expect(read.length).toBe(4);
        expect(read[0]).toBe(t0 as number);
        expect(read[1]).toBe(t1 as number);
        expect(read[2]).toBe(t2 as number);
        expect(read[3]).toBe(t3 as number);
      });

      it('_getArrayView serves a non-f32 element type after the f32 gate is removed', () => {
        const Refs = defineComponent('EntRefsView4', { targets: 'array<entity, 4>' });
        const world = new World();
        const Tag = defineComponent('TagView', {});
        const t0 = world.spawn({ component: Tag, data: {} }).unwrap();
        const t1 = world.spawn({ component: Tag, data: {} }).unwrap();
        const ids = Uint32Array.of(t0 as number, t1 as number, 0, 0);
        const holder = world.spawn({ component: Refs, data: { targets: ids } }).unwrap();

        const view = (
          world as unknown as {
            _getArrayView(e: unknown, c: unknown, f: string): ArrayLike<number> | undefined;
          }
        )._getArrayView(holder, Refs, 'targets');
        expect(view).toBeDefined();
        expect(view?.length).toBe(4);
        expect(view?.[0]).toBe(t0 as number);
        expect(view?.[1]).toBe(t1 as number);
      });
    });

    describe('swap-remove migrates the whole stride-N block (AC-06 / w8)', () => {
      it('removing a middle row moves the last row block intact', () => {
        const Mat = defineComponent('Mat16Swap', { m: 'array<f32, 16>' });
        const world = new World();
        const row = (base: number) => Float32Array.from({ length: 16 }, (_, i) => base + i);
        const e0 = world.spawn({ component: Mat, data: { m: row(100) } }).unwrap();
        const e1 = world.spawn({ component: Mat, data: { m: row(200) } }).unwrap();
        const e2 = world.spawn({ component: Mat, data: { m: row(300) } }).unwrap();

        world.despawn(e0);

        const r2 = world.get(e2, Mat).unwrap().m;
        expect(r2.length).toBe(16);
        for (let i = 0; i < 16; i++) {
          expect(r2[i]).toBe(300 + i);
        }
        const r1 = world.get(e1, Mat).unwrap().m;
        for (let i = 0; i < 16; i++) {
          expect(r1[i]).toBe(200 + i);
        }
      });
    });

    describe('fixed-only component leaves BufferPool live-count at 0 (AC-07 / w9)', () => {
      const liveCount = (world: World): number =>
        (world as unknown as { bufferPool: { _liveCount(): number } }).bufferPool._liveCount();

      it('array<f32,16>-only spawn->get->despawn never touches the pool', () => {
        const Mat = defineComponent('Mat16Pool', { m: 'array<f32, 16>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world
          .spawn({ component: Mat, data: { m: Float32Array.from({ length: 16 }, (_, i) => i) } })
          .unwrap();
        expect(liveCount(world)).toBe(0);

        world.get(e, Mat).unwrap().m;
        expect(liveCount(world)).toBe(0);

        world.despawn(e);
        expect(liveCount(world)).toBe(0);
      });

      it('buffer<64>-only spawn->get->despawn never touches the pool', () => {
        const Blob = defineComponent('Blob64Pool', { b: 'buffer<64>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world.spawn({ component: Blob, data: { b: new Uint8Array(64) } }).unwrap();
        expect(liveCount(world)).toBe(0);

        world.get(e, Blob).unwrap().b;
        expect(liveCount(world)).toBe(0);

        world.despawn(e);
        expect(liveCount(world)).toBe(0);
      });
    });

    describe('AC-08 variable array<T> push/pop/capacity post-inline (w15)', () => {
      const liveCount = (world: World): number =>
        (world as unknown as { bufferPool: { _liveCount(): number } }).bufferPool._liveCount();

      it('push grows capacity and increments snapshot length', () => {
        const C = defineComponent('VarF32Arr', { values: 'array<f32>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world.spawn({ component: C, data: { values: new Float32Array(0) } }).unwrap();
        expect(liveCount(world)).toBeGreaterThan(0);

        world.push(e, C, 'values', 1.5).unwrap();
        world.push(e, C, 'values', 2.5).unwrap();
        world.push(e, C, 'values', 3.5).unwrap();

        const snap = world.get(e, C).unwrap().values;
        expect(snap).toBeInstanceOf(Float32Array);
        expect(snap.length).toBe(3);
        expect(snap[0]).toBe(1.5);
        expect(snap[1]).toBe(2.5);
        expect(snap[2]).toBe(3.5);

        const cap = world.capacity(e, C, 'values').unwrap();
        expect(cap).toBeGreaterThanOrEqual(3);
      });

      it('pop shrinks snapshot length and returns the last element', () => {
        const C = defineComponent('VarU32Arr', { indices: 'array<u32>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { indices: new Uint32Array(0) } }).unwrap();

        world.push(e, C, 'indices', 10).unwrap();
        world.push(e, C, 'indices', 20).unwrap();
        world.push(e, C, 'indices', 30).unwrap();
        expect(world.get(e, C).unwrap().indices.length).toBe(3);

        const popped = world.pop(e, C, 'indices').unwrap();
        expect(popped).toBe(30);
        expect(world.get(e, C).unwrap().indices.length).toBe(2);

        const popped2 = world.pop(e, C, 'indices').unwrap();
        expect(popped2).toBe(20);
        expect(world.get(e, C).unwrap().indices.length).toBe(1);

        const popped3 = world.pop(e, C, 'indices').unwrap();
        expect(popped3).toBe(10);
        expect(world.get(e, C).unwrap().indices.length).toBe(0);

        const r = world.pop(e, C, 'indices');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('array-pop-empty');
      });

      it('capacity tracks variable growth independently', () => {
        const C = defineComponent('VarEntities', { refs: 'array<entity>' });
        const world = new World();
        const e = world.spawn({ component: C, data: { refs: new Uint32Array(0) } }).unwrap();
        expect(world.capacity(e, C, 'refs').unwrap()).toBe(0);

        world.push(e, C, 'refs', 1 as unknown as import('../entity-handle').EntityHandle).unwrap();
        expect(world.capacity(e, C, 'refs').unwrap()).toBeGreaterThanOrEqual(1);

        world.push(e, C, 'refs', 2 as unknown as import('../entity-handle').EntityHandle).unwrap();
        expect(world.capacity(e, C, 'refs').unwrap()).toBeGreaterThanOrEqual(2);
      });

      it('variable array survives despawn pool-release cycle', () => {
        const C = defineComponent('VarTmp', { data: 'array<f32>' });
        const world = new World();

        const e = world.spawn({ component: C, data: { data: new Float32Array(0) } }).unwrap();
        world.push(e, C, 'data', 42).unwrap();
        const beforeCount = liveCount(world);
        expect(beforeCount).toBeGreaterThan(0);

        world.despawn(e).unwrap();
      });

      it('variable array pool _liveCount is correct with fresh world', () => {
        const C = defineComponent('VarTmp2', { data: 'array<f32>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world.spawn({ component: C, data: { data: new Float32Array(0) } }).unwrap();
        expect(liveCount(world)).toBe(1);

        world.push(e, C, 'data', 1).unwrap();
        expect(liveCount(world)).toBe(1);

        world.despawn(e).unwrap();
        expect(liveCount(world)).toBe(0);
      });
    });

    describe('AC-08 variable buffer (no N) path post-inline (w15)', () => {
      const liveCount = (world: World): number =>
        (world as unknown as { bufferPool: { _liveCount(): number } }).bufferPool._liveCount();

      it('variable buffer spawn->set->get round-trip works', () => {
        const C = defineComponent('VarBuf', { blob: 'buffer' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const payload = Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd);
        const e = world.spawn({ component: C, data: { blob: payload } }).unwrap();
        expect(liveCount(world)).toBe(1);

        const snap = world.get(e, C).unwrap().blob;
        expect(snap).toBeInstanceOf(Uint8Array);
        expect(snap.length).toBe(4);
        expect(snap[0]).toBe(0xaa);
        expect(snap[3]).toBe(0xdd);
      });

      it('variable buffer grows via set with larger payload', () => {
        const C = defineComponent('VarBuf2', { blob: 'buffer' });
        const world = new World();
        const small = Uint8Array.of(0x01, 0x02);
        const e = world.spawn({ component: C, data: { blob: small } }).unwrap();

        expect(world.get(e, C).unwrap().blob.length).toBe(2);

        const large = new Uint8Array(32);
        for (let i = 0; i < 32; i++) large[i] = i + 0x10;
        world.set(e, C, { blob: large }).unwrap();

        const snap = world.get(e, C).unwrap().blob;
        expect(snap.length).toBe(32);
        for (let i = 0; i < 32; i++) expect(snap[i]).toBe(i + 0x10);
      });

      it('variable buffer release path: despawn returns slot to pool', () => {
        const C = defineComponent('VarBuf3', { blob: 'buffer' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e = world.spawn({ component: C, data: { blob: Uint8Array.of(0xfe) } }).unwrap();
        expect(liveCount(world)).toBe(1);

        world.despawn(e).unwrap();
        expect(liveCount(world)).toBe(0);
      });

      it('variable + fixed coexistence: pool count only reflects variable fields', () => {
        const VarArr = defineComponent('VarArr', { data: 'array<f32>' });
        const FixedMat = defineComponent('FixedMat', { m: 'array<f32, 16>' });
        const world = new World();
        expect(liveCount(world)).toBe(0);

        const e1 = world.spawn({ component: FixedMat, data: { m: new Float32Array(16) } }).unwrap();
        expect(liveCount(world)).toBe(0);

        const e2 = world
          .spawn(
            { component: FixedMat, data: { m: new Float32Array(16) } },
            { component: VarArr, data: { data: new Float32Array(0) } },
          )
          .unwrap();
        expect(liveCount(world)).toBe(1);

        world.despawn(e2).unwrap();
        expect(liveCount(world)).toBe(0);

        world.despawn(e1).unwrap();
        expect(liveCount(world)).toBe(0);
      });
    });
  });
}

{
  // ─── from query-preregister.test.ts ───
  describe('query-preregister.test.ts', () => {
    describe('Query — define before spawn (Bug 1)', () => {
      it('query still matches entities spawned with a freshly defined component', () => {
        const world = new World();
        const A = defineComponent('PreReg_A', { x: { type: 'f32' } });
        const B = defineComponent('PreReg_B', { y: { type: 'f32' } });

        world.spawn({ component: A, data: { x: 1 } }, { component: B, data: { y: 2 } });

        const state = createQueryState({ with: [A, B, Entity] });
        let total = 0;
        queryRun(state, world, (bundle) => {
          total += bundle.Entity.self.length;
        });
        expect(total).toBe(1);
      });

      it('an unrelated defined component does not affect query matching', () => {
        const world = new World();
        const A = defineComponent('PreRegUnrel_A', { x: 'f32' });
        const B = defineComponent('PreRegUnrel_B', { y: 'f32' });
        defineComponent('PreRegUnrel_C', { z: 'f32' });

        world.spawn({ component: A, data: { x: 1 } }, { component: B, data: { y: 2 } });

        const state = createQueryState({ with: [A, B, Entity] });
        let total = 0;
        queryRun(state, world, (bundle) => {
          total += bundle.Entity.self.length;
        });
        expect(total).toBe(1);
      });

      it('query state reused across multiple queryRun invocations matches entities spawned after first run', () => {
        const world = new World();
        const A = defineComponent('PreRegReuse_A', { x: { type: 'f32' } });
        const B = defineComponent('PreRegReuse_B', { y: { type: 'f32' } });

        const state = createQueryState({ with: [A, B, Entity] });

        let total = 0;
        queryRun(state, world, (bundle) => {
          total += bundle.Entity.self.length;
        });
        expect(total).toBe(0);

        world.spawn({ component: A, data: { x: 1 } }, { component: B, data: { y: 2 } });

        total = 0;
        queryRun(state, world, (bundle) => {
          total += bundle.Entity.self.length;
        });
        expect(total).toBe(1);
      });

      it('defining all query components then spawning still works', () => {
        const world = new World();
        const A = defineComponent('PreRegAll_A', { x: { type: 'f32' } });
        const B = defineComponent('PreRegAll_B', { y: { type: 'f32' } });
        const C = defineComponent('PreRegAll_C', { z: { type: 'f32' } });

        world.spawn(
          { component: A, data: { x: 1 } },
          { component: B, data: { y: 2 } },
          { component: C, data: { z: 3 } },
        );

        const state = createQueryState({ with: [A, B, Entity] });
        let total = 0;
        queryRun(state, world, (bundle) => {
          total += bundle.Entity.self.length;
        });
        expect(total).toBe(1);
      });
    });
  });
}

{
  // ─── from query.test.ts ───
  function collectBundles(
    state: QueryState,
    world: World,
  ): Array<{ entityCount: number; [k: string]: unknown }> {
    const bundles: Array<{ entityCount: number; [k: string]: unknown }> = [];
    // The `entityCount` field is synthesized at this test helper boundary —
    // ColumnBundle no longer carries it (tweak-20260612-ecs-concept-compression
    // dropped the duplicate; row count is `bundle.Entity.self.length` for any
    // query with `Entity` in `with`). Many of the legacy assertions below
    // express row count without explicitly requesting Entity, so we recover it
    // from the matched archetype index via `_getGraph()` after queryRun fires.
    const graph = (
      world as unknown as { _getGraph(): { archetypes: Array<{ size: number } | undefined> } }
    )._getGraph();
    // First pass: warm matchedArchetypes via the underlying queryRun, then
    // second pass: emit one entry per non-empty matched archetype with its
    // size sourced from the graph (queryRun skips arch.size===0, so we mirror
    // that order here).
    // biome-ignore lint/suspicious/noExplicitAny: test helper, generic erasure intentional
    (queryRun as any)(state, world, () => {});
    const matched = state.matchedArchetypes ?? [];
    let i = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test helper, generic erasure intentional
    (queryRun as any)(state, world, (bundle: any) => {
      // Step `i` past any archetypes queryRun skipped (arch.size === 0).
      while (i < matched.length) {
        const archId = matched[i];
        if (archId !== undefined && (graph.archetypes[archId]?.size ?? 0) > 0) break;
        i++;
      }
      const archId = matched[i++];
      const size = archId !== undefined ? (graph.archetypes[archId]?.size ?? 0) : 0;
      bundles.push({ entityCount: size, ...bundle });
    });
    return bundles;
  }

  describe('query.test.ts', () => {
    describe('Query — With matching', () => {
      it('returns archetypes containing all With components', () => {
        const world = new World();
        const Pos = defineComponent('QWPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Vel = defineComponent('QWVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
        const Hp = defineComponent('QWHp', { hp: { type: 'i32' } });

        world.spawn(
          { component: Pos, data: { x: 1, y: 2 } },
          { component: Vel, data: { vx: 3, vy: 4 } },
        );

        world.spawn({ component: Pos, data: { x: 5, y: 6 } });

        world.spawn(
          { component: Pos, data: { x: 7, y: 8 } },
          { component: Vel, data: { vx: 9, vy: 10 } },
          { component: Hp, data: { hp: 100 } },
        );

        const desc: QueryDescriptor = { with: [Pos, Vel] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(2);

        const totalCount = bundles.reduce((sum, b) => sum + b.entityCount, 0);
        expect(totalCount).toBe(2);
      });

      it('single-component With matches all archetypes containing it', () => {
        const world = new World();
        const Pos = defineComponent('QW1Pos', { x: { type: 'f32' } });
        const Vel = defineComponent('QW1Vel', { v: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1 } });
        world.spawn({ component: Pos, data: { x: 2 } }, { component: Vel, data: { v: 3 } });

        const desc: QueryDescriptor = { with: [Pos] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(2);
        const totalCount = bundles.reduce((sum, b) => sum + b.entityCount, 0);
        expect(totalCount).toBe(2);
      });
    });

    describe('Query — Without exclusion', () => {
      it('excludes archetypes containing Without components', () => {
        const world = new World();
        const Pos = defineComponent('QWOPos', { x: { type: 'f32' } });
        const Static = defineComponent('QWOStatic', {});

        world.spawn({ component: Pos, data: { x: 1 } });

        world.spawn({ component: Pos, data: { x: 2 } }, { component: Static, data: {} });

        const desc: QueryDescriptor = { with: [Pos], without: [Static] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        expect(bundles[0]?.entityCount).toBe(1);
      });
    });

    describe('Query — With + Without combination', () => {
      it('correctly combines With inclusion and Without exclusion', () => {
        const world = new World();
        const Pos = defineComponent('QCPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Vel = defineComponent('QCVel', { vx: { type: 'f32' } });
        const Frozen = defineComponent('QCFrozen', {});

        world.spawn({ component: Pos, data: { x: 1, y: 2 } }, { component: Vel, data: { vx: 3 } });

        world.spawn(
          { component: Pos, data: { x: 4, y: 5 } },
          { component: Vel, data: { vx: 6 } },
          { component: Frozen, data: {} },
        );

        world.spawn({ component: Pos, data: { x: 7, y: 8 } });

        const desc: QueryDescriptor = { with: [Pos, Vel], without: [Frozen] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        expect(bundles[0]?.entityCount).toBe(1);
      });
    });

    describe('Query — hot-table TypedArray view (AC-09)', () => {
      it('returns column bundle with TypedArray subarray views sharing archetype buffer', () => {
        const world = new World();
        const Pos = defineComponent('QHotPos', { x: { type: 'f32' }, y: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1.5, y: 2.5 } });
        world.spawn({ component: Pos, data: { x: 3.5, y: 4.5 } });

        const desc: QueryDescriptor = { with: [Pos] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bundle = bundles[0]!;
        expect(bundle.entityCount).toBe(2);

        const posFields = bundle.QHotPos as Record<string, Float32Array>;
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const x = posFields.x!;
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const y = posFields.y!;

        expect(x).toBeInstanceOf(Float32Array);
        expect(y).toBeInstanceOf(Float32Array);
        expect(x.length).toBe(2);
        expect(y.length).toBe(2);

        expect(x[0]).toBeCloseTo(1.5);
        expect(x[1]).toBeCloseTo(3.5);
        expect(y[0]).toBeCloseTo(2.5);
        expect(y[1]).toBeCloseTo(4.5);
      });

      it('TypedArray view.buffer is the same as the archetype column buffer', () => {
        const world = new World();
        const Pos = defineComponent('QBufPos', { x: { type: 'f32' }, y: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1, y: 2 } });

        const desc: QueryDescriptor = { with: [Pos] };
        const state = createQueryState(desc);

        let capturedX: Float32Array | null = null;
        queryRun(state, world, (bundle) => {
          // biome-ignore lint/style/noNonNullAssertion: Record key known present in test
          capturedX = (bundle.QBufPos as Record<string, Float32Array>).x!;
        });
        expect(capturedX).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        expect(capturedX!).toBeInstanceOf(Float32Array);

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        capturedX![0] = 99;

        world.spawn({ component: Pos, data: { x: 0, y: 0 } });
        let verified = false;
        queryRun(state, world, (bundle) => {
          // biome-ignore lint/style/noNonNullAssertion: Record key known present in test
          const x = (bundle.QBufPos as Record<string, Float32Array>).x!;
          if (x[0] === 99) {
            verified = true;
          }
        });
        expect(verified).toBe(true);
      });

      it('multi-component hot-table returns bundle per With component', () => {
        const world = new World();
        const Pos = defineComponent('QMCPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Vel = defineComponent('QMCVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });

        world.spawn(
          { component: Pos, data: { x: 1, y: 2 } },
          { component: Vel, data: { vx: 3, vy: 4 } },
        );

        const desc: QueryDescriptor = { with: [Pos, Vel] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bundle = bundles[0]!;
        expect(bundle.entityCount).toBe(1);

        const posFields = bundle.QMCPos as Record<string, Float32Array>;
        const velFields = bundle.QMCVel as Record<string, Float32Array>;
        expect(posFields.x).toBeInstanceOf(Float32Array);
        expect(posFields.y).toBeInstanceOf(Float32Array);
        expect(velFields.vx).toBeInstanceOf(Float32Array);
        expect(velFields.vy).toBeInstanceOf(Float32Array);

        expect(posFields.x?.[0]).toBeCloseTo(1);
        expect(posFields.y?.[0]).toBeCloseTo(2);
        expect(velFields.vx?.[0]).toBeCloseTo(3);
        expect(velFields.vy?.[0]).toBeCloseTo(4);
      });
    });

    describe('Query — inline array<T,N> bundle stride (bug-20260612)', () => {
      // Regression for tweak-20260611 / render-system-extract.ts:1258 finding:
      // buildColumnBundle previously called col.view.subarray(0, arch.size),
      // which for an inline array<T,N> column (arity=N) truncated the view to
      // the first arch.size elements (= column 0 of each row only). With the
      // arity-aware fix, row i lives at view.subarray(i*N, (i+1)*N).
      it('exposes the full stride-N flat slice for an array<f32, 4> column', () => {
        const world = new World();
        const SRO = defineComponent('QInlineSRO', {
          region: { type: 'array<f32, 4>' },
        });

        // Three rows with distinct 4-tuples so a stride bug aliases.
        world.spawn({ component: SRO, data: { region: new Float32Array([0.0, 0.1, 0.2, 0.3]) } });
        world.spawn({ component: SRO, data: { region: new Float32Array([1.0, 1.1, 1.2, 1.3]) } });
        world.spawn({ component: SRO, data: { region: new Float32Array([2.0, 2.1, 2.2, 2.3]) } });

        const desc: QueryDescriptor = { with: [SRO] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bundle = bundles[0]!;
        expect(bundle.entityCount).toBe(3);

        const fields = bundle.QInlineSRO as Record<string, Float32Array>;
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const region = fields.region!;
        expect(region).toBeInstanceOf(Float32Array);
        // size * arity = 3 * 4 = 12, NOT 3 (the pre-fix truncation length).
        expect(region.length).toBe(12);

        // Row i at [i*4, i*4+4).
        for (let row = 0; row < 3; row++) {
          for (let lane = 0; lane < 4; lane++) {
            // biome-ignore lint/style/noNonNullAssertion: bounds verified above
            expect(region[row * 4 + lane]!).toBeCloseTo(row + lane * 0.1);
          }
        }
      });

      it('same row layout when read through queryRun callback (alias check)', () => {
        const world = new World();
        const SRO = defineComponent('QInlineSRO2', {
          region: { type: 'array<f32, 4>' },
        });

        world.spawn({ component: SRO, data: { region: new Float32Array([10, 20, 30, 40]) } });
        world.spawn({ component: SRO, data: { region: new Float32Array([50, 60, 70, 80]) } });

        const state = createQueryState({ with: [SRO, Entity] });

        let captured: Float32Array | null = null;
        let entityCount = 0;
        queryRun(state, world, (bundle) => {
          entityCount = bundle.Entity.self.length;
          // biome-ignore lint/style/noNonNullAssertion: Record key known present in test
          captured = (bundle.QInlineSRO2 as Record<string, Float32Array>).region!;
        });

        expect(entityCount).toBe(2);
        expect(captured).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const region = captured!;
        expect(region.length).toBe(8);
        expect(Array.from(region)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
      });

      it('mixed scalar + inline array bundle keeps both stride conventions', () => {
        const world = new World();
        const Pos = defineComponent('QMixPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const SRO = defineComponent('QMixSRO', {
          region: { type: 'array<f32, 4>' },
        });

        world.spawn(
          { component: Pos, data: { x: 1, y: 2 } },
          { component: SRO, data: { region: new Float32Array([0.5, 0.5, 0.25, 0.25]) } },
        );
        world.spawn(
          { component: Pos, data: { x: 3, y: 4 } },
          { component: SRO, data: { region: new Float32Array([1, 1, 0.5, 0.5]) } },
        );

        const desc: QueryDescriptor = { with: [Pos, SRO] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);
        expect(bundles.length).toBe(1);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bundle = bundles[0]!;
        expect(bundle.entityCount).toBe(2);

        const pos = bundle.QMixPos as Record<string, Float32Array>;
        const sro = bundle.QMixSRO as Record<string, Float32Array>;

        // Scalar columns: arity=1, length=2.
        expect(pos.x?.length).toBe(2);
        expect(pos.y?.length).toBe(2);
        expect(pos.x?.[0]).toBeCloseTo(1);
        expect(pos.x?.[1]).toBeCloseTo(3);

        // Inline array<f32, 4>: arity=4, length=8.
        expect(sro.region?.length).toBe(8);
        expect(sro.region?.[4]).toBeCloseTo(1);
        expect(sro.region?.[7]).toBeCloseTo(0.5);
      });

      it('exposes inline array column the same way through `optional`', () => {
        const world = new World();
        const Anchor = defineComponent('QInlineAnchor', { x: { type: 'f32' } });
        const SRO = defineComponent('QInlineOptSRO', {
          region: { type: 'array<f32, 4>' },
        });

        world.spawn(
          { component: Anchor, data: { x: 1 } },
          { component: SRO, data: { region: new Float32Array([9, 8, 7, 6]) } },
        );

        const desc: QueryDescriptor = { with: [Anchor], optional: [SRO] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bundle = bundles[0]!;
        const sro = bundle.QInlineOptSRO as Record<string, Float32Array> | undefined;
        expect(sro).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: presence asserted above
        expect(sro!.region?.length).toBe(4);
        // biome-ignore lint/style/noNonNullAssertion: presence asserted above
        expect(Array.from(sro!.region ?? [])).toEqual([9, 8, 7, 6]);
      });
    });

    describe('Query — tag component (E-11)', () => {
      it('tag component in With filter matches but bundle has no tag fields', () => {
        const world = new World();
        const Pos = defineComponent('QTagPos', { x: { type: 'f32' } });
        const Player = defineComponent('QTagPlayer', {});

        world.spawn({ component: Pos, data: { x: 1 } }, { component: Player, data: {} });

        world.spawn({ component: Pos, data: { x: 2 } });

        const desc: QueryDescriptor = { with: [Pos, Player] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        expect(bundles[0]?.entityCount).toBe(1);

        const posFields = bundles[0]?.QTagPos as Record<string, Float32Array>;
        expect(posFields).toBeDefined();
        expect(posFields.x).toBeInstanceOf(Float32Array);
        expect(posFields.x?.[0]).toBeCloseTo(1);
      });

      it('tag-only query matches archetypes with the tag', () => {
        const world = new World();
        const Tag = defineComponent('QTOnly', {});
        const Pos = defineComponent('QTOPos', { x: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1 } }, { component: Tag, data: {} });

        const desc: QueryDescriptor = { with: [Tag] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        expect(bundles[0]?.entityCount).toBe(1);
      });
    });

    describe('Query — empty query (E-10)', () => {
      it('query with no matching archetypes returns empty iteration', () => {
        const world = new World();
        const A = defineComponent('QEmpA', { v: { type: 'f32' } });
        const B = defineComponent('QEmpB', { v: { type: 'f32' } });

        world.spawn({ component: A, data: { v: 1 } });

        const desc: QueryDescriptor = { with: [B] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(0);
      });

      it('query on empty world returns empty iteration', () => {
        const world = new World();
        const A = defineComponent('QEmpW', { v: { type: 'f32' } });

        const desc: QueryDescriptor = { with: [A] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(0);
      });
    });

    describe('Query — bitmask matching', () => {
      it('correctly matches with many components using bitmask', () => {
        const world = new World();
        const comps = Array.from({ length: 8 }, (_, i) =>
          defineComponent(`QBit${i}`, { v: { type: 'f32' } }),
        );

        world.spawn(...comps.slice(0, 4).map((c) => ({ component: c, data: { v: 0 } })));

        world.spawn(
          // biome-ignore lint/style/noNonNullAssertion: controlled test context
          ...[comps[0]!, comps[1]!, comps[4]!, comps[5]!].map((c) => ({
            component: c,
            data: { v: 0 },
          })),
        );

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const desc1: QueryDescriptor = { with: [comps[0]!, comps[1]!] };
        const state1 = createQueryState(desc1);
        const bundles1 = collectBundles(state1, world);
        expect(bundles1.length).toBe(2);

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const desc2: QueryDescriptor = { with: [comps[0]!, comps[2]!] };
        const state2 = createQueryState(desc2);
        const bundles2 = collectBundles(state2, world);
        expect(bundles2.length).toBe(1);

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const desc3: QueryDescriptor = { with: [comps[0]!, comps[1]!], without: [comps[4]!] };
        const state3 = createQueryState(desc3);
        const bundles3 = collectBundles(state3, world);
        expect(bundles3.length).toBe(1);
      });
    });

    describe('Query — ArchetypeGeneration incremental cache', () => {
      it('new archetype is picked up after initial query run', () => {
        const world = new World();
        const Pos = defineComponent('QGenPos', { x: { type: 'f32' } });
        const Vel = defineComponent('QGenVel', { v: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1 } });

        const desc: QueryDescriptor = { with: [Pos] };
        const state = createQueryState(desc);

        let bundles = collectBundles(state, world);
        expect(bundles.length).toBe(1);

        world.spawn({ component: Pos, data: { x: 2 } }, { component: Vel, data: { v: 3 } });

        bundles = collectBundles(state, world);
        expect(bundles.length).toBe(2);
      });

      it('cache is correctly maintained across multiple archetype additions', () => {
        const world = new World();
        const A = defineComponent('QGen2A', { v: { type: 'f32' } });
        const B = defineComponent('QGen2B', { v: { type: 'f32' } });
        const C = defineComponent('QGen2C', { v: { type: 'f32' } });

        const desc: QueryDescriptor = { with: [A] };
        const state = createQueryState(desc);

        let bundles = collectBundles(state, world);
        expect(bundles.length).toBe(0);

        world.spawn({ component: A, data: { v: 1 } });
        bundles = collectBundles(state, world);
        expect(bundles.length).toBe(1);

        world.spawn({ component: A, data: { v: 2 } }, { component: B, data: { v: 3 } });
        bundles = collectBundles(state, world);
        expect(bundles.length).toBe(2);

        world.spawn({ component: B, data: { v: 4 } });
        bundles = collectBundles(state, world);
        expect(bundles.length).toBe(2);

        world.spawn(
          { component: A, data: { v: 5 } },
          { component: B, data: { v: 6 } },
          { component: C, data: { v: 7 } },
        );
        bundles = collectBundles(state, world);
        expect(bundles.length).toBe(3);
      });
    });

    describe('Query — per-archetype version stamp (D-10)', () => {
      it('query rebuilds column bundle after archetype grows (TypedArray view refreshed)', () => {
        const world = new World();
        const Pos = defineComponent('QVerPos', { x: { type: 'f32' } });

        for (let i = 0; i < 64; i++) {
          world.spawn({ component: Pos, data: { x: i } });
        }

        const desc: QueryDescriptor = { with: [Pos] };
        const state = createQueryState(desc);

        let capturedBundle: Record<string, unknown> = {};
        queryRun(state, world, (bundle) => {
          capturedBundle = { ...bundle };
        });
        // biome-ignore lint/style/noNonNullAssertion: Record key known present in test
        const firstX = (capturedBundle.QVerPos as Record<string, Float32Array>).x!;
        expect(firstX.length).toBe(64);

        world.spawn({ component: Pos, data: { x: 999 } });

        let secondBundle: Record<string, unknown> = {};
        queryRun(state, world, (bundle) => {
          secondBundle = { ...bundle };
        });

        // biome-ignore lint/style/noNonNullAssertion: Record key known present in test
        const secondX = (secondBundle.QVerPos as Record<string, Float32Array>).x!;
        expect(secondX.length).toBe(65);
        expect(secondX[64]).toBeCloseTo(999);

        expect(secondX.buffer).not.toBe(firstX.buffer);
      });

      it('version stamp only invalidates the grown archetype, not others', () => {
        const world = new World();
        const A = defineComponent('QVer2A', { v: { type: 'f32' } });
        const B = defineComponent('QVer2B', { v: { type: 'f32' } });

        for (let i = 0; i < 64; i++) {
          world.spawn({ component: A, data: { v: i } });
        }

        world.spawn({ component: A, data: { v: 100 } }, { component: B, data: { v: 200 } });

        const desc: QueryDescriptor = { with: [A] };
        const state = createQueryState(desc);

        const firstBundles = collectBundles(state, world);
        expect(firstBundles.length).toBe(2);

        world.spawn({ component: A, data: { v: 65 } });

        const secondBundles = collectBundles(state, world);
        expect(secondBundles.length).toBe(2);

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bigBundle = secondBundles.find((b) => b.entityCount === 65)!;
        expect(bigBundle).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: Record key known present in test
        const bigV = (bigBundle.QVer2A as Record<string, Float32Array>).v!;
        expect(bigV.length).toBe(65);
        expect(bigV[64]).toBeCloseTo(65);

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const smallBundle = secondBundles.find((b) => b.entityCount === 1)!;
        expect(smallBundle).toBeDefined();
      });
    });

    describe('Query — hot/cold mixed archetype analogue (E-12)', () => {
      it('archetype with both data components and tag components returns correct bundle', () => {
        const world = new World();
        const Pos = defineComponent('QMixPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Vel = defineComponent('QMixVel', { vx: { type: 'f32' } });
        const Tag = defineComponent('QMixTag', {});

        world.spawn(
          { component: Pos, data: { x: 1, y: 2 } },
          { component: Vel, data: { vx: 3 } },
          { component: Tag, data: {} },
        );

        const desc: QueryDescriptor = { with: [Pos, Vel, Tag] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        expect(bundles[0]?.entityCount).toBe(1);

        const posFields = bundles[0]?.QMixPos as Record<string, Float32Array>;
        const velFields = bundles[0]?.QMixVel as Record<string, Float32Array>;
        expect(posFields.x).toBeInstanceOf(Float32Array);
        expect(posFields.y).toBeInstanceOf(Float32Array);
        expect(velFields.vx).toBeInstanceOf(Float32Array);

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const keys = Object.keys(bundles[0]!).filter((k) => k !== 'entityCount');
        expect(keys.sort()).toEqual(['QMixPos', 'QMixVel']);
      });
    });

    describe('Query — value correctness', () => {
      it('query returns correct values for multiple entities in same archetype', () => {
        const world = new World();
        const Pos = defineComponent('QValPos', { x: { type: 'f32' }, y: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 10, y: 20 } });
        world.spawn({ component: Pos, data: { x: 30, y: 40 } });
        world.spawn({ component: Pos, data: { x: 50, y: 60 } });

        const desc: QueryDescriptor = { with: [Pos] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const b = bundles[0]!;
        expect(b.entityCount).toBe(3);
        const posFields = b.QValPos as Record<string, Float32Array>;
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const x = posFields.x!;
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const y = posFields.y!;

        expect(x[0]).toBeCloseTo(10);
        expect(x[1]).toBeCloseTo(30);
        expect(x[2]).toBeCloseTo(50);
        expect(y[0]).toBeCloseTo(20);
        expect(y[1]).toBeCloseTo(40);
        expect(y[2]).toBeCloseTo(60);
      });

      it('bool fields in query result are numeric (0/1 in Uint8Array)', () => {
        const world = new World();
        const Flags = defineComponent('QBoolF', {
          active: { type: 'bool' },
          visible: { type: 'bool' },
        });

        world.spawn({ component: Flags, data: { active: true, visible: false } });

        const desc: QueryDescriptor = { with: [Flags] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const b = bundles[0]!;
        const flagsFields = b.QBoolF as Record<string, Uint8Array>;
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const active = flagsFields.active!;
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const visible = flagsFields.visible!;

        expect(active).toBeInstanceOf(Uint8Array);
        expect(visible).toBeInstanceOf(Uint8Array);
        expect(active[0]).toBe(1);
        expect(visible[0]).toBe(0);
      });
    });

    describe('Query — global component.id', () => {
      it('createQueryState(descriptor) resolves with-ids from global component.id', () => {
        const world = new World();
        const Pos = defineComponent('QPWPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Vel = defineComponent('QPWVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });

        world.spawn(
          { component: Pos, data: { x: 1, y: 2 } },
          { component: Vel, data: { vx: 3, vy: 4 } },
        );

        const desc: QueryDescriptor = { with: [Pos, Vel] };
        const state = createQueryState(desc);

        expect(state.withIds).toContain(Pos.id);
        expect(state.withIds).toContain(Vel.id);
      });

      it('queryRun works end-to-end with global component.id resolution', () => {
        const world = new World();
        const Pos = defineComponent('QPWRunPos', { x: { type: 'f32' }, y: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 10, y: 20 } });
        world.spawn({ component: Pos, data: { x: 30, y: 40 } });

        const desc: QueryDescriptor = { with: [Pos] };
        const state = createQueryState(desc);

        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        expect(bundles[0]?.entityCount).toBe(2);
      });

      it('per-World ID query matches correct archetypes across multiple components', () => {
        const world = new World();
        const A = defineComponent('QPWA', { v: { type: 'f32' } });
        const B = defineComponent('QPWB', { w: { type: 'f32' } });

        world.spawn({ component: A, data: { v: 1 } });
        world.spawn({ component: A, data: { v: 2 } }, { component: B, data: { w: 3 } });

        const desc: QueryDescriptor = { with: [A, B] };
        const state = createQueryState(desc);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(1);
        expect(bundles[0]?.entityCount).toBe(1);
      });
    });

    describe('Query — nested ColumnBundle (F-01)', () => {
      it('multi-component query returns nested bundle: bundle.Position.x is Float32Array', () => {
        const world = new World();
        const Position = defineComponent('NCBPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Velocity = defineComponent('NCBVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });

        world.spawn(
          { component: Position, data: { x: 1, y: 2 } },
          { component: Velocity, data: { vx: 3, vy: 4 } },
        );

        const desc: QueryDescriptor = { with: [Position, Velocity] };
        const state = createQueryState(desc);

        let capturedBundle: Record<string, unknown> | null = null;
        queryRun(state, world, (bundle) => {
          capturedBundle = { ...bundle };
        });

        expect(capturedBundle).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const b = capturedBundle!;
        const posFields = b.NCBPos as Record<string, unknown>;
        expect(posFields).toBeDefined();
        expect(posFields.x).toBeInstanceOf(Float32Array);
        expect(posFields.y).toBeInstanceOf(Float32Array);
        expect((posFields.x as Float32Array)[0]).toBeCloseTo(1);
        expect((posFields.y as Float32Array)[0]).toBeCloseTo(2);

        const velFields = b.NCBVel as Record<string, unknown>;
        expect(velFields).toBeDefined();
        expect(velFields.vx).toBeInstanceOf(Float32Array);
        expect(velFields.vy).toBeInstanceOf(Float32Array);
        expect((velFields.vx as Float32Array)[0]).toBeCloseTo(3);
        expect((velFields.vy as Float32Array)[0]).toBeCloseTo(4);
      });

      it('bundle row count is bundle.Entity.self.length (Entity is essential, drives count SSOT)', () => {
        const world = new World();
        const Pos = defineComponent('NCBCntPos', { x: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1 } });
        world.spawn({ component: Pos, data: { x: 2 } });

        const state = createQueryState({ with: [Pos, Entity] });

        let entityCount = -1;
        queryRun(state, world, (bundle) => {
          entityCount = bundle.Entity.self.length;
        });

        expect(entityCount).toBe(2);
      });

      it('two components with same-named fields are isolated in nested structure', () => {
        const world = new World();
        const A = defineComponent('NCBIsoA', { x: { type: 'f32' } });
        const B = defineComponent('NCBIsoB', { x: { type: 'f32' } });

        world.spawn({ component: A, data: { x: 10 } }, { component: B, data: { x: 20 } });

        const desc: QueryDescriptor = { with: [A, B] };
        const state = createQueryState(desc);

        let capturedBundle: Record<string, unknown> | null = null;
        queryRun(state, world, (bundle) => {
          capturedBundle = { ...bundle };
        });

        expect(capturedBundle).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const b = capturedBundle!;
        const aFields = b.NCBIsoA as Record<string, unknown>;
        const bFields = b.NCBIsoB as Record<string, unknown>;
        expect(aFields).toBeDefined();
        expect(bFields).toBeDefined();
        expect((aFields.x as Float32Array)[0]).toBeCloseTo(10);
        expect((bFields.x as Float32Array)[0]).toBeCloseTo(20);
      });
    });

    describe('Query — optional components (AC-01/02/03)', () => {
      it('AC-01: optional does not alter matching set vs equivalent with-only query', () => {
        const world = new World();
        const Pos = defineComponent('QOptPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Vel = defineComponent('QOptVel', { vx: { type: 'f32' } });
        const Hp = defineComponent('QOptHp', { hp: { type: 'i32' } });

        world.spawn({ component: Pos, data: { x: 1, y: 2 } }, { component: Vel, data: { vx: 3 } });
        world.spawn({ component: Pos, data: { x: 4, y: 5 } }, { component: Hp, data: { hp: 50 } });
        world.spawn(
          { component: Pos, data: { x: 7, y: 8 } },
          { component: Vel, data: { vx: 9 } },
          { component: Hp, data: { hp: 100 } },
        );

        const withOnlyState = createQueryState({ with: [Pos, Vel] });
        const withOnlyBundles = collectBundles(withOnlyState, world);
        const withOnlyArchetypes = withOnlyBundles.length;
        const withOnlyTotalCount = withOnlyBundles.reduce((sum, b) => sum + b.entityCount, 0);

        const optState = createQueryState({
          with: [Pos, Vel],
          optional: [Hp],
        } as QueryDescriptor);
        const optBundles = collectBundles(optState, world);
        const optArchetypes = optBundles.length;
        const optTotalCount = optBundles.reduce((sum, b) => sum + b.entityCount, 0);

        expect(optArchetypes).toBe(withOnlyArchetypes);
        expect(optTotalCount).toBe(withOnlyTotalCount);
      });

      it('AC-02: optional column is present when archetype has the component', () => {
        const world = new World();
        const Pos = defineComponent('QOptInPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Hp = defineComponent('QOptInHp', { hp: { type: 'i32' } });

        world.spawn({ component: Pos, data: { x: 1, y: 2 } }, { component: Hp, data: { hp: 100 } });

        const state = createQueryState({ with: [Pos], optional: [Hp] } as QueryDescriptor);

        let capturedBundle: Record<string, unknown> | null = null;
        // biome-ignore lint/suspicious/noExplicitAny: test helper, generic erasure intentional
        (queryRun as any)(state, world, (bundle: Record<string, unknown>) => {
          capturedBundle = { ...bundle };
        });

        expect(capturedBundle).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const b = capturedBundle!;

        const posFields = b.QOptInPos as Record<string, Float32Array>;
        expect(posFields).toBeDefined();
        expect(posFields.x).toBeInstanceOf(Float32Array);

        const hpFields = b.QOptInHp as Record<string, Int32Array>;
        expect(hpFields).toBeDefined();
        expect(hpFields.hp).toBeInstanceOf(Int32Array);
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        expect(hpFields.hp![0]).toBe(100);
      });

      it('AC-02: optional column is absent (undefined) when archetype lacks the component', () => {
        const world = new World();
        const Pos = defineComponent('QOptAbsPos', { x: { type: 'f32' }, y: { type: 'f32' } });
        const Hp = defineComponent('QOptAbsHp', { hp: { type: 'i32' } });

        world.spawn({ component: Pos, data: { x: 1, y: 2 } });

        const state = createQueryState({ with: [Pos], optional: [Hp] } as QueryDescriptor);

        let capturedBundle: Record<string, unknown> | null = null;
        // biome-ignore lint/suspicious/noExplicitAny: test helper, generic erasure intentional
        (queryRun as any)(state, world, (bundle: Record<string, unknown>) => {
          capturedBundle = { ...bundle };
        });

        expect(capturedBundle).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const b = capturedBundle!;

        const posFields = b.QOptAbsPos as Record<string, Float32Array>;
        expect(posFields).toBeDefined();
        expect(posFields.x).toBeInstanceOf(Float32Array);

        expect(b.QOptAbsHp).toBeUndefined();
        expect(Object.keys(b).includes('QOptAbsHp')).toBe(false);
      });

      it('AC-02: partial missing — one optional present, another absent in same bundle', () => {
        const world = new World();
        const Pos = defineComponent('QOptPartPos', { x: { type: 'f32' } });
        const A = defineComponent('QOptPartA', { v: { type: 'f32' } });
        const B = defineComponent('QOptPartB', { w: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1 } }, { component: A, data: { v: 10 } });
        world.spawn({ component: Pos, data: { x: 2 } }, { component: B, data: { w: 20 } });

        const state = createQueryState({ with: [Pos], optional: [A, B] } as QueryDescriptor);

        const bundles = collectBundles(state, world);
        expect(bundles.length).toBe(2);

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bWithA = bundles.find((b) => b.QOptPartA !== undefined)!;
        expect(bWithA).toBeDefined();
        expect(bWithA.QOptPartA).toBeDefined();
        expect(bWithA.QOptPartB).toBeUndefined();

        // biome-ignore lint/style/noNonNullAssertion: controlled test context
        const bWithB = bundles.find((b) => b.QOptPartB !== undefined)!;
        expect(bWithB).toBeDefined();
        expect(bWithB.QOptPartB).toBeDefined();
        expect(bWithB.QOptPartA).toBeUndefined();
      });

      it('AC-03: optional does NOT filter — archetype without any optional component still matches', () => {
        const world = new World();
        const Pos = defineComponent('QOptNoFPos', { x: { type: 'f32' } });
        const Tag = defineComponent('QOptNoFTag', {});

        world.spawn({ component: Pos, data: { x: 1 } }, { component: Tag, data: {} });
        world.spawn({ component: Pos, data: { x: 2 } });

        const state = createQueryState({ with: [Pos], optional: [Tag] } as QueryDescriptor);
        const bundles = collectBundles(state, world);

        expect(bundles.length).toBe(2);

        const totalCount = bundles.reduce((sum, b) => sum + b.entityCount, 0);
        expect(totalCount).toBe(2);
      });

      it('AC-03 boundary: empty optional list (optional: []) matches same as with-only', () => {
        const world = new World();
        const Pos = defineComponent('QOptEmpPos', { x: { type: 'f32' } });
        const Vel = defineComponent('QOptEmpVel', { v: { type: 'f32' } });

        world.spawn({ component: Pos, data: { x: 1 } });
        world.spawn({ component: Pos, data: { x: 2 } }, { component: Vel, data: { v: 3 } });

        const withOnlyState = createQueryState({ with: [Pos] });
        const withOnlyBundles = collectBundles(withOnlyState, world);

        const emptyOptState = createQueryState({
          with: [Pos],
          optional: [],
        } as QueryDescriptor);
        const emptyOptBundles = collectBundles(emptyOptState, world);

        expect(emptyOptBundles.length).toBe(withOnlyBundles.length);
        expect(emptyOptBundles.reduce((s, b) => s + b.entityCount, 0)).toBe(
          withOnlyBundles.reduce((s, b) => s + b.entityCount, 0),
        );
      });

      it('optional tag component (empty schema) handled gracefully', () => {
        const world = new World();
        const Pos = defineComponent('QOptTagPos', { x: { type: 'f32' } });
        const Tag = defineComponent('QOptTagTag', {});

        world.spawn({ component: Pos, data: { x: 1 } }, { component: Tag, data: {} });
        world.spawn({ component: Pos, data: { x: 2 } });

        const state = createQueryState({ with: [Pos], optional: [Tag] } as QueryDescriptor);
        const bundles = collectBundles(state, world);
        expect(bundles.length).toBe(2);

        expect(bundles.every((b) => b.QOptTagPos !== undefined)).toBe(true);
      });
    });

    describe('Query — with∩optional conflict (AC-09)', () => {
      it('same component in with and optional throws structured EcsError at createQueryState', () => {
        const Camera = defineComponent('QConfCam', { fovY: { type: 'f32' } });

        let caughtCode: string | undefined;
        let caughtHint: string | undefined;

        try {
          createQueryState({ with: [Camera], optional: [Camera] } as QueryDescriptor);
        } catch (err: unknown) {
          const e = err as { code?: string; hint?: string };
          caughtCode = e.code;
          caughtHint = e.hint;
        }

        expect(caughtCode).toBeDefined();
        expect(caughtCode).toBe('query-descriptor-with-optional-conflict');

        expect(caughtHint).toBeDefined();
        expect(typeof caughtHint).toBe('string');
        expect(caughtHint?.length).toBeGreaterThan(0);
        expect(caughtHint?.toLowerCase()).toContain('qconfcam');
      });

      it('multiple conflicts are detected (first conflicting component featured in error)', () => {
        const A = defineComponent('QConfA', { v: { type: 'f32' } });
        const B = defineComponent('QConfB', { w: { type: 'f32' } });

        let caughtCode: string | undefined;
        let caughtHint: string | undefined;

        try {
          createQueryState({ with: [A, B], optional: [A, B] } as QueryDescriptor);
        } catch (err: unknown) {
          const e = err as { code?: string; hint?: string };
          caughtCode = e.code;
          caughtHint = e.hint;
        }

        expect(caughtCode).toBe('query-descriptor-with-optional-conflict');
        expect(caughtHint).toBeDefined();
        expect(typeof caughtHint).toBe('string');
        const hintLower = caughtHint?.toLowerCase() ?? '';
        expect(hintLower.includes('qconfa') || hintLower.includes('qconfb')).toBe(true);
      });

      it('no throw when with and optional are disjoint', () => {
        const Camera = defineComponent('QConfDisCam', { fovY: { type: 'f32' } });
        const Transform = defineComponent('QConfDisTr', { posX: { type: 'f32' } });

        expect(() => {
          createQueryState({ with: [Camera], optional: [Transform] } as QueryDescriptor);
        }).not.toThrow();
      });

      it('error object .code is accessor-friendly (no string parse needed)', () => {
        const Comp = defineComponent('QConfAcc', { v: { type: 'f32' } });

        let errObj: unknown = null;

        try {
          createQueryState({ with: [Comp], optional: [Comp] } as QueryDescriptor);
        } catch (err: unknown) {
          errObj = err;
        }

        expect(errObj).not.toBeNull();
        expect((errObj as { code: string }).code).toBe('query-descriptor-with-optional-conflict');
      });
    });
  });
}

{
  // ─── from foldEssentials.test.ts (feat-20260611-ecs-storage-naming-ssot M-1 / w1) ───
  //
  // Verifies the `foldEssentials` helper + `ESSENTIAL_COMPONENT_IDS` SSOT
  // constant exported from `packages/ecs/src/entity.ts`. The helper
  // converges the two `archetypeKey` / `createArchetype` essential-id fold
  // sites onto one named function (research F-9: only 2 sites need converge,
  // not 3 -- `getOrCreateArchetype` does NOT fold).
  //
  // Constraints: ESSENTIAL_COMPONENT_IDS is the SSOT for which component ids
  // are essential to every archetype. Currently == [Entity.id] (== [0]).
  // The fold is idempotent (input already containing every essential id is
  // returned as-is, deduped) and pure (returns a new array, does not mutate
  // input).
  //
  // From plan-strategy D-1: physical location is `entity.ts`
  // (research F-6 cycle-dependency proof — `component.ts` and `entity.ts`
  // would create import cycles).

  describe('foldEssentials.test.ts', () => {
    describe('ESSENTIAL_COMPONENT_IDS SSOT', () => {
      it('is a frozen readonly array containing Entity.id', async () => {
        const mod = await import('../entity');
        const ESSENTIAL_COMPONENT_IDS = (
          mod as unknown as { ESSENTIAL_COMPONENT_IDS: ReadonlyArray<number> }
        ).ESSENTIAL_COMPONENT_IDS;
        expect(Array.isArray(ESSENTIAL_COMPONENT_IDS)).toBe(true);
        expect(ESSENTIAL_COMPONENT_IDS.length).toBe(1);
        expect(ESSENTIAL_COMPONENT_IDS[0]).toBe(Entity.id);
        expect(Object.isFrozen(ESSENTIAL_COMPONENT_IDS)).toBe(true);
      });
    });

    describe('foldEssentials() helper', () => {
      it('input containing Entity.id returns deduped copy', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const input = [Entity.id, 2, 5];
        const out = foldEssentials(input);
        // Entity.id appears exactly once
        expect(out.filter((id) => id === Entity.id).length).toBe(1);
        // No id is dropped
        expect(out).toContain(2);
        expect(out).toContain(5);
        expect(out).toContain(Entity.id);
      });

      it('input not containing Entity.id returns array prefixed with Entity.id', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const input = [2, 5, 7];
        const out = foldEssentials(input);
        expect(out.length).toBe(4);
        expect(out[0]).toBe(Entity.id);
        expect(out).toContain(2);
        expect(out).toContain(5);
        expect(out).toContain(7);
      });

      it('empty input returns [Entity.id]', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const out = foldEssentials([]);
        expect(out).toEqual([Entity.id]);
      });

      it('does not mutate input array', async () => {
        const mod = await import('../entity');
        const foldEssentials = (
          mod as unknown as { foldEssentials: (ids: ReadonlyArray<number>) => number[] }
        ).foldEssentials;
        const input = [2, 5];
        const inputSnapshot = [...input];
        const out = foldEssentials(input);
        expect(input).toEqual(inputSnapshot);
        // returned array must be a NEW array (different reference) when fold
        // had to insert Entity.id
        expect(out).not.toBe(input);
      });
    });
  });
}

{
  // ─── from entity-handle-rename-grep-gate.test.ts (feat-20260611 M-1 / w2) ───
  //
  // Grep gate verifying the type-space `Entity` -> `EntityHandle` rename
  // landed cleanly across `packages/ecs/src/`. Reads the actual source files
  // at test time (no mocking) so it directly enforces the source SSOT.
  //
  // Verifies:
  //   1. `entity.ts` exports `EntityHandle` (the renamed branded-number type)
  //      and no longer exports `type Entity`.
  //   2. `entity.ts` keeps the value-space `Entity` const (id=0
  //      component token) but does NOT re-export `type Entity` (the type-space
  //      handle alias is now `EntityHandle`).
  //
  // Constraints:
  //   - requirements §Component naming: id=0 component token is still named
  //     `Entity` -- only the type-space branded handle is renamed
  //   - requirements I-1: type Entity -> EntityHandle
  //   - research F-5: TS rename refactor not usable due to namespace merging,
  //     hence a grep-form gate
  //
  // Cross-package `: EntityHandle` type-annotation acceptance is verified by
  // `pnpm typecheck` at the milestone CI sweep level, not here.

  describe('entity-handle-rename-grep-gate.test.ts', () => {
    describe('packages/ecs/src/entity-handle.ts', () => {
      it('exports type EntityHandle (renamed branded-number handle)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity-handle.ts'), 'utf8');
        // exactly one `export type EntityHandle =` declaration
        const handleDeclMatches = src.match(/^export type EntityHandle\b/gm) ?? [];
        expect(handleDeclMatches.length).toBe(1);
      });

      it('no longer exports `type Entity` (type-space rename complete)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity-handle.ts'), 'utf8');
        // Match `export type Entity` not followed by `Handle` -- catches the
        // pre-rename declaration but not the post-rename `EntityHandle`.
        const entityTypeDeclMatches = src.match(/^export type Entity\b(?!Handle)/gm) ?? [];
        expect(entityTypeDeclMatches.length).toBe(0);
      });
    });

    describe('packages/ecs/src/entity.ts', () => {
      it('keeps value-space Entity (id=0 component token)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity.ts'), 'utf8');
        // The value-space token survives; Biome may wrap the call across lines.
        expect(/^export const Entity = defineComponent\(\s*['"]Entity['"]/m.test(src)).toBe(true);
      });

      it('does not re-export `type Entity` alias (type-space lives in entity-handle.ts as EntityHandle)', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const here = url.fileURLToPath(new URL('.', import.meta.url));
        const src = await fs.readFile(path.resolve(here, '..', 'entity.ts'), 'utf8');
        const entityTypeDeclMatches = src.match(/^export type Entity\b(?!Handle)/gm) ?? [];
        expect(entityTypeDeclMatches.length).toBe(0);
      });
    });
  });
}

{
  // ─── from swap-pop-self-column-removeEdge-filter.test.ts (feat-20260611-ecs-storage-naming-ssot M-2 / w4) ───
  //
  // Verifies two changes that landed in M-2:
  // 1. removeEntity swap-pop reads entity index from id=0 `self` column
  //    (columns.get(0)?.get('self')?.view[lastRow] & 0xffffff) instead of
  //    arch.entities[lastRow] — equivalence proven by research F-3.
  // 2. getRemoveEdge uses src.components.filter(c => c.id !== removedId) to
  //    rebuild the component list after componentRegistry is deleted.
  //
  // TDD red mechanism (pre-w5):
  //   (a) The test corrupted arch.entities[lastRow] so pre-w5 removeEntity
  //       would return the wrong value. Post-w5, removeEntity reads the
  //       self column directly.
  //   (b) The test verified graph.componentRegistry existence then verified
  //       getRemoveEdge still works with only src.components.filter.

  describe('swap-pop-self-column-removeEdge-filter.test.ts', () => {
    let testArchId = 0;

    describe('removeEntity swap-pop reads entity from id=0 self column', () => {
      it('2+ entities swap-pop: removed entity index comes from self column, not entities array', () => {
        const C = defineComponent('SwapSelfCol', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);

        // Populate 3 entities. appendEntity writes to the id=0 self column.
        appendEntity(arch, 0x42);
        appendEntity(arch, 0x77);
        appendEntity(arch, 0xff);

        const selfCol = arch.columns.get(Entity.id)?.get('self');
        expect(selfCol).toBeDefined();
        // Verify self column still has correct value
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        expect(selfCol!.view[2]! & 0xffffff).toBe(0xff);

        const swapped = removeEntity(arch, 0);

        // After w5: movedEntity comes from self column (lower 24 bits)
        if (swapped !== null) {
          expect(swapped.movedEntity).toBe(0xff);
          expect(swapped.newRow).toBe(0);
        } else {
          expect.unreachable('expected swap-pop for multi-entity archetype');
        }
      });

      it('single entity last-row swap-pop returns null (row === lastRow, no entities read needed)', () => {
        const C = defineComponent('SwapSelfLastRow', { v: { type: 'f32' } });
        const arch = createArchetype([C], testArchId++);

        appendEntity(arch, 0xab);

        const swapped = removeEntity(arch, 0);
        expect(arch.size).toBe(0);
        expect(swapped).toBeNull();
      });

      it('swap-pop self column data correctly migrated (column-level swap)', () => {
        const C = defineComponent('SwapSelfColData', { v: { type: 'i32' } });
        const arch = createArchetype([C], testArchId++);

        appendEntity(arch, 0x10);
        appendEntity(arch, 0x20);
        appendEntity(arch, 0x30);

        const selfCol = arch.columns.get(Entity.id)?.get('self');
        // biome-ignore lint/style/noNonNullAssertion: test setup
        const vCol = arch.columns.get(C.id)!.get('v')!;
        vCol.view[0] = 100;
        vCol.view[1] = 200;
        vCol.view[2] = 300;

        // Remove row 1. Last row (2) swaps into row 1.
        const swapped = removeEntity(arch, 1);
        expect(arch.size).toBe(2);

        if (swapped === null) {
          expect.unreachable('expected swap-pop');
        }

        // GREEN (after w5): movedEntity = 0x30 from self column
        // RED (before w5): movedEntity = 0xcafe from corrupted arch.entities[2]
        expect(swapped.movedEntity).toBe(0x30);
        expect(swapped.newRow).toBe(1);

        // self column swap-integrity: row 1 should now hold last-row's self value
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        expect(selfCol!.view[1]! & 0xffffff).toBe(0x30);
        // user column data also swapped
        expect(vCol.view[1]).toBe(300);
      });
    });

    describe('getRemoveEdge uses src.components.filter after componentRegistry delete', () => {
      it('getRemoveEdge rebuilds component list from src.components.filter (not registry)', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RemoveEdgeFilter_A', { a: { type: 'f32' } });
        const B = defineComponent('RemoveEdgeFilter_B', { b: { type: 'f32' } });
        const C = defineComponent('RemoveEdgeFilter_C', { c: { type: 'f32' } });

        const archABC = getOrCreateArchetype(graph, [A.id, B.id, C.id], [A, B, C]);

        // After w5: componentRegistry field deleted; getRemoveEdge derives
        // component list from src.components.filter(c => c.id !== removedId).
        const archAC = getRemoveEdge(graph, archABC, B.id);

        const expectedIds = [Entity.id, A.id, C.id].sort((a, b) => a - b);
        const actualComponentIds = archAC.components.map((c) => c.id).sort((a, b) => a - b);
        expect(actualComponentIds).toEqual(expectedIds);

        // Verify B is NOT present in the target
        expect(archAC.components.some((c) => c.id === B.id)).toBe(false);
      });

      it('getRemoveEdge of last non-essential component returns archetype with only Entity', () => {
        const graph = createArchetypeGraph();
        const A = defineComponent('RemoveEdgeLast_A', { a: { type: 'f32' } });

        const archA = getOrCreateArchetype(graph, [A.id], [A]);
        const archEmpty = getRemoveEdge(graph, archA, A.id);

        expect(archEmpty.components.length).toBe(1);
        expect(archEmpty.components[0]?.name).toBe('Entity');
        expect(archEmpty.components.map((c) => c.id)).toEqual([Entity.id]);
      });
    });
  });
}

{
  // ─── from isManaged-column-4-predicate-equivalence.test.ts (feat-20260611-ecs-storage-naming-ssot M-3 / w6) ───
  //
  // Verifies:
  //   1. Every TYPE_METADATA row has an `isManaged` boolean column.
  //   2. The 4 `isXxxField` predicates produce the same boolean result as the
  //      new TYPE_METADATA[].isXxx single-column lookups.
  //   3. `isManagedField` recognizes `'string'` and `'unique<T>'` (both isManaged).
  //
  // tweak-20260612-ecs-concept-compression dropped the redundant per-vocab
  // managed-ref predicate column (100% identical to `isManaged`); the
  // equivalence assertion below now reads `isManaged` directly.
  //
  // Plan-strategy D-3 (approach A): TYPE_METADATA gains an `isManaged` column;
  // 4 predicates are 1:1 derivations from TYPE_METADATA columns, zero OR.
  //
  // Plan-strategy D-4: `isManagedBufferField` semantic widening accepted —
  // `buffer<abc>` resolves to metaKey 'buffer', `isBuffer` returns true; the
  // upstream `isSchemaVocabKeyword` gate already rejects malformed keywords.
  //
  // TDD: these tests are RED before w7 (isManaged column does not yet exist on
  // TypeMetadataRow). They turn GREEN after w7 adds the column + rewrites
  // predicates.

  describe('isManaged-column-4-predicate-equivalence.test.ts', () => {
    describe('isManaged column exists on every TYPE_METADATA row', () => {
      it('every TYPE_METADATA row has a boolean isManaged property', () => {
        for (const [key, row] of Object.entries(TYPE_METADATA)) {
          expect(
            typeof (row as unknown as Record<string, unknown>).isManaged,
            `TYPE_METADATA['${key}'].isManaged must be boolean`,
          ).toBe('boolean');
        }
      });

      it('isManaged === true exactly for the managed-ref vocab + scalar rows ("string" + "ref" + "shared")', () => {
        // feat-20260614-ecs-shared-component-and-unique-rename M3 (D-3): the
        // independent `'shared'` TYPE_METADATA row joins the managed-ref tier
        // alongside `'string'` (UniqueRefStore-backed) and `'ref'` (the
        // post-M2 `'unique<T>'` family). Each meta key carries its own
        // release-semantics dispatch (M4 wires the sub-branches).
        for (const [key, row] of Object.entries(TYPE_METADATA)) {
          const im = (row as unknown as Record<string, unknown>).isManaged as boolean;
          const expected = key === 'string' || key === 'ref' || key === 'shared';
          expect(im, `TYPE_METADATA['${key}'].isManaged`).toBe(expected);
        }
      });

      it('"string" row has isManaged === true', () => {
        const stringRow = TYPE_METADATA.string;
        if (stringRow === undefined) throw new Error('string row missing');
        const im = (stringRow as unknown as Record<string, unknown>).isManaged;
        expect(im).toBe(true);
      });

      it('"ref" row has isManaged === true (shared scalar + vocab row)', () => {
        const refRow = TYPE_METADATA.ref;
        if (refRow === undefined) throw new Error('ref row missing');
        const im = (refRow as unknown as Record<string, unknown>).isManaged;
        expect(im).toBe(true);
      });

      it('non-managed rows (entity, buffer, array, scalars) have isManaged === false', () => {
        const nonManagedKeys = [
          'entity',
          'buffer',
          'array',
          'f32',
          'f64',
          'i32',
          'u32',
          'i16',
          'u16',
          'i8',
          'u8',
          'bool',
          'enum',
        ];
        for (const key of nonManagedKeys) {
          const row = TYPE_METADATA[key];
          if (row === undefined) throw new Error(`row ${key} missing`);
          const im = (row as unknown as Record<string, unknown>).isManaged as boolean;
          expect(im, `TYPE_METADATA['${key}'].isManaged`).toBe(false);
        }
      });
    });

    describe('4 predicate equivalence (old impl vs new TYPE_METADATA column)', () => {
      // Legal SchemaFieldType samples: all 11 legacy scalars (keywords) +
      // 6 vocab-family parametric representatives. Every sample is a
      // syntactically valid keyword accepted by `defineComponent`.
      //
      // Deliberately excluded: 'buffer<0>' (invalid N, /^[1-9]\d*$/ rejects
      // 0), 'buffer<abc>' (non-integer N), 'handle<>' (empty tag). These
      // are never accepted by `defineComponent` (gated via `isSchemaVocabKeyword`),
      // so they never flow through the runtime predicates. The D-4 semantic
      // widening only affects invalid inputs — a dead path.
      const SAMPLE_FIELD_TYPES: string[] = [
        // 11 legacy scalar keys
        'f32',
        'f64',
        'i32',
        'u32',
        'i16',
        'u16',
        'i8',
        'u8',
        'bool',
        'enum',
        'ref',
        // 6 vocab-family parametric reps
        'entity',
        'string',
        'buffer',
        'buffer<64>',
        'unique<MaterialAsset>',
        'shared<MaterialAsset>',
        'array<f32>',
        'array<f32, 16>',
        'array<entity>',
        'array<entity, 4>',
        'array<shared<MaterialAsset>>',
        'unknown-field-type',
      ];

      it('isManagedField: equivalence between current impl and TYPE_METADATA[].isManaged', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isManagedField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult =
            ((TYPE_METADATA[metaKey] as unknown as Record<string, unknown>)
              ?.isManaged as boolean) ?? false;
          expect(newResult, `isManagedField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });

      it('isManagedBufferField: equivalence between current impl and TYPE_METADATA[].isBuffer', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isManagedBufferField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult = TYPE_METADATA[metaKey]?.isBuffer ?? false;
          expect(newResult, `isManagedBufferField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });

      it('isEntityField: equivalence between current impl and TYPE_METADATA[].isEntityRef', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isEntityField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult = TYPE_METADATA[metaKey]?.isEntityRef ?? false;
          expect(newResult, `isEntityField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });

      it('isManagedArrayField: equivalence between current impl and TYPE_METADATA[].isArray', () => {
        for (const t of SAMPLE_FIELD_TYPES) {
          const oldResult = isManagedArrayField(t);
          const metaKey = fieldTypeToMetaKey(t) ?? '';
          const newResult = TYPE_METADATA[metaKey]?.isArray ?? false;
          expect(newResult, `isManagedArrayField('${t}'): old=${oldResult} new=${newResult}`).toBe(
            oldResult,
          );
        }
      });
    });

    describe('isManagedBufferField semantic widening (D-4 acceptance)', () => {
      it("'buffer<abc>' maps to metaKey 'buffer' so isBuffer returns true", () => {
        // D-4 states this widening is acceptable: defineComponent rejects
        // 'buffer<abc>' via isSchemaVocabKeyword (non-integer N), so it
        // never reaches the runtime predicate. The column-based predicate
        // unavoidably returns true via metaKey 'buffer'.isBuffer === true.
        const metaKey = fieldTypeToMetaKey('buffer<abc>') ?? '';
        expect(metaKey).toBe('buffer');
        expect(TYPE_METADATA[metaKey]?.isBuffer ?? false).toBe(true);
        // The new column-based predicate returns true for this dead path
        // (old regex impl returned false). Accepted per D-4.
        expect(isManagedBufferField('buffer<abc>')).toBe(true);
      });
    });

    describe('isManagedField coverage: string and ref<T>', () => {
      it("returns true for 'string' literal", () => {
        expect(isManagedField('string')).toBe(true);
      });

      it("returns true for 'unique<Foo>' template", () => {
        expect(isManagedField('unique<Foo>')).toBe(true);
      });

      it("returns true for 'shared<X>' (rc-tracked managed scalar)", () => {
        expect(isManagedField('shared<X>')).toBe(true);
      });

      it("returns false for 'entity', 'buffer', 'array<T>', and bare scalars", () => {
        expect(isManagedField('entity')).toBe(false);
        expect(isManagedField('buffer')).toBe(false);
        expect(isManagedField('buffer<64>')).toBe(false);
        expect(isManagedField('array<f32>')).toBe(false);
        expect(isManagedField('f32')).toBe(false);
      });
    });
  });
}
