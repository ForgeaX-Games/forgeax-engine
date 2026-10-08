import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyStandardDisplacement } from './standard-displacement.fixture';

it('validates vertex displacement pixels, material bytes and fresh RHI replay in Browser WebGPU', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
  if (!host.ok) throw host.error;
  try {
    await verifyStandardDisplacement(
      host.value.renderer,
      recorder,
      async (name, bytes) => {
        // Keep each runner message bounded while preserving the exact tape bytes.
        const chunkSize = 4 * 1024 * 1024;
        for (let start = 0; start < bytes.length; start += chunkSize) {
          const chunk = bytes.subarray(start, start + chunkSize);
          let binary = '';
          for (let offset = 0; offset < chunk.length; offset += 8192)
            binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
          await commands.writeFile(
            `artifacts/standard-displacement/browser/${name}`,
            btoa(binary),
            {
              encoding: 'base64',
              flag: start === 0 ? 'w' : 'a',
            },
          );
        }
      },
      import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60,
    );
  } finally {
    await host.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
