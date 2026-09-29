import { describe, expect, it } from 'vitest';
import { runLodOcclusionBrowserVisualEvidence } from './lod-occlusion-visual-evidence';

describe('LOD occlusion Browser visual evidence', () => {
  it('publishes compositor evidence or an explicit unavailable result', () => {
    const evidence = runLodOcclusionBrowserVisualEvidence();
    expect(evidence.backend).toBe('browser');
    expect(evidence.identity.commit.length).toBeGreaterThan(0);
    if (evidence.status === 'unavailable') {
      expect(evidence.verdict).toBe('unavailable');
      expect(evidence.confidence).toBe('none');
      expect(evidence.reason).toContain('visual');
    }
  });
});
