import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import type { ParticleCpuExecutorDefinition } from '../cpu-executor-registry.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import {
  createParticleSimulationOwner,
  simulateParticleOwner,
  snapshotParticleOwner,
} from '../simulate.js';

function program(rate: number, capacity: number, includeBurst = true): ParticleRuntimeProgram {
  return {
    format: 'forgeax-vfx-program-1',
    emitters: [
      {
        id: 'spark',
        capacity,
        space: 'world',
        schedule: { rate, bursts: includeBurst ? [{ time: 0.75, count: 3 }] : [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy: { kind: 'required', backend: 'cpu' },
        backendPlan: { kind: 'cpu', backends: ['cpu'] },
        operators: {
          spawn: [{ kind: 'spawn-rate', version: 1, params: { rate } }],
          initialize: [{ kind: 'set-life', version: 1, params: { seconds: 100 } }],
          update: [{ kind: 'noop', version: 1, params: {} }],
          output: [{ kind: 'noop-output', version: 1, params: {} }],
        },
        output: { kind: 'billboard', material: 'material-spark' },
        programs: {
          cpu: [
            { operator: 'spawn:spawn-rate:1', program: { rate } },
            { operator: 'initialize:set-life:1', program: { seconds: 100 } },
            { operator: 'update:noop:1', program: {} },
            { operator: 'output:noop-output:1', program: {} },
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

function registry() {
  return new ParticleCpuExecutorRegistry([
    executor('spawn', 'spawn-rate'),
    executor('initialize', 'set-life'),
    executor('update', 'noop'),
    executor('output', 'noop-output'),
  ]);
}

describe('emission remainder and capacity', () => {
  it('retains fractional remainder and counts stable overflow at a full emitter', () => {
    const owner = createParticleSimulationOwner({
      player: 4,
      seed: 1,
      program: program(1.5, 2),
      registry: registry(),
    });

    expect(simulateParticleOwner(owner, { fixedDelta: 0.5, tick: 0 }).ok).toBe(true);
    expect(owner.emitterStates[0]?.emissionRemainder).toBeCloseTo(0.75);
    expect(simulateParticleOwner(owner, { fixedDelta: 0.5, tick: 1 }).ok).toBe(true);
    expect(owner.emitterStates[0]?.emissionRemainder).toBeCloseTo(0.5);
    expect(owner.emitterStates[0]?.liveCount).toBe(2);

    for (let tick = 2; tick < 1002; tick += 1) {
      expect(simulateParticleOwner(owner, { fixedDelta: 0.25, tick }).ok).toBe(true);
    }
    const emitter = snapshotParticleOwner(owner).emitters[0];
    expect(emitter?.liveCount).toBeGreaterThanOrEqual(0);
    expect(emitter?.liveCount).toBeLessThanOrEqual(2);
    expect(emitter?.overflowCount).toBeGreaterThan(0);
  });

  it('keeps a legal empty result distinct from a full-capacity diagnostic counter', () => {
    const owner = createParticleSimulationOwner({
      player: 4,
      seed: 1,
      program: program(0, 2, false),
      registry: registry(),
    });

    const result = simulateParticleOwner(owner, { fixedDelta: 1, tick: 0 });
    const snapshot = snapshotParticleOwner(owner);

    expect(result.ok).toBe(true);
    expect(snapshot.batches).toEqual([]);
    expect(snapshot.emitters[0]?.liveCount).toBe(0);
    expect(snapshot.emitters[0]?.overflowCount).toBe(0);
  });
});
