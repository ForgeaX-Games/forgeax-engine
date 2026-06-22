// Compile-time type assertion tests for @forgeax/engine-ecs public API.
//
// Covers:
//   - defineComponent return type inference (schema → Component<S>)
//   - query column bundle type inference (hot-table fields → Float32Array)
//   - system fn parameter types
//   - Entity branded type not assignable from/to plain number
//   - @forgeax/engine-math branded Float32Array interop (AC-19)

import type { Vec3 } from '@forgeax/engine-math';
import { describe, expectTypeOf, it } from 'vitest';
import type { CommandBuffer } from '../commands';
import type { Component, ShapeOf } from '../component';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import type {
  ColumnBundle,
  ColumnBundleField,
  NestedColumnBundle,
  QueryDescriptor,
} from '../query';
import { createQueryState, queryRun } from '../query';
import type { SystemDescriptor } from '../schedule';
import type { ArchetypeInfo, ComponentData, WorldInspection } from '../world';
import { World } from '../world';

describe('defineComponent — type inference', () => {
  it('schema type is inferred from the literal argument', () => {
    const Pos = defineComponent('Pos', { x: { type: 'f32' }, y: { type: 'f32' } });
    expectTypeOf(Pos.schema).toEqualTypeOf<Readonly<{ x: 'f32'; y: 'f32' }>>();
  });

  it('schema with multiple field types is correctly inferred', () => {
    const Mixed = defineComponent('Mixed', {
      hp: { type: 'i32' },
      alive: { type: 'bool' },
      speed: { type: 'f64' },
    });
    expectTypeOf(Mixed.schema).toEqualTypeOf<
      Readonly<{ hp: 'i32'; alive: 'bool'; speed: 'f64' }>
    >();
  });

  it('Component token carries the schema type parameter', () => {
    const Vel = defineComponent('Vel', { vx: { type: 'f32' }, vy: { type: 'f32' } });
    // After KD-1: Component carries both the literal name `N` and schema `S`.
    // Single-arg `Component<S>` annotations must explicitly default `N` to
    // `string` (or pass the literal name) — see plan-strategy KD-1 impact note.
    expectTypeOf(Vel).toMatchTypeOf<Component<string, { vx: 'f32'; vy: 'f32' }>>();
  });

  it('ShapeOf derives the correct JS value-shape', () => {
    type S = { x: 'f32'; y: 'f32'; alive: 'bool' };
    type Expected = { x: number; y: number; alive: boolean };
    expectTypeOf<ShapeOf<S>>().toEqualTypeOf<Expected>();
  });

  it('tag component has empty schema', () => {
    const Tag = defineComponent('Tag', {});
    // Empty object schema: Readonly<{}>
    expectTypeOf(Tag.schema).toEqualTypeOf<Readonly<Record<never, never>>>();
  });

  it('.name is the literal string from the call site (KD-1) and .id is number', () => {
    const C = defineComponent('C', { v: { type: 'f32' } });
    // KD-1: `defineComponent<const N>` lifts the name argument to its
    // string-literal type. Runtime value is still a plain string, but the
    // type-level signal is the literal — enabling NestedColumnBundle key-based
    // mapped-type resolution.
    expectTypeOf(C.name).toEqualTypeOf<'C'>();
    expectTypeOf(C.id).toEqualTypeOf<number>();
  });
});

describe('Entity branded type', () => {
  it('Entity is not assignable from plain number', () => {
    // @ts-expect-error Entity is branded; plain number should not be assignable.
    const _e: EntityHandle = 42;
  });

  it('Entity is not assignable to plain number without cast', () => {
    const world = new World();
    const Pos = defineComponent('PosEntity', { x: { type: 'f32' }, y: { type: 'f32' } });
    const entity = world.spawn({ component: Pos, data: { x: 0, y: 0 } });
    // @ts-expect-error Entity should not be directly assignable to number.
    const _n: number = entity;
  });
});

