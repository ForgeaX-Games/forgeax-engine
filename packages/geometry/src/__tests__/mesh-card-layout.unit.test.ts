import { describe, expect, it } from 'vitest';
import { buildMeshCardLayout } from '../mesh-card-layout';

const positions = [
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
];
const indices = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6,
  1, 6, 5,
];

describe('offline card layout', () => {
  it('keeps mixed triangle sidedness local when fitting one mesh representation', async () => {
    // The left sheet is one-sided; only the right sheet may produce a back card.
    const p = [-3, -1, 0, -1, -1, 0, -3, 1, 0, -1, 1, 0, 1, -1, 0, 3, -1, 0, 1, 1, 0, 3, 1, 0];
    const ix = [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6];
    const layout = (
      await buildMeshCardLayout(p, ix, {
        resolution: 24,
        triangleSidedness: [0, 0, 1, 1],
      })
    ).unwrap();
    const back = layout.cards.filter((c) => c.n[2] === -1);
    expect(back).toHaveLength(1);
    expect(back[0]?.origin[0]).toBeGreaterThanOrEqual(1);
    expect(back[0]?.width).toBeLessThanOrEqual(2);
    const changed = (
      await buildMeshCardLayout(p, ix, {
        resolution: 24,
        triangleSidedness: [1, 1, 0, 0],
      })
    ).unwrap();
    expect(changed.meshDigest).toBe(layout.meshDigest);
    expect(changed.sidednessDigest).not.toBe(layout.sidednessDigest);
    expect(changed.cards.find((c) => c.n[2] === -1)?.origin[0]).toBeLessThan(0);
    for (const triangleSidedness of [[0], [0, 0, 1, 2], [0, 0, 1, NaN]])
      expect((await buildMeshCardLayout(p, ix, { triangleSidedness })).ok).toBe(false);
  });
  it('finds interior room cards when no outer projection has an admissible front face', async () => {
    const room = (
      await buildMeshCardLayout(positions, [...indices].reverse(), { resolution: 16 })
    ).unwrap();
    expect(room.cards).toHaveLength(6);
    expect(room.sampling.representedWeight).toBe(room.sampling.weightedCoverage);
  });
  it('fits all six box sides independently of any SDF or material capture', async () => {
    const result = (await buildMeshCardLayout(positions, indices, { resolution: 8 })).unwrap();
    expect(result.cards).toHaveLength(6);
    expect(result.sampling.representedWeight).toBe(result.sampling.weightedCoverage);
    expect(new Set(result.cards.map((c) => c.n.join(','))).size).toBe(6);
    for (const card of result.cards) {
      expect(card.width).toBe(2);
      expect(card.height).toBe(2);
      expect(card.depth).toBeGreaterThan(0);
      const near = card.origin.reduce((sum, x, i) => sum + x * (card.n[i] ?? NaN), 0);
      expect(near).toBeGreaterThan(1);
      expect(near - card.depth).toBeLessThan(1);
    }
    expect(await buildMeshCardLayout(positions, indices, { resolution: 8 })).toEqual(
      await buildMeshCardLayout(positions, indices, { resolution: 8 }),
    );
  });

  it('fits multiple depth layers and reports actual loss under a smaller global budget', async () => {
    const p: number[] = [],
      ix: number[] = [];
    // Three disconnected outward boxes need separate front/back depth planes.
    for (const center of [-4, 0, 4]) {
      const offset = p.length / 3;
      p.push(...positions.map((v, i) => v + (i % 3 === 2 ? center : 0)));
      ix.push(...indices.map((v) => v + offset));
    }
    const layout = (await buildMeshCardLayout(p, ix, { resolution: 24, maxCards: 24 })).unwrap();
    expect(layout.cards.filter((c) => c.n[2] === 1).length).toBe(3);
    expect(layout.cards.filter((c) => c.n[2] === -1).length).toBe(3);
    expect(layout.cards.length).toBeGreaterThan(6);
    const reduced = (await buildMeshCardLayout(p, ix, { resolution: 24, maxCards: 6 })).unwrap();
    expect(reduced.cards).toHaveLength(6);
    expect(reduced.sampling.weightedCoverage).toBe(layout.sampling.weightedCoverage);
    expect(reduced.sampling.representedWeight).toBeLessThan(layout.sampling.representedWeight);
    expect(reduced.cards).toEqual(layout.cards.slice(0, 6));
  });

  it('captures the two sides of an open thin sheet and rejects malformed source', async () => {
    const p = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
      ix = [0, 1, 2, 1, 3, 2];
    const one = (await buildMeshCardLayout(p, ix)).unwrap();
    const two = (
      await buildMeshCardLayout(p, ix, { triangleSidedness: new Uint8Array(ix.length / 3).fill(1) })
    ).unwrap();
    expect(one.cards).toHaveLength(1);
    expect(two.cards).toHaveLength(2);
    expect(two.cards.map((c) => c.n[2]).sort()).toEqual([-1, 1]);
    for (const settings of [{ resolution: 0 }, { maxCards: 65 }, { resolution: NaN }])
      expect((await buildMeshCardLayout(p, ix, settings)).ok).toBe(false);
    expect((await buildMeshCardLayout([NaN, ...p.slice(1)], ix)).ok).toBe(false);
    expect((await buildMeshCardLayout(p, [99, 1, 2])).ok).toBe(false);
    expect((await buildMeshCardLayout(p, [0, 0, 0])).ok).toBe(false);
  });
});
