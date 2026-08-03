import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import { createParticleSimulationOwner, simulateParticleOwner } from '../simulate.js';

const program: ParticleRuntimeProgram = {
  format: 'forgeax-vfx-program-1',
  emitters: [
    {
      id: 'spark',
      capacity: 8,
      space: 'world',
      schedule: { rate: 120, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: { spawn: [], initialize: [], update: [], output: [] },
      output: { kind: 'billboard', material: 'spark-material' },
      programs: { cpu: [] },
    },
  ],
};

describe('particle simulation transaction storage', () => {
  it('preallocates a scratch state and reusable live-prefix storage', () => {
    const owner = createParticleSimulationOwner({
      player: 1,
      seed: 4,
      program,
      registry: new ParticleCpuExecutorRegistry(),
    });

    expect(owner.scratchEmitterStates).toHaveLength(1);
    expect(owner.scratchEmitterStates[0]).not.toBe(owner.emitterStates[0]);
    expect(owner.scratchEmitterStates[0]?.liveSlots).toBeInstanceOf(Uint32Array);
    expect(owner.scratchEmitterStates[0]?.liveSlots.length).toBe(8);

    const committed = owner.emitterStates[0];
    expect(simulateParticleOwner(owner, { fixedDelta: 1 / 60, tick: 1 }).ok).toBe(true);
    expect(owner.emitterStates[0]).not.toBe(committed);
    expect(owner.scratchEmitterStates[0]).toBe(committed);
  });

  it('does not change committed bytes when a scratch execution fails', () => {
    const owner = createParticleSimulationOwner({
      player: 2,
      seed: 4,
      program: {
        ...program,
        emitters: program.emitters.map((emitter) => ({
          ...emitter,
          programs: { cpu: [{ operator: 'update:reject:1', program: {} }] },
        })),
      },
      registry: new ParticleCpuExecutorRegistry([
        {
          stage: 'update',
          kind: 'reject',
          version: 1,
          validateProgram: () => ({ ok: true, value: undefined }),
          execute: () => ({ ok: false, error: 'rejected' }),
        },
      ]),
    });
    const state = owner.emitterStates[0];
    const before = state?.positions.slice();

    expect(simulateParticleOwner(owner, { fixedDelta: 1 / 60, tick: 1 }).ok).toBe(false);
    expect(owner.tick).toBe(0);
    expect(owner.emitterStates[0]?.positions).toEqual(before);
  });
});
