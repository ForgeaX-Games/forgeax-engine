import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  runRenderFeatureFrame,
} from '../features/host';
import {
  createBuiltinMorphFeature,
  createMorphReentryState,
  deriveMorphBounds,
  MORPH_COMPUTE_WGSL,
  morphCullDecision,
  stepMorphReentry,
} from '../features/morph/morph-feature';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';

const baseBounds = {
  min: [-1, -1, -1] as const,
  max: [1, 1, 1] as const,
};

describe('Morph GPU culling and re-entry', () => {
  it('expands bounds from weighted target deltas before culling', () => {
    const bounds = deriveMorphBounds(
      baseBounds,
      [{ min: [-2, 0, 0], max: [3, 0, 0] }],
      new Float32Array([0.5]),
    );

    expect(bounds).toEqual({ min: [-2, -1, -1], max: [2.5, 1, 1] });
    expect(
      morphCullDecision({
        weights: new Float32Array([0.5]),
        expectedWeightCount: 1,
        baseAabbIntersectsFrustum: false,
      }),
    ).toBe('draw');
  });

  it('clears stale weights when a culled instance re-enters', () => {
    const state = createMorphReentryState();
    expect(
      stepMorphReentry(state, {
        frameNumber: 1,
        visible: true,
        generation: 0,
        weights: new Float32Array([0.25]),
      }),
    ).toMatchObject({ reentered: false, clearStale: false });
    expect(
      stepMorphReentry(state, {
        frameNumber: 2,
        visible: false,
        generation: 0,
        weights: new Float32Array([0]),
      }),
    ).toMatchObject({ reentered: false, clearStale: false });
    expect(
      stepMorphReentry(state, {
        frameNumber: 3,
        visible: true,
        generation: 0,
        weights: new Float32Array([0.75]),
      }),
    ).toMatchObject({ reentered: true, clearStale: true, weights: [0.75] });
  });

  it('declares compute and storage capability ownership and records 300 frame phases', () => {
    let frameNumber = 0;
    const feature = createBuiltinMorphFeature({
      collect: () => [
        {
          identity: 'format-tier1.face',
          vertexCount: 3,
          targetBounds: [{ min: [-2, 0, 0], max: [3, 0, 0] }],
          baseBounds,
          weights: new Float32Array([frameNumber >= 200 ? 1 : 0]),
          baseAabbIntersectsFrustum: frameNumber < 100 || frameNumber >= 200,
        },
      ],
    });

    expect(feature.requiredCapabilities).toEqual(['compute', 'storageBuffer']);
    let culledFrames = 0;
    let reentries = 0;
    for (frameNumber = 0; frameNumber < 300; frameNumber++) {
      const extracted = feature.extract({ worlds: [], owner: 0, frameNumber });
      expect(extracted.ok).toBe(true);
      if (!extracted.ok) continue;
      culledFrames += extracted.value.culledCount;
      reentries += extracted.value.reentryCount;
    }

    expect(culledFrames).toBe(100);
    expect(reentries).toBe(1);
  });

  it('submits one real Dawn compute frame through the Morph feature seam', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await createShaderModule(device, { code: MORPH_COMPUTE_WGSL })).unwrap();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const feature = createBuiltinMorphFeature({
      collect: () => [
        {
          identity: 'dawn-triangle',
          vertexCount: 3,
          baseBounds,
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
    const contribution =
      frame.plans[0] === undefined
        ? undefined
        : getRenderFeaturePlanExecutionProjection(frame.plans[0]);
    const encoder = device.createCommandEncoder({ label: 'dawn-morph-frame' }).unwrap();
    const work = contribution?.passes[0]?.resolvedGpuCompute;
    expect(work).toBeDefined();
    if (work === undefined) return;
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const projection = new RenderFeatureComputeGraphProjection(graph);
    expect(projection.addPass('forgeax.morph.compute', 'forgeax.morph', 0, work).ok).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.execute({ encoder }).ok).toBe(true);
    const commandBuffer = encoder.finish();
    expect(commandBuffer.ok).toBe(true);
    if (!commandBuffer.ok) return;
    expect(device.queue.submit([commandBuffer.value]).ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    expect((await compiled.retire()).ok).toBe(true);
    expect(host.value.dispose().ok).toBe(true);
  });
});
