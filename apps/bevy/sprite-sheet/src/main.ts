// Reproduction of Bevy's `sprite_sheet` example.

import { createApp } from '@forgeax/engine-app';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpriteSheetWorld, makeSpriteSheetPixels, SHEET_HEIGHT, SHEET_WIDTH, tickSpriteSheet } from './sprite-sheet';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite-sheet: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-sprite-sheet] no usable backend:', error);
  else console.error('[bevy-sprite-sheet] bootstrap failed:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) { console.error('[bevy-sprite-sheet] createApp failed:', appResult.error); return; }
  const app = appResult.value;
  console.warn(`[bevy-sprite-sheet] backend=${app.renderer.backend}`);
  const pixels = makeSpriteSheetPixels();
  const texture = { kind: 'texture' as const, width: SHEET_WIDTH, height: SHEET_HEIGHT, format: 'rgba8unorm-srgb' as const, data: pixels, colorSpace: 'srgb' as const, mipmap: false };
  const textureHandle = app.world.allocSharedRef('TextureAsset', texture);
  const upload = await app.renderer.store.uploadTexture(textureHandle, texture, { bytes: pixels, width: SHEET_WIDTH, height: SHEET_HEIGHT, mime: 'image/png', colorSpace: 'srgb', mipmap: false });
  if (!upload.ok) { console.error('[bevy-sprite-sheet] texture upload failed:', upload.error.code, upload.error.hint); return; }
  buildSpriteSheetWorld(app.world, unwrapHandle(textureHandle));
  app.world.addSystem(Update, { name: 'sprite-sheet-tick', queries: [], fn: (world) => tickSpriteSheet(world, world.getResource(Time).delta) });
  const started = app.start();
  if (!started.ok) { console.error('[bevy-sprite-sheet] app.start failed:', started.error); return; }
  (globalThis as typeof globalThis & { __bevySpriteSheetReady?: boolean }).__bevySpriteSheetReady = true;
}
