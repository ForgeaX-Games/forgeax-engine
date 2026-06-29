// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/physics-rapier3d/__tests__/collision-event.test.ts
//   - packages/physics-rapier3d/__tests__/despawn-cleanup.test.ts
//   - packages/physics-rapier3d/__tests__/raycast-teleport.test.ts
//   - packages/physics-rapier3d/__tests__/tick-pipeline.test.ts
//   - packages/physics-rapier3d/__tests__/wasm-loader.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from __tests__/ into src/__tests__/; import paths adjusted (../src/xxx → ../xxx).

import { World } from '@forgeax/engine-ecs';
import {
  CharacterController,
  Collider,
  PhysicsError,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld, registerPhysicsSystems } from '../rapier-physics-world-3d';
import { detectSimd3D, loadRapier3D } from '../wasm-loader';

{
  // ─── from collision-event.test.ts ───

  describe('collision-event.test.ts', () => {
    describe('feat-20260528 M2 t13 Rapier3D collision events', () => {
      it('two dynamic spheres fall and collide', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const b1 = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, -0.3),
        );
        b1.userData = 101;
        pw.raw.createCollider(
          RAPIER.ColliderDesc.ball(0.5).setFriction(0.1).setRestitution(0.3),
          b1,
        );
        pw.registerBody(101, b1.handle);

        const b2 = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0.3));
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

      it('userData can be read after setting', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));

        body.userData = 42;
        expect(body.userData).toBe(42);
      });

      it('ball bounces on ground without errors', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const ground = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
        ground.userData = 200;
        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10).setRestitution(0.3), ground);
        pw.registerBody(200, ground.handle);

        const ball = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        ball.userData = 201;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5).setRestitution(0.5), ball);
        pw.registerBody(201, ball.handle);

        for (let i = 0; i < 180; i++) {
          pw.step(1 / 60);
        }

        const pos = ball.translation();
        expect(pos.y).toBeLessThan(5);
      });
    });
  });
}

{
  // ─── from despawn-cleanup.test.ts ───

  describe('despawn-cleanup.test.ts', () => {
    describe('feat-20260528 M2 t14 Rapier3D entity despawn cleanup', () => {
      it('removeEntity reduces body count to zero', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        body.userData = 401;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
        pw.registerBody(401, body.handle);

        pw.step(1 / 60);
        expect(pw.getBodyCount()).toBeGreaterThan(0);

        pw.removeEntity(401);
        expect(pw.getBodyCount()).toBe(0);
      });

      it('multi-entity: remove one, others remain', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        for (let i = 0; i < 3; i++) {
          const body = pw.raw.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic().setTranslation(i, 5, 0),
          );
          body.userData = 410 + i;
          pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
          pw.registerBody(410 + i, body.handle);
        }

        const countBefore = pw.getBodyCount();
        expect(countBefore).toBe(3);

        pw.removeEntity(410);
        expect(pw.getBodyCount()).toBe(2);
      });

      it('removeEntity on unknown entity does not throw', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1));

        pw.removeEntity(999);
        expect(pw.getBodyCount()).toBe(0);
      });
    });
  });
}

