import type { Result } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullAdapter, RhiNullDevice } from '@forgeax/engine-rhi-null';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import {
  createFaceUniformsBuffer,
  createPrefilterUniformsBuffer,
} from '../../device/gpu-residency';
import {
  createIblPipelines,
  getOrCreateIblCache,
  type RunIblPrecomputeOptions,
  runIblPrecompute,
} from '../../ibl/IblPipelineCache';

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function fixture() {
  const device = unwrap(await new RhiNullAdapter().requestDevice());
  if (!(device instanceof RhiNullDevice)) throw new Error('Expected null backend');
  const scope = DeviceScope.create(1, 'ibl-submission-test');
  unwrap(await createIblPipelines(scope, device, createShaderModule));
  const texture = unwrap(
    device.createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      usage: 20,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
    }),
  );
  const view = unwrap(device.createTextureView(texture, { dimension: 'cube' }));
  const options: RunIblPrecomputeOptions = {
    scope,
    device,
    equirectGpuTex: texture,
    equirectView: view,
    cubeGpuTex: texture,
    cubeView: view,
    cubeFaceViews: Array.from({ length: 6 }, (_, face) =>
      unwrap(
        device.createTextureView(texture, {
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
        }),
      ),
    ),
    faceUniformsBuffer: unwrap(createFaceUniformsBuffer(device)),
    prefilterUniformsBuffer: unwrap(createPrefilterUniformsBuffer(device)),
    cubeVertexBuffer: unwrap(
      device.createBuffer({ size: 432, usage: 32, mappedAtCreation: false }),
    ),
  };
  return { ...options, device, cache: getOrCreateIblCache(scope), options };
}

afterEach(() => vi.restoreAllMocks());

describe('IBL precompute completion boundaries', () => {
  it('fences each prefilter face and publishes only after the final completion', async () => {
    const { device, scope, cache, options } = await fixture();
    const passes: string[][] = [];
    let offset = 0;
    const submit = device.queue.submit.bind(device.queue);
    vi.spyOn(device.queue, 'submit').mockImplementation((buffers) => {
      passes.push(device.framePassNames.slice(offset));
      offset = device.framePassNames.length;
      return submit(buffers);
    });
    let release!: () => void;
    const lastFence = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
      expect(cache.prefilterTexture).toBeUndefined();
      expect(cache.prefilterBakeCount).toBe(0);
      if (passes.at(-1)?.includes('ibl-brdf-lut')) await lastFence;
    });
    const result = runIblPrecompute(options);
    try {
      await vi.waitFor(() => expect(passes.at(-1)).toEqual(['ibl-brdf-lut']));
      expect(passes.filter((batch) => batch.includes('ibl-prefilter'))).toEqual(
        Array.from({ length: 30 }, () => ['ibl-prefilter']),
      );
      expect(cache.prefilterTexture).toBeUndefined();
      expect(device.totalDrawCount).toBe(43);
    } finally {
      release();
    }
    expect(await result).toEqual({ ok: true, value: { submitted: true } });
    expect(cache.prefilterTexture).toBeDefined();
    expect([cache.irradianceBakeCount, cache.prefilterBakeCount, cache.brdfLutBakeCount]).toEqual([
      1, 1, 1,
    ]);
    scope.dispose();
  });

  it.each([
    'fence failure',
    'scope retirement',
  ])('stops before the next prefilter face after %s', async (failure) => {
    const { device, scope, cache, options } = await fixture();
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(async () => {
      if (!device.framePassNames.includes('ibl-prefilter')) return;
      if (failure === 'fence failure') throw new Error('device lost');
      scope.abandon();
    });
    const result = await runIblPrecompute(options);
    expect(result).toMatchObject({ ok: false, error: { code: 'ibl-precompute-not-dispatched' } });
    expect(device.framePassNames.filter((name) => name === 'ibl-prefilter')).toHaveLength(1);
    expect(device.framePassNames).not.toContain('ibl-brdf-lut');
    expect(cache.prefilterTexture).toBeUndefined();
    expect([cache.irradianceBakeCount, cache.prefilterBakeCount, cache.brdfLutBakeCount]).toEqual([
      0, 0, 0,
    ]);
    scope.dispose();
  });
});
