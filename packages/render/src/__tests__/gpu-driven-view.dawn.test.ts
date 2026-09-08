import { describe, expect, it } from 'vitest';
import {
  runGpuDrivenViewGpuEvidence,
  runGpuDrivenViewLifecycleEvidence,
} from './gpu-driven-view-gpu-evidence';

describe('GPU-driven View Dawn', () => {
  it('produces compact visible IDs and portable indirect args on the real GPU API', async () => {
    await expect(runGpuDrivenViewGpuEvidence()).resolves.toEqual({
      visibleInstance: 0,
      indexCount: 36,
      instanceCount: 1,
      firstIndex: 3,
      baseVertex: -2,
      firstInstance: 0,
      overflow: 0,
      persistentTranslationX: 0,
    });
  });

  it('survives 300 frames of spawn/despawn capacity crossings without stale buffers', async () => {
    await expect(runGpuDrivenViewLifecycleEvidence()).resolves.toEqual({
      frames: 300,
      bufferRebuilds: 4,
      candidateCapacity: 8,
    });
  }, 30_000);
});