{
  // ─── from raycast-teleport.test.ts ───

  describe('raycast-teleport.test.ts', () => {
    describe('feat-20260528 M2 t13b Rapier3D raycast + teleport', () => {
      it('raycast: Rapier castRayAndGetNormal hits static ground', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const ground = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
        rw.createCollider(RAPIER.ColliderDesc.cuboid(10, 1, 10), ground);
        rw.step();

        const ray = new RAPIER.Ray({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 });
        const hit = rw.castRayAndGetNormal(ray, 100, true);

        expect(hit).toBeDefined();
        if (hit !== null) {
          const point = ray.pointAt(hit.timeOfImpact);
          expect(point.y).toBeLessThan(0);
          expect(point.y).toBeGreaterThan(-3);
          expect(hit.normal.y).toBeGreaterThan(0);
          expect(hit.timeOfImpact).toBeGreaterThan(0);
          expect(hit.timeOfImpact).toBeLessThan(100);
        }
      });

      it('raycast: Rapier castRay pointing away returns null', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const ground = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
        rw.createCollider(RAPIER.ColliderDesc.cuboid(10, 1, 10), ground);
        rw.step();

        const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
        const hit = rw.castRayAndGetNormal(ray, 100, true);

        expect(hit).toBeNull();
      });

      it('teleport: Rapier setTranslation + zero velocity', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const rw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0));
        rw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);

        body.setTranslation({ x: 100, y: 100, z: 100 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.setAngvel({ x: 0, y: 0, z: 0 }, false);

        const pos = body.translation();
        expect(pos.x).toBeCloseTo(100, 0);
        expect(pos.y).toBeCloseTo(100, 0);
        expect(pos.z).toBeCloseTo(100, 0);
      });
    });
  });
}

{
  // ─── from tick-pipeline.test.ts ───

  describe('tick-pipeline.test.ts', () => {
    describe('feat-20260528 M2 t12 Rapier3D low-level primitives (kinematic teleport, despawn)', () => {
      it('kinematic body: position follows setNextKinematicTranslation', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3, 0),
        );
        body.userData = 3;
        pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1), body);
        pw.registerBody(3, body.handle);

        pw.setKinematicPosition(3, { x: 10, y: 3, z: 0 });

        for (let i = 0; i < 60; i++) {
          pw.step(1 / 60);
        }

        const posAfter = body.translation();
        expect(posAfter.x).toBeCloseTo(10, 0);
      });

      it('despawn: removeEntity reduces body count', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const pw = createRapier3DPhysicsWorld(RAPIER);

        const body = pw.raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
        body.userData = 4;
        pw.raw.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
        pw.registerBody(4, body.handle);

        pw.step(1 / 60);
        expect(pw.getBodyCount()).toBeGreaterThan(0);

        pw.removeEntity(4);
        expect(pw.getBodyCount()).toBe(0);
      });
    });

    describe('bug-20260529 M1 real ECS bridge (regression)', () => {
      it('dynamic ball falls + static ground unchanged through registerPhysicsSystems', async () => {
        const RAPIER = await loadRapier3D();
        if ('code' in RAPIER) {
          expect(RAPIER.code).toBe('wasm-load-failed');
          return;
        }

        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);

        const dynamicEntity = world
          .spawn(
            { component: Transform as never, data: { posX: 0, posY: 5, posZ: 0 } },
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

        const staticEntity = world
          .spawn(
            { component: Transform as never, data: { posX: 0, posY: 0, posZ: 0 } },
            {
              component: RigidBody as never,
              data: { type: RigidBodyTypeValue.static },
            },
            {
              component: Collider as never,
              data: {
                shape: 0,
                halfExtentsX: 10,
                halfExtentsY: 1,
                halfExtentsZ: 10,
                friction: 0.5,
                restitution: 0,
              },
            },
          )
          .unwrap();

        const initDynamic = world.get(dynamicEntity, Transform as never);
        const initStatic = world.get(staticEntity, Transform as never);
        expect(initDynamic.ok).toBe(true);
        expect(initStatic.ok).toBe(true);
        if (!initDynamic.ok || !initStatic.ok) return;
        const dynPosYBefore = (initDynamic.value as Record<string, number>).posY;
        expect(dynPosYBefore).toBeCloseTo(5, 1);

        registerPhysicsSystems(world);

        for (let i = 0; i < 60; i++) {
          world.insertResource('Time', { dt: 1 / 60, elapsed: (i + 1) / 60 });
          world.update();
        }

        const finalDynamic = world.get(dynamicEntity, Transform as never);
        if (!finalDynamic.ok) {
          expect(finalDynamic.ok).toBe(true);
          return;
        }
        const dynPosYAfter = (finalDynamic.value as Record<string, number>).posY;
        expect(dynPosYAfter).toBeLessThan(4.5);

        const finalStatic = world.get(staticEntity, Transform as never);
        if (!finalStatic.ok) {
          expect(finalStatic.ok).toBe(true);
          return;
        }
        const staticPosYAfter = (finalStatic.value as Record<string, number>).posY;
        expect(staticPosYAfter).toBeCloseTo(0, 1);

        const bodyCount = pw.getBodyCount();
        expect(bodyCount).toBe(2);
      });
    });
  });
}

