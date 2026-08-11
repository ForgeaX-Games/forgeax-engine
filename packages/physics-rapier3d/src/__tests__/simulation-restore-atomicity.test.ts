import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { createRapier3DSimulationParticipant } from '../simulation-participant';
import { loadRapier3D } from '../wasm-loader';

describe('M4 Rapier 3D participant restore atomicity', () => {
  it('rejects not-ready and schema/version mismatch before target mutation', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const sourcePhysics = createRapier3DPhysicsWorld(rapier);
    const sourceParticipant = createRapier3DSimulationParticipant(sourcePhysics);
    const source = new World();
    source.registerSimulationParticipant(sourceParticipant).unwrap();
    const record = source.simulationRecord().unwrap();

    const targetPhysics = createRapier3DPhysicsWorld(rapier);
    const notReadyParticipant = createRapier3DSimulationParticipant(targetPhysics, {
      isReady: () => false,
    });
    const notReadyTarget = new World();
    notReadyTarget.registerSimulationParticipant(notReadyParticipant).unwrap();
    const baseline = notReadyTarget.simulationFingerprint();
    const notReady = notReadyTarget.simulationRestore(record);
    if (notReady.ok) expect.fail('not-ready restore unexpectedly succeeded');
    expect(notReady.error).toMatchObject({ code: 'simulation-participant-not-ready' });
    expect(notReadyTarget.simulationFingerprint()).toBe(baseline);
    expect(targetPhysics.getBodyCount()).toBe(0);

    const mismatchTarget = new World();
    const mismatchParticipant = createRapier3DSimulationParticipant(targetPhysics, {
      schemaFingerprint: 'wrong-schema',
    });
    mismatchTarget.registerSimulationParticipant(mismatchParticipant).unwrap();
    const mismatch = mismatchTarget.simulationRestore(record);
    if (mismatch.ok) expect.fail('schema-mismatch restore unexpectedly succeeded');
    expect(mismatch.error).toMatchObject({ code: 'simulation-participant-schema-mismatch' });
    expect(targetPhysics.getBodyCount()).toBe(0);
  });

  it('disposes a failed prepare and permits the same record on a fresh retry target', async () => {
    const rapier = await loadRapier3D();
    if ('code' in rapier) {
      expect.fail(`Rapier 3D WASM unavailable: ${rapier.message}`);
    }

    const sourcePhysics = createRapier3DPhysicsWorld(rapier);
    const sourceBody = sourcePhysics.raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(1, 2, 3),
    );
    sourceBody.userData = 1001;
    sourcePhysics.raw.createCollider(rapier.ColliderDesc.ball(0.5), sourceBody);
    sourcePhysics.registerBody(1001, sourceBody.handle);
    const sourceParticipant = createRapier3DSimulationParticipant(sourcePhysics);
    const record = sourceParticipant.recordState?.();
    if (!record?.ok) expect.fail('expected a recordable source state');

    const failedTargetPhysics = createRapier3DPhysicsWorld(rapier);
    const existing = failedTargetPhysics.raw.createRigidBody(rapier.RigidBodyDesc.fixed());
    existing.userData = 9999;
    failedTargetPhysics.registerBody(9999, existing.handle);
    const failedTargetParticipant = createRapier3DSimulationParticipant(failedTargetPhysics);
    const invalid = failedTargetParticipant.prepareRestore({
      ...(record.value as Record<string, unknown>),
      bodies: [{ entity: 1001 }],
    });
    if (invalid.ok) expect.fail('invalid staged body unexpectedly succeeded');
    expect(invalid.error).toMatchObject({ code: 'simulation-state-unsupported' });
    expect(failedTargetPhysics.getBodyCount()).toBe(1);

    const retryPhysics = createRapier3DPhysicsWorld(rapier);
    const retryParticipant = createRapier3DSimulationParticipant(retryPhysics);
    const prepared = retryParticipant.prepareRestore(record.value);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) retryParticipant.commitRestore(prepared.value);
    expect(retryPhysics.hasBody(1001)).toBe(true);
    expect(retryPhysics.getBodyCount()).toBe(1);
  });
});
