import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  VolumetricFog,
  VolumetricFogSamplingValue,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createRenderer } from '../createRenderer';

it('renders overlapping local fog, independently removes owners, and retires the collection', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  canvas.style.cssText = 'width:128px;height:128px';
  document.body.append(canvas);
  const renderer = (
    await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' })
  ).unwrap();
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  try {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3.4] } },
        {
          component: Camera,
          data: {
            fov: 0.9,
            aspect: 1,
            near: 0.03,
            far: 20,
            tonemap: 1,
            clearColor: [0.12, 0.12, 0.12, 1],
          },
        },
      )
      .unwrap();
    const light = world
      .spawn({ component: DirectionalLight, data: { direction: [0, -1, -1], intensity: 1 } })
      .unwrap();
    const size = 32;
    const data = new Uint8Array(size ** 3);
    for (let z = 0; z < size; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const radius = Math.hypot(
            ((x + 0.5) / size) * 2 - 1,
            ((y + 0.5) / size) * 2 - 1,
            ((z + 0.5) / size) * 2 - 1,
          );
          data[(z * size + y) * size + x] = Math.round(255 * Math.max(0, 1 - radius) ** 0.6);
        }
    const texture: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '3d', extent: { width: size, height: size, depth: size } },
      format: 'r8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data,
    };
    const density = world.allocSharedRef('TextureAsset', texture);
    const spawn = (x: number, emission: readonly number[]) =>
      world
        .spawn({
          component: VolumetricFog,
          data: {
            light,
            density,
            sampling: VolumetricFogSamplingValue.density,
            boundsMin: [x - 0.9, -0.9, -0.6],
            boundsMax: [x + 0.9, 0.9, 1.2],
            extinction: [2, 2, 2],
            albedo: [0.25, 0.25, 0.25],
            emission,
            maxDistance: 20,
          },
        })
        .unwrap();
    const left = spawn(-0.4, [0.8, 0.08, 0.01]);
    const right = spawn(0.4, [0.01, 0.1, 0.8]);
    const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(0.12, 1.7, 0.15).unwrap());
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.8, 0.8, 0.8, 1]));
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1.3] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const lease = renderer.attach(world).unwrap();
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = renderer
        .draw({ leases: [lease], camera: { lease }, environment: { lease } })
        .unwrap();
      (await receipt.completed).unwrap();
    };
    for (let index = 0; index < 12; index++) await draw();
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'available',
      ownerCount: 2,
      passCount: 4,
    });
    const both = await page
      .elementLocator(canvas)
      .screenshot({ path: 'volume-multiple-both.png', base64: true });
    world.despawn(right).unwrap();
    for (let index = 0; index < 12; index++) await draw();
    expect(renderer.inspect().volumetricFog?.ownerCount).toBe(1);
    const one = await page
      .elementLocator(canvas)
      .screenshot({ path: 'volume-multiple-one.png', base64: true });
    expect(one).not.toEqual(both);
    world.despawn(left).unwrap();
    await draw();
    expect(renderer.inspect().volumetricFog).toMatchObject({ status: 'off', ownerCount: 0 });
    const clear = await page
      .elementLocator(canvas)
      .screenshot({ path: 'volume-multiple-clear.png', base64: true });
    expect(clear).not.toEqual(one);
    for (let index = 0; index < 12; index++) {
      const a = spawn(-0.4, [0.8, 0.08, 0.01]);
      const b = spawn(0.4, [0.01, 0.1, 0.8]);
      for (let frame = 0; frame < 25; frame++) await draw();
      expect(renderer.inspect().volumetricFog?.ownerCount).toBe(2);
      world.despawn(a).unwrap();
      world.despawn(b).unwrap();
      await draw();
      expect(renderer.inspect().volumetricFog).toMatchObject({
        status: 'off',
        ownerCount: 0,
        memoryBytes: 0,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    off();
    await renderer.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 600_000);
