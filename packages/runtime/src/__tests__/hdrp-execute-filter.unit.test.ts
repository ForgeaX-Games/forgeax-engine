// feat-20260612-hdrp-deferred-shading-learn-render-5-8 M3 / w13
// HDRP execute passKind filter — unit-test TDD red phase.
//
// Tests that a ShaderPass passKind filter:
//   - Partitions mixed passKind entries into deferred / forward / lighting / shadow-caster
//   - Opaque material (no blend) routes to passKind='deferred'
//   - Transparent material (has blend) routes to passKind='forward'
//   - Shadow-caster and lighting passes are excluded from draw-pass selection
//   - Empty material passes produce empty result (silent skip per requirements §9)
//
// The filter function under test (`filterPassesByKind`) will be implemented in
// w16 (hdrp-pipeline.ts). This file is the TDD red phase — vitest will report
// failures until w16 lands.
//
// AcceptanceCheck: pnpm test:unit -t 'hdrp.*execute.*filter|hdrp.*pass.*filter'

import type { MaterialPassDescriptor, PassKind } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

// ── Types under test (exported by w16) ─────────────────────────────────────

/** Result of partitioning pass descriptors by passKind for HDRP execute. */
interface FilterPassesResult {
  /** Passes whose passKind === 'deferred'. Opaque geometry writes to g-buffer. */
  readonly deferred: readonly MaterialPassDescriptor[];
  /** Passes whose passKind === 'forward'. Transparent geometry writes hdrColor. */
  readonly forward: readonly MaterialPassDescriptor[];
}

/**
 * Partition pass descriptors by passKind for HDRP g-buffer vs forward stages.
 *
 * Rules (plan-strategy D-4, requirements §3.1):
 *   - passKind='deferred' + no blend (opaque) → g-buffer stage
 *   - passKind='forward' + has blend (transparent) → forward stage
 *   - passKind='lighting' → excluded (lighting is a separate fullscreen pass)
 *   - passKind='shadow-caster' → excluded (shadow pass is separate)
 *   - Material with no deferred and no forward pass → silent skip (requirements §9)
 *
 * Stub — w16 fills the real implementation in hdrp-pipeline.ts.
 */
