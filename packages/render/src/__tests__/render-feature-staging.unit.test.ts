import type { ResourceDescriptor } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import {
  createRenderFeatureContributionStaging,
  mergeRenderFeatureContributions,
} from '../features/graph-contribution';

const transientTexture: ResourceDescriptor = {
  kind: 'texture',
  lifetime: 'transient',
};

function pass() {
  return { reads: [], writes: ['color'], execute: () => undefined };
}

describe('render feature contribution staging', () => {
  it('commits resources and passes only after a successful callback', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.alpha', 0);
    expect(staging.addResource('color', transientTexture).ok).toBe(true);
    expect(staging.addPass('draw', pass()).ok).toBe(true);

    const contribution = staging.commit();

    expect(contribution.ok).toBe(true);
    if (!contribution.ok) return;
    expect(contribution.value.resources).toHaveLength(1);
    expect(contribution.value.passes.map((entry) => entry.name)).toEqual(['synthetic.alpha::draw']);
  });

  it('does not publish a partial contribution when staging is aborted', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.failed', 0);
    expect(staging.addResource('color', transientTexture).ok).toBe(true);
    expect(staging.addPass('draw', pass()).ok).toBe(true);

    staging.abort();

    expect(staging.commit().ok).toBe(false);
    expect(staging.resources).toHaveLength(0);
    expect(staging.passes).toHaveLength(0);
  });

  it('keeps identical local names isolated by feature namespace', () => {
    const alpha = createRenderFeatureContributionStaging('synthetic.alpha', 0);
    const beta = createRenderFeatureContributionStaging('synthetic.beta', 1);
    alpha.addResource('color', transientTexture);
    beta.addResource('color', transientTexture);
    alpha.addPass('draw', pass());
    beta.addPass('draw', pass());

    const merged = mergeRenderFeatureContributions([
      alpha.commit().unwrap(),
      beta.commit().unwrap(),
    ]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.resources.map((entry) => entry.name)).toEqual([
      'synthetic.alpha::color',
      'synthetic.beta::color',
    ]);
    expect(merged.value.passes.map((entry) => entry.name)).toEqual([
      'synthetic.alpha::draw',
      'synthetic.beta::draw',
    ]);
  });

  it('rejects a dependency that points to a later feature', () => {
    const alpha = createRenderFeatureContributionStaging('synthetic.alpha', 0);
    const beta = createRenderFeatureContributionStaging('synthetic.beta', 1);
    alpha.addResource('color', transientTexture);
    beta.addResource('color', transientTexture);
    alpha.addPass('draw', pass(), {
      dependsOn: [{ featureIdentity: 'synthetic.beta', passIdentity: 'draw' }],
    });
    beta.addPass('draw', pass());

    const merged = mergeRenderFeatureContributions([
      alpha.commit().unwrap(),
      beta.commit().unwrap(),
    ]);

    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.error.code).toBe('render-feature-pass-order-conflict');
    if (merged.error.code === 'render-feature-pass-order-conflict') {
      expect(merged.error.detail).toMatchObject({
        featureIdentity: 'synthetic.alpha',
        passIdentity: 'synthetic.alpha::draw',
        dependencyIdentity: 'synthetic.beta::draw',
      });
    }
  });
});
