// instances.test-d - type-level shape assertions for the migrated `Instances`
// ECS component (feat-20260514-ecs-children-instances-managed-buffer-array
// M3 / w14).
//
// Pairs with components/instances.ts (w14) which migrates the schema from
// the legacy `{ buffer: 'ref', count: 'u32' }` pair (cross-coupled with the
// retired `AssetRegistry.createInstancedBuffer` pipeline + the deleted
// `InstancedBufferAsset` POD) to the ECS-managed
// `{ transforms: 'array<f32>' }` path with `arrayStride: { transforms: 16 }`.
//
// The type-d coverage now locks the AC-06 spawn shape:
//   1. `InstancesData.transforms` narrows to `Float32Array` (no number / no
//      Handle brand on the spawn surface);
//   2. omitting `transforms` from `InstancesData` is a TS error;
//   3. assigning a non-Float32Array (plain `number[]` or `Uint32Array`) to
//      `InstancesData.transforms` is a TS error.
//
// The legacy three @ts-expect-error block (cross-brand `Handle<MeshAsset>` /
// untagged `number` / missing `count`) is retired alongside the
// `Handle<InstancedBufferAsset>` brand — the spawn shape no longer carries
// a handle field at all (charter "Optimal > compatible": new shape replaces
// the old one in the same PR; migration registry row in AGENTS.md).
//
// File location note: project convention places runtime tests under
// `src/__tests__/` (TS rootDir = `./src`); the plan-tasks.json target
// path matches this layout.

import { describe, expectTypeOf, it } from 'vitest';

import type { InstancesData } from '../components/instances';

describe('InstancesData shape (AC-06 ECS-managed array<f32> form)', () => {
  it('InstancesData carries a readonly transforms: Float32Array field', () => {
    expectTypeOf<InstancesData>().toEqualTypeOf<{
      readonly transforms: Float32Array;
    }>();
  });

  it('InstancesData.transforms narrows to Float32Array (no number / no Handle brand)', () => {
    expectTypeOf<InstancesData['transforms']>().toEqualTypeOf<Float32Array>();
  });
});

describe('@ts-expect-error negative assertions (AC-06 minimum 2)', () => {
  it('1. omitting `transforms` from InstancesData is a TS error (required field)', () => {
    // @ts-expect-error `transforms` is required; partial shape must not type-check.
    const wrong: InstancesData = {};
    void wrong;
  });

  it('2. plain `number[]` is not assignable to InstancesData.transforms (must be Float32Array)', () => {
    // @ts-expect-error `number[]` lacks the Float32Array brand.
    const wrong: InstancesData = { transforms: [0, 0, 0, 0] };
    void wrong;
  });

  it('3. `Uint32Array` is not assignable to InstancesData.transforms (Float32Array nominal)', () => {
    // @ts-expect-error TypedArray nominal types do not cross-assign in TS.
    const wrong: InstancesData = { transforms: new Uint32Array(16) };
    void wrong;
  });
});
