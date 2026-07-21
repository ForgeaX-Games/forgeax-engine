// apps/bevy/shadow-biases — reproduce Bevy's `shadow_biases` example.
// Thin over existing DirectionalLight.depthBias/normalBias fields.
// 1/2 keys adjust depthBias, 3/4 keys adjust normalBias.

import { createApp } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { Handle } from '@forgeax/engine-types';
import {
  Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer,
  perspective, Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shadow-biases: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-shadow-biases] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) { console.error('[bevy-shadow-biases] createApp failed:', appResult.error); return; }
  const app = appResult.value;
  const world = app.world;

  const mat = world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5 }));

  // Ground plane
  world.spawn(
    { component: Transform, data: { pos: [0, -1.5, 0], quat: [0, 0, 0, 1], scale: [20, 0.02, 20] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [mat] } },
  );

  // Spheres above the plane
  for (let x = -5; x <= 5; x += 2) {
    world.spawn(
      { component: Transform, data: { pos: [x * 0.5, 0.5, 0], quat: [0, 0, 0, 1], scale: [0.3, 0.3, 0.3] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE as Handle<'MeshAsset', 'shared'> } },
      { component: MeshRenderer, data: { materials: [mat] } },
    );
  }

  const lightEntity = world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.8, -0.5], color: [1, 1, 1], intensity: 2, depthBias: 0.005, normalBias: 0.05 },
  }).unwrap();

  world.spawn(
    { component: Transform, data: { pos: [0, 2, 5] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  world.addSystem(Update, {
    name: 'shadow-bias-keys',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (!snap) return;
      const lightResult = world.get(lightEntity, DirectionalLight);
      if (!lightResult.ok) return;
      const light = lightResult.value;
      let db = light.depthBias, nb = light.normalBias;
      if (snap.keyboard.down('1')) { db = Math.max(0, db - 0.001); console.log(`depthBias=${db.toFixed(4)}`); }
      if (snap.keyboard.down('2')) { db += 0.001; console.log(`depthBias=${db.toFixed(4)}`); }
      if (snap.keyboard.down('3')) { nb = Math.max(0, nb - 0.01); console.log(`normalBias=${nb.toFixed(3)}`); }
      if (snap.keyboard.down('4')) { nb += 0.01; console.log(`normalBias=${nb.toFixed(3)}`); }
      if (db !== light.depthBias || nb !== light.normalBias) {
        world.set(lightEntity, DirectionalLight, { depthBias: db, normalBias: nb });
      }
    },
  });

  const started = app.start();
  if (!started.ok) { console.error('[bevy-shadow-biases] app.start() failed:', started.error); return; }
  console.warn('[bevy-shadow-biases] running. 1/2: depthBias, 3/4: normalBias.');
}
