import { describe, expect, it } from 'vitest';
import { createVisibilityBudget } from '../scene/visibility/budget';
import {
  primitiveKey,
  primitiveKeyId,
  VisibilityFacetStore,
  viewKey,
  viewKeyId,
} from '../scene/visibility/facet';

const view = (cameraEntity: number) =>
  viewKey({
    attachmentId: 'budget-scene',
    cameraEntity,
    viewRole: 'main',
    viewGeneration: 1,
  });

const primitive = (slot: number) =>
  primitiveKey({
    attachmentId: 'budget-scene',
    worldGeneration: 1,
    primitiveSlot: slot,
    slotGeneration: 1,
  });

describe('visibility budget integration', () => {
  it('shares one derived window across views and LOD levels', () => {
    const budget = createVisibilityBudget(2048);
    const facets = new VisibilityFacetStore(budget);
    const views = [view(1), view(2)];
    for (const currentView of views) {
      facets.activateView(currentView);
      for (let level = 0; level < 8; level += 1) {
        const currentPrimitive = primitive(currentView.cameraEntity * 10 + level);
        facets.setCandidate(currentView, currentPrimitive, { level, confidence: 1 });
        facets.applyConfidence(currentView, currentPrimitive, {
          type: 'result',
          samples: 0,
          submissionGeneration: 1,
        });
        facets.applyConfidence(currentView, currentPrimitive, {
          type: 'result',
          samples: 0,
          submissionGeneration: 2,
        });
      }
    }

    expect(facets.visibilityBudget()).toBe(budget);
    expect(facets.visibilityBudget()).toMatchObject({
      effectiveQueryBudget: 2048,
      settleSubmits: 98,
      retestSubmits: 44,
      expirySubmits: 88,
    });

    facets.advanceSuccessfulSubmits(2 + budget.retestSubmits);
    for (const currentView of views) {
      expect(facets.shouldQuery(currentView, primitive(currentView.cameraEntity * 10))).toBe(true);
    }
  });

  it('keeps invalidation visible and requeues the same identity without extending evidence', () => {
    const budget = createVisibilityBudget(4096);
    const facets = new VisibilityFacetStore(budget);
    const currentView = view(3);
    const currentPrimitive = primitive(3);
    facets.activateView(currentView);
    facets.setCandidate(currentView, currentPrimitive, { level: 2, confidence: 1 });
    facets.applyConfidence(currentView, currentPrimitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 1,
    });
    facets.applyConfidence(currentView, currentPrimitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 2,
    });
    facets.advanceSuccessfulSubmits(2 + budget.retestSubmits, [
      { view: currentView, primitive: currentPrimitive },
    ]);
    expect(facets.getConfidence(currentView, currentPrimitive).status).toBe('hidden');

    facets.applyConfidence(currentView, currentPrimitive, {
      type: 'invalidate',
      reason: 'world-reorder',
    });
    expect(facets.getConfidence(currentView, currentPrimitive)).toMatchObject({
      status: 'visible',
      dirty: true,
      queryable: true,
    });
    expect(facets.dequeueQueryCandidates(currentView, 1)).toHaveLength(1);
  });

  it('uses expiry-only scheduling for a due hidden row while its query is in flight', () => {
    const budget = createVisibilityBudget();
    const facets = new VisibilityFacetStore(budget);
    const currentView = view(4);
    const currentPrimitive = primitive(4);
    facets.activateView(currentView);
    facets.setCandidate(currentView, currentPrimitive, { level: 0, confidence: 1 });
    facets.applyConfidence(currentView, currentPrimitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 1,
    });
    facets.applyConfidence(currentView, currentPrimitive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 2,
    });
    const dueGeneration = 2 + budget.retestSubmits;
    facets.advanceSuccessfulSubmits(dueGeneration);
    expect(facets.dequeueQueryCandidates(currentView, 1)).toHaveLength(1);

    facets.applyConfidence(currentView, currentPrimitive, {
      type: 'submit',
      submissionGeneration: dueGeneration,
    });
    expect(facets.getConfidence(currentView, currentPrimitive).successfulSubmits).toBe(
      budget.retestSubmits + 1,
    );
    const scheduler = facets as unknown as {
      confidence: { wakeByGeneration: Map<number, Set<string>> };
    };
    const key = `${viewKeyId(currentView)}|${primitiveKeyId(currentPrimitive)}`;
    expect([...scheduler.confidence.wakeByGeneration.values()].flat()).not.toContain(key);

    facets.advanceSuccessfulSubmits(
      dueGeneration + budget.expirySubmits - budget.retestSubmits - 1,
    );
    expect(facets.getConfidence(currentView, currentPrimitive)).toMatchObject({
      status: 'visible',
      dirty: true,
    });
  });
});
