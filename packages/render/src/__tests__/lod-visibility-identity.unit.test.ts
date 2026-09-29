import { describe, expect, it } from 'vitest';
import { createVisibilityBudget } from '../scene/visibility/budget';
import {
  type PrimitiveKey,
  primitiveKey,
  primitiveKeyId,
  type ViewKey,
  VisibilityFacetStore,
  viewKey,
} from '../scene/visibility/facet';

const primitive = (slot: number, generation = 0): PrimitiveKey =>
  primitiveKey({
    attachmentId: 'world-a',
    worldGeneration: 4,
    primitiveSlot: slot,
    slotGeneration: generation,
  });

const view = (
  cameraEntity: number,
  generation = 1,
  viewRole: ViewKey['viewRole'] = 'main',
): ViewKey =>
  viewKey({ attachmentId: 'world-a', cameraEntity, viewRole, viewGeneration: generation });

describe('LOD visibility facet identity', () => {
  it('keeps attachment, camera role, and generation in the view identity', () => {
    const store = new VisibilityFacetStore();
    const main = view(7, 3, 'main');
    const shadow = view(7, 3, 'shadow');

    store.activateView(main);
    store.activateView(shadow);
    store.setCandidate(main, primitive(2), { level: 1, confidence: 0.8 });
    store.setCandidate(shadow, primitive(2), { level: 0, confidence: 1 });

    expect(store.getCandidate(main, primitive(2))).toEqual({ level: 1, confidence: 0.8 });
    expect(store.getCandidate(shadow, primitive(2))).toEqual({ level: 0, confidence: 1 });
    expect(store.inspect().activeViews).toBe(2);
  });

  it('keeps primitive slot identity separate across ABA generations', () => {
    const store = new VisibilityFacetStore();
    const current = primitive(5, 2);
    const stale = primitive(5, 1);
    const main = view(9);
    store.activateView(main);
    store.setCandidate(main, current, { level: 2, confidence: 0.6 });

    expect(store.getCandidate(main, stale)).toBeUndefined();
    expect(store.getCandidate(main, current)).toEqual({ level: 2, confidence: 0.6 });
  });

  it('rejects completion from a retired view or an older view generation', () => {
    const store = new VisibilityFacetStore();
    const active = view(3, 4);
    const reused = view(3, 5);
    const p = primitive(1);
    store.activateView(active);
    store.retireView(active);

    expect(store.applyCompletion(active, p, 4, { level: 1, confidence: 0.5 })).toBe(false);
    store.activateView(reused);
    expect(store.applyCompletion(active, p, 5, { level: 0, confidence: 1 })).toBe(false);
    expect(store.getCandidate(reused, p)).toBeUndefined();
  });

  it('does not use array position as attachment identity when worlds reorder', () => {
    const store = new VisibilityFacetStore();
    const worldA = viewKey({
      attachmentId: 'world-a',
      cameraEntity: 1,
      viewRole: 'main',
      viewGeneration: 1,
    });
    const worldB = viewKey({
      attachmentId: 'world-b',
      cameraEntity: 1,
      viewRole: 'main',
      viewGeneration: 1,
    });
    const primitiveA = primitiveKey({
      attachmentId: 'world-a',
      worldGeneration: 2,
      primitiveSlot: 0,
      slotGeneration: 0,
    });
    const primitiveB = primitiveKey({
      attachmentId: 'world-b',
      worldGeneration: 9,
      primitiveSlot: 0,
      slotGeneration: 0,
    });
    store.activateView(worldA);
    store.activateView(worldB);
    store.setCandidate(worldA, primitiveA, { level: 1, confidence: 0.7 });
    store.setCandidate(worldB, primitiveB, { level: 2, confidence: 0.9 });

    expect(store.getCandidate(worldA, primitiveA)?.level).toBe(1);
    expect(store.getCandidate(worldB, primitiveB)?.level).toBe(2);
  });

  it('advances hidden evidence on successful frames and expires it without a query', () => {
    const budget = createVisibilityBudget();
    const store = new VisibilityFacetStore(budget);
    const main = view(11);
    const p = primitive(3);
    store.activateView(main);
    store.setCandidate(main, p, { level: 1, confidence: 0 });
    store.applyConfidence(main, p, { type: 'result', samples: 0, submissionGeneration: 1 });
    store.applyConfidence(main, p, { type: 'result', samples: 0, submissionGeneration: 2 });
    expect(store.getConfidence(main, p)).toMatchObject({ status: 'hidden', successfulSubmits: 0 });

    for (let generation = 3; generation <= 2 + budget.retestSubmits; generation += 1) {
      store.advanceSuccessfulSubmits(generation);
    }
    expect(store.getConfidence(main, p)).toMatchObject({
      status: 'hidden',
      successfulSubmits: budget.retestSubmits,
    });
    expect(store.shouldQuery(main, p)).toBe(true);

    store.advanceSuccessfulSubmits(2 + budget.expirySubmits);
    expect(store.getConfidence(main, p)).toMatchObject({
      status: 'visible',
      successfulSubmits: 0,
      dirty: true,
    });
  });

  it('dequeues bounded ready work and requeues only failed identities', () => {
    const store = new VisibilityFacetStore();
    const main = view(12);
    const first = primitive(1);
    const second = primitive(2);
    store.activateView(main);
    store.setCandidate(main, first, { level: 0, confidence: 1 });
    store.setCandidate(main, second, { level: 0, confidence: 1 });

    const page = store.dequeueQueryCandidates(main, 1);
    expect(page).toHaveLength(1);
    expect(page[0]?.primitive.primitiveSlot).toBe(1);
    expect(store.dequeueQueryCandidates(main, 1)[0]?.primitive.primitiveSlot).toBe(2);

    store.requeueQueryCandidate(main, first);
    expect(store.dequeueQueryCandidates(main, 1)[0]?.primitive.primitiveSlot).toBe(1);
    expect(store.dequeueQueryCandidates(main, 1)).toHaveLength(0);
  });

  it('keeps a first zero provisional so the production path submits the second query', () => {
    const store = new VisibilityFacetStore();
    const main = view(13);
    const p = primitive(4);
    store.activateView(main);
    store.setCandidate(main, p, { level: 0, confidence: 1 });
    expect(store.dequeueQueryCandidates(main, 1)).toHaveLength(1);
    store.applyConfidence(main, p, { type: 'submit', submissionGeneration: 1 });
    store.applyConfidence(main, p, { type: 'result', samples: 0, submissionGeneration: 1 });

    expect(store.getConfidence(main, p)).toMatchObject({
      status: 'visible',
      zeroStreak: 1,
      dirty: true,
    });
    expect(store.dequeueQueryCandidates(main, 1)).toHaveLength(1);
  });

  it('removes pruned queue identities without leaving stale work to scan', () => {
    const store = new VisibilityFacetStore();
    const main = view(14);
    const first = primitive(7);
    const second = primitive(8);
    store.activateView(main);
    store.setCandidate(main, first, { level: 0, confidence: 1 });
    store.setCandidate(main, second, { level: 0, confidence: 1 });
    store.pruneCandidates(main, new Set([primitiveKeyId(second)]));

    const page = store.dequeueQueryCandidates(main, 2);
    expect(page.map((entry) => entry.primitive.primitiveSlot)).toEqual([8]);
    expect(store.dequeueQueryCandidates(main, 2)).toHaveLength(0);
  });

  it('requeues an identity after hidden confidence is invalidated', () => {
    const store = new VisibilityFacetStore();
    const main = view(15);
    const p = primitive(9);
    store.activateView(main);
    store.setCandidate(main, p, { level: 0, confidence: 1 });
    expect(store.dequeueQueryCandidates(main, 1)).toHaveLength(1);
    store.applyConfidence(main, p, { type: 'result', samples: 0, submissionGeneration: 1 });
    store.applyConfidence(main, p, { type: 'result', samples: 0, submissionGeneration: 2 });
    expect(store.dequeueQueryCandidates(main, 1)).toHaveLength(0);

    store.applyConfidence(main, p, { type: 'invalidate', reason: 'teleport' });
    expect(store.dequeueQueryCandidates(main, 1)).toHaveLength(1);
  });
});
