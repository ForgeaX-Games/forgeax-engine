import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { CHANNEL_CHARACTER_SIZE, verifyCharacterFill } from './lighting-channels-character.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('keeps character fill while removing it from the visible environment in both paths', {
  timeout: 300_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CHANNEL_CHARACTER_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi }),
  );
  try {
    await verifyCharacterFill(host.renderer, recorder, async (name, bytes) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await commands.writeFile(
        `artifacts/lighting-channels/browser-character/${name}`,
        btoa(binary),
        'base64',
      );
      if (name.endsWith('.rhitape')) {
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        await commands.writeFile(
          `artifacts/lighting-channels/browser-character/${name.replace('.rhitape', '-display.png')}`,
          typeof shot === 'string' ? shot : shot.base64,
          'base64',
        );
      }
    });
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
