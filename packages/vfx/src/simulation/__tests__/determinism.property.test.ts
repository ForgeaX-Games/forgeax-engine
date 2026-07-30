import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import type { ParticleCpuExecutorDefinition } from '../cpu-executor-registry.js';
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
      capacity: 16,
      space: 'world',
      schedule: { rate: 8, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 8 } }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 4 } }],
        update: [{ kind: 'random-jitter', version: 1, params: {} }],
        output: [{ kind: 'output-size', version: 1, params: { size: 1 } }],
      },
      output: { kind: 'billboard', material: 'material-spark' },
      programs: {
        cpu: [
          { operator: 'spawn:spawn-rate:1', program: { rate: 8 } },
          { operator: 'initialize:set-life:1', program: { seconds: 4 } },
          { operator: 'update:random-jitter:1', program: {} },
          { operator: 'output:output-size:1', program: { size: 1 } },
        ],
      },
    },
  ],
};

function executor(
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  kind: string,
  execute: ParticleCpuExecutorDefinition['execute'],
): ParticleCpuExecutorDefinition {
  return {
    stage,
    kind,
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute,
  };
}

function registry(): ParticleCpuExecutorRegistry {
  return new ParticleCpuExecutorRegistry([
    executor('spawn', 'spawn-rate', () => ({ ok: true, value: undefined })),
    executor('initialize', 'set-life', ({ particle, program }) => {
      particle.lifetime = Number((program as { seconds: number }).seconds);
      return { ok: true, value: undefined };
    }),
    executor('update', 'random-jitter', ({ particle, random }) => {
      particle.position[0] += random.nextFloat();
      return { ok: true, value: undefined };
    }),
    executor('output', 'output-size', ({ particle, output, program }) => {
      output.size = Number((program as { size: number }).size);
      particle.size = output.size;
      return { ok: true, value: undefined };
    }),
  ]);
}

function run(seed: number, fixedDeltas: readonly number[]) {
  const owner = createParticleSimulationOwner({ player: 7, seed, program, registry: registry() });
  for (const [tick, delta] of fixedDeltas.entries()) {
    const result = simulateParticleOwner(owner, { fixedDelta: delta, tick });
    expect(result.ok).toBe(true);
  }
  return { owner, bytes: snapshotParticleOwner(owner).bytes };
}

describe('fixed-step deterministic replay', () => {
  it('compares effective state bytes for the same executed ticks despite host regrouping', () => {
    const fixedTicks = [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125];
    const groupedA = run(7, fixedTicks);
    const groupedB = run(7, [...fixedTicks.slice(0, 4), ...fixedTicks.slice(4)]);

    expect(groupedA.bytes).toEqual(groupedB.bytes);
    expect(groupedA.owner.emitterStates[0]?.drawIndex).toBe(
      groupedB.owner.emitterStates[0]?.drawIndex,
    );
  });

  it('diverges for different seeds when an executor consumes the owner-local stream', () => {
    const first = run(7, [0.25, 0.25, 0.25, 0.25]);
    const second = run(8, [0.25, 0.25, 0.25, 0.25]);

    expect(first.bytes).not.toEqual(second.bytes);
  });

  it('does not advance state, draw index, or bytes for a zero fixed delta', () => {
    const owner = createParticleSimulationOwner({
      player: 7,
      seed: 7,
      program,
      registry: registry(),
    });
    expect(simulateParticleOwner(owner, { fixedDelta: 0, tick: 0 }).ok).toBe(true);
    const before = snapshotParticleOwner(owner);
    const result = simulateParticleOwner(owner, { fixedDelta: 0, tick: 1 });
    const after = snapshotParticleOwner(owner);

    expect(result.ok).toBe(true);
    expect(after.bytes).toEqual(before.bytes);
    expect(after.tick).toBe(before.tick);
    expect(after.drawIndex).toBe(before.drawIndex);
  });
});
