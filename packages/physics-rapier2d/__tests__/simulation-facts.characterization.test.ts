import { describe, expect, it } from 'vitest';
import { PhysicsError } from '@forgeax/engine-physics';
import { createRapier2DPhysicsWorld } from '../src/rapier-physics-world-2d';
import { loadRapier2D } from '../src/wasm-loader';

type CollisionEventQueue = {
  drainCollisionEvents(callback: (handle1: number, handle2: number, started: boolean) => void): void;
};

function collisionEventQueueOf(world: unknown): CollisionEventQueue {
  return (world as { eventQueue: CollisionEventQueue }).eventQueue;
}

describe('M1 Rapier 2D simulation facts characterization', () => {
  it('exposes backend-owned dynamics, mapping, and pending teleport facts', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier2DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, -3]) as never);
    const body = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(0, 2)
        .setLinvel(1, 0)
        .setAngularDamping(0.25),
    );
    body.userData = 101;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(0.5).setFriction(0.2).setRestitution(0.4),
      body,
    );
    physics.registerBody(101, body.handle);

    expect(physics.getGravity()[1]).toBe(-3);
    expect(physics.hasBody(101)).toBe(true);
    expect(body.userData).toBe(101);
    expect(body.linvel()).toEqual({ x: 1, y: 0 });
    expect(body.bodyType()).toBe(rapier.RigidBodyType.Dynamic);

    physics.teleport(101, new Float32Array([4, 5]) as never, 0.5);
    physics.applyPendingTeleports();
    expect(body.translation()).toEqual({ x: 4, y: 5 });
    expect(body.linvel()).toEqual({ x: 0, y: 0 });
    expect(body.rotation()).toBe(0.5);
  });

  it('records dynamic writeback and removes mapping plus backend objects together', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier2DPhysicsWorld(rapier);
    const body = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0, 1).setRotation(0.25),
    );
    body.userData = 202;
    physics.raw.createCollider(rapier.ColliderDesc.ball(0.5), body);
    physics.registerBody(202, body.handle);

    physics.step(1 / 60);
    const writeback = physics.writebackDynamicBodies();
    expect(writeback).toHaveLength(1);
    expect(writeback[0]).toMatchObject({ entity: 202, pos: { x: 0, y: expect.any(Number) } });
    expect(typeof writeback[0]?.rotation).toBe('number');

    physics.removeEntity(202);
    expect(physics.hasBody(202)).toBe(false);
    expect(physics.getBodyCount()).toBe(0);
    expect(physics.kccCache.has(202)).toBe(false);
  });

  it('captures a backend-owned collision-enter event through the public drain facade', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier2DPhysicsWorld(rapier);
    expect(typeof physics.raw.createImpulseJoint).toBe('function');
    expect(typeof physics.drainCollisionEvents).toBe('function');
    physics.setGravity(new Float32Array([0, 0]) as never);
    const activeEvents = rapier.ActiveEvents.COLLISION_EVENTS;
    const activeTypes = rapier.ActiveCollisionTypes.ALL;
    const first = physics.raw.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, 0));
    first.userData = 301;
    const firstCollider = physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      first,
    );
    physics.registerBody(301, first.handle);
    const second = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 0).setLinvel(0, 0),
    );
    second.userData = 302;
    const secondCollider = physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      second,
    );
    physics.registerBody(302, second.handle);

    physics.step(1 / 60);
    expect(physics.drainCollisionEvents()).toContainEqual({
      type: 'started',
      entityA: 301,
      entityB: 302,
    });
    expect(firstCollider.handle).not.toBe(secondCollider.handle);
    expect(collisionEventQueueOf(physics)).toBeDefined();
    expect(physics.raw).toHaveProperty('step');
  });

  it('reports body readiness errors before any KCC or world mutation', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect(rapier.code).toBe('wasm-load-failed');
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier2DPhysicsWorld(rapier);
    expect(() => physics.moveAndSlide(999, new Float32Array([1, 0]) as never)).toThrow(
      PhysicsError,
    );
    try {
      physics.moveAndSlide(999, new Float32Array([1, 0]) as never);
      expect.fail('expected a body-not-found error');
    } catch (error) {
      expect(error).toMatchObject({ code: 'body-not-found' });
    }
    expect(physics.getBodyCount()).toBe(0);
  });
});
