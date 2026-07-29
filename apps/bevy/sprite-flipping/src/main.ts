// apps/bevy/sprite-flipping/src/main.ts — reproduction of Bevy's `sprite_flipping` example.
//
// Bevy source (references/repos/bevy/examples/2d/sprite_flipping.rs): one sprite
// rendered with the normal, horizontal-flip, and vertical-flip orientations.

import { createApp } from '@forgeax/engine-app';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpriteFlippingWorld, SPRITE_SIZE, makeSpritePixels } from './texture';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite-flipping: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-sprite-flipping] no usable backend:', err);
  } else {
    console.error('[bevy-sprite-flipping] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-sprite-flipping] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-sprite-flipping] backend=${app.renderer.backend}`);

  const spritePixels = makeSpritePixels();
  const texPod = {
    kind: 'texture' as const,
    width: SPRITE_SIZE,
    height: SPRITE_SIZE,
    format: 'rgba8unorm-srgb' as const,
    data: spritePixels,
    colorSpace: 'srgb' as const,
    mipmap: false,
  };
  const texHandle = app.world.allocSharedRef('TextureAsset', texPod);
  const texId = unwrapHandle(texHandle);

  const uploadRes = await app.renderer.store.uploadTexture(texHandle, texPod, {
    bytes: spritePixels,
    width: SPRITE_SIZE,
    height: SPRITE_SIZE,
    mime: 'image/png',
    colorSpace: 'srgb',
    mipmap: false,
  });
  if (!uploadRes.ok) {
    console.error('[bevy-sprite-flipping] texture upload failed:', uploadRes.error.code, uploadRes.error.hint);
    return;
  }

  buildSpriteFlippingWorld(app.world, texId);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-sprite-flipping] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  (globalThis as typeof globalThis & { __bevySpriteFlippingReady?: boolean }).__bevySpriteFlippingReady = true;
}
