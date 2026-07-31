import { createApp } from '@forgeax/engine-app';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTextureAtlasWorld, makeAtlas, type AtlasTexture } from './texture-atlas';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-texture-atlas: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-texture-atlas] no usable backend:', error);
  else console.error('[bevy-texture-atlas] bootstrap failed:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) { console.error('[bevy-texture-atlas] createApp failed:', appResult.error); return; }
  const app = appResult.value;
  console.warn(`[bevy-texture-atlas] backend=${app.renderer.backend}`);
  const atlases = [makeAtlas('unpadding'), makeAtlas('padding'), makeAtlas('unpadding'), makeAtlas('padding')];
  const variants: Array<{ texture: number; atlas: AtlasTexture }> = [];
  for (let index = 0; index < atlases.length; index += 1) {
    const atlas = atlases[index]!;
    const texture = { kind: 'texture' as const, width: atlas.size, height: atlas.size, format: 'rgba8unorm-srgb' as const, data: atlas.pixels, colorSpace: 'srgb' as const, mipmap: false };
    const textureHandle = app.world.allocSharedRef('TextureAsset', texture);
    const upload = await app.renderer.store.uploadTexture(textureHandle, texture, { bytes: atlas.pixels, width: atlas.size, height: atlas.size, mime: 'image/png', colorSpace: 'srgb', mipmap: false });
    if (!upload.ok) { console.error('[bevy-texture-atlas] texture upload failed:', upload.error.code, upload.error.hint); return; }
    variants.push({ texture: unwrapHandle(textureHandle), atlas });
  }
  buildTextureAtlasWorld(app.world, variants);
  const started = app.start();
  if (!started.ok) { console.error('[bevy-texture-atlas] app.start failed:', started.error); return; }
  (globalThis as typeof globalThis & { __bevyTextureAtlasReady?: boolean }).__bevyTextureAtlasReady = true;
}
