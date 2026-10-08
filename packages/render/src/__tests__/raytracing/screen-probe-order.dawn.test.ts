import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
  SCREEN_PROBE_TEXELS,
} from '../../raytracing/screen-probe-plan';

it('keeps receiver ray samples stable across adaptive allocation order and advances frame jitter', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const source = read('ray-screen-probe');
  const compiled = (
    await compileShader(source, {
      id: 'screen-probe-order',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe allocation regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage = 128) => {
    const value = device.createBuffer({
      size: data.byteLength,
      usage: usage | 8 | ((usage & 1) === 0 ? 4 : 0),
    });
    owned.push(value);
    if ((usage & 1) === 0) device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const directory =
    process.env.FORGEAX_SCREEN_PROBE_ORDER_ARTIFACT ?? 'artifacts/screen-probe/order';
  const receipt = {
    status: 'running',
    backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
    sourceSha256: digest(source),
    compiledSha256: digest(compiled.wgsl),
    adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
    errors,
    cases: [] as {
      importance: string;
      frame: number;
      permutation: number;
      pixels: Record<number, string>;
    }[],
  };
  try {
    const frame = buffer(new Uint8Array(SCREEN_PROBE_FRAME_BYTES), 64);
    const probes = buffer(new Uint8Array(7 * SCREEN_PROBE_RECORD_BYTES));
    const count = buffer(new Uint8Array(new Uint32Array([2]).buffer));
    const rays = buffer(new Uint8Array(7 * SCREEN_PROBE_TEXELS * 32));
    const staging = buffer(new Uint8Array(rays.size), 1);
    const module = device.createShaderModule({ code: compiled.wgsl });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'generateProbeRays' },
    });
    const inputs = { frame, probesIn: probes, adaptiveCountIn: count, rays };
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: SCREEN_PROBE_STAGES.generateProbeRays.slots.map((slot) => ({
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: { buffer: inputs[slot] },
      })),
    });
    const firstFrames = new Map<string, string>();
    for (const importance of ['uniform', 'brdf'] as const) {
      for (const frameIndex of [0, 1, 47]) {
        const packed = packScreenProbeFrame({
          layout: {
            width: 16,
            height: 4,
            tilesX: 4,
            tilesY: 1,
            uniformCount: 4,
            adaptiveCapacity: 3,
            probeCount: 7,
          },
          downsample: 4,
          frameIndex,
          importance,
          screenSteps: 0,
          thickness: 0.02,
          environment: [0, 0, 0],
          maxDistance: 100,
          shortRangeAo: 0,
          maxFrames: 8,
          sceneHistory: false,
          pixelHistory: false,
          worldBias: 0.25,
          cardMargin: 0.125,
          query: new Uint8Array(8),
          reprojection: undefined,
        });
        expect(packed.byteLength).toBe(frame.size);
        device.queue.writeBuffer(frame, 0, packed);
        let baseline: Map<number, Uint8Array> | undefined;
        for (const [permutation, pixels] of [
          [0, [3, 7, 11, 15, 1, 5, 0xffffffff]],
          [1, [3, 7, 11, 15, 5, 1, 0xffffffff]],
        ] as const) {
          const bytes = new Uint8Array(probes.size);
          const floats = new Float32Array(bytes.buffer),
            words = new Uint32Array(bytes.buffer);
          pixels.forEach((pixel, slot) => {
            const normal = pixel === 5 ? [0, 1, 0] : [0, 0, 1];
            floats.set([pixel % 16, 0, 0, 1, ...normal], slot * 8);
            words[slot * 8 + 7] = pixel;
          });
          device.queue.writeBuffer(probes, 0, bytes);
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(7);
          pass.end();
          encoder.copyBufferToBuffer(rays, 0, staging, 0, rays.size);
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(1);
          const actual = new Uint8Array(staging.getMappedRange()).slice();
          staging.unmap();
          const selected = new Map(
            pixels.map(
              (pixel, slot) =>
                [
                  pixel,
                  actual.slice(
                    slot * SCREEN_PROBE_TEXELS * 32,
                    (slot + 1) * SCREEN_PROBE_TEXELS * 32,
                  ),
                ] as const,
            ),
          );
          receipt.cases.push({
            importance,
            frame: frameIndex,
            permutation,
            pixels: Object.fromEntries([...selected].map(([pixel, data]) => [pixel, digest(data)])),
          });
          mkdirSync(directory, { recursive: true });
          writeFileSync(`${directory}/${importance}-${frameIndex}-${permutation}.bin`, actual);
          if (baseline) {
            for (const [pixel, data] of selected)
              expect(data, `receiver ${pixel} ${importance} frame ${frameIndex}`).toEqual(
                baseline.get(pixel),
              );
          } else {
            baseline = selected;
            const identity = `${importance}/1`,
              current = digest(selected.get(1) as Uint8Array);
            if (frameIndex === 0) firstFrames.set(identity, current);
            else expect(current).not.toBe(firstFrames.get(identity));
          }
        }
      }
    }
    expect(errors).toEqual([]);
    receipt.status = 'pass';
  } finally {
    if (receipt.status !== 'pass') receipt.status = 'fail';
    for (const value of owned) value.destroy();
    device.destroy();
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/result.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  }
});
