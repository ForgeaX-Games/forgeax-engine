import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildSystemClosureWorld, readSystemClosureState } from './system-closure.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-system-closure: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-system-closure] no usable backend:', error);
  } else {
    console.error('[bevy-system-closure] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-system-closure] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildSystemClosureWorld(app.world);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-system-closure] app.start failed:', started.error);
    return;
  }
  const host = globalThis as {
    __bevySystemClosureReady?: boolean;
    __bevySystemClosureState?: () => ReturnType<typeof readSystemClosureState>;
  };
  host.__bevySystemClosureState = () => readSystemClosureState(app.world, state);
  host.__bevySystemClosureReady = true;
}
