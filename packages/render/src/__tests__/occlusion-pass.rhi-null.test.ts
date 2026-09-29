import { describe, expect, it } from 'vitest';
import { buildOcclusionPassPlan } from '../scene/visibility/occlusion-pass';

describe('occlusion pass RhiNull structural contract', () => {
  it('does not create color/depth writes and keeps query index separate from identity', () => {
    const plan = buildOcclusionPassPlan({
      opaquePass: 'opaque',
      depthResource: 'depth',
      colorResource: 'color',
      bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      queryIndex: 17,
      identity: { primitiveSlot: 4, slotGeneration: 9 },
    });
    expect(plan).toMatchObject({
      queryIndex: 17,
      identity: { primitiveSlot: 4, slotGeneration: 9 },
      writesColor: false,
      writesDepth: false,
    });
    expect(plan?.depth.usage).toBe('depth-read-only');
  });
});
