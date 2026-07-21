// apps/bevy/lighting - reproduction of Bevy's `lighting` example.
//
// Static render — no per-frame animation needed. The 4 light types
// (PointLight, SpotLight, DirectionalLight, Skylight) compose correctly.

import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildLightingWorld } from './lighting';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-lighting: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-lighting] no usable backend:', err);
  } else {
    console.error('[bevy-lighting] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const renderer = await createRenderer(target, {}, forgeaxBundlerAdapter());

  const ready = await renderer.ready;
  if (!ready.ok) {
    console.error('[bevy-lighting] renderer.ready failed:', ready.error);
    return;
  }
  console.warn(`[bevy-lighting] backend=${renderer.backend}`);

  const world = new (await import('@forgeax/engine-ecs')).World();
  buildLightingWorld(world);

  const frame = (): void => {
    const r = renderer.draw([world], { owner: 0 });
    if (!r.ok) console.error('[bevy-lighting] draw error:', r.error);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}