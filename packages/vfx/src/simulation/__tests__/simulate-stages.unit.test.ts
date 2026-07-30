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
      capacity: 4,
      space: 'world',
      schedule: { rate: 4, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: {
        spawn: [{ kind: 'spawn', version: 1, params: {} }],
        initialize: [{ kind: 'initialize', version: 1, params: { seconds: 1 } }],
        update: [{ kind: 'update', version: 1, params: {} }],
        output: [{ kind: 'output', version: 1, params: { size: 0.5 } }],
      },
      output: { kind: 'billboard', material: 'material-spark' },
      programs: {
        cpu: [
          { operator: 'spawn:spawn:1', program: {} },
          { operator: 'initialize:initialize:1', program: { seconds: 1 } },
          { operator: 'update:update:1', program: {} },
          { operator: 'output:output:1', program: { size: 0.5 } },
        ],
      },
    },
  ],
};

function executor(
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  trace: string[],
  execute: ParticleCpuExecutorDefinition['execute'] = () => ({ ok: true, value: undefined }),
): ParticleCpuExecutorDefinition {
  return {
    stage,
    kind: stage,
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute: (context) => {
      trace.push(context.stage);
      return execute(context);
    },
  };
}

describe('definition-driven simulation stages', () => {
  it('runs spawn, initialize, update, and output in the fixed order', () => {
    const trace: string[] = [];
    const registry = new ParticleCpuExecutorRegistry([
      executor('spawn', trace),
      executor('initialize', trace, ({ particle, program }) => {
        particle.lifetime = Number((program as { seconds: number }).seconds);
        return { ok: true, value: undefined };
      }),
      executor('update', trace, ({ particle }) => {
        particle.position[0] += 2;
        return { ok: true, value: undefined };
      }),
      executor('output', trace, ({ output, program }) => {
        output.size = Number((program as { size: number }).size);
        return { ok: true, value: undefined };
      }),
    ]);
    const owner = createParticleSimulationOwner({ player: 5, seed: 2, program, registry });

    const result = simulateParticleOwner(owner, { fixedDelta: 0.25, tick: 0 });
    const snapshot = snapshotParticleOwner(owner);

    expect(result.ok).toBe(true);
    expect(trace).toEqual(['spawn', 'initialize', 'update', 'output']);
    expect(snapshot.emitters[0]?.liveCount).toBe(1);
    expect(snapshot.emitters[0]?.positions[0]).toBe(2);
    expect(snapshot.emitters[0]?.sizes[0]).toBe(0.5);
  });

  it('reports invalid definition data before publishing a partial stage result', () => {
    const registry = new ParticleCpuExecutorRegistry([
      executor('spawn', []),
      {
        ...executor('initialize', []),
        validateProgram: () => ({ ok: false, error: 'seconds must be positive' }),
      },
      executor('update', []),
      executor('output', []),
    ]);
    const owner = createParticleSimulationOwner({ player: 5, seed: 2, program, registry });
    const result = simulateParticleOwner(owner, { fixedDelta: 0.25, tick: 0 });

    expect(result.ok).toBe(false);
    expect(snapshotParticleOwner(owner).emitters[0]?.liveCount).toBe(0);
    if (!result.ok) {
      expect(result.error.detail.stage).toBe('initialize');
      expect(result.error.detail.operator).toBe('initialize:initialize:1');
    }
  });
});
