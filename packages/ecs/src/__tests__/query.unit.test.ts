// feat-20260614-ecs-managed-lifecycle-ssot M4 / w10 (AC-08, AC-09):
// Query bundle exposes ManagedColumnReader<T> for the 4 managed-vocab
// keywords ('string' / `ref<T>` / variable 'buffer' / variable `array<T>`)
// and a writable TypedArray for POD / fixed buffer / fixed array fields.
//
// AC-08 (negative): direct index assignment on a managed column emits a
// TypeScript compile error. The `@ts-expect-error` directive must be
// CONSUMED (removing it would make typecheck fail) -- positive proof
// that the type system, not narrative docs, gates the misuse.
//
// AC-09 (positive): same callback context POD writes (Position.x[i] = ...)
// and fixed-buffer / fixed-array writes still compile and execute.
//
// requirements section 5 callout: assertion MUST sit inside an actual
// consumer path -- a queryRun callback or addSystem fn callback -- not a
// standalone .test-d.ts. That is why this is `.unit.test.ts`.

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ManagedColumnReader } from '../column';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import { createQueryState, queryRun } from '../query';
import { World } from '../world';

// One component per managed vocab keyword + one POD reference + one
// fixed-buffer + one fixed-array. Each managed-bearing component carries
// one POD companion so AC-09 positive writes share the same archetype.

const PositionM4 = defineComponent('PositionM4', {
  x: 'f32',
  y: 'f32',
});

// 'string' managed-vocab keyword.
const GlyphTextM4 = defineComponent('GlyphTextM4', {
  text: { type: 'string' },
  size: 'f32',
});

// `ref<T>` managed-vocab keyword (target tag is the same component name --
// only the type-level shape matters for AC-08; runtime alloc is exercised
// in hierarchy.unit.test.ts).
const NodeRefM4 = defineComponent('NodeRefM4', {
  link: { type: 'unique<NodeRefM4>' },
  weight: 'f32',
});

// variable 'buffer' managed-vocab keyword.
const BlobM4 = defineComponent('BlobM4', {
  bytes: { type: 'buffer' },
  flag: 'u8',
});

// variable `array<T>` managed-vocab keyword.
const HitListM4 = defineComponent('HitListM4', {
  hits: { type: 'array<f32>' },
  active: 'u8',
});

// fixed `buffer<N>` (NOT managed -- inline TypedArray).
const FixedBlobM4 = defineComponent('FixedBlobM4', {
  fixed: { type: 'buffer<8>' },
});

// fixed `array<T,N>` (NOT managed -- inline TypedArray).
const FixedListM4 = defineComponent('FixedListM4', {
  values: { type: 'array<f32, 4>' },
});

describe('w10 --- AC-08 negative: managed columns reject direct index write', () => {
  // Each test runs the queryRun callback so the consumer-path requirement
  // (requirements section 5 callout) is satisfied; the index-write line is
  // gated behind `if (NEVER_RUN)` so the @ts-expect-error directive is
  // *typechecked* (and thus consumed) without executing the runtime
  // assignment that the now-frozen ManagedColumnReader would also reject.
  //
  // The runtime safety net is verified separately in the
  // "managed reader is frozen" test below.
  const NEVER_RUN: boolean = false;

  it('@ts-expect-error directive consumed in queryRun callback for string', () => {
    const world = new World();
    world.spawn({ component: GlyphTextM4, data: { text: 'hello', size: 12 } });

    const state = createQueryState({ with: [GlyphTextM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.GlyphTextM4.text).toEqualTypeOf<ManagedColumnReader<'string'>>();

      if (NEVER_RUN) {
        for (let i = 0; i < bundle.Entity.self.length; i++) {
          // Direct index assignment is a type system error -- ManagedColumnReader
          // exposes no numeric index signature. Remove the directive and
          // typecheck must fail.
          // @ts-expect-error AC-08: managed column is read-only via .get(i); use world.set(e, GlyphTextM4, { text }) instead
          bundle.GlyphTextM4.text[i] = 0;
        }
      }
      expect(typeof bundle.GlyphTextM4.text.get).toBe('function');
    });
  });

  it('@ts-expect-error directive consumed for ref<T> managed column', () => {
    const world = new World();
    world.spawn({ component: NodeRefM4, data: { weight: 0 } });

    const state = createQueryState({ with: [NodeRefM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.NodeRefM4.link).toEqualTypeOf<ManagedColumnReader<'unique<NodeRefM4>'>>();

      if (NEVER_RUN) {
        for (let i = 0; i < bundle.Entity.self.length; i++) {
          // @ts-expect-error AC-08: managed `ref<T>` column rejects direct index write
          bundle.NodeRefM4.link[i] = 0;
        }
      }
      expect(bundle.NodeRefM4.link.__managed).toBe('unique<NodeRefM4>');
    });
  });

  it('@ts-expect-error directive consumed for variable buffer managed column', () => {
    const world = new World();
    world.spawn({ component: BlobM4, data: { bytes: new Uint8Array([1, 2, 3]), flag: 0 } });

    const state = createQueryState({ with: [BlobM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.BlobM4.bytes).toEqualTypeOf<ManagedColumnReader<'buffer'>>();

      if (NEVER_RUN) {
        for (let i = 0; i < bundle.Entity.self.length; i++) {
          // @ts-expect-error AC-08: managed variable 'buffer' column rejects direct index write
          bundle.BlobM4.bytes[i] = 0;
        }
      }
      expect(bundle.BlobM4.bytes.__managed).toBe('buffer');
    });
  });

  it('@ts-expect-error directive consumed for variable array<T> managed column', () => {
    const world = new World();
    world.spawn({
      component: HitListM4,
      data: { hits: new Float32Array([0.5, 0.25]), active: 1 },
    });

    const state = createQueryState({ with: [HitListM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.HitListM4.hits).toEqualTypeOf<ManagedColumnReader<'array<f32>'>>();

      if (NEVER_RUN) {
        for (let i = 0; i < bundle.Entity.self.length; i++) {
          // @ts-expect-error AC-08: managed variable `array<T>` column rejects direct index write
          bundle.HitListM4.hits[i] = 0;
        }
      }
      expect(bundle.HitListM4.hits.__managed).toBe('array<f32>');
    });
  });

  it('addSystem fn callback shares the same managed-column reader shape', () => {
    const world = new World();
    world.spawn({ component: GlyphTextM4, data: { text: 'system', size: 8 } });

    let saw = false;
    world.addSystem({
      name: 'm4-managed-reader',
      queries: [{ with: [GlyphTextM4, Entity] }],
      fn: (_world, results) => {
        for (const result of results) {
          for (const bundle of result) {
            const reader: ManagedColumnReader<'string'> = bundle.GlyphTextM4.text;
            if (NEVER_RUN) {
              // @ts-expect-error AC-08: addSystem fn path also rejects index write
              bundle.GlyphTextM4.text[0] = 0;
            }
            expect(reader.length).toBeGreaterThanOrEqual(0);
            saw = true;
          }
        }
      },
    });
    world.update();
    expect(saw).toBe(true);
  });

  it('managed reader is frozen at runtime: index assignment throws', () => {
    const world = new World();
    world.spawn({ component: GlyphTextM4, data: { text: 'frozen-check', size: 1 } });
    const state = createQueryState({ with: [GlyphTextM4, Entity] });
    queryRun(state, world, (bundle) => {
      const reader = bundle.GlyphTextM4.text;
      expect(Object.isFrozen(reader)).toBe(true);
      expect(() => {
        // Bypass TS to verify the runtime safety net independently of
        // the type-level gate.
        (reader as unknown as Record<number, number>)[0] = 99;
      }).toThrow(TypeError);
    });
  });
});