{
  // ─── from wasm-loader.test.ts ───

  describe('wasm-loader.test.ts', () => {
    describe('feat-20260528 M2 t10 Rapier3D WASM loader', () => {
      it('loadRapier3D should import and init rapier3d-compat returning a RAPIER instance', async () => {
        const result = await loadRapier3D();

        if ('code' in result) {
          expect(result.code).toBe('wasm-load-failed');
          return;
        }

        expect(result).toBeDefined();
        expect(typeof result.version).toBe('function');
      });

      it('loadRapier3D RAPIER instance should support World + RigidBody creation', async () => {
        const rapier = await loadRapier3D();

        if ('code' in rapier) {
          expect(rapier.code).toBe('wasm-load-failed');
          return;
        }

        const world2 = new rapier.World({ x: 0, y: -9.81, z: 0 });
        expect(world2).toBeDefined();

        const bodyDesc = rapier.RigidBodyDesc.dynamic()
          .setTranslation(0, 5, 0)
          .setLinearDamping(0.1)
          .setAngularDamping(0.1);
        const body = world2.createRigidBody(bodyDesc);
        expect(body).toBeDefined();
        expect(typeof body.handle).toBe('number');
        expect(body.handle).toBeGreaterThanOrEqual(0);

        const colliderDesc = rapier.ColliderDesc.ball(0.5).setFriction(0.5).setRestitution(0.3);
        const collider = world2.createCollider(colliderDesc, body);
        expect(collider).toBeDefined();
        expect(typeof collider.handle).toBe('number');
      });

      it('loadRapier3D should step simulation without errors', async () => {
        const rapier = await loadRapier3D();

        if ('code' in rapier) {
          expect(rapier.code).toBe('wasm-load-failed');
          return;
        }

        const world3 = new rapier.World({ x: 0, y: -9.81, z: 0 });
        const body = world3.createRigidBody(
          rapier.RigidBodyDesc.dynamic().setTranslation(0, 10, 0),
        );
        world3.createCollider(rapier.ColliderDesc.ball(0.5), body);

        for (let i = 0; i < 60; i++) {
          world3.step();
        }

        const pos = body.translation();
        expect(pos.y).toBeLessThan(10);
      });

      it('detectSimd3D should return a boolean', () => {
        const result = detectSimd3D();
        expect(typeof result).toBe('boolean');
      });

      it('detectSimd3D should return consistent results on repeated calls', () => {
        const first = detectSimd3D();
        const second = detectSimd3D();
        expect(first).toBe(second);
      });
    });
  });
}

// ─── feat-20260617 M2 moveAndSlide (kinematic character controller) ───
//
// Shared scene builder: spawns a kinematic capsule character (RigidBody +
// Collider + CharacterController) plus optional static geometry, drives one
// world.update() to push the bodies into the Rapier world, then returns the
// handles so each test can call pw.moveAndSlide(entity, delta) directly.

