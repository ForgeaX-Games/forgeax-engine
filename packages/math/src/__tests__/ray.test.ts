// ray.test.ts — ray unit tests (feat-20260617-host-engine-contract-and-video-cutscene M2)
//
// Coverage: worldToScreen behind / onScreen / normal three-state, y-down pixel mapping,
// finite-input / zero-canvas degenerate edges. 100% branch coverage target.
//
// worldToScreen TDD: this file is committed RED (worldToScreen not yet implemented in ray.ts);
// w5 implementation greens these tests.
//
// Related: requirements AC-01; plan-tasks.json w3 acceptanceCheck;
//          research Finding 3 (projectPoint discards w).

import { describe, expect, it } from 'vitest';
import * as mat4 from '../mat4';
import { worldToScreen } from '../ray';
import type { Mat4 } from '../types';
import * as vec2 from '../vec2';

// ============================================================
// Helpers
// ============================================================

/** Build a simple perspective view-projection: camera at origin, looking at -z. */
function makeViewProj(
  out: Mat4,
  fovYRadians = Math.PI / 3,
  aspect = 800 / 600,
  near = 0.1,
  far = 100,
): Mat4 {
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const proj = mat4.perspective(mat4.create(), fovYRadians, aspect, near, far);
  return mat4.multiply(out, proj, view);
}

// ============================================================
// Three-state tests: behind / onScreen / normal
// ============================================================

describe('ray.worldToScreen — three-state', () => {
  it('behind: point behind camera (w<0) → behind=true, onScreen ignored', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, 5], VP, 800, 600);

    expect(result.behind).toBe(true);
    // behind=true → onScreen is meaningless (requirements §7: out is undefined)
  });

  it('onScreen=false: point in front but outside frustum → onScreen=false, behind=false', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create();
    // (10, 0, -5): in front of camera (z=-5) but far outside the NDC x bound
    const result = worldToScreen(out, [10, 0, -5], VP, 800, 600);

    expect(result.behind).toBe(false);
    expect(result.onScreen).toBe(false);
    // onScreen=false → out is still valid pixel for screen-edge clamping (requirements §7)
    expect(out[0]).toBeGreaterThan(800); // x maps past the right edge
    expect(out[1]).toBeCloseTo(300, -1); // y should be roughly centre
  });

  it('normal: point inside frustum → onScreen=true, behind=false, pixel is correct', () => {
    const VP = mat4.create();
    makeViewProj(VP, Math.PI / 3, 800 / 600, 0.1, 100);

    const out = vec2.create();
    // (0, 0, -5): directly in front of camera along -z axis
    const result = worldToScreen(out, [0, 0, -5], VP, 800, 600);

    expect(result.behind).toBe(false);
    expect(result.onScreen).toBe(true);
    // Centre of screen: (400, 300) for 800×600 canvas
    expect(out[0]).toBeCloseTo(400, -1);
    expect(out[1]).toBeCloseTo(300, -1);
  });
});

// ============================================================
// y-down pixel mapping
// ============================================================

describe('ray.worldToScreen — y-down pixel mapping', () => {
  it('maps NDC top (-y) to small pixel y, NDC bottom (+y) to large pixel y', () => {
    const VP = mat4.create();
    makeViewProj(VP, Math.PI / 3, 800 / 600, 0.1, 100);

    // Point above camera: y=2, z=-5. In view space, y>0 means above centre.
    // In NDC with perspective, y>0 maps to positive NDC, which with y-down
    // pixel mapping means smaller pixel y (near top of canvas).
    const top = vec2.create();
    const bottom = vec2.create();

    worldToScreen(top, [0, 2, -5], VP, 800, 600);
    worldToScreen(bottom, [0, -2, -5], VP, 800, 600);

    // y-down: top of screen = small pixel y, bottom = large pixel y
    // point at +y in view space → top of screen → smaller pixel y
    expect(top[1] as number).toBeLessThan(bottom[1] as number);
  });

  it('pixel x grows rightward (left NDC → small x, right NDC → large x)', () => {
    const VP = mat4.create();
    makeViewProj(VP, Math.PI / 3, 800 / 600, 0.1, 100);

    const left = vec2.create();
    const right = vec2.create();

    worldToScreen(left, [-2, 0, -5], VP, 800, 600);
    worldToScreen(right, [2, 0, -5], VP, 800, 600);

    // left side maps to smaller pixel x
    expect(left[0] as number).toBeLessThan(right[0] as number);
  });
});

