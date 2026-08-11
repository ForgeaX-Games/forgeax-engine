import { describe, expect, it } from 'vitest';
import { defineComponent, err, ok, World } from '../../index';
import { createSimulationError, type SimulationParticipant } from '../coordinator';

const AtomicNode = defineComponent('SimulationAtomicNode', {
  value: { type: 'f32', default: 0 },
  target: { type: 'entity' },
});

function participant(
  prepare: SimulationParticipant['prepareRestore'],
  dispose: SimulationParticipant['disposeRestore'] = () => undefined,
): SimulationParticipant {
  return {
    id: 'forgeax.test.atomic',
    version: '1',
    schemaFingerprint: 'atomic-v1',
    isReady: () => true,
    recordState: () => ok({ counter: 3 }),
    prepareRestore: prepare,
    commitRestore: () => undefined,
    disposeRestore: dispose,
  };
}

describe('simulation restore atomicity', () => {
  it('keeps the target baseline unchanged when participant prepare fails', () => {
    const source = new World();
    source
      .registerSimulationParticipant(
        participant(
          () => ok({ state: null }) as ReturnType<SimulationParticipant['prepareRestore']>,
        ),
      )
      .unwrap();
    const record = source.simulationRecord().unwrap();

    const target = new World();
    const failing = participant(() =>
      err(
        createSimulationError('simulation-participant-prepare-failed', {
          id: 'forgeax.test.atomic',
          path: 'state',
        }),
      ),
    );
    target.registerSimulationParticipant(failing).unwrap();
    const baseline = target.simulationFingerprint();

    const failed = target.simulationRestore(record);
    expect(failed.ok).toBe(false);
    expect(target.simulationFingerprint()).toBe(baseline);
    expect(target.inspect().entityCount).toBe(0);
  });

  it('disposes prepared stages and retries the same record on a fresh target', () => {
    const source = new World();
    const sourceParticipant = participant(() => ok({ state: null }));
    source.registerSimulationParticipant(sourceParticipant).unwrap();
    const record = source.simulationRecord().unwrap();

    let disposeCount = 0;
    let shouldFail = true;
    const targetParticipant = participant(
      () => {
        if (shouldFail) {
          return err(
            createSimulationError('simulation-participant-prepare-failed', {
              id: 'forgeax.test.atomic',
              path: 'state',
            }),
          );
        }
        return ok({ state: { restored: true } });
      },
      () => {
        disposeCount += 1;
      },
    );
    const failedTarget = new World();
    failedTarget.registerSimulationParticipant(targetParticipant).unwrap();
    expect(failedTarget.simulationRestore(record).ok).toBe(false);

    shouldFail = false;
    const retryTarget = new World();
    retryTarget.registerSimulationParticipant(targetParticipant).unwrap();
    expect(retryTarget.simulationRestore(record).ok).toBe(true);
    expect(disposeCount).toBe(0);
  });

  it('restores entity references to target handles instead of source handles', () => {
    const source = new World();
    const sourceTarget = source
      .spawn({ component: AtomicNode, data: { value: 4 } as never })
      .unwrap();
    source
      .spawn({ component: AtomicNode, data: { value: 8, target: sourceTarget } as never })
      .unwrap();
    source.registerSimulationParticipant(participant(() => ok({ state: null }))).unwrap();
    const record = source.simulationRecord().unwrap();

    const target = new World();
    target.registerSimulationParticipant(participant(() => ok({ state: null }))).unwrap();
    expect(target.simulationRestore(record).ok).toBe(true);

    const rows = target.query({ read: [AtomicNode] }).unwrap();
    const restoredTargets: unknown[] = [];
    for (const row of rows) restoredTargets.push(row.get(AtomicNode).target);
    expect(restoredTargets).toEqual([null, 0]);
  });
});
