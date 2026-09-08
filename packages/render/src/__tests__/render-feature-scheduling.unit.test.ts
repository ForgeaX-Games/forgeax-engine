import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';

const caps = {
  backendKind: 'null',
  compute: true,
  timestampQuery: true,
  timestampPeriodNanoseconds: null,
  indirectDrawing: true,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: true,
  firstInstanceIndirect: true,
  storageBuffer: true,
  storageTexture: true,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: true,
  float32Filterable: true,
  maxColorAttachments: 8,
} satisfies RhiCaps;

function feature(identity: string, events: string[], failStage?: 'extract' | 'plan') {
  const value = { identity };
  return {
    identity,
    extract: () => {
      events.push(`${identity}:extract`);
      return failStage === 'extract'
        ? err(new RenderFeatureStageFailedError(identity, 0, 'extract', 'next-frame'))
        : ok(value);
    },
    plan: () => {
      events.push(`${identity}:plan`);
      return failStage === 'plan'
        ? err(new RenderFeatureStageFailedError(identity, 0, 'plan', 'next-frame'))
        : ok({ resources: [], passes: [] });
    },
  } satisfies RenderFeature<typeof value>;
}

describe('render feature stage scheduling', () => {
  it('runs each feature once in registration and stage order', () => {
    const events: string[] = [];
    const host = createRenderFeatureHost([
      feature('synthetic.first', events),
      feature('synthetic.second', events),
    ]).unwrap();

    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 7,
      caps,
    });

    expect(
      result.stageEvents.map(({ featureIdentity, stage }) => `${featureIdentity}:${stage}`),
    ).toEqual([
      'synthetic.first:extract',
      'synthetic.first:plan',
      'synthetic.second:extract',
      'synthetic.second:plan',
    ]);
  });

  it.each([
    'extract',
    'plan',
  ] as const)('isolates a %s failure from the healthy feature', (failStage) => {
    const events: string[] = [];
    const host = createRenderFeatureHost([
      feature('synthetic.failed', events, failStage),
      feature('synthetic.healthy', events),
    ]).unwrap();

    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 8,
      caps,
    });

    expect(result.errors).toHaveLength(1);
    const error = result.errors[0];
    expect(error?.code).toBe('render-feature-stage-failed');
    if (error?.code === 'render-feature-stage-failed') {
      expect(error.detail).toMatchObject({
        featureIdentity: 'synthetic.failed',
        stage: failStage,
      });
    }
    expect(events).toContain('synthetic.healthy:extract');
    expect(events).toContain('synthetic.healthy:plan');
    const failedEvents = events.filter((event) => event.startsWith('synthetic.failed:'));
    const failedStageIndex = ['extract', 'plan'].indexOf(failStage);
    expect(failedEvents).toEqual(
      ['extract', 'plan']
        .slice(0, failedStageIndex + 1)
        .map((stage) => `synthetic.failed:${stage}`),
    );
  });
});