// ============================================================
// Degenerate edges
// ============================================================

describe('ray.worldToScreen — degenerate edges', () => {
  it('zero canvas width → onScreen=false (degenerate viewport)', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create();
    // Canvas width=0 is a degenerate viewport (detached/display:none)
    const result = worldToScreen(out, [0, 0, -5], VP, 0, 600);

    expect(result.onScreen).toBe(false);
  });

  it('zero canvas height → onScreen=false (degenerate viewport)', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, -5], VP, 800, 0);

    expect(result.onScreen).toBe(false);
  });

  it('zero canvas both → onScreen=false, behind=false, out unchanged from input', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create(-99, -99);
    const result = worldToScreen(out, [0, 0, -5], VP, 0, 0);

    expect(result.behind).toBe(false);
    expect(result.onScreen).toBe(false);
    // out should not be mutated when canvas is degenerate
    expect(out[0]).toBe(-99);
    expect(out[1]).toBe(-99);
  });

  it('negative canvas width → onScreen=false', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, -5], VP, -1, 600);

    expect(result.onScreen).toBe(false);
  });

  it('negative canvas height → onScreen=false', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, -5], VP, 800, -1);

    expect(result.onScreen).toBe(false);
  });
});

// ============================================================
// Multiple viewProj configs (parametric correctness)
// ============================================================

describe('ray.worldToScreen — multiple viewProj', () => {
  it('different camera pose: camera at (0,5,10) looking at (0,0,0) → origin maps to centre', () => {
    const view = mat4.lookAt(mat4.create(), [0, 5, 10], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 800 / 600, 0.1, 100);
    const VP = mat4.create();
    mat4.multiply(VP, proj, view);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, 0], VP, 800, 600);

    expect(result.behind).toBe(false);
    expect(result.onScreen).toBe(true);
    // World origin is at the centre of the view for a camera looking at it
  });

  it('wide aspect ratio (2:1) pixel mapping', () => {
    const VP = mat4.create();
    makeViewProj(VP, Math.PI / 3, 2, 0.1, 100);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, -5], VP, 1200, 600);

    expect(result.behind).toBe(false);
    expect(result.onScreen).toBe(true);
    // Centre of 1200×600 canvas
    expect(out[0]).toBeCloseTo(600, -1);
    expect(out[1]).toBeCloseTo(300, -1);
  });

  it('narrow near/far clip: point at z=-99 is still inside frustum', () => {
    const VP = mat4.create();
    makeViewProj(VP, Math.PI / 3, 800 / 600, 0.1, 100);

    const out = vec2.create();
    // z=-99: almost at far plane, still in frustum
    const result = worldToScreen(out, [0, 0, -99], VP, 800, 600);

    expect(result.behind).toBe(false);
    // near far plane → NDC z ≈ 1 (still in [0,1])
    expect(result.onScreen).toBe(true);
  });

  it('point at z=-0.05 (between camera and near plane) → behind=false, onScreen=false', () => {
    const VP = mat4.create();
    makeViewProj(VP, Math.PI / 3, 800 / 600, 0.1, 100);

    const out = vec2.create();
    // z=-0.05: between camera and near plane — in front (w>0) but outside frustum
    const result = worldToScreen(out, [0, 0, -0.05], VP, 800, 600);

    expect(result.behind).toBe(false);
    // NDC z will be outside [0,1] because the point is closer than near plane
    expect(result.onScreen).toBe(false);
  });

  it('point exactly on near plane (z=-0.1) → onScreen=true', () => {
    const VP = mat4.create();
    makeViewProj(VP, Math.PI / 3, 800 / 600, 0.1, 100);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, -0.1], VP, 800, 600);

    expect(result.behind).toBe(false);
    expect(result.onScreen).toBe(true);
    // Near plane → NDC z=0 (WebGPU convention)
  });
});

// ============================================================
// WorldToScreenResult type test (compile-time only)
// ============================================================

describe('ray.worldToScreen — return type', () => {
  it('returns plain {onScreen, behind} object (no allocation, no Result/ErrorCode)', () => {
    const VP = mat4.create();
    makeViewProj(VP);

    const out = vec2.create();
    const result = worldToScreen(out, [0, 0, -5], VP, 800, 600);

    expect(typeof result.onScreen).toBe('boolean');
    expect(typeof result.behind).toBe('boolean');
    // Verify no extra keys
    expect(Object.keys(result).sort()).toEqual(['behind', 'onScreen']);
  });
});

void expect;
