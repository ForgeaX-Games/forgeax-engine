import { describe, expect, it } from 'vitest';
import { runLodOcclusionDawnVisualEvidence } from './lod-occlusion-visual-evidence';

describe('LOD occlusion Dawn visual evidence', () => {
  it('proves matching-identity zero/positive readback and recovery invariants', async () => {
    const evidence = await runLodOcclusionDawnVisualEvidence();
    expect(evidence.status).toBe('available');
    expect(evidence.verdict).toBe('pass');
    expect(evidence.confidence).toBe('high');
    expect(evidence.identity.commit.length).toBeGreaterThan(0);
    expect(evidence.observed).toEqual(
      expect.arrayContaining([
        'zero-samples:0',
        'out-of-order:true',
        'stale-visible:true',
        'fault-visible:true',
      ]),
    );
  });
});
