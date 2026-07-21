// apps/bevy/spotlight - reproduction of Bevy's `spotlight` example.
//
// Static render — no per-frame animation needed. The 4 SpotLights with their
// cone angles produce the characteristic round light spots on the ground.

import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpotlightWorld } from './spotlight';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-spotlight: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-spotlight] no usable backend:', err);
  } else {
    console.error('[bevy-spotlight] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[bevy-spotlight] renderer.ready failed:', ready.error);
    return;
  }
  console.warn(`[bevy-spotlight] backend=${renderer.backend}`);

  const world = new (await import('@forgeax/engine-ecs')).World();
  buildSpotlightWorld(world);

  const frame = (): void => {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[bevy-spotlight] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}