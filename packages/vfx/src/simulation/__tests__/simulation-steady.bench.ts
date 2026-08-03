import { bench, describe, expect } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import {
  createParticleSimulationOwner,
  resetParticleSimulationOwner,
  simulateParticleOwner,
} from '../simulate.js';
import type { ParticleSimulationOwner } from '../types.js';

const FIXED_DELTA = 1 / 60;
const WARMUP_TICKS = 120;
const MEASURE_TICKS = 300;
const PLAYER = 1;
const FIXED_CAPACITY = 256;

const EMPTY_PROGRAM = (capacity: number, rate: number): ParticleRuntimeProgram => ({
  format: 'forgeax-vfx-program-1',
  emitters: [
    {
      id: 'benchmark',
      capacity,
      space: 'world',
      schedule: { rate, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: { spawn: [], initialize: [], update: [], output: [] },
      output: { kind: 'billboard', material: 'benchmark-material' },
      programs: { cpu: [] },
    },
  ],
});

function createOwner(capacity: number, rate: number): ParticleSimulationOwner {
  return createParticleSimulationOwner({
    player: PLAYER,
    seed: 0x20260730,
    program: EMPTY_PROGRAM(capacity, rate),
    registry: new ParticleCpuExecutorRegistry(),
  });
}

function primeLivePrefix(owner: ParticleSimulationOwner, liveCount: number): void {
  const state = owner.emitterStates[0];
  if (state === undefined || liveCount > state.capacity) {
    throw new Error('benchmark live count exceeds emitter capacity');
  }
  state.liveCount = liveCount;
  for (let index = 0; index < liveCount; index += 1) {
    state.active[index] = 1;
    state.birthOrders[index] = index;
    state.ages[index] = 0;
    state.lifetimes[index] = Number.POSITIVE_INFINITY;
    state.positions[index * 3] = index;
    state.positions[index * 3 + 1] = index * 0.5;
    state.positions[index * 3 + 2] = -index;
    state.velocities[index * 3] = 0;
    state.velocities[index * 3 + 1] = 0;
    state.velocities[index * 3 + 2] = 0;
    state.sizes[index] = 1;
    state.colors[index * 4] = 1;
    state.colors[index * 4 + 1] = 1;
    state.colors[index * 4 + 2] = 1;
    state.colors[index * 4 + 3] = 1;
  }
  state.active[liveCount] = 0;
}

function advance(owner: ParticleSimulationOwner, tick: number): void {
  const result = simulateParticleOwner(owner, {
    fixedDelta: FIXED_DELTA,
    tick,
  });
  if (!result.ok) throw new Error(`steady simulation failed: ${result.error.code}`);
  if (owner.allocatedBytes !== 0) {
    throw new Error(`steady simulation allocated ${owner.allocatedBytes} bytes`);
  }
  if (!Number.isFinite(owner.cpuUpdateMs) || owner.cpuUpdateMs < 0) {
    throw new Error(`steady simulation reported invalid CPU time: ${owner.cpuUpdateMs}`);
  }
}

function runEnvelope(owner: ParticleSimulationOwner, liveCount: number): number {
  resetParticleSimulationOwner(owner);
  for (let tick = 1; tick <= WARMUP_TICKS; tick += 1) advance(owner, tick);
  primeLivePrefix(owner, liveCount);

  let checksum = 0;
  for (let tick = WARMUP_TICKS + 1; tick <= WARMUP_TICKS + MEASURE_TICKS; tick += 1) {
    advance(owner, tick);
    const state = owner.emitterStates[0];
    checksum ^= (state?.liveCount ?? 0) + Math.trunc(owner.cpuUpdateMs * 1_000_000);
  }
  expect(owner.tick).toBe(WARMUP_TICKS + MEASURE_TICKS);
  expect(Number.isSafeInteger(checksum)).toBe(true);
  return checksum;
}

describe('VFX steady simulation allocation and complexity envelope', () => {
  bench(
    'one player, capacity 256, dt 1/60, warmup 120, measure 300',
    () => {
      const checksum = runEnvelope(createOwner(FIXED_CAPACITY, 0), 64);
      expect(checksum).toBeTypeOf('number');
    },
    { iterations: 1 },
  );

  bench(
    'capacity axis 256 to 1024 at live prefix 64',
    () => {
      const small = runEnvelope(createOwner(256, 0), 64);
      const large = runEnvelope(createOwner(1024, 0), 64);
      expect(small).toBeTypeOf('number');
      expect(large).toBeTypeOf('number');
    },
    { iterations: 1 },
  );

  bench(
    'live axis 64 to 256 at capacity 256',
    () => {
      const low = runEnvelope(createOwner(FIXED_CAPACITY, 0), 64);
      const high = runEnvelope(createOwner(FIXED_CAPACITY, 0), 256);
      expect(low).toBeTypeOf('number');
      expect(high).toBeTypeOf('number');
    },
    { iterations: 1 },
  );
});
