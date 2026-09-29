import { describe, expect, it } from 'vitest';
import { projectCpuDirectCandidates } from '../scene/render-scene';
import { primitiveKey, VisibilityFacetStore, viewKey } from '../scene/visibility/facet';

describe('multi-view CPU LOD projection', () => {
  it('keeps main, shadow, reflection, and probe decisions independent', () => {
    const store = new VisibilityFacetStore();
    const primitive = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 1,
      primitiveSlot: 4,
      slotGeneration: 2,
    });
    const views = (['main', 'shadow', 'reflection', 'probe'] as const).map((viewRole, index) =>
      viewKey({ attachmentId: 'world-a', cameraEntity: 5, viewRole, viewGeneration: index + 1 }),
    );
    for (const [index, view] of views.entries()) {
      store.activateView(view);
      store.setCandidate(view, primitive, { level: index, confidence: 1 - index * 0.1 });
    }

    const projected = projectCpuDirectCandidates(
      store,
      views.map((view) => ({ view, primitives: [primitive] })),
    );

    expect(projected.map((entry) => entry.candidate.level)).toEqual([0, 1, 2, 3]);
    expect(projected).toHaveLength(4);
  });

  it('does not duplicate a primitive when views are projected together', () => {
    const store = new VisibilityFacetStore();
    const main = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 1,
      viewRole: 'main',
      viewGeneration: 1,
    });
    const shadow = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 2,
      viewRole: 'shadow',
      viewGeneration: 1,
    });
    const primitive = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 1,
      primitiveSlot: 0,
      slotGeneration: 0,
    });
    store.activateView(main);
    store.activateView(shadow);
    store.setCandidate(main, primitive, { level: 0, confidence: 1 });
    store.setCandidate(shadow, primitive, { level: 1, confidence: 1 });

    const projected = projectCpuDirectCandidates(store, [
      { view: main, primitives: [primitive] },
      { view: shadow, primitives: [primitive] },
    ]);
    expect(projected.filter((entry) => entry.view.viewRole === 'main')).toHaveLength(1);
    expect(projected.filter((entry) => entry.view.viewRole === 'shadow')).toHaveLength(1);
  });
});
