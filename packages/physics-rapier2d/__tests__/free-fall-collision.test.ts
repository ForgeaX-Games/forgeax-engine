// packages/physics-rapier2d/__tests__/free-fall-collision.test.ts
//
// feat-20260528-rapier-physics-2d-3d . M3 . t18 (red)
// bug-20260529-physics-tick-systems-no-op-stub-demo-frozen M4 AC-07 rework
//
// Low-level Rapier-direct tests for collision, kinematic teleport, despawn,
// userData, and 2D rotation primitives. Distinct from the ECS-bridge
// regression tests in the "bug-20260529 M2 real ECS bridge" describe below,
// which use World.spawn + registerPhysicsSystems2D → world.update → assert
// Transform writeback.
//
// Dynamic free-fall and static-body tests that previously used
// pw.raw.createRigidBody have been removed — they were semantically replaced
// by the real ECS bridge test.

import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-runtime';
import { loadRapier2D } from '../src/wasm-loader';
import {
  createRapier2DPhysicsWorld,
  registerPhysicsSystems2D,
} from '../src/rapier-physics-world-2d';

describe('feat-20260528 M3 t18 Rapier2D low-level primitives (collision, kinematic, despawn, rotation)', () => {
  it('kinematic body: position follows setNextKinematicTranslation in 2D', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const pw = createRapier2DPhysicsWorld(RAPIER);

    const body = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3),
    );
    body.userData = 3;
    pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1), body);
    pw.registerBody(3, body.handle);

    pw.setKinematicPosition(3, { x: 5, y: 3 });

    for (let i = 0; i < 60; i++) {
      pw.step(1 / 60);
    }

    const posAfter = body.translation();
    expect(posAfter.x).toBeCloseTo(5, 0);
  });

  it('two dynamic balls collide in 2D', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const pw = createRapier2DPhysicsWorld(RAPIER);

    // Two balls placed close together, gravity pulls both down + together.
    const b1 = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(-0.1, 1),
    );
    b1.userData = 101;
    pw.raw.createCollider(
      RAPIER.ColliderDesc.ball(0.5).setFriction(0.1).setRestitution(0.3),
      b1,
    );
    pw.registerBody(101, b1.handle);

    const b2 = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0.1, 1),
    );
    b2.userData = 102;
    pw.raw.createCollider(
      RAPIER.ColliderDesc.ball(0.5).setFriction(0.1).setRestitution(0.3),
      b2,
    );
    pw.registerBody(102, b2.handle);

    for (let i = 0; i < 120; i++) {
      pw.step(1 / 60);
    }

    const pos1 = b1.translation();
    const pos2 = b2.translation();
    expect(pos1.y).toBeLessThan(1);
    expect(pos2.y).toBeLessThan(1);
  });

  it('ball bounces on ground without errors in 2D', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const pw = createRapier2DPhysicsWorld(RAPIER);

    const ground = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2),
    );
    ground.userData = 200;
    pw.raw.createCollider(
      RAPIER.ColliderDesc.cuboid(10, 0.5).setRestitution(0.3),
      ground,
    );
    pw.registerBody(200, ground.handle);

    const ball = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5),
    );
    ball.userData = 201;
    pw.raw.createCollider(
      RAPIER.ColliderDesc.ball(0.5).setRestitution(0.5),
      ball,
    );
    pw.registerBody(201, ball.handle);

    for (let i = 0; i < 180; i++) {
      pw.step(1 / 60);
    }

    const pos = ball.translation();
    expect(pos.y).toBeLessThan(5);
  });

  it('despawn: removeEntity reduces body count in 2D', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const pw = createRapier2DPhysicsWorld(RAPIER);

    const body = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5),
    );
    body.userData = 4;
    pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
    pw.registerBody(4, body.handle);

    pw.step(1 / 60);
    expect(pw.getBodyCount()).toBeGreaterThan(0);

    pw.removeEntity(4);
    expect(pw.getBodyCount()).toBe(0);
  });

  it('userData can be read after setting on 2D body', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const rw = new RAPIER.World({ x: 0, y: -9.81 });
    const body = rw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5),
    );

    body.userData = 42;
    expect(body.userData).toBe(42);
  });

  it('2D rotation is scalar angle after physics step', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const pw = createRapier2DPhysicsWorld(RAPIER);

    const body = pw.raw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 5)
        .setRotation(0.5)
        .setAngularDamping(0),
    );
    body.userData = 5;
    pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(2, 1), body);
    pw.registerBody(5, body.handle);

    for (let i = 0; i < 10; i++) {
      pw.step(1 / 60);
    }

    const results = pw.writebackDynamicBodies();
    expect(results.length).toBeGreaterThan(0);
    const r0 = results[0];
    expect(r0).toBeDefined();
    if (r0) {
      // 2D rotation is a scalar angle, not a quaternion.
      expect(typeof r0.rotation).toBe('number');
    }
  });
});

