import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  runRenderFeatureFrame,
} from '../features/host';
import { createBuiltinMorphFeature, MORPH_COMPUTE_WGSL } from '../features/morph/morph-feature';
import {
  createRenderFeatureGpuWorkOwner,
  encodeRenderFeatureGpuComputePass,
} from '../features/prepared-gpu-work';

describe('Morph RenderFeature GPU work', () => {
  it('exposes morph work through the declarative plan owner', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../features/morph/morph-feature.ts'),
      'utf8',
    );
    expect(source).toContain('RenderFeaturePlan');
    expect(source).not.toMatch(/GPUCommandEncoder|queue\.submit|encoder\.finish/);
  });

  it('projects the plan into one executable compute pass', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: MORPH_COMPUTE_WGSL })).unwrap();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const feature = createBuiltinMorphFeature({
      collect: () => [
        {
          identity: 'triangle',
          vertexCount: 3,
          baseBounds: { min: [-1, -1, -1], max: [1, 1, 1] },
          targetBounds: [{ min: [-1, 0, 0], max: [1, 0, 0] }],
          weights: new Float32Array([0.5]),
          baseAabbIntersectsFrustum: true,
          basePositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          targetDeltas: new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]),
        },
      ],
    });
    const host = createRenderFeatureHost([feature]);
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    const frame = runRenderFeatureFrame(host.value, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: device.caps,
      gpuWork: owner,
    });
    expect(frame.errors).toEqual([]);
    expect(frame.plans).toHaveLength(1);
    const contribution =
      frame.plans[0] === undefined
        ? undefined
        : getRenderFeaturePlanExecutionProjection(frame.plans[0]);
    expect(contribution?.passes).toHaveLength(1);
    expect(contribution?.passes[0]?.gpuCompute?.program).toBeDefined();
    expect(contribution?.passes[0]?.resolvedGpuCompute).toBeDefined();
    expect(MORPH_COMPUTE_WGSL).toContain('@compute');

    const encoder = device.createCommandEncoder({ label: 'morph-feature' }).unwrap();
    const work = contribution?.passes[0]?.resolvedGpuCompute;
    expect(work).toBeDefined();
    if (work === undefined) return;
    const pass = encoder.beginComputePass({ label: 'forgeax.morph.compute' });
    encodeRenderFeatureGpuComputePass(pass, work);
    pass.end();
    expect(encoder.finish().ok).toBe(true);
    expect(host.value.dispose().ok).toBe(true);
  });
});
