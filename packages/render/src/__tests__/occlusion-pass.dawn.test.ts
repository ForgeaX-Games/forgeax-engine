import { describe, expect, it } from 'vitest';
import { buildOcclusionPassPlan } from '../scene/visibility/occlusion-pass';

describe('occlusion pass Dawn contract', () => {
  it('keeps resolve, copy, and async map in one shared submission plan', () => {
    const plan = buildOcclusionPassPlan({
      opaquePass: 'opaque',
      depthResource: 'depth',
      colorResource: 'color',
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      queryIndex: 0,
    });
    expect(plan).toMatchObject({
      resolve: { queryIndex: 0 },
      copy: { asynchronous: true },
      submitCount: 1,
      mapSameFrame: false,
    });
  });
});
