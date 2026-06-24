// w9/w10 — writeback round-trip semantic equivalence + handle→GUID reverse
// lookup tests (plan-strategy D-1: semantic equivalence not byte equivalence
// because full writeback materializes defaults — decisions #8 OOS).
//
// Coverage:
//   (a) instantiate → collectSceneAsset → structural round-trip (entity count,
//       localId set, component names per entity match)
//   (b) semantic value equivalence (world.get values match collected POD
//       values, default value materialization accepted)
//   (c) serializeSceneAssetToPack produces valid pack JSON (kind:'scene',
//       assets[] with entities and refs[])
//   (d) handle→GUID reverse lookup: shared<> fields (assetHandle/material/
//       skeleton/clip/cubemap) + materials array map to correct GUIDs in refs[]

import { defineComponent, World } from '@forgeax/engine-ecs';
import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
// Import SceneInstance to trigger its defineComponent registration (required
// for world.instantiateScene to resolve the component token).
import '../components/scene-instance';
import { collectSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

function registerSceneAsset(
  world: World,
  asset: SceneAsset,
): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}

/** Safe property access into the dynamic component map. */
function comp(
  entity: SceneEntity,
  name: string,
): Record<string, unknown> | undefined {
  const map = entity.components as Record<string, Record<string, unknown>>;
  return map[name];
}

// ═══════════════════════════════════════════════════════════════════════════════
// w9 — round-trip semantic equivalence
// ═══════════════════════════════════════════════════════════════════════════════

