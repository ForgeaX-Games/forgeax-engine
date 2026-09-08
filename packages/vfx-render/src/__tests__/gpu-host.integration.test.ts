import { World } from '@forgeax/engine-ecs';
import type { Asset, MaterialAsset } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  type VfxGpuTickIntent,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxRuntimeHost,
  PARTICLE_SHADER_IDENTIFIERS,
} from '../index.js';

describe('GPU VFX public host', () => {
  it('owns loader and FixedUpdate attachment without exposing simulation internals', async () => {
    const world = new World();
    const registered: unknown[] = [];
    const assets = {
      loaders: { registerPackLoader: (loader: unknown) => registered.push(loader) },
      lookup: () => undefined,
    };
    const host = createVfxRuntimeHost({
      camera: {
        read: () => ({
          position: new Float32Array(3),
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: new Float32Array(16),
        }),
      },
    });

    const attached = await host.attachWorld({ world, assets: assets as never });
    expect(attached).toMatchObject({ ok: true, value: { state: 'attached' } });
    expect(registered).toHaveLength(1);
    expect(host.feature.requiredMaterialShaders).toEqual(
      Object.values(PARTICLE_SHADER_IDENTIFIERS),
    );
    expect(await host.detachWorld({ world })).toMatchObject({
      ok: true,
      value: { state: 'detached' },
    });
  });

  it('preserves the asset registry receiver while planning a material projection', async () => {
    const world = new World();
    const lookups: string[] = [];
    class StatefulAssets {
      readonly material: MaterialAsset = {
        kind: 'material',
        passes: [{ name: 'particle-billboard', program: { module: 'custom-depth' } }],
      };
      readonly loaders = { registerPackLoader: () => {} };

      lookup<T extends Asset = Asset>(guid: string): T | undefined {
        if (this !== assets) throw new Error('asset registry receiver was lost');
        lookups.push(guid);
        return guid === 'material-guid' ? (this.material as T) : undefined;
      }
    }
    const assets = new StatefulAssets();
    const host = createVfxRuntimeHost({
      camera: {
        read: () => ({
          position: new Float32Array(3),
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        }),
      },
    });
    expect(await host.attachWorld({ world, assets })).toMatchObject({ ok: true });

    const intent = {
      player: world.spawn().unwrap(),
      fixedDelta: 1 / 60,
      phaseTick: 0,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      reset: true,
      channelInputs: [],
      emitter: {
        id: 'receiver-check',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// receiver check',
        reflection: { entryPoints: [], bindings: [] },
        renderers: [{ kind: 'billboard', material: 'material-guid' }],
      },
    } as unknown as VfxGpuTickIntent;
    const planned = host.feature.plan(
      {
        worlds: [
          {
            world,
            runtime: {
              isEmitterSessionEnabled: () => true,
              setEmitterCameraVisibility: () => {},
              markEventDispatched: () => {},
              commit: () => {},
            },
            camera: {
              position: new Float32Array(3),
              right: new Float32Array([1, 0, 0]),
              up: new Float32Array([0, 1, 0]),
              viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            },
            intents: [intent],
          },
        ],
        frameNumber: 1,
      } as never,
      {
        targets: [
          { name: 'scene-color', kind: 'color', format: 'rgba8unorm-srgb', sampleCount: 1 },
          { name: 'scene-depth', kind: 'depth', format: 'depth24plus', sampleCount: 1 },
        ],
        caps: {},
        frame: { frameNumber: 1 },
        generation: 1,
        materialShaderBindingContract: () => 'group-0-resource',
      } as never,
    );
    expect(planned.ok).toBe(true);
    expect(lookups).toEqual(['material-guid']);
    if (planned.ok) {
      expect(planned.value.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'graphics-bindings',
            values: expect.objectContaining({ sceneDepthBinding: 0 }),
            logicalTargets: { sceneDepth: 'scene-depth' },
          }),
        ]),
      );
    }
    await host.detachWorld({ world });
  });

  it('fences preview controls to one attached host generation', async () => {
    const world = new World();
    const assets = {
      loaders: { registerPackLoader: () => {} },
      lookup: () => undefined,
    };
    const host = createVfxRuntimeHost({ camera: { read: () => undefined } });
    expect(host.acquireControl(world)).toMatchObject({
      ok: false,
      error: { code: 'vfx-host-control-world-detached' },
    });

    expect(await host.attachWorld({ world, assets: assets as never })).toMatchObject({ ok: true });
    const acquired = host.acquireControl(world);
    expect(acquired).toMatchObject({ ok: true, value: { generation: 1 } });
    if (!acquired.ok) throw new Error(acquired.error.code);
    const effect = world.allocSharedRef('ParticleEffectAsset', {} as never);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();

    expect(
      acquired.value.setEmitterSessionEnabled({
        player,
        emitterId: 'sparks',
        enabled: false,
      }),
    ).toMatchObject({ ok: true, value: { state: 'disabled', generation: 1 } });
    expect(
      world
        .getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY)
        .isEmitterSessionEnabled(player, 'sparks'),
    ).toBe(false);
    expect(acquired.value.replay({ player })).toMatchObject({
      ok: true,
      value: { state: 'queued', generation: 1 },
    });
    expect(acquired.value.setPlayerRenderConsumption({ player, enabled: false })).toMatchObject({
      ok: true,
      value: { state: 'paused', generation: 1 },
    });
    expect(acquired.value.setPlayerRenderConsumption({ player, enabled: true })).toMatchObject({
      ok: true,
      value: { state: 'enabled', generation: 1 },
    });

    world.despawn(player).unwrap();
    expect(acquired.value.replay({ player })).toMatchObject({
      ok: false,
      error: {
        code: 'vfx-host-control-player-unavailable',
        detail: { player, requestedGeneration: 1, currentGeneration: 1 },
      },
    });

    expect(await host.detachWorld({ world })).toMatchObject({ ok: true });
    expect(await host.attachWorld({ world, assets: assets as never })).toMatchObject({ ok: true });
    expect(acquired.value.replay({ player })).toMatchObject({
      ok: false,
      error: {
        code: 'vfx-host-control-stale-generation',
        detail: { requestedGeneration: 1, currentGeneration: 2 },
      },
    });
    expect(host.acquireControl(world)).toMatchObject({ ok: true, value: { generation: 2 } });
  });

  it('declares every pending emitter program in one feature plan', () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const intent = (id: string): VfxGpuTickIntent => ({
      sequence: 1,
      player,
      emitter: {
        id,
        module: `${id}.vfx.wgsl`,
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'local',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: `// ${id}`,
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
        },
        renderers: [],
      },
      programFingerprint: id,
      reset: true,
      fixedDelta: 1 / 60,
      phaseTick: 0,
      tick: 0,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick: 0,
        generation: 0,
        sequence: 1,
        fingerprint: id,
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    const feature = gpuParticleRenderFeature({ camera: { read: () => undefined } });
    const planned = feature.plan(
      {
        worlds: [
          {
            world,
            runtime: {
              isEmitterSessionEnabled: () => true,
              setEmitterCameraVisibility: () => {},
              markEventDispatched: () => {},
              commit: () => {},
            },
            camera: {
              position: new Float32Array(3),
              right: new Float32Array([1, 0, 0]),
              up: new Float32Array([0, 1, 0]),
              viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            },
            intents: [intent('first'), intent('second')],
          },
        ],
        frameNumber: 1,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      planned.value.resources
        .filter((resource) => resource.kind === 'compute-program')
        .map((resource) => resource.name),
    ).toEqual([expect.stringContaining('.first.'), expect.stringContaining('.second.')]);
  });

  it('keeps masked bindings warm and sends effect-relative time to WGSL', () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const intent = (tick: number): VfxGpuTickIntent => ({
      sequence: tick + 1,
      player,
      emitter: {
        id: 'masked',
        module: 'masked.vfx.wgsl',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'local',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// masked',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
        },
        renderers: [],
      },
      programFingerprint: 'masked-program',
      reset: tick === 0,
      fixedDelta: 1 / 60,
      phaseTick: tick + 7,
      tick,
      seed: 1,
      playCycle: 0,
      spawnCount: tick === 0 ? 1 : 0,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick,
        generation: 0,
        sequence: tick + 1,
        fingerprint: 'masked-program',
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    let sessionEnabled = true;
    const runtime = {
      isEmitterSessionEnabled: () => sessionEnabled,
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {},
      commit: () => {},
    };
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array(16),
    };
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    const context = { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never;
    const frame = (intents: readonly VfxGpuTickIntent[], frameNumber: number) =>
      ({
        worlds: [{ world, runtime, camera, intents }],
        frameNumber,
      }) as never;

    const active = feature.plan(frame([intent(0)], 1), context);
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const runtimeWrite = active.value.resources.find(
      (resource) => resource.kind === 'buffer' && resource.name.endsWith('.runtime'),
    );
    expect(runtimeWrite?.kind === 'buffer' ? runtimeWrite.data : undefined).toBeInstanceOf(
      Uint8Array,
    );
    const runtimeBytes = runtimeWrite?.kind === 'buffer' ? runtimeWrite.data : undefined;
    expect(new Uint32Array((runtimeBytes as Uint8Array).buffer)[1]).toBe(7);
    sessionEnabled = false;
    const masked = feature.plan(frame([intent(1)], 2), context);
    expect(masked).toMatchObject({ ok: true, value: { resources: [], passes: [] } });
    sessionEnabled = true;
    const resumed = feature.plan(frame([intent(2)], 3), context);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.value.resources.length).toBeGreaterThan(0);
  });

  it('rejects a second host without replacing the first World runtime', async () => {
    const world = new World();
    const assets = {
      loaders: { registerPackLoader: () => {} },
      lookup: () => undefined,
    };
    const options = {
      camera: {
        read: () => undefined,
      },
    };
    const first = createVfxRuntimeHost(options);
    const second = createVfxRuntimeHost(options);
    expect(await first.attachWorld({ world, assets: assets as never })).toMatchObject({ ok: true });
    expect(await second.attachWorld({ world, assets: assets as never })).toMatchObject({
      ok: false,
      error: { code: 'vfx-host-world-attach-failed' },
    });
    expect(await first.detachWorld({ world })).toMatchObject({ ok: true });
  });

  it('keeps depth readiness on the host contract for a real renderer frame', () => {
    const host = createVfxRuntimeHost({
      camera: { read: () => undefined },
      providers: [
        createCameraProvider({ available: () => true }),
        createSceneDepthProvider({ available: () => true }),
      ],
    });
    const result = host.resolveDataInterfaces({
      requirements: [
        {
          token: 'vfx:scene-depth',
          kind: 'scene-depth',
          binding: 9,
          bindingType: 'sampled-depth',
          lifetime: 'generation',
        },
      ],
      generation: 1,
    });
    expect(result).toMatchObject({ ok: true, value: { readiness: 'ready' } });
  });

  it('returns an empty keyed inspection aggregate before a player is present', async () => {
    const world = new World();
    const assets = {
      loaders: { registerPackLoader: () => {} },
      lookup: () => undefined,
    };
    const host = createVfxRuntimeHost({ camera: { read: () => undefined } });
    await host.attachWorld({ world, assets: assets as never });

    expect(host.inspect(world)).toEqual({
      generation: 1,
      renderGeneration: 0,
      players: [],
      diagnostics: [],
    });
  });
});
