import { describe, expect, it } from 'vitest';
import type { RenderFeaturePlannedFrame } from '../../features/plan';
import {
  type RenderFeatureGraphCandidate,
  renderFeatureGraphPlanSignature,
} from '../typed-frame-graph';

function planned(generation: number, signature: string): RenderFeaturePlannedFrame {
  return {
    featureIdentity: 'synthetic.feature',
    generation,
    signature,
    plan: { resources: [], passes: [] },
  };
}

describe('typed frame graph feature plan authority', () => {
  it('keys topology and last-known-good candidates by stable plan signature and generation', () => {
    const first = renderFeatureGraphPlanSignature([planned(1, 'plan-a')]);
    expect(renderFeatureGraphPlanSignature([planned(1, 'plan-a')])).toBe(first);
    expect(renderFeatureGraphPlanSignature([planned(1, 'plan-b')])).not.toBe(first);
    expect(renderFeatureGraphPlanSignature([planned(2, 'plan-a')])).not.toBe(first);
  });

  it('keys candidates only by producer plans', () => {
    const candidate: RenderFeatureGraphCandidate = {
      plans: [planned(1, 'plan-a')],
      fullscreenEffects: new Map(),
    };
    expect(candidate.plans).toHaveLength(1);
  });

  it('keeps execution projection out of the public planned-frame vocabulary', () => {
    const invalid: RenderFeaturePlannedFrame = {
      ...planned(1, 'plan-a'),
      // @ts-expect-error execution belongs to the graph candidate adapter, not the producer plan.
      execution: {},
    };
    void invalid;
  });
});
