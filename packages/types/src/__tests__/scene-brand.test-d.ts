// scene-brand.test-d - type-level brand inequivalence assertions for
// LocalEntityId vs Entity (feat-20260514-scene-as-world-blueprint
// AC-02 + plan-strategy D-P1).
//
// Two-way brand isolation: Entity (engine-ecs unique-symbol brand) and
// LocalEntityId (scene-local index brand) must be mutually non-assignable
// while still extending number (u32 runtime storage shared).
//
// Charter mapping: proposition 4 explicit failure (cross-brand assignment
// is a TS compile-time error, never a silent type mismatch) + proposition 5
// consistent abstraction (parallel to Handle<T> brand pattern in
// handle-brand.test-d.ts).

import { describe, expectTypeOf, it } from 'vitest';
import type { LocalEntityId, SceneAsset, SceneEntity } from '../index';

// Re-declare a minimal Entity surface mirroring @forgeax/engine-ecs entity.ts
// (types is upstream of ecs; we cannot import the runtime brand). The shape
// matches `number & { readonly __entity: unique symbol }` exactly so the
// brand inequivalence assertions exercise the real `unique symbol`
// brands at the type checker.
declare const _entityBrand: unique symbol;
type EntityHandle = number & { readonly __entity: typeof _entityBrand };

describe('LocalEntityId brand - rejects cross-brand assignment with Entity', () => {
  it('Entity is not assignable to LocalEntityId', () => {
    expectTypeOf<EntityHandle>().not.toExtend<LocalEntityId>();
  });

  it('LocalEntityId is not assignable to Entity (reverse direction)', () => {
    expectTypeOf<LocalEntityId>().not.toExtend<EntityHandle>();
  });

  it('both brands extend number (u32 runtime storage shared)', () => {
    expectTypeOf<LocalEntityId>().toExtend<number>();
    expectTypeOf<EntityHandle>().toExtend<number>();
  });

  it('plain number does not extend any of the two brands', () => {
    expectTypeOf<number>().not.toExtend<LocalEntityId>();
    expectTypeOf<number>().not.toExtend<EntityHandle>();
  });
});

describe('SceneEntity.localId field consumes the LocalEntityId brand at a real call site', () => {
  it('SceneEntity.localId narrows to LocalEntityId (not plain number)', () => {
    expectTypeOf<SceneEntity>().toHaveProperty('localId').toEqualTypeOf<LocalEntityId>();
  });

  it('SceneAsset.entities is a readonly array of SceneEntity', () => {
    expectTypeOf<SceneAsset>().toHaveProperty('entities').toEqualTypeOf<readonly SceneEntity[]>();
  });

  it('SceneAsset.kind narrows to the literal "scene"', () => {
    expectTypeOf<SceneAsset>().toHaveProperty('kind').toEqualTypeOf<'scene'>();
  });
});