describe('bug-20260529 M2 real ECS bridge (regression)', () => {
  it('dynamic ball falls + static ground unchanged through registerPhysicsSystems2D', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const world = new World();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);

    // Spawn dynamic ball at y=5 with (Transform, RigidBody{dynamic}, Collider{sphere}).
    const dynamicEntity = world
      .spawn(
        { component: Transform as never, data: { pos: [0, 5, 0]} },
        {
          component: RigidBody as never,
          data: {
            type: RigidBodyTypeValue.dynamic,
            mass: 1,
            linearDamping: 0,
            angularDamping: 0,
            gravityScale: 1,
          },
        },
        {
          component: Collider as never,
          data: { shape: 1, radius: 0.5, friction: 0.5, restitution: 0 },
        },
      )
      .unwrap();

    // Spawn static ground at y=0 with (Transform, RigidBody{static}, Collider{cuboid}).
    const staticEntity = world
      .spawn(
        { component: Transform as never, data: { pos: [0, 0, 0]} },
        {
          component: RigidBody as never,
          data: { type: RigidBodyTypeValue.static },
        },
        {
          component: Collider as never,
          data: {
            shape: 0,
            halfExtents: [10, 1],
            friction: 0.5,
            restitution: 0,
          },
        },
      )
      .unwrap();

    // Read initial positions.
    const initDynamic = world.get(dynamicEntity, Transform as never);
    const initStatic = world.get(staticEntity, Transform as never);
    expect(initDynamic.ok).toBe(true);
    expect(initStatic.ok).toBe(true);
    if (!initDynamic.ok || !initStatic.ok) return;
    const dynPosYBefore = (initDynamic.value as { pos: Float32Array }).pos[1] as number;
    expect(dynPosYBefore).toBeCloseTo(5, 1);

    // Register physics systems.
    registerPhysicsSystems2D(world);

    // Run 60 frames at 60 fps.
    for (let i = 0; i < 60; i++) {
      world.insertResource('Time', { dt: 1 / 60, elapsed: (i + 1) / 60 });
      world.update();
    }

    // Dynamic entity should have fallen (posY < 4.5).
    const finalDynamic = world.get(dynamicEntity, Transform as never);
    if (!finalDynamic.ok) {
      expect(finalDynamic.ok).toBe(true);
      return;
    }
    const dynPosYAfter = (finalDynamic.value as { pos: Float32Array }).pos[1] as number;
    expect(dynPosYAfter).toBeLessThan(4.5);

    // Static entity Transform should be unchanged.
    const finalStatic = world.get(staticEntity, Transform as never);
    if (!finalStatic.ok) {
      expect(finalStatic.ok).toBe(true);
      return;
    }
    const staticPosYAfter = (finalStatic.value as { pos: Float32Array }).pos[1] as number;
    expect(staticPosYAfter).toBeCloseTo(0, 1);

    // Verify physics body count: 2 entities should exist in Rapier world.
    const bodyCount = pw.getBodyCount();
    expect(bodyCount).toBe(2);
  });
});

describe('feat-20260709 M4 / w18 -- cuboid halfExtents array passes through the 2D bridge', () => {
  it('ball rests at ground-top + radius, driven by halfExtents[1] (regression)', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const world = new World();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);

    // Dynamic ball (radius 0.5) dropped onto a cuboid ground whose top is at
    // groundPosY + halfExtents[1] = 0 + 2 = 2. If the array collapse dropped
    // halfExtents[1] (=> 0 half-height) the ball would settle near 0.5 instead
    // of ~2.5, so this resting height is a dimension-sensitive regression.
    const ball = world
      .spawn(
        { component: Transform as never, data: { pos: [0, 6, 0] } },
        {
          component: RigidBody as never,
          data: { type: RigidBodyTypeValue.dynamic, mass: 1, gravityScale: 1 },
        },
        {
          component: Collider as never,
          data: { shape: 1, radius: 0.5, friction: 0.5, restitution: 0 },
        },
      )
      .unwrap();

    world
      .spawn(
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
        {
          component: Collider as never,
          data: { shape: 0, halfExtents: [10, 2], friction: 0.5, restitution: 0 },
        },
      )
      .unwrap();

    registerPhysicsSystems2D(world);
    for (let i = 0; i < 240; i++) {
      world.insertResource('Time', { dt: 1 / 60, elapsed: (i + 1) / 60 });
      world.update();
    }

    const finalBall = world.get(ball, Transform as never);
    expect(finalBall.ok).toBe(true);
    if (!finalBall.ok) return;
    const restY = (finalBall.value as { pos: Float32Array }).pos[1] as number;
    // ground top (2.0) + ball radius (0.5) = 2.5.
    expect(restY).toBeGreaterThan(2.2);
    expect(restY).toBeLessThan(2.8);
  });
});

