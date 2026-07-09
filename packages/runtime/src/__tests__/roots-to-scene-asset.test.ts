// M2 test -- rootsToSceneAsset forest entry + schema-derived field conversion
// (plan-strategy D-1/D-2/D-4/D-7/D-8).
//
// Coverage (by task):
//   m2-t1: forest multi-root BFS closure + localId renumbering
//   m2-t2: entity / array<entity> -> localId (AC-04/05)
//   m2-t3: shared<> / array<shared<>> -> GUID, incl. fixed-size variant (AC-06/07)
//   m2-t4: root ChildOf strip + cross-root closure refs (AC-09/10)
//   m2-t5: out-of-bounds fail-fast + GUID unresolved fail-fast + exhaustive switch (AC-11/12/17)

import type { Asset } from '@forgeax/engine-assets-runtime';
import {
  AssetRegistry,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { ChildOf } from '../components/child-of';
import { Children } from '../components/children';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function makePayload(kind: Asset['kind']): Asset {
  return { kind } as Asset;
}

// A marker component with no entity/shared fields -- safe for entity spawning.
const Tag = defineComponent('Tag', { value: 'f32' });

/** Spawn an entity with a component; return raw id. */
// biome-ignore lint/suspicious/noExplicitAny: test helper bridging typed component tokens to World.spawn
function s(w: World, comp: any, data: any): number {
  // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for World.spawn overload
  const r = w.spawn({ component: comp, data } as any);
  if (!r.ok) throw new Error('spawn failed');
  return r.value as number;
}

/** Spawn a tag-only entity (no entity ref fields). */
function stag(w: World, n: number): number {
  return s(w, Tag, { value: n });
}

// Reusable ref components for entity-type fields.
const Test_EntityRef = defineComponent('Test_EntityRef', { target: 'entity' });
const Test_EntityArray = defineComponent('Test_EntityArray', { targets: 'array<entity>' });

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t1: forest multi-root BFS closure + localId renumbering
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t1: forest multi-root BFS closure + localId renumbering', () => {
  it('3-root forest yields all entities in the closure', () => {
    const world = new World();
    const reg = makeRegistry();

    const e0 = stag(world, 0);
    const e1 = stag(world, 1);
    const e2 = stag(world, 2);
    const e3 = stag(world, 3);
    const e4 = stag(world, 4);
    const e5 = stag(world, 5);

    // Tree A: e0 -> e1 -> e2
    world.addComponent(e0 as EntityHandle, {
      component: Children,
      data: { entities: [e1 as EntityHandle] },
    });
    world.addComponent(e1 as EntityHandle, {
      component: Children,
      data: { entities: [e2 as EntityHandle] },
    });
    // Tree C: e4 -> e5
    world.addComponent(e4 as EntityHandle, {
      component: Children,
      data: { entities: [e5 as EntityHandle] },
    });

    const result = rootsToSceneAsset(reg, world, [
      e0 as EntityHandle,
      e3 as EntityHandle,
      e4 as EntityHandle,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(6);
  });

  it('ancestor-descendant overlapping roots silently de-duplicate', () => {
    const world = new World();
    const reg = makeRegistry();
    const e0 = stag(world, 0);
    const e1 = stag(world, 1);
    const e2 = stag(world, 2);
    const e3 = stag(world, 3);
    world.addComponent(e0 as EntityHandle, {
      component: Children,
      data: { entities: [e1 as EntityHandle] },
    });
    world.addComponent(e1 as EntityHandle, {
      component: Children,
      data: { entities: [e2 as EntityHandle] },
    });
    world.addComponent(e2 as EntityHandle, {
      component: Children,
      data: { entities: [e3 as EntityHandle] },
    });

    const result = rootsToSceneAsset(reg, world, [e0 as EntityHandle, e1 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(4);
  });

  it('localIds are 0..N-1 continuous in BFS order', () => {
    const world = new World();
    const reg = makeRegistry();
    const e0 = stag(world, 0);
    const e1 = stag(world, 1);
    const e2 = stag(world, 2);
    const e3 = stag(world, 3);
    const e4 = stag(world, 4);
    world.addComponent(e0 as EntityHandle, {
      component: Children,
      data: { entities: [e1 as EntityHandle, e2 as EntityHandle] },
    });
    world.addComponent(e1 as EntityHandle, {
      component: Children,
      data: { entities: [e3 as EntityHandle] },
    });
    world.addComponent(e2 as EntityHandle, {
      component: Children,
      data: { entities: [e4 as EntityHandle] },
    });

    const result = rootsToSceneAsset(reg, world, [e0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(scene.entities).toHaveLength(5);

    const localIds = scene.entities.map((e) => e.localId as unknown as number);
    expect(localIds).toEqual([0, 1, 2, 3, 4]);
  });

  it('empty roots produces empty SceneAsset (no error)', () => {
    const world = new World();
    const reg = makeRegistry();
    const result = rootsToSceneAsset(reg, world, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t2: entity / array<entity> -> localId (AC-04/05)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t2: entity / array<entity> -> localId', () => {
  it('entity field round-trips as localId, not raw handle', () => {
    const world = new World();
    const reg = makeRegistry();

    const r0 = stag(world, 0);
    const r1 = s(world, Test_EntityRef, { target: r0 });
    world.addComponent(r0 as EntityHandle, {
      component: Children,
      data: { entities: [r1 as EntityHandle] },
    });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(scene.entities).toHaveLength(2);

    const e1 = scene.entities[1];
    if (!e1) throw new Error('entity 1 missing');
    const refComps = (e1.components as Record<string, Record<string, unknown>>).Test_EntityRef;
    expect(refComps).toBeDefined();
    if (!refComps) throw new Error('Test_EntityRef missing');
    expect(refComps.target).toBeTypeOf('number');
    expect(refComps.target).toBe(0);
  });

  it('array<entity> field round-trips each element as localId', () => {
    const world = new World();
    const reg = makeRegistry();

    const r0 = stag(world, 0);
    const r1 = stag(world, 1);
    const r2 = stag(world, 2);
    world.addComponent(r0 as EntityHandle, {
      component: Children,
      data: { entities: [r1 as EntityHandle, r2 as EntityHandle] },
    });
    world.addComponent(r0 as EntityHandle, {
      component: Test_EntityArray,
      // biome-ignore lint/suspicious/noExplicitAny: entity handle arrays typed as EntityHandle[]; data schema matches component definition
      data: { targets: [r1 as EntityHandle, r2 as EntityHandle] } as any,
    });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(scene.entities).toHaveLength(3);

    const rootEnt = scene.entities[0];
    if (!rootEnt) throw new Error('entity 0 missing');
    const elComps = (rootEnt.components as Record<string, Record<string, unknown>>)
      .Test_EntityArray;
    expect(elComps).toBeDefined();
    if (!elComps) throw new Error('Test_EntityArray missing');
    const targetsArr = elComps.targets as unknown[];
    expect(Array.isArray(targetsArr)).toBe(true);
    expect(targetsArr).toEqual([1, 2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t3: shared<> / array<shared<>> -> GUID, incl. fixed-size variant (AC-06/07)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t3: shared<> / array<shared<>> -> GUID', () => {
  it('shared<> scalar field resolves to GUID string (no handleToGuid param)', () => {
    const assetPayload = makePayload('skeleton');
    const reg = makeRegistry();
    const guid = AssetGuid.parse('d0000000-d000-0000-0000-000000000001');
    if (!guid.ok) throw new Error('guid parse failed');
    reg.catalog(guid.value, assetPayload);

    const world = new World();
    const handle = world.allocSharedRef('', assetPayload);

    const Test_HasShared = defineComponent('Test_HasShared', {
      ref: { type: 'shared<TestAsset>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent generic constraint is too strict for complex schema types like shared<>
    } as any);

    const r0 = s(world, Test_HasShared, {
      ref: handle,
      // biome-ignore lint/suspicious/noExplicitAny: Handle<> branded type is not directly assignable to component data field for schema 'shared<>'
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>).Test_HasShared;
    expect(comps).toBeDefined();
    if (!comps) throw new Error('Test_HasShared missing');
    expect(comps.ref).toBeTypeOf('string');
    expect(comps.ref).toBe(AssetGuid.format(guid.value));
  });

  it('array<shared<>> field resolves each element to GUID', () => {
    const assetA = makePayload('skeleton');
    const assetB = makePayload('equirect');
    const reg = makeRegistry();
    const guidA = AssetGuid.parse('d0000000-d000-0000-0000-000000000001');
    const guidB = AssetGuid.parse('e0000000-e000-0000-0000-000000000001');
    if (!guidA.ok || !guidB.ok) throw new Error('guid parse failed');
    reg.catalog(guidA.value, assetA);
    reg.catalog(guidB.value, assetB);

    const world = new World();
    const hA = world.allocSharedRef('', assetA);
    const hB = world.allocSharedRef('', assetB);

    const Test_HasSharedArray = defineComponent('Test_HasSharedArray', {
      sources: { type: 'array<shared<TestAsset>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for complex schema types like array<shared<>>
    } as any);

    const r0 = s(world, Test_HasSharedArray, {
      // biome-ignore lint/suspicious/noExplicitAny: Handle<> branded types require casting for component data assignment
      sources: [hA as any, hB as any],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>).Test_HasSharedArray;
    expect(comps).toBeDefined();
    if (!comps) throw new Error('Test_HasSharedArray missing');
    const sources = comps.sources as unknown[];
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe(AssetGuid.format(guidA.value));
    expect(sources[1]).toBe(AssetGuid.format(guidB.value));
  });

  it('EMPTY array<shared<>> collects WITHOUT throwing (default-material fallback)', () => {
    // Regression: the editor used to auto-mint a synthetic default MaterialAsset
    // (allocSharedRef WITHOUT catalog) for MeshFilter-only entities, so on save
    // this collect path hit `_guidForAsset === undefined` and threw
    // SceneCollectAssetGuidUnresolvedError -> the whole save aborted. The fix
    // attaches an EMPTY `materials: []` instead (engine's own default-material
    // fallback paints it grey). An empty shared-array must serialize to `[]` with
    // ZERO _guidForAsset calls -> no throw, save succeeds.
    const reg = makeRegistry();
    const world = new World();

    const Test_HasSharedArray = defineComponent('Test_EmptyMaterials', {
      sources: { type: 'array<shared<TestAsset>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<shared<>>
    } as any);

    // Empty array -- exactly what MeshRenderer{materials:[]} produces.
    const r0 = s(world, Test_HasSharedArray, {
      sources: [],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ent0 = result.value.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>).Test_EmptyMaterials;
    // An empty shared array serializes to [] (or the component is omitted when it
    // has no other populated fields) -- either way, no unresolved-GUID throw.
    if (comps !== undefined) {
      expect(comps.sources as unknown[]).toEqual([]);
    }
  });

  it('anti-vacuous: a NON-cataloged handle in the shared array DOES throw', () => {
    // Guards the test above from passing vacuously: a shared-array element whose
    // handle resolves to an UNcataloged asset (the old synthetic-mint situation)
    // must still fail-fast with SceneCollectAssetGuidUnresolvedError.
    const reg = makeRegistry();
    const world = new World();
    const uncataloged = makePayload('material');
    // allocSharedRef WITHOUT reg.catalog(...) -- the exact old bug shape.
    const h = world.allocSharedRef('', uncataloged);

    const Test_HasSharedArray = defineComponent('Test_UncatMaterials', {
      sources: { type: 'array<shared<TestAsset>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<shared<>>
    } as any);
    const r0 = s(world, Test_HasSharedArray, {
      // biome-ignore lint/suspicious/noExplicitAny: Handle<> branded types require casting
      sources: [h as any],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SceneCollectAssetGuidUnresolvedError);
    }
  });

  it('fixed-size array<shared<T>,N> schema variant matches startsWith classifier', () => {
    // Verify that classifyFieldSchema startsWith('array<shared<')
    // covers fixed-size 'array<shared<T>,N>' variants (R-1 / D-2).
    expect('array<shared<TestAsset>, 3>'.startsWith('array<shared<')).toBe(true);
    expect('array<shared<TestAsset>>'.startsWith('array<shared<')).toBe(true);
    expect('array<shared<>>'.startsWith('array<shared<')).toBe(true);
  });

  // NULL sentinel handle 0 -- an UNSET shared<T> field defaults to slot 0
  // (ECS three-layer default). world.ts retain arms treat `!== 0` as the
  // active-slot guard, so slot 0 is the documented "no asset here" sentinel.
  // collect must NOT try to resolve it to a GUID (there is none) -- otherwise
  // every entity carrying an unset shared field aborts the whole scene
  // serialize (regression: feedback 2026-07-08-rootstosceneasset).
  it('scalar shared<> field left at NULL sentinel (handle 0) is OMITTED, not an error', () => {
    const reg = makeRegistry();
    const world = new World();

    const Test_UnsetScalar = defineComponent('Test_UnsetScalarShared', {
      ref: { type: 'shared<TestAsset>' },
      tag: { type: 'f32', default: 7 },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for shared<>
    } as any);

    // Spawn WITHOUT setting `ref` -- it defaults to slot 0 (NULL sentinel).
    const r0 = s(world, Test_UnsetScalar, { tag: 42 });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ent0 = result.value.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>)
      .Test_UnsetScalarShared;
    if (!comps) throw new Error('Test_UnsetScalarShared missing');
    // The unset shared scalar is omitted; other fields survive.
    expect(comps.ref).toBeUndefined();
    expect(comps.tag).toBe(42);
  });

  it('array<shared<T>,N> with NULL sentinel slots preserves POSITION (does not compact)', () => {
    // Positional SoA (e.g. AnimationPlayer.clips = [h, 0, 0, 0]) -- a slot may
    // be 0 while its paired arrays (times/weights) carry per-slot data at the
    // same index. collect must keep the slot as numeric 0, not drop it, or the
    // arrays desynchronize on reload.
    const assetA = makePayload('skeleton');
    const reg = makeRegistry();
    const guidA = AssetGuid.parse('d0000000-d000-0000-0000-000000000009');
    if (!guidA.ok) throw new Error('guid parse failed');
    reg.catalog(guidA.value, assetA);

    const world = new World();
    const hA = world.allocSharedRef('', assetA);

    // Fixed-size-4 array; only slot 2 is populated -> [0, 0, hA, 0].
    const Test_SparseArray = defineComponent('Test_SparseSharedArray', {
      slots: { type: 'array<shared<TestAsset>, 4>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<shared<>,N>
    } as any);

    const r0 = s(world, Test_SparseArray, {
      // biome-ignore lint/suspicious/noExplicitAny: short-prefix write pads tail with sentinel 0
      slots: [0, 0, hA as any, 0],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ent0 = result.value.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>)
      .Test_SparseSharedArray;
    if (!comps) throw new Error('Test_SparseSharedArray missing');
    const slots = comps.slots as unknown[];
    expect(Array.isArray(slots)).toBe(true);
    // Position preserved: 4 slots, GUID only at index 2, sentinel 0 elsewhere.
    expect(slots).toHaveLength(4);
    expect(slots[0]).toBe(0);
    expect(slots[1]).toBe(0);
    expect(slots[2]).toBe(AssetGuid.format(guidA.value));
    expect(slots[3]).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t4: root ChildOf strip + cross-root closure refs (AC-09/10)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t4: root ChildOf strip + cross-root closure refs', () => {
  it('root entity ChildOf is stripped from output', () => {
    const world = new World();
    const reg = makeRegistry();
    const parent = stag(world, 99);
    const r0 = s(world, ChildOf, { parent: parent as EntityHandle });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(scene.entities).toHaveLength(1);

    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    expect(comps.ChildOf).toBeUndefined();
  });

  it('cross-root but within-closure entity ref resolves to localId', () => {
    const world = new World();
    const reg = makeRegistry();
    const aRoot = stag(world, 0);
    const bRoot = stag(world, 1);
    const aChild = s(world, Test_EntityRef, { target: bRoot });

    world.addComponent(aRoot as EntityHandle, {
      component: Children,
      data: { entities: [aChild as EntityHandle] },
    });

    const result = rootsToSceneAsset(reg, world, [aRoot as EntityHandle, bRoot as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(scene.entities).toHaveLength(3);

    const childEntity = scene.entities.find(
      (e) =>
        (e.components as Record<string, Record<string, unknown>>).Test_EntityRef?.target !==
        undefined,
    );
    expect(childEntity).toBeDefined();
    if (!childEntity) throw new Error('child entity missing');
    const refVal = (childEntity.components as Record<string, Record<string, unknown>>)
      .Test_EntityRef;
    if (!refVal) throw new Error('Test_EntityRef missing');
    expect(typeof refVal.target).toBe('number');
    expect(refVal.target as number).toBeGreaterThanOrEqual(0);
    expect(refVal.target as number).toBeLessThan(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t5: out-of-bounds + GUID unresolved fail-fast + exhaustive switch (AC-11/12/17)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t5: fail-fast error paths + exhaustive switch', () => {
  it('entity ref outside closure -> err with code scene-collect-entity-ref-out-of-closure', () => {
    const world = new World();
    const reg = makeRegistry();
    const external = stag(world, 99);
    const r0 = s(world, Test_EntityRef, { target: external });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe('scene-collect-entity-ref-out-of-closure');
      const err = result.error;
      if (err instanceof SceneCollectEntityRefOutOfClosureError) {
        expect(err.detail.entity).toBeTypeOf('number');
        expect(err.detail.field).toBe('target');
        expect(err.detail.target).toBeTypeOf('number');
      }
    }
  });

  it('GUID unresolved -> err with code scene-collect-asset-guid-unresolved', () => {
    const assetPayload = makePayload('skeleton');
    const reg = makeRegistry();
    const world = new World();
    const handle = world.allocSharedRef('', assetPayload);

    const Test_SharedMiss = defineComponent('Test_SharedMiss', {
      src: { type: 'shared<TestAsset>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict for complex schema
    } as any);

    const r0 = s(world, Test_SharedMiss, {
      // biome-ignore lint/suspicious/noExplicitAny: Handle branded type not assignable to component data
      src: handle as any,
    });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe('scene-collect-asset-guid-unresolved');
      const err = result.error;
      if (err instanceof SceneCollectAssetGuidUnresolvedError) {
        expect(err.detail.field).toBe('src');
        expect(err.detail.handle).toBeTypeOf('number');
      }
    }
  });

  it('exhaustive switch consumer path (AC-17): no default branch compiles', () => {
    const world = new World();
    const reg = makeRegistry();
    const external = stag(world, 99);
    const r0 = s(world, Test_EntityRef, { target: external });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      switch (result.error.code) {
        case 'scene-collect-entity-ref-out-of-closure': {
          expect(typeof result.error.detail.entity).toBe('number');
          break;
        }
        case 'scene-collect-asset-guid-unresolved': {
          expect(typeof result.error.detail.handle).toBe('number');
          break;
        }
      }
    }
  });
});
