import { describe, expect, it } from 'vitest';
import { runOcclusionQueryDawnEvidence } from './occlusion-query.evidence';

describe('occlusion query Dawn evidence', () => {
  it('maps real zero and positive query results with identity and lifecycle evidence', async () => {
    const evidence = await runOcclusionQueryDawnEvidence();
    expect(evidence.status).toBe('available');
    expect(evidence.identity.commit.length).toBeGreaterThan(0);
    expect(evidence.identity.device).toBe('webgpu-dawn');
    expect(evidence.zeroSamples).toBe(0);
    expect(evidence.positiveSamples).toBeGreaterThan(0);
    expect(evidence.outOfOrder).toBe(true);
    expect(evidence.staleVisible).toBe(true);
    expect(evidence.faultVisible).toBe(true);
  });
});
