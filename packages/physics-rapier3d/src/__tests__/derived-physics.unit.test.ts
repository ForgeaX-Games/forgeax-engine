import { vec3 } from '@forgeax/engine-math';
import type { DerivedPhysicsCandidateInput } from '@forgeax/engine-physics';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader';

function voxelCandidate(entity: number, revision: number, worldIdentity?: object) {
  return {
    entity,
    revision,
    sourceKey: `body:${entity}`,
    ...(worldIdentity === undefined ? {} : { worldIdentity }),
    shapes: [
      {
        id: 'left',
        revision,
        cells: new Int32Array([0, 0, 0, -1, 0, 0]),
        voxelSize: [1, 1, 1] as const,
        origin: [0, 0, 0] as const,
      },
      {
        id: 'right',
        revision,
        cells: [[0, 0, 0]] as const,
        voxelSize: [1, 1, 1] as const,
        origin: [2, 0, 0] as const,
      },
    ],
    seams: [{ shapeA: 'left', shapeB: 'right', offset: [2, 0, 0] as const }],
    bodyType: 'dynamic' as const,
    massProperties: {
      mode: 'explicit' as const,
      mass: 2,
      centerOfMass: [0.25, 0, 0] as const,
      principalInertia: [1, 1, 1] as const,
    },
    velocityPolicy: 'preserve' as const,
    constraints: [],
  };
}

