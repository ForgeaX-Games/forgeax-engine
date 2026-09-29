import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyVisibleSurfaceReplay } from './visible-surface-replay.fixture';

it('validates ordinary Renderer visible surfaces and history through Browser WebGPU', {
  timeout: 180_000,
}, async (ctx) => {
  const adapter = await navigator.gpu.requestAdapter();
  expect(adapter).not.toBeNull();
  if (!adapter?.features.has('primitive-index')) ctx.skip('primitive-index unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  try {
    await verifyVisibleSurfaceReplay(canvas, async (name, bytes) => {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      await commands.writeFile(
        `artifacts/raytracing/iteration-01/renderer-visible-surface-browser/${name}`,
        btoa(binary),
        'base64',
      );
    });
  } finally {
    canvas.remove();
  }
});
