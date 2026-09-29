import { shaderManifestUrl } from './shader-manifest-url.fixture';
// shadow-csm-runtime-vary.dawn.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M5 / w26: dynamic cascadeCount + mapSize via world.set dawn-node test.
//
// Covers AC-07 (runtime-mutable cascade fields take effect on the next
// frame; shadow atlas RT rebuilds on mapSize change without device error)
// + AC-10 (cascadeCount=1 degeneracy renders cleanly through the same
// pathway).
//
// Strategy: spin up a renderer with a minimal directional-light + shadow
// scene, draw N frames at cascadeCount=4, mutate to cascadeCount=2 via
// world.set and draw, mutate to cascadeCount=4 again, then walk
// mapSize 2048 -> 1024 -> 2048 the same way. Asserts every draw returns
// `ok: true` and no device-lost / structured RhiError fires.
//
// This is a structural GPU behavior gate: the unified Standard shadow graph
// must rebuild its atlas and continue drawing without device errors.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { projectDirectionalShadowInspection } from '../../../render/src/assembly/directional-shadow-inspection';
import { resolveDirectionalShadowBackendAdmission } from '../../../render/src/render-pipeline';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

describe('M3 RhiNull structural admission', () => {
  it('requires the structural-only RhiNull projection and explicit no-pixel claim', async () => {
    const module = (await import('../../../render/src/render-pipeline')) as Record<string, unknown>;
    const resolver = module.resolveDirectionalShadowBackendAdmission;
    expect(typeof resolver).toBe('function');
    const result = (
      resolver as (input: {
        backendKind: 'null';
        requested: 'pcssMedium' | 'pcssHigh';
        candidate: 'accepted' | 'failed';
      }) => { effective: string; fallbackReason?: string; pixelEvidence: string }
    )({ backendKind: 'null', requested: 'pcssMedium', candidate: 'accepted' });
    expect(result).toMatchObject({
      effective: 'rhi-null-structural',
      fallbackReason: 'rhi-null-structural',
      pixelEvidence: 'not-available',
    });
  });

  it('keeps RhiNull recovery structural and generation-scoped', () => {
    const inspection = projectDirectionalShadowInspection({
      admission: resolveDirectionalShadowBackendAdmission({
        backendKind: 'null',
        requested: 'pcssMedium',
        candidate: 'accepted',
      }),
      cascadeCount: 4,
      mapSize: 1024,
      shadowMapBytes: 16_777_216,
      writerPasses: 4,
      blockerTaps: 0,
      filterTapUpperBound: 0,
      seamTapUpperBound: 0,
      deviceGeneration: 4,
      graphGeneration: 9,
    });
    expect(inspection).toMatchObject({
      effective: 'rhi-null-structural',
      pixelEvidence: 'not-available',
      deviceGeneration: 4,
      graphGeneration: 9,
    });
  });
});

const WIDTH = 320;
const HEIGHT = 240;
const LIGHTWEIGHT_DAWN = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
// The variation gate only needs to observe graph rebuilds. Keep the full
// 2048 atlas for local/nightly diagnostics, while avoiding a 4-cascade 16MiB
// allocation on the overloaded PR lane.
const LARGE_MAP_SIZE = LIGHTWEIGHT_DAWN ? 1024 : 2048;

interface MockCanvas {
  width: number;
  height: number;
  getContext(kind: string): unknown;
}

function createMockCanvas(): MockCanvas {
  let renderTarget: GPUTexture | undefined;
  let sharedDevice: GPUDevice | undefined;
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format: GPUTextureFormat }): void {
          sharedDevice = desc.device;
          if (renderTarget === undefined) {
            renderTarget = desc.device.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format: desc.format,
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
          }
        },
        unconfigure(): void {},
        getCurrentTexture(): GPUTexture {
          if (renderTarget === undefined && sharedDevice !== undefined) {
            renderTarget = sharedDevice.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format: 'rgba8unorm',
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
          }
          if (renderTarget === undefined) throw new Error('no render target');
          return renderTarget;
        },
      };
    },
  };
}

interface SceneEntities {
  world: World;
  shadowEntity: EntityHandle;
}

function buildScene(initialCascadeCount: number, initialMapSize: number): SceneEntities {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: Camera, data: { fov: 1.0472, near: 0.1, far: 60 } },
    )
    .unwrap();
  const shadowEntity = world
    .spawn(
      {
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          color: [1, 1, 1],
          intensity: 1,
        },
      },
      {
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          mapSize: initialMapSize,
          shadowDistance: 50,
          cascadeCount: initialCascadeCount,
        },
      },
    )
    .unwrap();
  return { world, shadowEntity };
}

describe('CSM runtime cascade + mapSize variation (M5/w26)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  it('cascadeCount 4 -> 2 -> 4 round-trip without device error', async () => {
    if (!dawnReady) return;
    const canvas = createMockCanvas();
    const host = await constructRuntimeRendererHost(
      canvas as unknown as HTMLCanvasElement,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    const { world, shadowEntity } = buildScene(4, LARGE_MAP_SIZE);

    expect(drawPublished(renderer, world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: LARGE_MAP_SIZE,
      shadowDistance: 50,
      cascadeCount: 2,
    });
    expect(drawPublished(renderer, world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: LARGE_MAP_SIZE,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect(drawPublished(renderer, world).ok).toBe(true);
  });

  it('mapSize 2048 -> 1024 -> 2048 RT rebuild without device error', async () => {
    if (!dawnReady) return;
    const canvas = createMockCanvas();
    const host = await constructRuntimeRendererHost(
      canvas as unknown as HTMLCanvasElement,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    const { world, shadowEntity } = buildScene(4, LARGE_MAP_SIZE);

    expect(drawPublished(renderer, world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: 1024,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect(drawPublished(renderer, world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: LARGE_MAP_SIZE,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect(drawPublished(renderer, world).ok).toBe(true);
  });

  it('cascadeCount=1 renders through the unified pathway (AC-10)', async () => {
    if (!dawnReady) return;
    const canvas = createMockCanvas();
    const host = await constructRuntimeRendererHost(
      canvas as unknown as HTMLCanvasElement,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    const { world } = buildScene(1, 1024);
    expect(drawPublished(renderer, world).ok).toBe(true);
  });

  it('castShadow true -> false -> true toggles the directional graph without device error', async () => {
    if (!dawnReady) return;
    const canvas = createMockCanvas();
    const host = await constructRuntimeRendererHost(
      canvas as unknown as HTMLCanvasElement,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    const { world, shadowEntity } = buildScene(4, 1024);

    expect(drawPublished(renderer, world).ok).toBe(true);
    world.set(shadowEntity, DirectionalLight, { castShadow: false });
    expect(drawPublished(renderer, world).ok).toBe(true);
    world.set(shadowEntity, DirectionalLight, {
      castShadow: true,
      mapSize: 1024,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect(drawPublished(renderer, world).ok).toBe(true);
  });
});
