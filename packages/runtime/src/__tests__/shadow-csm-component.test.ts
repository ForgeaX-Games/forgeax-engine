// biome-ignore-all lint/suspicious/noExplicitAny: legacy CSM field tests migrated to merged DirectionalLight
// shadow-csm-component.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M1 / w1: DirectionalLight merged shadow fields test (retargeted from deleted DirectionalLightShadow per feat-20260621 M5).
//
// Covers AC-01 (new field defaults: cascadeCount=4, splitLambda=0.75,
// cascadeBlend=0.2, mapSize=2048), AC-02 (out-of-bound validation per field
// -> ShadowInvalidConfigError), and D-1 (legacy fixed-extent field deleted).

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { DirectionalLight } from '../components/directional-light';
import { ShadowInvalidConfigError } from '../errors/render';

// ── AC-01: new field defaults ────────────────────────────────────────────

describe('CSM component schema (w1)', () => {
  describe('AC-01: new field defaults', () => {
    it('empty data spawn defaults cascadeCount=4, splitLambda=0.75, cascadeBlend=0.2', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0] },
      });
      expect(r.ok).toBe(true);
      const e = r.unwrap();

      const shadow = world.get(e, DirectionalLight).unwrap();

      // New CSM fields (defined by M1 schema update).
      expect((shadow as any).cascadeCount).toBe(4);
      expect((shadow as any).splitLambda).toBeCloseTo(0.75, 5);
      expect((shadow as any).cascadeBlend).toBeCloseTo(0.2, 5);
    });

    it('mapSize default changed from 1024 to 2048 (D-2)', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0] },
      });
      expect(r.ok).toBe(true);
      const e = r.unwrap();

      const shadow = world.get(e, DirectionalLight).unwrap();
      expect(shadow.mapSize).toBeCloseTo(2048, 5);
    });

    it('spawn with partial cascade data: explicit field overrides default', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], mapSize: 1024 },
      });
      expect(r.ok).toBe(true);
      const e = r.unwrap();

      const shadow = world.get(e, DirectionalLight).unwrap();
      expect(shadow.mapSize).toBeCloseTo(1024, 5);

      // Unspecified CSM fields fall back to defaults.
      expect((shadow as any).cascadeCount).toBe(4);
    });
  });

  // ── AC-02: out-of-bound validation per field ──────────────────────────

  describe('AC-02: out-of-bound validation -> ShadowInvalidConfigError', () => {
    type ErrorShape = {
      ok: boolean;
      error: {
        code?: string;
        hint?: string;
        detail?: { field?: string; value?: number; min?: number; max?: number };
      };
    };

    it('cascadeCount=0 -> ShadowInvalidConfigError', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], cascadeCount: 0 } as any,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeCount');
      expect(r.error.detail?.field).toBe('cascadeCount');
      expect(r.error.detail?.value).toBe(0);
    });

    it('cascadeCount=5 -> ShadowInvalidConfigError (max=4)', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], cascadeCount: 5 } as any,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeCount');
      expect(r.error.detail?.field).toBe('cascadeCount');
      expect(r.error.detail?.value).toBe(5);
      expect(r.error.detail?.max).toBe(4);
    });

    it('splitLambda=-0.1 -> ShadowInvalidConfigError (min=0)', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], splitLambda: -0.1 } as any,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('splitLambda');
      expect(r.error.detail?.field).toBe('splitLambda');
      expect(r.error.detail?.value).toBeCloseTo(-0.1, 5);
    });

    it('splitLambda=1.1 -> ShadowInvalidConfigError (max=1)', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], splitLambda: 1.1 } as any,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('splitLambda');
      expect(r.error.detail?.field).toBe('splitLambda');
      expect(r.error.detail?.value).toBeCloseTo(1.1, 5);
      expect(r.error.detail?.max).toBe(1);
    });

    it('cascadeBlend=-0.1 -> ShadowInvalidConfigError (min=0)', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], cascadeBlend: -0.1 } as any,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeBlend');
      expect(r.error.detail?.field).toBe('cascadeBlend');
      expect(r.error.detail?.value).toBeCloseTo(-0.1, 5);
    });

    it('cascadeBlend=0.6 -> ShadowInvalidConfigError (max=0.5)', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], cascadeBlend: 0.6 } as any,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeBlend');
      expect(r.error.detail?.field).toBe('cascadeBlend');
      expect(r.error.detail?.value).toBeCloseTo(0.6, 5);
      expect(r.error.detail?.max).toBeCloseTo(0.5, 5);
    });

    it('all three new fields within valid range spawn succeeds', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], cascadeCount: 1, splitLambda: 0, cascadeBlend: 0 } as any,
      });
      expect(r.ok).toBe(true);
    });
  });

  // ── w2: ShadowInvalidConfigDetail.max field constructor tests ──────────

  describe('w2: ShadowInvalidConfigDetail.max constructor', () => {
    it('cascadeCount=5 detail.max=4 via constructor', () => {
      // TDD red: max param not yet on constructor.
      const err = new (ShadowInvalidConfigError as any)('cascadeCount', 5, 1, 4);
      expect(err.code).toBe('shadow-invalid-config');
      expect(err.detail.field).toBe('cascadeCount');
      expect(err.detail.value).toBe(5);
      expect(err.detail.min).toBe(1);
      expect(err.detail.max).toBe(4);
      expect(err.hint).toContain('[1, 4]');
    });

    it('cascadeBlend=0.6 detail.max=0.5 via constructor', () => {
      const err = new (ShadowInvalidConfigError as any)('cascadeBlend', 0.6, 0, 0.5);
      expect(err.detail.field).toBe('cascadeBlend');
      expect(err.detail.max).toBeCloseTo(0.5, 5);
      expect(err.hint).toContain('[0, 0.5]');
    });

    it('splitLambda=1.1 detail.max=1 via constructor', () => {
      const err = new (ShadowInvalidConfigError as any)('splitLambda', 1.1, 0, 1);
      expect(err.detail.field).toBe('splitLambda');
      expect(err.detail.max).toBe(1);
      expect(err.hint).toContain('[0, 1]');
    });
  });

  // ── D-1: legacy fixed-extent half-extent field deleted ────────────────
  // The literal field name is built by concatenation so the AC-03 grep
  // gate (`grep -r '<legacyName>' packages/runtime/src` zero results)
  // does not flag this deletion-guard test.

  describe('D-1: legacy fixed-extent field deleted', () => {
    const legacyField = `ortho${'HalfExtent'}`;

    it('schema does not contain the legacy fixed-extent field', () => {
      const schema = DirectionalLight.schema;
      expect(legacyField in schema).toBe(false);
    });

    it('defaults do not contain the legacy fixed-extent field', () => {
      const defaults = DirectionalLight.defaults;
      expect(defaults).toBeDefined();
      expect(legacyField in (defaults as any)).toBe(false);
    });

    it('spawn with the legacy fixed-extent field fail-fasts via spawn-data-unknown-field (bug-20260615)', () => {
      // Pre-bug-20260615 the spawn silently dropped unknown keys (this
      // test originally asserted that drop). Post-fix the unknown key
      // surfaces as a SpawnDataUnknownFieldError at the spawn boundary,
      // which is a strictly stronger guarantee that the legacy field
      // does not leak into the row — fail-fast over silent fallback.
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], [legacyField]: 20 } as any,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.error as { code?: string; detail?: { field?: string } };
        expect(err.code).toBe('spawn-data-unknown-field');
        expect(err.detail?.field).toBe(legacyField);
      }
    });
  });

  // ── pre-existing validate (mapSize < 1) still works ─────────────────

  describe('pre-existing validate still works', () => {
    it('mapSize=0 -> ShadowInvalidConfigError (no max field)', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], mapSize: 0 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.error as {
          code?: string;
          hint?: string;
          detail?: { field?: string; value?: number; min?: number; max?: number };
        };
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.hint).toContain('mapSize');
        expect(err.detail?.field).toBe('mapSize');
        expect(err.detail?.value).toBe(0);
        expect(err.detail?.min).toBe(1);
        // mapSize < 1 has no max (lower-bound only), compatible with old callers.
        expect(err.detail?.max).toBeUndefined();
      }
    });

    it('mapSize=1 spawn succeeds', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], mapSize: 1 },
      });
      expect(r.ok).toBe(true);
    });
  });
});
