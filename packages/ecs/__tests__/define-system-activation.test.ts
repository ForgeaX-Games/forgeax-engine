import { Update } from '../src/schedule-token';
// feat-20260618-ecs-module-mechanism M1 / w1 (AC-01):
// defineSystem(desc) returns a token; world.addSystem(Update, token) activates it with
// zero modification; after update() the system fn is invoked exactly once. The
// token is consumed directly -- NOT round-tripped through
// getRegisteredSystems().get(name) (that is the AC-02 aux path).
//
// Constraints (plan-strategy D-6 / requirements OOS-8): addSystem signature is
// unchanged and accepts the token raw; no addSystem(name: string) by-name
// overload exists.

import { describe, expect, it } from 'vitest';
import { defineComponent, getRegisteredComponents } from '../src/component';
import { defineSystem, defineSystemSet, getRegisteredSystems } from '../src/index';
import { World } from '../src/world';

describe('define-system-activation.test.ts', () => {
  it('AC-01: defineSystem token feeds addSystem directly; fn runs once per update', () => {
    let calls = 0;
    const Marker = defineComponent('W1Marker', { v: 'f32' });
    const token = defineSystem({
      name: 'w1-activation',
      queries: [{ with: [Marker] }],
      fn: (_world, _queryResults, _commands) => {
        calls += 1;
      },
    });

    const world = new World();
    world.spawn({ component: Marker, data: { v: 1 } });
    world.addSystem(Update, token);

    expect(calls).toBe(0);
    world.update();
    expect(calls).toBe(1);
    world.update();
    expect(calls).toBe(2);
  });

  it('AC-01: token is the frozen descriptor (defineSystem returns the same shape)', () => {
    const token = defineSystem({
      name: 'w1-shape',
      queries: [],
      fn: () => {},
    });
    expect(token.name).toBe('w1-shape');
    expect(Array.isArray(token.queries)).toBe(true);
    expect(typeof token.fn).toBe('function');
    expect(Object.isFrozen(token)).toBe(true);
  });

  // ── w24 (AC-11): same-name silent overwrite ──

  describe('AC-11: same-name silent overwrite (no throw)', () => {
    it('defineSystem second call overwrites in SYSTEM_REGISTRY without throw', () => {
      const set = defineSystemSet({ name: 'w24-set' });
      const A = defineSystem({
        name: 'w24-dup',
        queries: [],
        fn: () => {},
      });
      const B = defineSystem({
        name: 'w24-dup',
        queries: [],
        fn: () => {},
      });
      const world = new World();
      world.addSystems(Update, set, [B]);

      // No throw reached here -- defineSystem silently overwrites (OOS-3).
      // Registries are global singletons; the static import already resolved.
      const got = getRegisteredSystems().get('w24-dup');
      expect(got).toBe(B);
      expect(world.inspect().systems.find((system) => system.name === 'w24-dup')?.sets).toEqual([
        'w24-set',
      ]);
      expect(got).not.toBe(A);
    });

    it('defineComponent second call still silently overwrites (unchanged)', () => {
      const C1 = defineComponent('W24Comp', { x: 'f32' });
      const C2 = defineComponent('W24Comp', { y: 'f32' });

      const got = getRegisteredComponents().get('W24Comp');
      expect(got).toBe(C2);
      expect(got).not.toBe(C1);
    });
  });
});
