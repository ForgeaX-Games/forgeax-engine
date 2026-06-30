// shadow-m3-calibrate.ts - feat-20260520-directional-light-shadow-mapping
// M3 / w15: AC-13 threshold calibration helper.
//
// This module is NOT a test file (no .test.ts suffix) — vitest will not
// auto-discover it. It exports a `calibrateThresholdX` function that measures
// shadow factor diffs between M2 (naive) and M3 (bias+PCF) on a common fixture
// and prints the suggested AC_13_THRESHOLD_X.
//
// Workflow (plan-strategy D-4):
//   Step 1 (w15 RED):  write this helper + shadow-m3.dawn.test.ts with
//                      placeholder X=0.05. Calibration returns trivial diffs
//                      (M2==M2 before w16). AC-13 stays RED.
//   Step 2 (w16 impl): implement pbr.wgsl bias+PCF. Compile + build.
//   Step 3 (w16 calibrate): run this helper via the calibration runner
//                           shadow-m3-calibrate-run.dawn.test.ts. Collect
//                           max(diff) and suggested X.
//   Step 4 (w16 freeze):   edit shadow-m3.dawn.test.ts to set AC_13_THRESHOLD_X
//                           to the calibrated value. Commit. AC-13 turns GREEN.
//
// The helper samples N >= 10 acne-prone ground-plane positions where M2 shows
// spurious sub-1 shadow factors (acne artifact). It reads shadow factors
// pre-change (current shader = M2 baseline) and post-change (after M3
// bias+PCF is deployed). The suggested X = floor(max(diff) * 0.5 * 100) / 100
// with a floor of 0.02 to avoid vanishing thresholds that invite flakiness.

import type { Renderer } from '@forgeax/engine-runtime';

/**
 * Shadow factor sample returned by debugSampleShadowFactor.
 * Matches the return type shape from Renderer.debugSampleShadowFactor.
 */
export interface ShadowFactorSample {
  readonly shadowFactor: number;
}

/**
 * Calibration result: per-sample M2/M3 factors + derived threshold.
 */
export interface CalibrationResult {
  /** Per-sample data ordered by the input positions array. */
  samples: CalibrationSample[];
  /** Maximum |m2Factor - m3Factor| across all samples. */
  maxDiff: number;
  /** Suggested AC_13_THRESHOLD_X = max(floor(maxDiff * 0.5 * 100) / 100, 0.02). */
  suggestedX: number;
  /** Sample count. */
  sampleCount: number;
}

export interface CalibrationSample {
  position: readonly [number, number, number];
  m2Factor: number;
  m3Factor: number;
  diff: number;
}

/**
 * Fixed acne probe positions for calibration.
 *
 * All positions lie on the ground plane (y=0) in the -X lit region where M2
 * naive depth comparison produces spurious sub-1 shadow factors due to
 * surface self-shadowing. The cube occluder at (0, 1.3, 0) + light tilting +X
 * means the -X region should be fully lit.
 *
 * SSOT: must stay in sync with shadow-m3.dawn.test.ts acne sample constants.
 */
export const CALIBRATION_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [-4, 0, 0],
  [-3, 0, 2],
  [-4, 0, -2],
  [-2.5, 0, -1],
  [-3.5, 0, 1],
  [-2, 0, -2.5],
  [-4.5, 0, -0.5],
  [-1.5, 0, 2.5],
  [-3, 0, -1.5],
  [-5, 0, 0.5],
  // Extra round to 12 — more samples reduce threshold noise.
  [-4.2, 0, 1.2],
  [-3.8, 0, -0.8],
];

/**
 * Read M2 shadow factors from the renderer (GPU probe, pre-bias/pre-PCF).
 *
 * In the RED phase (before w16), this is the same as M3 — so diffs are zero.
 * After w16 lands (bias+PCF in pbr.wgsl), the renderer reflects the new
 * shader and m2Factors become a historical baseline from the pre-M3 commit.
 *
 * For a single-session implementer, the calibration workflow is:
 *   1. Record M2 factors with the current (naive) shader
 *   2. Apply w16 (pbr.wgsl bias+PCF)
 *   3. Rebuild, re-measure M3 factors
 *   4. Call `computeThresholdX(m2Factors, m3Factors)` on the stored values
 *
 * This function measures the **current** shadow factors via debugSampleShadowFactor.
 */
