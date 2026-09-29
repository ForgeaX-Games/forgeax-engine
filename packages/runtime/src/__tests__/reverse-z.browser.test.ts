import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyReverseZ } from './reverse-z.fixture';

it('verifies Reverse-Z pixels and capture/replay through browser WebGPU', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const result = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
  if (!result.ok) throw result.error;
  try {
    await verifyReverseZ(result.value.renderer, recorder, async (name, bytes) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await commands.writeFile(`artifacts/reverse-z/browser/${name}`, btoa(binary), 'base64');
    });
  } finally {
    await result.value.renderer.dispose();
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
