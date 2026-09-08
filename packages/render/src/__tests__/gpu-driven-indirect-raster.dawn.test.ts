import { describe, expect, it } from 'vitest';
import { runGpuDrivenIndirectRasterEvidence } from './gpu-driven-indirect-raster-evidence';

describe('GPU-driven indirect raster Dawn', () => {
  it('consumes indexed, non-indexed, and multi-submesh indirect args without CPU readback', async () => {
    const evidence = await runGpuDrivenIndirectRasterEvidence();
    expect(evidence.pixel).toEqual([64, 128, 191, 255]);
    expect(evidence.passNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
      'gpu-driven.opaque-indirect',
      'gpu-driven.raster-readback',
    ]);
  });
});
