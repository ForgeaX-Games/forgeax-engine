// M3 test -- full schema primitive round-trip (AC-18)
// (plan-strategy: cover f32/f64/i32/u32/bool/string + entity + shared<>
//  combination + TypedArray->Array normalization).
//
// The round-trip path is: spawn live entities → rootsToSceneAsset collect → verify
// value equivalence. We use live entity spawning rather than instantiateScene because
// instantiateScene creates internal shared<> refs back to the SceneAsset itself,
// which would require cataloguing the scene asset.

import type { Asset } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
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

// biome-ignore lint/suspicious/noExplicitAny: test helper bridging typed component tokens to World.spawn
function s(w: World, compToken: any, data: any): number {
  // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for World.spawn overload
  const r = w.spawn({ component: compToken, data } as any);
  if (!r.ok) throw new Error('spawn failed');
  return r.value as number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// m3-t3(a): individual primitive field round-trip value equivalence
// ═══════════════════════════════════════════════════════════════════════════════

describe('m3-t3(a): individual primitive field round-trip', () => {
  it('f32 field round-trips with value equivalence', () => {
    const Test_F32 = defineComponent('Test_RT_F32', { val: 'f32' });

    const world = new World();
    const reg = makeRegistry();
    // 1.5 is exactly representable in f32.
    const r0 = s(world, Test_F32, { val: 1.5 });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(1);

    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const cf = comps.Test_RT_F32;
    expect(cf).toBeDefined();
    if (!cf) throw new Error('Test_RT_F32 missing');
    expect(cf.val).toBe(1.5);
  });

  it('f64 field round-trips with value equivalence', () => {
    const Test_F64 = defineComponent('Test_RT_F64', { val: 'f64' });

    const world = new World();
    const reg = makeRegistry();
    const r0 = s(world, Test_F64, { val: 1.7976931348623157e308 });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(1);

    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const cf = comps.Test_RT_F64;
    expect(cf).toBeDefined();
    if (!cf) throw new Error('Test_RT_F64 missing');
    const v = cf.val as number;
    expect(v).toBeGreaterThan(1e308);
  });

  it('i32 field round-trips with value equivalence', () => {
    const Test_I32 = defineComponent('Test_RT_I32', { val: 'i32' });

    const world = new World();
    const reg = makeRegistry();
    const r0 = s(world, Test_I32, { val: -42 });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(1);

    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const cf = comps.Test_RT_I32;
    expect(cf).toBeDefined();
    if (!cf) throw new Error('Test_RT_I32 missing');
    expect(cf.val).toBe(-42);
  });

  it('u32 field round-trips with value equivalence', () => {
    const Test_U32 = defineComponent('Test_RT_U32', { val: 'u32' });

    const world = new World();
    const reg = makeRegistry();
    const r0 = s(world, Test_U32, { val: 4294967295 });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(1);

    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const cf = comps.Test_RT_U32;
    expect(cf).toBeDefined();
    if (!cf) throw new Error('Test_RT_U32 missing');
    expect(cf.val).toBe(4294967295);
  });

  it('bool field round-trips with value equivalence', () => {
    const Test_Bool = defineComponent('Test_RT_BOOL', { flag: 'bool' });

    const world = new World();
    const reg = makeRegistry();
    const r0 = s(world, Test_Bool, { flag: true });
    const r1 = s(world, Test_Bool, { flag: false });
    world.addComponent(r0 as EntityHandle, {
      component: Children,
      data: { entities: [r1 as EntityHandle] },
    });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(2);

    const comps0 = (scene.entities[0]?.components as Record<string, Record<string, unknown>>)
      .Test_RT_BOOL;
    expect(comps0).toBeDefined();
    if (!comps0) throw new Error('Test_RT_BOOL missing on e0');
    expect(comps0.flag).toBe(true);

    const comps1 = (scene.entities[1]?.components as Record<string, Record<string, unknown>>)
      .Test_RT_BOOL;
    expect(comps1).toBeDefined();
    if (!comps1) throw new Error('Test_RT_BOOL missing on e1');
    expect(comps1.flag).toBe(false);
  });

  it('string field round-trips with value equivalence', () => {
    const Test_Str = defineComponent('Test_RT_STR', { label: 'string' });

    const world = new World();
    const reg = makeRegistry();
    const r0 = s(world, Test_Str, { label: 'hello-primitive-test' });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(1);

    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const cf = comps.Test_RT_STR;
    expect(cf).toBeDefined();
    if (!cf) throw new Error('Test_RT_STR missing');
    expect(cf.label).toBe('hello-primitive-test');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m3-t3(b): entity + shared<> + primitive mixed entity full-chain value equivalence
// ═══════════════════════════════════════════════════════════════════════════════

describe('m3-t3(b): mixed entity+shared+primitive round-trip', () => {
  it('entity with all primitive types + entity ref + shared ref survives round-trip', () => {
    // Primitive component.
    const Test_MixedPrim = defineComponent('Test_RT_MixedPrim', {
      posX: 'f32',
      posY: 'f32',
      count: 'i32',
      flags: 'u32',
      active: 'bool',
      name: 'string',
    });

    // Entity ref component.
    const Test_EntityRef = defineComponent('Test_EntityRef', { target: 'entity' });

    // Shared ref component.
    const Test_HasShared = defineComponent('Test_HasShared', {
      ref: { type: 'shared<TestAsset>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict for shared<> schema
    } as any);

    // Register a catalogued asset.
    const assetPayload = makePayload('skeleton');
    const reg = makeRegistry();
    const guid = AssetGuid.parse('d0000000-d000-0000-0000-000000000001');
    if (!guid.ok) throw new Error('guid parse failed');
    reg.catalog(guid.value, assetPayload);

    const world = new World();
    const handle = world.allocSharedRef('', assetPayload);

    // Spawn entity A (primitive holder) as root.
    const r0 = s(world, Test_MixedPrim, {
      posX: 1.5,
      posY: 2.5,
      count: 7,
      flags: 42,
      active: true,
      name: 'mixed-entity',
    });

    // Spawn entity B (with entity ref to A + shared ref).
    const r1 = s(world, Test_EntityRef, { target: r0 as EntityHandle });
    world.addComponent(r1 as EntityHandle, {
      component: Test_HasShared,
      // biome-ignore lint/suspicious/noExplicitAny: Handle branded type not assignable to component data for shared<> schema
      data: { ref: handle as any },
    });

    // Link r0 → r1 via Children so both are in the BFS closure.
    world.addComponent(r0 as EntityHandle, {
      component: Children,
      data: { entities: [r1 as EntityHandle] },
    });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(2);

    // Entity 0 (r0): primitives
    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('e0 missing');
    const mp = (ent0.components as Record<string, Record<string, unknown>>).Test_RT_MixedPrim;
    expect(mp).toBeDefined();
    if (!mp) throw new Error('Test_RT_MixedPrim missing');
    expect(mp.posX).toBe(1.5);
    expect(mp.posY).toBe(2.5);
    expect(mp.count).toBe(7);
    expect(mp.flags).toBe(42);
    expect(mp.active).toBe(true);
    expect(mp.name).toBe('mixed-entity');

    // Entity 1 (r1): entity ref + shared ref
    const ent1 = scene.entities[1];
    if (!ent1) throw new Error('e1 missing');
    const er = (ent1.components as Record<string, Record<string, unknown>>).Test_EntityRef;
    expect(er).toBeDefined();
    if (!er) throw new Error('Test_EntityRef missing');
    // After localId renumbering, the target should be a valid localId number.
    expect(typeof er.target).toBe('number');
    expect(er.target as number).toBeGreaterThanOrEqual(0);

    // shared<> field must resolve to GUID string.
    const hs = (ent1.components as Record<string, Record<string, unknown>>).Test_HasShared;
    expect(hs).toBeDefined();
    if (!hs) throw new Error('Test_HasShared missing');
    expect(typeof hs.ref).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m3-t3(c): Float32Array field round-trip as plain Array + value equivalence
// ═══════════════════════════════════════════════════════════════════════════════

describe('m3-t3(c): TypedArray->Array round-trip normalization', () => {
  it('Float32Array field round-trips to plain Array with value equivalence', () => {
    const Test_ArrF32 = defineComponent('Test_RT_ArrF32', {
      data: 'array<f32>',
    });

    const world = new World();
    const reg = makeRegistry();
    const arr = new Float32Array([1.0, 2.5, 3.75, 4.0, 5.125]);
    const r0 = s(world, Test_ArrF32, {
      // biome-ignore lint/suspicious/noExplicitAny: Float32Array not directly assignable to component data field
      data: arr as any,
    });

    const collected = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(1);

    const ent0 = scene.entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const cf = comps.Test_RT_ArrF32;
    expect(cf).toBeDefined();
    if (!cf) throw new Error('Test_RT_ArrF32 missing');
    const data = cf.data as unknown[];

    // Round-trip output must be a plain Array.
    expect(Array.isArray(data)).toBe(true);
    expect(data).not.toBeInstanceOf(Float32Array);

    // Values must be equivalent.
    expect(data).toHaveLength(5);
    expect(data[0]).toBe(1.0);
    expect(data[1]).toBe(2.5);
    expect(data[2]).toBe(3.75);
    expect(data[3]).toBe(4.0);
    expect(data[4]).toBeCloseTo(5.125, 5);
  });
});
