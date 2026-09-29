import { describe, expect, it } from 'vitest';
import {
  decideVisibility,
  type VisibilityDecisionInput,
} from '../scene/visibility/occlusion-confidence';

const visibleInput: VisibilityDecisionInput = {
  authorVisible: true,
  validBounds: true,
  frustumVisible: true,
  lodReady: true,
  occlusion: { status: 'visible', queryable: true },
};

describe('LOD and occlusion final decision', () => {
  it('evaluates author, bounds, frustum, LOD, then shared confidence', () => {
    expect(decideVisibility(visibleInput)).toMatchObject({ draw: true, stage: 'occlusion' });
    expect(decideVisibility({ ...visibleInput, authorVisible: false })).toMatchObject({
      draw: false,
      stage: 'author',
    });
    expect(decideVisibility({ ...visibleInput, validBounds: false })).toMatchObject({
      draw: true,
      stage: 'bounds',
    });
    expect(decideVisibility({ ...visibleInput, frustumVisible: false })).toMatchObject({
      draw: false,
      stage: 'frustum',
    });
    expect(decideVisibility({ ...visibleInput, lodReady: false })).toMatchObject({
      draw: true,
      stage: 'lod',
    });
    expect(
      decideVisibility({ ...visibleInput, occlusion: { status: 'hidden', queryable: true } }),
    ).toMatchObject({ draw: false, stage: 'occlusion' });
    expect(
      decideVisibility({ ...visibleInput, occlusion: { status: 'hidden', queryable: false } }),
    ).toMatchObject({ draw: true, stage: 'occlusion' });
  });

  it('returns the same decision shape for CPU and GPU lanes', () => {
    const cpu = decideVisibility({ ...visibleInput, lane: 'cpu' });
    const gpu = decideVisibility({ ...visibleInput, lane: 'gpu' });
    expect(gpu).toEqual(cpu);
  });
});
