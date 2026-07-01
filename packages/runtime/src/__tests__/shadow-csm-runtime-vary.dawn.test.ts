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
// best-effort: we do not pixel-readback (M3 atlas slot debugReadback was
// retuned in w28 transitional); the gate is "render loop completes
// without device error".

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Camera } from '../components/camera';
import { DirectionalLight } from '../components/directional-light';
import { Transform } from '../components/transform';
import { createRenderer } from '../createRenderer';

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify(ENGINE_MANIFEST),
)}`;

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

const WIDTH = 320;
const HEIGHT = 240;

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
      { component: Transform, data: { posY: 5, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
      { component: Camera, data: { fov: 1.0472, near: 0.1, far: 60 } },
    )
    .unwrap();
  const shadowEntity = world
    .spawn(
      {
        component: DirectionalLight,
        data: {
          directionX: 0,
          directionY: -1,
          directionZ: 0,
          colorR: 1,
          colorG: 1,
          colorB: 1,
          intensity: 1,
        },
      },
      {
        component: DirectionalLight,
        data: {
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
    const renderer = await createRenderer(
      canvas as unknown as HTMLCanvasElement,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    const { world, shadowEntity } = buildScene(4, 2048);

    expect(renderer.draw(world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: 2048,
      shadowDistance: 50,
      cascadeCount: 2,
    });
    expect(renderer.draw(world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: 2048,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect(renderer.draw(world).ok).toBe(true);
  });

  it('mapSize 2048 -> 1024 -> 2048 RT rebuild without device error', async () => {
    if (!dawnReady) return;
    const canvas = createMockCanvas();
    const renderer = await createRenderer(
      canvas as unknown as HTMLCanvasElement,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    const { world, shadowEntity } = buildScene(4, 2048);

    expect(renderer.draw(world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: 1024,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect(renderer.draw(world).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: 2048,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect(renderer.draw(world).ok).toBe(true);
  });

  it('cascadeCount=1 renders through the unified pathway (AC-10)', async () => {
    if (!dawnReady) return;
    const canvas = createMockCanvas();
    const renderer = await createRenderer(
      canvas as unknown as HTMLCanvasElement,
      {},
      { shaderManifestUrl: ENGINE_MANIFEST_URL },
    );
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    const { world } = buildScene(1, 1024);
    expect(renderer.draw(world).ok).toBe(true);
  });
});
