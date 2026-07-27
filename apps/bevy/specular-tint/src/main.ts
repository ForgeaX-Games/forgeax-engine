import { createApp } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { EquirectAsset, TextureAsset } from '@forgeax/engine-types';
import { EngineEnvironmentError, createDevImportTransport } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpecularTintWorld } from './specular-tint';

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const SPECULAR_TINT_GUID = '019e3969-1d46-79d1-9d22-ffd8c6859c64';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-specular-tint: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-specular-tint] no usable backend:', error);
  else console.error('[bevy-specular-tint] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const bundler = { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() };
  const result = await createApp(target, {}, bundler);
  if (!result.ok) { console.error('[bevy-specular-tint] createApp failed:', result.error); return; }
  const app = result.value;
  app.renderer.assets.configurePackIndex('/pack-index.json');
  const hdrGuid = AssetGuid.parse(NEWPORT_LOFT_GUID);
  const tintGuid = AssetGuid.parse(SPECULAR_TINT_GUID);
  if (!hdrGuid.ok || !tintGuid.ok) { console.error('[bevy-specular-tint] asset GUID parse failed'); return; }
  const hdr = await app.renderer.assets.loadByGuid<EquirectAsset>(hdrGuid.value);
  const tint = await app.renderer.assets.loadByGuid<TextureAsset>(tintGuid.value);
  if (!hdr.ok) { console.error('[bevy-specular-tint] HDR load failed:', hdr.error.code); return; }
  if (!tint.ok) { console.error('[bevy-specular-tint] texture load failed:', tint.error.code); return; }
  const equirect = app.world.allocSharedRef('EquirectAsset', hdr.value);
  const specularTintTexture = unwrapHandle(app.world.allocSharedRef('TextureAsset', tint.value));
  buildSpecularTintWorld(app.world, equirect, specularTintTexture, target.width / Math.max(target.height, 1));
  app.onError((error) => console.error('[bevy-specular-tint] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-specular-tint] app.start failed:', started.error);
}