describe('w10 --- AC-09 positive: POD / fixed columns still write through', () => {
  it('POD f32 column accepts direct index write', () => {
    const world = new World();
    world.spawn({ component: PositionM4, data: { x: 1, y: 2 } });

    const state = createQueryState({ with: [PositionM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.PositionM4.x).toEqualTypeOf<Float32Array>();
      for (let i = 0; i < bundle.Entity.self.length; i++) {
        // POD path: direct write compiles and runs.
        bundle.PositionM4.x[i] = 1.5;
        bundle.PositionM4.y[i] = -2.5;
      }
    });

    queryRun(state, world, (bundle) => {
      for (let i = 0; i < bundle.Entity.self.length; i++) {
        expect(bundle.PositionM4.x[i]).toBeCloseTo(1.5);
        expect(bundle.PositionM4.y[i]).toBeCloseTo(-2.5);
      }
    });
  });

  it('POD u8 companion column on managed-bearing component accepts direct index write', () => {
    const world = new World();
    world.spawn({
      component: HitListM4,
      data: { hits: new Float32Array([0.1]), active: 1 },
    });
    const state = createQueryState({ with: [HitListM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.HitListM4.active).toEqualTypeOf<Uint8Array>();
      for (let i = 0; i < bundle.Entity.self.length; i++) {
        bundle.HitListM4.active[i] = 0;
      }
    });
  });

  it('fixed `buffer<N>` inline column accepts direct index write', () => {
    const world = new World();
    world.spawn({
      component: FixedBlobM4,
      data: { fixed: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    });
    const state = createQueryState({ with: [FixedBlobM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.FixedBlobM4.fixed).toEqualTypeOf<Uint8Array>();
      // Inline column: arity-aware subarray of length N for one row.
      bundle.FixedBlobM4.fixed[0] = 0xff;
      expect(bundle.FixedBlobM4.fixed[0]).toBe(0xff);
    });
  });

  it('fixed `array<T,N>` inline column accepts direct index write', () => {
    const world = new World();
    world.spawn({
      component: FixedListM4,
      data: { values: new Float32Array([0, 0, 0, 0]) },
    });
    const state = createQueryState({ with: [FixedListM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.FixedListM4.values).toEqualTypeOf<Float32Array>();
      bundle.FixedListM4.values[0] = 9.5;
      bundle.FixedListM4.values[3] = -3.25;
      expect(bundle.FixedListM4.values[0]).toBeCloseTo(9.5);
      expect(bundle.FixedListM4.values[3]).toBeCloseTo(-3.25);
    });
  });
});

describe('w10 --- type-d smoke: ManagedColumnReader<T> per-keyword localisation', () => {
  it("'string' arm exposes ManagedColumnReader<'string'>", () => {
    const world = new World();
    world.spawn({ component: GlyphTextM4, data: { text: 'a', size: 1 } });
    const state = createQueryState({ with: [GlyphTextM4, Entity] });
    queryRun(state, world, (bundle) => {
      expectTypeOf(bundle.GlyphTextM4.text).toEqualTypeOf<ManagedColumnReader<'string'>>();
    });
  });
});
