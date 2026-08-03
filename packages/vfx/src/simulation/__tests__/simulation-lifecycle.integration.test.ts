import { FixedTime, World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import {
  type LoadedParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleSimulation,
  particleSimulationPlugin,
} from '@forgeax/engine-vfx';
import { describe, expect, it, vi } from 'vitest';

const effect: LoadedParticleEffect = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 4 }],
  program: {
    format: 'forgeax-vfx-program-1',
    emitters: [
      {
        id: 'spark',
        capacity: 4,
        space: 'world',
        schedule: { rate: 10, bursts: [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy: { kind: 'required', backend: 'cpu' },
        backendPlan: { kind: 'cpu', backends: ['cpu'] },
        operators: { spawn: [], initialize: [], update: [], output: [] },
        output: { kind: 'billboard', material: 'material-spark' },
        programs: { cpu: [] },
      },
    ],
  },
};

const meshEffect: LoadedParticleEffect = {
  ...effect,
  program: {
    ...effect.program,
    emitters: effect.program.emitters.map((emitter) => ({
      ...emitter,
      output: { kind: 'mesh' as const, material: 'material-spark', mesh: 'mesh-spark' },
    })),
  },
};

const cpuExecutors = new ParticleCpuExecutorRegistry();

async function setup(
  loadedEffect: LoadedParticleEffect = effect,
  assets: { lookup(guid: string): unknown } = { lookup: () => undefined },
) {
  const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
  const handle = world.allocSharedRef('ParticleEffectAsset', loadedEffect);
  const player = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 7, timeScale: 1 },
    })
    .unwrap();
  const plugins = await runPlugins(world, [], [particleSimulationPlugin({ assets, cpuExecutors })]);
  expect(plugins.ok).toBe(true);
  return { world, player };
}

function releaseCount(spy: ReturnType<typeof vi.spyOn>, handle: number): number {
  const calls = spy.mock.calls as readonly (readonly [number])[];
  return calls.filter(([candidate]) => candidate === handle).length;
}

describe('particle simulation lifecycle', () => {
  it('uses FixedTime boundaries for pause, scale validation, replay, and reset', async () => {
    const { world, player } = await setup();
    expect(world.update(0.1).ok).toBe(true);
    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    const beforePause = simulation.read(player);
    expect(beforePause?.tick).toBe(world.getResource(FixedTime).tick);

    world.set(player, ParticleEffectPlayer, { playing: false }).unwrap();
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.batches).toEqual(beforePause?.batches);

    world.set(player, ParticleEffectPlayer, { timeScale: -1 }).unwrap();
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.diagnostics[0]?.code).toBe('vfx-simulation-player-invalid');

    world.set(player, ParticleEffectPlayer, { timeScale: 1, playing: true }).unwrap();
    simulation.replay(player).unwrap();
    world.update(0.1).unwrap();
    expect(simulation.read(player)?.tick).toBe(world.getResource(FixedTime).tick);
    expect(simulation.reset(player).ok).toBe(true);
  });

  it('releases material and mesh outputs once across replacement, reset, and disappearance', async () => {
    const assets = {
      lookup: (guid: string) => ({ kind: guid === 'mesh-spark' ? 'mesh' : 'material', guid }),
    };
    const { world, player } = await setup(effect, assets);
    const releaseSpy = vi.spyOn(world.sharedRefs, 'release');
    const initialEffect = world.get(player, ParticleEffectPlayer).unwrap().effect;

    world.update(0.1).unwrap();
    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    const billboard = simulation.read(player)?.batches.batches[0];
    expect(billboard?.kind).toBe('billboard');
    if (billboard?.kind !== 'billboard') return;
    const billboardMaterial = billboard.material;

    const replacementEffect = world.allocSharedRef('ParticleEffectAsset', meshEffect);
    world.set(player, ParticleEffectPlayer, { effect: replacementEffect }).unwrap();
    world.update(0.1).unwrap();
    expect(releaseCount(releaseSpy, billboardMaterial)).toBe(1);
    const mesh = simulation.read(player)?.batches.batches[0];
    expect(mesh?.kind).toBe('mesh');
    if (mesh?.kind !== 'mesh') return;
    const meshMaterial = mesh.material;
    const meshAsset = mesh.mesh;

    simulation.replay(player).unwrap();
    world.update(0.1).unwrap();
    expect(releaseCount(releaseSpy, meshMaterial)).toBe(1);
    expect(releaseCount(releaseSpy, meshAsset)).toBe(1);
    const replayMesh = simulation.read(player)?.batches.batches[0];
    expect(replayMesh?.kind).toBe('mesh');
    if (replayMesh?.kind !== 'mesh') return;

    simulation.reset(player).unwrap();
    world.update(0.1).unwrap();
    expect(releaseCount(releaseSpy, replayMesh.material)).toBe(1);
    expect(releaseCount(releaseSpy, replayMesh.mesh)).toBe(1);
    const resetMesh = simulation.read(player)?.batches.batches[0];
    expect(resetMesh?.kind).toBe('mesh');
    if (resetMesh?.kind !== 'mesh') return;

    world.despawn(player).unwrap();
    world.update(0.1).unwrap();
    expect(releaseCount(releaseSpy, resetMesh.material)).toBe(1);
    expect(releaseCount(releaseSpy, resetMesh.mesh)).toBe(1);
    simulation.advance(world, []);
    expect(releaseCount(releaseSpy, resetMesh.material)).toBe(1);
    expect(releaseCount(releaseSpy, resetMesh.mesh)).toBe(1);
    expect(world.sharedRefs.refcount(billboardMaterial)).toBe(0);
    expect(world.sharedRefs.refcount(meshMaterial)).toBe(0);
    expect(world.sharedRefs.refcount(meshAsset)).toBe(0);
    expect(world.sharedRefs.refcount(replayMesh.material)).toBe(0);
    expect(world.sharedRefs.refcount(replayMesh.mesh)).toBe(0);
    expect(world.sharedRefs.refcount(resetMesh.material)).toBe(0);
    expect(world.sharedRefs.refcount(resetMesh.mesh)).toBe(0);
    world.sharedRefs.release(initialEffect);
    world.sharedRefs.release(replacementEffect);
  });
});
