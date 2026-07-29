import { createApp } from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildChangeDetectionWorld, readChangeDetectionState } from './change-detection.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-change-detection: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-change-detection] no usable backend:', error);
  else console.error('[bevy-change-detection] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) { console.error('[bevy-change-detection] createApp failed:', result.error); return; }
  const app = result.value;
  const state = buildChangeDetectionWorld(app.world);
  const started = app.start();
  if (!started.ok) { console.error('[bevy-change-detection] app.start failed:', started.error); return; }
  const host = globalThis as { __bevyChangeDetectionReady?: boolean; __bevyChangeDetectionState?: () => ReturnType<typeof readChangeDetectionState> };
  host.__bevyChangeDetectionState = () => readChangeDetectionState(app.world, state);
  host.__bevyChangeDetectionReady = true;
}
