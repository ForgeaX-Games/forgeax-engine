import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyLensFlare } from './lens-flare.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('verifies lens flare through Browser WebGPU and fresh-device RHI replay', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 96;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
    }),
  );
  const save = async (name: string, bytes: Uint8Array) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    await commands.writeFile(`artifacts/lens-flare/browser/${name}`, btoa(binary), 'base64');
  };
  try {
    await verifyLensFlare(
      host.renderer,
      recorder,
      save,
      async (name) => {
        await commands.writeFile(
          `artifacts/lens-flare/browser/${name}.png`,
          canvas.toDataURL('image/png').split(',')[1] ?? '',
          'base64',
        );
      },
      (width, height) => {
        canvas.width = width;
        canvas.height = height;
      },
    );
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