describe('ComponentData type', () => {
  it('ComponentData pairs component token with correct shape (Partial after M2)', () => {
    const Pos = defineComponent('PosCD', { x: { type: 'f32' }, y: { type: 'f32' } });
    const data: ComponentData<{ x: 'f32'; y: 'f32' }> = {
      component: Pos,
      data: { x: 1, y: 2 },
    };
    // feat-20260517 / M2 / AC-01: data.data widened from ShapeOf<S> to
    // Partial<ShapeOf<S>>. spawn / addComponent / SceneAsset.instantiate
    // share the SAME field bridge; layer-2 + layer-3 silent fallback fills
    // omitted fields inside writeRow via fillComponentDefaults.
    expectTypeOf(data.data).toEqualTypeOf<Partial<{ x: number; y: number }>>();
  });
});

describe('QueryDescriptor type', () => {
  it('accepts Component tokens in with/without arrays', () => {
    const A = defineComponent('QA', { v: { type: 'f32' } });
    const B = defineComponent('QB', { w: { type: 'i32' } });
    const C = defineComponent('QC', { t: { type: 'u8' } });

    const desc: QueryDescriptor = {
      with: [A, B],
      without: [C],
    };
    expectTypeOf(desc.with).toMatchTypeOf<ReadonlyArray<Component>>();
  });
});

describe('ColumnBundle type', () => {
  it('is a string-indexed dict mapping component name -> field-view map', () => {
    // ColumnBundle is the untyped runtime shape (compile-time queries see
    // the typed NestedColumnBundle<Cs, Os>); per-key access yields a
    // field-view map keyed by ColumnBundleField (TypedArray for POD / fixed
    // columns, ManagedColumnReader for the 4 managed-vocab keywords --
    // feat-20260614 M4 / D-4 widened the union from FieldView to
    // include the read-only managed reader shape).
    const bundle: ColumnBundle = {
      Entity: { self: new Uint32Array(2) },
    };
    expectTypeOf(bundle.Entity).toEqualTypeOf<Record<string, ColumnBundleField> | undefined>();
  });
});

describe('SystemDescriptor type', () => {
  it('fn receives mapped query results and CommandBuffer', () => {
    // After KD-2: SystemDescriptor.fn first param is mapped over Qs.
    // Default Qs (= readonly QueryDescriptor[]) expands element-wise to
    // a per-query array of NestedColumnBundle<...>. The default-shape bundle
    // is a string-indexed dict of `Record<string, FieldView>`, so we can index
    // any component name and pull its field-view dict.
    const desc: SystemDescriptor = {
      name: 'test',
      queries: [],
      fn: (_world, queryResults, commands) => {
        const sample = queryResults[0]?.[0];
        if (sample) {
          // Default-shape bundle: with the `with` tuple defaulted to
          // `readonly Component[]` and the `optional` tuple defaulted to
          // `readonly Component[]` (both wide), the per-component intersection
          // and distributive `TypedArrayFor<SchemaFieldType>` collapses to
          // `never` per arm. Concrete `with: [Foo, Bar]` queries recover the
          // typed `{ [field]: TypedArray | ManagedColumnReader<T> }` shape;
          // this assertion only locks the default-shape escape hatch (string
          // indexable, per-key access widens to `... | undefined`).
          expectTypeOf(sample.Anything).toBeNullable();
        }
        expectTypeOf(commands).toEqualTypeOf<CommandBuffer>();
      },
    };
    expectTypeOf(desc.fn).toBeFunction();
  });

  it('accepts optional after/before string arrays', () => {
    const desc: SystemDescriptor = {
      name: 'ordered',
      queries: [],
      fn: () => {},
      after: ['sysA'],
      before: ['sysB'],
    };
    expectTypeOf(desc.after).toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf(desc.before).toEqualTypeOf<readonly string[] | undefined>();
  });
});

