import { describe, expect, it } from 'vitest';
import { runStorageIndirectGraph } from './render-graph-storage-indirect-gpu';

describe('RenderGraph storage texture and indirect dispatch on Dawn', () => {
  it('executes storage-write -> copy-readback through one command encoder', async () => {
    const evidence = await runStorageIndirectGraph();
    expect(evidence.caps).toEqual({
      compute: true,
      storageTexture: true,
      indirectDrawing: true,
    });
    expect(evidence.graph.passes).toMatchObject([
      {
        name: 'storage-write',
        kind: 'compute',
        accesses: [
          { resource: 'storage-output', usage: 'storage-write' },
          { resource: 'dispatch-args', usage: 'indirect-read' },
        ],
      },
      { name: 'readback', kind: 'copy', dependencies: ['storage-write'] },
    ]);
    expect(evidence.pixel[0]).toBeCloseTo(64, 0);
    expect(evidence.pixel[1]).toBeCloseTo(128, 0);
    expect(evidence.pixel[2]).toBeCloseTo(191, 0);
    expect(evidence.pixel[3]).toBe(255);
  });
});
