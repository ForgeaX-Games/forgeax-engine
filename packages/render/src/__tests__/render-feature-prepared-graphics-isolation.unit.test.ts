import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';

const caps = { backendKind: 'null' } as unknown as Readonly<RhiCaps>;

function ordinaryFeature(identity: string): RenderFeature<{ readonly work: true }> {
  return {
    identity,
    extract: () => ok({ work: true }),
    prepare: () => ok(undefined),
    contribute: (_data, context) => {
      context.staging.addResource('base', { kind: 'texture', lifetime: 'transient' });
      return context.staging.addPass('base', {
        reads: [],
        writes: ['base'],
        execute: () => undefined,
      });
    },
  };
}

function preparedFeature(
  identity: string,
  mode: 'healthy' | 'invalid' | 'empty',
): RenderFeature<{ readonly work: true }> {
  let pipeline: { kind: 'pipeline'; generation: number } | undefined;
  let bindings: { kind: 'bindings'; generation: number } | undefined;
  let vertices: { kind: 'vertex-data'; generation: number } | undefined;
  return {
    identity,
    extract: () => ok({ work: true }),
    prepare: (_data, context) => {
      const preparedPipeline = context.graphics.preparePipeline('forward', {
        shader: 'synthetic',
        vertexLayout: 'position',
        colorFormats: ['rgba8unorm'],
      });
      if (!preparedPipeline.ok) return preparedPipeline;
      const preparedBindings = context.graphics.prepareBindings('forward', {
        pipeline: preparedPipeline.value,
        values: {},
      });
      if (!preparedBindings.ok) return preparedBindings;
      const preparedVertices = context.graphics.prepareVertexData('triangle', {
        layout: 'position',
        data: [0, 0, 0],
      });
      if (!preparedVertices.ok) return preparedVertices;
      pipeline = preparedPipeline.value;
      bindings = preparedBindings.value;
      vertices = preparedVertices.value;
      return ok(undefined);
    },
    contribute: (_data, context) => {
      if (mode === 'empty') return ok(undefined);
      if (pipeline === undefined || bindings === undefined || vertices === undefined) {
        return err(new RenderFeatureStageFailedError(identity, 0, 'contribute', 'next-frame'));
      }
      context.staging.addResource('color', { kind: 'texture', lifetime: 'transient' });
      return context.staging.addGraphicsPass('forward', {
        attachments: {
          colors:
            mode === 'healthy'
              ? [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }]
              : [{ resource: 'missing', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
        },
        draws: [
          {
            kind: 'draw',
            pipeline,
            bindings: [bindings],
            vertexData: [{ slot: 0, resource: vertices }],
            command: { vertexCount: 3, instanceCount: 1 },
          },
        ],
      });
    },
  };
}

describe('prepared graphics feature isolation', () => {
  it('aborts only the failed feature while preserving healthy and base contributions', () => {
    const host = createRenderFeatureHost([
      preparedFeature('synthetic.failed', 'invalid'),
      ordinaryFeature('synthetic.healthy'),
    ]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      detail: { featureIdentity: 'synthetic.failed' },
    });
    expect(result.contributions.map((contribution) => contribution.featureIdentity)).toEqual([
      'synthetic.healthy',
    ]);
    expect(result.contributions[0]?.passes.map((pass) => pass.name)).toEqual([
      'synthetic.healthy::base',
    ]);
  });

  it('treats an empty feature as successful no-work without a phantom graphics pass', () => {
    const host = createRenderFeatureHost([preparedFeature('synthetic.empty', 'empty')]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps,
    });
    expect(result.errors).toEqual([]);
    expect(result.contributions).toEqual([]);
    expect(host.diagnostics()[0]?.status).toBe('active');
  });
});
