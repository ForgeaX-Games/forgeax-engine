// feat-20260709-component-vec-fields-and-field-transient-batch M1 / w2:
// AC-08 round-trip + rebuild tests for CollidingEntities and CharacterController.
//
// TDD red-phase: these assertions will FAIL before w3 lands the transient
// declarations, then turn green after w3 adds transient: true.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rootsToSceneAsset } from '@forgeax/engine-runtime';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { CharacterController, CollidingEntities } from '../index';

function makeMockShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  return new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function hasComp(entity: SceneEntity, compName: string): boolean {
  return (entity.components as Record<string, Record<string, unknown>>)[compName] !== undefined;
}

function compField(entity: SceneEntity, compName: string, fieldName: string): unknown {
  const comp = (entity.components as Record<string, Record<string, unknown>>)[compName];
  return comp?.[fieldName];
}

describe('w2 — AC-08 round-trip tests (CollidingEntities, CharacterController)', () => {
  it('CollidingEntities: absent from collect output, absent after round-trip', () => {
    const world = new World();
    const e = world.spawn({ component: CollidingEntities, data: { entities: [] } });
    if (!e.ok) return expect(e.ok).toBe(true);

    const reg = makeRegistry();
    const collected = rootsToSceneAsset(reg, world, [e.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // CollidingEntities should NOT be in the collect output.
    const entity = collected.value.entities[0];
    expect(entity).toBeDefined();
    if (!entity) return;
    expect(hasComp(entity, 'CollidingEntities')).toBe(false);

    // Round-trip: instantiate the collected scene → re-collect.
    const handle = world.allocSharedRef('SceneAsset', collected.value);
    const inst = world.instantiateScene(handle as Parameters<typeof world.instantiateScene>[0]);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    const rt = rootsToSceneAsset(reg, world, [inst.value.root]);
    expect(rt.ok).toBe(true);
    if (!rt.ok) return;

    // After round-trip, CollidingEntities is still absent (transient, never serialized).
    for (const ent of rt.value.entities) {
      expect(hasComp(ent, 'CollidingEntities')).toBe(false);
    }
  });

  it('CharacterController: grounded absent from collect, absent after round-trip', () => {
    const world = new World();
    const e = world.spawn({ component: CharacterController, data: { grounded: true } });
    if (!e.ok) return expect(e.ok).toBe(true);

    const reg = makeRegistry();
    const collected = rootsToSceneAsset(reg, world, [e.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const entity = collected.value.entities[0];
    expect(entity).toBeDefined();
    if (!entity) return;

    // CharacterController should be present but grounded should be absent.
    expect(hasComp(entity, 'CharacterController')).toBe(true);
    expect(compField(entity, 'CharacterController', 'grounded')).toBeUndefined();

    // Round-trip: instantiate the collected scene → re-collect.
    const handle = world.allocSharedRef('SceneAsset', collected.value);
    const inst = world.instantiateScene(handle as Parameters<typeof world.instantiateScene>[0]);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    const rt = rootsToSceneAsset(reg, world, [inst.value.root]);
    expect(rt.ok).toBe(true);
    if (!rt.ok) return;

    // Find the CharacterController entity in the re-collected scene.
    const ccEntity = rt.value.entities.find((en) => hasComp(en, 'CharacterController'));
    expect(ccEntity).toBeDefined();
    if (!ccEntity) return;
    // grounded is transient — excluded from both collect and re-collect.
    expect(compField(ccEntity, 'CharacterController', 'grounded')).toBeUndefined();
  });
});
