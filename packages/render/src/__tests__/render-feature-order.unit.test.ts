import type { ResourceDescriptor } from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import {
  createRenderFeatureContributionStaging,
  mergeRenderFeatureContributions,
} from '../features/graph-contribution';

const resource: ResourceDescriptor = {
  kind: 'texture',
  lifetime: 'transient',
};

function pass(reads: readonly string[] = []) {
  return { reads, writes: [], execute: () => undefined };
}

describe('render feature contribution order', () => {
  it('sorts contributions by registration order before preserving declaration order', () => {
    const late = createRenderFeatureContributionStaging('synthetic.late', 2);
    const early = createRenderFeatureContributionStaging('synthetic.early', 0);
    late.addResource('target', resource);
    early.addResource('target', resource);
    late.addPass('late-pass', pass(['target']));
    early.addPass('first-pass', pass(['target']));

    const merged = mergeRenderFeatureContributions([
      late.commit().unwrap(),
      early.commit().unwrap(),
    ]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.passes.map((entry) => entry.name)).toEqual([
      'synthetic.early::first-pass',
      'synthetic.late::late-pass',
    ]);
  });

  it('keeps a same-feature dependency in declared order', () => {
    const feature = createRenderFeatureContributionStaging('synthetic.feature', 0);
    feature.addResource('target', resource);
    feature.addPass('first', pass(['target']));
    feature.addPass('second', pass(['target']), {
      dependsOn: [{ featureIdentity: 'synthetic.feature', passIdentity: 'first' }],
    });

    const merged = mergeRenderFeatureContributions([feature.commit().unwrap()]);

    expect(merged.ok).toBe(true);
  });

  it('reports a same-feature dependency on a later declaration', () => {
    const feature = createRenderFeatureContributionStaging('synthetic.feature', 0);
    feature.addResource('target', resource);
    feature.addPass('first', pass(['target']), {
      dependsOn: [{ featureIdentity: 'synthetic.feature', passIdentity: 'second' }],
    });
    feature.addPass('second', pass(['target']));

    const merged = mergeRenderFeatureContributions([feature.commit().unwrap()]);

    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.error.code).toBe('render-feature-pass-order-conflict');
  });
});
