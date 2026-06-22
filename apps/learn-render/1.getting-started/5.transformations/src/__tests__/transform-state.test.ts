// transform-state.test.ts -- vitest unit test (T-M3-1 red phase).
//
// AC-01 (requirements §4): the LO §1.5 demo's per-frame system writes
// `Transform` SoA columns whose VALUES reproduce the LO §1.5 teaching
// constants (translate(0.5,-0.5,0) + rotate(time, Z) + sin-pulse scale).
// The test asserts these field values by mocking elapsed time t = 1.5s
// and reading the field outputs of the pure helper `computeTransformAt`
// that the demo module exposes (the same helper the system fn body
// calls each frame -- charter F1 single-grep + P5 producer / consumer
// split: pure helper here is independently testable, the system fn
// keeps the world / query plumbing).
//
// Charter P5: this test does NOT bootstrap a renderer / canvas / WebGPU.
// It exercises only the field-level math of the LO §1.5 mapping; pixel
// concerns live in transformations.browser.test.ts (T-M3-2).

import { describe, expect, it } from 'vitest';

import { computeTransformAt } from '../transform-animation';

describe('5.transformations Transform field values reproduce LO §1.5 teaching constants (AC-01)', () => {
  it('computeTransformAt(1.5) produces translate(0.5, -0.5, 0) + rotate(t, Z) + sin-pulse scale', () => {
    const out = computeTransformAt(1.5);

    // LO §1.5 verbatim: glm::translate(trans, glm::vec3(0.5f, -0.5f, 0.0f)).
    expect(out.posX).toBeCloseTo(0.5, 6);
    expect(out.posY).toBeCloseTo(-0.5, 6);
    expect(out.posZ).toBeCloseTo(0, 6);

    // LO §1.5 verbatim: glm::rotate(trans, time, glm::vec3(0,0,1)) -- the
    // Z-axis quaternion encoding (0, 0, sin(angle/2), cos(angle/2)). At
    // t = 1.5s the angle is non-zero -> quatZ (quaternion z component) is
    // non-zero. quatX / quatY stay 0 (single-axis Z rotation).
    expect(out.quatX).toBe(0);
    expect(out.quatY).toBe(0);
    expect(out.quatZ).not.toBe(0);
    expect(Math.abs(out.quatZ)).toBeLessThanOrEqual(1);

    // Sin-pulse scale (D-8 / OOS-8 carve-out): forgeax animates the
    // glm::scale(trans, glm::vec3(0.5)) static value into a sin envelope
    // 0.5 + 0.5 * sin(t * 2π / 3) so the visible frame proves the system
    // fn writes per tick. Range is [0, 1]; at t=1.5s the value is mid-
    // pulse.
    expect(out.scaleX).toBeGreaterThanOrEqual(0);
    expect(out.scaleX).toBeLessThanOrEqual(1);
    expect(out.scaleX).toBe(out.scaleY);
    expect(out.scaleX).toBe(out.scaleZ);
  });

  it('computeTransformAt(0) produces the spawn-time identity baseline (quatZ=0, scaleX in [0,1])', () => {
    const out = computeTransformAt(0);
    // Position is the LO §1.5 translate constant regardless of t.
    expect(out.posX).toBeCloseTo(0.5, 6);
    expect(out.posY).toBeCloseTo(-0.5, 6);
    // At t=0 the Z-axis rotation angle is 0 -> sin(0) = 0 quaternion z.
    expect(out.quatZ).toBe(0);
    expect(out.quatW).toBeCloseTo(1, 6);
    // Sin-pulse 0.5 + 0.5 * sin(0) = 0.5 baseline.
    expect(out.scaleX).toBeCloseTo(0.5, 6);
    expect(out.scaleX).toBe(out.scaleY);
    expect(out.scaleX).toBe(out.scaleZ);
  });
});
