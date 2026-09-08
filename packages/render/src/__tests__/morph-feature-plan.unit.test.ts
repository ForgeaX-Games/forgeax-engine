import { describe, expect, it } from 'vitest';
import { createBuiltinMorphFeature } from '../features/morph/morph-feature';
import { freezeRenderFeaturePlan } from '../features/plan';

describe('morph RenderFeature plan', () => {
  it('declares compute descriptors and a vertex-consumable output', () => {
    const feature = createBuiltinMorphFeature({
      collect: () => [
        {
          identity: 'face',
          vertexCount: 3,
          baseBounds: { min: [-1, -1, -1], max: [1, 1, 1] },
          targetBounds: [{ min: [0, 0, 0], max: [1, 1, 1] }],
          weights: [0.5],
          baseAabbIntersectsFrustum: true,
          basePositions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          targetDeltas: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        },
      ],
    });
    const extracted = feature.extract({ worlds: [], owner: 0, frameNumber: 1 });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const planned = feature.plan(extracted.value, {
      caps: {} as never,
      frame: { frameNumber: 1 },
      generation: 1,
      targets: [],
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(freezeRenderFeaturePlan(feature.identity, planned.value).ok).toBe(true);
    expect(planned.value.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'compute-program' }),
        expect.objectContaining({
          kind: 'buffer',
          name: 'morph.draw-0.output',
          usage: ['storage', 'vertex', 'copy-src'],
        }),
        expect.objectContaining({ kind: 'compute-bindings' }),
        expect.objectContaining({ kind: 'vertex-data', buffer: 'morph.draw-0.output' }),
      ]),
    );
    expect(planned.value.passes).toEqual([
      expect.objectContaining({
        kind: 'compute',
        dispatches: [expect.objectContaining({ entryPoint: 'morph_main' })],
      }),
    ]);
  });
});
