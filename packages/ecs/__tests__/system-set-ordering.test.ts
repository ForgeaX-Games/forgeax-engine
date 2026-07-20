// @forgeax/engine-ecs — set-level ordering + chain tests (w10, w11, RED)
//
// TDD: set-level edge expansion in buildSchedule() does not exist yet, so all
// ordering tests that rely on set edges being expanded will fail (RED). They
// become GREEN after w14 implements the expansion logic.
//
// Coverage:
//   w10: AC-03 set-level ordering (setA before setB), set+system overlay, empty-set no-op
//   w11: AC-06 chain serial, chain across addSystems, chain+explicit before/after conflict,
//        chain+set before/after cycle

import { describe, expect, it } from 'vitest';
import { CyclicDependencyError } from '../src/errors';
import { defineSystem, defineSystemSet } from '../src/schedule';
import { World } from '../src/world';

describe('system-set-ordering.test.ts', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // w10 — set-level ordering constraints
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-03 — set-level ordering', () => {
    it('setA before setB: each system in setA runs before each system in setB', () => {
      const setA = defineSystemSet({ name: 'ordered-a' });
      const setB = defineSystemSet({ name: 'ordered-b' });
      const world = new World();
      const log: string[] = [];

      const a1 = defineSystem({ name: 'a1', queries: [], fn: () => log.push('a1') });
      const a2 = defineSystem({ name: 'a2', queries: [], fn: () => log.push('a2') });
      const b1 = defineSystem({ name: 'b1', queries: [], fn: () => log.push('b1') });
      const b2 = defineSystem({ name: 'b2', queries: [], fn: () => log.push('b2') });

      // Register b-set first so natural registration order would put b1, b2
      // before a1, a2. Only the set edge expansion (setA before setB) can
      // reverse this — without it, the test is RED.
      world.addSystems(setB, [b1, b2]);
      world.addSystems(setA, [a1, a2]);
      world.configureSets({ set: setA, before: [setB] });

      world.update();

      // All a* must appear before all b* (set constraint overrides registration order)
      const a1Idx = log.indexOf('a1');
      const a2Idx = log.indexOf('a2');
      const b1Idx = log.indexOf('b1');
      const b2Idx = log.indexOf('b2');
      const maxA = Math.max(a1Idx, a2Idx);
      const minB = Math.min(b1Idx, b2Idx);
      expect(maxA).toBeLessThan(minB);
    });

    it('set constraint with system-level before/after overlay', () => {
      const setA = defineSystemSet({ name: 'overlay-a' });
      const setB = defineSystemSet({ name: 'overlay-b' });
      const world = new World();
      const log: string[] = [];

      const a1 = defineSystem({
        name: 'ov-a1',
        queries: [],
        fn: () => log.push('ov-a1'),
        after: ['ov-z'],
      });
      const a2 = defineSystem({ name: 'ov-a2', queries: [], fn: () => log.push('ov-a2') });
      const b1 = defineSystem({ name: 'ov-b1', queries: [], fn: () => log.push('ov-b1') });
      const b2 = defineSystem({ name: 'ov-b2', queries: [], fn: () => log.push('ov-b2') });

      // Free system z — no set
      world.addSystem({ name: 'ov-z', queries: [], fn: () => log.push('ov-z') });

      // Register b-set first so natural order is the reverse — only set edge
      // expansion makes a's come before b's
      world.addSystems(setB, [b1, b2]);
      world.addSystems(setA, [a1, a2]);
      world.configureSets({ set: setA, before: [setB] });

      world.update();

      // z before a1 (system-level after), a1 before b1/b2 (set-level override)
      const zIdx = log.indexOf('ov-z');
      const a1Idx = log.indexOf('ov-a1');
      const a2Idx = log.indexOf('ov-a2');
      const b1Idx = log.indexOf('ov-b1');
      const b2Idx = log.indexOf('ov-b2');
      expect(zIdx).toBeLessThan(a1Idx);
      const maxA = Math.max(a1Idx, a2Idx);
      const minB = Math.min(b1Idx, b2Idx);
      expect(maxA).toBeLessThan(minB);
    });

    it('empty set referenced as before/after target is a no-op', () => {
      const emptySet = defineSystemSet({ name: 'empty-target' });
      const activeSet = defineSystemSet({ name: 'active-set' });
      const world = new World();
      const log: string[] = [];

      const sys = defineSystem({
        name: 'active-sys',
        queries: [],
        fn: () => log.push('active-sys'),
      });

      world.addSystems(activeSet, [sys]);
      // emptySet has no members — before reference should be a no-op
      world.configureSets({ set: activeSet, before: [emptySet] });

      world.update();

      expect(log).toEqual(['active-sys']);
    });

    it('empty set with after reference is a no-op', () => {
      const emptySet = defineSystemSet({ name: 'empty-after' });
      const activeSet = defineSystemSet({ name: 'active-after' });
      const world = new World();
      const log: string[] = [];

      const sys = defineSystem({
        name: 'after-sys',
        queries: [],
        fn: () => log.push('after-sys'),
      });

      world.addSystems(activeSet, [sys]);
      world.configureSets({ set: activeSet, after: [emptySet] });

      world.update();

      expect(log).toEqual(['after-sys']);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // w11 — chain serial + boundary cases
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-06 — chain serial execution', () => {
    it('chain set members execute in strict registration order', () => {
      const chainSet = defineSystemSet({ name: 'chained', chained: true });
      const world = new World();
      const log: string[] = [];

      const c1 = defineSystem({ name: 'ch1', queries: [], fn: () => log.push('ch1') });
      const c2 = defineSystem({ name: 'ch2', queries: [], fn: () => log.push('ch2') });
      const c3 = defineSystem({ name: 'ch3', queries: [], fn: () => log.push('ch3') });

      world.addSystems(chainSet, [c1, c2, c3]);
      world.update();

      expect(log).toEqual(['ch1', 'ch2', 'ch3']);
    });

    it('chain order accumulates across multiple addSystems calls', () => {
      const chainSet = defineSystemSet({ name: 'chained-acc', chained: true });
      const world = new World();
      const log: string[] = [];

      const c1 = defineSystem({ name: 'ca1', queries: [], fn: () => log.push('ca1') });
      const c2 = defineSystem({ name: 'ca2', queries: [], fn: () => log.push('ca2') });
      const c3 = defineSystem({ name: 'ca3', queries: [], fn: () => log.push('ca3') });
      const c4 = defineSystem({ name: 'ca4', queries: [], fn: () => log.push('ca4') });

      world.addSystems(chainSet, [c1, c2]);
      world.addSystems(chainSet, [c3, c4]);
      world.update();

      // Members accumulate in insertion order: c1, c2, c3, c4
      expect(log).toEqual(['ca1', 'ca2', 'ca3', 'ca4']);
    });

    it('chain with single member executes normally', () => {
      const chainSet = defineSystemSet({ name: 'chained-single', chained: true });
      const world = new World();
      const log: string[] = [];

      const c1 = defineSystem({ name: 'cs1', queries: [], fn: () => log.push('cs1') });
      world.addSystems(chainSet, [c1]);
      world.update();

      expect(log).toEqual(['cs1']);
    });

    it('chain + explicit member before/after conflict → fail-fast CyclicDependencyError', () => {
      const chainSet = defineSystemSet({ name: 'chained-conflict', chained: true });
      const world = new World();

      const c1 = defineSystem({
        name: 'cc1',
        queries: [],
        fn: () => {},
        after: ['cc2'], // c1 after c2, but chain makes c1 before c2 → cycle
      });
      const c2 = defineSystem({ name: 'cc2', queries: [], fn: () => {} });

      world.addSystems(chainSet, [c1, c2]);
      expect(() => world.update()).toThrow(CyclicDependencyError);
    });

    it('chain + set before/after forming a cycle → fail-fast', () => {
      const setA = defineSystemSet({ name: 'cycle-set-a' });
      const setB = defineSystemSet({ name: 'cycle-set-b', chained: true });
      const world = new World();

      const a1 = defineSystem({ name: 'cycl-a1', queries: [], fn: () => {} });
      const a2 = defineSystem({ name: 'cycl-a2', queries: [], fn: () => {} });
      const b1 = defineSystem({ name: 'cycl-b1', queries: [], fn: () => {} });
      const b2 = defineSystem({ name: 'cycl-b2', queries: [], fn: () => {} });

      world.addSystems(setA, [a1, a2]);
      world.addSystems(setB, [b1, b2]);
      // setA before setB, setB before setA → cycle
      world.configureSets({ set: setA, before: [setB] });
      world.configureSets({ set: setB, before: [setA] });

      expect(() => world.update()).toThrow(CyclicDependencyError);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // w13 — CyclicDependencyError.detail.cycle structured assertions
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-04 — structured detail.cycle', () => {
    it('set constraint + system-level before/after forming cycle → detail.cycle is string[]', () => {
      const setA = defineSystemSet({ name: 'dcyc-a' });
      const setB = defineSystemSet({ name: 'dcyc-b' });
      const world = new World();

      const a1 = defineSystem({
        name: 'dcyc-a1',
        queries: [],
        fn: () => {},
        after: ['dcyc-b2'], // a1 after b2, but setA before setB → cycle
      });
      const a2 = defineSystem({ name: 'dcyc-a2', queries: [], fn: () => {} });
      const b1 = defineSystem({ name: 'dcyc-b1', queries: [], fn: () => {} });
      const b2 = defineSystem({ name: 'dcyc-b2', queries: [], fn: () => {} });

      world.addSystems(setA, [a1, a2]);
      world.addSystems(setB, [b1, b2]);
      world.configureSets({ set: setA, before: [setB] });

      try {
        world.update();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CyclicDependencyError);
        const e = err as CyclicDependencyError;
        expect(e.code).toBe('cyclic-dependency');
        expect(e.detail.code).toBe('cyclic-dependency');
        expect(e.detail.cycle).toBeInstanceOf(Array);
        expect(e.detail.cycle.length).toBeGreaterThanOrEqual(2);
        // Every element is a string
        for (const n of e.detail.cycle) {
          expect(typeof n).toBe('string');
        }
      }
    });

    it('pure system-level cycle (no sets) → detail.cycle is string[]', () => {
      const world = new World();

      world.addSystem({ name: 'pure-a', queries: [], fn: () => {}, after: ['pure-c'] });
      world.addSystem({ name: 'pure-b', queries: [], fn: () => {}, after: ['pure-a'] });
      world.addSystem({ name: 'pure-c', queries: [], fn: () => {}, after: ['pure-b'] });

      try {
        world.update();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CyclicDependencyError);
        const e = err as CyclicDependencyError;
        expect(e.code).toBe('cyclic-dependency');
        expect(e.detail.cycle).toBeInstanceOf(Array);
        expect(e.detail.cycle.length).toBeGreaterThanOrEqual(2);
        // cycle contains the system names
        expect(e.detail.cycle).toContain('pure-a');
        expect(e.detail.cycle).toContain('pure-b');
        expect(e.detail.cycle).toContain('pure-c');
      }
    });

    it('detail.cycle is accessible as readonly property without message parsing', () => {
      const world = new World();

      world.addSystem({ name: 'nomsg-a', queries: [], fn: () => {}, after: ['nomsg-b'] });
      world.addSystem({ name: 'nomsg-b', queries: [], fn: () => {}, after: ['nomsg-a'] });

      try {
        world.update();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CyclicDependencyError);
        const cycle = (err as CyclicDependencyError).detail.cycle;
        // Direct array access — no string parsing needed
        const first = cycle[0];
        expect(typeof first).toBe('string');
        expect(cycle.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});