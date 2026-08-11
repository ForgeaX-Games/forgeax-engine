import { describe, expect, it } from 'vitest';
import { ok } from '../../index';
import { type SimulationParticipant, SimulationParticipantRegistry } from '../coordinator';
import type { SimulationRecordV1 } from '../types';

function recordWith(
  participants: SimulationRecordV1['participants'],
  trace: SimulationRecordV1['trace'] = [],
): SimulationRecordV1 {
  return {
    formatVersion: 1,
    recordTick: 0,
    clock: {
      time: { delta: 0, elapsed: 0 },
      fixed: {
        delta: 1 / 60,
        tick: 0,
        overstep: 0,
        droppedSeconds: 0,
        droppedUpdates: 0,
      },
    },
    world: { entities: [], resources: [] },
    participants,
    trace,
    fingerprint: 'simulation-v1:test',
  };
}

function participant(overrides: Partial<SimulationParticipant> = {}): SimulationParticipant {
  return {
    id: 'forgeax.test.participant',
    version: '1',
    schemaFingerprint: 'test-v1',
    isReady: () => true,
    prepareRestore: () =>
      ok({ state: null }) as ReturnType<SimulationParticipant['prepareRestore']>,
    commitRestore: () => undefined,
    disposeRestore: () => undefined,
    ...overrides,
  };
}

describe('simulation participant preflight errors', () => {
  it('rejects duplicate participant identity without choosing one registration', () => {
    const registry = new SimulationParticipantRegistry();
    expect(registry.register(participant()).ok).toBe(true);

    const duplicate = registry.register(participant());
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    switch (duplicate.error.code) {
      case 'simulation-participant-duplicate':
        expect(duplicate.error.detail.id).toBe('forgeax.test.participant');
        break;
      default:
        throw new Error(`unexpected simulation error: ${duplicate.error.code}`);
    }
  });

  it('reports missing, incompatible, and not-ready participants with machine-readable detail', () => {
    const ready = participant();
    const registry = new SimulationParticipantRegistry();
    registry.register(ready);

    const missing = registry.preflight(recordWith([]));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('simulation-participant-missing');

    const incompatible = new SimulationParticipantRegistry();
    incompatible.register(participant({ version: '2' }));
    const versionMismatch = incompatible.preflight(
      recordWith([
        { id: ready.id, version: '1', schemaFingerprint: ready.schemaFingerprint, state: null },
      ]),
    );
    expect(versionMismatch.ok).toBe(false);
    if (!versionMismatch.ok) {
      switch (versionMismatch.error.code) {
        case 'simulation-participant-version-mismatch':
          expect(versionMismatch.error.detail.expectedVersion).toBe('2');
          break;
        default:
          throw new Error(`unexpected simulation error: ${versionMismatch.error.code}`);
      }
    }

    const notReady = new SimulationParticipantRegistry();
    notReady.register(participant({ isReady: () => false }));
    const readiness = notReady.preflight(
      recordWith([
        { id: ready.id, version: '1', schemaFingerprint: ready.schemaFingerprint, state: null },
      ]),
    );
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      switch (readiness.error.code) {
        case 'simulation-participant-not-ready':
          break;
        default:
          throw new Error(`unexpected simulation error: ${readiness.error.code}`);
      }
    }
  });

  it('rejects malformed records and invalid traces before participant preparation', () => {
    const registry = new SimulationParticipantRegistry();
    registry.register(participant());

    const malformed = registry.preflight(recordWith([], [{ tick: 2, input: {} }]));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      switch (malformed.error.code) {
        case 'simulation-trace-invalid':
          expect(malformed.error.detail.path).toBe('trace[0].tick');
          break;
        default:
          throw new Error(`unexpected simulation error: ${malformed.error.code}`);
      }
    }
  });
});
