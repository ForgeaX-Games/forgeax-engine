import { freezeRenderFeaturePlan } from '../../render/src/features/plan';
import { describe, expect, it } from 'vitest';
import { createDebugDrawRenderFeaturePlan } from '../src/render-feature';

describe('debug draw RenderFeature plan', () => {
  it('uses the render-owned plan vocabulary for a line draw', () => {
    const plan = createDebugDrawRenderFeaturePlan({
      vertexCapacity: 32,
      vertexCount: 6,
      target: 'scene-color',
      colorFormat: 'rgba16float',
      viewProjection: new Float32Array(16),
    });
    const validated = freezeRenderFeaturePlan('debug-draw', plan, [
      { name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 },
    ]);

    expect(validated.ok).toBe(true);
    expect(plan.resources.map((resource) => resource.kind)).toEqual([
      'graphics-program',
      'graphics-bindings',
      'buffer',
      'vertex-data',
    ]);
    expect(plan.passes[0]).toMatchObject({
      kind: 'raster',
      draws: [{ draw: { kind: 'draw', vertexCount: 6 } }],
    });
  });
});
