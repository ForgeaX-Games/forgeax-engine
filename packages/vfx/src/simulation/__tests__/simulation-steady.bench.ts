import { type EntityHandle, FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { bench, describe, expect } from 'vitest';
import { ParticleEffectPlayer } from '../../player.js';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import { ParticleSimulation } from '../resource.js';
import {
  createParticleSimulationOwner,
  resetParticleSimulationOwner,
  simulateParticleOwner,
} from '../simulate.js';
import type { ParticleSimulationOwner, ParticleSimulationPlayerInput } from '../types.js';

const FIXED_DELTA = 1 / 60;
const WARMUP_TICKS = 120;
const MEASURE_TICKS = 300;
const PLAYER = 1;
const FIXED_CAPACITY = 256;
const OBSERVATION_PLAYERS = 500;
const BENCH_OPTIONS = { iterations: 100 } as const;
const P95_SAMPLE_COUNT = 100;

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

function createObservationBench(): {
  readonly simulation: ParticleSimulation;
  readonly world: World;
  readonly inputs: readonly ParticleSimulationPlayerInput[];
} {
  const world = new World({ time: { fixedDeltaSeconds: FIXED_DELTA, maxDeltaSeconds: 1 } });
  const effect = {
    kind: 'particle-effect' as const,
    schemaVersion: 1 as const,
    emitters: [],
    program: { format: 'forgeax-vfx-program-1' as const, emitters: [] },
  };
  const effectHandle = world.allocSharedRef('ParticleEffectAsset', effect);
  const players = new Array<EntityHandle>(OBSERVATION_PLAYERS);
  for (let index = 0; index < OBSERVATION_PLAYERS; index += 1) {
    players[index] = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: effectHandle, playing: true, seed: index, timeScale: 1 },
      })
      .unwrap();
  }
  const simulation = new ParticleSimulation(
    { lookup: () => undefined },
    new ParticleCpuExecutorRegistry(),
  );
  const inputs = players.map((player, seed) => ({
    player,
    effect: effectHandle,
    playing: true,
    seed,
    timeScale: 1,
  }));
  world
    .addSystem(FixedUpdate, {
      name: 'read-all-bench-fixed-tick',
      queries: [],
      fn: () => undefined,
    })
    .unwrap();
  world.update(FIXED_DELTA).unwrap();
  simulation.advance(world, inputs);
  expect(simulation.readAll()).toHaveLength(OBSERVATION_PLAYERS);
  expect(world.getResource(FixedTime).tick).toBe(1);
  return { simulation, world, inputs };
}

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function recordP95Sample(samples: number[], startedAt: number): boolean {
  if (samples.length >= P95_SAMPLE_COUNT) return false;
  samples.push(performance.now() - startedAt);
  return samples.length === P95_SAMPLE_COUNT;
}

function reportP95(steadySamples: readonly number[], rebuildSamples: readonly number[]): void {
  if (steadySamples.length < P95_SAMPLE_COUNT || rebuildSamples.length < P95_SAMPLE_COUNT) return;
  // biome-ignore lint/suspicious/noConsole: p95 is the acceptance evidence.
  console.info(
    `[readAll bench] steady_p95_ms=${percentile(steadySamples, 0.95).toFixed(4)} rebuild_p95_ms=${percentile(rebuildSamples, 0.95).toFixed(4)} live_players=${OBSERVATION_PLAYERS} repeated_read_allocation=0 snapshot_rebuilds_per_tick=1`,
  );
}

describe('VFX steady simulation allocation and complexity envelope', () => {
  const observationBench = createObservationBench();
  const steadyP95Samples: number[] = [];
  const rebuildP95Samples: number[] = [];
  let observationSink = 0;
  let p95Reported = false;

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

  bench(
    'readAll steady snapshot, 500 live players, repeated reads',
    () => {
      const { simulation } = observationBench;
      const startedAt = performance.now();
      const snapshot = simulation.readAll();
      for (let read = 0; read < 32; read += 1) {
        expect(simulation.readAll()).toBe(snapshot);
      }
      recordP95Sample(steadyP95Samples, startedAt);
      observationSink ^= snapshot.length;
    },
    BENCH_OPTIONS,
  );

  bench(
    'readAll snapshot rebuild, 500 live players, one fixed tick',
    () => {
      const { simulation, world, inputs } = observationBench;
      const startedAt = performance.now();
      const prior = simulation.readAll();
      world.update(FIXED_DELTA).unwrap();
      simulation.advance(world, inputs);
      const next = simulation.readAll();
      expect(next).toHaveLength(OBSERVATION_PLAYERS);
      expect(next).not.toBe(prior);
      recordP95Sample(rebuildP95Samples, startedAt);
      if (
        !p95Reported &&
        steadyP95Samples.length >= P95_SAMPLE_COUNT &&
        rebuildP95Samples.length >= P95_SAMPLE_COUNT
      ) {
        reportP95(steadyP95Samples, rebuildP95Samples);
        p95Reported = true;
      }
      observationSink ^= next[0]?.player ?? 0;
    },
    BENCH_OPTIONS,
  );

  void observationSink;
});
