import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  CharacterController,
  Collider,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld, registerPhysicsSystems } from '../rapier-physics-world-3d';
import { createRapier3DSimulationParticipant } from '../simulation-participant';
import { loadRapier3D } from '../wasm-loader';

const SimulationMarker = defineComponent('M4SimulationMarker', {
  value: { type: 'f32', default: 0 },
});

type SimulationState3D = {
  version: number;
  gravity: { x: number; y: number; z: number };
  bodies: Array<{
    entity: number;
    bodyType: number;
    translation: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    nextTranslation: { x: number; y: number; z: number };
    nextRotation: { x: number; y: number; z: number; w: number };
    linearVelocity: { x: number; y: number; z: number };
    angularVelocity: { x: number; y: number; z: number };
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
  pendingCollisionEvents: unknown[];
};

type TestRapierBody = {
  userData?: unknown;
  translation(): { x: number; y: number; z: number };
  linvel(): { x: number; y: number; z: number };
};

function bodyForEntity(
  world: { raw: { forEachRigidBody: (fn: (body: TestRapierBody) => void) => void } },
  entity: number,
): TestRapierBody | undefined {
  let found: TestRapierBody | undefined;
  world.raw.forEachRigidBody((body) => {
    if (body.userData === entity) found = body;
  });
  return found;
}

describe('M4 Rapier 3D simulation participant', () => {
  it('records dynamics, forces, mapping, pending state, collision order, and cleanup facts', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const physics = createRapier3DPhysicsWorld(rapier);
    physics.setGravity(new Float32Array([0, 0, 0]) as never);
    const activeEvents = rapier.ActiveEvents.COLLISION_EVENTS;
    const activeTypes = rapier.ActiveCollisionTypes.ALL;
    const first = physics.raw.createRigidBody(rapier.RigidBodyDesc.fixed());
    first.userData = 901;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(1)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      first,
    );
    physics.registerBody(901, first.handle);
    const second = physics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(0.5, 0, 0)
        .setLinvel(1, 2, 3)
        .setAngvel({ x: 0.1, y: 0.2, z: 0.3 })
        .setLinearDamping(0.25)
        .setAngularDamping(0.75)
        .setGravityScale(0.5)
        .setCcdEnabled(true),
    );
    second.userData = 902;
    physics.raw.createCollider(
      rapier.ColliderDesc.ball(0.5)
        .setDensity(2)
        .setSensor(true)
        .setActiveEvents(activeEvents)
        .setActiveCollisionTypes(activeTypes),
      second,
    );
    physics.registerBody(902, second.handle);
    second.addForce({ x: 4, y: 5, z: 6 }, false);
    physics.teleport(902, new Float32Array([9, 8, 7]) as never);
    physics.step(1 / 60);

    const participant = createRapier3DSimulationParticipant(physics);
    const recorded = participant.recordState?.();
    expect(recorded?.ok).toBe(true);
    const state = recorded?.ok ? (recorded.value as SimulationState3D) : undefined;
    expect(participant.id).toBe('forgeax.physics.rapier-3d');
    expect(participant.version).toBe('1');
    expect(participant.schemaFingerprint).toBe('rapier-3d-simulation-v1');
    expect(participant.isReady()).toBe(true);
    expect(state).toMatchObject({
      version: 1,
      gravity: { x: 0, y: 0, z: 0 },
      pendingTeleports: [[902, { x: 9, y: 8, z: 7 }]],
    });
    expect(state?.bodies.find((body) => body.entity === 902)).toMatchObject({
      linearVelocity: { x: expect.any(Number), y: expect.any(Number), z: expect.any(Number) },
      angularVelocity: { x: expect.any(Number), y: expect.any(Number), z: expect.any(Number) },
      gravityScale: 0.5,
      linearDamping: 0.25,
      angularDamping: 0.75,
      ccdEnabled: true,
    });
    expect(state?.collisionPairs).toEqual([
      [901, [902]],
      [902, [901]],
    ]);
    expect(state?.collisionEvents).toMatchObject([{ type: 'started', entityA: 901, entityB: 902 }]);
    expect(state?.pendingCollisionEvents).toMatchObject([
      { type: 'started', entityA: 901, entityB: 902 },
    ]);

    const pendingTarget = createRapier3DPhysicsWorld(rapier);
    const pendingParticipant = createRapier3DSimulationParticipant(pendingTarget);
    const pendingPrepared = pendingParticipant.prepareRestore(state);
    expect(pendingPrepared.ok).toBe(true);
    if (pendingPrepared.ok) pendingParticipant.commitRestore(pendingPrepared.value);
    expect(pendingTarget.drainCollisionEvents()).toMatchObject([
      { type: 'started', entityA: 901, entityB: 902 },
    ]);

    physics.removeEntity(902);
    const afterDespawn = participant.recordState?.();
    if (afterDespawn === undefined || !afterDespawn.ok) {
      expect.fail('expected a recordable 3D state after despawn');
    }
    expect((afterDespawn.value as SimulationState3D).collisionPairs).toEqual([[901, []]]);
  });

  it('restores body state into a fresh target without copying raw Rapier identity', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const source = createRapier3DPhysicsWorld(rapier);
    const sourceBody = source.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(3, 4, 5).setLinvel(6, 7, 8),
    );
    sourceBody.userData = 903;
    source.raw.createCollider(rapier.ColliderDesc.ball(0.5), sourceBody);
    source.registerBody(903, sourceBody.handle);
    const sourceParticipant = createRapier3DSimulationParticipant(source);
    const recorded = sourceParticipant.recordState?.();
    if (!recorded?.ok) expect.fail('expected a recordable 3D state');

    const target = createRapier3DPhysicsWorld(rapier);
    const targetParticipant = createRapier3DSimulationParticipant(target);
    const prepared = targetParticipant.prepareRestore(recorded.value);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) targetParticipant.commitRestore(prepared.value);

    const targetBody = bodyForEntity(target, 903);
    if (targetBody === undefined) expect.fail('expected a restored 3D body');
    expect(targetBody).not.toBe(sourceBody);
    expect(targetBody.translation()).toEqual({ x: 3, y: 4, z: 5 });
    expect(targetBody.linvel()).toEqual({ x: 6, y: 7, z: 8 });
    expect(target.hasBody(903)).toBe(true);
  });

  it('records and restores the KCC cache and kinematic next pose', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const world = new World();
    const source = createRapier3DPhysicsWorld(rapier);
    world.insertResource('PhysicsWorld', source);
    registerPhysicsSystems(world);
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
    source.moveAndSlide(entity, Float32Array.of(0, 0, 0) as never);

    const sourceParticipant = createRapier3DSimulationParticipant(source);
    const recorded = sourceParticipant.recordState?.();
    if (!recorded?.ok) expect.fail('expected a recordable 3D state');
    const state = recorded.value as SimulationState3D;
    expect(state.kinematicControllers).toHaveLength(1);
    expect(state.kinematicControllers[0]?.entity).toBe(entity);
    expect(state.kinematicControllers[0]?.offset).toBeCloseTo(0.2);

    const target = createRapier3DPhysicsWorld(rapier);
    const targetParticipant = createRapier3DSimulationParticipant(target);
    const prepared = targetParticipant.prepareRestore(state);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) targetParticipant.commitRestore(prepared.value);
    const restored = target.getKinematicControllerStates();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.entity).toBe(entity);
    expect(restored[0]?.offset).toBeCloseTo(0.2);
    expect(target.kccCache.size).toBe(1);
  });

  it('remaps local record entities before replacing the target world', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const source = createRapier3DPhysicsWorld(rapier);
    const sourceBody = source.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(3, 4, 5),
    );
    sourceBody.userData = 905;
    source.raw.createCollider(rapier.ColliderDesc.ball(0.5), sourceBody);
    source.registerBody(905, sourceBody.handle);
    source.teleport(905, new Float32Array([8, 7, 6]) as never);
    const sourceParticipant = createRapier3DSimulationParticipant(source);
    const recorded = sourceParticipant.recordState?.({
      mapEntity: (entity) => (entity === 905 ? 0 : undefined),
    });
    if (!recorded?.ok) expect.fail('expected a mapped 3D state');

    const target = createRapier3DPhysicsWorld(rapier);
    const targetParticipant = createRapier3DSimulationParticipant(target);
    const prepared = targetParticipant.prepareRestore(recorded.value, { entityCount: 1 });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      targetParticipant.commitRestore(prepared.value, {
        entityCount: 1,
        entityMap: new Map([[0, 77]]),
      });
    }
    expect(target.hasBody(77)).toBe(true);
    expect(target.getPendingTeleports()[0]?.[0]).toBe(77);
  });

  it('uses ECS local ids for a real World restore into a different entity handle', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const source = new World();
    const discarded = source.spawn({ component: SimulationMarker, data: { value: 0 } }).unwrap();
    source.despawn(discarded).unwrap();
    const sourceEntity = source
      .spawn({ component: SimulationMarker, data: { value: 1 } })
      .unwrap() as number;
    expect(sourceEntity).not.toBe(0);
    const sourcePhysics = createRapier3DPhysicsWorld(rapier);
    const sourceBody = sourcePhysics.raw.createRigidBody(rapier.RigidBodyDesc.dynamic());
    sourceBody.userData = sourceEntity;
    sourcePhysics.raw.createCollider(rapier.ColliderDesc.ball(0.5), sourceBody);
    sourcePhysics.registerBody(sourceEntity, sourceBody.handle);
    source
      .registerSimulationParticipant(createRapier3DSimulationParticipant(sourcePhysics))
      .unwrap();
    const record = source.simulationRecord().unwrap();

    const target = new World();
    const targetPhysics = createRapier3DPhysicsWorld(rapier);
    const targetParticipant = createRapier3DSimulationParticipant(targetPhysics);
    target.registerSimulationParticipant(targetParticipant).unwrap();
    expect(target.simulationRestore(record).ok).toBe(true);
    expect(targetPhysics.hasBody(0)).toBe(true);
    expect(targetPhysics.hasBody(sourceEntity)).toBe(false);
  });
});
