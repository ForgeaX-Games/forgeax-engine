import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyRendererDiffuse } from './renderer-diffuse.fixture';

for (const reconstruction of [undefined, 'combined'] as const) {
  it(`submits ordinary Renderer diffuse GI (${reconstruction ?? 'raw'}) on Browser WebGPU and replays its inputs`, async (ctx) => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter?.features.has('primitive-index')) ctx.skip('primitive-index unavailable');
    await verifyRendererDiffuse(
      await commands.prepareRayPathFixture(),
      async (name, bytes) => {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        await commands.writeFile(
          `artifacts/raytracing/iteration-03/renderer-diffuse/browser/${reconstruction ?? 'raw'}/${name}`,
          btoa(binary),
          'base64',
        );
      },
      undefined,
      reconstruction,
    );
  }, 180000);
}
