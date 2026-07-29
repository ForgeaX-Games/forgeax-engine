import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildSystemParamWorld, readSystemParamState } from './system-param.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-system-param: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-system-param] no usable backend:', error);
  } else {
    console.error('[bevy-system-param] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-system-param] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildSystemParamWorld(app.world);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-system-param] app.start failed:', started.error);
    return;
  }
  const host = globalThis as {
    __bevySystemParamReady?: boolean;
    __bevySystemParamState?: () => ReturnType<typeof readSystemParamState>;
  };
  host.__bevySystemParamState = () => readSystemParamState(app.world, state);
  host.__bevySystemParamReady = true;
}