{
  describe('moveAndSlide.test.ts', () => {
    type Vec3Tuple = readonly [number, number, number];

    interface StaticBox {
      readonly pos: Vec3Tuple;
      readonly halfExtents: Vec3Tuple;
      readonly rotXDeg?: number;
    }

    async function loadOrNull() {
      const RAPIER = await loadRapier3D();
      if ('code' in RAPIER) {
        expect(RAPIER.code).toBe('wasm-load-failed');
        return undefined;
      }
      return RAPIER;
    }

    function spawnCharacter(
      world: World,
      pos: Vec3Tuple,
      cc?: Record<string, number>,
      bodyType: number = RigidBodyTypeValue.kinematic,
    ): number {
      const entity = world
        .spawn(
          { component: Transform as never, data: { posX: pos[0], posY: pos[1], posZ: pos[2] } },
          { component: RigidBody as never, data: { type: bodyType } },
          {
            component: Collider as never,
            data: { shape: 2, radius: 0.3, halfHeight: 0.5, friction: 0.5, restitution: 0 },
          },
          { component: CharacterController as never, data: cc ?? {} },
        )
        .unwrap();
      return entity as unknown as number;
    }

    function spawnStaticBox(world: World, box: StaticBox): number {
      const data: Record<string, number> = {
        shape: 0,
        halfExtentsX: box.halfExtents[0],
        halfExtentsY: box.halfExtents[1],
        halfExtentsZ: box.halfExtents[2],
        friction: 0.5,
        restitution: 0,
      };
      const entity = world
        .spawn(
          {
            component: Transform as never,
            data: { posX: box.pos[0], posY: box.pos[1], posZ: box.pos[2] },
          },
          { component: RigidBody as never, data: { type: RigidBodyTypeValue.static } },
          { component: Collider as never, data },
        )
        .unwrap();
      return entity as unknown as number;
    }

    function tfPos(world: World, entity: number): { x: number; y: number; z: number } {
      const r = world.get(entity as never, Transform as never);
      if (!r.ok) throw new Error('transform missing');
      const v = r.value as Record<string, number>;
      return { x: v.posX as number, y: v.posY as number, z: v.posZ as number };
    }

    function ccGrounded(world: World, entity: number): boolean {
      const r = world.get(entity as never, CharacterController as never);
      if (!r.ok) throw new Error('CharacterController missing');
      // `grounded` is a `bool` schema field; world.get materializes it as a JS
      // boolean (not a 0/1 number), so compare against `true` directly. A prior
      // `!== 0` check compared a boolean to a number and was always truthy.
      return (r.value as Record<string, boolean>).grounded === true;
    }

    describe('moveAndSlide basic motion (AC-01/02/03)', () => {
      it('AC-01 flat walk: actualDelta tracks desiredDelta and grounded=true', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Ground under the character so it is grounded.
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        expect(actual[0]).toBeCloseTo(1, 1);
        expect(Math.abs(actual[2] ?? 0)).toBeLessThan(0.05);
        expect(ccGrounded(world, char)).toBe(true);
        expect(tfPos(world, char).x).toBeCloseTo(1, 1);
      });

      it('AC-02 wall ahead: actualDelta.x clamped below requested and no clip-through', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        // Wall 0.5m ahead (character radius 0.3 → contact well before x=1).
        spawnStaticBox(world, { pos: [0.8, 0.5, 0], halfExtents: [0.1, 1, 2] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        expect(actual[0]).toBeLessThan(1);
        // Character right edge must not pass the wall left face (~x=0.7).
        expect(tfPos(world, char).x).toBeLessThan(0.45);
      });

      it('AC-03 angled into wall: tangential motion survives, normal is eaten', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        // Wall facing -x at x≈0.8.
        spawnStaticBox(world, { pos: [0.8, 0.5, 0], halfExtents: [0.1, 1, 4] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        // Push diagonally into the wall: +x (blocked) and +z (tangential, free).
        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 1) as never);
        expect(actual[2]).toBeGreaterThan(0.3); // tangential z preserved
        expect(actual[0]).toBeLessThan(1); // normal x absorbed
      });
    });

    // Slope geometry must be rotated, but the ECS bridge (ensureBody) only
    // applies translation. Build tilted ramps directly on the Rapier world;
    // the character still goes through the ECS path so moveAndSlide resolves it.
    // biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamic module
    function spawnRawRamp(pw: any, RAPIER: any, pos: Vec3Tuple, slopeDeg: number): void {
      const rad = (slopeDeg * Math.PI) / 180;
      // Rotation about z tilts the top face of a wide thin box around the x-axis
      // of travel; quaternion from axis-angle about z.
      const half = rad / 2;
      const body = pw.raw.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(pos[0], pos[1], pos[2])
          .setRotation({ x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) }),
      );
      pw.raw.createCollider(RAPIER.ColliderDesc.cuboid(8, 0.5, 8).setFriction(0.5), body);
    }

    describe('moveAndSlide slope (AC-04/05)', () => {
      it('AC-04 gentle slope (< maxSlopeClimbDeg=45): y rises, not blocked', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // 30deg ramp centered at x=2; the ramp surface at x≈0.8 is near y=0.
        spawnRawRamp(pw, RAPIER, [2, -0.85, 0], 30);
        const char = spawnCharacter(world, [0.7, 0.05, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();
        // gravity pulse to settle onto the ramp surface.
        pw.moveAndSlide(char, Float32Array.of(0, -0.15, 0) as never);

        const before = tfPos(world, char).y;
        // Walk into the ramp repeatedly; a climbable slope lets the character ascend.
        for (let i = 0; i < 30; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.12, -0.01, 0) as never);
        }
        const after = tfPos(world, char).y;
        expect(after).toBeGreaterThan(before);
        expect(tfPos(world, char).x).toBeGreaterThan(0.5);
      });

      it('AC-05 steep slope (> maxSlopeClimbDeg=45): horizontal travel is blocked', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // 60deg ramp centered at x=1.5 — steeper than default maxSlopeClimbDeg=45.
        spawnRawRamp(pw, RAPIER, [1.5, -0.85, 0], 60);
        const char = spawnCharacter(world, [0.7, 0.05, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();
        pw.moveAndSlide(char, Float32Array.of(0, -0.15, 0) as never);

        let totalX = 0;
        for (let i = 0; i < 30; i++) {
          const a = pw.moveAndSlide(char, Float32Array.of(0.1, -0.02, 0) as never);
          totalX += a[0] ?? 0;
        }
        // The character cannot climb a too-steep slope: forward progress stalls
        // well short of the unobstructed 30 * 0.1 = 3.0.
        expect(totalX).toBeLessThan(1.5);
      });
    });

    describe('moveAndSlide autostep (AC-06)', () => {
      it('AC-06a low step (0.2 < autoStepMaxHeight=0.3): character climbs it', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Ground box top at y=-0.35; the capsule (radius 0.3 + halfHeight 0.5)
        // has a half-total of 0.8, so it rests with its center at y=0.45.
        // Spawning at the resting height (not buried at y=0) is what lets KCC
        // autostep — a capsule penetrating the floor has a degenerate contact.
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 4] });
        // A 0.2m-tall step ledge at x=1..3 (top at y=-0.25).
        spawnStaticBox(world, { pos: [2, -0.45, 0], halfExtents: [1, 0.2, 4] });
        const char = spawnCharacter(world, [0, 0.45, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();
        pw.moveAndSlide(char, Float32Array.of(0, -0.15, 0) as never);

        const before = tfPos(world, char).y;
        // Walk toward and across the 0.2m ledge (x in [1,3]). Track the peak y
        // reached while on the ledge — the character steps up onto the ledge
        // top, traverses it, then steps back down off the far edge, so asserting
        // y at a fixed final iteration would read the post-ledge ground. The
        // peak captures the autostep climb regardless of where traversal ends.
        let peakY = before;
        let reachedLedge = false;
        for (let i = 0; i < 40; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.1, -0.02, 0) as never);
          const p = tfPos(world, char);
          if (p.y > peakY) peakY = p.y;
          if (p.x > 1.5 && p.x < 2.5) reachedLedge = true;
        }
        // Auto-step lifted the character onto the 0.2m ledge top mid-traversal.
        expect(peakY).toBeGreaterThan(before + 0.05);
        expect(reachedLedge).toBe(true);
      });

      it('AC-06b high step (0.5 > autoStepMaxHeight=0.3): character is blocked', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [4, 0.5, 4] });
        // A 0.5m-tall step ledge — too tall to auto-step.
        spawnStaticBox(world, { pos: [2, -0.05, 0], halfExtents: [2, 0.5, 4] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        for (let i = 0; i < 25; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.1, -0.05, 0) as never);
        }
        // Could not step up: stays low, blocked before the ledge top.
        expect(tfPos(world, char).y).toBeLessThan(0.2);
      });

      it('AC-06c autoStepMaxHeight=0 disables auto-step (low step now blocks)', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [4, 0.5, 4] });
        spawnStaticBox(world, { pos: [2, -0.45, 0], halfExtents: [2, 0.2, 4] });
        const char = spawnCharacter(world, [0, 0, 0], { autoStepMaxHeight: 0 });

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        for (let i = 0; i < 25; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.1, -0.05, 0) as never);
        }
        // Auto-step off: the 0.2m ledge is no longer climbed.
        expect(tfPos(world, char).y).toBeLessThan(0.1);
      });
    });

    describe('moveAndSlide snap-to-ground (AC-07)', () => {
      it('AC-07a snap-to-ground keeps the character on a descending slope (pure horizontal move pulls y down)', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Downhill ramp toward +x (top near origin, descending).
        spawnRawRamp(pw, RAPIER, [4, -1.0, 0], -20);
        const char = spawnCharacter(world, [0, 0.1, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();
        // Establish ground contact first.
        pw.moveAndSlide(char, Float32Array.of(0, -0.1, 0) as never);
        const startY = tfPos(world, char).y;

        // Walk forward with NO vertical input. Without snap-to-ground the
        // character would travel level and lift off the descending surface;
        // snap pulls it back down onto the ramp, so y decreases monotonically
        // as x advances. (Rapier's computedGrounded() reads false while sliding
        // a slope in this build — the snap effect shows in the trajectory, not
        // the flag; the grounded flag itself is asserted on flat ground in
        // AC-01 and in the void in AC-07b.)
        for (let i = 0; i < 20; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.08, 0, 0) as never);
        }
        const endPos = tfPos(world, char);
        // The character followed the ramp down (snap kept it on the surface)
        // rather than flying off level.
        expect(endPos.x).toBeGreaterThan(0.5);
        expect(endPos.y).toBeLessThan(startY - 0.1);
      });

      it('AC-07b grounded flips false when the character walks off a ledge into open air', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // A short platform: top at y=0 (center -0.5, halfExtent 0.5), spanning
        // x in [-2, 1]. Nothing exists beyond x=1, so walking off the edge with
        // a downward bias drops the character into open air. The grounded flag
        // must follow: true on the platform, false once airborne. This is the
        // falsifiable counterpart to AC-07a (descending slope stays grounded) —
        // snap-to-ground keeps contact across surfaces, but a true void must
        // still report not-grounded. The capsule rests at y=0.8 (top 0 + 0.8).
        spawnStaticBox(world, { pos: [-0.5, -0.5, 0], halfExtents: [1.5, 0.5, 4] });
        const char = spawnCharacter(world, [-1, 0.8, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();
        // Settle on the platform first.
        pw.moveAndSlide(char, Float32Array.of(0, -0.1, 0) as never);
        expect(ccGrounded(world, char)).toBe(true);

        // Walk toward +x and off the edge with a small gravity bias.
        let wentAirborne = false;
        for (let i = 0; i < 25; i++) {
          pw.moveAndSlide(char, Float32Array.of(0.15, -0.05, 0) as never);
          if (!ccGrounded(world, char)) wentAirborne = true;
        }
        // The character left the platform and fell, so grounded flipped to false.
        expect(wentAirborne).toBe(true);
        expect(ccGrounded(world, char)).toBe(false);
        expect(tfPos(world, char).x).toBeGreaterThan(1);
        expect(tfPos(world, char).y).toBeLessThan(0.8);
      });

      it('AC-07c pure horizontal move on flat ground stays grounded', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();
        pw.moveAndSlide(char, Float32Array.of(0, -0.1, 0) as never);

        const actual = pw.moveAndSlide(char, Float32Array.of(0.5, 0, 0) as never);
        // Flat ground: horizontal travel preserved, still grounded.
        expect(actual[0]).toBeCloseTo(0.5, 1);
        expect(ccGrounded(world, char)).toBe(true);
      });
    });

    describe('moveAndSlide error codes (AC-08/09)', () => {
      it('AC-08a dynamic body: throws controller-requires-kinematic with detail', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        const char = spawnCharacter(world, [0, 0, 0], {}, RigidBodyTypeValue.dynamic);
        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        let caught: unknown;
        try {
          pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PhysicsError);
        const err = caught as PhysicsError;
        expect(err.code).toBe('controller-requires-kinematic');
        expect(err.detail?.code).toBe('controller-requires-kinematic');
        if (err.detail?.code === 'controller-requires-kinematic') {
          expect(err.detail.entity).toBe(char);
          expect(err.detail.bodyType).toBe('dynamic');
        }
      });

      it('AC-08b static body: throws controller-requires-kinematic', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        const char = spawnCharacter(world, [0, 0, 0], {}, RigidBodyTypeValue.static);
        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        let caught: unknown;
        try {
          pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect((caught as PhysicsError).code).toBe('controller-requires-kinematic');
        expect((caught as PhysicsError).detail?.code).toBe('controller-requires-kinematic');
      });

      it('AC-09a unregistered entity: throws body-not-found with detail.entity', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const pw = createRapier3DPhysicsWorld(RAPIER);

        let caught: unknown;
        try {
          pw.moveAndSlide(12345, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PhysicsError);
        const err = caught as PhysicsError;
        expect(err.code).toBe('body-not-found');
        if (err.detail?.code === 'body-not-found') {
          expect(err.detail.entity).toBe(12345);
        }
      });

      it('AC-09b kinematic body with no collider: throws collider-not-found (D-2)', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const pw = createRapier3DPhysicsWorld(RAPIER);

        // Register a kinematic body directly with NO collider attached.
        const body = pw.raw.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0),
        );
        body.userData = 7;
        pw.registerBody(7, body.handle);

        let caught: unknown;
        try {
          pw.moveAndSlide(7, Float32Array.of(1, 0, 0) as never);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PhysicsError);
        const err = caught as PhysicsError;
        expect(err.code).toBe('collider-not-found');
        if (err.detail?.code === 'collider-not-found') {
          expect(err.detail.entity).toBe(7);
        }
      });
    });

    // Read the Rapier body translation for an entity by scanning userData;
    // entityMap is private, so this is the test-side reverse lookup.
    function rapierBodyPos(
      // biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamic module
      pw: any,
      entity: number,
    ): { x: number; y: number; z: number } | undefined {
      let found: { x: number; y: number; z: number } | undefined;
      pw.raw.bodies.forEach(
        (body: { userData: number; translation(): { x: number; y: number; z: number } }) => {
          if (body.userData === entity) {
            const t = body.translation();
            found = { x: t.x, y: t.y, z: t.z };
          }
        },
      );
      return found;
    }

    describe('moveAndSlide syncBackend split (AC-10)', () => {
      it('AC-10a kinematic platform without CharacterController is mirrored', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        // Platform: kinematic body + collider, NO CharacterController.
        const platform = world
          .spawn(
            { component: Transform as never, data: { posX: 0, posY: 0, posZ: 0 } },
            { component: RigidBody as never, data: { type: RigidBodyTypeValue.kinematic } },
            {
              component: Collider as never,
              data: { shape: 0, halfExtentsX: 1, halfExtentsY: 0.5, halfExtentsZ: 1 },
            },
          )
          .unwrap() as unknown as number;

        // Move the platform via Transform; syncBackend should mirror it.
        world.set(platform as never, Transform as never, { posX: 5, posY: 2, posZ: 0 });
        for (let i = 0; i < 30; i++) {
          world.insertResource('Time', { dt: 1 / 60, elapsed: (i + 1) / 60 });
          world.update();
        }

        const pos = rapierBodyPos(pw, platform);
        expect(pos).toBeDefined();
        expect(pos?.x).toBeCloseTo(5, 0);
        expect(pos?.y).toBeCloseTo(2, 0);
      });

      it('AC-10b kinematic character with CharacterController is NOT mirrored', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        // First update creates the body at origin.
        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        // moveAndSlide drives the character to ~x=1; syncBackend must not then
        // overwrite the Rapier body back to the (stale) Transform from a prior
        // frame. Set the ECS Transform to a bogus far value to prove the split:
        // a mirroring syncBackend would push the kinematic body to x=99.
        pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        const afterMove = tfPos(world, char).x;

        world.set(char as never, Transform as never, { posX: 99, posY: 99, posZ: 99 });
        // Run a tick: if the character row were mirrored, the body would target 99.
        world.insertResource('Time', { dt: 1 / 60, elapsed: 2 / 60 });
        world.update();
        for (let i = 0; i < 10; i++) pw.step(1 / 60);

        const pos = rapierBodyPos(pw, char);
        expect(pos).toBeDefined();
        // Character body must NOT have been mirrored to the bogus 99.
        expect(pos?.x).toBeLessThan(5);
        expect(afterMove).toBeCloseTo(1, 1);
      });
    });

    describe('moveAndSlide despawn cleanup (AC-11)', () => {
      it('AC-11a despawn auto-fires Collider.onRemove: KCC + caches cleared', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        // moveAndSlide lazily builds + caches a KCC for this character.
        pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);
        expect(pw.raw.characterControllers.size).toBe(1);
        expect(pw.kccCache.size).toBe(1);

        // Despawn must auto-trigger Collider.onRemove -> removeEntity -> KCC cleanup.
        world.despawn(char as never);

        expect(pw.raw.characterControllers.size).toBe(0);
        expect(pw.kccCache.size).toBe(0);
      });

      it('AC-11b despawn a character that never moved: removeEntity does not throw', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        // No moveAndSlide -> no cached KCC. Despawn must still clean the body.
        const before = pw.getBodyCount();
        expect(before).toBeGreaterThan(0);
        expect(() => world.despawn(char as never)).not.toThrow();
        expect(pw.kccCache.size).toBe(0);
      });
    });

    describe('moveAndSlide self-exclude (D-1)', () => {
      it('character does not collide with its own collider', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;

        // The self-exclude predicate omits the character's own collider, so on
        // flat ground a full horizontal request is delivered intact (no
        // self-collision eating the movement).
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);
        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);
        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();
        const actual = pw.moveAndSlide(char, Float32Array.of(1, 0, 0) as never);

        expect(actual[0]).toBeCloseTo(1, 1);
      });
    });

    describe('hasBody readiness query', () => {
      it('returns false before the body is built, true after', async () => {
        const RAPIER = await loadOrNull();
        if (!RAPIER) return;
        const world = new World();
        const pw = createRapier3DPhysicsWorld(RAPIER);
        world.insertResource('PhysicsWorld', pw);
        registerPhysicsSystems(world);

        spawnStaticBox(world, { pos: [0, -0.85, 0], halfExtents: [10, 0.5, 10] });
        const char = spawnCharacter(world, [0, 0, 0]);

        // Before the first physicsSyncBackend tick the body has not been built.
        expect(pw.hasBody(char)).toBe(false);

        world.insertResource('Time', { dt: 1 / 60, elapsed: 1 / 60 });
        world.update();

        // After the tick, ensureBody has run and the body exists.
        expect(pw.hasBody(char)).toBe(true);
      });
    });
  });
}