export async function measureShadowFactors(
  renderer: Renderer,
  positions: ReadonlyArray<readonly [number, number, number]>,
): Promise<number[]> {
  const results = await renderer.debugSampleShadowFactor?.(positions);
  if (!results) throw new Error('debugSampleShadowFactor returned null');
  return results.map((r) => r.shadowFactor);
}

/**
 * Compute the suggested AC-13 threshold X from measured M2 and M3 shadow factors.
 *
 * X = max(floor(max(|m2 - m3|) * 0.5 * 100) / 100, 0.02)
 *
 * The 0.5 multiplier gives headroom (roughly half the maximum observed
 * improvement); the floor at 0.02 prevents vanishing thresholds that would
 * make AC-13 flaky at machine-boundary epsilon.
 */
export function computeThresholdX(
  m2Factors: readonly number[],
  m3Factors: readonly number[],
): { maxDiff: number; suggestedX: number } {
  let maxDiff = 0;
  for (let i = 0; i < m2Factors.length && i < m3Factors.length; i++) {
    const diff = Math.abs((m2Factors[i] as number) - (m3Factors[i] as number));
    if (diff > maxDiff) maxDiff = diff;
  }
  const rawX = Math.floor(maxDiff * 0.5 * 100) / 100;
  const suggestedX = Math.max(rawX, 0.02);
  return { maxDiff, suggestedX };
}

/**
 * Full calibration: reads M2 + M3 shadow factors from the same renderer and
 * computes the suggested threshold.
 *
 * `measureM2`: function returning M2 factors (pre-bias/PCF baseline).
 * `measureM3`: function returning M3 factors (post-bias/PCF with current shader).
 *
 * In a single-session workflow these two calls happen on the same renderer but
 * at different points in time (pre-w16 commit vs post-w16 build).
 */
export async function calibrateThresholdX(
  positions: ReadonlyArray<readonly [number, number, number]>,
  measureM2: () => Promise<number[]>,
  measureM3: () => Promise<number[]>,
): Promise<CalibrationResult> {
  const m2Factors = await measureM2();
  const m3Factors = await measureM3();

  const { maxDiff, suggestedX } = computeThresholdX(m2Factors, m3Factors);

  const samples: CalibrationSample[] = [];
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (!pos) continue;
    const m2 = m2Factors[i] as number;
    const m3 = m3Factors[i] as number;
    samples.push({
      position: pos,
      m2Factor: m2,
      m3Factor: m3,
      diff: Math.abs(m2 - m3),
    });
  }

  return {
    samples,
    maxDiff,
    suggestedX,
    sampleCount: samples.length,
  };
}

/**
 * Pretty-print calibration result to stdout for implementer consumption.
 */
export function printCalibrationReport(result: CalibrationResult): void {
  console.warn('═══════════════════════════════════════════════════════════');
  console.warn('  M3 AC-13 threshold calibration report');
  console.warn('═══════════════════════════════════════════════════════════');
  console.warn(`  Sample count : ${result.sampleCount}`);
  console.warn('  Sample |' + ' position          | M2 factor | M3 factor | diff');
  console.warn('  -------|-------------------|-----------|-----------|--------');
  for (let i = 0; i < result.samples.length; i++) {
    const s = result.samples[i];
    if (!s) continue;
    const posStr = `(${s.position[0].toFixed(1)}, ${s.position[1].toFixed(1)}, ${s.position[2].toFixed(1)})`;
    console.warn(
      `  ${String(i).padStart(6)} | ${posStr.padEnd(17)} |` +
        ` ${s.m2Factor.toFixed(4).padStart(9)} |` +
        ` ${s.m3Factor.toFixed(4).padStart(9)} |` +
        ` ${s.diff.toFixed(4).padStart(6)}`,
    );
  }
  console.warn('  -------|-------------------|-----------|-----------|--------');
  console.warn(`  max(diff)            = ${result.maxDiff.toFixed(4)}`);
  console.warn(`  suggested X          = ${result.suggestedX.toFixed(2)}`);
  console.warn('  (X = max(floor(maxDiff * 0.5 * 100) / 100, 0.02))');
  console.warn('');
  console.warn(
    '  Next step: set AC_13_THRESHOLD_X =' +
      ` ${result.suggestedX.toFixed(2)} in shadow-m3.dawn.test.ts`,
  );
  console.warn('═══════════════════════════════════════════════════════════');
}
