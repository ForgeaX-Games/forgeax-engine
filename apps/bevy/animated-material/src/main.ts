import { createApp } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildAnimatedMaterialWorld, stepAnimatedMaterials } from './animated-material';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-animated-material: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-animated-material] no usable backend:', error);
  else console.error('[bevy-animated-material] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[bevy-animated-material] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const scene = buildAnimatedMaterialWorld(app.world, target.width / Math.max(target.height, 1));
  app.world.addSystem(Update, {
    name: 'animate-materials',
    queries: [],
    fn: (world) => {
      const elapsed = world.hasResource('Time')
        ? world.getResource<{ elapsed: number }>('Time').elapsed
        : 0;
      stepAnimatedMaterials(world, scene, elapsed);
    },
  });
  app.onError((error) => console.error('[bevy-animated-material] app error:', error.code, error.hint));
  console.warn(`[bevy-animated-material] backend=${app.renderer.backend}`);
  const started = app.start();
  if (!started.ok) console.error('[bevy-animated-material] app.start failed:', started.error);
}
