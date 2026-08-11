import { CollidingEntities } from '@forgeax/engine-physics';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { createRapier2DPhysicsWorld } from '../src/rapier-physics-world-2d';
import { loadRapier2D } from '../src/wasm-loader';

describe('M4 Rapier 2D collision event and writeback parity', () => {
  it('drains ordered enter, stay, and exit facts into deduplicated entity pairs', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier2DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, 0]) as never);
    const activeEvents = rapier.ActiveEvents.COLLISION_EVENTS;
    const activeTypes = rapier.ActiveCollisionTypes.ALL;
    const first = physics.raw.createRigidBody(rapier.RigidBodyDesc.fixed());
    first.userData = 101;
    const firstCollider = physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      first,
    );
    physics.registerBody(101, first.handle);
    const second = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 0),
    );
    second.userData = 102;
    const secondCollider = physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      second,
    );
    physics.registerBody(102, second.handle);

    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toMatchObject([
      { type: 'started', entityA: 101, entityB: 102 },
    ]);
    expect(physics.getCollisionPairs().get(101)).toEqual(new Set([102]));
    expect(physics.getCollisionPairs().get(102)).toEqual(new Set([101]));

    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toEqual([]);
    expect(physics.getCollisionPairs().get(101)).toEqual(new Set([102]));

    second.setTranslation({ x: 5, y: 0 }, true);
    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toMatchObject([
      { type: 'stopped', entityA: 101, entityB: 102 },
    ]);
    expect(physics.getCollisionPairs().get(101)).toEqual(new Set());
    expect(firstCollider.handle).not.toBe(secondCollider.handle);
  });

  it('writes current overlap sets and cleans both sides on despawn', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier2DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, 0]) as never);
    const first = physics.raw.createRigidBody(rapier.RigidBodyDesc.fixed());
    first.userData = 201;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(rapier.ActiveCollisionTypes.ALL),
      first,
    );
    physics.registerBody(201, first.handle);
    const second = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 0),
    );
    second.userData = 202;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(rapier.ActiveCollisionTypes.ALL),
      second,
    );
    physics.registerBody(202, second.handle);
    physics.step(1 / 60);

    const world = new World();
    const firstEntity = world.spawn({ component: CollidingEntities, data: { entities: [] } }).unwrap();
    const secondEntity = world.spawn({ component: CollidingEntities, data: { entities: [] } }).unwrap();
    physics.removeEntity(202);
    physics.writebackCollidingEntities(world, CollidingEntities);

    expect(physics.getCollisionPairs().get(201)).toEqual(new Set());
    expect(Array.from(world.get(firstEntity, CollidingEntities).unwrap().entities)).toEqual([]);
    expect(Array.from(world.get(secondEntity, CollidingEntities).unwrap().entities)).toEqual([]);
  });
});
