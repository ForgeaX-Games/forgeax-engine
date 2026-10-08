import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';
import { verifyStereo } from './stereo.fixture';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

it.each([
  'world',
  'publication',
] as const)('renders stereo eyes with Three.js disparity and replays Browser WebGPU through %s', {
  timeout: 240_000,
}, async (mode) => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  document.body.append(canvas);
  const identity = { source: 'stereo', epoch: 1 };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      ssrIdentity: gbufferReplayIdentity,
      ...(mode === 'publication' ? { publicationSource: identity } : {}),
    }),
  );
  const directory = `artifacts/stereo/${mode === 'world' ? 'browser' : 'publication-browser'}`;
  try {
    const summary = await verifyStereo(
      host.renderer,
      recorder,
      // The tape is replayed in-page; the summary carries its digest instead of the bytes.
      async (name, bytes) => {
        if (!name.endsWith('.rhitape'))
          await commands.writeFile(`${directory}/${name}`, base64(bytes), 'base64');
      },
      canvas,
      mode === 'publication' ? { assets: host.assets, identity } : undefined,
      import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 16 : 60,
    );
    await commands.writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
