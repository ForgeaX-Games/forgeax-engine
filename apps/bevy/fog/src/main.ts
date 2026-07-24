import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildFogWorld, installFogPostProcess } from './fog.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-fog: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-fog] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  buildFogWorld(app.world, target.width / Math.max(target.height, 1));
  installFogPostProcess(app.renderer, app.world);
  app.onError((error) => console.error('[bevy-fog] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-fog] app.start failed:', started.error);
}

bootstrap(canvas).catch((error: unknown) => {
  console.error('[bevy-fog] bootstrap error:', error);
});
