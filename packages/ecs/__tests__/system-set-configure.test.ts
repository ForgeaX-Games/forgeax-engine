// @forgeax/engine-ecs — configureSets positive tests (w6, RED)
//
// TDD: world.configureSets API does not exist yet, so this file will fail to
// compile (RED). It becomes GREEN after w8 implements the configureSets entry
// point.
//
// Coverage: AC-03 set-level edge recording, cumulative edge accumulation,
// empty-set no-op reference. M1 only records edges (no expansion).

import { describe, expect, it } from 'vitest';
import { defineSystemSet } from '../src/schedule';
import { World } from '../src/world';

describe('system-set-configure.test.ts', () => {
  describe('AC-03 — set-level edge recording', () => {
    it('configureSets with setA before setB returns ok', () => {
      const setA = defineSystemSet({ name: 'cfg-set-a' });
      const setB = defineSystemSet({ name: 'cfg-set-b' });
      const world = new World();
      const r = world.configureSets({ set: setA, before: [setB] });
      expect(r.ok).toBe(true);
    });

    it('configureSets with setA after setB returns ok', () => {
      const setA = defineSystemSet({ name: 'cfg-set-c' });
      const setB = defineSystemSet({ name: 'cfg-set-d' });
      const world = new World();
      const r = world.configureSets({ set: setA, after: [setB] });
      expect(r.ok).toBe(true);
    });

    it('configureSets with both before and after returns ok', () => {
      const setA = defineSystemSet({ name: 'cfg-set-e' });
      const setB = defineSystemSet({ name: 'cfg-set-f' });
      const setC = defineSystemSet({ name: 'cfg-set-g' });
      const world = new World();
      const r = world.configureSets({ set: setA, before: [setB], after: [setC] });
      expect(r.ok).toBe(true);
    });
  });

  describe('Cumulative edge accumulation', () => {
    it('same set called multiple times accumulates edges', () => {
      const setA = defineSystemSet({ name: 'cumul-set-a' });
      const setB = defineSystemSet({ name: 'cumul-set-b' });
      const setC = defineSystemSet({ name: 'cumul-set-c' });
      const world = new World();
      // First call adds before edge.
      world.configureSets({ set: setA, before: [setB] });
      // Second call adds after edge — accumulates, does not overwrite.
      const r = world.configureSets({ set: setA, after: [setC] });
      expect(r.ok).toBe(true);
    });
  });

  describe('Empty-set reference as before/after target', () => {
    it('empty set referenced as before target is no-op', () => {
      const setA = defineSystemSet({ name: 'empty-ref-a' });
      const setB = defineSystemSet({ name: 'empty-ref-b' });
      const world = new World();
      // setB has no members — configureSets still returns ok (M2 expands to no-op).
      const r = world.configureSets({ set: setA, before: [setB] });
      expect(r.ok).toBe(true);
    });

    it('empty set referenced as after target is no-op', () => {
      const setA = defineSystemSet({ name: 'empty-ref-c' });
      const setB = defineSystemSet({ name: 'empty-ref-d' });
      const world = new World();
      const r = world.configureSets({ set: setA, after: [setB] });
      expect(r.ok).toBe(true);
    });
  });
});