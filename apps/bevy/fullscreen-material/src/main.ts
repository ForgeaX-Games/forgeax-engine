import { createApp } from '@forgeax/engine-app';
import { Update } from '@forgeax/engine-ecs';
import { PostProcessParams, URP_PIPELINE_ID } from '@forgeax/engine-render/internal';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import fullscreenShader from './fullscreen-material.wgsl';
import { buildFullscreenMaterialWorld } from './scene.js';

export const FULLSCREEN_MATERIAL_ID = 'bevy-fullscreen-material::chromatic';
const PARAM_BYTES = 16;

export function packFullscreenParams(intensity: number): Uint8Array {
  const bytes = new ArrayBuffer(PARAM_BYTES);
  new Float32Array(bytes)[0] = intensity;
  return new Uint8Array(bytes);
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-fullscreen-material: missing <canvas id="app">');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[bevy-fullscreen-material] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  buildFullscreenMaterialWorld(app.world, target.width / Math.max(target.height, 1));

  const initialParams = packFullscreenParams(0.012);
  app.renderer.postProcess.register(FULLSCREEN_MATERIAL_ID, {
    source: fullscreenShader.wgsl,
    reads: ['sceneColor'],
    params: { byteSize: PARAM_BYTES, defaultValue: initialParams },
  });
  const paramsEntity = app.world.spawn({
    component: PostProcessParams,
    data: { shader: FULLSCREEN_MATERIAL_ID, data: initialParams },
  }).unwrap();
  const installed = app.renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: URP_PIPELINE_ID,
    config: { postEffects: [FULLSCREEN_MATERIAL_ID] },
  });
  if (!installed.ok) {
    console.error('[bevy-fullscreen-material] installPipeline failed:', installed.error);
    return;
  }

  app.world.addSystem(Update, {
    name: 'fullscreen-material-intensity',
    queries: [],
    fn: (world) => {
      const elapsed = world.hasResource('Time')
        ? world.getResource<{ elapsed: number }>('Time').elapsed
        : 0;
      const intensity = 0.002 + (0.014 * (Math.sin(elapsed * 2) + 1)) / 2;
      world.set(paramsEntity, PostProcessParams, { data: packFullscreenParams(intensity) });
    },
  });
  app.onError((error) => console.error('[bevy-fullscreen-material] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-fullscreen-material] app.start failed:', started.error);
}

bootstrap(canvas).catch((error: unknown) => {
  console.error('[bevy-fullscreen-material] bootstrap error:', error);
});
