import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type {
  RenderFeatureDrawRecord,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import type { RenderFeature } from '../features/types';

const supportedCaps: Readonly<RhiCaps> = {
  backendKind: 'null',
  compute: true,
  timestampQuery: false,
  indirectDrawing: false,
  textureCompressionBc: false,
} as RhiCaps;

const missingCaps: Readonly<RhiCaps> = { ...supportedCaps, compute: false };

function preparedFeature(): RenderFeature<{ readonly draw: RenderFeatureDrawRecord }> {
  let pipeline: RenderFeaturePreparedRef<'pipeline'> | undefined;
  let bindings: RenderFeaturePreparedRef<'bindings'> | undefined;
  let vertices: RenderFeaturePreparedRef<'vertex-data'> | undefined;

  return {
    identity: 'synthetic.capability',
    requiredCapabilities: ['compute'],
    extract: () =>
      ok({
        draw: {
          kind: 'draw',
          pipeline: { kind: 'pipeline', generation: 0 },
          bindings: [{ kind: 'bindings', generation: 0 }],
          vertexData: [{ slot: 0, resource: { kind: 'vertex-data', generation: 0 } }],
          command: { vertexCount: 3, instanceCount: 1 },
        },
      }),
    prepare: (_data, context) => {
      const preparedPipeline = context.graphics.preparePipeline('pipeline', {
        shader: 'synthetic.shader',
        vertexLayout: 'position',
        colorFormats: ['rgba8unorm'],
      });
      if (!preparedPipeline.ok) return preparedPipeline;
      const preparedBindings = context.graphics.prepareBindings('bindings', {
        pipeline: preparedPipeline.value,
        values: { opacity: 1 },
      });
      if (!preparedBindings.ok) return preparedBindings;
      const preparedVertices = context.graphics.prepareVertexData('vertices', {
        layout: 'position',
        data: [0, 0, 0],
      });
      if (!preparedVertices.ok) return preparedVertices;
      pipeline = preparedPipeline.value;
      bindings = preparedBindings.value;
      vertices = preparedVertices.value;
      return ok(undefined);
    },
    contribute: (data, context) => {
      if (pipeline === undefined || bindings === undefined || vertices === undefined) {
        return ok(undefined);
      }
      context.staging.addResource('color', { kind: 'texture', lifetime: 'transient' });
      return context.staging.addGraphicsPass('prepared', {
        attachments: {
          colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
        },
        draws: [
          {
            ...data.draw,
            pipeline,
            bindings: [bindings],
            vertexData: [{ slot: 0, resource: vertices }],
          },
        ],
      });
    },
  };
}

describe('prepared graphics capability projection', () => {
  it('projects supported capability into an accepted machine-readable operation', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: supportedCaps,
    });

    expect(result.errors).toEqual([]);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]?.passes[0]?.graphicsState).toMatchObject({
      capabilityAvailable: true,
      generation: 0,
    });
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('returns a structured capability failure without a silent operation', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: missingCaps,
    });

    expect(result.contributions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'render-feature-capability-missing',
      expected: expect.stringContaining('compute'),
      hint: expect.stringContaining('disable'),
      detail: {
        featureIdentity: 'synthetic.capability',
        capability: 'compute',
      },
    });
    expect(host.diagnostics()[0]?.status).toBe('disabled');
  });
});
