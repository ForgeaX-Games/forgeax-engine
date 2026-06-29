// registry.test-d - type-level assertions for the two new Registry interface
// methods registerMutatingMethods + lookupMutatingMethods (feat-20260517
// w2 / plan-strategy D-5). Pairs with the existing Registry interface in
// `../index.ts` (lookupRoot / lookupMethod) — same verb + Plural-noun shape.
//
// Assertions:
// - `Registry['registerMutatingMethods']` parameter type is exactly
//   `ReadonlySet<string>` (frozen-set contract; reference-stable identity
//   is the duplicate-detection key per plan-strategy D-5).
// - `Registry['registerMutatingMethods']` return type is
//   `RegisterRootResult` (charter proposition 5 consistent abstraction —
//   structurally aligned with `registerRoot` / `registerMethod`).
// - `Registry['lookupMutatingMethods']` is a no-arg method returning
//   `ReadonlySet<string>` (cached frozen Set; sandbox.ts reads it once at
//   wrap-time per research F6).
//
// Anchors: requirements §3 AC-04 (Registry interface adds two methods + grep
// must hit each name once); plan-strategy §2 D-5 (Registry interface extends
// with two methods using ReadonlySet<string>); §8.2 naming convention.

import { describe, expectTypeOf, it } from 'vitest';
import type { RegisterRootResult, Registry } from '../index';

describe('Registry interface - registerMutatingMethods + lookupMutatingMethods (feat-20260517 D-5)', () => {
  it('registerMutatingMethods: parameter type is ReadonlySet<string>', () => {
    expectTypeOf<Parameters<Registry['registerMutatingMethods']>>().toEqualTypeOf<
      [ReadonlySet<string>]
    >();
  });

  it('registerMutatingMethods: return type is RegisterRootResult', () => {
    expectTypeOf<
      ReturnType<Registry['registerMutatingMethods']>
    >().toEqualTypeOf<RegisterRootResult>();
  });

  it('lookupMutatingMethods: zero-argument signature returns ReadonlySet<string>', () => {
    expectTypeOf<Parameters<Registry['lookupMutatingMethods']>>().toEqualTypeOf<[]>();
    expectTypeOf<ReturnType<Registry['lookupMutatingMethods']>>().toEqualTypeOf<
      ReadonlySet<string>
    >();
  });
});
