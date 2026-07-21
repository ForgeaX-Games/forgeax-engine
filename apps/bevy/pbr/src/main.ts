// apps/bevy/pbr — reproduction of Bevy's `pbr` example.
//
// Bevy source (references/repos/bevy/examples/3d/pbr.rs):
// "This example shows how to configure Physically Based Rendering (PBR)
// parameters." 11×5 sphere grid with varying metallic/roughness +
// DirectionalLight + orthographic camera.
//
// forgeax mapping: thin over existing primitives — no engine gap.
//   - `Materials.standard({ metallic, roughness })` already exists
//   - `Materials.unlit()` already exists
//   - DirectionalLight + orthographic camera already exist

import { createRenderer } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildPbrWorld } from './pbr.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-pbr: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());
  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[bevy-pbr] renderer.ready failed:', ready.error);
    return;
  }

  const { World } = await import('@forgeax/engine-ecs');
  const world = new World();
  buildPbrWorld(world);

  const frame = (): void => {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[bevy-pbr] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

bootstrap(canvas).catch((err) => {
  console.error('[bevy-pbr] bootstrap error:', err);
});