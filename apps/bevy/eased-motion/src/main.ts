import { createApp } from '@forgeax/engine-app';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildEasedMotionWorld, readEasedMotionState } from './eased-motion';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('[eased-motion] missing #app canvas');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[eased-motion] env:', err);
  else console.error('[eased-motion] error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) { console.error('[eased-motion] createApp failed:', appResult.error); return; }
  const app = appResult.value;
  const state = buildEasedMotionWorld(app.world);
  Object.assign(globalThis, {
    __bevyEasedMotionReady: true,
    __bevyEasedMotionSnapshot: () => readEasedMotionState(app.world, state),
  });
  const started = app.start();
  if (!started.ok) console.error('[eased-motion] app.start failed:', started.error);
}
