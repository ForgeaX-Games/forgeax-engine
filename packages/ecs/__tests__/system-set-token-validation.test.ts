// @forgeax/engine-ecs — token validity negative tests (w5n + w6n + w9, RED)
//
// TDD: world.addSystems / world.configureSets token validation is not yet
// implemented (w7 / w8), so this file will fail to compile (RED). It becomes
// GREEN after w7 (addSystems) and w8 (configureSets) implement validation.
//
// Coverage: D-2 brand+identity dual boundary — typecheck @ts-expect-error,
// runtime forged-value rejection, runtime stale-token rejection, and
// cross-entry atomicity (w9).

import { describe, expect, it } from 'vitest';
import { defineSystem } from '../src/schedule';
import { defineSystemSet, getRegisteredSystemSets } from '../src/schedule';
import { World } from '../src/world';
import { defineComponent } from '../src/component';

const Pos = defineComponent('Pos', { x: 'f32', y: 'f32' });

// Helper: a system token for the addSystems tests.
const _dummySys = defineSystem({
  name: 'tokval-dummy',
  queries: [{ with: [Pos] }],
  fn: () => {},
});

// ---------------------------------------------------------------------------
// w5n — addSystems token validation negative tests
// ---------------------------------------------------------------------------

describe('system-set-token-validation.test.ts', () => {
  describe('w5n — addSystems token validation', () => {
    describe('typecheck layer — brand rejects plain object', () => {
      it('plain { name } passed to addSystems triggers @ts-expect-error', () => {
        const world = new World();
        // @ts-expect-error — plain object lacks the __forgeaxSystemSet brand
        const r = world.addSystems({ name: 'typo' }, [_dummySys]);
        expect(r.ok).toBe(false);
      });
    });

    describe('runtime layer — forged value rejected', () => {
      it('as unknown as SystemSet cast bypasses brand, runtime rejects with err', () => {
        const world = new World();
        const forged = { name: 'forged-set' } as unknown as ReturnType<typeof defineSystemSet>;
        const r = world.addSystems(forged, [_dummySys]);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('system-set-not-registered');
          expect(r.error.expected).toBe('forged-set');
          expect(r.error.hint).toContain('getRegisteredSystemSets');
          expect(r.error.detail.code).toBe('system-set-not-registered');
          expect(r.error.detail.name).toBe('forged-set');
          expect(Array.isArray(r.error.detail.registered)).toBe(true);
        }
        // No side effects: inspect unchanged.
        const snap = world.inspect();
        expect(snap.systemCount).toBe(0);
      });
    });

    describe('runtime layer — stale token rejected', () => {
      it('overwritten token rejected by addSystems', () => {
        const first = defineSystemSet({ name: 'stale-add' });
        const _second = defineSystemSet({ name: 'stale-add' }); // overwrites
        const world = new World();
        const r = world.addSystems(first, [_dummySys]);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('system-set-not-registered');
        }
        // No side effects.
        expect(world.inspect().systemCount).toBe(0);
      });

      it('current token (after overwrite) is accepted by addSystems', () => {
        const _first = defineSystemSet({ name: 'stale-add-ok' });
        const second = defineSystemSet({ name: 'stale-add-ok' }); // overwrites
        const world = new World();
        const r = world.addSystems(second, [_dummySys]);
        expect(r.ok).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // w6n — configureSets token validation negative tests
  // ---------------------------------------------------------------------------

  describe('w6n — configureSets token validation', () => {
    describe('typecheck layer — brand rejects plain object', () => {
      it('plain { name } passed as set triggers @ts-expect-error', () => {
        const world = new World();
        // @ts-expect-error — plain object lacks the __forgeaxSystemSet brand
        const r = world.configureSets({ set: { name: 'typo' } });
        expect(r.ok).toBe(false);
      });

      it('plain { name } passed as before triggers @ts-expect-error', () => {
        const set = defineSystemSet({ name: 'cfg-set' });
        const world = new World();
        // @ts-expect-error — plain object lacks the __forgeaxSystemSet brand
        const r = world.configureSets({ set, before: [{ name: 'typo' }] });
        expect(r.ok).toBe(false);
      });

      it('plain { name } passed as after triggers @ts-expect-error', () => {
        const set = defineSystemSet({ name: 'cfg-set-2' });
        const world = new World();
        // @ts-expect-error — plain object lacks the __forgeaxSystemSet brand
        const r = world.configureSets({ set, after: [{ name: 'typo' }] });
        expect(r.ok).toBe(false);
      });
    });

    describe('runtime layer — forged value rejected', () => {
      it('as unknown as SystemSet cast as main set bypasses brand, runtime rejects', () => {
        const world = new World();
        const forged = { name: 'forged-cfg' } as unknown as ReturnType<typeof defineSystemSet>;
        const r = world.configureSets({ set: forged });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('system-set-not-registered');
          expect(r.error.expected).toBe('forged-cfg');
          expect(r.error.detail.name).toBe('forged-cfg');
        }
      });

      it('as unknown as SystemSet cast as before member rejects, no side effects', () => {
        const set = defineSystemSet({ name: 'cfg-main' });
        const world = new World();
        const forged = { name: 'forged-before' } as unknown as ReturnType<typeof defineSystemSet>;
        const r = world.configureSets({ set, before: [forged] });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('system-set-not-registered');
        }
      });

      it('as unknown as SystemSet cast as after member rejects, no side effects', () => {
        const set = defineSystemSet({ name: 'cfg-main-2' });
        const world = new World();
        const forged = { name: 'forged-after' } as unknown as ReturnType<typeof defineSystemSet>;
        const r = world.configureSets({ set, after: [forged] });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('system-set-not-registered');
        }
      });
    });

    describe('runtime layer — stale token rejected', () => {
      it('overwritten token as main set rejected by configureSets', () => {
        const first = defineSystemSet({ name: 'stale-cfg' });
        const _second = defineSystemSet({ name: 'stale-cfg' }); // overwrites
        const world = new World();
        const r = world.configureSets({ set: first });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('system-set-not-registered');
        }
      });

      it('current token (after overwrite) is accepted by configureSets', () => {
        const _first = defineSystemSet({ name: 'stale-cfg-ok' });
        const second = defineSystemSet({ name: 'stale-cfg-ok' }); // overwrites
        const world = new World();
        const r = world.configureSets({ set: second });
        expect(r.ok).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // w9 — cross-entry atomicity tests
  // ---------------------------------------------------------------------------

  describe('w9 — cross-entry atomicity', () => {
    it('valid main set + invalid before token in configureSets rejects entirely', () => {
      const set = defineSystemSet({ name: 'atom-main' });
      const world = new World();
      const forged = { name: 'atom-forged' } as unknown as ReturnType<typeof defineSystemSet>;
      const r = world.configureSets({ set, before: [forged] });
      expect(r.ok).toBe(false);
      // No partial write: no set record, no edges, no dirty.
      const snap = world.inspect();
      // No system registered through addSystems, so systemCount should be 0.
      expect(snap.systemCount).toBe(0);
    });

    it('valid main set + invalid after token in configureSets rejects entirely', () => {
      const set = defineSystemSet({ name: 'atom-main-2' });
      const world = new World();
      const forged = { name: 'atom-forged-2' } as unknown as ReturnType<typeof defineSystemSet>;
      const r = world.configureSets({ set, after: [forged] });
      expect(r.ok).toBe(false);
    });

    it('invalid before token leaves records and dirty bit unchanged', () => {
      const set = defineSystemSet({ name: 'atom-record-main' });
      const world = new World();
      const schedule = (world as unknown as {
        readonly schedule: {
          readonly sets: ReadonlyMap<string, unknown>;
          dirty: boolean;
        };
      }).schedule;
      schedule.dirty = false;
      const forged = { name: 'atom-record-forged' } as unknown as ReturnType<typeof defineSystemSet>;

      const r = world.configureSets({ set, before: [forged] });

      expect(r.ok).toBe(false);
      expect(schedule.sets.has(set.name)).toBe(false);
      expect(schedule.sets.has('atom-record-forged')).toBe(false);
      expect(schedule.dirty).toBe(false);
    });

    it('addSystems and configureSets with valid tokens both pass', () => {
      const setA = defineSystemSet({ name: 'atom-pass-a' });
      const setB = defineSystemSet({ name: 'atom-pass-b' });
      const world = new World();
      const sys = defineSystem({
        name: 'atom-pass-sys',
        queries: [{ with: [Pos] }],
        fn: () => {},
      });
      const r1 = world.addSystems(setA, [sys]);
      expect(r1.ok).toBe(true);
      const r2 = world.configureSets({ set: setA, before: [setB] });
      expect(r2.ok).toBe(true);
    });
  });
});