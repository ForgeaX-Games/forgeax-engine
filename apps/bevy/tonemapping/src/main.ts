// apps/bevy/tonemapping — reproduce Bevy's `tonemapping` example.
//
// Bevy source: compare different tonemapping methods on a 3D scene.
// forgeax: 3D scene with 1-7 keys cycling through 7 tonemap modes.
// Thin over existing TONEMAP_* constants + hello/tonemap surface.

import { createApp } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { Handle } from '@forgeax/engine-types';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const TONEMAP_MODES = [
  TONEMAP_NONE,
  TONEMAP_REINHARD_EXTENDED,
  TONEMAP_LINEAR,
  TONEMAP_CINEON,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_NEUTRAL,
];

const TONEMAP_NAMES = ['none', 'reinhard', 'linear', 'cineon', 'aces', 'agx', 'neutral'];

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-tonemapping: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-tonemapping] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-tonemapping] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const world = app.world;

  const matHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.8, 0.7, 0.6, 1], metallic: 0, roughness: 0.4,
  }));

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [1.5, 0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE as Handle<'MeshAsset', 'shared'> } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  );

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 2 },
  });

  const camEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, 6] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }), tonemap: TONEMAP_NONE } },
  ).unwrap();

  world.addSystem(Update, {
    name: 'tonemap-cycle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (!snap) return;
      for (let i = 0; i < TONEMAP_MODES.length; i++) {
        if (snap.keyboard.down(String(i + 1))) {
          const tonemap = TONEMAP_MODES[i];
          if (tonemap === undefined) continue;
          world.set(camEntity, Camera, { tonemap });
          console.log(`[tonemapping] mode: ${TONEMAP_NAMES[i]}`);
          break;
        }
      }
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-tonemapping] app.start() failed:', started.error);
    return;
  }
  console.warn('[bevy-tonemapping] running. Press 1-7 to cycle tonemap modes.');
}
