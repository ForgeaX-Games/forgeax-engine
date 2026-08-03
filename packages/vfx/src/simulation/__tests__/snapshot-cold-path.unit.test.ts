import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import {
  createParticleSimulationOwner,
  simulateParticleOwner,
  snapshotParticleOwner,
} from '../simulate.js';

const program: ParticleRuntimeProgram = {
  format: 'forgeax-vfx-program-1',
  emitters: [
    {
      id: 'spark',
      capacity: 4,
      space: 'world',
      schedule: { rate: 60, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: { spawn: [], initialize: [], update: [], output: [] },
      output: { kind: 'billboard', material: 'spark-material' },
      programs: { cpu: [] },
    },
  ],
};

describe('particle simulation snapshot cold path', () => {
  it('keeps completed state views independent until snapshot is explicitly requested', () => {
    const owner = createParticleSimulationOwner({
      player: 1,
      seed: 2,
      program,
      registry: new ParticleCpuExecutorRegistry(),
    });

    expect(simulateParticleOwner(owner, { fixedDelta: 1 / 60, tick: 1 }).ok).toBe(true);
    const committed = owner.emitterStates[0];
    const snapshot = snapshotParticleOwner(owner);
    const bytes = snapshot.bytes.slice();

    expect(snapshot.emitters[0]?.positions).not.toBe(committed?.positions);
    expect(snapshot.emitters[0]?.positions).toHaveLength(3);
    expect(snapshot.bytes).toEqual(bytes);

    expect(simulateParticleOwner(owner, { fixedDelta: 1 / 60, tick: 2 }).ok).toBe(true);
    expect(snapshot.bytes).toEqual(bytes);
    expect(snapshot.emitters[0]?.positions).not.toBe(owner.emitterStates[0]?.positions);
  });
});
