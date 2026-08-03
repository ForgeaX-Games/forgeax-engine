import { createApp } from '@forgeax/engine-app';
import { Time, Update } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createDevImportTransport, EngineEnvironmentError } from '@forgeax/engine-runtime';
import type { FontAsset, Handle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildText2dWorld, registerSharedSampler, stepText2d } from './text2d';

const FONT_GUID = '019eb276-4d96-7f2c-9ecf-5124a020eebb';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-text2d: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-text2d] no usable backend:', error);
  else console.error('[bevy-text2d] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() },
  );
  if (!result.ok) {
    console.error('[bevy-text2d] createApp failed:', result.error);
    return;
  }

  const app = result.value;
  const assets = app.renderer.assets;
  assets.configurePackIndex('/pack-index.json');
  registerSharedSampler(assets);
  const parsed = AssetGuid.parse(FONT_GUID);
  if (!parsed.ok) {
    console.error('[bevy-text2d] FONT_GUID parse failed:', parsed.error.code);
    return;
  }
  const font = await assets.loadByGuid<FontAsset>(parsed.value);
  if (!font.ok) {
    console.error('[bevy-text2d] font load failed:', font.error.code, font.error.hint);
    return;
  }

  const fontHandle: Handle<'FontAsset', 'shared'> = app.world.allocSharedRef('FontAsset', font.value);
  const scene = buildText2dWorld(app.world, fontHandle);
  app.world.addSystem(Update, {
    name: 'text2d-motion',
    queries: [],
    fn: (world) => stepText2d(world, scene, world.hasResource(Time) ? world.getResource(Time).delta : 0),
  });
  app.onError((error) => console.error('[bevy-text2d] app error:', error.code, error.hint));
  console.info(`[bevy-text2d] backend=${app.renderer.backend}`);
  const started = app.start();
  if (!started.ok) console.error('[bevy-text2d] app.start failed:', started.error.code, started.error.hint);
  else (globalThis as typeof globalThis & { __bevyText2dReady?: boolean }).__bevyText2dReady = true;
}
