import { describe, expect, it } from 'vitest';

describe('package-private World internal seam', () => {
  it('shares the World key across split bundled entry points', async () => {
    const indexPath = '../../dist/index.mjs';
    const projectionPath = '../../dist/projection/index.mjs';
    const [{ World }, { createWorldProjection }] = await Promise.all([
      import(indexPath),
      import(projectionPath),
    ]);

    const world = new World();
    const projection = createWorldProjection(world);

    expect(projection.poll()).toEqual({ status: 'delta', cursor: 0, changes: [] });
  });
});
