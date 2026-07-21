// apps/bevy/bloom — reproduce Bevy's `bloom_3d` example.
//
// Bevy source: emissive spheres in a dark scene with bloom post-processing.
// forgeax: emissive sphere + non-emissive cube, Space toggles Camera.bloom.
// Thin over existing BLOOM_ENABLED/BLOOM_DISABLED + hello/bloom surface.

import { createApp } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { Handle } from '@forgeax/engine-types';
import {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-bloom: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-bloom] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-bloom] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const world = app.world;

  const cubeMat = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.7, 0.7, 0.7, 1],
    metallic: 0,
    roughness: 0.4,
  }));

  const emissiveMat = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.9, 0.9, 0.9, 1],
    metallic: 0,
    roughness: 0.4,
    emissive: [50, 0, 0],
    emissiveIntensity: 1,
  }));

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [emissiveMat] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [1.5, 0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  );

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 1.5 },
  });

  const camEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, 6] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
        bloom: BLOOM_DISABLED,
      },
    },
  ).unwrap();

  let prevSpace = false;
  let currentBloom: number = BLOOM_DISABLED;
  world.addSystem(Update, {
    name: 'bloom-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (!snap) return;
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        currentBloom = currentBloom === BLOOM_ENABLED ? BLOOM_DISABLED : BLOOM_ENABLED;
        world.set(camEntity, Camera, { bloom: currentBloom });
      }
      prevSpace = cur;
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-bloom] app.start() failed:', started.error);
    return;
  }
  console.warn('[bevy-bloom] running. Press Space to toggle Bloom.');
}