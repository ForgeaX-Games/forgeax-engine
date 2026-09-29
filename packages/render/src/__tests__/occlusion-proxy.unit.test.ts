import { describe, expect, it } from 'vitest';
import { buildWorldOcclusionProxyVertices } from '../occlusion-proxy';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';

describe('instance occlusion proxy', () => {
  it('covers the world-space union of distant instances', () => {
    const vertices = buildWorldOcclusionProxyVertices(
      { min: [-61, -1, -12], max: [61, 1, -10] },
      makeZeroCameraFallbackSnapshot(),
    );
    const projectedX = Array.from({ length: vertices.length / 4 }, (_, index) => {
      const offset = index * 4;
      return (vertices[offset] ?? 0) / (vertices[offset + 3] ?? 1);
    });
    expect(Math.min(...projectedX)).toBeLessThan(-1);
    expect(Math.max(...projectedX)).toBeGreaterThan(1);
  });
});
