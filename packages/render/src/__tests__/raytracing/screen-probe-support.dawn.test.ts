import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  IRRADIANCE_FIELD_PENDING_OFFSET,
  IrradianceFieldProbeState,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import { IRRADIANCE_FIELD_PROBE_STRIDE } from '../../raytracing/irradiance-field-plan';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_STAGES,
  type ScreenProbeSlot,
} from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame, ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

it('keeps unresolved directions absent through Screen Probe filtering, integration and history', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = (
    await compileShader(read('ray-screen-probe'), {
      id: 'screen-probe-support',
      imports: {
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_ray::irradiance_field_sample': read('ray-irradiance-field-sample'),
      },
    })
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Screen Probe support regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const buffer = (data: Uint8Array, usage = 128 | 4) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    owned.push(value);
    device.queue.writeBuffer(value, 0, data);
    return value;
  };
  const result: Record<string, number[]> = {};
  const historyMeta: Record<string, number[]> = {};
  let status = 'running';
  try {
    const previousView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1];
    const frame = buffer(
      packScreenProbeFrame({
        layout: {
          width: 8,
          height: 4,
          tilesX: 2,
          tilesY: 1,
          uniformCount: 2,
          adaptiveCapacity: 0,
          probeCount: 2,
        },
        downsample: 4,
        frameIndex: 0,
        importance: 'uniform',
        screenSteps: 0,
        thickness: 0.02,
        environment: [0, 0, 0],
        maxDistance: 100,
        shortRangeAo: 0,
        maxFrames: 8,
        sceneHistory: false,
        pixelHistory: true,
        worldBias: 0.25,
        cardMargin: 0.125,
        query: new Uint8Array(8),
        reprojection: { viewProjection: previousView, cameraPosition: [0, 0, 1] },
      }),
      64,
    );
    const records = new Uint8Array(2 * 32);
    const f = new Float32Array(records.buffer);
    const u = new Uint32Array(records.buffer);
    for (let probe = 0; probe < 2; probe++) {
      f.set([0, 0, 0, 1, 0, 0, 1], probe * 8);
      u[probe * 8 + 7] = probe;
    }
    const probes = buffer(records);
    const adaptive = buffer(new Uint8Array(4));
    const rayData = new Uint8Array(2 * 64 * 32);
    const rayFloats = new Float32Array(rayData.buffer);
    const rayWords = new Uint32Array(rayData.buffer);
    const rays = buffer(rayData);
    const resolve = buffer(new Uint8Array(2 * 64 * 16));
    const filtered = buffer(new Uint8Array(resolve.size));
    const irradiance = buffer(new Uint8Array(resolve.size));
    const integrated = buffer(new Uint8Array(8 * 4 * 16));
    const history = buffer(new Uint8Array(integrated.size));
    const metadata = buffer(new Uint8Array(integrated.size));
    const outputs = [resolve, filtered, irradiance, integrated, history, metadata];
    const readback = buffer(new Uint8Array(resolve.size * 3 + integrated.size * 3), 1);
    const viewBytes = new Uint8Array(VIEW_UNIFORM_BYTES);
    const viewFloats = new Float32Array(viewBytes.buffer);
    viewFloats.set(previousView);
    viewFloats.set([0, 0, 1], 24);
    viewFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1], 44);
    const view = buffer(viewBytes, 64);
    const previousHistory = new Float32Array(8 * 4 * 4);
    const previousMeta = new Uint8Array(previousHistory.byteLength);
    const metaFloats = new Float32Array(previousMeta.buffer);
    const metaWords = new Uint32Array(previousMeta.buffer);
    for (let pixel = 0; pixel < 32; pixel++) {
      previousHistory.set([3, 3, 3, 1], pixel * 4);
      const x = (((pixel % 8) + 0.5) / 8) * 2 - 1;
      const y = 1 - ((Math.floor(pixel / 8) + 0.5) / 4) * 2;
      metaFloats[pixel * 4] = Math.hypot(x, y, 1);
      metaWords.set([0, 7, 1], pixel * 4 + 1);
    }
    const oldHistory = buffer(new Uint8Array(previousHistory.buffer));
    const oldMeta = buffer(previousMeta);
    const tileAdaptive = buffer(new Uint8Array(new Uint32Array(8).fill(0xffffffff).buffer));
    const depth = device.createTexture({ size: [8, 4], format: 'depth32float', usage: 4 | 16 });
    const normal = device.createTexture({ size: [8, 4], format: 'r32uint', usage: 4 | 2 });
    textures.push(depth, normal);
    device.queue.writeTexture(
      { texture: normal },
      new Uint32Array(32).fill(2048 | (2048 << 12)),
      { bytesPerRow: 32 },
      [8, 4],
    );
    const clear = device.createCommandEncoder();
    clear
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0.5,
        },
      })
      .end();
    device.queue.submit([clear.finish()]);
    const field = buffer(
      packIrradianceFieldUniform(
        { origin: [-1, -1, -1], spacing: 2, dimensions: [2, 2, 2], probeCount: 8, levels: 1 },
        [{ window: [0, 0, 0], min: [0, 0, 0], max: [2, 2, 2] }],
      ),
      64,
    );
    const fieldRadiance = new Float32Array(8 * IRRADIANCE_FIELD_PROBE_STRIDE * 4);
    for (let i = 0; i < fieldRadiance.length; i += 4) fieldRadiance.set([0.5, 0.5, 0.5, 1], i);
    const retained = buffer(new Uint8Array(fieldRadiance.buffer));
    const fieldMoments = new Float32Array(8 * 64 * 2);
    for (let i = 0; i < fieldMoments.length; i += 2) fieldMoments.set([8, 64], i);
    const moments = buffer(new Uint8Array(fieldMoments.buffer));
    const fieldStates = new Uint32Array(8 * 4);
    const meta = buffer(new Uint8Array(fieldStates.buffer));
    const module = device.createShaderModule({ code: compiled.wgsl });
    const resources: Partial<Record<ScreenProbeSlot, GPUBindingResource>> = {
      frame: { buffer: frame },
      view: { buffer: view },
      depth: depth.createView(),
      normal: normal.createView(),
      probesIn: { buffer: probes },
      adaptiveCountIn: { buffer: adaptive },
      raysIn: { buffer: rays },
      radianceOut: { buffer: resolve },
      radianceIn: { buffer: resolve },
      probeIrradianceOut: { buffer: irradiance },
      probeIrradiance: { buffer: irradiance },
      tileAdaptiveIn: { buffer: tileAdaptive },
      integratedOut: { buffer: integrated },
      integrated: { buffer: integrated },
      historyIn: { buffer: oldHistory },
      historyOut: { buffer: history },
      metaIn: { buffer: oldMeta },
      metaOut: { buffer: metadata },
    };
    const stages = [
      'resolveProbeRays',
      'filterProbeRadiance',
      'convertProbeIrradiance',
      'integrateScreenProbes',
      'temporalScreenProbes',
    ] as const;
    const pipelines = stages.map((entryPoint) => {
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint },
      });
      const inputs = { ...resources };
      if (entryPoint === 'filterProbeRadiance') inputs.radianceOut = { buffer: filtered };
      if (entryPoint === 'convertProbeIrradiance') inputs.radianceIn = { buffer: filtered };
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: SCREEN_PROBE_STAGES[entryPoint].slots.map((slot) => {
          const value = inputs[slot];
          if (!value) throw new Error(`missing real Screen Probe input ${slot}`);
          return { binding: SCREEN_PROBE_BINDINGS[slot][0], resource: value };
        }),
      });
      const sample =
        entryPoint === 'resolveProbeRays' || entryPoint === 'integrateScreenProbes'
          ? device.createBindGroup({
              layout: pipeline.getBindGroupLayout(1),
              entries: [field, retained, moments, meta].map((value, binding) => ({
                binding,
                resource: { buffer: value },
              })),
            })
          : undefined;
      return {
        pipeline,
        group,
        sample,
        dispatch: SCREEN_PROBE_STAGES[entryPoint].dispatch === 'probes' ? 2 : 1,
      };
    });
    const cases = [
      'missing',
      'true-zero',
      'cache',
      'missing-neighbor',
      'zero-neighbor',
      'missing-direction-back',
      'missing-direction-front',
      'incomplete-world',
      'mixed-incomplete-world',
      'incomplete-cache',
    ] as const;
    for (const name of cases) {
      const angular = name.startsWith('missing-direction-');
      const incomplete = name.endsWith('incomplete-world') || name === 'incomplete-cache';
      device.queue.writeBuffer(
        field,
        IRRADIANCE_FIELD_PENDING_OFFSET,
        new Uint32Array([Number(incomplete && name !== 'incomplete-cache')]),
      );
      // Octahedral texels 0 and 36 lie in opposite hemispheres. Missing support
      // behind the +Z receiver must not invalidate its complete cosine lobe.
      const missingDirection = name === 'missing-direction-back' ? 0 : 36;
      for (let probe = 0; probe < 8; probe++)
        fieldStates.set(
          [
            1,
            name === 'cache' || incomplete
              ? IrradianceFieldProbeState.active
              : IrradianceFieldProbeState.untraced,
            0,
            0,
          ],
          probe * 4,
        );
      device.queue.writeBuffer(meta, 0, fieldStates);
      for (let probe = 0; probe < 2; probe++) {
        for (let texel = 0; texel < 64; texel++) {
          const base = (probe * 64 + texel) * 8;
          const resolved =
            (name === 'mixed-incomplete-world' && texel >= 32) ||
            (angular && texel !== missingDirection) ||
            name === 'true-zero' ||
            name === 'zero-neighbor' ||
            (name === 'missing-neighbor' && probe === 0);
          const value = incomplete
            ? resolved
              ? 1
              : 123
            : angular || ((name === 'missing-neighbor' || name === 'zero-neighbor') && probe === 0)
              ? 1
              : 0;
          rayFloats.set([0, 0, 1, 0, value, value, value, 0], base);
          rayWords[base + 3] =
            512 |
            (name === 'mixed-incomplete-world' ? texel % 32 : texel) |
            ((resolved
              ? ScreenProbeRayStatus.resolved
              : incomplete
                ? ScreenProbeRayStatus.incomplete
                : ScreenProbeRayStatus.fallback) <<
              12);
        }
      }
      device.queue.writeBuffer(rays, 0, rayData);
      const encoder = device.createCommandEncoder();
      for (const { pipeline, group, sample, dispatch } of pipelines) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        if (sample) pass.setBindGroup(1, sample);
        pass.dispatchWorkgroups(dispatch);
        pass.end();
      }
      let destination = 0;
      for (const value of outputs) {
        encoder.copyBufferToBuffer(value, 0, readback, destination, value.size);
        destination += value.size;
      }
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      const mapped = readback.getMappedRange().slice(0);
      result[name] = Array.from(new Float32Array(mapped, 0, (readback.size - metadata.size) / 4));
      historyMeta[name] = Array.from(new Uint32Array(mapped, readback.size - metadata.size));
      readback.unmap();
    }
    for (const name of cases) {
      const values = result[name];
      const meta = historyMeta[name];
      if (!values || !meta) throw new Error(`missing pixel support ${name}`);
      for (const pixel of [0, 7, 24, 31]) {
        const valid =
          name !== 'missing' &&
          !name.endsWith('incomplete-world') &&
          name !== 'incomplete-cache' &&
          name !== 'missing-direction-front' &&
          !(name === 'missing-neighbor' && pixel % 8 === 7);
        const current =
          name === 'missing-direction-back'
            ? 1
            : name === 'cache'
              ? 0.5
              : name === 'missing-neighbor' && valid
                ? 1
                : name === 'zero-neighbor'
                  ? 0.5
                  : 0;
        const first = (3 * resolve.size) / 4 + pixel * 4;
        expect(values[first + 3], `${name}:integrated support`).toBe(valid ? 1 : 0);
        expect(values[first], `${name}:integrated D`).toBeCloseTo(current, 5);
        expect(values[first + integrated.size / 4], `${name}:history D`).toBeCloseTo(
          valid ? (3 * 7) / 8 + current / 8 : 0,
          5,
        );
        expect(meta[pixel * 4 + 2], `${name}:history weight`).toBe(valid ? 8 : 0);
        expect(meta[pixel * 4 + 3], `${name}:history support`).toBe(valid ? 1 : 0);
      }
    }
    // Retain every control before reporting failures. Missing transport is not
    // a true zero; a physically resolved zero still contributes its denominator.
    for (const name of cases) {
      const values = result[name];
      if (!values) throw new Error(`missing support result ${name}`);
      if (name.endsWith('incomplete-world') || name === 'incomplete-cache') {
        for (let stage = 0; stage < 3; stage++)
          for (let probe = 0; probe < 2; probe++)
            for (let texel = 0; texel < 64; texel++) {
              const index = stage * (resolve.size / 4) + (probe * 64 + texel) * 4;
              expect(values.slice(index, index + 3), `${name}:stage ${stage}:RGB`).toEqual([
                0, 0, 0,
              ]);
              const support = values[index + 3];
              if (name !== 'mixed-incomplete-world') expect(support).toBe(-1);
              else if (stage < 2) expect(support).toBe(texel < 32 ? -1 : 0);
              else expect(support).toBeLessThanOrEqual(0);
            }
        continue;
      }
      if (name.startsWith('missing-direction-')) {
        const missingDirection = name === 'missing-direction-back' ? 0 : 36;
        for (let stage = 0; stage < 3; stage++)
          for (let probe = 0; probe < 2; probe++)
            for (const texel of [0, 36]) {
              const valid = texel !== missingDirection;
              const index = stage * (resolve.size / 4) + (probe * 64 + texel) * 4;
              expect(values[index + 3], `${name}:stage ${stage}:texel ${texel}`).toBe(
                valid ? 1 : 0,
              );
              expect(values[index], `${name}:stage ${stage}:D`).toBeCloseTo(valid ? 1 : 0, 5);
            }
        continue;
      }
      for (let stage = 0; stage < 3; stage++) {
        for (let probe = 0; probe < 2; probe++) {
          const valid =
            name !== 'missing' &&
            !name.endsWith('incomplete-world') &&
            !(name === 'missing-neighbor' && probe === 1);
          const value =
            name === 'cache'
              ? 0.5
              : name === 'missing-neighbor' && probe === 0
                ? 1
                : name === 'zero-neighbor'
                  ? stage === 0
                    ? probe === 0
                      ? 1
                      : 0
                    : 0.5
                  : 0;
          const first = stage * (resolve.size / 4) + probe * 64 * 4;
          const rgbError = Array.from({ length: 64 * 3 }, (_, i) =>
            Math.abs((values[first + Math.floor(i / 3) * 4 + (i % 3)] ?? NaN) - value),
          );
          expect(Math.max(...rgbError), `${name}:stage ${stage}:probe ${probe}`).toBeLessThan(1e-5);
          const support = new Set(
            Array.from({ length: 64 }, (_, texel) => values[first + texel * 4 + 3]),
          );
          expect(support, `${name}:stage ${stage}:support`).toEqual(new Set([valid ? 1 : 0]));
        }
      }
    }
    expect(errors).toEqual([]);
    status = 'pass';
  } catch (cause) {
    status = 'fail';
    throw cause;
  } finally {
    const directory = 'artifacts/screen-probe/dawn';
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/support-result.json`,
      JSON.stringify(
        {
          status,
          result,
          historyMeta,
          errors,
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
        },
        null,
        2,
      ),
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
}, 120000);
