// Reproduction of Bevy's `sprite` example: one image-backed Sprite.

import { createApp } from '@forgeax/engine-app';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpriteWorld, makeSpritePixels, SPRITE_SIZE } from './sprite';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-sprite] no usable backend:', error);
  } else {
    console.error('[bevy-sprite] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-sprite] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-sprite] backend=${app.renderer.backend}`);
  const pixels = makeSpritePixels();
  const texture = {
    kind: 'texture' as const,
    width: SPRITE_SIZE,
    height: SPRITE_SIZE,
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mipmap: false,
  };
  const handle = app.world.allocSharedRef('TextureAsset', texture);
  const upload = await app.renderer.store.uploadTexture(handle, texture, {
    bytes: pixels,
    width: SPRITE_SIZE,
    height: SPRITE_SIZE,
    mime: 'image/png',
    colorSpace: 'srgb',
    mipmap: false,
  });
  if (!upload.ok) {
    console.error('[bevy-sprite] texture upload failed:', upload.error.code, upload.error.hint);
    return;
  }
  buildSpriteWorld(app.world, unwrapHandle(handle));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-sprite] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  (globalThis as typeof globalThis & { __bevySpriteReady?: boolean }).__bevySpriteReady = true;
}
