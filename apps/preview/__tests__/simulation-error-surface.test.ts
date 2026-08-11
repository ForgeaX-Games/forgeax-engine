import {
  createSimulationError,
  type SimulationError,
} from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

import { consumeSimulationError } from '../src/preview-inspection';

function surface(error: SimulationError) {
  return consumeSimulationError(error, 'simulation-v1:baseline');
}

describe('Preview simulation error surface', () => {
  it('consumes participant missing, not-ready, schema mismatch, and preserved baseline structurally', () => {
    const missing = surface(
      createSimulationError('simulation-participant-missing', {
        id: 'forgeax.physics.rapier-3d',
        expectedVersion: '1',
        expectedSchemaFingerprint: 'rapier-3d-simulation-v1',
      }),
    );
    expect(missing).toMatchObject({
      code: 'simulation-participant-missing',
      action: 'register participant on a fresh target and retry',
      baselineFingerprint: 'simulation-v1:baseline',
      detail: { id: 'forgeax.physics.rapier-3d' },
    });

    const notReady = surface(createSimulationError('simulation-participant-not-ready', { id: 'audio' }));
    expect(notReady).toMatchObject({
      code: 'simulation-participant-not-ready',
      action: 'wait until the participant is ready, then retry on a fresh target',
      baselineFingerprint: 'simulation-v1:baseline',
      detail: { id: 'audio' },
    });

    const mismatch = surface(
      createSimulationError('simulation-participant-schema-mismatch', {
        id: 'forgeax.audio.ecs',
        expectedSchemaFingerprint: 'audio-v1',
        actualSchemaFingerprint: 'audio-v0',
      }),
    );
    expect(mismatch).toMatchObject({
      code: 'simulation-participant-schema-mismatch',
      action: 'use a compatible participant schema and create a new record',
      baselineFingerprint: 'simulation-v1:baseline',
      detail: { actualSchemaFingerprint: 'audio-v0' },
    });

    for (const value of [missing, notReady, mismatch]) {
      expect(value.expected).toEqual(expect.any(String));
      expect(value.hint).toEqual(expect.any(String));
      expect(value.detail).toBeDefined();
    }
  });
});
