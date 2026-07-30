import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import type { ParticleCpuExecutorDefinition } from '../cpu-executor-registry.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import {
  createParticleSimulationOwner,
  resetParticleSimulationOwner,
  simulateParticleOwner,
  snapshotParticleOwner,
} from '../simulate.js';

const program: ParticleRuntimeProgram = {
  format: 'forgeax-vfx-program-1',
  emitters: [
    {
      id: 'spark',
      capacity: 3,
      space: 'world',
      schedule: { rate: 4, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: {} }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 0.6 } }],
        update: [{ kind: 'move', version: 1, params: { x: 1 } }],
        output: [{ kind: 'output-size', version: 1, params: { size: 1 } }],
      },
      output: { kind: 'billboard', material: 'material-spark' },
      programs: {
        cpu: [
          { operator: 'spawn:spawn-rate:1', program: {} },
          { operator: 'initialize:set-life:1', program: { seconds: 0.6 } },
          { operator: 'update:move:1', program: { x: 1 } },
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

const registry = new ParticleCpuExecutorRegistry([
  executor('spawn', 'spawn-rate', () => ({ ok: true, value: undefined })),
  executor('initialize', 'set-life', ({ particle, program }) => {
    particle.lifetime = Number((program as { seconds: number }).seconds);
    return { ok: true, value: undefined };
  }),
  executor('update', 'move', ({ particle, program }) => {
    particle.position[0] += Number((program as { x: number }).x);
    return { ok: true, value: undefined };
  }),
  executor('output', 'output-size', ({ particle, output, program }) => {
    output.size = Number((program as { size: number }).size);
    particle.size = output.size;
    return { ok: true, value: undefined };
  }),
]);

describe('bounded SoA particle slots', () => {
  it('keeps stable live-slot order and reclaims dead slots without exceeding capacity', () => {
    const owner = createParticleSimulationOwner({ player: 3, seed: 9, program, registry });

    expect(simulateParticleOwner(owner, { fixedDelta: 0.25, tick: 0 }).ok).toBe(true);
    expect(simulateParticleOwner(owner, { fixedDelta: 0.25, tick: 1 }).ok).toBe(true);
    expect(simulateParticleOwner(owner, { fixedDelta: 0.25, tick: 2 }).ok).toBe(true);
    const snapshot = snapshotParticleOwner(owner);
    const emitter = snapshot.emitters[0];

    expect(emitter?.liveCount).toBeLessThanOrEqual(3);
    expect(emitter?.liveCount).toBe(2);
    expect(emitter?.birthOrders).toEqual(new Uint32Array([1, 2]));
    expect(emitter?.positions[0]).toBeGreaterThan(emitter?.positions[3] ?? 0);
  });

  it('clears timers, live state, snapshot bytes, and draw index on reset', () => {
    const owner = createParticleSimulationOwner({ player: 3, seed: 9, program, registry });
    expect(simulateParticleOwner(owner, { fixedDelta: 0.5, tick: 0 }).ok).toBe(true);
    expect(owner.emitterStates[0]?.liveCount).toBeGreaterThan(0);

    resetParticleSimulationOwner(owner);
    const snapshot = snapshotParticleOwner(owner);

    expect(snapshot.tick).toBe(0);
    expect(snapshot.drawIndex).toBe(0);
    expect(snapshot.emitters[0]?.liveCount).toBe(0);
    expect(snapshot.emitters[0]?.ages).toEqual(new Float32Array());
    expect(snapshot.bytes).toEqual(new Uint8Array(snapshot.bytes.length));
  });
});
