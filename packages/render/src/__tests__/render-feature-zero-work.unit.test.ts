import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';

function noWorkFeature(identity: string): RenderFeature<{ readonly empty: true }> {
  return {
    identity,
    extract: () => ok({ empty: true }),
    plan: () => ok({ resources: [], passes: [] }),
  };
}

function failedFeature(identity: string): RenderFeature<{ readonly empty: true }> {
  return {
    identity,
    extract: () => err(new RenderFeatureStageFailedError(identity, 0, 'extract', 'next-frame')),
    plan: () => ok({ resources: [], passes: [] }),
  };
}

describe('render feature zero-work boundaries', () => {
  it('keeps an empty registry free of work, errors, and proxy noise', () => {
    const host = createRenderFeatureHost([]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 11,
      caps: {} as never,
    });

    expect(result.stageEvents).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.plans).toEqual([]);
  });

  it('keeps empty data and zero-pass features as an empty plan', () => {
    const host = createRenderFeatureHost([noWorkFeature('synthetic.empty')]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 12,
      caps: {} as never,
    });

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(
      result.stageEvents.map(({ featureIdentity, stage }) => `${featureIdentity}:${stage}`),
    ).toEqual(['synthetic.empty:extract', 'synthetic.empty:plan']);
  });

  it('does not remove healthy work when one feature fails or is disabled', () => {
    const host = createRenderFeatureHost([
      failedFeature('synthetic.failed'),
      noWorkFeature('synthetic.healthy'),
      noWorkFeature('synthetic.disabled'),
    ]).unwrap();
    host.setStatus('synthetic.disabled', 'disabled');

    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 13,
      caps: {} as never,
    });

    expect(result.errors).toHaveLength(1);
    expect(
      result.stageEvents.map(({ featureIdentity, stage }) => `${featureIdentity}:${stage}`),
    ).toEqual(['synthetic.failed:extract', 'synthetic.healthy:extract', 'synthetic.healthy:plan']);
    expect(result.plans).toHaveLength(1);
  });
});
