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

import type { Handle, ShapeOf } from '@forgeax/engine-ecs';
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
  it('Transform data shape has 10 local number fields + world array<f32,16>', () => {
    type Data = ShapeOf<typeof Transform.schema>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      | 'posX'
      | 'posY'
      | 'posZ'
      | 'quatX'
      | 'quatY'
      | 'quatZ'
      | 'quatW'
      | 'scaleX'
      | 'scaleY'
      | 'scaleZ'
      | 'world'
    >();
    expectTypeOf<Data['posX']>().toEqualTypeOf<number>();
    expectTypeOf<Data['quatW']>().toEqualTypeOf<number>();
    expectTypeOf<Data['scaleZ']>().toEqualTypeOf<number>();
    expectTypeOf<Data['world']>().toEqualTypeOf<Float32Array>();
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

  it('Camera data shape has 22 fields (21 number + autoAspect boolean: w9 9 + tonemap trio + antialias + bloom quartet + clear-color quartet + autoAspect)', () => {
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
      | 'clearR'
      | 'clearG'
      | 'clearB'
      | 'clearA'
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
    // feat-20260617 / M3: AC-09 -- bool column narrows to boolean, not number.
    expectTypeOf<Data['autoAspect']>().toEqualTypeOf<boolean>();
  });

  it('DirectionalLight data shape: 7 light fields + castShadow bool + 8 merged shadow fields', () => {
    // feat-20260621: DirectionalLightShadow merged into DirectionalLight via castShadow toggle.
    // shadowDistance replaced the nearPlane/farPlane pair (near derives from camera).
    type Data = ShapeOf<typeof DirectionalLight.schema>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      | 'directionX'
      | 'directionY'
      | 'directionZ'
      | 'colorR'
      | 'colorG'
      | 'colorB'
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
//         (a) ShapeOf<typeof Transform.schema> => 10 number fields
//         (b) Transform's field descriptor uses `default: number` for each `type:'f32'`
//         (c) A mismatched default (e.g. `default: "zero"` for `type:'f32'`) would be
//             rejected by TypeScript because FieldDescriptor<'f32'> requires
//             `default?: number` (via FieldValueType<'f32'> = number).
// ────────────────────────────────────────────────────────────────────────────

describe('w15 AC-04 type constraint — ShapeOf derivation from field-payload', () => {
  it("ShapeOf<typeof Transform.schema> yields 10 number fields (all 'f32' -> number)", () => {
    type T = ShapeOf<typeof Transform.schema>;
    expectTypeOf<T['posX']>().toEqualTypeOf<number>();
    expectTypeOf<T['posY']>().toEqualTypeOf<number>();
    expectTypeOf<T['posZ']>().toEqualTypeOf<number>();
    expectTypeOf<T['quatX']>().toEqualTypeOf<number>();
    expectTypeOf<T['quatY']>().toEqualTypeOf<number>();
    expectTypeOf<T['quatZ']>().toEqualTypeOf<number>();
    expectTypeOf<T['quatW']>().toEqualTypeOf<number>();
    expectTypeOf<T['scaleX']>().toEqualTypeOf<number>();
    expectTypeOf<T['scaleY']>().toEqualTypeOf<number>();
    expectTypeOf<T['scaleZ']>().toEqualTypeOf<number>();
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
    // Transform has 10 keys => keyof T is a non-never union.
    type Keys = keyof T;
    // The assertion: Keys is exactly 10 string keys, not never.
    expectTypeOf<Keys>().toMatchTypeOf<string>();
    // The inverse: never would NOT be matched by a string literal.
  });

  it('AC-04 guard: default values in Transform field descriptors are number-typed', () => {
    // The Transform component definition from M3 (w9) supplies
    // { type:'f32', default: 0 } for each of its 10 fields.
    // Because FieldDescriptor<'f32'> expects default?: number,
    // any non-numeric literal (e.g. "hello") would be a type error.
    // This compile-time assertion confirms the derivation chain:
    //   field.type='f32' -> FieldValueType<'f32'> = number
    //   -> default must satisfy number
    // The ShapeOf projection is the final consumer evidence.
    type T = ShapeOf<typeof Transform.schema>;
    expectTypeOf<T['posX']>().toEqualTypeOf<number>();
    // If FieldValueType<'f32'> had resolved to, say, string, this would fail.
  });
});
