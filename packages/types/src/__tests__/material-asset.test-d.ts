// material-asset.test-d - type-level (test-d) assertions for the
// pass-based MaterialAsset shape + RenderQueue constants + PassSelector
// (feat-20260526-material-asset-multipass-renderstate M1 / w5 + w8).
//
// Assertions:
// - RenderQueue 5 constant values (AC-04): Background=1000 / Geometry=2000 /
//   AlphaTest=2450 / Transparent=3000 / Overlay=4000
// - PassSelector type smoke:
//   (a) empty selector matches type,
//   (b) LightMode string array matches,
//   (c) number array is a type error.
//
// Anchors: requirements AC-04 (RenderQueue 5 constant values);
//          requirements AC-05 (PassSelector tags + matching);
//          plan-strategy D-3 (RenderQueue constants);
//          plan-strategy D-4 (PassSelector Record<string, string[]>).

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PassSelector } from '../index';
import { RenderQueue } from '../index';

describe('RenderQueue - 5 standard queue constants (w5 / AC-04)', () => {
  it('Background === 1000', () => {
    expect(RenderQueue.Background).toBe(1000);
  });

  it('Geometry === 2000', () => {
    expect(RenderQueue.Geometry).toBe(2000);
  });

  it('AlphaTest === 2450', () => {
    expect(RenderQueue.AlphaTest).toBe(2450);
  });

  it('Transparent === 3000', () => {
    expect(RenderQueue.Transparent).toBe(3000);
  });

  it('Overlay === 4000', () => {
    expect(RenderQueue.Overlay).toBe(4000);
  });

  it('exactly 5 keys', () => {
    expect(Object.keys(RenderQueue)).toHaveLength(5);
  });
});

describe('PassSelector - type-level smoke tests (w8)', () => {
  it('type-level: empty selector passes (Record<string, string[]>)', () => {
    const ps: PassSelector = {};
    expectTypeOf(ps).toMatchTypeOf<PassSelector>();
  });

  it('type-level: LightMode selector with string values passes', () => {
    const ps: PassSelector = { LightMode: ['Forward', 'ShadowCaster'] };
    expectTypeOf(ps).toMatchTypeOf<PassSelector>();
  });

  it('type-level: number values in selector should fail (negative test)', () => {
    // @ts-expect-error - PassSelector values must be string[], not number[]
    const _ps: PassSelector = { LightMode: [123] };
    void _ps;
  });
});
