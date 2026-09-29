import { describe, expect, it } from 'vitest';
import { buildPbrViewBglEntries } from '../pbr-pipeline';
import {
  GPU_DRIVEN_PRODUCTION_VIEW_BGL_ENTRIES,
  runGpuDrivenIndirectRasterEvidence,
} from './gpu-driven-indirect-raster-evidence';

describe('GPU-driven indirect raster Dawn', () => {
  it('matches the shared PBR View BGL dynamic-offset slots', () => {
    const fixtureDynamicBindings = GPU_DRIVEN_PRODUCTION_VIEW_BGL_ENTRIES.filter(
      (entry) => entry.buffer?.hasDynamicOffset === true,
    ).map((entry) => entry.binding);
    const sharedDynamicBindings = buildPbrViewBglEntries({ storageBuffer: true })
      .filter((entry) => entry.buffer?.hasDynamicOffset === true)
      .map((entry) => entry.binding);

    expect(fixtureDynamicBindings).toEqual([0, 10]);
    expect(fixtureDynamicBindings).toEqual(sharedDynamicBindings);
  });

  it('consumes indexed, non-indexed, and multi-submesh indirect args without CPU readback', async () => {
    const evidence = await runGpuDrivenIndirectRasterEvidence();
    expect(evidence.pixel).toEqual([64, 128, 191, 255]);
    expect(evidence.passNames).toEqual([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
      'gpu-driven.lod-selection-readback',
      'gpu-driven.opaque-indirect',
      'gpu-driven.raster-readback',
    ]);
  });
});
