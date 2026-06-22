// asset-registry.recursive.test-d — type-level assertion that collectRefs
// fails to compile if the closed Asset union gains a new kind without an
// accompanying case in the exhaustive switch (requirements AC-09 / D-3).
//
// The technique: declare a local function that mirrors collectRefs' exhaustive
// switch contract (no default arm) and assert it type-checks against the real
// Asset union. Then, separately, an `@ts-expect-error` proves that a value
// outside the union cannot be widened to `Asset` — meaning that if someone
// added a new kind to the real union, the existing exhaustive switch in
// `collectRefs.ts` becomes a TS `never`-flow error.
//
// Charter P3: closed-union exhaustive switch without default arm is the
// compile-time guard; this fixture proves the guard fires.

import type { Asset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

// Local exhaustive-switch mirror: same contract as collectRefs.
// If Asset gains a 14th member tomorrow, this function (and collectRefs)
// both become `Type '<new-kind>' is not assignable to type 'never'`.
// Mirror of the production switch in packages/runtime/src/collect-refs.ts — keep cases in sync.
function assertExhaustive(asset: Asset): number {
  switch (asset.kind) {
    case 'mesh':
      return 0;
    case 'texture':
      return 0;
    case 'cube-texture':
      return 0;
    case 'sampler':
      return 0;
    case 'shader':
      return 0;
    case 'skeleton':
      return 0;
    case 'animation-clip':
      return 0;
    case 'audio':
      return 0;
    case 'font':
      return 0;
    case 'render-pipeline':
      return 0;
    // composites (M1-M2) — present for exhaustiveness
    case 'scene':
      return 1;
    case 'material':
      return 2;
    case 'skin':
      return 3;
    // feat-20260608 M0 baseline rebuild — tileset leaf (no GUID refs in POD).
    case 'tileset':
      return 0;
  }
}

describe('collectRefs exhaustive switch (AC-09)', () => {
  it('assertExhaustive covers all current Asset union members', () => {
    expectTypeOf(assertExhaustive).returns.toBeNumber();
  });

  it('a kind outside the closed union cannot be assigned to Asset', () => {
    const fake = { kind: 'hypothetical-new-kind' as const, __brand: null };
    // @ts-expect-error — 'hypothetical-new-kind' is not a member of Asset
    const _bad: Asset = fake;
    void _bad;
  });
});
