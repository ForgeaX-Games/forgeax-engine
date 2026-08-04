import { FixedUpdate, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ParticleEffectPlayer } from '../../player.js';
import { ParticleCpuExecutorRegistry } from '../cpu-executor-registry.js';
import { ParticleSimulation } from '../resource.js';
import type { ParticleSimulationPlayerInput } from '../types.js';

const effect = {
  kind: 'particle-effect' as const,
  schemaVersion: 1 as const,
  emitters: [],
  program: { format: 'forgeax-vfx-program-1' as const, emitters: [] },
};

function setup() {
  const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
  const handle = world.allocSharedRef('ParticleEffectAsset', effect);
  const first = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
    })
    .unwrap();
  const second = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 2, timeScale: 1 },
    })
    .unwrap();
  const simulation = new ParticleSimulation(
    { lookup: () => undefined },
    new ParticleCpuExecutorRegistry(),
  );
  world
    .addSystem(FixedUpdate, {
      name: 'test-fixed-tick',
      queries: [],
      fn: () => undefined,
    })
    .unwrap();
  const input = (player: typeof first, seed: number): ParticleSimulationPlayerInput => ({
    player,
    effect: handle,
    playing: true,
    seed,
    timeScale: 1,
  });
  return { world, first, second, simulation, input };
}

describe('ParticleSimulation.readAll observation ordering', () => {
  it('returns a sorted, tick-stable, immutable projection', () => {
    const { world, first, second, simulation, input } = setup();
    world.update(0.1).unwrap();
    simulation.advance(world, [input(second, 2), input(first, 1)]);

    const snapshot = simulation.readAll();
    expect(snapshot.map((observation) => observation.player)).toEqual([first, second]);
    expect(simulation.readAll()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as unknown as unknown[]).push(undefined)).toThrow();

    world.update(0.1).unwrap();
    simulation.advance(world, [input(second, 2), input(first, 1)]);
    expect(simulation.readAll()).not.toBe(snapshot);
  });

  it('drops stale players, keeps zero-particle states healthy, and only reads state', () => {
    const { world, first, second, simulation, input } = setup();
    world.update(0.1).unwrap();
    simulation.advance(world, [input(first, 1), input(second, 2)]);
    const firstObservation = simulation.read(first);
    expect(simulation.readAll()[0]?.batches.batches).toEqual([]);
    expect(simulation.read(first)).toBe(firstObservation);

    world.update(0.1).unwrap();
    simulation.advance(world, [input(first, 1)]);
    expect(simulation.readAll().map((observation) => observation.player)).toEqual([first]);
    expect(simulation.read(second)).toBeUndefined();

    world.update(0.1).unwrap();
    simulation.advance(world, []);
    expect(simulation.readAll()).toEqual([]);
    expect(simulation.read(first)).toBeUndefined();
  });
});
