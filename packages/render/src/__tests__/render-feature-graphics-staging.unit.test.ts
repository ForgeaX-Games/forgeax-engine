import { RenderGraph, type ResourceDescriptor } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import {
  composeRenderFeatureGraph,
  createRenderFeatureContributionStaging,
} from '../features/graph-contribution';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';

const target: ResourceDescriptor = { kind: 'texture', lifetime: 'transient' };

const pass: RenderFeatureGraphicsPassDescriptor = {
  attachments: {
    colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
  },
  draws: [
    {
      kind: 'draw',
      pipeline: { kind: 'pipeline', generation: 2 } as RenderFeaturePreparedRef<'pipeline'>,
      bindings: [{ kind: 'bindings', generation: 2 }],
      vertexData: [{ slot: 0, resource: { kind: 'vertex-data', generation: 2 } }],
      command: { vertexCount: 3, instanceCount: 1 },
    },
  ],
};

describe('render feature graphics staging', () => {
  it('projects an accepted graphics pass into the active graph contribution', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.graphics', 0);
    expect(staging.addResource('color', target).ok).toBe(true);
    expect(staging.addGraphicsPass('forward', pass).ok).toBe(true);

    const contribution = staging.commit();
    expect(contribution.ok).toBe(true);
    if (!contribution.ok) return;
    expect(contribution.value.passes).toHaveLength(1);
    expect(contribution.value.passes[0]).toMatchObject({
      name: 'synthetic.graphics::forward',
      graphics: pass,
    });

    const graph = new RenderGraph();
    const composed = composeRenderFeatureGraph(graph, [contribution.value]);
    expect(composed.ok).toBe(true);
    if (composed.ok) {
      expect(composed.value.passNames).toEqual(['synthetic.graphics::forward']);
      expect(composed.value.graph).toBe(graph);
    }
  });

  it('keeps ordinary addPass graph-only and contributes no work for an empty draw list', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.empty', 0);
    const empty: RenderFeatureGraphicsPassDescriptor = { ...pass, draws: [] };
    expect(staging.addGraphicsPass('empty', empty).ok).toBe(true);
    const contribution = staging.commit();
    expect(contribution.ok).toBe(true);
    if (contribution.ok) {
      expect(contribution.value.passes).toHaveLength(0);
      expect(contribution.value.resources).toHaveLength(0);
    }
  });

  it('aborts graphics staging without creating a feature-private graph', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.failed', 0);
    expect(staging.addResource('color', target).ok).toBe(true);
    expect(staging.addGraphicsPass('forward', pass).ok).toBe(true);
    staging.abort();
    expect(staging.resources).toEqual([]);
    expect(staging.passes).toEqual([]);
    expect(staging.commit().ok).toBe(false);
  });
});
