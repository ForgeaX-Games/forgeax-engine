// shadow-csm-atlas.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M3 / w13: atlas RT size derivation unit test.
//
// Covers AC-05 (atlas tile layout): tilesPerSide = ceil(sqrt(cascadeCount)),
// atlasSize = tilesPerSide * mapSize. Verifies viewport coordinates for each
// cascade tile: col = i % tilesPerSide, row = floor(i / tilesPerSide).

import { describe, expect, it } from 'vitest';

/**
 * Pure helper mirroring urp-pipeline.ts atlas sizing logic.
 * Extracted so unit tests can verify the formula without a GPU device.
 */
function computeAtlasLayout(
  cascadeCount: number,
  mapSize: number,
): {
  tilesPerSide: number;
  atlasSize: number;
  tileViewports: Array<{ x: number; y: number; w: number; h: number }>;
} {
  const tilesPerSide = Math.ceil(Math.sqrt(cascadeCount));
  const atlasSize = tilesPerSide * mapSize;
  const tileViewports: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let i = 0; i < cascadeCount; i++) {
    const col = i % tilesPerSide;
    const row = Math.floor(i / tilesPerSide);
    tileViewports.push({
      x: col * mapSize,
      y: row * mapSize,
      w: mapSize,
      h: mapSize,
    });
  }
  return { tilesPerSide, atlasSize, tileViewports };
}

describe('CSM atlas layout (w13)', () => {
  const MAP_SIZE = 2048;

  describe('N=1: single cascade', () => {
    it('tilesPerSide=1, atlasSize=mapSize', () => {
      const layout = computeAtlasLayout(1, MAP_SIZE);
      expect(layout.tilesPerSide).toBe(1);
      expect(layout.atlasSize).toBe(MAP_SIZE);
    });

    it('single tile viewport at (0, 0)', () => {
      const layout = computeAtlasLayout(1, MAP_SIZE);
      expect(layout.tileViewports).toHaveLength(1);
      expect(layout.tileViewports[0]).toEqual({
        x: 0,
        y: 0,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
    });
  });

  describe('N=2: horizontal strip', () => {
    it('tilesPerSide=2, atlasSize=2*mapSize', () => {
      const layout = computeAtlasLayout(2, MAP_SIZE);
      expect(layout.tilesPerSide).toBe(2);
      expect(layout.atlasSize).toBe(2 * MAP_SIZE);
    });

    it('cascade 0 at (0, 0), cascade 1 at (mapSize, 0)', () => {
      const layout = computeAtlasLayout(2, MAP_SIZE);
      expect(layout.tileViewports).toHaveLength(2);
      expect(layout.tileViewports[0]).toEqual({
        x: 0,
        y: 0,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
      expect(layout.tileViewports[1]).toEqual({
        x: MAP_SIZE,
        y: 0,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
    });
  });

  describe('N=3: 2x2 grid, one tile empty (D-5)', () => {
    it('tilesPerSide=2, atlasSize=2*mapSize', () => {
      const layout = computeAtlasLayout(3, MAP_SIZE);
      expect(layout.tilesPerSide).toBe(2);
      expect(layout.atlasSize).toBe(2 * MAP_SIZE);
    });

    it('three tiles: (0,0), (mapSize,0), (0,mapSize) — bottom-right unused', () => {
      const layout = computeAtlasLayout(3, MAP_SIZE);
      expect(layout.tileViewports).toHaveLength(3);
      expect(layout.tileViewports[0]).toEqual({
        x: 0,
        y: 0,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
      expect(layout.tileViewports[1]).toEqual({
        x: MAP_SIZE,
        y: 0,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
      expect(layout.tileViewports[2]).toEqual({
        x: 0,
        y: MAP_SIZE,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
    });
  });

  describe('N=4: full 2x2 grid', () => {
    it('tilesPerSide=2, atlasSize=2*mapSize', () => {
      const layout = computeAtlasLayout(4, MAP_SIZE);
      expect(layout.tilesPerSide).toBe(2);
      expect(layout.atlasSize).toBe(2 * MAP_SIZE);
    });

    it('four tiles at all four quadrants of the atlas', () => {
      const layout = computeAtlasLayout(4, MAP_SIZE);
      expect(layout.tileViewports).toHaveLength(4);
      // col=0,row=0
      expect(layout.tileViewports[0]).toEqual({
        x: 0,
        y: 0,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
      // col=1,row=0
      expect(layout.tileViewports[1]).toEqual({
        x: MAP_SIZE,
        y: 0,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
      // col=0,row=1
      expect(layout.tileViewports[2]).toEqual({
        x: 0,
        y: MAP_SIZE,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
      // col=1,row=1
      expect(layout.tileViewports[3]).toEqual({
        x: MAP_SIZE,
        y: MAP_SIZE,
        w: MAP_SIZE,
        h: MAP_SIZE,
      });
    });
  });

  describe('viewport size invariant', () => {
    it('every tile viewport is mapSize x mapSize (never atlasSize)', () => {
      for (const n of [1, 2, 3, 4]) {
        const layout = computeAtlasLayout(n, MAP_SIZE);
        for (const vp of layout.tileViewports) {
          expect(vp.w).toBe(MAP_SIZE);
          expect(vp.h).toBe(MAP_SIZE);
        }
      }
    });

    it('atlasSize grows with tilesPerSide, viewports stay mapSize', () => {
      const n1 = computeAtlasLayout(1, MAP_SIZE);
      const n4 = computeAtlasLayout(4, MAP_SIZE);
      expect(n1.atlasSize).toBe(MAP_SIZE);
      expect(n4.atlasSize).toBe(2 * MAP_SIZE);
      // Both have same per-tile viewport dimensions.
      expect(n1.tileViewports[0]?.w).toBe(MAP_SIZE);
      expect(n4.tileViewports[0]?.w).toBe(MAP_SIZE);
    });
  });
});
