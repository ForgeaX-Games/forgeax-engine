import type {
  RenderError,
  RenderFeature,
  RenderFeatureErrorDescriptor,
  RenderFeaturePreparedRef,
} from '@forgeax/engine-render';
import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';

type ParticleRenderBatch = {
  readonly batches: readonly unknown[];
};

interface PreparedGraphicsRefs {
  readonly pipeline: RenderFeaturePreparedRef<'pipeline'>;
  readonly bindings: RenderFeaturePreparedRef<'bindings'>;
  readonly vertexData: RenderFeaturePreparedRef<'vertex-data'>;
}

function describeRenderFeatureError(error: RenderFeatureErrorDescriptor): string {
  switch (error.code) {
    case 'render-feature-registration-conflict':
      return `${error.detail.featureIdentity}:${error.detail.conflictingOrder}`;
    case 'render-feature-stage-failed':
      return `${error.detail.featureIdentity}:${error.detail.stage}:${error.detail.recovery}`;
    case 'render-feature-capability-missing':
      return `${error.detail.featureIdentity}:${error.detail.capability}`;
    case 'render-feature-pass-order-conflict':
      return `${error.detail.passIdentity}:${error.detail.dependencyIdentity}`;
    case 'render-feature-preparation-failed':
      return `${error.detail.resourceKind}:${error.detail.resourceName}`;
    case 'render-feature-prepared-state-mismatch':
      switch (error.detail.reason) {
        case 'missing-prepared-state':
          return `${error.detail.resourceKind}:${error.detail.missingResource}`;
        case 'foreign-feature':
          return `${error.detail.expectedFeatureIdentity}:${error.detail.actualFeatureIdentity}`;
        case 'foreign-kind':
          return `${error.detail.expectedKind}:${error.detail.actualKind}`;
        case 'generation-mismatch':
          return `${error.detail.expectedGeneration}:${error.detail.actualGeneration}`;
        case 'layout-mismatch':
          return `${error.detail.expectedLayout}:${error.detail.actualLayout}`;
        case 'format-mismatch':
          return `${error.detail.expectedFormat}:${error.detail.actualFormat}`;
      }
      break;
    case 'render-feature-draw-recording-failed':
      return `${error.detail.resourceKind}:${error.detail.backendReason}`;
  }
}

function publicPreparedRecipe(batch: ParticleRenderBatch): RenderFeature<ParticleRenderBatch> {
  let prepared: PreparedGraphicsRefs | undefined;
  const feature: RenderFeature<ParticleRenderBatch> = {
    identity: 'docs.prepared-graphics',
    extract: () => ok(batch),
    prepare: (data, context): Result<void, RenderError> => {
      const pipeline = context.graphics.preparePipeline('docs.pipeline', {
        shader: 'docs.shader',
        vertexLayout: 'particle-billboard',
        colorFormats: ['rgba8unorm-srgb'],
      });
      if (!pipeline.ok) return pipeline;
      const bindings = context.graphics.prepareBindings('docs.bindings', {
        pipeline: pipeline.value,
        values: { batchCount: data.batches.length },
      });
      if (!bindings.ok) return bindings;
      const vertexData = context.graphics.prepareVertexData('docs.vertices', {
        layout: 'particle-billboard',
        data: new Float32Array(),
      });
      if (!vertexData.ok) return vertexData;
      prepared = {
        pipeline: pipeline.value,
        bindings: bindings.value,
        vertexData: vertexData.value,
      };
      return ok(undefined);
    },
    contribute: (data, context): Result<void, RenderError> => {
      if (prepared === undefined) {
        return ok(undefined);
      }
      return context.staging.addGraphicsPass('docs.prepared-pass', {
        attachments: {
          colors: [
            {
              resource: 'swap-chain',
              format: 'rgba8unorm-srgb',
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
        },
        draws: [
          {
            kind: 'draw',
            pipeline: prepared.pipeline,
            bindings: [prepared.bindings],
            vertexData: [{ slot: 0, resource: prepared.vertexData }],
            command: {
              vertexCount: data.batches.length * 0,
              instanceCount: 1,
            },
          },
        ],
      });
    },
  };
  return feature;
}

describe('public prepared graphics recipe', () => {
  it('keeps the public imports and callback inference type-safe', () => {
    const batch: ParticleRenderBatch = { batches: [] };
    expectTypeOf(publicPreparedRecipe).parameter(0).toMatchTypeOf<ParticleRenderBatch>();
    expectTypeOf(publicPreparedRecipe).returns.toMatchTypeOf<RenderFeature<ParticleRenderBatch>>();
    expect(typeof publicPreparedRecipe).toBe('function');
    expect(batch.batches).toHaveLength(0);
  });

  it('keeps structured error fields available without message parsing', () => {
    const error: RenderFeatureErrorDescriptor = {
      code: 'render-feature-stage-failed',
      expected: "feature 'docs.prepared-graphics' completes its prepare stage without an error",
      hint: "correct 'docs.prepared-graphics' prepare data and retry on the next frame",
      detail: {
        featureIdentity: 'docs.prepared-graphics',
        order: 0,
        stage: 'prepare',
        recovery: 'next-frame',
      },
    };
    expect(describeRenderFeatureError(error)).toBe('docs.prepared-graphics:prepare:next-frame');
    expect(error.expected).toContain('prepare');
    expect(error.hint).toContain('next frame');
    expect(error.detail.recovery).toBe('next-frame');
  });
});
