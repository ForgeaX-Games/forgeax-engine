import { World } from '@forgeax/engine-ecs';
import {
  CharacterController,
  Collider,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import {
  createRapier2DPhysicsWorld,
  registerPhysicsSystems2D,
} from '../src/rapier-physics-world-2d';
import { createRapier2DSimulationParticipant } from '../src/simulation-participant';
import { loadRapier2D } from '../src/wasm-loader';

type SimulationState2D = {
  version: number;
  gravity: { x: number; y: number };
  bodies: Array<{
    entity: number;
    bodyType: number;
    translation: { x: number; y: number };
    rotation: number;
    nextTranslation: { x: number; y: number };
    nextRotation: number;
    linearVelocity: { x: number; y: number };
    angularVelocity: number;
    gravityScale: number;
    linearDamping: number;
    angularDamping: number;
    ccdEnabled: boolean;
    sleeping: boolean;
    colliders: unknown[];
  }>;
  joints: unknown[];
  kinematicControllers: Array<{ entity: number; offset: number }>;
  pendingTeleports: unknown[];
  collisionPairs: Array<[number, number[]]>;
  collisionEvents: unknown[];
};

describe('M4 Rapier 2D simulation participant', () => {
  it('records backend-owned dynamics, mapping, pending state, and event facts as DTOs', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier2DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, -3]) as never);
    const body = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(1, 2)
        .setLinvel(3, 4)
        .setAngvel(0.5)
        .setLinearDamping(0.25)
        .setAngularDamping(0.75)
        .setGravityScale(0.5)
        .setCcdEnabled(true),
    );
    body.userData = 401;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(0.5).setDensity(2).setSensor(true),
      body,
    );
    physics.registerBody(401, body.handle);
    physics.teleport(401, new Float32Array([9, 8]) as never, 0.25);

    const participant = createRapier2DSimulationParticipant(physics);
    const recorded = participant.recordState?.();
    expect(recorded?.ok).toBe(true);
    const state = recorded?.ok ? (recorded.value as SimulationState2D) : undefined;
    expect(participant.id).toBe('forgeax.physics.rapier-2d');
    expect(participant.version).toBe('1');
    expect(participant.schemaFingerprint).toBe('rapier-2d-simulation-v1');
    expect(participant.isReady()).toBe(true);
    expect(state).toMatchObject({
      version: 1,
      gravity: { x: 0, y: -3 },
      pendingTeleports: [[401, { x: 9, y: 8, rotation: 0.25 }]],
    });
    expect(state?.bodies[0]).toMatchObject({
      entity: 401,
      linearVelocity: { x: 3, y: 4 },
      angularVelocity: 0.5,
      gravityScale: 0.5,
      linearDamping: 0.25,
      angularDamping: 0.75,
      ccdEnabled: true,
    });
    expect(state?.bodies[0]?.colliders).toHaveLength(1);
    expect(state?.joints).toEqual([]);
    expect(JSON.stringify(state)).not.toContain('RapierWorld');
  });

  it('prepares a fresh target and rejects inaccessible or incompatible state before mutation', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const source = createRapier2DPhysicsWorld(rapier);
    const body = source.raw.createRigidBody(rapier.RigidBodyDesc.dynamic());
    body.userData = 402;
    source.raw.createCollider(rapier.ColliderDesc.ball(0.5), body);
    source.registerBody(402, body.handle);
    const sourceParticipant = createRapier2DSimulationParticipant(source);
    const recorded = sourceParticipant.recordState?.();
    if (!recorded?.ok) expect.fail('expected a recordable 2D state');

    const target = createRapier2DPhysicsWorld(rapier);
    const targetParticipant = createRapier2DSimulationParticipant(target);
    const prepared = targetParticipant.prepareRestore(recorded.value);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      targetParticipant.commitRestore(prepared.value);
    }
    expect(target.getBodyCount()).toBe(1);
    expect(target.hasBody(402)).toBe(true);

    const broken = targetParticipant.prepareRestore({
      ...(recorded.value as Record<string, unknown>),
      version: 99,
    });
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatchObject({ code: 'simulation-state-unsupported' });
    expect(target.getBodyCount()).toBe(1);
  });

  it('records and restores the KCC cache and kinematic next pose', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const world = new World();
    const source = createRapier2DPhysicsWorld(rapier);
    world.insertResource('PhysicsWorld', source);
    registerPhysicsSystems2D(world);
    const entity = world
      .spawn(
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
        {
          component: Collider as never,
          data: { shape: 2, radius: 0.3, halfHeight: 0.5 },
        },
        { component: CharacterController as never, data: { offset: 0.2 } },
      )
      .unwrap() as unknown as number;
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    source.moveAndSlide(entity, Float32Array.of(0, 0) as never);

    const sourceParticipant = createRapier2DSimulationParticipant(source);
    const recorded = sourceParticipant.recordState?.();
    if (!recorded?.ok) expect.fail('expected a recordable 2D state');
    const state = recorded.value as SimulationState2D;
    expect(state.kinematicControllers).toHaveLength(1);
    expect(state.kinematicControllers[0]?.entity).toBe(entity);
    expect(state.kinematicControllers[0]?.offset).toBeCloseTo(0.2);

    const target = createRapier2DPhysicsWorld(rapier);
    const targetParticipant = createRapier2DSimulationParticipant(target);
    const prepared = targetParticipant.prepareRestore(state);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) targetParticipant.commitRestore(prepared.value);
    const restored = target.getKinematicControllerStates();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.entity).toBe(entity);
    expect(restored[0]?.offset).toBeCloseTo(0.2);
    expect(target.kccCache.size).toBe(1);
  });

  it('remaps local record entities and preserves pending collision events on commit', async () => {
    const rapier = await loadRapier2D();
    if ('code' in rapier) {
      expect.fail(`Rapier 2D WASM unavailable: ${rapier.message}`);
    }

    const source = createRapier2DPhysicsWorld(rapier);
    source.setGravity(new Float32Array([0, 0]) as never);
    const activeEvents = rapier.ActiveEvents.COLLISION_EVENTS;
    const activeTypes = rapier.ActiveCollisionTypes.ALL;
    const first = source.raw.createRigidBody(rapier.RigidBodyDesc.fixed());
    first.userData = 403;
    source.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      first,
    );
    source.registerBody(403, first.handle);
    const second = source.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 0),
    );
    second.userData = 404;
    source.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      second,
    );
    source.registerBody(404, second.handle);
    source.teleport(403, new Float32Array([4, 5]) as never, 0.1);
    source.step(1 / 60);

    const sourceParticipant = createRapier2DSimulationParticipant(source);
    const recorded = sourceParticipant.recordState?.({
      mapEntity: (entity) => (entity === 403 ? 0 : entity === 404 ? 1 : undefined),
    });
    if (!recorded?.ok) expect.fail('expected a mapped 2D state');
    const mappedState = recorded.value as SimulationState2D & {
      pendingCollisionEvents: unknown[];
    };
    expect(mappedState.bodies.map((body) => body.entity)).toEqual([0, 1]);
    expect(mappedState.pendingTeleports[0]?.[0]).toBe(0);
    expect(mappedState.pendingCollisionEvents).toMatchObject([
      { type: 'started', entityA: 0, entityB: 1 },
    ]);

    const target = createRapier2DPhysicsWorld(rapier);
    const free = vi.fn();
    target.raw.free = free;
    const targetParticipant = createRapier2DSimulationParticipant(target);
    const prepared = targetParticipant.prepareRestore(mappedState, { entityCount: 2 });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      targetParticipant.commitRestore(prepared.value, {
        entityCount: 2,
        entityMap: new Map([
          [0, 42],
          [1, 43],
        ]),
      });
    }
    expect(target.hasBody(42)).toBe(true);
    expect(target.hasBody(43)).toBe(true);
    expect(target.getPendingTeleports()[0]?.[0]).toBe(42);
    expect(target.drainCollisionEvents()).toMatchObject([
      { type: 'started', entityA: 42, entityB: 43 },
    ]);
    expect(free).toHaveBeenCalledTimes(1);
  });
});