describe('w9 — round-trip semantic equivalence', () => {
  it('(a) entity count and localId set survive instantiate→collect round-trip', () => {
    defineComponent('Test_Transform', {
      posX: 'f32',
      posY: 'f32',
      posZ: 'f32',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_Transform: { posX: 1, posY: 2, posZ: 3 } } },
        { localId: localId(1), components: { Test_Transform: { posX: 4, posY: 5, posZ: 6 } } },
        { localId: localId(2), components: { Test_Transform: { posX: 7, posY: 8, posZ: 9 } } },
      ],
    };

    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    expect(collected.kind).toBe('scene');
    expect(collected.entities).toHaveLength(3);

    const collectedLocalIds = collected.entities.map((e) => (e.localId as unknown as number)).sort();
    expect(collectedLocalIds).toEqual([0, 1, 2]);
  });

  it('(b) component value semantic equivalence — f32 fields round-trip', () => {
    defineComponent('Test_Pos3', {
      x: 'f32',
      y: 'f32',
      z: 'f32',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_Pos3: { x: 10.5, y: 20.5, z: 30.5 } } },
      ],
    };

    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    expect(collected.entities).toHaveLength(1);
    const tp = comp(collected.entities[0]!, 'Test_Pos3');
    expect(tp).toBeDefined();
    expect(Math.abs((tp!.x as number) - 10.5)).toBeLessThan(0.001);
    expect(Math.abs((tp!.y as number) - 20.5)).toBeLessThan(0.001);
    expect(Math.abs((tp!.z as number) - 30.5)).toBeLessThan(0.001);
  });

  it('(c) default value materialization accepted (semantic != byte equivalence)', () => {
    defineComponent('Test_WithDefault', {
      required: 'f32',
      optional: { type: 'f32', default: 42 },
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: localId(0),
          components: { Test_WithDefault: { required: 7 } },
        },
      ],
    };

    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    const tw = comp(collected.entities[0]!, 'Test_WithDefault');
    expect(tw).toBeDefined();
    expect(tw!.required).toBe(7);
    expect(tw!.optional).toBe(42);
  });

  it('(d) empty scene (no entities) round-trips to empty entities[]', () => {
    const asset: SceneAsset = { kind: 'scene', entities: [] };
    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    expect(collected.kind).toBe('scene');
    expect(collected.entities).toHaveLength(0);
  });

  it('(e) string field round-trips through collectSceneAsset', () => {
    defineComponent('Test_Name', {
      label: 'string',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_Name: { label: 'hello' } } },
      ],
    };

    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    const tn = comp(collected.entities[0]!, 'Test_Name');
    expect(tn).toBeDefined();
    expect(tn!.label).toBe('hello');
  });

  it('(f) multiple components per entity round-trip correctly', () => {
    defineComponent('Test_A', { val: 'f32' });
    defineComponent('Test_B', { flag: 'bool' });
    defineComponent('Test_C', { name: 'string' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: localId(0),
          components: {
            Test_A: { val: 1 },
            Test_B: { flag: true },
            Test_C: { name: 'multi' },
          },
        },
      ],
    };

    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    expect(comp(collected.entities[0]!, 'Test_A')!.val).toBe(1);
    expect(comp(collected.entities[0]!, 'Test_B')!.flag).toBe(true);
    expect(comp(collected.entities[0]!, 'Test_C')!.name).toBe('multi');
  });

  it('(g) bool field round-trips through collectSceneAsset', () => {
    defineComponent('Test_Flag', { enabled: 'bool' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_Flag: { enabled: true } } },
        { localId: localId(1), components: { Test_Flag: { enabled: false } } },
      ],
    };

    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    expect(collected.entities).toHaveLength(2);
    expect(comp(collected.entities[0]!, 'Test_Flag')!.enabled).toBe(true);
    expect(comp(collected.entities[1]!, 'Test_Flag')!.enabled).toBe(false);
  });

  it('(h) serializeSceneAssetToPack produces valid pack envelope', () => {
    defineComponent('Test_Pack', { a: 'f32' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_Pack: { a: 99 } } },
      ],
    };

    const pack = serializeSceneAssetToPack(asset, 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
    expect(pack.schemaVersion).toBe('1.0.0');
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets).toHaveLength(1);

    const assetEntry = assets[0]!;
    expect(assetEntry.guid).toBe('aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
    expect(assetEntry.kind).toBe('scene');
    const payload = assetEntry.payload as Record<string, unknown>;
    expect(Array.isArray(payload.entities)).toBe(true);
    expect((payload.entities as Array<unknown>)).toHaveLength(1);
  });

  it('(i) serializeSceneAssetToPack without guid uses a generated guid', () => {
    const asset: SceneAsset = { kind: 'scene', entities: [] };

    const pack = serializeSceneAssetToPack(asset);
    expect(pack.schemaVersion).toBe('1.0.0');
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets).toHaveLength(1);
    expect(typeof assets[0]!.guid).toBe('string');
    expect((assets[0]!.guid as string).length).toBeGreaterThan(0);
  });

  it('(j) full round-trip instantiate->collect->serialize->check', () => {
    defineComponent('Test_Full', {
      posX: 'f32',
      posY: 'f32',
      name: 'string',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_Full: { posX: 1.5, posY: 2.5, name: 'e0' } } },
        { localId: localId(1), components: { Test_Full: { posX: 3.5, posY: 4.5, name: 'e1' } } },
      ],
    };

    const world = new World();
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root);
    expect(collected.entities).toHaveLength(2);

    const pack = serializeSceneAssetToPack(collected, '11111111-2222-4333-8444-555555555555');
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    const payload = assets[0]!.payload as Record<string, unknown>;
    const entities = payload.entities as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(2);

    // Check entity 0
    const tf = (entities[0]!.components as Record<string, Record<string, unknown>>)['Test_Full']!;
    expect(Math.abs((tf.posX as number) - 1.5)).toBeLessThan(0.001);
    expect(Math.abs((tf.posY as number) - 2.5)).toBeLessThan(0.001);
    expect(tf.name).toBe('e0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// w10 — handle→GUID reverse lookup
// ═══════════════════════════════════════════════════════════════════════════════

describe('w10 — handle→GUID reverse lookup', () => {
  it('(a) assetHandle field resolves to correct GUID in refs[]', () => {
    // Use f32 as field type to avoid shared-ref schema validation,
    // but name the field 'assetHandle' so the collector's allowlist
    // resolves it through handleToGuid.
    defineComponent('Test_MeshRef', {
      assetHandle: 'f32',
    });

    const world = new World();
    const fakeHandle = 101;
    const testGuid = 'mesh-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
    const handleToGuid = new Map<number, string>();
    handleToGuid.set(fakeHandle, testGuid);

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_MeshRef: { assetHandle: fakeHandle } } },
      ],
    };

    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root, handleToGuid);
    expect(collected.entities).toHaveLength(1);
    expect(comp(collected.entities[0]!, 'Test_MeshRef')!.assetHandle).toBe(testGuid);
  });

  it('(b) material field resolves to correct GUID', () => {
    defineComponent('Test_MatRef', {
      material: 'f32',
    });

    const world = new World();
    const fakeHandle = 102;
    const testGuid = 'mat-guid-mat-guid-mat-guid-mat-guid01';
    const handleToGuid = new Map<number, string>();
    handleToGuid.set(fakeHandle, testGuid);

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_MatRef: { material: fakeHandle } } },
      ],
    };

    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root, handleToGuid);
    expect(comp(collected.entities[0]!, 'Test_MatRef')!.material).toBe(testGuid);
  });

  it('(c) skeleton field resolves to correct GUID', () => {
    defineComponent('Test_SkelRef', {
      skeleton: 'f32',
    });

    const world = new World();
    const fakeHandle = 103;
    const testGuid = 'skel-guid-skel-guid-skel-guid-skel01';
    const handleToGuid = new Map<number, string>();
    handleToGuid.set(fakeHandle, testGuid);

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_SkelRef: { skeleton: fakeHandle } } },
      ],
    };

    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root, handleToGuid);
    expect(comp(collected.entities[0]!, 'Test_SkelRef')!.skeleton).toBe(testGuid);
  });

  it('(d) clip field resolves to correct GUID', () => {
    defineComponent('Test_ClipRef', {
      clip: 'f32',
    });

    const world = new World();
    const fakeHandle = 104;
    const testGuid = 'clip-guid-clip-guid-clip-guid-clip01';
    const handleToGuid = new Map<number, string>();
    handleToGuid.set(fakeHandle, testGuid);

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_ClipRef: { clip: fakeHandle } } },
      ],
    };

    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root, handleToGuid);
    expect(comp(collected.entities[0]!, 'Test_ClipRef')!.clip).toBe(testGuid);
  });

  it('(e) cubemap field resolves to correct GUID', () => {
    defineComponent('Test_CubeRef', {
      cubemap: 'f32',
    });

    const world = new World();
    const fakeHandle = 105;
    const testGuid = 'cube-guid-cube-guid-cube-guid-cube01';
    const handleToGuid = new Map<number, string>();
    handleToGuid.set(fakeHandle, testGuid);

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_CubeRef: { cubemap: fakeHandle } } },
      ],
    };

    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root, handleToGuid);
    expect(comp(collected.entities[0]!, 'Test_CubeRef')!.cubemap).toBe(testGuid);
  });

  it('(f) materials array field resolves each element to correct GUID', () => {
    // 'materials' is the only array<shared<T>> field name; use f32 elements
    // inside an array<f32> so the collector's allowlist triggers on the field
    // name and resolves element by element.
    defineComponent('Test_ArrayRef', {
      materials: 'array<f32>',
    });

    const world = new World();
    const guid0 = 'mat0-guid-mat0-guid-mat0-guid-mat0guid';
    const guid1 = 'mat1-guid-mat1-guid-mat1-guid-mat1guid';
    const handleToGuid = new Map<number, string>();
    handleToGuid.set(201, guid0);
    handleToGuid.set(202, guid1);

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: localId(0),
          components: { Test_ArrayRef: { materials: [201, 202] } },
        },
      ],
    };

    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root, handleToGuid);
    const resolved = comp(collected.entities[0]!, 'Test_ArrayRef')!.materials as unknown[];
    expect(Array.isArray(resolved)).toBe(true);
    expect(resolved).toEqual([guid0, guid1]);
  });

  it('(g) round-trip includes refs[] in serialized pack output', () => {
    defineComponent('Test_MeshWithMat', {
      assetHandle: 'f32',
      material: 'f32',
    });

    const world = new World();
    const meshGuid = 'mesh-guid-mesh-guid-mesh-guid-meshguid0';
    const matGuid = 'mat--guid-mat--guid-mat--guid-matguid00';
    const handleToGuid = new Map<number, string>();
    handleToGuid.set(301, meshGuid);
    handleToGuid.set(302, matGuid);

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: localId(0),
          components: {
            Test_MeshWithMat: { assetHandle: 301, material: 302 },
          },
        },
      ],
    };

    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = collectSceneAsset(world, root, handleToGuid);
    const pack = serializeSceneAssetToPack(collected, 'scene-guid-scene-guid-scene-guid-sc');
    const assets = pack.assets as Array<Record<string, unknown>>;
    const refs = assets[0]!.refs as string[];
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.includes(meshGuid) || refs.includes(matGuid)).toBe(true);
  });
});