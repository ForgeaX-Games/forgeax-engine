// apps/bevy/orthographic — reproduction of Bevy's `orthographic` example.
//
// Bevy source (references/repos/bevy/examples/3d/orthographic.rs):
// "Shows how to create a 3D orthographic view (for isometric-look games or CAD
// applications)." Green plane + 4 brown cubes + PointLight, orthographic camera.
//
// forgeax mapping (thin over existing primitives — no engine gap):
//   - orthographic projection already exists (Camera + orthographic())
//   - scene uses standard PBR materials + PointLight + HANDLE_CUBE

import { World } from '@forgeax/engine-ecs';
import {
  acquireCanvasContext,
  createRenderer,
  EngineEnvironmentError,
} from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildOrthographicWorld } from './orthographic.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-orthographic: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-orthographic] no usable backend:', err);
  } else {
    console.error('[bevy-orthographic] bootstrap error:', err);
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
    if (!cfgResult.ok) console.error('[bevy-orthographic] canvasContext.configure failed:', cfgResult.error);
  } else {
    console.warn('[bevy-orthographic] acquireCanvasContext failed:', ctxResult.error);
  }
  console.warn(`[bevy-orthographic] backend=${renderer.backend}`);

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[bevy-orthographic] renderer.ready failed:', ready.error);
    return;
  }

  const world = new World();
  buildOrthographicWorld(world);

  const frame = (): void => {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[bevy-orthographic] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}