import { readFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import { describe, expect, it } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import type { VfxGpuEffectAsset } from '../gpu-program.js';
import {
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '../gpu-runtime.js';
import { ParticleEffectInstance } from '../instance.js';
import { ParticleEffectPlayer } from '../player.js';

const effect: VfxGpuEffectAsset = {
  guid: 'effect-guid',
  kind: 'particle-effect',
  schemaVersion: 2,
  programFingerprint: 'sha256:test',
  emitters: [{ id: 'sparks', capacity: 100_000 }],
  program: {
    format: 'forgeax-vfx-program-2',
    fingerprint: 'sha256:test',
    emitters: [
      {
        id: 'sparks',
        module: 'sparks.vfx.wgsl',
        capacity: 100_000,
        backend: { required: 'gpu' },
        space: 'world',
        schedule: { rate: 60, bursts: [{ time: 0, count: 7 }], loopDuration: 1 },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
        renderers: [{ kind: 'billboard', material: 'material-guid' }],
        simulationWhenCulled: 'continue',
        wgsl: 'cooked',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: [],
          bindings: [],
        },
      },
    ],
  },
};

describe('GPU VFX fixed-tick intents', () => {
  it('keeps stage recovery scoped to the cooked generation', () => {
    const source = readFileSync(new URL('../gpu-runtime.ts', import.meta.url), 'utf8');
    expect(source).toContain('instanceGeneration');
    expect(source).not.toContain('runtimeCompiler');
  });

  it('uploads channel inputs with the fixed tick and isolates per-player overflow', async () => {
    const channelEffect = structuredClone(effect) as VfxGpuEffectAsset;
    const channelEmitters = channelEffect.program.emitters as unknown as Array<
      Record<string, unknown>
    >;
    channelEmitters[0] = {
      ...channelEmitters[0],
      channels: [{ id: 'impact', capacity: 1, overflow: 'drop-newest' }],
      events: [
        {
          id: 'impact-event',
          channel: 'impact',
          subEmitter: 'sparks',
          fanOut: 1,
          recursionDepth: 1,
        },
      ],
    };
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', channelEffect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin({ maxQueuedTicks: 2 })]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    world.update(1 / 60).unwrap();
    const instance = runtime.getInstance(player);
    expect(instance).toBeDefined();
    if (instance === undefined) return;
    const first = (instance as unknown as { submit(input: unknown): { ok: boolean } }).submit({
      channel: 'impact',
      payload: { position: [0, 1, 0], strength: 1 },
      sequence: 1,
    });
    const second = (instance as unknown as { submit(input: unknown): { ok: boolean } }).submit({
      channel: 'impact',
      payload: { position: [0, 1, 0], strength: 1 },
      sequence: 2,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot().find((intent) => intent.channelInputs.length > 0)).toMatchObject({
      channelInputs: [{ channel: 'impact' }],
    });
  });

  it('publishes multiple same-tick patches as one atomic instance generation', async () => {
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    const contract = createVfxEffectContract({
      version: 1,
      parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
      custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
      fingerprint: 'sha256:atomic-patch',
    });
    const instance = new ParticleEffectInstance(contract);
    const installed = await runPlugins(world, [], [vfxGpuRuntimePlugin()]);
    expect(installed.ok).toBe(true);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    runtime.attachInstance(player, instance);
    expect(instance.patch({}).ok).toBe(true);
    expect(instance.patch({}).ok).toBe(true);

    world.update(1 / 60).unwrap();

    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]).toMatchObject({
      tick: 1,
      instanceGeneration: 1,
      instancePatchCount: 2,
    });
    expect(runtime.snapshot()[0]?.canonicalPayload).toBeInstanceOf(Uint8Array);
  });

  it('drops stale instances at a new render generation and restarts from authored state', async () => {
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 60).unwrap();
    const stale = runtime.getInstance(player);
    expect(stale).toBeDefined();
    expect(runtime.renderGeneration).toBe(0);

    runtime.recover();

    expect(runtime.renderGeneration).toBe(1);
    expect(runtime.hasPlayer(player)).toBe(false);
    expect(runtime.getInstance(player)).toBeUndefined();
    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.lastCommitted(player)).toBeUndefined();

    expect(stale?.patch({}).ok).toBe(true);
    world.update(1 / 60).unwrap();
    const restarted = runtime.getInstance(player);
    expect(restarted).toBeDefined();
    expect(restarted).not.toBe(stale);
    expect(runtime.inspectPlayer(player)?.values.generation).toBe(0);

    expect(restarted?.patch({}).ok).toBe(true);
    world.update(1 / 60).unwrap();
    expect(runtime.inspectPlayer(player)?.values.generation).toBe(1);
  });

  it('fires time-zero once and keeps tick commands bounded and ordered', async () => {
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const spawned = world.spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
    });
    expect(spawned.ok).toBe(true);
    const installed = await runPlugins(world, [], [vfxGpuRuntimePlugin({ maxQueuedTicks: 2 })]);
    expect(installed.ok).toBe(true);

    expect(world.update(1 / 60).ok).toBe(true);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]).toMatchObject({ reset: true, spawnCount: 8, firstParticleId: 0 });
    runtime.commit(runtime.snapshot().at(0)?.sequence ?? -1);

    expect(world.update(1 / 60).ok).toBe(true);
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]).toMatchObject({
      reset: false,
      spawnCount: 1,
      firstParticleId: 8,
    });
  });

  it('replays an authored stopped player without mutating author intent', async () => {
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: false, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(0);

    runtime.replay(player);
    world.update(1 / 60).unwrap();

    expect(runtime.snapshot()[0]).toMatchObject({
      player,
      reset: true,
      phaseTick: 0,
      spawnCount: 8,
      firstParticleId: 0,
    });
    expect(world.get(player, ParticleEffectPlayer).unwrap().playing).toBe(false);

    runtime.commit(runtime.snapshot().at(0)?.sequence ?? -1);
    world.update(1 / 60).unwrap();

    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.inspectPlayer(player)?.playing).toBe(false);
  });

  it('holds time during cold GPU preparation, then diagnoses post-start backpressure', async () => {
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin({ maxQueuedTicks: 1 })]);
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.diagnostics()).toHaveLength(0);
    runtime.commit(runtime.snapshot().at(0)?.sequence ?? -1);
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.diagnostics().at(-1)?.code).toBe('vfx-intent-queue-overflow');
    runtime.commit(runtime.snapshot().at(-1)?.sequence ?? -1);
    expect(runtime.diagnostics()).toEqual([]);
  });

  it('bounds each player independently', async () => {
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const first = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 2, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin({ maxQueuedTicks: 1 })]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(2);
    expect(runtime.snapshot().map((intent) => intent.player)).toContain(first);
  });

  it('inspects every player and emitter by stable runtime identity', async () => {
    const multiEmitter = structuredClone(effect) as VfxGpuEffectAsset;
    const firstEmitter = multiEmitter.program.emitters[0];
    expect(firstEmitter).toBeDefined();
    if (firstEmitter === undefined) return;
    const secondEmitter = {
      ...firstEmitter,
      id: 'smoke',
      module: 'smoke.vfx.wgsl',
      capacity: 64,
      renderers: [
        { kind: 'trail' as const, material: 'smoke-material', historyLength: 4, capacity: 64 },
      ],
    };
    (multiEmitter.program.emitters as VfxGpuEffectAsset['program']['emitters'][number][]).push(
      secondEmitter,
    );
    (multiEmitter.emitters as { id: string; capacity: number }[]).push({
      id: 'smoke',
      capacity: 64,
    });
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', multiEmitter);
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
    await runPlugins(world, [], [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    expect(runtime.inspectPlayers()).toEqual([
      expect.objectContaining({
        player: first,
        assetGuid: 'effect-guid',
        programFingerprint: 'sha256:test',
        emitters: [
          expect.objectContaining({
            id: 'sparks',
            module: 'sparks.vfx.wgsl',
            cameraVisible: true,
            sessionEnabled: true,
            phaseTick: 0,
          }),
          expect.objectContaining({
            id: 'smoke',
            module: 'smoke.vfx.wgsl',
            cameraVisible: true,
            sessionEnabled: true,
            phaseTick: 0,
          }),
        ],
      }),
      expect.objectContaining({ player: second }),
    ]);

    runtime.setEmitterCameraVisibility(first, 'smoke', false);
    expect(runtime.inspectPlayer(first)?.emitters[1]).toMatchObject({
      id: 'smoke',
      cameraVisible: false,
      sessionEnabled: true,
    });
    expect(runtime.inspectPlayer(999 as never)).toBeUndefined();
  });

  it('clears player and effect diagnostics after authored state recovers', async () => {
    const world = new World();
    const unavailable = world.allocSharedRef('ParticleEffectAsset', {
      ...effect,
      schemaVersion: 1,
    } as never);
    const available = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: unavailable, playing: true, seed: 3, timeScale: -1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics().map((diagnostic) => diagnostic.code)).toEqual([
      'vfx-player-invalid',
    ]);

    world.set(player, ParticleEffectPlayer, { timeScale: 1 }).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics().map((diagnostic) => diagnostic.code)).toEqual([
      'vfx-effect-unavailable',
    ]);

    world.set(player, ParticleEffectPlayer, { effect: available }).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics()).toEqual([]);
  });

  it.each([
    ['pause', false, 8],
    ['restart-on-visible', true, 0],
  ] as const)('%s applies culling lifecycle at fixed-tick boundaries', async (policy, reset, firstParticleId) => {
    const world = new World();
    const policyEffect = structuredClone(effect) as VfxGpuEffectAsset;
    (policyEffect.program.emitters[0] as { simulationWhenCulled: string }).simulationWhenCulled =
      policy;
    const handle = world.allocSharedRef('ParticleEffectAsset', policyEffect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    runtime.commit(runtime.snapshot().at(0)?.sequence ?? -1);

    runtime.setEmitterCameraVisibility(player, 'sparks', false);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);

    runtime.setEmitterCameraVisibility(player, 'sparks', true);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({
      reset,
      firstParticleId,
      phaseTick: reset ? 0 : 1,
    });
  });

  it('keeps editor session masks independent from camera culling and authored enablement', async () => {
    const world = new World();
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 4, timeScale: 1 },
      })
      .unwrap();
    await runPlugins(world, [], [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    runtime.commit(runtime.snapshot().at(0)?.sequence ?? -1);

    runtime.setEmitterSessionEnabled(player, 'sparks', false);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.inspectPlayer(player)?.emitters[0]).toMatchObject({
      cameraVisible: true,
      sessionEnabled: false,
      phaseTick: 0,
    });

    runtime.setEmitterCameraVisibility(player, 'sparks', false);
    runtime.setEmitterSessionEnabled(player, 'sparks', true);
    expect(runtime.isEmitterSessionEnabled(player, 'sparks')).toBe(true);
    expect(runtime.inspectPlayer(player)?.emitters[0]).toMatchObject({
      cameraVisible: false,
      sessionEnabled: true,
    });

    runtime.setEmitterCameraVisibility(player, 'sparks', true);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({ reset: false, phaseTick: 1 });
  });
});
