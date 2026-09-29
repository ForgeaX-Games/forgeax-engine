import { describe, expect, it } from 'vitest';
import { createVisibilityBudget } from '../scene/visibility/budget';
import {
  applyConfidenceEvent,
  createConfidenceState,
  OcclusionConfidenceScheduler,
  shouldIssueRetest,
} from '../scene/visibility/occlusion-confidence';

describe('occlusion confidence FSM', () => {
  it('shows positive results immediately and suppresses only after two zeros', () => {
    const initial = createConfidenceState();
    const positive = applyConfidenceEvent(initial, {
      type: 'result',
      samples: 4,
      submissionGeneration: 1,
    });
    expect(positive.status).toBe('visible');
    const firstZero = applyConfidenceEvent(positive, {
      type: 'result',
      samples: 0,
      submissionGeneration: 2,
    });
    expect(firstZero.status).toBe('visible');
    const secondZero = applyConfidenceEvent(firstZero, {
      type: 'result',
      samples: 0,
      submissionGeneration: 3,
    });
    expect(secondZero.status).toBe('hidden');
  });

  it('retests within six successful submits and expires to visible by eight', () => {
    const budget = createVisibilityBudget();
    let state = applyConfidenceEvent(createConfidenceState(), {
      type: 'result',
      samples: 0,
      submissionGeneration: 1,
    });
    state = applyConfidenceEvent(state, {
      type: 'result',
      samples: 0,
      submissionGeneration: 2,
    });
    expect(state.status).toBe('hidden');
    for (let generation = 3; generation <= 2 + budget.retestSubmits; generation += 1) {
      state = applyConfidenceEvent(
        state,
        { type: 'submit', submissionGeneration: generation },
        budget,
      );
    }
    expect(shouldIssueRetest(state, budget)).toBe(true);
    expect(state.status).toBe('hidden');
    for (
      let generation = 3 + budget.retestSubmits;
      generation <= 2 + budget.expirySubmits;
      generation += 1
    ) {
      state = applyConfidenceEvent(
        state,
        { type: 'submit', submissionGeneration: generation },
        budget,
      );
    }
    expect(state.status).toBe('visible');
    expect(shouldIssueRetest(state, budget)).toBe(false);
  });

  it('keeps failures and invalidations visible and clears only the facet state', () => {
    const hidden = applyConfidenceEvent(
      applyConfidenceEvent(createConfidenceState(), {
        type: 'result',
        samples: 0,
        submissionGeneration: 1,
      }),
      { type: 'result', samples: 0, submissionGeneration: 2 },
    );
    const failed = applyConfidenceEvent(hidden, {
      type: 'failure',
      submissionGeneration: 3,
    });
    expect(failed).toMatchObject({ status: 'visible', queryable: true });
    const invalidated = applyConfidenceEvent(hidden, { type: 'invalidate', reason: 'teleport' });
    expect(invalidated).toMatchObject({ status: 'visible', zeroStreak: 0, queryable: true });
  });

  it('does not query transparent or detached facets', () => {
    expect(
      applyConfidenceEvent(createConfidenceState(), { type: 'invalidate', reason: 'transparent' }),
    ).toMatchObject({ queryable: false, status: 'visible' });
    expect(
      applyConfidenceEvent(createConfidenceState(), { type: 'invalidate', reason: 'detach' }),
    ).toMatchObject({ queryable: false, status: 'visible' });
  });

  it('consumes overdue wake/expiry buckets without scanning unrelated generations', () => {
    const budget = createVisibilityBudget();
    const scheduler = new OcclusionConfidenceScheduler(budget);
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 1 });
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 2 });
    scheduler.apply('other', { type: 'result', samples: 0, submissionGeneration: 99 });
    scheduler.apply('other', { type: 'result', samples: 0, submissionGeneration: 100 });

    scheduler.advanceSuccessfulSubmits(100);
    expect(scheduler.get('hidden')).toMatchObject({ status: 'visible', dirty: true });
    expect(scheduler.get('other')).toMatchObject({ status: 'hidden', successfulSubmits: 0 });
  });

  it('reschedules an excluded due wake without retaining its old expiry bucket', () => {
    const budget = createVisibilityBudget();
    const scheduler = new OcclusionConfidenceScheduler(budget);
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 1 });
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 2 });

    scheduler.advanceSuccessfulSubmits(2 + budget.retestSubmits, new Set(['hidden']));
    scheduler.advanceSuccessfulSubmits(2 + budget.retestSubmits + 2);
    expect(scheduler.get('hidden')).toMatchObject({ status: 'hidden', successfulSubmits: 0 });

    scheduler.advanceSuccessfulSubmits(2 + budget.retestSubmits + budget.expirySubmits);
    expect(scheduler.get('hidden')).toMatchObject({ status: 'visible', dirty: true });
  });

  it('keeps a same-generation excluded reschedule reachable after an empty bucket', () => {
    const budget = createVisibilityBudget();
    const scheduler = new OcclusionConfidenceScheduler(budget);
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 1 });
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 2 });
    for (let generation = 3; generation <= 2 + budget.retestSubmits; generation += 1) {
      scheduler.apply('hidden', { type: 'submit', submissionGeneration: generation });
    }

    const retestGeneration = 2 + budget.retestSubmits;
    scheduler.advanceSuccessfulSubmits(retestGeneration, new Set(['hidden']));
    // Repeating the same generation used to leave the newly-created bucket
    // only in the map: unschedule removed its key but the heap membership bit
    // prevented addDue from pushing a reachable heap entry.
    scheduler.advanceSuccessfulSubmits(retestGeneration, new Set(['hidden']));
    // The requeued wake at generation 8 must remain reachable. Consuming it
    // here recreates the expiry at generation 10; without the heap repair the
    // old expiry was removed and this later recovery never happens.
    scheduler.advanceSuccessfulSubmits(retestGeneration);
    scheduler.advanceSuccessfulSubmits(
      retestGeneration + budget.expirySubmits - budget.retestSubmits,
    );
    expect(scheduler.get('hidden')).toMatchObject({ status: 'visible', dirty: true });
  });

  it('advances a due hidden row queried in the same generation exactly once', () => {
    const budget = createVisibilityBudget();
    const scheduler = new OcclusionConfidenceScheduler(budget);
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 1 });
    scheduler.apply('hidden', { type: 'result', samples: 0, submissionGeneration: 2 });
    const dueGeneration = 2 + budget.retestSubmits;

    scheduler.advanceSuccessfulSubmits(dueGeneration);
    expect(scheduler.get('hidden')).toMatchObject({
      status: 'hidden',
      successfulSubmits: budget.retestSubmits,
    });
    scheduler.apply('hidden', { type: 'submit', submissionGeneration: dueGeneration });
    scheduler.advanceSuccessfulSubmits(dueGeneration);
    expect(scheduler.get('hidden')).toMatchObject({
      status: 'hidden',
      successfulSubmits: budget.retestSubmits + 1,
    });
  });
});
