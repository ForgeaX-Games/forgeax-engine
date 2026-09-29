import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { LOD_SIZE, value, verifyLodTransition } from './lod-transition.fixture';

it.each([
  { renderPath: 'forward' as const, masked: false, taa: false },
  { renderPath: 'deferred' as const, masked: true, taa: false },
  { renderPath: 'forward' as const, masked: true, taa: true },
])('renders adjacent LOD coverage with browser WebGPU ($renderPath, TAA=$taa, mask=$masked)', {
  timeout: 180_000,
}, async (options) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = LOD_SIZE;
  document.body.append(canvas);
  const host = value(await constructRuntimeRendererHost(canvas));
  try {
    await verifyLodTransition(host, options);
  } finally {
    host.renderer.dispose();
    canvas.remove();
  }
});
