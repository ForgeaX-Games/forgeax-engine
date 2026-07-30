import { createApp } from '@forgeax/engine-app';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import type { TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './shader-material.wgsl';
import { buildShaderMaterialWorld, makeTextureAsset, makeTexturePixels, TEXTURE_SIZE } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shader-material: missing <canvas id="app">');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!result.ok) {
    console.error('[bevy-shader-material] createApp failed:', result.error);
    return;
  }
  const app = result.value;
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
    console.error('[bevy-shader-material] texture upload failed:', upload.error.code, upload.error.hint);
    return;
  }
  if (!buildShaderMaterialWorld(app.world, unwrapHandle(textureHandle), target.width / Math.max(target.height, 1))) {
    console.error('[bevy-shader-material] scene construction failed');
    return;
  }
  app.onError((error) => console.error('[bevy-shader-material] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-shader-material] app.start failed:', started.error);
}
