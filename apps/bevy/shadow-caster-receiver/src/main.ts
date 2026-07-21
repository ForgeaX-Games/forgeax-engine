// apps/bevy/shadow-caster-receiver — reproduce Bevy's `shadow_caster_receiver` example.
// Red sphere casts shadow (default), blue sphere does NOT (castShadow:false), green plane.
// Thin over Materials.standard({ castShadow: false }).

import { createApp } from '@forgeax/engine-app';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { Handle } from '@forgeax/engine-types';
import {
  Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer,
  perspective, Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shadow-caster-receiver: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-shadow-caster-receiver] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) { console.error('[bevy-shadow-caster-receiver] createApp failed:', appResult.error); return; }
  const app = appResult.value;
  const world = app.world;

  const redMat = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.9, 0.2, 0.2, 1], metallic: 0, roughness: 0.5,
  }));
  const blueMat = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.2, 0.2, 0.9, 1], metallic: 0, roughness: 0.5, castShadow: false,
  }));
  const greenMat = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.2, 0.9, 0.2, 1], metallic: 0, roughness: 0.5,
  }));

  world.spawn(
    { component: Transform, data: { pos: [0, -1.5, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [greenMat] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [-1.5, 0.5, 0], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [redMat] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [1.5, 0.5, 0], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [blueMat] } },
  );

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.8, -0.5], color: [1, 1, 1], intensity: 2 },
  });

  world.spawn(
    { component: Transform, data: { pos: [0, 2, 5] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  const started = app.start();
  if (!started.ok) { console.error('[bevy-shadow-caster-receiver] app.start() failed:', started.error); return; }
  console.warn('[bevy-shadow-caster-receiver] running. Red casts shadow, blue does not.');
}