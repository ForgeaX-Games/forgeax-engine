import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import type { ParticleCpuExecutorDefinition } from '../cpu-executor-registry.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import {
  createParticleSimulationOwner,
  simulateParticleOwner,
  snapshotParticleOwner,
} from '../simulate.js';

function program(rate: number, capacity = 4): ParticleRuntimeProgram {
  return {
    format: 'forgeax-vfx-program-1',
    emitters: [
      {
        id: 'lifecycle',
        capacity,
        space: 'world',
        schedule: { rate, bursts: [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy: { kind: 'required', backend: 'cpu' },
        backendPlan: { kind: 'cpu', backends: ['cpu'] },
        operators: {
          spawn: [{ kind: 'trace-spawn', version: 1, params: {} }],
          initialize: [{ kind: 'set-lifetime', version: 1, params: { seconds: 1 } }],
          update: [{ kind: 'trace-update', version: 1, params: {} }],
          output: [{ kind: 'trace-output', version: 1, params: {} }],
        },
        output: { kind: 'billboard', material: 'material-lifecycle' },
        programs: {
          cpu: [
            { operator: 'spawn:trace-spawn:1', program: {} },
            { operator: 'initialize:set-lifetime:1', program: { seconds: 1 } },
            { operator: 'update:trace-update:1', program: {} },
            { operator: 'output:trace-output:1', program: {} },
          ],
        },
      },
    ],
  };
}

function registry(trace: string[], lifetime: number): ParticleCpuExecutorRegistry {
  const definition = (
    stage: 'spawn' | 'initialize' | 'update' | 'output',
    kind: string,
  ): ParticleCpuExecutorDefinition => ({
    stage,
    kind,
    version: 1,
    validateProgram: () => ({ ok: true, value: undefined }),
    execute: (context) => {
      trace.push(context.stage === 'spawn' ? `spawn:${context.spawnIndex}` : context.stage);
      if (context.stage === 'initialize') context.particle.lifetime = lifetime;
      return { ok: true, value: undefined };
    },
  });

  return new ParticleCpuExecutorRegistry([
    definition('spawn', 'trace-spawn'),
    definition('initialize', 'set-lifetime'),
    definition('update', 'trace-update'),
    definition('output', 'trace-output'),
  ]);
}

function owner(rate = 10, capacity = 4, lifetime = 1, trace: string[] = []) {
  return {
    trace,
    owner: createParticleSimulationOwner({
      player: 1,
      seed: 7,
      program: program(rate, capacity),
      registry: registry(trace, lifetime),
    }),
  };
}

describe('particle simulation lifecycle contract', () => {
  it('commits the four phases in order and omits particles at equality expiry', () => {
    const state = owner(10, 4, 1);
    const result = simulateParticleOwner(state.owner, { fixedDelta: 0.1, tick: 1 });

    expect(result.ok).toBe(true);
    expect(state.trace).toEqual(['spawn:0', 'initialize', 'update', 'output']);
    expect(snapshotParticleOwner(state.owner).emitters[0]?.liveCount).toBe(1);
  });

  it('reaps zero-lifetime particles in the same tick and reuses the slot next tick', () => {
    const state = owner(10, 1, 0);

    expect(simulateParticleOwner(state.owner, { fixedDelta: 0.1, tick: 1 }).ok).toBe(true);
    expect(snapshotParticleOwner(state.owner).emitters[0]?.liveCount).toBe(0);
    expect(simulateParticleOwner(state.owner, { fixedDelta: 0.1, tick: 2 }).ok).toBe(true);

    const snapshot = snapshotParticleOwner(state.owner);
    expect(snapshot.emitters[0]?.liveCount).toBe(0);
    expect(snapshot.emitters[0]?.birthOrders).toEqual(new Uint32Array());
    expect(state.trace.filter((entry) => entry === 'spawn:0')).toHaveLength(2);
  });

  it('records capacity drops and keeps zero-delta as a committed-state no-op', () => {
    const state = owner(30, 1, 10);
    expect(simulateParticleOwner(state.owner, { fixedDelta: 0.1, tick: 1 }).ok).toBe(true);
    const before = snapshotParticleOwner(state.owner);
    const traceLength = state.trace.length;

    expect(before.emitters[0]?.overflowCount).toBe(2);
    expect(simulateParticleOwner(state.owner, { fixedDelta: 0, tick: 2 }).ok).toBe(true);
    const after = snapshotParticleOwner(state.owner);

    expect([...after.bytes]).toEqual([...before.bytes]);
    expect(after.tick).toBe(before.tick);
    expect(state.trace).toHaveLength(traceLength);
  });

  it('reaps a particle after a large delta without publishing a dead output', () => {
    const state = owner(1, 2, 0.5);
    expect(simulateParticleOwner(state.owner, { fixedDelta: 2, tick: 1 }).ok).toBe(true);
    expect(snapshotParticleOwner(state.owner).batches).toEqual([]);
  });
});
