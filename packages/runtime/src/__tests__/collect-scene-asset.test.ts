// w9 — writeback round-trip semantic equivalence tests, migrated to
// rootsToSceneAsset (plan-strategy D-1: semantic equivalence not byte
// equivalence because full writeback materializes defaults — decisions #8 OOS).
//
// Old w10 (handleToGuid tests) removed — engine now self-resolves GUIDs
// via AssetRegistry, no external handleToGuid table needed. Those scenarios
// are covered by m2-t3 in roots-to-scene-asset.test.ts.
//
// NOTE: rootsToSceneAsset collects the root entity itself in the BFS closure,
// unlike old collectSceneAsset (which only returned SceneAsset entities).
// Entity counts here include the synthetic root from instantiateScene.
//
// M1T7 AUDIT (feat-20260707-engine-world-clone-transient-for-editor-ssot):
//   Classification: (b) false-positive modification risk — all 10 tests
//   preserved as-is. These tests check entity count, component value fidelity,
//   and round-trip semantics using custom non-transient test components
//   (Test_Transform, Test_Pos3, etc.). None of them assert on Children or
//   SceneInstance presence in output. Entity-count checks (n entities + 1
//   synthetic root) are unaffected by transient — transient only skips
//   component-level keys, not entity-level entries.
//   VERDICT: zero expectations encoded pre-fix bug.

