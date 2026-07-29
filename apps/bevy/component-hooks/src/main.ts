import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildComponentHooksWorld, readComponentHooksState } from './component-hooks.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-component-hooks: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-component-hooks] no usable backend:', error);
  } else {
    console.error('[bevy-component-hooks] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-component-hooks] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildComponentHooksWorld(app.world);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-component-hooks] app.start failed:', started.error);
    return;
  }
  const host = globalThis as {
    __bevyComponentHooksReady?: boolean;
    __bevyComponentHooksState?: () => ReturnType<typeof readComponentHooksState>;
  };
  host.__bevyComponentHooksState = () => readComponentHooksState(app.world, state);
  host.__bevyComponentHooksReady = true;
}
