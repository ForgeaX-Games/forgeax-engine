/// <reference types="@webgpu/types" />

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps clear daylight blue at the horizon, finite at low turbidity, and linear in solar energy', async () => {
  const source = readFileSync(
    new URL('../../../shader/src/atmosphere-daylight.wgsl', import.meta.url),
    'utf8',
  ).replace(/^#.*$/gm, '');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const output = device.createBuffer({
    size: 128,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 128,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({
      code: `${source}
      @group(0) @binding(0) var<storage, read_write> output: array<vec4<f32>>;
      @compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let energy = select(select(1.0, 2.0, id.x == 1u), 0.0, id.x == 6u);
        let turbidity = select(select(select(2.0, 1.0, id.x == 2u), 1.5, id.x == 4u), 20.0, id.x == 5u);
        let view = select(vec3<f32>(0.0, 0.0, -1.0), vec3<f32>(0.0, 1.0, 0.0), id.x == 3u);
        let sun = normalize(vec3<f32>(0.35, select(0.72, -0.3, id.x == 7u), 0.58));
        output[id.x] = vec4<f32>(daylight_sky_radiance(view, sun, vec3<f32>(1.0), energy, turbidity, 1.0, 0.005, 0.8, 1.0, 1.0), 1.0);
      }`,
    });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 128);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = Array.from(new Float32Array(readback.getMappedRange()));
    expect(pixels.every((v) => Number.isFinite(v) && v >= 0 && v < 10)).toBe(true);
    // A broad neutral/purple horizon was the observed regression, not a sun-disc pixel.
    expect((pixels[2] ?? Number.NaN) / (pixels[0] ?? Number.NaN)).toBeGreaterThan(1.8);
    expect(pixels[1] ?? Number.NaN).toBeGreaterThan(pixels[0] ?? Number.NaN);
    for (let c = 0; c < 3; c++)
      expect((pixels[4 + c] ?? Number.NaN) / (pixels[c] ?? Number.NaN)).toBeCloseTo(2, 4);
    expect(pixels[14] ?? Number.NaN).toBeGreaterThan((pixels[12] ?? Number.NaN) * 2);
    expect(pixels.slice(24, 27)).toEqual([0, 0, 0]);
    expect(pixels[30] ?? 0).toBeGreaterThan(pixels[28] ?? 0);
    readback.unmap();
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
