import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

describe('M4 Rapier 3D collision event order', () => {
  it('reports one enter, no stay duplicate, one exit, and one despawn cleanup', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier3DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, 0, 0]) as never);
    const activeEvents = rapier.ActiveEvents.COLLISION_EVENTS;
    const activeTypes = rapier.ActiveCollisionTypes.ALL;
    const first = physics.raw.createRigidBody(rapier.RigidBodyDesc.fixed());
    first.userData = 1101;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      first,
    );
    physics.registerBody(1101, first.handle);
    const second = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 0, 0),
    );
    second.userData = 1102;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      second,
    );
    physics.registerBody(1102, second.handle);

    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toMatchObject([
      { type: 'started', entityA: 1101, entityB: 1102 },
    ]);
    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toEqual([]);
    expect(physics.getCollisionPairs().get(1101)).toEqual(new Set([1102]));

    second.setTranslation({ x: 5, y: 0, z: 0 }, true);
    physics.raw.propagateModifiedBodyPositionsToColliders();
    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toMatchObject([
      { type: 'stopped', entityA: 1101, entityB: 1102 },
    ]);
    expect(physics.getCollisionPairs().get(1101)).toEqual(new Set());

    const third = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 0, 0),
    );
    third.userData = 1103;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      third,
    );
    physics.registerBody(1103, third.handle);
    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toMatchObject([
      { type: 'started', entityA: 1101, entityB: 1103 },
    ]);
    physics.removeEntity(1103);
    expect(physics.drainCollisionEvents()).toMatchObject([
      { type: 'stopped', entityA: 1101, entityB: 1103 },
    ]);
    expect(physics.getCollisionPairs().get(1101)).toEqual(new Set());
  });
});