describe('WorldInspection type', () => {
  it('has all 6 required fields', () => {
    const world = new World();
    const info: WorldInspection = world.inspect();
    expectTypeOf(info.entityCount).toEqualTypeOf<number>();
    expectTypeOf(info.archetypeCount).toEqualTypeOf<number>();
    expectTypeOf(info.archetypes).toEqualTypeOf<ArchetypeInfo[]>();
    expectTypeOf(info.activeComponents).toEqualTypeOf<string[]>();
    expectTypeOf(info.systemCount).toEqualTypeOf<number>();
    expectTypeOf(info.resourceKeys).toEqualTypeOf<string[]>();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w14] Nested ColumnBundle type inference (F-3)
// ────────────────────────────────────────────────────────────────────────────

describe('ColumnBundle — nested type inference (F-3)', () => {
  it('NestedColumnBundle infers Position.x as Float32Array', () => {
    const Position = defineComponent('TypedPos', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('TypedVel', { vx: { type: 'f32' }, vy: { type: 'f32' } });

    type Bundle = NestedColumnBundle<[typeof Position, typeof Velocity]>;

    // Position fields should be inferred as Float32Array
    expectTypeOf<Bundle['TypedPos']['x']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Bundle['TypedPos']['y']>().toEqualTypeOf<Float32Array>();

    // Velocity fields should be inferred as Float32Array
    expectTypeOf<Bundle['TypedVel']['vx']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Bundle['TypedVel']['vy']>().toEqualTypeOf<Float32Array>();
  });

  it('NestedColumnBundle infers different TypedArrays for different field types', () => {
    const Mixed = defineComponent('TypedMixed', {
      hp: { type: 'i32' },
      active: { type: 'bool' },
      speed: { type: 'f64' },
    });

    type Bundle = NestedColumnBundle<[typeof Mixed]>;

    expectTypeOf<Bundle['TypedMixed']['hp']>().toEqualTypeOf<Int32Array>();
    expectTypeOf<Bundle['TypedMixed']['active']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Bundle['TypedMixed']['speed']>().toEqualTypeOf<Float64Array>();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w1] KD-1 probe: Component<N> string-literal lifting eliminates TS18048
// ────────────────────────────────────────────────────────────────────────────
//
// Probe expectations (must turn green after w2 implements `Component<N, S>` +
// `defineComponent<const N>`):
//   1. `Bundle['Position']` resolves to a concrete object type (not an
//      undefined-union). Under noUncheckedIndexedAccess + non-literal `name:
//      string`, the mapped tuple `{ [K in N]: ... }` would degrade to an index
//      signature, making `Bundle['Position']` resolve to `... | undefined`.
//   2. Direct field access `bundle.Position.x` typechecks without optional
//      chaining or non-null assertion (charter proposition 4: explicit failure
//      over silent undefined paths; G-4 minimal-example AC-4 prerequisite).
//
// Until KD-1 candidate (a) lands in component.ts, this block must compile-fail
// with TS18048 ('bundle.Position' is possibly 'undefined') — the RED state of
// the M1 TDD probe. After w2, the @ts-expect-error sentinels below must be
// removed (they are commented out here so the file still compiles in either
// state; the live `expectTypeOf` lines are the load-bearing assertions).

describe('[w1] KD-1 probe — Component<N> literal lifting', () => {
  it('NestedColumnBundle["Position"] is a concrete object, not undefined-union', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    type Bundle = NestedColumnBundle<readonly [typeof Position, typeof Velocity]>;

    // After KD-1 lands: Bundle['Position'] is `{ x: Float32Array; y: Float32Array }`.
    // Before KD-1: name is non-literal `string`, mapped tuple degrades to index
    // signature, and noUncheckedIndexedAccess injects `| undefined` here.
    expectTypeOf<Bundle['Position']>().toEqualTypeOf<{
      readonly x: Float32Array;
      readonly y: Float32Array;
    }>();
    expectTypeOf<Bundle['Velocity']>().toEqualTypeOf<{
      readonly dx: Float32Array;
      readonly dy: Float32Array;
    }>();
  });

  it('bundle.Position.x is directly accessible without optional chaining (G-4)', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    type Bundle = NestedColumnBundle<readonly [typeof Position]>;
    // Construct a sentinel value of the bundle type (cast — only the type-level
    // shape matters for this probe). Direct `.Position.x` access must
    // typecheck. Under the pre-w2 state, `bundle.Position` is possibly
    // undefined and `bundle.Position.x` triggers TS18048.
    const bundle = {} as Bundle;
    expectTypeOf(bundle.Position.x).toEqualTypeOf<Float32Array>();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w10] T-1: queryRun callback infers NestedColumnBundle<Cs>
// ────────────────────────────────────────────────────────────────────────────
//
// Validates G-1 (requirements §2): without `as const` annotations, the
// `queryRun(state, world, callback)` callback's first parameter must be
// `NestedColumnBundle<readonly [typeof Position, typeof Velocity]>` and inner
// fields must be inferred as concrete TypedArray types (not `unknown` /
// `FieldView | undefined`).

describe('[w10] T-1 — queryRun callback infers NestedColumnBundle<Cs>', () => {
  it('callback bundle param recovers per-component field TypedArray types', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    const world = new World();
    const state = createQueryState({ with: [Position, Velocity, Entity] });

    // Type-level: state recovers the literal tuple of components.
    expectTypeOf(state).toMatchTypeOf<
      import('../query').QueryState<readonly [typeof Position, typeof Velocity, typeof Entity]>
    >();

    queryRun(state, world, (bundle) => {
      // Type-level assertions: callback param is a fully-inferred bundle.
      expectTypeOf(bundle).toMatchTypeOf<
        NestedColumnBundle<readonly [typeof Position, typeof Velocity, typeof Entity]>
      >();
      expectTypeOf(bundle.Position.x).toEqualTypeOf<Float32Array>();
      expectTypeOf(bundle.Position.y).toEqualTypeOf<Float32Array>();
      expectTypeOf(bundle.Velocity.dx).toEqualTypeOf<Float32Array>();
      expectTypeOf(bundle.Velocity.dy).toEqualTypeOf<Float32Array>();
      expectTypeOf(bundle.Entity.self.length).toEqualTypeOf<number>();

      // Value-level: direct TypedArray binding compiles without `as` cast.
      const xs: Float32Array = bundle.Position.x;
      const dxs: Float32Array = bundle.Velocity.dx;
      void xs;
      void dxs;
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w11] T-2: SystemDescriptor.fn[0][0].Comp.field inference
// ────────────────────────────────────────────────────────────────────────────
//
// Validates G-2 (requirements §2): `SystemDescriptor.fn` first parameter is
// mapped over `Qs`, so `Parameters<fn>[0][i][j]` recovers
// `NestedColumnBundle<Qs[i]['with']>` and inner field access compiles to a
// concrete TypedArray.

describe('[w11] T-2 — SystemDescriptor.fn first param maps over Qs', () => {
  it('Parameters<fn>[0][0][0].Position.x is Float32Array', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });

    type Qs = readonly [QueryDescriptor<readonly [typeof Position]>];
    type Desc = SystemDescriptor<Qs>;
    type Fn = Desc['fn'];
    // Parameters<Fn>[0] is `world`; [1] is the mapped query-results tuple.
    type FirstQueryBundles = Parameters<Fn>[1][0];
    type FirstBundle = FirstQueryBundles[number];

    // queryResults[0] is an array of NestedColumnBundle<readonly [typeof Position]>
    expectTypeOf<FirstQueryBundles>().toEqualTypeOf<
      NestedColumnBundle<readonly [typeof Position]>[]
    >();

    // Inner field access: Float32Array.
    expectTypeOf<FirstBundle['Position']['x']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<FirstBundle['Position']['y']>().toEqualTypeOf<Float32Array>();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w12] T-3: Multi-query independence — Qs[0] and Qs[1] do not cross-pollute
// ────────────────────────────────────────────────────────────────────────────
//
// Validates E-7 (requirements §9): in a system with two queries, each query's
// `with` tuple is recovered independently. Accessing a key from the wrong
// query bundle must compile-fail (caught by `@ts-expect-error`).

describe('[w12] T-3 — multi-query Qs tuple independence', () => {
  it('queryResults[0] only knows Position; queryResults[1] only knows Velocity', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    type Qs = readonly [
      QueryDescriptor<readonly [typeof Position]>,
      QueryDescriptor<readonly [typeof Velocity]>,
    ];
    type Desc = SystemDescriptor<Qs>;
    type Fn = Desc['fn'];
    // Parameters<Fn>[0] is `world`; [1] is the mapped query-results tuple.
    type Q0Bundle = Parameters<Fn>[1][0][number];
    type Q1Bundle = Parameters<Fn>[1][1][number];

    // Forward: Position is reachable through Q0, Velocity through Q1.
    expectTypeOf<Q0Bundle['Position']['x']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Q1Bundle['Velocity']['dx']>().toEqualTypeOf<Float32Array>();

    // Reverse (contamination probe): Q0 must NOT expose Velocity.
    type Q0Keys = keyof Q0Bundle;
    type Q1Keys = keyof Q1Bundle;
    expectTypeOf<'Velocity' extends Q0Keys ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'Position' extends Q1Keys ? true : false>().toEqualTypeOf<false>();

    // Direct key access via @ts-expect-error sentinels (self-reflective probe).
    const q0 = {} as Q0Bundle;
    const q1 = {} as Q1Bundle;
    // @ts-expect-error Q0 only contains Position; Velocity must not exist on Q0Bundle.
    void q0.Velocity;
    // @ts-expect-error Q1 only contains Velocity; Position must not exist on Q1Bundle.
    void q1.Position;
    // Forward sanity (no expect-error): direct access compiles.
    void q0.Position;
    void q1.Velocity;
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w13] T-4: `without` components do not appear as bundle keys
// ────────────────────────────────────────────────────────────────────────────
//
// Validates G-1 (requirements §2) negative path: only components in `with` are
// surfaced as nested bundle keys. Components in `without` (or any component
// not in `with`) must compile-fail when accessed. Uses `@ts-expect-error`
// (research §F-R4 recommended writing — strongest self-reflective probe;
// turns RED on its own if KD-1 regresses, immediately visible to AI users).

describe('[w13] T-4 — `without` components do not appear in bundle', () => {
  it('Bundle["TypedPos4"].x is Float32Array; bundle.TypedVel4 must compile-fail', () => {
    const TypedPos4 = defineComponent('TypedPos4', { x: { type: 'f32' }, y: { type: 'f32' } });
    const TypedVel4 = defineComponent('TypedVel4', { dx: { type: 'f32' }, dy: { type: 'f32' } });
    void TypedVel4; // referenced only via type-of below; keep at runtime to anchor literal.

    type Bundle4 = NestedColumnBundle<readonly [typeof TypedPos4]>;

    // Forward: TypedPos4.x recovers as Float32Array (positive shape).
    expectTypeOf<Bundle4['TypedPos4']['x']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Bundle4['TypedPos4']['y']>().toEqualTypeOf<Float32Array>();

    // Negative: TypedVel4 is NOT in `with`, so accessing `b4.TypedVel4` must
    // compile-fail. The `@ts-expect-error` directive turns RED (TS2578) the
    // moment KD-1's literal-lifting regresses or NestedColumnBundle drifts.
    const b4 = {} as Bundle4;
    // @ts-expect-error TypedVel4 is not in `with`; bundle key must not exist.
    const _v = b4.TypedVel4;
    void _v;
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w15] AC-5: world.addSystem boundary preserves Qs inference
// ────────────────────────────────────────────────────────────────────────────
//
// Validates AC-5 (requirements §5): the World class-method `addSystem<const Qs>`
// boundary preserves per-query bundle inference inside `fn`. AI users calling
// `world.addSystem({ queries: [...], fn })` must see `queryResults[0][0].Comp.x`
// inferred as a concrete TypedArray without `as` casts (KD-3, F-R5 path).

describe('[w15] AC-5 — world.addSystem<const Qs> boundary inference', () => {
  it('fn queryResults[0][0].Position.x is Float32Array via class-method generic', () => {
    const Position = defineComponent('Position', { x: { type: 'f32' }, y: { type: 'f32' } });
    const Velocity = defineComponent('Velocity', { dx: { type: 'f32' }, dy: { type: 'f32' } });

    const world = new World();
    world.addSystem({
      name: 'ac5-probe',
      queries: [{ with: [Position, Velocity] }],
      fn: (_world, queryResults, _commands) => {
        const sample = queryResults[0]?.[0];
        if (sample) {
          expectTypeOf(sample.Position.x).toEqualTypeOf<Float32Array>();
          expectTypeOf(sample.Position.y).toEqualTypeOf<Float32Array>();
          expectTypeOf(sample.Velocity.dx).toEqualTypeOf<Float32Array>();
          expectTypeOf(sample.Velocity.dy).toEqualTypeOf<Float32Array>();
        }
      },
    });
    expectTypeOf(world).toMatchTypeOf<World>();
  });
});

describe('@forgeax/engine-math branded Float32Array interop (AC-19)', () => {
  it('hot-table f32 columns use Float32Array which is compatible with math Vec3 backing', () => {
    // Vec3 is Float32Array & { readonly __vec3: void }.
    // Hot-table f32 columns return Float32Array (via subarray).
    // We verify Float32Array is assignable to the base Float32Array that Vec3 extends.
    const f32arr = new Float32Array(3);
    expectTypeOf(f32arr).toMatchTypeOf<Float32Array>();

    // A Vec3 (branded Float32Array) can be used wherever Float32Array is expected,
    // because Vec3 extends Float32Array.
    const v: Vec3 = f32arr as Vec3;
    expectTypeOf(v).toMatchTypeOf<Float32Array>();

    // Branded Vec3 is also indexable like Float32Array.
    // TypedArray index access returns number | undefined in strict mode.
    expectTypeOf(v[0]).toEqualTypeOf<number | undefined>();
    expectTypeOf(v.length).toEqualTypeOf<number>();
  });
});

describe('AC-04 optional column inference at queryRun callback consumer path (verify round-1 fix)', () => {
  it('createQueryState descriptor literal infers Os so bundle.Optional is whole-optional, no cast', () => {
    const Camera = defineComponent('Camera', { fovY: { type: 'f32' } });
    const GlobalTransform = defineComponent('GlobalTransform', {
      posX: { type: 'f32' },
      posY: { type: 'f32' },
      posZ: { type: 'f32' },
    });
    const world = new World();

    // Os must infer from the descriptor literal `optional: [...]` — the verify
    // round-1 defect was QueryDescriptor not carrying the optional tuple, which
    // collapsed the optional bundle type and forced an `as` cast at the consumer.
    const state = createQueryState({ with: [Camera], optional: [GlobalTransform] });
    queryRun(state, world, (bundle) => {
      // with column: non-optional component, fields are concrete Float32Array
      expectTypeOf(bundle.Camera.fovY).toEqualTypeOf<Float32Array>();
      // optional component: WHOLE-optional. Assignment-style proof (no `as`):
      // the optional-chained field is Float32Array | undefined, fields stay concrete.
      const col: Float32Array | undefined = bundle.GlobalTransform?.posX;
      void col;
      // and the component key itself may be undefined (whole-optional, not per-field)
      const whole: { posX: Float32Array; posY: Float32Array; posZ: Float32Array } | undefined =
        bundle.GlobalTransform;
      void whole;
    });
  });
});
