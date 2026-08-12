import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import { createRenderFeatureTarget } from '../features/targets';
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

const colorTarget = createRenderFeatureTarget({
  kind: 'scene-color',
  resource: 'scene-color',
  format: 'rgba8unorm',
  sampleCount: 1,
});
const depthTarget = createRenderFeatureTarget({
  kind: 'scene-depth',
  resource: 'scene-depth',
  format: 'depth24plus',
  sampleCount: 1,
});

function noVertexFeature(): RenderFeature<{ readonly drawCount: number }> {
  let pipeline: import('../features/prepared-graphics').RenderFeaturePreparedRef<'pipeline'>;
  let bindings: import('../features/prepared-graphics').RenderFeaturePreparedRef<'bindings'>;

  return {
    identity: 'editor.infinite-grid.probe',
    extract: () => ok({ drawCount: 1 }),
    prepare: (_data, context) => {
      const preparedPipeline = context.graphics.preparePipeline('fullscreen', {
        shader: 'editor.infinite-grid.probe',
        vertexLayout: 'none',
        colorFormats: [colorTarget.format],
        depthFormat: depthTarget.format,
        sampleCount: colorTarget.sampleCount,
        topology: 'triangle-list',
      });
      if (!preparedPipeline.ok) return preparedPipeline;
      const preparedBindings = context.graphics.prepareBindings('view', {
        pipeline: preparedPipeline.value,
        values: { vertexShaderUsesVertexIndex: true },
      });
      if (!preparedBindings.ok) return preparedBindings;
      pipeline = preparedPipeline.value;
      bindings = preparedBindings.value;
      return ok(undefined);
    },
    contribute: (_data, context) => {
      if (pipeline === undefined || bindings === undefined) return ok(undefined);
      return context.staging.addGraphicsPass('infinite-grid', {
        attachments: {
          colors: [
            { resource: colorTarget, format: colorTarget.format, loadOp: 'load', storeOp: 'store' },
          ],
          depthStencil: {
            resource: depthTarget,
            format: depthTarget.format,
            depthLoadOp: 'load',
            depthStoreOp: 'store',
          },
        },
        draws: [
          {
            kind: 'draw',
            pipeline,
            bindings: [bindings],
            vertexData: [],
            vertexLayout: 'none',
            command: { vertexCount: 3, instanceCount: 1 },
          },
        ],
      });
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
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]?.passes[0]?.graphics?.draws[0]).toMatchObject({
      kind: 'draw',
      vertexLayout: 'none',
      vertexData: [],
      command: { vertexCount: 3, instanceCount: 1 },
    });
    expect(host.diagnostics()[0]).toMatchObject({
      identity: 'editor.infinite-grid.probe',
      status: 'active',
      latestError: undefined,
    });
    expect(result.stageEvents.map((event) => event.stage)).toEqual([
      'extract',
      'prepare',
      'contribute',
    ]);
  });
});
