import { describe, expect, it } from 'vitest';
import { projectCpuDirectCandidates } from '../scene/render-scene';
import { primitiveKey, VisibilityFacetStore, viewKey } from '../scene/visibility/facet';

describe('CPU direct LOD lane', () => {
  it('emits exactly one selected candidate per view and primitive', () => {
    const store = new VisibilityFacetStore();
    const view = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 1,
      viewRole: 'main',
      viewGeneration: 1,
    });
    const primitive = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 2,
      primitiveSlot: 3,
      slotGeneration: 0,
    });
    store.activateView(view);
    store.setCandidate(view, primitive, { level: 2, confidence: 0.9 });

    expect(projectCpuDirectCandidates(store, [{ view, primitives: [primitive] }])).toEqual([
      { view, primitive, candidate: { level: 2, confidence: 0.9 } },
    ]);
  });

  it('keeps the direct candidate order stable when only selection changes', () => {
    const store = new VisibilityFacetStore();
    const view = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 1,
      viewRole: 'main',
      viewGeneration: 1,
    });
    const first = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 2,
      primitiveSlot: 1,
      slotGeneration: 0,
    });
    const second = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 2,
      primitiveSlot: 2,
      slotGeneration: 0,
    });
    store.activateView(view);
    store.setCandidate(view, first, { level: 1, confidence: 1 });
    store.setCandidate(view, second, { level: 0, confidence: 1 });

    const result = projectCpuDirectCandidates(store, [{ view, primitives: [first, second] }]);
    expect(result.map((entry) => entry.primitive.primitiveSlot)).toEqual([1, 2]);
  });
});
