import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { deviceOptionsForAdapter } from '../../../render/src/assembly/device-feature-admission';
import { constructRuntimeRendererHost } from '../renderer-host';
import { OIT_SIZE, verifyOit } from './oit.fixture';
import { inspectOitTape } from './oit-capture.fixture';

function browserCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = OIT_SIZE;
  document.body.append(canvas);
  return canvas;
}

it.each([
  { renderPath: 'forward', msaa: false },
  { renderPath: 'forward', msaa: true },
  { renderPath: 'deferred', msaa: false },
] as const)('weighted blended OIT $renderPath msaa=$msaa survives the browser manifest path', {
  timeout: 180_000,
}, async (options) => {
  const canvas = browserCanvas();
  const constructed = await constructRuntimeRendererHost(canvas);
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const host = constructed.value;
  try {
    const evidence = await verifyOit(host.renderer, options);
    expect(evidence.oitOrderDelta).toBeLessThanOrEqual(0.01);
  } finally {
    host.renderer.dispose();
    canvas.remove();
  }
});

it('OIT MSAA frame replays on a fresh browser device', { timeout: 240_000 }, async () => {
  const canvas = browserCanvas();
  const recorder = attachRecorder(webgpu).unwrap();
  const constructed = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const host = constructed.value;
  let inspected = false;
  try {
    await verifyOit(host.renderer, {
      renderPath: 'forward',
      msaa: true,
      capture: {
        recorder,
        async onTape(encoded, live) {
          const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
          const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
          await inspectOitTape({
            encoded,
            live,
            msaa: true,
            backend: { device, createShaderModule: webgpu.createShaderModule },
          });
          inspected = true;
        },
      },
    });
    expect(inspected).toBe(true);
  } finally {
    host.renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
