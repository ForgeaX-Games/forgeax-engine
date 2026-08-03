import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import type { ParticleCpuExecutorDefinition } from '../cpu-executor-registry.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import {
  createParticleSimulationOwner,
  simulateParticleOwner,
  snapshotParticleOwner,
} from '../simulate.js';

function program(operator: string): ParticleRuntimeProgram {
  return {
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
          initialize: [{ kind: 'initialize', version: 1, params: { seconds: 2 } }],
          update: [{ kind: operator, version: 1, params: {} }],
          output: [{ kind: 'output', version: 1, params: {} }],
        },
        output: { kind: 'billboard', material: 'material-spark' },
        programs: {
          cpu: [
            { operator: 'spawn:spawn:1', program: {} },
            { operator: 'initialize:initialize:1', program: { seconds: 2 } },
            { operator: `update:${operator}:1`, program: {} },
            { operator: 'output:output:1', program: {} },
          ],
        },
      },
    ],
  };
}

function executor(
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  kind: string,
  execute: ParticleCpuExecutorDefinition['execute'] = () => ({ ok: true, value: undefined }),
): ParticleCpuExecutorDefinition {
  return {
    stage,
    kind,
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute,
  };
}

function registry(failing: boolean) {
  return new ParticleCpuExecutorRegistry([
    executor('spawn', 'spawn'),
    executor('initialize', 'initialize', ({ particle, program }) => {
      particle.lifetime = Number((program as { seconds: number }).seconds);
      return { ok: true, value: undefined };
    }),
    executor(
      'update',
      failing ? 'reject' : 'move',
      failing
        ? () => ({ ok: false, error: 'numeric state rejected' })
        : ({ particle }) => {
            particle.position[0] += 1;
            return { ok: true, value: undefined };
          },
    ),
    executor('output', 'output'),
  ]);
}

describe('transactional simulation failure isolation', () => {
  it('holds the last valid owner snapshot and leaves another owner byte-identical', () => {
    const failed = createParticleSimulationOwner({
      player: 10,
      seed: 7,
      program: program('reject'),
      registry: registry(true),
    });
    const valid = createParticleSimulationOwner({
      player: 11,
      seed: 7,
      program: program('move'),
      registry: registry(false),
    });
    const clean = createParticleSimulationOwner({
      player: 11,
      seed: 7,
      program: program('move'),
      registry: registry(false),
    });

    expect(simulateParticleOwner(valid, { fixedDelta: 0.25, tick: 0 }).ok).toBe(true);
    expect(simulateParticleOwner(clean, { fixedDelta: 0.25, tick: 0 }).ok).toBe(true);
    const before = snapshotParticleOwner(failed);
    const failedResult = simulateParticleOwner(failed, { fixedDelta: 0.25, tick: 0 });

    expect(failedResult.ok).toBe(false);
    expect(snapshotParticleOwner(failed).bytes).toEqual(before.bytes);
    expect(failed.scratchEmitterStates[0]?.positions).not.toBe(failed.emitterStates[0]?.positions);
    expect(snapshotParticleOwner(valid).bytes).toEqual(snapshotParticleOwner(clean).bytes);
    if (!failedResult.ok) {
      expect(failedResult.error.detail.player).toBe(10);
      expect(failedResult.error.detail.emitterId).toBe('spark');
      expect(failedResult.error.detail.stage).toBe('update');
      expect(failedResult.error.detail.operator).toBe('update:reject:1');
    }
  });
});
