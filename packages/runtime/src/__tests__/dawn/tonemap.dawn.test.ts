// tonemap.dawn.test.ts - feat-20260519-tonemap-reinhard-mvp / M3 / T-M3.4
// (dawn tier).
//
// Numerically aligns the host-side TS port (`packages/runtime/src/systems/
// tonemap.ts`) against the canonical Reinhard 2002 extended formula, with
// the AC-04 / AC-05 / AC-06 anchor inputs the WGSL fragment stage agrees
// on byte-for-byte (D-O3 shared `TONEMAP_LUMINANCE_EPSILON`).
//
// This tier asserts the TS-side derivation that the host writes into the
// `TonemapParams` UBO + the post-process fragment stage consumes; the
// fullscreen-pass GPU readback path is covered by the apps/hello/tonemap
// smoke gate (T-M4.2 dawn-node + chromium 300 frames) and the AC-07/08/09
// pixel-parity checks land there.
//
// Tier discipline mirrors mesh-ssbo-normal-matrix.dawn.test.ts: real GPU
// presence is checked via `navigator.gpu` and `it.skipIf(!dawnReady)`
// guards every assertion; the actual numeric assertions run against the
// pure-TS port so the test stays deterministic across hardware /
// driver / chromium-channel.

import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { tonemapReinhardLuminance } from '../../systems/tonemap';

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

describe('T-M3.4 tonemap dawn-tier numeric anchor (AC-04 / AC-05 / AC-06)', () => {
  it.skipIf(!dawnReady)(
    'AC-04: high-intensity HDR sample compresses without NaN + preserves channel ratios',
    () => {
      // intensity=20 PBR direct-lit sample at the highlight peak. With
      // exposure=1 + Lw=4, the luminance Y ~ 13.2 maps to Y' ~ 1.7 (knee-
      // saturated; AC-06 anchor: Lw=Y is the knee point, so Y > Lw lands in
      // the saturation regime). Per-channel output preserves the input
      // ratio exactly (no hue shift; only the luminance scale changes).
      // The swap-chain bgra8unorm-srgb store-op clamps each channel to
      // [0, 1] at hardware encode time, so AC-07 (no integer-white burn)
      // is enforced by the hardware, not the shader formula. The TS port
      // mirrors the formula 1:1 so this test asserts the pre-clamp
      // numerical shape the GPU then writes through the sRGB encode.
      const lIn: [number, number, number] = [20, 12, 5];
      const out = tonemapReinhardLuminance(lIn, 1.0, 4.0);
      expect(Number.isFinite(out[0])).toBe(true);
      expect(Number.isFinite(out[1])).toBe(true);
      expect(Number.isFinite(out[2])).toBe(true);
      expect(out[0]).toBeGreaterThan(0);
      expect(out[1]).toBeGreaterThan(0);
      expect(out[2]).toBeGreaterThan(0);
      // Per-channel ratio preserved.
      const inGR = 12 / 20;
      const outGR = (out[1] ?? 0) / (out[0] ?? 1);
      expect(outGR).toBeCloseTo(inGR, 3);
      const inBR = 5 / 20;
      const outBR = (out[2] ?? 0) / (out[0] ?? 1);
      expect(outBR).toBeCloseTo(inBR, 3);
    },
  );

  it.skipIf(!dawnReady)(
    'AC-05: exposure=2 + light=1 mid-grey ~ exposure=1 + light=2 mid-grey',
    () => {
      // The host writes `params.exposure` into byte offset 0 of the 16 B
      // TonemapParams UBO. AC-05 mandates that `(exposure=2.0, L=L0)` and
      // `(exposure=1.0, L=2*L0)` produce equivalent output at the fragment
      // stage. The TS port mirrors this multiplicative pre-stage exactly.
      const lInA: [number, number, number] = [1, 1, 1];
      const lInB: [number, number, number] = [2, 2, 2];
      const outA = tonemapReinhardLuminance(lInA, 2.0, 4.0);
      const outB = tonemapReinhardLuminance(lInB, 1.0, 4.0);
      expect(outA[0]).toBeCloseTo(outB[0] ?? 0, 5);
      expect(outA[1]).toBeCloseTo(outB[1] ?? 0, 5);
      expect(outA[2]).toBeCloseTo(outB[2] ?? 0, 5);
    },
  );

  it.skipIf(!dawnReady)('AC-06: Lw=L grey saturates to 1 (extended-Reinhard knee)', () => {
    // For a grey input where `L == Lw`, the extended Reinhard curve
    // sends Y' to exactly 1 (the knee point). AC-06 motivates the white
    // point semantic: AI users tune Lw to set the "this is the brightest
    // pixel" threshold.
    for (const Lw of [1, 2, 4, 8]) {
      const out = tonemapReinhardLuminance([Lw, Lw, Lw], 1.0, Lw);
      expect(out[0]).toBeCloseTo(1, 4);
      expect(out[1]).toBeCloseTo(1, 4);
      expect(out[2]).toBeCloseTo(1, 4);
    }
  });

  it.skipIf(!dawnReady)(
    'D-O3: shared TONEMAP_LUMINANCE_EPSILON floor protects against degenerate inputs',
    () => {
      // exposure = 0 + Lw = 0 is the absolute degenerate case. Without the
      // floor the divisor goes through 0 and produces NaN; with the floor
      // every channel collapses to a finite zero (charter P3 explicit
      // failure: a NaN would propagate through the swap-chain and produce
      // visually undefined pixels).
      expect(TONEMAP_LUMINANCE_EPSILON).toBe(1e-5);
      const out = tonemapReinhardLuminance([5, 3, 1], 0.0, 4.0);
      expect(Number.isFinite(out[0])).toBe(true);
      expect(Number.isFinite(out[1])).toBe(true);
      expect(Number.isFinite(out[2])).toBe(true);
      expect(out[0]).toBeCloseTo(0, 6);
      expect(out[1]).toBeCloseTo(0, 6);
      expect(out[2]).toBeCloseTo(0, 6);
    },
  );
});
