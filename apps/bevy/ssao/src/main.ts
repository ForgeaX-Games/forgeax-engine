import { createApp } from '@forgeax/engine-app';
import { HDRP_PIPELINE_ID } from '@forgeax/engine-render/internal';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSsaoWorld } from './ssao';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-ssao: missing <canvas id="app">');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[bevy-ssao] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const ready = await app.renderer.ready;
  if (!ready.ok) {
    console.error('[bevy-ssao] renderer.ready failed:', ready.error);
    return;
  }
  const installed = app.renderer.installPipeline({
    kind: 'render-pipeline',
    pipelineId: HDRP_PIPELINE_ID,
    config: { clusterGrid: { x: 16, y: 9, z: 24 }, ssao: { enabled: true, radius: 0.65, bias: 0.025, intensity: 1.4 } },
  });
  if (!installed.ok) {
    console.error('[bevy-ssao] installPipeline failed:', installed.error.code, installed.error.hint);
    return;
  }
  const scene = buildSsaoWorld(app.world, target.width / Math.max(target.height, 1));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-ssao] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  Object.assign(globalThis, { __bevySsaoReady: true, __bevySsaoState: { enabled: true, meshCount: scene.meshCount, pipeline: HDRP_PIPELINE_ID } });
}

bootstrap(canvas).catch((error: unknown) => console.error('[bevy-ssao] bootstrap error:', error));
