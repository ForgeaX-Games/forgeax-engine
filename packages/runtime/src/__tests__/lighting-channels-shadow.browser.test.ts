import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { CHANNEL_SIZE } from './lighting-channels.fixture';
import { verifyChannelShadows } from './lighting-channels-shadow.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('keeps browser direct matching independent of all supported shadow producers', {
  timeout: 300_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CHANNEL_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi }),
  );
  const save = async (name: string, bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await commands.writeFile(
      `artifacts/lighting-channels/browser-shadow/${name}`,
      btoa(binary),
      'base64',
    );
  };
  try {
    await verifyChannelShadows(host.renderer, recorder, async (name, tape, image, facts) => {
      await save(`${name}.rhitape`, tape.bytes);
      await save(`${name}.luminance-f32`, new Uint8Array(image.buffer));
      await save(
        `${name}.json`,
        new TextEncoder().encode(JSON.stringify({ digest: tape.digest, facts }, null, 2)),
      );
    });
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
