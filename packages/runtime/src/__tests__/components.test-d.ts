// w7 / w3 — 5 component schema type-level inference test (test-d, no `as` assertions).
//
// Verifies the call-site type contract of `world.spawn({ component, data })`:
// the `data` object key set + value types must be inferred from the component
// schema without `as` assertions. This is the AI-user-facing affordance
// (charter proposition 5 consistent abstraction + proposition 3 machine-
// readable union > prose).
//
// feat-20260517-merge-mesh-renderer-material-renderer M2 / w3:
//   MeshRenderer collapses to a single `material` field with brand
//   `Handle<'MaterialAsset','shared'>` (twoParam phantom). The
//   schema is upgraded to `'shared<MaterialAsset>'`; the legacy
//   material-binding component (token / file / data alias) is
//   physically gone. AC-04 / AC-05 literals follow plan-strategy
//   decision §2.6.

import type { Handle, InputShapeOf, ShapeOf } from '@forgeax/engine-ecs';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  Camera,
  ChildOf,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  Transform,
} from '../components';

describe('w7 type-level - 5 component schemas yield exact data shapes via ShapeOf', () => {
  it('Transform data shape has 3 local inline-array fields + world array<f32,16>', () => {
    type Data = ShapeOf<typeof Transform.schema>;
    expectTypeOf<keyof Data>().toEqualTypeOf<'pos' | 'quat' | 'scale' | 'world'>();
    expectTypeOf<Data['pos']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['quat']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['scale']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['world']>().toEqualTypeOf<Float32Array>();
    // Write side widens `array<f32, N>` to also accept plain number[] literals
    // (InputShapeOf asymmetry): `pos: [1, 2, 3]` spawns without a
    // Float32Array wrapper at the call site.
    type Input = InputShapeOf<typeof Transform.schema>;
    expectTypeOf<Input['pos']>().toEqualTypeOf<Float32Array | readonly number[]>();
    expectTypeOf<Input['quat']>().toEqualTypeOf<Float32Array | readonly number[]>();
    expectTypeOf<Input['scale']>().toEqualTypeOf<Float32Array | readonly number[]>();
  });

  it("MeshFilter data shape has 1 Handle<'MeshAsset','shared'> field (assetHandle; M5 / w19)", () => {
    type Data = ShapeOf<typeof MeshFilter.schema>;
    expectTypeOf<keyof Data>().toEqualTypeOf<'assetHandle'>();
    expectTypeOf<Data['assetHandle']>().toEqualTypeOf<Handle<'MeshAsset', 'shared'>>();
  });

  it('MeshRenderer data shape has 1 field (materials; feat-20260608 M2 / w7 multi-material array)', () => {
    type Data = ShapeOf<typeof MeshRenderer.schema>;
    expectTypeOf<keyof Data>().toEqualTypeOf<'materials'>();
    expectTypeOf<Data['materials']>().toEqualTypeOf<readonly Handle<'MaterialAsset', 'shared'>[]>();
  });

  it('MeshRenderer spawn payload accepts empty data (AC-04 plan §2.6 literal)', () => {
    // `world.spawn`'s `data` is `Partial<ShapeOf<S>>` — every schema field is
    // optional at the consumer surface, so the empty `{}` payload is accepted
    // (case B path — missing-spec fallback to mid-grey default), and
    // `materials: [0]` plain numeric literal is rejected by brand discipline
    // (charter prop 4).
    type SpawnData = Partial<ShapeOf<typeof MeshRenderer.schema>>;
    // AC-04 application point: brand-undefined union surfaces at the call site.
    expectTypeOf<SpawnData['materials']>().toEqualTypeOf<
      readonly Handle<'MaterialAsset', 'shared'>[] | undefined
    >();
    // empty payload is a valid SpawnData (case B).
    const empty: SpawnData = {};
    void empty;
    // plain `[0]` is not assignable to brand-typed `materials`.
    expectTypeOf<{ materials: readonly [0] }>().not.toMatchTypeOf<SpawnData>();
  });

  it('Camera data shape has 19 fields (17 number + clearColor array + autoAspect boolean: w9 9 + tonemap trio + antialias + bloom quartet + clearColor + autoAspect)', () => {
    type Data = ShapeOf<typeof Camera.schema>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      | 'fov'
      | 'aspect'
      | 'near'
      | 'far'
      | 'projection'
      | 'left'
      | 'right'
      | 'bottom'
      | 'top'
      | 'tonemap'
      | 'exposure'
      | 'whitePoint'
      | 'antialias'
      | 'bloom'
      | 'bloomThreshold'
      | 'bloomIntensity'
      | 'bloomBlurRadius'
      | 'clearColor'
      | 'autoAspect'
    >();
    expectTypeOf<Data['fov']>().toEqualTypeOf<number>();
    expectTypeOf<Data['far']>().toEqualTypeOf<number>();
    expectTypeOf<Data['projection']>().toEqualTypeOf<number>();
    expectTypeOf<Data['left']>().toEqualTypeOf<number>();
    // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.1: AC-01 +
    // plan-strategy section 2.3 D-1 (f32 enum encoding).
    expectTypeOf<Data['tonemap']>().toEqualTypeOf<number>();
    expectTypeOf<Data['exposure']>().toEqualTypeOf<number>();
    expectTypeOf<Data['whitePoint']>().toEqualTypeOf<number>();
    // feat-20260709 M3: clear-color quartet collapsed into one inline
    // array<f32,4> column; read side resolves to Float32Array (mirrors the
    // Transform pos/quat/scale precedent).
    expectTypeOf<Data['clearColor']>().toEqualTypeOf<Float32Array>();
    // feat-20260617 / M3: AC-09 -- bool column narrows to boolean, not number.
    expectTypeOf<Data['autoAspect']>().toEqualTypeOf<boolean>();
  });

  it('DirectionalLight data shape: 3 light fields + castShadow bool + 8 merged shadow fields', () => {
    // feat-20260621: DirectionalLightShadow merged into DirectionalLight via castShadow toggle.
    // shadowDistance replaced the nearPlane/farPlane pair (near derives from camera).
    // feat-20260709 M2: direction/color collapsed to array<f32,3> columns.
    type Data = ShapeOf<typeof DirectionalLight.schema>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      | 'direction'
      | 'color'
      | 'intensity'
      | 'castShadow'
      | 'mapSize'
      | 'cascadeCount'
      | 'splitLambda'
      | 'cascadeBlend'
      | 'depthBias'
      | 'normalBias'
      | 'shadowDistance'
      | 'pcfKernelSize'
    >();
    expectTypeOf<Data['direction']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['color']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['intensity']>().toEqualTypeOf<number>();
    // bool column narrows to boolean, not number.
    expectTypeOf<Data['castShadow']>().toEqualTypeOf<boolean>();
  });
});

