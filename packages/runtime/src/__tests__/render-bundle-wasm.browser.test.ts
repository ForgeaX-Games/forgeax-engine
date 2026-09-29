import type { Result } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { RenderBundleCache } from '../../../render/src/record/render-bundle-cache';
import { createShaderModule, ensureReady, rhi } from '../../../rhi-wgpu/src/index';

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it('reuses a source-built WASM render bundle without consuming its handle', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  document.body.append(canvas);
  await ensureReady();
  const adapter = value(await rhi.requestAdapter(undefined, canvas));
  const device = value(await adapter.requestDevice());
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const shader = value(
    await createShaderModule(device, {
      code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f,3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(p[i], 0., 1.);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1., 0., 0., 1.); }`,
    }),
  );
  const layout = value(device.createPipelineLayout({ bindGroupLayouts: [] }));
  const pipeline = value(
    device.createRenderPipeline({
      layout,
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    }),
  );
  const texture = value(device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 0x11 }));
  const view = value(device.createTextureView(texture, {}));
  const bundleEncoder = value(device.createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] }));
  bundleEncoder.pushDebugGroup('triangle');
  bundleEncoder.setPipeline(pipeline);
  bundleEncoder.draw(3);
  bundleEncoder.popDebugGroup();
  const bundle = value(bundleEncoder.finish());
  expect(bundleEncoder.finish()).toMatchObject({
    ok: false,
    error: { code: 'command-encoder-finished' },
  });
  const readback = value(device.createBuffer({ size: 256 * 8, usage: 0x09 }));
  try {
    for (let i = 0; i < 60; i++) {
      const encoder = value(device.createCommandEncoder());
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      value(pass.executeBundles([bundle]));
      pass.end();
      if (i === 59)
        encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [8, 8]);
      value(device.queue.submit([value(encoder.finish())]));
      await device.queue.onSubmittedWorkDone();
    }
    const mapped = value(await readback.mapAsync(1));
    const bytes = new Uint8Array(value(mapped.getMappedRange()));
    expect(Array.from(bytes.slice(0, 4))).toEqual([255, 0, 0, 255]);
    mapped.unmap();
    const cache = new RenderBundleCache({ colorFormats: ['rgba8unorm'] });
    for (let frame = 0; frame < 96; frame++) {
      const visible = Math.floor(frame / 4) % 2 === 0;
      const encoder = value(device.createCommandEncoder());
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      cache.encode(device, pass, (target) => {
        target.setPipeline(pipeline);
        if (visible) target.draw(3);
      });
      pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [8, 8]);
      value(device.queue.submit([value(encoder.finish())]));
      await device.queue.onSubmittedWorkDone();
      const current = value(await readback.mapAsync(1));
      const pixels = new Uint8Array(value(current.getMappedRange()));
      expect(Array.from(pixels.slice(0, 4)), `frame=${frame} visible=${visible}`).toEqual([
        visible ? 255 : 0,
        0,
        0,
        255,
      ]);
      current.unmap();
    }
  } finally {
    value(device.destroyBuffer(readback));
    value(device.destroyTexture(texture));
    canvas.remove();
  }
}, 60_000);
