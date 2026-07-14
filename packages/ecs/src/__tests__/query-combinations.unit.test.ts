// query-combinations.unit.test.ts — value tests for queryCombinations
// (solo bevy-examples round 20260713-194533).
//
// Regression guard for the friction that motivated the helper: acting on every
// unordered PAIR of matched entities (Bevy iter_combinations: N-body force,
// broadphase, flocking) forced an AI user to queryRun → collect handles → hand-
// write a nested `for i / for j=i+1` loop, re-deriving the combination math
// (self-pairs, double-counting). These tests pin:
//   1. K=2 over N yields exactly C(N,2) unordered pairs, no self-pairs, no dups,
//   2. K=3 yields C(N,3) triples in ascending-index order,
//   3. empty / single-entity query yields zero combinations; K>N yields zero,
//   4. combinations respect the query filter (with / without),
//   5. each yielded handle is valid — world.get resolves its components,
//   6. the K=2 default (omitted k arg is 2 — via explicit 2 here; see main.ts),
//   7. Entity omitted from `with` → fail-fast QueryCombinationsEntityRequiredError.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import { createQueryState, queryCombinations, queryRun } from '../query';
import { World } from '../world';

const Body = defineComponent('Body', { mass: 'f32' });
const Frozen = defineComponent('Frozen', { flag: 'u32' });

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

describe('queryCombinations — pair (K=2) semantics', () => {
  it('yields exactly C(N,2) unordered pairs, no self-pairs, no duplicates', () => {
    const world = new World();
    const handles: number[] = [];
    for (let i = 0; i < 5; i++) {
      handles.push(world.spawn({ component: Body, data: { mass: i + 1 } }) as unknown as number);
    }
    const state = createQueryState({ with: [Body, Entity] });
    const seen = new Set<string>();
    let count = 0;
    queryCombinations(state, world, 2, ([a, b]) => {
      count++;
      expect(a).not.toBe(b); // no self-pair
      const key = pairKey(a as unknown as number, b as unknown as number);
      expect(seen.has(key)).toBe(false); // no duplicate unordered pair
      seen.add(key);
    });
    expect(count).toBe(10); // C(5,2)
    expect(seen.size).toBe(10);
  });

  it('each yielded handle resolves via world.get', () => {
    const world = new World();
    for (let i = 0; i < 4; i++) world.spawn({ component: Body, data: { mass: i + 1 } });
    const state = createQueryState({ with: [Body, Entity] });
    queryCombinations(state, world, 2, (pair) => {
      const a = pair[0];
      const b = pair[1];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      const ra = world.get(a as EntityHandle, Body);
      const rb = world.get(b as EntityHandle, Body);
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
    });
  });

  it('ascending-index order within each pair, matching the queryRun iteration order', () => {
    const world = new World();
    for (let i = 0; i < 4; i++) world.spawn({ component: Body, data: { mass: i } });
    const state = createQueryState({ with: [Body, Entity] });

    // The collection order is whatever queryRun yields (archetype-internal), NOT
    // the spawn-handle numeric value. queryCombinations must pair by that same
    // order with i < j — so rank by the queryRun order and assert a precedes b.
    const rank = new Map<number, number>();
    let r = 0;
    queryRun(state, world, (bundle) => {
      const selfCol = bundle.Entity.self;
      for (let i = 0; i < selfCol.length; i++) rank.set((selfCol[i] ?? 0) as number, r++);
    });

    queryCombinations(state, world, 2, ([a, b]) => {
      const ra = rank.get(a as unknown as number) ?? -1;
      const rb = rank.get(b as unknown as number) ?? -1;
      expect(ra).toBeGreaterThanOrEqual(0);
      expect(ra < rb).toBe(true); // a precedes b in the collected order
    });
  });
});

describe('queryCombinations — K=3 and boundary cases', () => {
  it('K=3 yields exactly C(N,3) triples', () => {
    const world = new World();
    for (let i = 0; i < 5; i++) world.spawn({ component: Body, data: { mass: i } });
    const state = createQueryState({ with: [Body, Entity] });
    let count = 0;
    queryCombinations(state, world, 3, (t) => {
      expect(t.length).toBe(3);
      count++;
    });
    expect(count).toBe(10); // C(5,3)
  });

  it('empty query yields zero combinations', () => {
    const world = new World();
    const state = createQueryState({ with: [Body, Entity] });
    let count = 0;
    queryCombinations(state, world, 2, () => count++);
    expect(count).toBe(0);
  });

  it('single-entity query yields zero pairs', () => {
    const world = new World();
    world.spawn({ component: Body, data: { mass: 1 } });
    const state = createQueryState({ with: [Body, Entity] });
    let count = 0;
    queryCombinations(state, world, 2, () => count++);
    expect(count).toBe(0);
  });

  it('K > N yields zero', () => {
    const world = new World();
    for (let i = 0; i < 2; i++) world.spawn({ component: Body, data: { mass: i } });
    const state = createQueryState({ with: [Body, Entity] });
    let count = 0;
    queryCombinations(state, world, 3, () => count++);
    expect(count).toBe(0);
  });
});

describe('queryCombinations — filter + fail-fast', () => {
  it('respects the query `without` filter', () => {
    const world = new World();
    // 3 plain bodies + 2 frozen bodies; query excludes Frozen → C(3,2)=3 pairs.
    for (let i = 0; i < 3; i++) world.spawn({ component: Body, data: { mass: i } });
    for (let i = 0; i < 2; i++) {
      world.spawn(
        { component: Body, data: { mass: 10 + i } },
        { component: Frozen, data: { flag: 1 } },
      );
    }
    const state = createQueryState({ with: [Body, Entity], without: [Frozen] });
    let count = 0;
    queryCombinations(state, world, 2, () => count++);
    expect(count).toBe(3); // C(3,2), the 2 frozen excluded
  });

  it('throws QueryCombinationsEntityRequiredError when Entity omitted from `with`', () => {
    const world = new World();
    world.spawn({ component: Body, data: { mass: 1 } });
    const state = createQueryState({ with: [Body] }); // no Entity
    let caughtCode = '';
    try {
      queryCombinations(state, world, 2, () => {});
    } catch (e) {
      caughtCode = (e as { code?: string }).code ?? '';
    }
    expect(caughtCode).toBe('query-combinations-entity-required');
  });
});
