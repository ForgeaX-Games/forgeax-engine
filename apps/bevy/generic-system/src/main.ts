import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildGenericSystemWorld, readGenericSystemState } from './generic-system.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[generic-system] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const state = buildGenericSystemWorld(app.world);
  globalThis.__bevyGenericSystemState = () => readGenericSystemState(app.world, state);
  const started = app.start();
  if (!started.ok) {
    console.error('[generic-system] app.start() failed:', started.error);
    return;
  }
  globalThis.__bevyGenericSystemReady = true;
}

declare global {
  var __bevyGenericSystemReady: boolean | undefined;
  var __bevyGenericSystemState: (() => ReturnType<typeof readGenericSystemState>) | undefined;
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);
