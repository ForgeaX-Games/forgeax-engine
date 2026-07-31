import { createApp } from '@forgeax/engine-app';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildAnimatedTransformWorld, readAnimatedTransformState } from './animated-transform';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('[animated-transform] missing <canvas id="app">');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[animated-transform] env:', err);
  else console.error('[animated-transform] error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[animated-transform] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildAnimatedTransformWorld(app.world);
  console.warn(`[animated-transform] backend=${app.renderer.backend}`);
  Object.assign(globalThis, {
    __bevyAnimatedTransformReady: true,
    __bevyAnimatedTransformState: state,
    __bevyAnimatedTransformSnapshot: () => readAnimatedTransformState(app.world, state),
  });
  const started = app.start();
  if (!started.ok) console.error('[animated-transform] app.start failed:', started.error);
}
