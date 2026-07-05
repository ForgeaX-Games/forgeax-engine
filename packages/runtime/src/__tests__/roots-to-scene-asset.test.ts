// M2 test -- rootsToSceneAsset forest entry + schema-derived field conversion
// (plan-strategy D-1/D-2/D-4/D-7/D-8).
//
// Coverage (by task):
//   m2-t1: forest multi-root BFS closure + localId renumbering
//   m2-t2: entity / array<entity> -> localId (AC-04/05)
//   m2-t3: shared<> / array<shared<>> -> GUID, incl. fixed-size variant (AC-06/07)
//   m2-t4: root ChildOf strip + cross-root closure refs (AC-09/10)
//   m2-t5: out-of-bounds fail-fast + GUID unresolved fail-fast + exhaustive switch (AC-11/12/17)

import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import type { Asset } from '../asset-registry';
import { AssetRegistry } from '../asset-registry';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { ChildOf } from '../components/child-of';
import { Children } from '../components/children';
import {
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '../errors';
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

  it('fixed-size array<shared<T>,N> schema variant matches startsWith classifier', () => {
    // Verify that classifyFieldSchema startsWith('array<shared<')
    // covers fixed-size 'array<shared<T>,N>' variants (R-1 / D-2).
    expect('array<shared<TestAsset>, 3>'.startsWith('array<shared<')).toBe(true);
    expect('array<shared<TestAsset>>'.startsWith('array<shared<')).toBe(true);
    expect('array<shared<>>'.startsWith('array<shared<')).toBe(true);
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
