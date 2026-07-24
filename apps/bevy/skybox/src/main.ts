import { createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { EquirectAsset } from '@forgeax/engine-types';
import { createDevImportTransport, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSkyboxWorld } from './skybox';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-skybox: missing <canvas id="app" in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-skybox] no usable backend:', error);
  } else {
    console.error('[bevy-skybox] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const bundler = { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() };
  const appResult = await createApp(target, {}, bundler);
  if (!appResult.ok) {
    console.error('[bevy-skybox] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const guidResult = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guidResult.ok) {
    console.error('[bevy-skybox] HDR GUID parse failed:', guidResult.error.code);
    return;
  }
  app.renderer.assets.configurePackIndex('/pack-index.json');
  const hdrResult = await app.renderer.assets.loadByGuid<EquirectAsset>(guidResult.value);
  if (!hdrResult.ok) {
    console.error('[bevy-skybox] HDR load failed:', hdrResult.error.code, hdrResult.error.hint);
    return;
  }

  const equirect = app.world.allocSharedRef('EquirectAsset', hdrResult.value);
  buildSkyboxWorld(app.world, equirect, target.width / Math.max(target.height, 1));
  app.onError((error) => console.error('[bevy-skybox] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-skybox] app.start failed:', started.error);
    return;
  }
  console.warn('[bevy-skybox] skybox active: Newport Loft HDR equirect');
}
