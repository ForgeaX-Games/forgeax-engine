import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyNormalBump } from './normal-bump.fixture';

it('validates normal/bump pixels, material bytes and fresh RHI replay in Browser WebGPU', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
  if (!host.ok) throw host.error;
  try {
    await verifyNormalBump(
      host.value.renderer,
      recorder,
      async (name, bytes) => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        await commands.writeFile(`artifacts/normal-bump/browser/${name}`, btoa(binary), 'base64');
      },
      import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60,
    );
  } finally {
    await host.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
