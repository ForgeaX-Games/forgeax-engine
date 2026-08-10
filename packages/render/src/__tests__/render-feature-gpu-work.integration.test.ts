import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureGpuWorkResolver } from '../features/prepared-gpu-work';

describe('RenderFeature persistent GPU work', () => {
  it('classifies an asynchronous shader warmup as a next-frame retry', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const resolver = createRenderFeatureGpuWorkResolver({
      device,
      generation: 0,
      featureIdentity: 'synthetic.gpu',
      shaderModuleFactory: {
        createShaderModule: () =>
          err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'asynchronous shader compilation to finish',
              hint: 'retry on the next frame',
            }),
          ),
      },
    });

    const prepared = resolver.prepareProgram('program', {
      wgsl: 'synthetic',
      entryPoints: ['simulate'],
    });

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.error).toMatchObject({
        code: 'render-feature-preparation-failed',
        detail: {
          operation: 'prepare-gpu-program',
          reason: 'rhi-not-available:retry on the next frame',
          recovery: 'next-frame',
        },
      });
    }
  });

  it('records compute against persistent storage and releases it once', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const resolver = createRenderFeatureGpuWorkResolver({
      device,
      generation: 4,
      featureIdentity: 'synthetic.gpu',
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    });
    resolver.beginFrame();
    const program = resolver
      .prepareProgram('program', { wgsl: 'synthetic', entryPoints: ['simulate', 'compact'] })
      .unwrap();
    const storage = resolver
      .prepareBuffer('particles', {
        size: 4096,
        usage: ['storage', 'vertex'],
        data: new Uint32Array([1, 2, 3, 4]),
      })
      .unwrap();
    const indirect = resolver
      .prepareBuffer('indirect', {
        size: 20,
        usage: ['storage', 'indirect'],
        data: new Uint32Array([6, 0, 0, 0, 0]),
      })
      .unwrap();
    const bindings = resolver
      .prepareBindings('bindings', {
        program,
        entries: [
          { binding: 0, buffer: storage },
          { binding: 1, buffer: indirect },
        ],
      })
      .unwrap();
    const work = resolver
      .resolveComputePass('synthetic.gpu', {
        program,
        bindings,
        dispatches: [
          { entryPoint: 'simulate', workgroups: [16] },
          { entryPoint: 'compact', workgroups: [1] },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder({ label: 'gpu-feature-frame' }).unwrap();
    expect(work.record(encoder).ok).toBe(true);
    expect(encoder.finish().ok).toBe(true);
    expect(resolver.resolveBuffer(storage)).toBeDefined();
    expect(resolver.resolveBuffer(indirect)).toBeDefined();
    expect(resolver.retireUntouched()).toEqual([]);

    resolver.beginFrame();
    expect(resolver.retainBindings([bindings]).ok).toBe(true);
    expect(resolver.retireUntouched()).toEqual([]);

    resolver.beginFrame();
    const retired = resolver.retireUntouched();
    expect(retired).toHaveLength(1);
    expect(resolver.resolveBuffer(storage)).toBeUndefined();
    expect(retired[0]?.release().ok).toBe(true);
    expect(retired[0]?.release().ok).toBe(true);
    expect(resolver.dispose().ok).toBe(true);
    expect(resolver.dispose().ok).toBe(true);
  });
});
