import { World } from '@forgeax/engine-ecs';
import { RenderFeaturePreparationFailedError } from '@forgeax/engine-render';
import { err } from '@forgeax/engine-types';
import type { VfxGpuTickIntent } from '@forgeax/engine-vfx';
import { describe, expect, it, vi } from 'vitest';
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
    expect(host.detachWorld({ world })).toMatchObject({ ok: true, value: { state: 'detached' } });
  });

  it('starts every pending emitter program in one prepare frame', () => {
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
    const prepareProgram = vi.fn((name: string) =>
      err(
        new RenderFeaturePreparationFailedError(
          'forgeax.vfx-render.gpu-particles',
          -1,
          'prepare-gpu-program',
          'pipeline',
          name,
          'rhi-not-available:compile pending',
          'next-frame',
        ),
      ),
    );
    const feature = gpuParticleRenderFeature({ camera: { read: () => undefined } });

    const prepared = feature.prepare(
      {
        worlds: [
          {
            world,
            runtime: {},
            camera: {},
            intents: [intent('first'), intent('second')],
          },
        ],
        frameNumber: 1,
      } as never,
      { gpu: { prepareProgram }, targets: [] } as never,
    );

    expect(prepared).toMatchObject({ ok: false, error: { detail: { recovery: 'next-frame' } } });
    expect(prepareProgram).toHaveBeenCalledTimes(2);
    expect(prepareProgram.mock.calls.map(([name]) => name)).toEqual([
      expect.stringContaining('.first.'),
      expect.stringContaining('.second.'),
    ]);
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
    expect(first.detachWorld({ world })).toMatchObject({ ok: true });
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

    expect(host.inspect(world)).toEqual({ generation: 1, players: [], diagnostics: [] });
  });
});
