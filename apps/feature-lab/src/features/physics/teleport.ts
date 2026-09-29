import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

export default defineFeature({
  title: 'Teleport',
  catalog: 'Teleport',
  kind: 'headless',
  summary:
    'PhysicsWorld.teleport(entity, position) queues an instant move for the next sync phase and zeroes velocity, unlike writing Transform on a dynamic body, which the solver would treat as motion.',
  expect:
    'All checks pass: the teleport is not visible until the next fixed step, the body then sits at the target, and it starts falling again from rest (no inherited downward velocity).',
  async run(checks) {
    const harness = await createPhysicsHarness3D();
    if (typeof harness === 'string') {
      checks.ok('Rapier 3D loads', false, harness);
      return;
    }
    const body = harness.spawn(
      { component: Transform, data: { pos: [0, 50, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
      { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.5 } },
    );
    harness.tick(60);
    const beforeY = harness.pos(body)[1];
    checks.ok('body was falling fast before teleport', beforeY < 47, `y=${beforeY}`);
    harness.physics.teleport(body, vec3(3, 20, 0));
    checks.near(
      'teleport is queued, Transform unchanged until sync',
      harness.pos(body)[1],
      beforeY,
      1e-5,
    );
    harness.tick(1);
    const [x, y] = harness.pos(body);
    checks.near('x moved to the target', x, 3, 0.01);
    checks.ok(
      'y is at the target (from rest, one step of gravity)',
      Math.abs(y - 20) < 0.02,
      `y=${y}`,
    );
    harness.tick(10);
    const drop = 20 - harness.pos(body)[1];
    checks.ok(
      'fall after teleport starts from zero velocity',
      drop > 0 && drop < 1.5,
      `drop=${drop} (from rest about 0.67; with inherited velocity it would exceed 6)`,
    );
    harness.dispose();
  },
});