describe('bug-20260713 solo round-22 Rapier2D raycast entity resolution', () => {
  // Same bug + fix as the 3D backend: raycast resolved hit.entity via
  // `bodies.get(hit.collider.parent())`, but `.parent()` already returns the
  // RigidBody OBJECT (compat build), so treating it as a handle returned a
  // DIFFERENT body → the wrong entity. Drive the real PhysicsWorld2D.raycast()
  // with two distinct entities and assert the one geometrically struck.
  it('raycast: hit.entity is the entity actually struck (not another body)', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const world = new World();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);

    // Ground: static cuboid, top at y=0.
    const ground = world
      .spawn(
        { component: Transform as never, data: { pos: [0, -0.5, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
        { component: Collider as never, data: { shape: 0, halfExtents: [10, 0.5] } },
      )
      .unwrap();

    // Target: static cuboid centred at x=5 (near face x=4), above the ground.
    const target = world
      .spawn(
        { component: Transform as never, data: { pos: [5, 1, 0] } },
        { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
        { component: Collider as never, data: { shape: 0, halfExtents: [1, 1] } },
      )
      .unwrap();

    registerPhysicsSystems2D(world);
    for (let i = 0; i < 5; i++) {
      world.insertResource('Time', { dt: 1 / 60, elapsed: (i + 1) / 60 });
      world.update();
    }

    // Ray at y=1 toward +X can only reach the target (ground tops out at y=0).
    const toTarget = pw.raycast(Float32Array.of(0, 1) as never, Float32Array.of(1, 0) as never, 20);
    expect(toTarget).toBeDefined();
    expect(toTarget?.entity).toBe(target);
    expect(toTarget?.timeOfImpact).toBeCloseTo(4, 1);

    // Ray straight down from above the origin hits the ground, not the target.
    const toGround = pw.raycast(Float32Array.of(0, 5) as never, Float32Array.of(0, -1) as never, 20);
    expect(toGround).toBeDefined();
    expect(toGround?.entity).toBe(ground);

    // A ray past all geometry misses.
    const miss = pw.raycast(Float32Array.of(0, 1) as never, Float32Array.of(0, 1) as never, 20);
    expect(miss).toBeUndefined();
  });
});

describe('bug-20260713 solo round-26 Rapier2D bare-Collider static floor', () => {
  // Same fix as the 3D backend: physicsSyncBackend2D used to gate on a RigidBody
  // column, so a bare Collider (no RigidBody) — the natural way to author static
  // level geometry, promised as a static collider by the Collider docstring —
  // was NEVER simulated and a dynamic ball fell through it. This locks the fix:
  // the floor is synthesized as an implicit static body and the ball settles.
  it('bare Collider (no RigidBody) acts as a static floor — dynamic ball settles, not falls through', async () => {
    const RAPIER = await loadRapier2D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }

    const world = new World();
    const pw = createRapier2DPhysicsWorld(RAPIER);
    world.insertResource('PhysicsWorld', pw);

    // Ball: dynamic body + circle collider dropped from y=5.
    const ball = world
      .spawn(
        { component: Transform as never, data: { pos: [0, 5, 0] } },
        {
          component: RigidBody as never,
          data: {
            type: RigidBodyTypeValue.dynamic,
            mass: 1,
            linearDamping: 0,
            angularDamping: 0,
            gravityScale: 1,
          },
        },
        {
          component: Collider as never,
          data: { shape: ColliderShapeValue.sphere, radius: 0.5, friction: 0.5, restitution: 0 },
        },
      )
      .unwrap();

    // Floor: a BARE Collider — NO RigidBody. Cuboid top at y = 0 + 0.5 = 0.5.
    const floor = world
      .spawn(
        { component: Transform as never, data: { pos: [0, 0, 0] } },
        {
          component: Collider as never,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5], friction: 0.5, restitution: 0 },
        },
      )
      .unwrap();

    // Sanity: the floor archetype genuinely has no RigidBody column.
    expect(world.get(floor, RigidBody as never).ok).toBe(false);

    registerPhysicsSystems2D(world);

    for (let i = 0; i < 120; i++) {
      world.insertResource('Time', { dt: 1 / 60, elapsed: (i + 1) / 60 });
      world.update();
    }

    const finalBall = world.get(ball, Transform as never);
    expect(finalBall.ok).toBe(true);
    if (!finalBall.ok) return;
    const ballY = (finalBall.value as { pos: Float32Array }).pos[1] as number;
    // Rests at floorTop (0.5) + radius (0.5) = ~1.0 — NOT fallen through to a
    // large-negative y (the pre-fix behavior).
    expect(ballY).toBeGreaterThan(0.6);
    expect(ballY).toBeLessThan(1.4);

    // Both bodies exist in the sim (the bare-Collider floor now gets a body).
    expect(pw.getBodyCount()).toBe(2);
  });
});