function addBody(
  pw: ReturnType<typeof createRapier3DPhysicsWorld>,
  entity: number,
  position: [number, number, number],
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
) {
  pw.ensureBody(
    entity,
    {
      position: { x: position[0], y: position[1], z: position[2] },
      rotation: { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
      scale: { x: 1, y: 1, z: 1 },
    },
    {
      type: 1,
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 0,
      ccdEnabled: 0,
    },
    {
      shape: 0,
      halfExtents: [0.25, 0.25, 0.25],
      radius: 0.25,
      halfHeight: 0.25,
      friction: 0.5,
      restitution: 0,
      density: 1,
      isSensor: 0,
      collisionGroups: 0xffffffff,
      solverGroups: 0xffffffff,
    },
  );
}

/** Public-module fixture: inject a failure only after native mass mutation. */
function rapierWithMassFailure(RAPIER: Rapier3DModule): Rapier3DModule {
  const OriginalWorld = RAPIER.World;
  function FaultWorld(gravity: unknown) {
    const world = new OriginalWorld(gravity);
    const createRigidBody = world.createRigidBody.bind(world);
    world.createRigidBody = (descriptor: unknown) => {
      const body = createRigidBody(descriptor);
      const setAdditionalMassProperties = body.setAdditionalMassProperties.bind(body);
      let inject = true;
      body.setAdditionalMassProperties = (...args: unknown[]) => {
        setAdditionalMassProperties(...args);
        if (inject) {
          inject = false;
          throw new Error('injected failure after native mass mutation');
        }
      };
      return body;
    };
    return world;
  }
  return { ...RAPIER, World: FaultWorld };
}

describe('Rapier 3D derived voxel candidates', () => {
  it('publishes 33 distinct bodies while retaining a 32-candidate staging bound', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      for (let entity = 1; entity <= 33; entity += 1) {
        addBody(pw, entity, [entity * 4, 0, 0]);
        const candidate = pw.prepareDerivedShapeCandidate(voxelCandidate(entity, 1)).unwrap();
        pw.admitDerivedShapeCandidate(candidate).unwrap();
        pw.step(1 / 60);
        expect(pw.getDerivedPublication(entity)?.candidateId).toBe(candidate.candidateId);
      }
      expect(pw.captureDerivedPhysicsState().bodies).toHaveLength(33);
      const pending = Array.from({ length: 32 }, (_, index) =>
        pw.prepareDerivedShapeCandidate(voxelCandidate(index + 1, 2)).unwrap(),
      );
      expect(pw.prepareDerivedShapeCandidate(voxelCandidate(33, 2))).toMatchObject({
        ok: false,
        error: { code: 'derived-candidate-budget-exceeded', detail: { reason: 'in-flight' } },
      });
      const first = pending[0];
      if (!first) throw new Error('expected a pending candidate');
      pw.cancelDerivedShapeCandidate(first).unwrap();
      const reopened = pw.prepareDerivedShapeCandidate(voxelCandidate(33, 2));
      expect(reopened.ok).toBe(true);
      if (reopened.ok) pw.cancelDerivedShapeCandidate(reopened.value).unwrap();
      for (const candidate of pending.slice(1)) pw.cancelDerivedShapeCandidate(candidate).unwrap();
    } finally {
      pw.dispose();
    }
  });
  it('applies a revision-bound world impulse at a point without teleporting the derived body', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [0, 0, 0]);
      pw.admitDerivedShapeCandidate(
        pw.prepareDerivedShapeCandidate(voxelCandidate(7, 1)).unwrap(),
      ).unwrap();
      pw.step(1 / 60);
      const before = pw.getDerivedMotion(7);
      if (before === undefined) throw new Error('missing committed motion');
      const input = {
        entity: 7,
        sourceKey: 'body:7',
        revision: 1,
        impulse: [0, 2, 0] as const,
        point: [
          before.centerOfMass[0] + 1,
          before.centerOfMass[1],
          before.centerOfMass[2],
        ] as const,
      };
      pw.applyDerivedImpulse(input).unwrap();
      const after = pw.getDerivedMotion(7);
      if (after === undefined) throw new Error('missing impulse motion');
      expect(after.centerOfMass).toEqual(before.centerOfMass);
      expect(after.linearVelocity[1] - before.linearVelocity[1]).toBeCloseTo(1, 5);
      expect(after.angularVelocity[2] - before.angularVelocity[2]).toBeCloseTo(2, 5);
      expect(pw.applyDerivedImpulse({ ...input, revision: 0 }).ok).toBe(false);
      expect(pw.applyDerivedImpulse({ ...input, sourceKey: 'another-owner' }).ok).toBe(false);
      expect(pw.applyDerivedImpulse({ ...input, impulse: [0, Number.NaN, 0] }).ok).toBe(false);
      expect(pw.getDerivedMotion(7)).toEqual(after);
      const queued = pw.prepareDerivedShapeCandidate(voxelCandidate(7, 2)).unwrap();
      pw.admitDerivedShapeCandidate(queued).unwrap();
      expect(pw.applyDerivedImpulse(input).ok).toBe(false);
      pw.cancelDerivedShapeCandidate(queued).unwrap();
      expect(pw.applyDerivedImpulse(input).ok).toBe(true);
      const moving = pw.getDerivedMotion(7);
      if (moving === undefined) throw new Error('missing moving body');
      pw.step(1 / 120);
      const advanced = pw.getDerivedMotion(7);
      if (advanced === undefined) throw new Error('missing stepped motion');
      expect(advanced.centerOfMass[1] - moving.centerOfMass[1]).toBeCloseTo(
        moving.linearVelocity[1] / 120,
        5,
      );
    } finally {
      pw.dispose();
    }
  });

  it('requires recovery after a native impulse mutates and then throws', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const OriginalWorld = RAPIER.World;
    function FaultWorld(gravity: unknown) {
      const world = new OriginalWorld(gravity);
      const create = world.createRigidBody.bind(world);
      world.createRigidBody = (descriptor: unknown) => {
        const body = create(descriptor);
        const apply = body.applyImpulseAtPoint.bind(body);
        body.applyImpulseAtPoint = (...args: unknown[]) => {
          apply(...args);
          throw new Error('partial native impulse');
        };
        return body;
      };
      return world;
    }
    const pw = createRapier3DPhysicsWorld({ ...RAPIER, World: FaultWorld });
    try {
      addBody(pw, 7, [0, 0, 0]);
      pw.admitDerivedShapeCandidate(
        pw.prepareDerivedShapeCandidate(voxelCandidate(7, 1)).unwrap(),
      ).unwrap();
      pw.step(1 / 60);
      expect(
        pw.applyDerivedImpulse({
          entity: 7,
          sourceKey: 'body:7',
          revision: 1,
          impulse: [1, 0, 0],
          point: [0, 0, 0],
        }).ok,
      ).toBe(false);
      expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
      expect(pw.getDerivedMotion(7)).toBeUndefined();
      expect(() => pw.raycast(vec3.create(0, 0, 5), vec3.create(0, 0, -1), 10)).toThrow();
    } finally {
      pw.dispose();
    }
  });

  it('clears one derived shape set in the same group that replaces its successor', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      for (const entity of [7, 8]) {
        addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
        pw.admitDerivedShapeCandidate(
          pw.prepareDerivedShapeCandidate(voxelCandidate(entity, 1)).unwrap(),
        ).unwrap();
      }
      pw.step(1 / 60);
      const ray = () => pw.raycast(vec3.create(-0.5, 0.5, 3), vec3.create(0, 0, -1), 5);
      expect(ray()?.entity).toBe(7);
      const removed = pw
        .prepareDerivedShapeCandidate({ entity: 7, revision: 2, sourceKey: 'body:7', shapes: [] })
        .unwrap();
      const successor = pw.prepareDerivedShapeCandidate(voxelCandidate(8, 2)).unwrap();
      pw.admitDerivedShapeCandidates([removed, successor]).unwrap();
      expect(ray()?.entity).toBe(7);
      pw.step(1 / 60);
      expect(ray()).toBeUndefined();
      expect(pw.getDerivedPublication(7)).toMatchObject({ revision: 2, shapeIds: [] });
      expect(pw.getDerivedPublication(8)?.revision).toBe(2);
      expect(pw.hasBody(7)).toBe(true); // ECS still owns body removal.
    } finally {
      pw.dispose();
    }
  });

  it.each([
    'cancel',
    'despawn',
  ] as const)('releases the whole queued group after one member %s', async (action) => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      for (const entity of [7, 8]) addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
      const candidates = [7, 8].map((entity) =>
        pw.prepareDerivedShapeCandidate(voxelCandidate(entity, 1)).unwrap(),
      );
      pw.admitDerivedShapeCandidates(candidates).unwrap();
      const first = candidates[0];
      if (first === undefined) throw new Error('missing first fixture candidate');
      if (action === 'cancel') pw.cancelDerivedShapeCandidate(first).unwrap();
      else pw.removeEntity(7);
      pw.step(1 / 60);
      expect(pw.getDerivedPublication(8)).toBeUndefined();
      // A stranded member would retain the per-body pending lock here.
      const retry = pw.prepareDerivedShapeCandidate(voxelCandidate(8, 2)).unwrap();
      pw.admitDerivedShapeCandidate(retry).unwrap();
      pw.step(1 / 60);
      expect(pw.getDerivedPublication(8)?.revision).toBe(2);
    } finally {
      pw.dispose();
    }
  });

  it.each([
    'refuse',
    'throw',
  ] as const)('treats a batch geometry %s as a group-wide outcome', async (action) => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      for (const entity of [7, 8]) {
        addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
        pw.admitDerivedShapeCandidate(
          pw.prepareDerivedShapeCandidate(voxelCandidate(entity, 1)).unwrap(),
        ).unwrap();
      }
      pw.step(1 / 60);
      const candidates = [7, 8].map((entity) =>
        pw.prepareDerivedShapeCandidate(voxelCandidate(entity, 2)).unwrap(),
      );
      pw.admitDerivedShapeCandidates(candidates, () => {
        if (action === 'throw') throw new Error('uncertain consumer write');
        return err(new Error('consumer refused without writes'));
      }).unwrap();
      pw.step(1 / 60);
      for (const entity of [7, 8]) {
        expect(pw.getDerivedFailure(entity)?.recovery).toBe(
          action === 'throw' ? 'rebuild-required' : 'old-state-retained',
        );
        expect(pw.getDerivedPublication(entity)?.revision).toBe(action === 'throw' ? undefined : 1);
      }
      expect(pw.getDerivedRecoveryState()).toBe(action === 'throw' ? 'rebuild-required' : 'ready');
    } finally {
      pw.dispose();
    }
  });

  it('publishes two derived bodies under one paired admission and fixed-step receipt', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [0, 0, 0]);
      addBody(pw, 8, [10, 0, 0]);
      const candidates = [7, 8].map((entity) =>
        pw
          .prepareDerivedShapeCandidate({
            ...voxelCandidate(entity, 1),
            constraints: [
              {
                id: `coupled:${entity}`,
                revision: 1,
                kind: 'spring',
                bodyA: 7,
                bodyB: 8,
                bodyASource: { sourceKey: 'body:7', revision: 1 },
                bodyBSource: { sourceKey: 'body:8', revision: 1 },
                anchorA: [0, 0, 0],
                anchorB: [0, 0, 0],
                restLength: 10,
                stiffness: 2,
                damping: 1,
              },
            ],
          })
          .unwrap(),
      );
      let commits = 0;
      pw.admitDerivedShapeCandidates(candidates, () => {
        commits += 1;
        expect(pw.getDerivedAdmission(7)).toMatchObject({ entity: 7, revision: 1, fixedStep: 1 });
        expect(pw.getDerivedAdmission(8)).toMatchObject({ entity: 8, revision: 1, fixedStep: 1 });
        return ok(undefined);
      }).unwrap();
      expect(pw.getDerivedPublication(7)).toBeUndefined();
      expect(pw.getDerivedPublication(8)).toBeUndefined();
      pw.step(1 / 60);
      expect(commits).toBe(1);
      expect(pw.getDerivedPublication(7)).toMatchObject({ revision: 1, fixedStep: 1 });
      expect(pw.getDerivedPublication(8)).toMatchObject({ revision: 1, fixedStep: 1 });
      expect(pw.getDerivedAdmission(7)).toBeUndefined();
      const snapshot = pw.captureDerivedPhysicsState();
      const fresh = createRapier3DPhysicsWorld(RAPIER);
      try {
        fresh.setGravity(vec3.create(0, 0, 0));
        addBody(fresh, 7, [0, 0, 0]);
        addBody(fresh, 8, [10, 0, 0]);
        fresh.restoreDerivedPhysicsState(snapshot).unwrap();
        fresh.step(1 / 60);
        expect(fresh.getDerivedPublication(7)?.revision).toBe(1);
        expect(fresh.getDerivedPublication(8)?.revision).toBe(1);
        const restored = fresh
          .captureDerivedPhysicsState()
          .bodies.flatMap((body) => body.constraints);
        expect([...new Set(restored.map((joint) => joint.id))].sort()).toEqual([
          'coupled:7',
          'coupled:8',
        ]);
      } finally {
        fresh.dispose();
      }
    } finally {
      pw.dispose();
    }
  });

  it('rolls back the entire group when the second native mass mutation fails', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const OriginalWorld = RAPIER.World;
    let failSecond = false;
    function FaultWorld(gravity: unknown) {
      const world = new OriginalWorld(gravity);
      const create = world.createRigidBody.bind(world);
      world.createRigidBody = (descriptor: unknown) => {
        const body = create(descriptor);
        const setMass = body.setAdditionalMassProperties.bind(body);
        body.setAdditionalMassProperties = (...args: unknown[]) => {
          setMass(...args);
          if (failSecond && args[0] === 13) {
            failSecond = false;
            throw new Error('second body failed after mass mutation');
          }
        };
        return body;
      };
      return world;
    }
    const pw = createRapier3DPhysicsWorld({ ...RAPIER, World: FaultWorld });
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      for (const entity of [7, 8]) {
        addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
        pw.admitDerivedShapeCandidate(
          pw.prepareDerivedShapeCandidate(voxelCandidate(entity, 1)).unwrap(),
        ).unwrap();
      }
      pw.step(1 / 60);
      const before = [7, 8].map((entity) => ({
        publication: pw.getDerivedPublication(entity),
        motion: pw.getDerivedMotion(entity),
      }));
      const joint = {
        id: 'batch-shared-joint',
        revision: 1,
        kind: 'spring' as const,
        bodyA: 7,
        bodyB: 8,
        bodyASource: { sourceKey: 'body:7', revision: 1 },
        bodyBSource: { sourceKey: 'body:8', revision: 1 },
        anchorA: [0, 0, 0] as const,
        anchorB: [0, 0, 0] as const,
        restLength: 10,
        stiffness: 2,
        damping: 1,
      };
      pw.createDerivedConstraint(joint).unwrap();
      const oldRay = () => pw.raycast(vec3.create(-0.5, 0.5, 3), vec3.create(0, 0, -1), 5);
      const newRay = () => pw.raycast(vec3.create(4.5, 0.5, 3), vec3.create(0, 0, -1), 5);
      expect(oldRay()?.entity).toBe(7);
      expect(newRay()).toBeUndefined();
      const candidates = [7, 8].map((entity) => {
        const input = voxelCandidate(entity, 2);
        return pw
          .prepareDerivedShapeCandidate({
            ...input,
            shapes: [{ id: 'replacement', revision: 2, cells: [[4, 0, 0]], voxelSize: [1, 1, 1] }],
            seams: [],
            constraints:
              entity === 7
                ? [
                    {
                      ...joint,
                      revision: 2,
                      bodyASource: { sourceKey: 'body:7', revision: 2 },
                      bodyBSource: { sourceKey: 'body:8', revision: 2 },
                    },
                  ]
                : [],
            massProperties: { ...input.massProperties, mass: entity === 7 ? 5 : 13 },
          })
          .unwrap();
      });
      let commits = 0;
      failSecond = true;
      pw.admitDerivedShapeCandidates(candidates, () => {
        commits += 1;
        return ok(undefined);
      }).unwrap();
      pw.step(1 / 60);
      expect(commits).toBe(0);
      expect(oldRay()?.entity).toBe(7);
      expect(newRay()).toBeUndefined();
      expect(pw.captureDerivedPhysicsState().bodies.flatMap((body) => body.constraints)).toEqual([
        joint,
        joint,
      ]);
      for (let i = 0; i < 2; i++) {
        const entity = i + 7;
        expect(pw.getDerivedPublication(entity)).toEqual(before[i]?.publication);
        expect(pw.getDerivedMotion(entity)).toEqual(before[i]?.motion);
        expect(pw.getDerivedFailure(entity)).toMatchObject({
          candidateId: candidates[i]?.candidateId,
          recovery: 'old-state-retained',
        });
      }
      expect(pw.getDerivedRecoveryState()).toBe('ready');
    } finally {
      pw.dispose();
    }
  });

  it('restores a world COM using the newly admitted nonzero local mass center', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [10, 20, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
      pw.admitDerivedShapeCandidate(
        pw
          .prepareDerivedShapeCandidate({
            ...voxelCandidate(7, 1),
            massProperties: {
              mode: 'explicit',
              mass: 6,
              centerOfMass: [1.5, 0, 0.5],
              principalInertia: [1, 1, 1],
            },
            motion: {
              centerOfMass: [10, 21.5, 0.5],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          })
          .unwrap(),
      ).unwrap();
      pw.step(1 / 60);
      const motion = pw.getDerivedMotion(7);
      expect(motion?.centerOfMass[0]).toBeCloseTo(10, 5);
      expect(motion?.centerOfMass[1]).toBeCloseTo(21.5, 5);
      expect(motion?.centerOfMass[2]).toBeCloseTo(0.5, 5);
      expect(pw.getDerivedBodyMass(7)).toBeCloseTo(6, 5);
    } finally {
      pw.dispose();
    }
  });

  it('stops publication and queries if native step throws after the geometry commit', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(voxelCandidate(7, 1)).unwrap(),
    ).unwrap();
    pw.step(1 / 60);
    let geometryRevision = 1;
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(voxelCandidate(7, 2)).unwrap(),
      () => {
        geometryRevision = 2;
        return ok(undefined);
      },
    ).unwrap();
    const nativeStep = pw.raw.step.bind(pw.raw);
    pw.raw.step = (...args: unknown[]) => {
      nativeStep(...args);
      throw new Error('injected failure after native advancement');
    };
    expect(() => pw.step(1 / 60)).toThrow('derived-backend-failed');
    expect(geometryRevision).toBe(2);
    expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
    expect(pw.getDerivedFailure(7)?.recovery).toBe('rebuild-required');
    expect(pw.getDerivedPublication(7)).toBeUndefined();
    expect(pw.getDerivedShapes(7)).toEqual([]);
    expect(() => pw.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 10)).toThrow(
      'derived-recovery-invalid',
    );
    pw.raw.step = nativeStep;
    pw.dispose();
  });

  it('keeps staged and retired shapes out of automatic mass and restores a refused replacement', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    const automatic = (revision: number) => ({
      ...voxelCandidate(7, revision),
      massProperties: { mode: 'automatic' as const },
    });
    pw.admitDerivedShapeCandidate(pw.prepareDerivedShapeCandidate(automatic(1)).unwrap()).unwrap();
    pw.step(1 / 60);
    const mass = pw.getDerivedBodyMass(7);
    const pending = pw.prepareDerivedShapeCandidate(automatic(2)).unwrap();
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    pw.admitDerivedShapeCandidate(pending, () => err(new Error('binding refused'))).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedFailure(7)?.recovery).toBe('old-state-retained');
    expect(pw.getDerivedPublication(7)?.revision).toBe(1);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    const otherPending = pw.prepareDerivedShapeCandidate(automatic(3)).unwrap();
    pw.admitDerivedShapeCandidate(pw.prepareDerivedShapeCandidate(automatic(4)).unwrap()).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    pw.cancelDerivedShapeCandidate(otherPending).unwrap();
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    pw.dispose();
  });

  it('requires rebuild if a geometry callback throws after an unknown ECS write', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(voxelCandidate(7, 1)).unwrap(),
      () => {
        throw new Error('unknown failure after a possible geometry write');
      },
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedFailure(7)?.recovery).toBe('rebuild-required');
    expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
    expect(pw.getDerivedPublication(7)).toBeUndefined();
    expect(() => pw.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 10)).toThrow(
      'derived-recovery-invalid',
    );
    pw.dispose();
  });

  it('keeps the old physics publication when the paired geometry commit refuses', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(voxelCandidate(7, 1)).unwrap(),
    ).unwrap();
    pw.step(1 / 60);
    let commits = 0;
    const replacement = pw
      .prepareDerivedShapeCandidate({
        ...voxelCandidate(7, 2),
        massProperties: {
          mode: 'explicit',
          mass: 9,
          centerOfMass: [0, 0, 0],
          principalInertia: [1, 1, 1],
        },
      })
      .unwrap();
    pw.admitDerivedShapeCandidate(replacement, () => {
      commits += 1;
      expect(() => pw.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 10)).toThrow();
      return err(new Error('geometry admission refused'));
    }).unwrap();
    pw.step(1 / 60);
    expect(commits).toBe(1);
    expect(pw.getDerivedPublication(7)?.revision).toBe(1);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(2);
    expect(pw.getDerivedFailure(7)?.recovery).toBe('old-state-retained');
    expect(pw.getDerivedRecoveryState()).toBe('ready');
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(voxelCandidate(7, 3)).unwrap(),
      () => {
        expect(pw.getDerivedAdmission(7)).toMatchObject({ revision: 3, fixedStep: 3 });
        return ok(undefined);
      },
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(7)?.revision).toBe(3);
    expect(pw.getDerivedAdmission(7)).toBeUndefined();
    pw.dispose();
  });

  it('stages multiple native voxel shapes and publishes them after one fixed step', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    pw.setGravity(vec3.create(0, 0, 0));
    addBody(pw, 7, [0, 0, 0]);
    const prepared = pw.prepareDerivedShapeCandidate(voxelCandidate(7, 1));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(pw.getDerivedShapes(7)).toHaveLength(0);
    const admitted = pw.admitDerivedShapeCandidate(prepared.value);
    expect(admitted.ok).toBe(true);
    expect(pw.getDerivedPublication(7)).toBeUndefined();

    pw.step(1 / 60);

    expect(pw.getDerivedPublication(7)).toMatchObject({
      entity: 7,
      revision: 1,
      fixedStep: 1,
      shapeIds: ['left', 'right'],
    });
    expect(pw.getDerivedShapes(7).map((entry) => entry.id)).toEqual(['left', 'right']);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(2, 5);
  });

  it('retains a newly created colliderless body when its first paired admission is refused', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    pw.ensureBody(
      7,
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 1, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(1);
    const candidate = pw.prepareDerivedShapeCandidate(voxelCandidate(7, 1)).unwrap();
    pw.admitDerivedShapeCandidates([candidate], () =>
      err(new Error('reject new fragment')),
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedRecoveryState()).toBe('ready');
    expect(pw.getDerivedFailure(7)?.recovery).toBe('old-state-retained');
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(1);
    expect(pw.getDerivedPublication(7)).toBeUndefined();
    expect(pw.raycast(vec3.create(0.5, 0.5, 3), vec3.create(0, 0, -1), 5)).toBeUndefined();
    pw.dispose();
  });

  it('carries a successor world orientation through admission, rollback and snapshot recovery', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 16, [0, 0, 0]);
    const rotation: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const input = {
      ...voxelCandidate(16, 1),
      motion: {
        centerOfMass: [10, 0, 0] as const,
        linearVelocity: [0, 0, 0] as const,
        angularVelocity: [0, 0, 0] as const,
        rotation,
      },
    };
    const prepared = pw.prepareDerivedShapeCandidate(input).unwrap();
    rotation[1] = 0;
    rotation[3] = 1;
    pw.admitDerivedShapeCandidate(prepared).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedMotion(16)?.rotation?.[1]).toBeCloseTo(Math.SQRT1_2);
    expect(pw.raycast(vec3.create(10.5, 4, -2.25), vec3.create(0, -1, 0), 5)?.entity).toBe(16);
    const before = pw.getDerivedMotion(16);
    pw.admitDerivedShapeCandidate(
      pw
        .prepareDerivedShapeCandidate({
          ...voxelCandidate(16, 2),
          motion: { ...input.motion, rotation: [0, 0, 0, 1] },
        })
        .unwrap(),
      () => err(new Error('keep the prior orientation')),
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedMotion(16)).toEqual(before);
    const snapshot = pw.captureDerivedPhysicsState();
    pw.removeEntity(16);
    addBody(pw, 16, [0, 0, 0]);
    pw.restoreDerivedPhysicsState(snapshot).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedMotion(16)?.rotation?.[1]).toBeCloseTo(Math.SQRT1_2);
    expect(pw.raycast(vec3.create(10.5, 4, -2.25), vec3.create(0, -1, 0), 5)?.entity).toBe(16);
    expect(
      pw.prepareDerivedShapeCandidate({
        ...voxelCandidate(16, 2),
        motion: { ...input.motion, rotation: [0, 0, 0, 0] },
      }).ok,
    ).toBe(false);
    pw.dispose();
  });

  it('exposes committed COM and motion and restores that movement through a snapshot', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 16, [0, 0, 0]);
    const prepared = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(16, 1),
      massProperties: {
        mode: 'explicit' as const,
        mass: 2,
        centerOfMass: [0, 0, 0] as const,
        principalInertia: [1, 1, 1] as const,
      },
      motion: {
        centerOfMass: [0.5, 0.25, 0] as const,
        linearVelocity: [1, 2, 3] as const,
        angularVelocity: [0.1, 0.2, 0.3] as const,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(pw.admitDerivedShapeCandidate(prepared.value).ok).toBe(true);
    pw.step(1 / 60);
    const motion = pw.getDerivedMotion(16);
    expect(motion?.centerOfMass[0]).toBeCloseTo(0.5 + 1 / 60, 4);
    expect(motion?.centerOfMass[1]).toBeCloseTo(0.25 + 2 / 60, 4);
    expect(motion?.centerOfMass[2]).toBeCloseTo(3 / 60, 4);
    expect(motion?.linearVelocity).toEqual([1, 2, 3]);
    expect(motion?.angularVelocity[0]).toBeCloseTo(0.1, 5);
    expect(motion?.angularVelocity[1]).toBeCloseTo(0.2, 5);
    expect(motion?.angularVelocity[2]).toBeCloseTo(0.3, 5);
    const snapshot = pw.captureDerivedPhysicsState();
    expect(snapshot.bodies[0]?.motion?.linearVelocity).toEqual([1, 2, 3]);
    expect(snapshot.bodies[0]?.motion?.angularVelocity[0]).toBeCloseTo(0.1, 5);
    pw.removeEntity(16);
    addBody(pw, 16, [0, 0, 0]);
    expect(pw.restoreDerivedPhysicsState(snapshot).ok).toBe(true);
    pw.step(1 / 60);
    const restoredMotion = pw.getDerivedMotion(16);
    const snapshotMotion = snapshot.bodies[0]?.motion;
    expect(snapshotMotion).toBeDefined();
    expect(restoredMotion?.centerOfMass[0]).toBeCloseTo(
      (snapshotMotion?.centerOfMass[0] ?? 0) + 1 / 60,
      4,
    );
    expect(restoredMotion?.centerOfMass[1]).toBeCloseTo(
      (snapshotMotion?.centerOfMass[1] ?? 0) + 2 / 60,
      4,
    );
    expect(restoredMotion?.centerOfMass[2]).toBeCloseTo(
      (snapshotMotion?.centerOfMass[2] ?? 0) + 3 / 60,
      4,
    );
    expect(restoredMotion?.linearVelocity).toEqual([1, 2, 3]);
    expect(restoredMotion?.angularVelocity[0]).toBeCloseTo(0.1, 5);
    pw.dispose();
  });

  it('keeps the committed shape set on cancellation and rejects stale revisions', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 8, [0, 0, 0]);
    const first = pw.prepareDerivedShapeCandidate(voxelCandidate(8, 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(pw.admitDerivedShapeCandidate(first.value).ok).toBe(true);
    pw.step(1 / 60);
    const stale = pw.prepareDerivedShapeCandidate(voxelCandidate(8, 1));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('derived-candidate-stale');

    const next = pw.prepareDerivedShapeCandidate(voxelCandidate(8, 2));
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(pw.cancelDerivedShapeCandidate(next.value).ok).toBe(true);
    expect(pw.getDerivedPublication(8)?.revision).toBe(1);
    expect(pw.getDerivedShapes(8)).toHaveLength(2);
  });

  it('retains the committed native state when an endpoint disappears before admission', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 12, [0, 0, 0]);
    addBody(pw, 13, [0, 0, 0]);
    const first = pw.prepareDerivedShapeCandidate(voxelCandidate(12, 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(pw.admitDerivedShapeCandidate(first.value).ok).toBe(true);
    pw.step(1 / 60);

    const next = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(12, 2),
      bodyType: 'static',
      constraints: [
        {
          id: 'disappearing-endpoint',
          revision: 1,
          kind: 'spring',
          bodyA: 12,
          bodyB: 13,
          bodyASource: { sourceKey: 'body:12', revision: 2 },
          bodyBSource: { sourceKey: 'entity:13', revision: 0 },
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          restLength: 0,
          stiffness: 10,
          damping: 1,
        },
      ],
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(pw.admitDerivedShapeCandidate(next.value).ok).toBe(true);
    pw.removeEntity(13);
    pw.step(1 / 60);

    expect(pw.getDerivedBodyType(12)).toBe('dynamic');
    expect(pw.getDerivedPublication(12)?.revision).toBe(1);
    expect(pw.getDerivedShapes(12).map((shape) => shape.id)).toEqual(['left', 'right']);
    expect(pw.getDerivedFailure(12)).toMatchObject({
      candidateId: next.value.candidateId,
      recovery: 'old-state-retained',
      error: { code: 'derived-body-not-found' },
    });
  });

  it('rejects an invalid body type before native mutation and releases the candidate', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 14, [0, 0, 0]);
    const first = pw.prepareDerivedShapeCandidate(voxelCandidate(14, 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(pw.admitDerivedShapeCandidate(first.value).ok).toBe(true);
    pw.step(1 / 60);

    const invalid = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(14, 2),
      bodyType: 'invalid',
    } as unknown as DerivedPhysicsCandidateInput);
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    expect(pw.admitDerivedShapeCandidate(invalid.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-invalid' },
    });
    expect(pw.cancelDerivedShapeCandidate(invalid.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-not-found' },
    });
    expect(pw.getDerivedBodyType(14)).toBe('dynamic');
    expect(pw.getDerivedPublication(14)?.revision).toBe(1);
    expect(pw.getDerivedFailure(14)).toMatchObject({
      candidateId: invalid.value.candidateId,
      recovery: 'old-state-retained',
      error: { code: 'derived-candidate-invalid' },
    });
  });

  it('exposes stable constraint identity and real shape contact observations', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    pw.setGravity(vec3.create(0, 0, 0));
    addBody(pw, 9, [0, 0, 0]);
    addBody(pw, 10, [0, 0, 0]);
    const candidate = pw.prepareDerivedShapeCandidate(voxelCandidate(9, 1));
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(pw.admitDerivedShapeCandidate(candidate.value).ok).toBe(true);
    pw.step(1 / 60);
    const constraint = pw.createDerivedConstraint({
      id: 'grab',
      revision: 1,
      kind: 'spring',
      bodyA: 9,
      bodyB: 10,
      bodyASource: { sourceKey: 'body:9', revision: 1 },
      bodyBSource: { sourceKey: 'entity:10', revision: 0 },
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      restLength: 0,
      stiffness: 20,
      damping: 1,
    });
    expect(constraint.ok).toBe(true);
    pw.step(1 / 60);
    const observations = pw.getContactObservations();
    expect(
      observations.some(
        (observation) =>
          observation.fixedStep === 1 &&
          (observation.shapeA === 'left' || observation.shapeB === 'left'),
      ),
    ).toBe(true);
    expect(
      pw.updateDerivedConstraint?.({
        id: 'grab',
        revision: 2,
        kind: 'spring',
        bodyA: 9,
        bodyB: 10,
        bodyASource: { sourceKey: 'body:9', revision: 1 },
        bodyBSource: { sourceKey: 'entity:10', revision: 0 },
        anchorA: [0, 0, 0],
        anchorB: [0, 0, 0],
        restLength: 0.1,
        stiffness: 25,
        damping: 1,
      }).ok,
    ).toBe(true);
    const snapshot = pw.captureDerivedPhysicsState();
    expect(snapshot.bodies[0]?.constraints).toMatchObject([
      {
        id: 'grab',
        bodyASource: { sourceKey: 'body:9', revision: 1 },
        bodyBSource: { sourceKey: 'entity:10', revision: 0 },
      },
    ]);
    const bodyRevision = pw.prepareDerivedShapeCandidate(voxelCandidate(9, 2));
    expect(bodyRevision.ok).toBe(true);
    if (!bodyRevision.ok) return;
    expect(pw.admitDerivedShapeCandidate(bodyRevision.value).ok).toBe(true);
    pw.step(1 / 60);
    expect(pw.captureDerivedPhysicsState().bodies[0]?.constraints).toEqual([]);
    expect(pw.removeEntity(9)).toBeUndefined();
    addBody(pw, 9, [0, 0, 0]);
    expect(pw.restoreDerivedPhysicsState(snapshot).ok).toBe(true);
    pw.step(1 / 60);
    expect(pw.captureDerivedPhysicsState().bodies[0]?.constraints).toMatchObject([
      { id: 'grab', revision: 2 },
    ]);
  });

  it('restores committed input through a fresh native body without restoring handles', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 11, [0, 0, 0]);
    const candidate = pw.prepareDerivedShapeCandidate(voxelCandidate(11, 1));
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(pw.admitDerivedShapeCandidate(candidate.value).ok).toBe(true);
    pw.step(1 / 60);
    const snapshot = pw.captureDerivedPhysicsState();
    pw.removeEntity(11);
    addBody(pw, 11, [0, 0, 0]);
    const restored = pw.restoreDerivedPhysicsState(snapshot);
    expect(restored.ok).toBe(true);
    expect(pw.getDerivedShapes(11)).toHaveLength(0);
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(11)).toMatchObject({ revision: 1, fixedStep: 2 });
    expect(pw.getDerivedShapes(11).map((entry) => entry.id)).toEqual(['left', 'right']);
  });

  it('restores native mass policy after a public-entry failure injected after mutation', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(rapierWithMassFailure(RAPIER));
    addBody(pw, 15, [0, 0, 0]);
    const before = pw.getDerivedBodyMass(15);
    const prepared = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(15, 1),
      massProperties: {
        mode: 'explicit',
        mass: 10,
        centerOfMass: [0, 0, 0],
        principalInertia: [1, 1, 1],
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(pw.admitDerivedShapeCandidate(prepared.value).ok).toBe(true);
    pw.step(1 / 60);

    expect(pw.getDerivedBodyMass(15)).toBeCloseTo(before ?? Number.NaN, 6);
    expect(pw.getDerivedRecoveryState()).toBe('ready');
    expect(pw.getDerivedPublication(15)).toBeUndefined();
    expect(pw.getDerivedFailure(15)).toMatchObject({
      entity: 15,
      recovery: 'old-state-retained',
      error: { code: 'derived-backend-failed' },
    });
  });

  it('revalidates queued endpoint revisions at admission and fixed-step processing', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 20, [0, 0, 0]);
    addBody(pw, 21, [0, 0, 0]);
    for (const entity of [20, 21]) {
      const initial = pw.prepareDerivedShapeCandidate(voxelCandidate(entity, 1));
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      expect(pw.admitDerivedShapeCandidate(initial.value).ok).toBe(true);
    }
    pw.step(1 / 60);

    const body21Revision2 = pw.prepareDerivedShapeCandidate(voxelCandidate(21, 2));
    expect(body21Revision2.ok).toBe(true);
    if (!body21Revision2.ok) return;
    expect(pw.admitDerivedShapeCandidate(body21Revision2.value).ok).toBe(true);
    const staleAtAdmission = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(20, 2),
      constraints: [
        {
          id: 'queued-stale',
          revision: 1,
          kind: 'spring',
          bodyA: 20,
          bodyB: 21,
          bodyASource: { sourceKey: 'body:20', revision: 2 },
          bodyBSource: { sourceKey: 'body:21', revision: 1 },
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          restLength: 0,
          stiffness: 10,
          damping: 1,
        },
      ],
    });
    expect(staleAtAdmission.ok).toBe(true);
    if (!staleAtAdmission.ok) return;
    expect(pw.admitDerivedShapeCandidate(staleAtAdmission.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-constraint-stale' },
    });
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(21)).toMatchObject({ revision: 2 });
    expect(pw.getDerivedPublication(20)).toMatchObject({ revision: 1 });

    const queuedBeforeDependency = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(20, 3),
      constraints: [
        {
          id: 'process-stale',
          revision: 1,
          kind: 'spring',
          bodyA: 20,
          bodyB: 21,
          bodyASource: { sourceKey: 'body:20', revision: 3 },
          bodyBSource: { sourceKey: 'body:21', revision: 2 },
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          restLength: 0,
          stiffness: 10,
          damping: 1,
        },
      ],
    });
    expect(queuedBeforeDependency.ok).toBe(true);
    if (!queuedBeforeDependency.ok) return;
    expect(pw.admitDerivedShapeCandidate(queuedBeforeDependency.value).ok).toBe(true);
    const body21Revision3 = pw.prepareDerivedShapeCandidate(voxelCandidate(21, 3));
    expect(body21Revision3.ok).toBe(true);
    if (!body21Revision3.ok) return;
    expect(pw.admitDerivedShapeCandidate(body21Revision3.value).ok).toBe(true);
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(20)).toMatchObject({ revision: 1 });
    expect(pw.getDerivedPublication(21)).toMatchObject({ revision: 3 });
    expect(pw.getDerivedFailure(20)).toMatchObject({
      recovery: 'old-state-retained',
      error: { code: 'derived-constraint-stale' },
    });
  });

  it('keeps the newest prepared revision and rejects a descending admission', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 22, [0, 0, 0]);
    const revision4 = pw.prepareDerivedShapeCandidate(voxelCandidate(22, 4));
    const revision3 = pw.prepareDerivedShapeCandidate(voxelCandidate(22, 3));
    expect(revision4.ok).toBe(true);
    expect(revision3.ok).toBe(true);
    if (!revision4.ok || !revision3.ok) return;
    expect(pw.admitDerivedShapeCandidate(revision4.value).ok).toBe(true);
    expect(pw.admitDerivedShapeCandidate(revision3.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-stale' },
    });
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(22)).toMatchObject({ revision: 4 });
  });

  it('restores a two-body constraint into a fresh world as one dependency-consistent batch', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const source = createRapier3DPhysicsWorld(RAPIER);
    addBody(source, 30, [0, 0, 0]);
    addBody(source, 31, [0, 0, 0]);
    for (const entity of [30, 31]) {
      const prepared = source.prepareDerivedShapeCandidate(voxelCandidate(entity, 1));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(source.admitDerivedShapeCandidate(prepared.value).ok).toBe(true);
    }
    source.step(1 / 60);
    expect(
      source.createDerivedConstraint({
        id: 'fresh-restore-joint',
        revision: 1,
        kind: 'spring',
        bodyA: 30,
        bodyB: 31,
        bodyASource: { sourceKey: 'body:30', revision: 1 },
        bodyBSource: { sourceKey: 'body:31', revision: 1 },
        anchorA: [0, 0, 0],
        anchorB: [0, 0, 0],
        restLength: 0,
        stiffness: 10,
        damping: 1,
      }).ok,
    ).toBe(true);
    const snapshot = source.captureDerivedPhysicsState();

    const fresh = createRapier3DPhysicsWorld(RAPIER);
    addBody(fresh, 30, [0, 0, 0]);
    addBody(fresh, 31, [0, 0, 0]);
    const restored = fresh.restoreDerivedPhysicsState(snapshot);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value).toHaveLength(2);
    fresh.step(1 / 60);
    expect(fresh.getDerivedPublication(30)).toMatchObject({ revision: 1, fixedStep: 1 });
    expect(fresh.getDerivedPublication(31)).toMatchObject({ revision: 1, fixedStep: 1 });
    const restoredConstraints = fresh
      .captureDerivedPhysicsState()
      .bodies.flatMap((body) => body.constraints);
    expect(restoredConstraints).toHaveLength(2);
    expect(restoredConstraints[0]).toMatchObject({
      id: 'fresh-restore-joint',
      bodyASource: { sourceKey: 'body:30', revision: 1 },
      bodyBSource: { sourceKey: 'body:31', revision: 1 },
    });
    source.dispose();
    fresh.dispose();
  });

  it('clears explicit mass residue when switching to automatic density policy', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 40, [0, 0, 0]);
    const explicit = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(40, 1),
      massProperties: {
        mode: 'explicit',
        mass: 10,
        centerOfMass: [0, 0, 0],
        principalInertia: [1, 1, 1],
      },
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(pw.admitDerivedShapeCandidate(explicit.value).ok).toBe(true);
    pw.step(1 / 60);
    const automatic = pw.prepareDerivedShapeCandidate({
      ...voxelCandidate(40, 2),
      massProperties: { mode: 'automatic' },
    });
    expect(automatic.ok).toBe(true);
    if (!automatic.ok) return;
    expect(pw.admitDerivedShapeCandidate(automatic.value).ok).toBe(true);
    pw.step(1 / 60);
    const switchedMass = pw.getDerivedBodyMass(40);

    const fresh = createRapier3DPhysicsWorld(RAPIER);
    addBody(fresh, 41, [0, 0, 0]);
    const freshAutomatic = fresh.prepareDerivedShapeCandidate({
      ...voxelCandidate(41, 1),
      massProperties: { mode: 'automatic' },
    });
    expect(freshAutomatic.ok).toBe(true);
    if (!freshAutomatic.ok) return;
    expect(fresh.admitDerivedShapeCandidate(freshAutomatic.value).ok).toBe(true);
    fresh.step(1 / 60);
    expect(switchedMass).toBeCloseTo(fresh.getDerivedBodyMass(41) ?? Number.NaN, 6);
    pw.dispose();
    fresh.dispose();
  });
});
