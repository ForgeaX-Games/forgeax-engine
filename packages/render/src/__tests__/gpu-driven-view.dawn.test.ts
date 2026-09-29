import { describe, expect, it } from 'vitest';
import {
  runGpuDrivenViewGpuEvidence,
  runGpuDrivenViewLifecycleEvidence,
  runGpuDrivenViewOcclusionEvidence,
} from './gpu-driven-view-gpu-evidence';

describe('GPU-driven View Dawn', () => {
  it('produces compact visible IDs and portable indirect args on the real GPU API', async () => {
    await expect(runGpuDrivenViewGpuEvidence()).resolves.toEqual({
      visibleInstance: 0,
      indexCount: 12,
      instanceCount: 1,
      firstIndex: 9,
      baseVertex: 4,
      firstInstance: 0,
      overflow: 0,
      persistentTranslationX: 0,
      firstReadbackFrame: 10,
      recoveredReadbackFrame: 11,
      firstVisible: 1,
      recoveredVisible: 0,
    });
  });

  it('survives 60 frames of spawn/despawn capacity crossings without stale buffers', async () => {
    await expect(runGpuDrivenViewLifecycleEvidence()).resolves.toEqual({
      frames: 60,
      bufferRebuilds: 4,
      candidateCapacity: 8,
    });
  }, 30_000);

  it('culls only fully hidden instances through the two-phase HZB test', async () => {
    const frames = await runGpuDrivenViewOcclusionEvidence();
    expect(frames.map(({ visible, culled, late }) => ({ visible, culled, late }))).toEqual([
      // No history: the early phase draws everything; the late test records the hidden cube.
      { visible: 3, culled: 1, late: 0 },
      // Two-phase: the hidden cube skips the early phase and stays culled.
      { visible: 2, culled: 1, late: 0 },
      // The wall is gone: the hidden cube returns only through the late phase.
      { visible: 3, culled: 0, late: 1 },
    ]);
  });

  it('keeps HZB visibility history across a view buffer rebuild', async () => {
    const frames = await runGpuDrivenViewOcclusionEvidence({ grow: true });
    expect(frames[2]?.bufferRebuilds).toBeGreaterThan(frames[1]?.bufferRebuilds ?? Infinity);
    // Five cubes join beside the wall with no history and draw through the late
    // phase; the hidden cube keeps its culled history instead of drawing early
    // because the rebuilt counters lost it.
    expect(frames[2]).toMatchObject({ visible: 7, culled: 1, late: 5 });
  });

  it('FALSIFY: a shrunken HZB footprint culls the partially visible instance', async () => {
    const frames = await runGpuDrivenViewOcclusionEvidence({ occlusionFootprintScale: 0.3 });
    expect(frames[1]).toMatchObject({ visible: 1, culled: 2, late: 0 });
  });
});
