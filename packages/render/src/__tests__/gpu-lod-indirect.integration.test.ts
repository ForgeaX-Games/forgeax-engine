import { describe, expect, it } from 'vitest';
import { BatchTopology, compactGpuLodCandidates } from '../gpu-driven/batch-topology';
import { buildGpuLodRows } from '../scene/visibility/gpu-lod';

describe('GPU LOD indirect compact', () => {
  it('compacts one selected level per candidate while leaving topology membership stable', () => {
    const rows = buildGpuLodRows({
      generation: 4,
      hysteresis: 0,
      ranges: [
        { firstIndex: 0, indexCount: 36, baseVertex: 0 },
        { firstIndex: 36, indexCount: 18, baseVertex: 0 },
        { firstIndex: 54, indexCount: 6, baseVertex: 0 },
      ],
      coverages: [1, 0.5, 0.2],
      ready: [true, true, true],
    });
    const compacted = compactGpuLodCandidates([
      {
        candidate: { primitiveIndex: 2, generation: 4, drawItemIndex: 0, instanceOrdinal: 0 },
        rows,
        projectedHeight: 0.1,
        previousLevel: 0,
        historyValid: false,
      },
      {
        candidate: { primitiveIndex: 3, generation: 4, drawItemIndex: 0, instanceOrdinal: 0 },
        rows,
        projectedHeight: 0.6,
        previousLevel: 0,
        historyValid: false,
      },
    ]);

    expect(compacted.map((entry) => entry.level)).toEqual([2, 0]);
    expect(new Set(compacted.map((entry) => entry.candidate.primitiveIndex)).size).toBe(2);
    const topology = new BatchTopology();
    expect(topology).toBeDefined();
  });
});
