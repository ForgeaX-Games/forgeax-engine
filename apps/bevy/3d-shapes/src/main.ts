// apps/bevy/3d-shapes - reproduction of Bevy's `3d_shapes` example.
//
// Bevy source (references/repos/bevy/examples/3d/3d_shapes.rs): a row of shape
// primitives generated from Bevy's shape primitives (Cuboid / Sphere / Cylinder
// / Capsule3d / Torus / Cone / …), each meshed and placed along X, lit and
// viewed from a fixed camera.
//
// forgeax mapping: exercises all 7 @forgeax/engine-geometry factories — the
// new createCapsuleGeometry (solo round 20260713-153135) sits at the row center.
// The scene recipe is the shared SSOT builder in src/shapes.ts so this app and
// the headless dawn smoke render the identical World (memory
// smoke-script-duplicate-scene-must-stay-in-sync-with-main).

import { World } from '@forgeax/engine-ecs';
import {
  acquireCanvasContext,
  createRenderer,
  EngineEnvironmentError,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildShapesWorld } from './shapes';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-3d-shapes: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-3d-shapes] no usable backend:', err);
  } else {
    console.error('[bevy-3d-shapes] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());

  const ctxResult = acquireCanvasContext(target);
  if (ctxResult.ok) {
    const cfgResult = ctxResult.value.configure({
      device: renderer.device,
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    });
    if (!cfgResult.ok) console.error('[bevy-3d-shapes] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.warn('[bevy-3d-shapes] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[bevy-3d-shapes] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[bevy-3d-shapes] renderer.ready failed:', ready.error);
    return;
  }

  const world = new World();
  const placed = buildShapesWorld(world);
  console.warn(`[bevy-3d-shapes] placed ${placed} shapes`);

  const frame = (): void => {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[bevy-3d-shapes] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
