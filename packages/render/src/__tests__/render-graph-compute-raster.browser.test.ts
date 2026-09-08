import { describe, expect, it } from 'vitest';
import { runComputeRasterGraph } from './render-graph-compute-raster-gpu';

describe('RenderGraph compute to indirect raster in Chromium WebGPU', () => {
  it('preserves the same graph hazards and pixel through the browser path', async () => {
    const evidence = await runComputeRasterGraph();
    expect(evidence.graph.passes.map((pass) => pass.name)).toEqual([
      'prepare-args-and-ping',
      'ping-pong',
      'storage-texture',
      'indirect-raster',
      'readback',
    ]);
    expect(evidence.pixel).toEqual([64, 128, 191, 255]);
  });
});
