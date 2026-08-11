import { PhysicsError } from '@forgeax/engine-physics';
import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D } from '../wasm-loader';

type CollisionPairs = Map<number, Set<number>>;

function collisionPairsOf(world: unknown): CollisionPairs {
  return (world as { collisionPairs: CollisionPairs }).collisionPairs;
}

describe('M1 Rapier 3D simulation facts characterization', () => {
  it('exposes dynamics, controls, entity mapping, and pending teleport facts', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier3DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, -3, 0]) as never);
    const body = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(0, 2, 0)
        .setLinvel(1, 2, 3)
        .setAngvel({ x: 0.1, y: 0.2, z: 0.3 })
        .setLinearDamping(0.25)
        .setAngularDamping(0.5)
        .setGravityScale(0.75)
        .setCcdEnabled(true),
    );
    body.userData = 101;
    physics.raw.createCollider(rapier.ColliderDesc.ball(0.5), body);
    physics.registerBody(101, body.handle);

    expect(physics.getGravity()[1]).toBe(-3);
    expect(physics.hasBody(101)).toBe(true);
    expect(body.userData).toBe(101);
    expect(body.linvel()).toEqual({ x: 1, y: 2, z: 3 });
    expect(body.angvel().x).toBeCloseTo(0.1);
    expect(body.angvel().y).toBeCloseTo(0.2);
    expect(body.angvel().z).toBeCloseTo(0.3);
    expect(body.bodyType()).toBe(rapier.RigidBodyType.Dynamic);
    expect(body.gravityScale()).toBeCloseTo(0.75);
    expect(body.linearDamping()).toBeCloseTo(0.25);
    expect(body.angularDamping()).toBeCloseTo(0.5);
    expect(body.isCcdEnabled()).toBe(true);

    physics.teleport(101, new Float32Array([4, 5, 6]) as never);
    physics.applyPendingTeleports();
    expect(body.translation()).toEqual({ x: 4, y: 5, z: 6 });
    expect(body.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('records dynamic writeback and removes mapping plus backend objects together', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier3DPhysicsWorld(rapier);
    const body = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 0)
        .setRotation({ x: 0, y: 0, z: 0, w: 1 }),
    );
    body.userData = 202;
    physics.raw.createCollider(rapier.ColliderDesc.ball(0.5), body);
    physics.registerBody(202, body.handle);

    physics.step(1 / 60);
    const writeback = physics.writebackDynamicBodies();
    expect(writeback).toHaveLength(1);
    expect(writeback[0]).toMatchObject({ entity: 202, pos: { x: 0, y: expect.any(Number), z: 0 } });
    expect(writeback[0]?.rotation).toEqual(expect.objectContaining({ w: expect.any(Number) }));

    physics.removeEntity(202);
    expect(physics.hasBody(202)).toBe(false);
    expect(physics.getBodyCount()).toBe(0);
    expect(physics.kccCache.has(202)).toBe(false);
  });

  it('keeps collision pairs and event queue as backend-owned facts', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier3DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, 0, 0]) as never);
    const activeEvents = rapier.ActiveEvents.COLLISION_EVENTS;
    const activeTypes = rapier.ActiveCollisionTypes.ALL;
    const first = physics.raw.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    first.userData = 301;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      first,
    );
    physics.registerBody(301, first.handle);
    const second = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 0, 0),
    );
    second.userData = 302;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      second,
    );
    physics.registerBody(302, second.handle);

    physics.step(1 / 60);
    expect(collisionPairsOf(physics).get(301)?.has(302)).toBe(true);
    expect(collisionPairsOf(physics).get(302)?.has(301)).toBe(true);
    expect(
      typeof (physics as unknown as { drainCollisionEvents: () => void }).drainCollisionEvents,
    ).toBe('function');
    expect(physics.raw).toHaveProperty('step');

    physics.step(1 / 60);
    expect(collisionPairsOf(physics).get(301)?.has(302)).toBe(true);

    second.setTranslation({ x: 5, y: 0, z: 0 }, true);
    physics.step(1 / 60);
    expect(collisionPairsOf(physics).get(301)?.has(302)).toBe(false);

    physics.removeEntity(302);
    expect(collisionPairsOf(physics).get(301)?.has(302)).toBe(false);
  });

  it('reports body readiness errors before KCC or world mutation', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier3DPhysicsWorld(rapier);
    expect(() => physics.moveAndSlide(999, new Float32Array([1, 0, 0]) as never)).toThrow(
      PhysicsError,
    );
    try {
      physics.moveAndSlide(999, new Float32Array([1, 0, 0]) as never);
      expect.fail('expected a body-not-found error');
    } catch (error) {
      expect(error).toMatchObject({ code: 'body-not-found' });
    }
    expect(physics.getBodyCount()).toBe(0);
    expect(physics.kccCache.size).toBe(0);
  });
});
