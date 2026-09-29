import { describe, expect, it } from 'vitest';
import { primitiveKey, VisibilityFacetStore, viewKey } from '../scene/visibility/facet';

describe('LOD visibility facet lifecycle', () => {
  it('retires all facet rows for a detached attachment', () => {
    const store = new VisibilityFacetStore();
    const view = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 4,
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
    store.setCandidate(view, primitive, { level: 0, confidence: 1 });

    store.detachAttachment('world-a');

    expect(store.getCandidate(view, primitive)).toBeUndefined();
    expect(store.inspect()).toMatchObject({ activeViews: 0, facetRows: 0 });
  });

  it('preserves active rows when unrelated worlds reorder', () => {
    const store = new VisibilityFacetStore();
    const first = viewKey({
      attachmentId: 'world-first',
      cameraEntity: 1,
      viewRole: 'main',
      viewGeneration: 2,
    });
    const second = viewKey({
      attachmentId: 'world-second',
      cameraEntity: 2,
      viewRole: 'probe',
      viewGeneration: 5,
    });
    const firstPrimitive = primitiveKey({
      attachmentId: 'world-first',
      worldGeneration: 3,
      primitiveSlot: 0,
      slotGeneration: 1,
    });
    const secondPrimitive = primitiveKey({
      attachmentId: 'world-second',
      worldGeneration: 7,
      primitiveSlot: 1,
      slotGeneration: 4,
    });
    store.activateView(first);
    store.activateView(second);
    store.setCandidate(first, firstPrimitive, { level: 1, confidence: 0.8 });
    store.setCandidate(second, secondPrimitive, { level: 2, confidence: 0.4 });

    store.reorderAttachments(['world-second', 'world-first']);

    expect(store.getCandidate(first, firstPrimitive)).toEqual({ level: 1, confidence: 0.8 });
    expect(store.getCandidate(second, secondPrimitive)).toEqual({ level: 2, confidence: 0.4 });
  });

  it('rejects stale completion after a view epoch advances', () => {
    const store = new VisibilityFacetStore();
    const view = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 8,
      viewRole: 'reflection',
      viewGeneration: 3,
    });
    const primitive = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 1,
      primitiveSlot: 8,
      slotGeneration: 0,
    });
    store.activateView(view);
    const epoch = store.beginViewEpoch(view);
    store.beginViewEpoch(view);

    expect(store.applyCompletion(view, primitive, epoch, { level: 2, confidence: 0.3 })).toBe(
      false,
    );
    expect(store.getCandidate(view, primitive)).toBeUndefined();
  });

  it('does not invalidate draw admission for an identical completion', () => {
    const store = new VisibilityFacetStore();
    const view = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 9,
      viewRole: 'main',
      viewGeneration: 1,
    });
    const primitive = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 1,
      primitiveSlot: 9,
      slotGeneration: 0,
    });
    store.activateView(view);
    const epoch = store.beginViewEpoch(view);
    store.setCandidate(view, primitive, { level: 0, confidence: 1 });
    const before = {
      visibility: store.revision,
      draw: store.drawRevisionValue,
    };

    expect(store.applyCompletion(view, primitive, epoch, { level: 0, confidence: 1 })).toBe(true);
    expect(store.revision).toBe(before.visibility);
    expect(store.drawRevisionValue).toBe(before.draw);

    expect(store.applyCompletion(view, primitive, epoch, { level: 1, confidence: 0.5 })).toBe(true);
    expect(store.revision).toBe(before.visibility + 1);
    expect(store.drawRevisionValue).toBe(before.draw + 1);
  });

  it('exposes one facet owner without lane-specific visibility maps', () => {
    const store = new VisibilityFacetStore();
    const inspection = store.inspect();

    expect(inspection).toMatchObject({
      owner: 'persistent-render-scene',
      activeViews: 0,
      facetRows: 0,
    });
    expect(Object.keys(inspection)).not.toContain('cameraUnion');
    expect(Object.keys(inspection)).not.toContain('laneVisibility');
  });
});
