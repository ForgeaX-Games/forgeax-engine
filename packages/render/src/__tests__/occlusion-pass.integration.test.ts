import { describe, expect, it } from 'vitest';
import { buildOcclusionPassPlan } from '../scene/visibility/occlusion-pass';

const bounds = { min: [-1, -1, -1] as const, max: [1, 1, 1] as const };

describe('typed occlusion bounds pass', () => {
  it('is ordered after opaque and only reads depth through a conservative proxy', () => {
    expect(
      buildOcclusionPassPlan({
        opaquePass: 'opaque-main',
        depthResource: 'depth-main',
        colorResource: 'color-main',
        bounds,
        queryIndex: 3,
      }),
    ).toMatchObject({
      after: 'opaque-main',
      queryIndex: 3,
      depth: { resource: 'depth-main', usage: 'depth-read-only' },
      writesColor: false,
      writesDepth: false,
      submitCount: 1,
    });
  });

  it.each([
    { transparent: true },
    { deformed: true },
    { bounds: undefined },
  ])('keeps non-queryable candidates visible: %o', (input) => {
    expect(
      buildOcclusionPassPlan({
        opaquePass: 'opaque-main',
        depthResource: 'depth-main',
        colorResource: 'color-main',
        bounds: input.bounds === undefined ? undefined : bounds,
        queryIndex: 0,
        ...(input.transparent === undefined ? {} : { transparent: input.transparent }),
        ...(input.deformed === undefined ? {} : { deformed: input.deformed }),
      }),
    ).toBeUndefined();
  });
});