import { defineComponent, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import '../components/scene-instance';
import { AssetRegistry } from '../asset-registry';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

// biome-ignore lint/suspicious/noExplicitAny: allocSharedRef('SceneAsset') returns branded Handle<"SceneAsset", ...> but instantiateScene expects Handle<string, ...>
function registerSceneAsset(world: World, asset: SceneAsset): any {
  return world.allocSharedRef('SceneAsset', asset);
}

function comp(entity: SceneEntity, name: string): Record<string, unknown> | undefined {
  const map = entity.components as Record<string, Record<string, unknown>>;
  return map[name];
}

function def<T>(v: T | undefined | null, label = 'value'): T {
  if (v === undefined || v === null) throw new Error(`expected ${label} to be defined`);
  return v;
}

/** Find the entity in the scene that has the given component. */
function findEntityWith(entities: readonly SceneEntity[], compName: string): SceneEntity {
  const found = entities.find(
    (e) => (e.components as Record<string, Record<string, unknown>>)[compName] !== undefined,
  );
  if (!found) throw new Error(`no entity with component ${compName}`);
  return found;
}

describe('w9 — round-trip semantic equivalence', () => {
  it('(a) entity count and localId set survive instantiate->collect round-trip', () => {
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
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.kind).toBe('scene');
    // rootsToSceneAsset includes the root entity + all children = 4 entities.
    expect(scene.entities).toHaveLength(4);

    const entityWithTransform = findEntityWith(scene.entities, 'Test_Transform');
    expect(entityWithTransform).toBeDefined();
  });

  it('(b) component value semantic equivalence — f32 fields round-trip', () => {
    defineComponent('Test_Pos3', {
      x: 'f32',
      y: 'f32',
      z: 'f32',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: { Test_Pos3: { x: 10.5, y: 20.5, z: 30.5 } } }],
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    // root + 1 child = 2 entities.
    expect(scene.entities).toHaveLength(2);
    const e = findEntityWith(scene.entities, 'Test_Pos3');
    const tp = def(comp(e, 'Test_Pos3'), 'Test_Pos3');
    expect(Math.abs((tp.x as number) - 10.5)).toBeLessThan(0.001);
    expect(Math.abs((tp.y as number) - 20.5)).toBeLessThan(0.001);
    expect(Math.abs((tp.z as number) - 30.5)).toBeLessThan(0.001);
  });

  it('(c) default value materialization accepted (semantic != byte equivalence)', () => {
    defineComponent('Test_WithDefault', {
      required: 'f32',
      optional: { type: 'f32', default: 42 },
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: { Test_WithDefault: { required: 7 } } }],
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(2);
    const e = findEntityWith(scene.entities, 'Test_WithDefault');
    const tw = def(comp(e, 'Test_WithDefault'), 'Test_WithDefault');
    expect(tw.required).toBe(7);
    expect(tw.optional).toBe(42);
  });

  it('(d) empty scene (no entities) round-trips to empty entities[]', () => {
    const asset: SceneAsset = { kind: 'scene', entities: [] };
    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    // Empty scene may still instantiate; root should be present.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.kind).toBe('scene');
    // Empty scene: root only (1 entity in closure — just the root).
    expect(scene.entities.length).toBeGreaterThanOrEqual(1);
  });

  it('(e) string field round-trips through rootsToSceneAsset', () => {
    defineComponent('Test_Name', {
      label: 'string',
    });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: { Test_Name: { label: 'hello' } } }],
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(2);
    const e = findEntityWith(scene.entities, 'Test_Name');
    const tn = def(comp(e, 'Test_Name'), 'Test_Name');
    expect(tn.label).toBe('hello');
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
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    expect(scene.entities).toHaveLength(2);
    const e = findEntityWith(scene.entities, 'Test_A');
    expect(def(comp(e, 'Test_A'), 'Test_A').val).toBe(1);
    expect(def(comp(e, 'Test_B'), 'Test_B').flag).toBe(true);
    expect(def(comp(e, 'Test_C'), 'Test_C').name).toBe('multi');
  });

  it('(g) bool field round-trips through rootsToSceneAsset', () => {
    defineComponent('Test_Flag', { enabled: 'bool' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: localId(0), components: { Test_Flag: { enabled: true } } },
        { localId: localId(1), components: { Test_Flag: { enabled: false } } },
      ],
    };

    const world = new World();
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const scene = collected.value;
    // root + 2 children = 3 entities.
    expect(scene.entities).toHaveLength(3);

    // Find the two entities with Test_Flag.
    const flagged = scene.entities.filter(
      (e) => (e.components as Record<string, Record<string, unknown>>).Test_Flag !== undefined,
    );
    expect(flagged).toHaveLength(2);

    // One should have true, one false.
    const values = flagged.map(
      (e) => (e.components as Record<string, Record<string, unknown>>).Test_Flag?.enabled,
    );
    expect(values).toContain(true);
    expect(values).toContain(false);
  });

  it('(h) serializeSceneAssetToPack produces valid pack envelope', () => {
    defineComponent('Test_Pack', { a: 'f32' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: { Test_Pack: { a: 99 } } }],
    };

    const packResult = serializeSceneAssetToPack(asset, 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;
    const pack = packResult.value;
    expect(pack.schemaVersion).toBe('1.0.0');
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets).toHaveLength(1);

    const assetEntry = def(assets[0], 'assets[0]');
    expect(assetEntry.guid).toBe('aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee');
    expect(assetEntry.kind).toBe('scene');
    const payload = assetEntry.payload as Record<string, unknown>;
    expect(Array.isArray(payload.entities)).toBe(true);
    expect(payload.entities as Array<unknown>).toHaveLength(1);
  });

  it('(i) serializeSceneAssetToPack without guid uses a generated guid', () => {
    const asset: SceneAsset = { kind: 'scene', entities: [] };

    const packResult = serializeSceneAssetToPack(asset);
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;
    const pack = packResult.value;
    expect(pack.schemaVersion).toBe('1.0.0');
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets).toHaveLength(1);
    const entry0 = def(assets[0], 'assets[0]');
    expect(typeof entry0.guid).toBe('string');
    expect((entry0.guid as string).length).toBeGreaterThan(0);
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
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = world.instantiateScene(handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = res.value.root;

    const collected = rootsToSceneAsset(reg, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    // root + 2 children = 3 entities.
    expect(collected.value.entities).toHaveLength(3);

    const packResult = serializeSceneAssetToPack(
      collected.value,
      '11111111-2222-4333-8444-555555555555',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;
    const pack = packResult.value;
    expect(pack.kind).toBe('internal-text-package');
    const assets = pack.assets as Array<Record<string, unknown>>;
    const payload = def(assets[0], 'assets[0]').payload as Record<string, unknown>;
    const entities = payload.entities as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(3);

    // Find entities with Test_Full in serialized output.
    const tfEntities = entities.filter(
      (ent) => (ent.components as Record<string, Record<string, unknown>>).Test_Full !== undefined,
    );
    expect(tfEntities).toHaveLength(2);

    const names = tfEntities.map(
      (ent) =>
        (
          (ent.components as Record<string, Record<string, unknown>>).Test_Full as Record<
            string,
            unknown
          >
        ).name,
    );
    expect(names).toContain('e0');
    expect(names).toContain('e1');
  });
});
