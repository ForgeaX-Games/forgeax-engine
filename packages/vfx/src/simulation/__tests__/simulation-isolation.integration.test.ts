import { World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import {
  type LoadedParticleEffect,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleCpuExecutorRegistry,
  ParticleEffectPlayer,
  type ParticleSimulation,
  particleSimulationPlugin,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const effect: LoadedParticleEffect = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [
    { id: 'good', capacity: 2 },
    { id: 'bad', capacity: 2 },
  ],
  program: {
    format: 'forgeax-vfx-program-1',
    emitters: ['good', 'bad'].map((id) => ({
      id,
      capacity: 2,
      space: 'world' as const,
      schedule: { rate: 10, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required' as const, backend: 'cpu' as const },
      backendPlan: { kind: 'cpu' as const, backends: ['cpu' as const] },
      operators: { spawn: [], initialize: [], update: [], output: [] },
      output: { kind: 'billboard' as const, material: `${id}-material` },
      programs: { cpu: [{ operator: 'update:fail:1', program: {} }] },
    })),
  },
};

const validEffect: LoadedParticleEffect = {
  ...effect,
  program: {
    ...effect.program,
    emitters: effect.program.emitters.map((emitter) => ({
      ...emitter,
      programs: { cpu: [] },
    })),
  },
};

describe('particle simulation failure isolation', () => {
  it('keeps a failing emitter from changing a valid emitter', async () => {
    const executors = new ParticleCpuExecutorRegistry([
      {
        stage: 'update',
        kind: 'fail',
        version: 1,
        validateProgram: () => ({ ok: true, value: undefined }),
        execute: ({ emitterId }) =>
          emitterId === 'bad'
            ? { ok: false, error: 'injected emitter failure' }
            : { ok: true, value: undefined },
      },
    ]);
    const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const first = world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle, seed: 1, timeScale: 1 } })
      .unwrap();
    const second = world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle, seed: 2, timeScale: 1 } })
      .unwrap();
    const plugins = await runPlugins(
      world,
      [],
      [
        particleSimulationPlugin({
          assets: { lookup: (guid: string) => ({ kind: 'material', guid }) },
          cpuExecutors: executors,
        }),
      ],
    );
    expect(plugins.ok).toBe(true);
    world.update(0.1).unwrap();

    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    const firstObservation = simulation.read(first);
    const secondObservation = simulation.read(second);
    expect(firstObservation?.emitters[0]?.status).toBe('ready');
    expect(firstObservation?.emitters[1]?.status).toBe('failed');
    expect(secondObservation?.emitters[0]?.status).toBe(firstObservation?.emitters[0]?.status);
    expect(secondObservation?.emitters[0]?.liveCount).toBe(
      firstObservation?.emitters[0]?.liveCount,
    );
    const diagnostic = secondObservation?.diagnostics[0];
    expect(diagnostic?.code).toBe('vfx-simulation-execution-failed');
    if (diagnostic?.code === 'vfx-simulation-execution-failed') {
      expect(diagnostic.detail.emitterId).toBe('bad');
    }
  });

  it('keeps another player ready when one effect reference becomes invalid', async () => {
    const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 1 } });
    const handle = world.allocSharedRef('ParticleEffectAsset', validEffect);
    const first = world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle, seed: 1, timeScale: 1 } })
      .unwrap();
    const second = world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle, seed: 2, timeScale: 1 } })
      .unwrap();
    const plugins = await runPlugins(
      world,
      [],
      [
        particleSimulationPlugin({
          assets: { lookup: (guid: string) => ({ kind: 'material', guid }) },
          cpuExecutors: new ParticleCpuExecutorRegistry(),
        }),
      ],
    );
    expect(plugins.ok).toBe(true);
    world.update(0.1).unwrap();

    const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
    const before = simulation.read(second);
    const beforeStatus = before?.emitters[0]?.status;
    const beforePosition =
      before?.batches.batches[0]?.kind === 'billboard'
        ? before.batches.batches[0].attributes.position[0]
        : undefined;
    const invalidHandle = world.allocSharedRef('ParticleEffectAsset', validEffect);
    world.sharedRefs.release(invalidHandle);
    simulation.advance(world, [
      { player: first, effect: invalidHandle, playing: true, seed: 1, timeScale: 1 },
      { player: second, effect: handle, playing: true, seed: 2, timeScale: 1 },
    ]);

    const firstAfter = simulation.read(first);
    const secondAfter = simulation.read(second);
    expect(firstAfter?.emitters[0]?.status).toBe('failed');
    expect(firstAfter?.batches.batches).toEqual([]);
    expect(secondAfter?.emitters[0]?.status).toBe(beforeStatus);
    expect(secondAfter?.diagnostics).toEqual([]);
    if (secondAfter?.batches.batches[0]?.kind === 'billboard') {
      expect(secondAfter.batches.batches[0].attributes.position[0]).toBe(beforePosition);
    } else {
      throw new Error('valid player lost its billboard output');
    }
    world.sharedRefs.release(handle);
  });
});
