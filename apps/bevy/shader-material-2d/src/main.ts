import { createApp } from '@forgeax/engine-app';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import type { TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './shader-material-2d.wgsl';
import { buildShaderMaterial2dWorld, makeTextureAsset, makeTexturePixels, TEXTURE_SIZE } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shader-material-2d: missing <canvas id="app">');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!appResult.ok) {
    console.error('[bevy-shader-material-2d] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const pixels = makeTexturePixels();
  const texture = makeTextureAsset(pixels);
  const textureHandle = app.world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', texture);
  const upload = await app.renderer.store.uploadTexture(textureHandle, texture, {
    bytes: pixels,
    width: TEXTURE_SIZE,
    height: TEXTURE_SIZE,
    mime: 'image/png',
    colorSpace: 'srgb',
    mipmap: false,
  });
  if (!upload.ok) {
    console.error('[bevy-shader-material-2d] texture upload failed:', upload.error.code, upload.error.hint);
    return;
  }
  buildShaderMaterial2dWorld(app.world, unwrapHandle(textureHandle), target.width / Math.max(target.height, 1));
  app.onError((error) => console.error('[bevy-shader-material-2d] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-shader-material-2d] app.start failed:', started.error);
    return;
  }
  (globalThis as { __bevyShaderMaterial2dReady?: boolean }).__bevyShaderMaterial2dReady = true;
}
