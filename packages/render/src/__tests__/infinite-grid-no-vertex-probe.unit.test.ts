import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeaturePlan } from '../features/plan';
import type { RenderFeature } from '../features/types';

const caps = {
  backendKind: 'null',
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: true,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: true,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: true,
  float32Filterable: true,
  maxColorAttachments: 8,
} as const;

function noVertexFeature(): RenderFeature<{ readonly drawCount: number }> {
  return {
    identity: 'editor.infinite-grid.probe',
    extract: () => ok({ drawCount: 1 }),
    plan: () => {
      const value: RenderFeaturePlan = {
        resources: [
          {
            kind: 'graphics-program',
            name: 'fullscreen',
            program: {
              shader: 'editor.infinite-grid.probe',
              vertexLayout: 'none',
              colorFormats: ['rgba8unorm'],
            },
          },
          { kind: 'graphics-bindings', name: 'view', program: 'fullscreen', values: {} },
        ],
        passes: [
          {
            kind: 'raster',
            name: 'infinite-grid',
            colorAttachments: [{ target: 'swapchain', loadOp: 'load', storeOp: 'store' }],
            draws: [
              {
                program: 'fullscreen',
                bindings: ['view'],
                vertexData: [],
                vertexLayout: 'none',
                draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
              },
            ],
          },
        ],
      };
      return ok(value);
    },
  };
}

describe('public no-vertex RenderFeature seam probe', () => {
  it('accepts the explicit public no-vertex producer contract', () => {
    const host = createRenderFeatureHost([noVertexFeature()]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps,
    });

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.plan.passes[0]).toMatchObject({
      kind: 'raster',
      draws: [{ vertexLayout: 'none', vertexData: [], draw: { kind: 'draw' } }],
    });
    expect(host.diagnostics()[0]).toMatchObject({
      identity: 'editor.infinite-grid.probe',
      status: 'active',
      latestError: undefined,
    });
    expect(result.stageEvents.map((event) => event.stage)).toEqual(['extract', 'plan']);
  });
});
