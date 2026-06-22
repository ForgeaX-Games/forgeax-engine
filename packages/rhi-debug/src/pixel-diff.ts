// @forgeax/engine-rhi-debug/src/pixel-diff — epsilon helper for cross-device
// pixel readback comparison (AC-14).
//
// Formula locked per plan-strategy §5.3.1:
//   pixelDeltaAbsMean = mean over (pixels × 4 RGBA channels) of |orig[i] - replay[i]| / 255
//
// Preconditions: orig.length === replay.length && % 4 === 0.
// Violation throws DebugError with code='replay-deterministic-violation'.
//
// Related: plan-strategy §5.3.1; m5b-2 / m5b-3 / m5b-4.

import { DebugError } from './errors';

/**
 * Compute the mean absolute per-channel pixel delta between two RGBA8
 * pixel buffers.
 *
 * Formula: `mean over (all i) of |orig[i] - replay[i]| / 255`.
 *
 * Returns a number in [0..1] where:
 * - 0 = identical (orig === replay, strict zero)
 * - 1 = maximum difference (all channels flipped 0 ↔ 255)
 *
 * @param orig - Baseline pixel buffer (RGBA8, tight-packed).
 * @param replay - Replay pixel buffer (RGBA8, tight-packed).
 * @param opts - Options (currently only `channels` to verify alignment).
 * @returns The mean absolute delta, a number in [0, 1].
 * @throws DebugError with code='replay-deterministic-violation' on length mismatch.
 */
export function pixelDeltaAbsMean(
  orig: Uint8Array,
  replay: Uint8Array,
  opts?: { channels?: 4 },
): number {
  const channels = opts?.channels ?? 4;

  // Precondition: equal length
  if (orig.length !== replay.length) {
    throw new DebugError({
      code: 'replay-deterministic-violation',
      expected: 'orig and replay pixel buffers must have identical length',
      hint: `pixel buffer length mismatch: orig=${orig.length}, replay=${replay.length}`,
      detail: {
        actualDelta: 1,
        expectedDelta: 0.01,
        drawIdx: undefined,
      },
    });
  }

  // Precondition: length must be a multiple of channels
  if (orig.length % channels !== 0) {
    throw new DebugError({
      code: 'replay-deterministic-violation',
      expected: `pixel buffer length must be a multiple of ${channels}`,
      hint: `pixel buffer length ${orig.length} is not a multiple of ${channels} (RGBA)`,
      detail: {
        actualDelta: 1,
        expectedDelta: 0.01,
        drawIdx: undefined,
      },
    });
  }

  // Identity short-circuit: if buffers are === reference-equal, return 0
  if (orig === replay) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < orig.length; i++) {
    const o = orig[i] ?? 0;
    const r = replay[i] ?? 0;
    sum += Math.abs(o - r);
  }

  const mean = sum / orig.length;
  return mean / 255;
}