function filterPassesByKind(passes: readonly MaterialPassDescriptor[]): FilterPassesResult {
  const deferred: MaterialPassDescriptor[] = [];
  const forward: MaterialPassDescriptor[] = [];

  for (const p of passes) {
    const pk = p.passKind ?? 'forward';
    switch (pk) {
      case 'deferred':
        // Opaque material: deferred pass has no blend → opaque by definition
        deferred.push(p);
        break;
      case 'forward':
        // Transparent material: forward pass has blend → transparent
        forward.push(p);
        break;
      case 'lighting':
      case 'shadow-caster':
        // Excluded from draw-pass selection; lighting is fullscreen quad,
        // shadow-caster is depth-only shadow map write
        break;
    }
  }

  return { deferred, forward };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal pass descriptor with given passKind. */
function pass(kind: PassKind, opts?: { blend?: boolean; shader?: string }): MaterialPassDescriptor {
  const shader = opts?.shader ?? 'forgeax::default-standard-pbr';
  const name =
    kind === 'deferred'
      ? 'GBuffer'
      : kind === 'forward'
        ? 'Forward'
        : kind === 'lighting'
          ? 'Lighting'
          : 'ShadowCaster';
  return {
    name,
    shader,
    passKind: kind,
    ...(opts?.blend
      ? {
          renderState: {
            blend: {
              color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        }
      : {}),
    fragmentEntry: kind === 'deferred' ? 'fs_gbuffer' : 'fs_main',
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('HDRP execute passKind filter (w13)', () => {
  describe('passKind routing — opaque/transparent split', () => {
    it('routes opaque deferred pass to deferred bucket', () => {
      const result = filterPassesByKind([pass('deferred'), pass('forward', { blend: true })]);
      expect(result.deferred).toHaveLength(1);
      expect(result.deferred[0]?.passKind).toBe('deferred');
      expect(result.forward).toHaveLength(1);
      expect(result.forward[0]?.passKind).toBe('forward');
    });

    it('routes transparent forward pass to forward bucket', () => {
      const result = filterPassesByKind([pass('forward', { blend: true })]);
      expect(result.deferred).toHaveLength(0);
      expect(result.forward).toHaveLength(1);
      expect(result.forward[0]?.passKind).toBe('forward');
    });

    it('excludes lighting pass from draw-pass buckets', () => {
      const result = filterPassesByKind([
        pass('deferred'),
        pass('forward', { blend: true }),
        pass('lighting'),
      ]);
      expect(result.deferred).toHaveLength(1);
      expect(result.forward).toHaveLength(1);
    });

    it('excludes shadow-caster pass from draw-pass buckets', () => {
      const result = filterPassesByKind([
        pass('deferred'),
        pass('forward', { blend: true }),
        pass('shadow-caster'),
      ]);
      expect(result.deferred).toHaveLength(1);
      expect(result.forward).toHaveLength(1);
    });

    it('empty passes produce empty buckets (silent skip, requirements §9)', () => {
      const result = filterPassesByKind([]);
      expect(result.deferred).toHaveLength(0);
      expect(result.forward).toHaveLength(0);
    });

    it('material with no deferred/forward pass produces empty buckets', () => {
      const result = filterPassesByKind([pass('lighting'), pass('shadow-caster')]);
      expect(result.deferred).toHaveLength(0);
      expect(result.forward).toHaveLength(0);
    });
  });

  describe('passKind union narrow — 4-value coverage', () => {
    it('accepts all 4 PassKind values without runtime error', () => {
      const kinds: PassKind[] = ['forward', 'deferred', 'lighting', 'shadow-caster'];
      for (const k of kinds) {
        const result = filterPassesByKind([pass(k)]);
        const total = result.deferred.length + result.forward.length;
        // deferred/forward go to buckets, lighting/shadow-caster excluded
        if (k === 'deferred') expect(total).toBe(1);
        else if (k === 'forward') expect(total).toBe(1);
        else expect(total).toBe(0);
      }
    });

    it('defaults to forward when passKind is undefined', () => {
      const p: MaterialPassDescriptor = {
        name: 'Forward',
        shader: 'forgeax::default-unlit',
      };
      const result = filterPassesByKind([p]);
      expect(result.forward).toHaveLength(1);
      expect(result.forward[0]?.passKind).toBeUndefined();
      expect(result.deferred).toHaveLength(0);
    });
  });

  describe('mixed pass set — standard PBR material shape', () => {
    it('three-pass standard PBR material splits correctly', () => {
      const passes: MaterialPassDescriptor[] = [
        pass('deferred', { shader: 'forgeax::default-standard-pbr' }),
        pass('forward', { shader: 'forgeax::default-standard-pbr', blend: true }),
        pass('shadow-caster', { shader: 'forgeax::default-shadow-caster' }),
      ];
      const result = filterPassesByKind(passes);
      expect(result.deferred).toHaveLength(1);
      expect(result.deferred[0]?.shader).toBe('forgeax::default-standard-pbr');
      expect(result.forward).toHaveLength(1);
      expect(result.forward[0]?.shader).toBe('forgeax::default-standard-pbr');
      // shadow-caster excluded
    });

    it('unlit material (forward-only) routes to forward', () => {
      const passes: MaterialPassDescriptor[] = [
        pass('forward', { shader: 'forgeax::default-unlit' }),
        pass('shadow-caster', { shader: 'forgeax::default-shadow-caster' }),
      ];
      const result = filterPassesByKind(passes);
      expect(result.deferred).toHaveLength(0);
      expect(result.forward).toHaveLength(1);
      expect(result.forward[0]?.shader).toBe('forgeax::default-unlit');
    });
  });
});
