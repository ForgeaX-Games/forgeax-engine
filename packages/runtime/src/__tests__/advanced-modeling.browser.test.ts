import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyAdvancedModeling } from './advanced-modeling.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('renders advanced modeling through Browser WebGPU and independently replays every case', {
  timeout: 180000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 },
    }),
  );
  try {
    await verifyAdvancedModeling(
      host.renderer,
      recorder,
      async (name, bytes) => {
        if (name.endsWith('.rhitape')) {
          const shot = await page.elementLocator(canvas).screenshot({ base64: true, save: false });
          await commands.writeFile(
            `artifacts/advanced-modeling/browser/${name.replace('.rhitape', '.png')}`,
            typeof shot === 'string' ? shot : shot.base64,
            'base64',
          );
        }
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await commands.writeFile(
          `artifacts/advanced-modeling/browser/${name}`,
          btoa(binary),
          'base64',
        );
      },
      import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 12 : 60,
    );
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
