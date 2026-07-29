import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildRunConditionsWorld, readRunConditionState } from './run-conditions.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-run-conditions: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-run-conditions] no usable backend:', error);
  } else {
    console.error('[bevy-run-conditions] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-run-conditions] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildRunConditionsWorld(app.world);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-run-conditions] app.start failed:', started.error);
    return;
  }
  const host = globalThis as {
    __bevyRunConditionsReady?: boolean;
    __bevyRunConditionsState?: () => ReturnType<typeof readRunConditionState>;
  };
  host.__bevyRunConditionsState = () => readRunConditionState(app.world, state);
  host.__bevyRunConditionsReady = true;
}
