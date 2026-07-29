// Reproduction of Bevy's `sprite_animation` example.

import { createApp } from '@forgeax/engine-app';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { ATLAS_HEIGHT, ATLAS_WIDTH, buildSpriteAnimationWorld, makeAtlasPixels, tickSpriteAnimation } from './sprite-animation';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite-animation: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[bevy-sprite-animation] no usable backend:', err);
  else console.error('[bevy-sprite-animation] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) { console.error('[bevy-sprite-animation] createApp failed:', appResult.error); return; }
  const app = appResult.value;
  console.warn(`[bevy-sprite-animation] backend=${app.renderer.backend}`);
  const pixels = makeAtlasPixels();
  const texture = { kind: 'texture' as const, width: ATLAS_WIDTH, height: ATLAS_HEIGHT, format: 'rgba8unorm-srgb' as const, data: pixels, colorSpace: 'srgb' as const, mipmap: false };
  const handle = app.world.allocSharedRef('TextureAsset', texture);
  const upload = await app.renderer.store.uploadTexture(handle, texture, { bytes: pixels, width: ATLAS_WIDTH, height: ATLAS_HEIGHT, mime: 'image/png', colorSpace: 'srgb', mipmap: false });
  if (!upload.ok) { console.error('[bevy-sprite-animation] texture upload failed:', upload.error.code, upload.error.hint); return; }
  buildSpriteAnimationWorld(app.world, unwrapHandle(handle));
  app.world.addSystem(Update, { name: 'sprite-animation-tick', queries: [], fn: (world) => tickSpriteAnimation(world, world.getResource(Time).delta) });
  const started = app.start();
  if (!started.ok) { console.error('[bevy-sprite-animation] app.start failed:', started.error.code, started.error.hint); return; }
  (globalThis as typeof globalThis & { __bevySpriteAnimationReady?: boolean }).__bevySpriteAnimationReady = true;
}