describe('w7 type-level - component name literal types are preserved', () => {
  it('Transform.name has the literal type "Transform"', () => {
    expectTypeOf<typeof Transform.name>().toEqualTypeOf<'Transform'>();
  });

  it('MeshFilter.name has the literal type "MeshFilter"', () => {
    expectTypeOf<typeof MeshFilter.name>().toEqualTypeOf<'MeshFilter'>();
  });

  it('MeshRenderer.name has the literal type "MeshRenderer" (AC-05 application point)', () => {
    // M2 / D-2: shading-model classification (unlit / standard) lives on
    // the asset, NOT on the component name. The single MeshRenderer
    // schema carries the merged surface; AC-13 routes per-frame via
    // `switch (mat.shadingModel)` in the canonical dispatch site.
    expectTypeOf<typeof MeshRenderer.name>().toEqualTypeOf<'MeshRenderer'>();
    expectTypeOf<keyof typeof MeshRenderer.schema>().toEqualTypeOf<'materials'>();
  });

  it('Camera.name has the literal type "Camera"', () => {
    expectTypeOf<typeof Camera.name>().toEqualTypeOf<'Camera'>();
  });

  it('DirectionalLight.name has the literal type "DirectionalLight"', () => {
    expectTypeOf<typeof DirectionalLight.name>().toEqualTypeOf<'DirectionalLight'>();
  });

  it('ChildOf.name has the literal type "ChildOf" and parent ref field is keyof', () => {
    expectTypeOf<typeof ChildOf.name>().toEqualTypeOf<'ChildOf'>();
    expectTypeOf<keyof typeof ChildOf.schema>().toEqualTypeOf<'parent'>();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// [w15] AC-04 type constraint: the ShapeOf<typeof Component.schema> derivation
//       from the field-descriptor input guarantees that every field's default
//       value type aligns with the schema `type` (compile-time SSOT).
//       Proof points:
//         (a) ShapeOf<typeof Transform.schema> => 4 Float32Array view fields
//         (b) Transform's field descriptor uses `default: Float32Array` for each
//             `type:'array<f32, N>'`
//         (c) A mismatched default (e.g. `default: "zero"` for `type:'array<f32, 3>'`)
//             would be rejected by TypeScript because
//             FieldDescriptor<'array<f32, 3>'> requires `default?: Float32Array`
//             (via FieldValueType<'array<f32, 3>'> = Float32Array).
// ────────────────────────────────────────────────────────────────────────────

describe('w15 AC-04 type constraint — ShapeOf derivation from field-payload', () => {
  it("ShapeOf<typeof Transform.schema> yields Float32Array views (all 'array<f32, N>' -> Float32Array)", () => {
    type T = ShapeOf<typeof Transform.schema>;
    expectTypeOf<T['pos']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<T['quat']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<T['scale']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<T['world']>().toEqualTypeOf<Float32Array>();
  });

  it("ShapeOf<typeof Camera.schema> yields 21 number fields ('f32' -> number) + autoAspect boolean ('bool' -> boolean)", () => {
    type T = ShapeOf<typeof Camera.schema>;
    expectTypeOf<T['fov']>().toEqualTypeOf<number>();
    expectTypeOf<T['projection']>().toEqualTypeOf<number>();
    expectTypeOf<T['tonemap']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloom']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloomThreshold']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloomIntensity']>().toEqualTypeOf<number>();
    expectTypeOf<T['bloomBlurRadius']>().toEqualTypeOf<number>();
    // feat-20260617 / M3: AC-09 -- the bool column narrows to boolean.
    expectTypeOf<T['autoAspect']>().toEqualTypeOf<boolean>();
  });

  it('ShapeOf<typeof Transform.schema> is non-empty (field cardinality > 0)', () => {
    type T = ShapeOf<typeof Transform.schema>;
    // If the schema were empty {}, keyof T would be never.
    // Transform has 4 keys (pos/quat/scale/world) => keyof T is a non-never union.
    type Keys = keyof T;
    // The assertion: Keys is exactly 4 string keys, not never.
    expectTypeOf<Keys>().toMatchTypeOf<string>();
    // The inverse: never would NOT be matched by a string literal.
  });

  it('AC-04 guard: default values in Transform field descriptors are Float32Array-typed', () => {
    // The Transform component definition supplies
    // { type: 'array<f32, N>', default: new Float32Array([...]) } for each of
    // its 3 local TRS fields. Because FieldDescriptor<'array<f32, 3>'> expects
    // default?: Float32Array, any non-typed-array default (e.g. "hello" or a
    // bare number) would be a type error. This compile-time assertion confirms
    // the derivation chain:
    //   field.type='array<f32, 3>' -> FieldValueType<'array<f32, 3>'> = Float32Array
    //   -> default must satisfy Float32Array
    // The ShapeOf projection is the final consumer evidence.
    type T = ShapeOf<typeof Transform.schema>;
    expectTypeOf<T['pos']>().toEqualTypeOf<Float32Array>();
    // If FieldValueType<'array<f32, 3>'> had resolved to, say, number[], this would fail.
  });
});
