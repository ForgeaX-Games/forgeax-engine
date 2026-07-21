// apps/bevy/anti-aliasing — reproduce Bevy's `anti_aliasing` example.
//
// Bevy source: a 3D scene with multiple AA techniques (MSAA/FXAA/SMAA/TAA/DLSS) toggled
// via keyboard. forgeax has FXAA only (ANTIALIAS_FXAA / ANTIALIAS_NONE on Camera.antialias).
// Scene: 4 geometric shapes (triangle, cube, quad, sphere) spread horizontally under a
// slant directional light — the same scene as hello/fxaa, ported to the bevy-app convention.

import { createApp } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE, HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  Transform,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-anti-aliasing: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-anti-aliasing] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-anti-aliasing] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const world = app.world;

  const matHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.7, 0.7, 0.7, 1],
    metallic: 0,
    roughness: 0.4,
  }));

  // 4 geometric shapes spread horizontally — sharp edges make aliasing visible.
  const LAYOUT: readonly {
    readonly handle: typeof HANDLE_TRIANGLE;
    readonly pos: readonly [number, number, number];
  }[] = [
    { handle: HANDLE_TRIANGLE, pos: [-1.05, 0, 0] },
    { handle: HANDLE_CUBE, pos: [-0.35, 0, 0] },
    { handle: HANDLE_QUAD, pos: [0.35, 0, 0] },
    { handle: HANDLE_SPHERE, pos: [1.05, 0, 0] },
  ];
  for (const slot of LAYOUT) {
    world.spawn(
      { component: Transform, data: { pos: slot.pos, quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
      { component: MeshFilter, data: { assetHandle: slot.handle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
    );
  }

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 1.5 },
  });

  const camEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, 6] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }), antialias: ANTIALIAS_NONE } },
  ).unwrap();

  // Space toggle between FXAA ON / OFF.
  let prevSpace = false;
  let currentAA: number = ANTIALIAS_NONE;
  world.addSystem(Update, {
    name: 'aa-toggle',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = app.renderer.input.snapshot(world);
      if (!snap) return;
      const cur = snap.keyboard.down(' ');
      if (cur && !prevSpace) {
        currentAA = currentAA === ANTIALIAS_FXAA ? ANTIALIAS_NONE : ANTIALIAS_FXAA;
        world.set(camEntity, Camera, { antialias: currentAA });
      }
      prevSpace = cur;
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-anti-aliasing] app.start() failed:', started.error);
    return;
  }
  console.warn('[bevy-anti-aliasing] running. Press Space to toggle FXAA.');
}