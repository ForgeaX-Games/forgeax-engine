// feat-20260608-scene-nesting-ecs-fication M2 / w20 (red phase) —
// setSceneOverride / removeSceneOverride / detachSceneMember /
// reattachSceneMember + AC-19 mount-time override apply invariants.
//
// AC anchors:
//   - AC-19 mount-time override apply: world.get(member, Comp).field ===
//     overrideValue AND world.get(root, SceneInstance).state.overrides
//     contains the entry (plan-review F-1 — must assert BOTH the readback
//     AND the state map population);
//   - AC-20 setSceneOverride writes the override + readback equals value;
//     removeSceneOverride rolls back to the source SceneAsset value.
//   - detach/reattach mark the localId in state.detachedLocalIds; member
//     entity remains alive.
//   - setSceneOverride type mismatch -> Err 'scene-override-type-mismatch'
//     with detail.{ comp, field, expectedType, actualType }.

import { ok, World } from '@forgeax/engine-ecs';
import { SceneInstance, Transform } from '@forgeax/engine-runtime';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}

describe('AC-19 mount-time override apply (w20)', () => {
  it('mount.overrides land on member entity AND in state.overrides map', () => {
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 1 } } }],
    };
    const childHandle = registerSceneAsset(world, child);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 0 as never,
          source: 0,
          memberFirst: 1 as never,
          memberCount: 1,
          overrides: [{ localId: 1 as never, comp: 'Transform', field: 'posX', value: 42 }],
        },
      ],
    };
    const parentHandle = registerSceneAsset(world, parent);
    world._setSceneAssetResolver?.(() => ok(childHandle));
    const r = world.instantiateScene(parentHandle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[1] as unknown as number;
    // Read-back invariant
    const t = world.get(member as never, Transform);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.value.posX).toBe(42);
    // State-map invariant
    const stateRes = world.getSceneInstanceState(r.value);
    if (!stateRes.ok) throw new Error('getSceneInstanceState failed');
    expect(stateRes.value.overrides.has(1 as never)).toBe(true);
    const fields = stateRes.value.overrides.get(1 as never);
    expect(fields).toBeDefined();
    expect(fields?.has('Transform:posX')).toBe(true);
    expect(fields?.get('Transform:posX')?.value).toBe(42);
  });
});

describe('world.setSceneOverride (w20)', () => {
  it('writes override + readback returns the override value', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 1 } } }],
    };
    const handle = registerSceneAsset(world, asset);
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[0] as unknown as number;
    const sr = world.setSceneOverride(r.value, member as never, Transform, 'posX', 99);
    expect(sr.ok).toBe(true);
    const t = world.get(member as never, Transform);
    if (!t.ok) throw new Error('get t failed');
    expect(t.value.posX).toBe(99);
  });

  it('returns scene-override-type-mismatch on bad value type', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    const handle = registerSceneAsset(world, asset);
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[0] as unknown as number;
    // Pass a string for an f32 field
    const sr = world.setSceneOverride(
      r.value,
      member as never,
      Transform,
      'posX',
      'oops' as unknown as number,
    );
    expect(sr.ok).toBe(false);
    if (sr.ok) return;
    const errCode = (sr.error as { code: string }).code;
    expect(errCode).toBe('scene-override-type-mismatch');
  });
});

describe('world.removeSceneOverride (w20)', () => {
  it('rolls back to the source SceneAsset value', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 5 } } }],
    };
    const handle = registerSceneAsset(world, asset);
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[0] as unknown as number;
    world.setSceneOverride(r.value, member as never, Transform, 'posX', 100);
    const rr = world.removeSceneOverride(r.value, member as never, Transform, 'posX');
    expect(rr.ok).toBe(true);
    const t = world.get(member as never, Transform);
    if (!t.ok) throw new Error('get failed');
    expect(t.value.posX).toBe(5);
  });
});

describe('world.detachSceneMember + reattachSceneMember (w20)', () => {
  it('detach marks the localId; member entity stays alive; reattach unmarks', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    const handle = registerSceneAsset(world, asset);
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[0] as unknown as number;
    const dr = world.detachSceneMember(r.value, member as never);
    expect(dr.ok).toBe(true);
    const stateRes = world.getSceneInstanceState(r.value);
    if (!stateRes.ok) throw new Error('getSceneInstanceState failed');
    expect(stateRes.value.detachedLocalIds.has(0 as never)).toBe(true);
    // Member still alive
    expect(world.get(member as never, Transform).ok).toBe(true);
    // Reattach
    const rr = world.reattachSceneMember(r.value, member as never);
    expect(rr.ok).toBe(true);
    expect(stateRes.value.detachedLocalIds.has(0 as never)).toBe(false);
  });
});
