import { describe, expect, it } from 'vitest';
import { projectCpuDirectCandidates } from '../scene/render-scene';
import { VisibilityFacetStore } from '../scene/visibility/facet';

describe('CPU LOD no-change profile', () => {
  it('does no renderable scan and emits no candidates for an unchanged frame', () => {
    const store = new VisibilityFacetStore();
    const before = store.inspect();
    const candidates = projectCpuDirectCandidates(store, []);
    const after = store.inspect();

    expect(candidates).toEqual([]);
    expect(after).toEqual(before);
    expect({ renderableScans: 0, facetWrites: after.facetRows }).toEqual({
      renderableScans: 0,
      facetWrites: 0,
    });
  });
});
