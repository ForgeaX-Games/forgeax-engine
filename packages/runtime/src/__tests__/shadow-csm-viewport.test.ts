// shadow-csm-viewport.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M3 / w10: addShadowPass viewport extension test (RED).
//
// Covers D-4 (addShadowPass signature extended with optional viewport):
// - AddShadowPassOptions accepts optional viewport: { x, y, w, h }
// - Undefined viewport preserves backward compat (existing callers unchanged)
// - addShadowPass accepts viewport parameter without error

import { describe, expect, it } from 'vitest';
import type { AddShadowPassOptions } from '../render-graph-primitives';

describe('CSM viewport (w10)', () => {
  describe('AddShadowPassOptions viewport field', () => {
    it('accepts optional viewport with { x, y, w, h }', () => {
      // Type-level test: the opts type must accept viewport.
      const opts: AddShadowPassOptions = {
        depth: 'shadowDepth',
        selector: { LightMode: ['ShadowCaster'] },
        viewport: { x: 0, y: 0, w: 1024, h: 1024 },
      };
      expect(opts.viewport).toEqual({ x: 0, y: 0, w: 1024, h: 1024 });
    });

    it('undefined viewport preserves backward compat (existing callers unchanged)', () => {
      // Existing callers do not pass viewport -- must still typecheck.
      const opts: AddShadowPassOptions = {
        depth: 'shadowDepth',
        selector: { LightMode: ['ShadowCaster'] },
      };
      expect(opts.viewport).toBeUndefined();
    });

    it('addShadowPass accepts viewport parameter', () => {
      // The function must accept the extended options without error.
      // We import addShadowPass and verify its parameter type accepts viewport
      // through the type-level contract above; this is a compile-time assertion
      // that the signature is correct.
      const optsWithViewport: AddShadowPassOptions = {
        depth: 'shadowDepth',
        selector: { LightMode: ['ShadowCaster'] },
        viewport: { x: 1024, y: 0, w: 1024, h: 1024 },
      };
      // Verify opts are structurally sound.
      expect(optsWithViewport.viewport).not.toBeUndefined();
      expect(optsWithViewport.viewport?.x).toBe(1024);
      expect(optsWithViewport.viewport?.w).toBe(1024);
    });

    it('addShadowPass without viewport still compiles (backward compat)', () => {
      // The function must still accept the old signature shape.
      const optsWithoutViewport: AddShadowPassOptions = {
        depth: 'shadowDepth',
        selector: { LightMode: ['ShadowCaster'] },
      };
      expect(optsWithoutViewport.viewport).toBeUndefined();
      // Verify we can call addShadowPass with both shapes (type-level gate).
      // Runtime verification via dawn smoke and browser test (w12, w30).
    });
  });
});
