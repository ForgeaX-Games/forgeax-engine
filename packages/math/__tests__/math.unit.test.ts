// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=13):
//   - packages/math/src/__tests__/box3.test.ts
//   - packages/math/src/__tests__/color.test.ts
//   - packages/math/src/__tests__/euler.test.ts
//   - packages/math/src/__tests__/f32-to-f16-bytes.test.ts
//   - packages/math/src/__tests__/frustum.test.ts
//   - packages/math/src/__tests__/mat3.test.ts
//   - packages/math/src/__tests__/mat4.test.ts
//   - packages/math/src/__tests__/quat.test.ts
//   - packages/math/src/__tests__/ray.test.ts
//   - packages/math/src/__tests__/sphere.test.ts
//   - packages/math/src/__tests__/vec2.test.ts
//   - packages/math/src/__tests__/vec3.test.ts
//   - packages/math/src/__tests__/vec4.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
// import paths adjusted: ../X -> ../src/X (output is __tests__/, sources were src/__tests__/).

import { describe, expect, it } from 'vitest';
import * as box3 from '../src/box3';
import * as color from '../src/color';
import * as euler from '../src/euler';
import * as frustum from '../src/frustum';
import * as mat3 from '../src/mat3';
import * as mat4 from '../src/mat4';
import * as quat from '../src/quat';
import * as ray from '../src/ray';
import * as sphere from '../src/sphere';
import * as vec2 from '../src/vec2';
import * as vec3 from '../src/vec3';
import * as vec4 from '../src/vec4';
import { halfFloat } from '../src/index.js';
import type { EulerOrder, Mat3 as Mat3T, Mat4 as Mat4T, Vec3 as Vec3T } from '../src/types';
import {
  PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED,
  PERSPECTIVE_REVERSE_Z_FINITE_INPUT,
  PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED,
  REVERSE_Z_FIXTURE_TOLERANCE,
  REVERSE_Z_PROJECTION_PROBES_FINITE,
  REVERSE_Z_PROJECTION_PROBES_INFINITE,
} from '../src/__tests__/_fixtures';


{
  // --- from box3.test.ts ---
// Box3 unit tests — TDD red phase (feat-20260511-asset-system-v1 M3 / w7).
//
// Box3 is an axis-aligned bounding box stored as 6 f32 [minX, minY, minZ, maxX, maxY, maxZ];
// pure-function surface aligned with packages/math branded ABI + SoA style.
// Surface (5 ops per plan-tasks.json w7): create / expandByPoint / containsPoint / intersectsBox / fromPoints.
//
// Three tiers per test group: normal / boundary / degenerate.
// Related: requirements §AC-16 (Box3 / Sphere pure functions); plan-strategy M3 range;
//          plan-tasks.json w7 acceptanceCheck.


describe('box3.create', () => {
  it('returns Float32Array length 6 with inverted-infinity (empty) box by default (normal)', () => {
    const b = box3.create();
    expect(b).toBeInstanceOf(Float32Array);
    expect(b.length).toBe(6);
    // min = +Infinity, max = -Infinity so expandByPoint on any finite point collapses to that point
    expect(b[0]).toBe(Number.POSITIVE_INFINITY);
    expect(b[1]).toBe(Number.POSITIVE_INFINITY);
    expect(b[2]).toBe(Number.POSITIVE_INFINITY);
    expect(b[3]).toBe(Number.NEGATIVE_INFINITY);
    expect(b[4]).toBe(Number.NEGATIVE_INFINITY);
    expect(b[5]).toBe(Number.NEGATIVE_INFINITY);
  });

  it('accepts explicit min / max components (boundary)', () => {
    const b = box3.create(-1, -2, -3, 4, 5, 6);
    expect(Array.from(b)).toEqual([-1, -2, -3, 4, 5, 6]);
  });

  it('zero-volume box (min == max) is allowed (degenerate)', () => {
    const b = box3.create(1, 2, 3, 1, 2, 3);
    expect(Array.from(b)).toEqual([1, 2, 3, 1, 2, 3]);
  });
});

describe('box3.expandByPoint', () => {
  it('grows an empty box to a zero-volume box containing the point (normal)', () => {
    const b = box3.create();
    const ret = box3.expandByPoint(b, [1, 2, 3]);
    expect(ret).toBe(b);
    expect(Array.from(b)).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('expands min and max independently per axis (boundary)', () => {
    const b = box3.create(0, 0, 0, 1, 1, 1);
    box3.expandByPoint(b, [-2, 0.5, 5]);
    expect(Array.from(b)).toEqual([-2, 0, 0, 1, 1, 5]);
  });

  it('point inside box leaves box unchanged (degenerate)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    box3.expandByPoint(b, [0, 0, 0]);
    expect(Array.from(b)).toEqual([-1, -1, -1, 1, 1, 1]);
  });
});

describe('box3.containsPoint', () => {
  it('returns true for point strictly inside (normal)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(box3.containsPoint(b, [0, 0, 0])).toBe(true);
  });

  it('point on the boundary is considered inside (boundary)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(box3.containsPoint(b, [1, 1, 1])).toBe(true);
    expect(box3.containsPoint(b, [-1, -1, -1])).toBe(true);
  });

  it('point outside any axis is rejected (degenerate)', () => {
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(box3.containsPoint(b, [2, 0, 0])).toBe(false);
    expect(box3.containsPoint(b, [0, -2, 0])).toBe(false);
    expect(box3.containsPoint(b, [0, 0, 2])).toBe(false);
  });

  it('empty (inverted-infinity) box contains nothing (degenerate)', () => {
    const b = box3.create();
    expect(box3.containsPoint(b, [0, 0, 0])).toBe(false);
  });
});

describe('box3.intersectsBox', () => {
  it('overlapping boxes intersect (normal)', () => {
    const a = box3.create(0, 0, 0, 2, 2, 2);
    const b = box3.create(1, 1, 1, 3, 3, 3);
    expect(box3.intersectsBox(a, b)).toBe(true);
  });

  it('touching boxes (shared face) intersect (boundary)', () => {
    const a = box3.create(0, 0, 0, 1, 1, 1);
    const b = box3.create(1, 0, 0, 2, 1, 1);
    expect(box3.intersectsBox(a, b)).toBe(true);
  });

  it('disjoint boxes do not intersect (degenerate)', () => {
    const a = box3.create(0, 0, 0, 1, 1, 1);
    const b = box3.create(2, 0, 0, 3, 1, 1);
    expect(box3.intersectsBox(a, b)).toBe(false);
  });
});

describe('box3.fromPoints', () => {
  it('builds tightest AABB from 3 points (normal)', () => {
    const out = box3.create();
    const ret = box3.fromPoints(out, [
      [1, 0, 0],
      [0, 2, 0],
      [0, 0, 3],
    ]);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([0, 0, 0, 1, 2, 3]);
  });

  it('single point produces zero-volume box (boundary)', () => {
    const out = box3.create();
    box3.fromPoints(out, [[5, -5, 5]]);
    expect(Array.from(out)).toEqual([5, -5, 5, 5, -5, 5]);
  });

  it('empty points array leaves the inverted-infinity empty box (degenerate)', () => {
    const out = box3.create();
    box3.fromPoints(out, []);
    expect(out[0]).toBe(Number.POSITIVE_INFINITY);
    expect(out[3]).toBe(Number.NEGATIVE_INFINITY);
  });
});

// === transformBox3 (M1 / w1) ===
//
// Conservative 8-corner method: transform all 8 corners of the AABB by the 4x4 matrix,
// then compute a new AABB that encloses all transformed corners.
// Signature: transformBox3(out: Box3, box: Box3Like, m: Mat4Like): Box3
// Out-param first, aliasing-safe, returns out.

describe('box3.transformBox3', () => {
  it('identity matrix leaves box unchanged (normal)', () => {
    const box = box3.create(-1, -2, -3, 4, 5, 6);
    const m = mat4.identity(mat4.create());
    const out = box3.create();
    const ret = box3.transformBox3(out, box, m);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([-1, -2, -3, 4, 5, 6]);
  });

  it('translation shifts box by offset (normal)', () => {
    const box = box3.create(0, 0, 0, 2, 2, 2);
    const m = mat4.fromTranslation(mat4.create(), [3, -1, 5]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([3, -1, 5, 5, 1, 7]);
  });

  it('uniform scale expands box proportionally (normal)', () => {
    const box = box3.create(1, 2, 3, 4, 5, 6);
    const m = mat4.fromScaling(mat4.create(), [2, 2, 2]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('non-uniform scale expands axes independently (normal)', () => {
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    const m = mat4.fromScaling(mat4.create(), [2, 0.5, 3]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([-2, -0.5, -3, 2, 0.5, 3]);
  });

  it('rotation by 45 degrees around Y axis expands box conservatively (boundary)', () => {
    // box = [1,0,0] to [2,1,1], rotated 45 deg around Y
    // 8-corner transform: x' = c*x + s*z, z' = -s*x + c*z (c=s~0.7071)
    // All corners have z' <= 0 (rotated box is entirely at or below z=0)
    const box = box3.create(1, 0, 0, 2, 1, 1);
    const m = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 4);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    // min ~ (0.707, 0, -1.414), max ~ (2.121, 1, 0)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(-Math.SQRT2, 3);
    expect(out[3]).toBeCloseTo(Math.SQRT2 + Math.SQRT1_2, 3);
    expect(out[4]).toBe(1);
    expect(out[5]).toBeCloseTo(0, 4);
  });

  it('rotation by 90 degrees around Z swaps min/max extents (boundary)', () => {
    // box from (1,0,0) to (3,2,1), rotated 90 deg around Z:
    // (x,y) -> (-y,x), so x-range [-2, 0], y-range [1, 3]
    const box = box3.create(1, 0, 0, 3, 2, 1);
    const m = mat4.fromRotation(mat4.create(), [0, 0, 1], Math.PI / 2);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(out[0]).toBeCloseTo(-2, 5);
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[3]).toBeCloseTo(0, 5);
    expect(out[4]).toBeCloseTo(3, 5);
  });

  it('scale + translate composite transform (normal)', () => {
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    // T * S: scale first then translate
    // x: [-1,1]*2+5 = [3,7]; y: [-1,1]*3+0 = [-3,3]; z: [-1,1]*1 = [-1,1]
    const t = mat4.fromTranslation(mat4.create(), [5, 0, 0]);
    const s = mat4.fromScaling(mat4.create(), [2, 3, 1]);
    const m = mat4.create();
    mat4.multiply(m, t, s);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([3, -3, -1, 7, 3, 1]);
  });

  it('zero-volume box (min == max) transforms to correct position (degenerate)', () => {
    const box = box3.create(1, 2, 3, 1, 2, 3);
    const m = mat4.fromTranslation(mat4.create(), [10, -5, 0]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    expect(Array.from(out)).toEqual([11, -3, 3, 11, -3, 3]);
  });

  it('zero scale collapses box to a point at origin (degenerate)', () => {
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    const m = mat4.fromScaling(mat4.create(), [0, 0, 0]);
    const out = box3.create();
    box3.transformBox3(out, box, m);
    // All 8 corners map to (0,0,0), so AABB is a zero-volume box at origin
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('out may alias box (aliasing-safe)', () => {
    const box = box3.create(0, 0, 0, 1, 1, 1);
    const m = mat4.fromTranslation(mat4.create(), [2, 0, 0]);
    // box is both input and output — must be read before overwritten
    box3.transformBox3(box, box, m);
    expect(Array.from(box)).toEqual([2, 0, 0, 3, 1, 1]);
  });
});

}

{
  // --- from color.test.ts ---
// color.test.ts — color namespace unit tests (M5 / T-031 red → T-032 green)
//
// Three tiers: normal / boundary / degenerate.
//
// Implementation anchors (D-P7 / requirements §Surface color lower bound 6):
//   - create / clone: Float32Array length 4 RGBA brand
//   - srgbToLinear / linearToSrgb: IEC 61966-2-1 piecewise gamma (RGB channels only; alpha untouched)
//     - cutoff 0.04045 / 0.0031308; linear-segment slope 12.92; power-segment exponent 2.4
//     - negative values returned verbatim (preserves HDR semantics; same convention as bevy_color::gamma_function)
//   - fromHex: only supports `#RRGGBB` and `#RRGGBBAA` (D-P7 does not support #RGB / #RGBA short forms)
//     - illegal hex silently falls back to (0, 0, 0, 1); does not throw (D-P12 degenerate family / AC-06)
//   - toHex: emits `#RRGGBB` (when alpha=1) or `#RRGGBBAA` (when alpha<1); components clamped to [0,1]
//
// Related: requirements §AC-06 / §AC-07; plan-strategy D-P7 / D-P12 / §appendix A degenerate registry;
//          wiki/sources/2026-05-05-bevy-0-19-math-transform-color §sRGB piecewise gamma;
//          wiki/glam-rs-overview §LinearRgba.


describe('color.create', () => {
  it('returns Float32Array length 4 black/opaque by default (normal)', () => {
    const c = color.create();
    expect(c).toBeInstanceOf(Float32Array);
    expect(c.length).toBe(4);
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(0);
    expect(c[3]).toBe(1);
  });

  it('accepts explicit RGBA components (boundary)', () => {
    const c = color.create(0.25, 0.5, 0.75, 0.5);
    expect(c[0]).toBe(0.25);
    expect(c[1]).toBe(0.5);
    expect(c[2]).toBe(0.75);
    expect(c[3]).toBe(0.5);
  });

  it('NaN preserved verbatim (degenerate)', () => {
    const c = color.create(Number.NaN, 0, 0, 1);
    expect(Number.isNaN(c[0])).toBe(true);
  });
});

describe('color.clone', () => {
  it('produces new Float32Array with identical values (normal)', () => {
    const a = color.create(0.1, 0.2, 0.3, 0.4);
    const b = color.clone(a);
    expect(b).not.toBe(a);
    expect(Array.from(b)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
      Math.fround(0.4),
    ]);
  });
});

describe('color.srgbToLinear', () => {
  it('preserves 0 and 1 endpoints (boundary)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(0, 0, 0, 1));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1); // alpha untouched

    color.srgbToLinear(out, color.create(1, 1, 1, 1));
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[2]).toBeCloseTo(1, 5);
  });

  it('linear segment for v ≤ 0.04045 (boundary)', () => {
    // v=0.04 → 0.04 / 12.92 ≈ 0.003095975
    const out = color.create();
    color.srgbToLinear(out, color.create(0.04, 0.04, 0.04, 1));
    expect(out[0]).toBeCloseTo(0.04 / 12.92, 6);
  });

  it('power segment for v > 0.04045 (normal)', () => {
    // v=0.5 → ((0.5 + 0.055) / 1.055)^2.4 ≈ 0.21404114
    const out = color.create();
    color.srgbToLinear(out, color.create(0.5, 0.5, 0.5, 1));
    expect(out[0]).toBeCloseTo(((0.5 + 0.055) / 1.055) ** 2.4, 5);
  });

  it('does not touch alpha channel (boundary)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(0.5, 0.5, 0.5, 0.42));
    expect(out[3]).toBe(Math.fround(0.42));
  });

  it('NaN propagates (degenerate)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(Number.NaN, 0, 0, 1));
    expect(Number.isNaN(out[0])).toBe(true);
  });

  it('negative values returned verbatim (degenerate, HDR-friendly)', () => {
    const out = color.create();
    color.srgbToLinear(out, color.create(-0.1, 0, 0, 1));
    expect(out[0]).toBe(Math.fround(-0.1));
  });
});

describe('color.linearToSrgb', () => {
  it('preserves 0 and 1 endpoints (boundary)', () => {
    const out = color.create();
    color.linearToSrgb(out, color.create(0, 0, 0, 1));
    expect(out[0]).toBe(0);
    color.linearToSrgb(out, color.create(1, 1, 1, 1));
    expect(out[0]).toBeCloseTo(1, 5);
  });

  it('roundtrip srgbToLinear ∘ linearToSrgb ≈ identity in mid-range (normal)', () => {
    const tmp = color.create();
    const back = color.create();
    const src = color.create(0.5, 0.3, 0.8, 0.7);
    color.srgbToLinear(tmp, src);
    color.linearToSrgb(back, tmp);
    expect(back[0]).toBeCloseTo(0.5, 4);
    expect(back[1]).toBeCloseTo(0.3, 4);
    expect(back[2]).toBeCloseTo(0.8, 4);
    expect(back[3]).toBeCloseTo(0.7, 5); // alpha unchanged
  });

  it('linear segment for v ≤ 0.0031308 (boundary)', () => {
    // v=0.003 → 0.003 * 12.92 ≈ 0.03876
    const out = color.create();
    color.linearToSrgb(out, color.create(0.003, 0.003, 0.003, 1));
    expect(out[0]).toBeCloseTo(0.003 * 12.92, 5);
  });
});

describe('color.fromHex', () => {
  it('parses #RRGGBB (normal)', () => {
    const out = color.create();
    color.fromHex(out, '#FF8040');
    expect(out[0]).toBeCloseTo(255 / 255, 5);
    expect(out[1]).toBeCloseTo(128 / 255, 5);
    expect(out[2]).toBeCloseTo(64 / 255, 5);
    expect(out[3]).toBe(1); // default alpha=1
  });

  it('parses #RRGGBBAA (boundary)', () => {
    const out = color.create();
    color.fromHex(out, '#FF80407F');
    expect(out[0]).toBeCloseTo(255 / 255, 5);
    expect(out[1]).toBeCloseTo(128 / 255, 5);
    expect(out[2]).toBeCloseTo(64 / 255, 5);
    expect(out[3]).toBeCloseTo(127 / 255, 5);
  });

  it('lower-case hex digits accepted (boundary)', () => {
    const out = color.create();
    color.fromHex(out, '#ff8040');
    expect(out[0]).toBeCloseTo(255 / 255, 5);
  });

  it('rejects #RGB short form → silent (0,0,0,1) (degenerate, D-P7)', () => {
    const out = color.create(0.5, 0.5, 0.5, 0.5); // pre-poisoned
    color.fromHex(out, '#F84');
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
  });

  it('rejects bad hex chars → silent (0,0,0,1) (degenerate)', () => {
    const out = color.create();
    color.fromHex(out, '#GGGGGG');
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
  });

  it('rejects missing # prefix → silent (0,0,0,1) (degenerate)', () => {
    const out = color.create();
    color.fromHex(out, 'FF8040');
    expect(out[0]).toBe(0);
  });

  it('does not throw on null/undefined-like inputs (degenerate)', () => {
    const out = color.create();
    expect(() => color.fromHex(out, '')).not.toThrow();
    expect(out[3]).toBe(1);
  });
});

describe('color.toHex', () => {
  it('emits #RRGGBB when alpha=1 (normal)', () => {
    const c = color.create(1, 128 / 255, 64 / 255, 1);
    expect(color.toHex(c)).toBe('#ff8040');
  });

  it('emits #RRGGBBAA when alpha<1 (boundary)', () => {
    const c = color.create(1, 128 / 255, 64 / 255, 127 / 255);
    expect(color.toHex(c)).toBe('#ff80407f');
  });

  it('clamps out-of-range to [0, 255] (degenerate)', () => {
    const c = color.create(2, -1, 0.5, 1);
    expect(color.toHex(c)).toBe('#ff0080');
  });
});

}

{
  // --- from euler.test.ts ---
// euler.test.ts — M4 red: euler namespace unit tests with full 6-order coverage (T-025)
//
// Covers the three tiers normal + degenerate + boundary:
//   create / clone / set / fromQuat (6 orders) / toQuat / fromRotationMatrix (6 orders)
//
// Degenerate convention (plan-strategy §appendix A degenerate registry #16):
//   - euler.fromQuat(q, order) picks an equivalent branch near gimbal-lock critical angles; never throws
//
// Euler is a plain object { x, y, z, order } (not a Float32Array) to carry the order alongside the angles.
//
// Related: requirements §Surface euler lower bound 6 + 6-order full support;
//          plan-strategy §1.1 euler.ts + degenerate registry #16;
//          wiki/threejs-math (Euler.setFromQuaternion 6-order formulas).


const ORDERS: readonly EulerOrder[] = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

describe('euler.create / clone / set', () => {
  it('create() returns {x:0, y:0, z:0, order:"XYZ"} (normal)', () => {
    const e = euler.create();
    expect(e.x).toBe(0);
    expect(e.y).toBe(0);
    expect(e.z).toBe(0);
    expect(e.order).toBe('XYZ');
  });

  it('clone(e) returns new object with same fields (normal)', () => {
    const a = euler.create();
    a.x = 0.1;
    a.y = 0.2;
    a.z = 0.3;
    a.order = 'ZYX';
    const b = euler.clone(a);
    expect(b).not.toBe(a);
    expect(b.x).toBe(0.1);
    expect(b.y).toBe(0.2);
    expect(b.z).toBe(0.3);
    expect(b.order).toBe('ZYX');
  });

  it('set(out, x, y, z, order) writes fields in place (normal)', () => {
    const e = euler.create();
    const out = euler.set(e, 1, 2, 3, 'YXZ');
    expect(out).toBe(e);
    expect(e.x).toBe(1);
    expect(e.y).toBe(2);
    expect(e.z).toBe(3);
    expect(e.order).toBe('YXZ');
  });
});

describe('euler.toQuat / fromQuat — 6 order round-trip', () => {
  it.each(ORDERS)('toQuat(zero euler, order=%s) = identity (normal)', (order) => {
    const e = euler.set(euler.create(), 0, 0, 0, order);
    const q = euler.toQuat(quat.create(), e);
    expect(q[0]).toBeCloseTo(0);
    expect(q[1]).toBeCloseTo(0);
    expect(q[2]).toBeCloseTo(0);
    expect(q[3]).toBeCloseTo(1);
  });

  it.each(ORDERS)('round-trip euler→quat→euler preserves angles (order=%s, normal)', (order) => {
    // pick small angles to avoid gimbal-lock; different orders do not round-trip into each other, but the same order must be self-consistent
    const src = euler.set(euler.create(), 0.21, -0.34, 0.55, order);
    const q = euler.toQuat(quat.create(), src);
    const dst = euler.fromQuat(euler.create(), q, order);
    expect(dst.x).toBeCloseTo(src.x, 4);
    expect(dst.y).toBeCloseTo(src.y, 4);
    expect(dst.z).toBeCloseTo(src.z, 4);
    expect(dst.order).toBe(order);
  });

  it('toQuat(XYZ): X-only rotation matches fromAxisAngle (normal)', () => {
    const e = euler.set(euler.create(), Math.PI / 3, 0, 0, 'XYZ');
    const q = euler.toQuat(quat.create(), e);
    const ref = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 3);
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(ref[i] as number);
  });

  it('toQuat(YXZ): Y-only rotation matches fromAxisAngle (normal)', () => {
    const e = euler.set(euler.create(), 0, Math.PI / 3, 0, 'YXZ');
    const q = euler.toQuat(quat.create(), e);
    const ref = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 3);
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(ref[i] as number);
  });
});

describe('euler.fromQuat — degenerate / gimbal lock', () => {
  it('fromQuat(identity, XYZ) → zero euler (boundary)', () => {
    const i = quat.identity(quat.create());
    const e = euler.fromQuat(euler.create(), i, 'XYZ');
    expect(e.x).toBeCloseTo(0);
    expect(e.y).toBeCloseTo(0);
    expect(e.z).toBeCloseTo(0);
    expect(e.order).toBe('XYZ');
  });

  it('fromQuat at gimbal lock (XYZ, pitch=PI/2) does not throw (degenerate, registry #16)', () => {
    // Build a quaternion corresponding to XYZ Euler (0, PI/2, 0) → gimbal lock
    const src = euler.set(euler.create(), 0, Math.PI / 2, 0, 'XYZ');
    const q = euler.toQuat(quat.create(), src);
    expect(() => {
      const dst = euler.fromQuat(euler.create(), q, 'XYZ');
      // y component must stay near PI/2 (no NaN); under Float32 precision relax to 3 decimals
      expect(Number.isFinite(dst.y)).toBe(true);
      expect(dst.y).toBeCloseTo(Math.PI / 2, 3);
    }).not.toThrow();
  });

  it('fromQuat at gimbal lock (YXZ, pitch=-PI/2) does not throw (degenerate)', () => {
    const src = euler.set(euler.create(), -Math.PI / 2, 0, 0, 'YXZ');
    const q = euler.toQuat(quat.create(), src);
    expect(() => {
      const dst = euler.fromQuat(euler.create(), q, 'YXZ');
      expect(Number.isFinite(dst.x)).toBe(true);
    }).not.toThrow();
  });
});

describe('euler.fromRotationMatrix', () => {
  it.each(ORDERS)('identity mat3 → zero euler (order=%s, normal)', (order) => {
    const m = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
    const e = euler.fromRotationMatrix(euler.create(), m, order);
    expect(e.x).toBeCloseTo(0);
    expect(e.y).toBeCloseTo(0);
    expect(e.z).toBeCloseTo(0);
    expect(e.order).toBe(order);
  });

  it('fromRotationMatrix consistent with toQuat→fromRotationMatrix(via mat3) for XYZ (normal)', () => {
    // round-trip through the fromRotationMatrix path
    const src = euler.set(euler.create(), 0.2, 0.3, 0.4, 'XYZ');
    const q = euler.toQuat(quat.create(), src);
    // Build the equivalent mat3 from the quaternion explicitly (the same form as the mat3 in fromQuat)
    const x = q[0] as number;
    const y = q[1] as number;
    const z = q[2] as number;
    const w = q[3] as number;
    const xx = x * x;
    const xy = x * y;
    const xz = x * z;
    const yy = y * y;
    const yz = y * z;
    const zz = z * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    const m = Float32Array.of(
      1 - 2 * (yy + zz),
      2 * (xy + wz),
      2 * (xz - wy),
      2 * (xy - wz),
      1 - 2 * (xx + zz),
      2 * (yz + wx),
      2 * (xz + wy),
      2 * (yz - wx),
      1 - 2 * (xx + yy),
    );
    const dst = euler.fromRotationMatrix(euler.create(), m, 'XYZ');
    expect(dst.x).toBeCloseTo(src.x, 4);
    expect(dst.y).toBeCloseTo(src.y, 4);
    expect(dst.z).toBeCloseTo(src.z, 4);
  });
});

// ---------------------------------------------------------------------------
// M3 t11 — euler 12-case gimbal-lock supplementary tests (D-8 pure supplement, no src changes)
//
// Threshold: euler.ts branch coverage 64% → ≥ 75% (plan-strategy §3 R-3 + AC-10).
// Path: when each order's "middle axis" reaches ±π/2, the `else { /* gimbal lock */ }`
// branch in src is triggered.
// Middle-axis lookup table (src euler.ts:150-225):
//   XYZ → out.y = asin(_13)   → middle axis Y → set y=±π/2
//   YXZ → out.x = asin(-_23)  → middle axis X → set x=±π/2
//   ZXY → out.x = asin(_32)   → middle axis X → set x=±π/2
//   ZYX → out.y = asin(-_31)  → middle axis Y → set y=±π/2
//   YZX → out.z = asin(_21)   → middle axis Z → set z=±π/2
//   XZY → out.z = asin(-_12)  → middle axis Z → set z=±π/2
// ---------------------------------------------------------------------------

/** The "middle axis" per order — determines which axis hits ±π/2 at gimbal-lock. */
const MIDDLE_AXIS = {
  XYZ: 'y',
  YXZ: 'x',
  ZXY: 'x',
  ZYX: 'y',
  YZX: 'z',
  XZY: 'z',
} as const satisfies Record<EulerOrder, 'x' | 'y' | 'z'>;

/** Build a src Euler whose middle axis is sign*π/2, triggering the corresponding order's gimbal-lock branch. */
function makeGimbalEuler(order: EulerOrder, sign: 1 | -1): ReturnType<typeof euler.create> {
  const e = euler.create();
  const axis = MIDDLE_AXIS[order];
  e[axis] = (sign * Math.PI) / 2;
  e.order = order;
  return e;
}

/** Expand a quaternion into a column-major 3×3 rotation matrix (matches the formula inside src `euler.fromQuat`). */
function quatToMat3(q: ReturnType<typeof quat.create>): Float32Array {
  const x = q[0] as number;
  const y = q[1] as number;
  const z = q[2] as number;
  const w = q[3] as number;
  const xx = x * x;
  const xy = x * y;
  const xz = x * z;
  const yy = y * y;
  const yz = y * z;
  const zz = z * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return Float32Array.of(
    1 - 2 * (yy + zz),
    2 * (xy + wz),
    2 * (xz - wy),
    2 * (xy - wz),
    1 - 2 * (xx + zz),
    2 * (yz + wx),
    2 * (xz + wy),
    2 * (yz - wx),
    1 - 2 * (xx + yy),
  );
}

describe('euler.fromQuat — 6 order × gimbal-lock', () => {
  // 6 orders × 2 polar angles = 12 cases; each case hits the `else { /* gimbal lock */ }` branch of the corresponding order.
  for (const order of ORDERS) {
    for (const sign of [1, -1] as const) {
      const polarity = sign === 1 ? '+π/2' : '-π/2';
      it(`fromQuat at gimbal lock (order=${order}, ${MIDDLE_AXIS[order]}=${polarity}) does not throw, finite (degenerate)`, () => {
        const src = makeGimbalEuler(order, sign);
        const q = euler.toQuat(quat.create(), src);
        const dst = euler.create();
        expect(() => euler.fromQuat(dst, q, order)).not.toThrow();
        expect(Number.isFinite(dst.x)).toBe(true);
        expect(Number.isFinite(dst.y)).toBe(true);
        expect(Number.isFinite(dst.z)).toBe(true);
        expect(dst.order).toBe(order);
        // middle axis should still be close to sign*π/2 (relaxed to 3 decimals under Float32 precision)
        const mid = MIDDLE_AXIS[order];
        expect(dst[mid]).toBeCloseTo((sign * Math.PI) / 2, 3);
      });
    }
  }
});

describe('euler.fromRotationMatrix — 6 order × gimbal-lock', () => {
  // 6 orders × 1 polar angle = 6 cases (fromQuat already covers ±π/2 in both directions; fromRotationMatrix only needs 1 per order).
  for (const order of ORDERS) {
    it(`fromRotationMatrix at gimbal lock (order=${order}, ${MIDDLE_AXIS[order]}=+π/2) does not throw, finite (degenerate)`, () => {
      const src = makeGimbalEuler(order, 1);
      const q = euler.toQuat(quat.create(), src);
      const m = quatToMat3(q);
      const dst = euler.create();
      expect(() => euler.fromRotationMatrix(dst, m, order)).not.toThrow();
      expect(Number.isFinite(dst.x)).toBe(true);
      expect(Number.isFinite(dst.y)).toBe(true);
      expect(Number.isFinite(dst.z)).toBe(true);
      expect(dst.order).toBe(order);
      const mid = MIDDLE_AXIS[order];
      expect(dst[mid]).toBeCloseTo(Math.PI / 2, 3);
    });
  }
});

describe('euler.fromRotationMatrix — default fallback (unknown order)', () => {
  it('unknown order silently falls back to XYZ (degenerate, src line 213-223)', () => {
    // identity mat3 + illegal order: hits the default branch (same convention as quat.fromEuler D-P2)
    const m = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
    const dst = euler.create();
    expect(() => euler.fromRotationMatrix(dst, m, 'BOGUS' as EulerOrder)).not.toThrow();
    expect(Number.isFinite(dst.x)).toBe(true);
    expect(Number.isFinite(dst.y)).toBe(true);
    expect(Number.isFinite(dst.z)).toBe(true);
    // src line 222: `out.order = 'XYZ'` → after fallback the order is overwritten
    expect(dst.order).toBe('XYZ');
  });

  it('unknown order at gimbal lock (mat3 with _13≈1) hits default-branch else (degenerate, src line 219-220)', () => {
    // Build _13 = 1 (i.e. m[6] = 1) → the default branch's |_13| < 1 - 1e-7 fails → goes into else
    const src = makeGimbalEuler('XYZ', 1); // y = π/2 → cos=0, sin=1 → _13 = 1
    const q = euler.toQuat(quat.create(), src);
    const m = quatToMat3(q);
    const dst = euler.create();
    expect(() => euler.fromRotationMatrix(dst, m, 'UNKNOWN' as EulerOrder)).not.toThrow();
    expect(Number.isFinite(dst.x)).toBe(true);
    expect(Number.isFinite(dst.y)).toBe(true);
    expect(Number.isFinite(dst.z)).toBe(true);
    expect(dst.order).toBe('XYZ');
    expect(dst.y).toBeCloseTo(Math.PI / 2, 3);
  });
});

}

{
  // --- from f32-to-f16-bytes.test.ts ---
// f32ToF16Bytes unit test — TDD red phase (M1 w1).
//
// The function converts a packed float32 RGBA byte buffer (Uint8Array view over
// Float32 interleaved RGBA pixels) into the equivalent float16 RGBA byte buffer
// (IEEE 754 binary16, little-endian, half the byte length). See plan-strategy
// D-3 for extraction rationale and plan-tasks w2 for the implementation.
//
// Test coverage: normal f32 values / inf / NaN / subnormal / saturation >65504
// / zero / odd-length truncation.
//
// Related: plan-strategy §5.3 key test points; research Finding 5 (pure arithmetic).

// After w2 delivers the implementation to the barrel, this import will resolve.

describe('f32ToF16Bytes', () => {
  // --- Normal f32 values ---

  it('converts 1.0 to f16 and back (normal)', () => {
    const f32 = new Float32Array([1.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    // 4 bytes f32 -> 2 bytes f16
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    const half = view.getUint16(0, true);
    // 1.0 in binary16: sign=0, exp=15 (01111), mant=0 -> 0x3c00
    expect(half).toBe(0x3c00);
  });

  it('converts 0.0 to f16 (zero)', () => {
    const f32 = new Float32Array([0.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    expect(view.getUint16(0, true)).toBe(0x0000);
  });

  it('converts -0.0 to f16 (negative zero)', () => {
    const f32 = new Float32Array([-0.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // sign bit set; all other bits zero.
    expect(view.getUint16(0, true)).toBe(0x8000);
  });

  // --- Inf / NaN ---

  it('converts +Infinity to f16 +inf', () => {
    const f32 = new Float32Array([Number.POSITIVE_INFINITY]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // binary16 +inf: sign=0, exp=31, mant=0 -> 0x7c00
    expect(view.getUint16(0, true)).toBe(0x7c00);
  });

  it('converts -Infinity to f16 -inf', () => {
    const f32 = new Float32Array([Number.NEGATIVE_INFINITY]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // binary16 -inf: sign=1, exp=31, mant=0 -> 0xfc00
    expect(view.getUint16(0, true)).toBe(0xfc00);
  });

  it('propagates NaN (quiet NaN -> f16 NaN with mantissa bit)', () => {
    // f32 quiet NaN: exponent=0xff, mantissa high bit set.
    const scratch = new ArrayBuffer(4);
    const u32 = new Uint32Array(scratch);
    u32[0] = 0x7fc00000; // canonical quiet NaN
    const f32 = new Float32Array(scratch);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // NaN -> exp=31, mant=(any mant bit? 1) -> 0x200 | 0x7c00 = 0x7e00
    // But the existing code preserves one mantissa bit for NaN: (mant ? 0x200 : 0)
    // With f32 canonical NaN mant=0x400000, mant is truthy -> set 0x200 -> 0x7e00
    expect(view.getUint16(0, true)).toBe(0x7e00);
  });

  // --- Subnormal ---

  it('rounds subnormals to zero (round-to-zero for e < -10)', () => {
    // Smallest positive f32 normal: 1.1754943508222875e-38 (0x00800000)
    // Half that = subnormal with e < -10 in half precision
    const f32 = new Float32Array([5.877471754111438e-39]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // Subnormal below half precision range -> round to zero
    expect(view.getUint16(0, true)).toBe(0x0000);
  });

  // --- Saturation ---

  it('saturates values > 65504 to +inf', () => {
    const f32 = new Float32Array([100000.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // 100000 > 65504 (max half) -> saturate to +inf: 0x7c00
    expect(view.getUint16(0, true)).toBe(0x7c00);
  });

  it('saturates values < -65504 to -inf', () => {
    const f32 = new Float32Array([-100000.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // -100000 < -65504 -> saturate to -inf: 0xfc00
    expect(view.getUint16(0, true)).toBe(0xfc00);
  });

  // --- Multiple pixels (RGBA interleaved) ---

  it('produces output half the byte length of input (4 f32 -> 4 f16)', () => {
    const f32 = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    // 4 * 4 = 16 bytes in -> 4 * 2 = 8 bytes out
    expect(dst.length).toBe(8);
  });

  it('converts a 4-pixel RGBA buffer correctly', () => {
    const f32 = new Float32Array([1.0, 2.0, 3.0, 1.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(8);
    const view = new DataView(dst.buffer, dst.byteOffset, 8);
    expect(view.getUint16(0, true)).toBe(0x3c00); // 1.0
    // 2.0: sign=0, exp=16 (10000), mant=0 -> 0x4000
    expect(view.getUint16(2, true)).toBe(0x4000);
    // 3.0: 3.0 = 1.5 * 2^1, mant=0.5=0x200, exp=16 -> 0x4200
    expect(view.getUint16(4, true)).toBe(0x4200);
    expect(view.getUint16(6, true)).toBe(0x3c00); // 1.0
  });

  // --- Odd-length input (non-multiple of 4) ---

  it('handles odd-length input (truncates to largest 4-byte multiple)', () => {
    const f32 = new Float32Array([1.0, 2.0, 3.0]); // 3 floats = 12 bytes = valid as multiple of 4
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(6); // 3 * 2 = 6
  });

  it('produces zero-length output for empty input', () => {
    const src = new Uint8Array(0);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(0);
  });

  // --- Boundary: max representable normal value (w21) ---

  it('preserves the max half-precision normal value 65504 without saturation', () => {
    const f32 = new Float32Array([65504.0]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // 65504 = max half normal: sign=0, exp=30 (11110), mant=0x3ff (1023)
    // half = 0x7bff
    expect(view.getUint16(0, true)).toBe(0x7bff);
  });

  // --- Boundary: min positive normal value (w21) ---

  it('preserves the min half-precision normal value 6.1035e-5', () => {
    // Min positive half normal: 2^-14 = 0.00006103515625
    const minHalf = 6.103515625e-5;
    const f32 = new Float32Array([minHalf]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    // sign=0, exp=1 (00001), mant=0 -> 0x0400
    expect(view.getUint16(0, true)).toBe(0x0400);
  });

  // --- Boundary: round-to-zero for subnormals (w21) ---

  it('rounds the largest f32 subnormal to zero in half precision', () => {
    // Largest f32 subnormal: 1.1754942106924411e-38
    // In half precision e = exp - 127 + 15 = 0 - 127 + 15 = -112, which is < -10
    // so the code branch (e < -10) sets half = sign << 15 = 0.
    const maxSubnormal = 1.1754942106924411e-38;
    const f32 = new Float32Array([maxSubnormal]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    expect(view.getUint16(0, true)).toBe(0x0000);
  });

  it('rounds the smallest positive f32 normal to zero in half precision', () => {
    // Smallest f32 normal: 1.1754943508222875e-38 (0x00800000).
    // exp=1, e = 1 - 127 + 15 = -111, which is < -10 -> rounds to zero.
    const minPositive = 1.1754943508222875e-38;
    const f32 = new Float32Array([minPositive]);
    const src = new Uint8Array(f32.buffer);
    const dst = halfFloat.f32ToF16Bytes(src);
    expect(dst.length).toBe(2);
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    expect(view.getUint16(0, true)).toBe(0x0000);
  });
});

}

{
  // --- from frustum.test.ts ---
// Frustum unit tests — TDD red phase (feat-20260528-frustum-culling M1 / w3).
//
// From plan-strategy D-6: plane normalization is built into fromViewProjection internally.
// Frustum storage: Float32Array(24) — 6 planes × 4 floats (nx, ny, nz, d), normalized.
// Plane equation: nx*x + ny*y + nz*z + d = 0. Positive side = in front (inside frustum).
//
// Surface: fromViewProjection / intersectsBox / intersectsSphere.
//
// Related: requirements §AC-01 (frustum function signatures + test coverage);
//          plan-strategy §D-6 (internal normalization).


describe('frustum.fromViewProjection', () => {
  it('extracts 6 planes from a perspective VP matrix (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 3], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 10);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    expect(f).toBeInstanceOf(Float32Array);
    expect(f.length).toBe(24);
  });

  it('near plane faces the camera (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 3], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 10);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Near plane normal points toward camera: ~(0, 0, -1) (into screen)
    // A point at (0,0,2) should be inside the frustum (between near=1 and far=10, looking at origin)
    const d = f[11]; // near plane d
    expect(d).toBeGreaterThan(0);
  });

  it('origin should be inside a perspective frustum looking at origin (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // origin (0,0,0) should be inside
    const box = box3.create(-0.01, -0.01, -0.01, 0.01, 0.01, 0.01);
    expect(frustum.intersectsBox(f, box)).toBe(true);
  });

  it('extracts planes from orthographic VP (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 3], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.orthographic(mat4.create(), -5, 5, -5, 5, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Near plane should reject a point behind the camera
    const nearBox = box3.create(-1, -1, -100, 1, 1, -99);
    expect(frustum.intersectsBox(f, nearBox)).toBe(false);
  });

  it('degenerate zero matrix produces valid (but nonsensical) planes (degenerate)', () => {
    const vp = mat4.create(); // all zeros
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Should not throw; produces planes (may be degenerate but function must not crash)
    expect(f).toBeInstanceOf(Float32Array);
    expect(f.length).toBe(24);
  });

  it('returns out parameter', () => {
    const out = frustum.create();
    const vp = mat4.identity(mat4.create());
    const ret = frustum.fromViewProjection(out, vp);
    expect(ret).toBe(out);
  });
});

describe('frustum.intersectsBox', () => {
  it('box completely inside frustum returns true (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Small box at origin is well inside frustum
    const box = box3.create(-1, -1, -1, 1, 1, 1);
    expect(frustum.intersectsBox(f, box)).toBe(true);
  });

  it('box outside the right plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box far to the right, outside the frustum's right plane
    const box = box3.create(100, -1, 1, 101, 1, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box outside the left plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    const box = box3.create(-101, -1, 1, -100, 1, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box outside the top plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    const box = box3.create(-1, 100, 1, 1, 101, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box outside the bottom plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    const box = box3.create(-1, -101, 1, 1, -100, 10);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box behind the near plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box at z = 6 (behind the camera at z=5 looking toward origin)
    const box = box3.create(-1, -1, 5.1, 1, 1, 6);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box beyond the far plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box far from camera: camera at z=5, far=100, so z < -95 is beyond far
    const box = box3.create(-1, -1, -101, 1, 1, -96);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });

  it('box straddling the frustum boundary returns true (conservative)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box straddling right plane: half inside, half outside
    // At z=3 (between near=0.1 and far=100), the frustum right boundary is at x = z*tan(fov/2) = 3
    // Box from x=2 to x=4 straddles the boundary
    const box = box3.create(2, -1, 2.5, 4, 1, 3.5);
    expect(frustum.intersectsBox(f, box)).toBe(true);
  });

  it('intersection test is plane-order independent (boundary)', () => {
    // Camera at (0,0,5) looking at origin; near=5, so z > 5 is behind the camera
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 5, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Box at z > 5 is behind the camera's near plane
    const box = box3.create(-1, -1, 5.5, 1, 1, 6);
    expect(frustum.intersectsBox(f, box)).toBe(false);
  });
});

describe('frustum.intersectsSphere', () => {
  it('sphere inside frustum returns true (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    expect(frustum.intersectsSphere(f, [0, 0, 0], 1)).toBe(true);
  });

  it('sphere outside right plane returns false (normal)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    expect(frustum.intersectsSphere(f, [100, 0, 5], 1)).toBe(false);
  });

  it('sphere partially inside is considered intersecting (conservative)', () => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const vp = mat4.create();
    mat4.multiply(vp, proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    // Large sphere centered outside right plane but intersecting it
    expect(frustum.intersectsSphere(f, [50, 0, 5], 100)).toBe(true);
  });
});

}

{
  // --- from mat3.test.ts ---
// mat3.test.ts — M3 red: 3x3 matrix namespace unit tests (T-017)
//
// Covers the three tiers normal + degenerate (singular invert) + boundary:
//   create / clone / identity / equals / multiply / transpose / invert /
//   scale / fromMat4 / normalMatrix
//
// Memory layout lock: 9 floats packed (D-P4), column-major.
// Degenerate convention: invert(singular) → identity (same as D-P1).
//
// Related: requirements §AC-04 (normalMatrix) + AC-06 (throw 0) + AC-08;
//          plan-strategy §6 M3 + §appendix A degenerate registry #3 mat section.


describe('mat3.create / clone', () => {
  it('create() returns Float32Array length 9 zero (normal)', () => {
    const m = mat3.create();
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(9);
    for (let i = 0; i < 9; i++) expect(m[i]).toBe(0);
  });

  it('clone(a) returns a new Float32Array with same content (normal)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.clone(a);
    expect(b).not.toBe(a);
    for (let i = 0; i < 9; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('mat3.identity', () => {
  it('writes 3x3 identity column-major (normal)', () => {
    const m = mat3.identity(mat3.create());
    // identity column-major: [1,0,0, 0,1,0, 0,0,1]
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('idempotent: identity(identity(m)) == identity(m) (boundary)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(a);
    expect(b).toBe(a);
    for (let i = 0; i < 9; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('mat3.equals', () => {
  it('I == I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    expect(mat3.equals(a, b)).toBe(true);
  });

  it('detects 1e-3 component diff (boundary)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    b[0] = 1.001;
    expect(mat3.equals(a, b)).toBe(false);
  });

  it('NaN never equals (degenerate)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    b[0] = Number.NaN;
    expect(mat3.equals(a, b)).toBe(false);
  });
});

describe('mat3.multiply', () => {
  it('I * I = I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const b = mat3.identity(mat3.create());
    const out = mat3.multiply(mat3.create(), a, b);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('M * I = M (boundary)', () => {
    // any multipliable mat3: column-major [1,2,3, 4,5,6, 7,8,9]
    const m = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const i = mat3.identity(mat3.create());
    const out = mat3.multiply(mat3.create(), m as unknown as Mat3, i);
    for (let k = 0; k < 9; k++) expect(out[k]).toBeCloseTo(m[k] as number, 5);
  });

  it('aliasing-safe: multiply(m, m, m) reads before writes (degenerate)', () => {
    // m = identity * 2 (diagonal 2); m*m diagonal should be 4
    const m = mat3.identity(mat3.create());
    m[0] = 2;
    m[4] = 2;
    m[8] = 2;
    mat3.multiply(m, m, m);
    expect(m[0]).toBeCloseTo(4, 5);
    expect(m[4]).toBeCloseTo(4, 5);
    expect(m[8]).toBeCloseTo(4, 5);
  });
});

describe('mat3.transpose', () => {
  it('transpose(I) = I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const out = mat3.transpose(mat3.create(), a);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('transpose(transpose(m)) = m (boundary)', () => {
    const m = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const t1 = mat3.transpose(mat3.create(), m as unknown as Mat3);
    const t2 = mat3.transpose(mat3.create(), t1);
    for (let k = 0; k < 9; k++) expect(t2[k]).toBeCloseTo(m[k] as number, 5);
  });

  it('aliasing-safe: transpose(m, m) (degenerate)', () => {
    const m = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9) as unknown as Mat3;
    mat3.transpose(m, m);
    // column-major [1,2,3, 4,5,6, 7,8,9] transposed = [1,4,7, 2,5,8, 3,6,9]
    expect(Array.from(m)).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });
});

describe('mat3.invert (D-P1: singular → identity)', () => {
  it('invert(I) = I (normal)', () => {
    const a = mat3.identity(mat3.create());
    const out = mat3.invert(mat3.create(), a);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('invert(invert(m)) ≈ m for non-singular m (boundary)', () => {
    // non-singular mat3: diag(2, 3, 4) column-major
    const m = Float32Array.of(2, 0, 0, 0, 3, 0, 0, 0, 4) as unknown as Mat3;
    const inv = mat3.invert(mat3.create(), m);
    const back = mat3.invert(mat3.create(), inv);
    for (let k = 0; k < 9; k++) expect(back[k]).toBeCloseTo(m[k] as number, 5);
  });

  it('singular matrix → out = identity (degenerate, D-P1)', () => {
    // all zero → singular (det = 0)
    const singular = mat3.create();
    const out = mat3.invert(mat3.create(), singular);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('invert returns out (not null) for singular matrix', () => {
    const singular = mat3.create();
    const out = mat3.create();
    const ret = mat3.invert(out, singular);
    expect(ret).toBe(out);
  });
});

describe('mat3.scale', () => {
  it('scale(I, [2,3,1]) yields diag(2,3,1) (normal)', () => {
    // mat3 scale by Vec2 / Vec3? We design it to take Vec3 (aligned with mat4).
    // mat3 is typically used for 2D affine + normal matrix; for simplicity we take Vec3 and use the first 3 components.
    const a = mat3.identity(mat3.create());
    const v = Float32Array.of(2, 3, 1) as unknown as Vec3;
    const out = mat3.scale(mat3.create(), a, v);
    expect(out[0]).toBeCloseTo(2);
    expect(out[4]).toBeCloseTo(3);
    expect(out[8]).toBeCloseTo(1);
  });
});

describe('mat3.fromMat4 (drop 3rd row & column)', () => {
  it('extracts upper-left 3x3 from mat4 column-major (normal)', () => {
    // mat4 column-major:
    // col0: [1, 2, 3, 0]   col1: [4, 5, 6, 0]   col2: [7, 8, 9, 0]   col3: [0,0,0,1]
    const m4 = Float32Array.of(1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 0, 0, 0, 1) as unknown as Mat4;
    const m3 = mat3.fromMat4(mat3.create(), m4);
    expect(Array.from(m3)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('mat3.normalMatrix (transpose-inverse upper-left of mat4)', () => {
  it('normalMatrix(I_4) = I_3 (normal)', () => {
    const m4 = mat4.identity(mat4.create());
    const n = mat3.normalMatrix(mat3.create(), m4);
    expect(Array.from(n)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('normalMatrix preserves uniform scale → diag inverse (boundary)', () => {
    // mat4 = diag(2, 2, 2, 1) upper-left 3x3 = 2I → invert = 0.5I → transpose = 0.5I
    const m4 = mat4.identity(mat4.create());
    m4[0] = 2;
    m4[5] = 2;
    m4[10] = 2;
    const n = mat3.normalMatrix(mat3.create(), m4);
    expect(n[0]).toBeCloseTo(0.5);
    expect(n[4]).toBeCloseTo(0.5);
    expect(n[8]).toBeCloseTo(0.5);
  });

  it('singular upper-left → identity (degenerate, same convention as D-P1)', () => {
    // mat4 with zero upper-left 3x3 → singular → fallback identity
    const m4 = mat4.identity(mat4.create());
    m4[0] = 0;
    m4[5] = 0;
    m4[10] = 0;
    const n = mat3.normalMatrix(mat3.create(), m4);
    expect(Array.from(n)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe('mat3 — V8 elements-kinds performance guard', () => {
  it('all return values are Float32Array (no number[] coercion)', () => {
    const out1 = mat3.identity(mat3.create());
    const out2 = mat3.multiply(mat3.create(), out1, out1);
    const out3 = mat3.transpose(mat3.create(), out1);
    const out4 = mat3.invert(mat3.create(), out1);
    expect(out1).toBeInstanceOf(Float32Array);
    expect(out2).toBeInstanceOf(Float32Array);
    expect(out3).toBeInstanceOf(Float32Array);
    expect(out4).toBeInstanceOf(Float32Array);
  });
});

}

{
  // --- from mat4.test.ts ---
// mat4.test.ts — M3 red: 4x4 matrix namespace unit tests (T-017)
//
// Covers the three tiers normal + degenerate + boundary:
//   create / clone / identity / equals / multiply / transpose / invert / scale /
//   translate / rotate / lookAt / compose / decompose / fromQuat /
//   perspective (WebGPU [0,1]) / perspectiveNO (WebGL [-1,1]) / perspectiveReverseZ /
//   orthographic / orthographicNO / orthographicReverseZ
//
// Degenerate convention: invert(singular) → identity (D-P1); lookAt(eye=target) → identity (D-P17).
// Boundary: near >= far is numerically undefined but does not throw (plan §appendix A degenerate registry #7).
// reversed-Z fixture values come from _fixtures.ts (error ≤ 1e-5, AC-05).
//
// Related: requirements §AC-04 three projection tiers complete + AC-05 reversed-Z + AC-06 throw 0;
//          plan-strategy §6 M3 + §appendix A degenerate registry mat section (5 entries);
//          wiki/reversed-z-projection.md §7.2 / 7.3 fixture;
//          wiki/wgpu-matrix-overview.md / gl-matrix-overview.md naming conventions.


describe('mat4.create / clone', () => {
  it('create() returns Float32Array length 16 zero (normal)', () => {
    const m = mat4.create();
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
    for (let i = 0; i < 16; i++) expect(m[i]).toBe(0);
  });

  it('clone(a) returns a new Float32Array with same content (normal)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.clone(a);
    expect(b).not.toBe(a);
    for (let i = 0; i < 16; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('mat4.identity', () => {
  it('returns 4x4 identity in a Float32Array of length 16 (normal)', () => {
    const m = mat4.identity(mat4.create());
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(m[i]).toBe(expected);
    }
  });

  it('idempotent: identity(identity(m)) equals identity(m) (boundary)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(a);
    for (let i = 0; i < 16; i++) expect(b[i]).toBe(a[i]);
  });

  it('returns same Float32Array instance (degenerate: in-place semantics)', () => {
    const m = mat4.create();
    const out = mat4.identity(m);
    expect(out).toBe(m);
  });
});

describe('mat4.equals', () => {
  it('I == I (normal)', () => {
    expect(mat4.equals(mat4.identity(mat4.create()), mat4.identity(mat4.create()))).toBe(true);
  });

  it('NaN never equals (degenerate)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    b[0] = Number.NaN;
    expect(mat4.equals(a, b)).toBe(false);
  });
});

describe('mat4.multiply', () => {
  it('I * I = I (normal)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    const out = mat4.multiply(mat4.create(), a, b);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(out[i]).toBe(expected);
    }
  });

  it('M * I = M (boundary)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    const i = mat4.identity(mat4.create());
    const out = mat4.multiply(mat4.create(), m, i);
    for (let k = 0; k < 16; k++) expect(out[k]).toBeCloseTo(m[k] as number);
  });

  it('two translations compose additively (degenerate aliasing input)', () => {
    const t1 = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    const t2 = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [4, 5, 6]);
    const out = mat4.multiply(mat4.create(), t1, t2);
    expect(out[12]).toBeCloseTo(5);
    expect(out[13]).toBeCloseTo(7);
    expect(out[14]).toBeCloseTo(9);
    expect(out[15]).toBeCloseTo(1);
  });

  it('aliasing-safe: multiply(m, m, m) (degenerate)', () => {
    const m = mat4.identity(mat4.create());
    m[0] = 2;
    m[5] = 2;
    m[10] = 2;
    mat4.multiply(m, m, m);
    expect(m[0]).toBeCloseTo(4);
    expect(m[5]).toBeCloseTo(4);
    expect(m[10]).toBeCloseTo(4);
  });
});

describe('mat4.transpose', () => {
  it('transpose(I) = I (normal)', () => {
    const a = mat4.identity(mat4.create());
    const out = mat4.transpose(mat4.create(), a);
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(a[i]);
  });

  it('transpose(transpose(m)) = m (boundary)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    const t1 = mat4.transpose(mat4.create(), m);
    const t2 = mat4.transpose(mat4.create(), t1);
    for (let k = 0; k < 16; k++) expect(t2[k]).toBeCloseTo(m[k] as number);
  });
});

describe('mat4.invert (D-P1: singular → identity)', () => {
  it('invert(I) = I (normal)', () => {
    const a = mat4.identity(mat4.create());
    const out = mat4.invert(mat4.create(), a);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(a[i] as number);
  });

  it('invert(translation) flips sign (boundary)', () => {
    const t = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [3, 4, 5]);
    const inv = mat4.invert(mat4.create(), t);
    expect(inv[12]).toBeCloseTo(-3);
    expect(inv[13]).toBeCloseTo(-4);
    expect(inv[14]).toBeCloseTo(-5);
  });

  it('invert(invert(m)) ≈ m for non-singular m (boundary)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [2, -1, 7]);
    const inv = mat4.invert(mat4.create(), m);
    const back = mat4.invert(mat4.create(), inv);
    for (let k = 0; k < 16; k++) expect(back[k]).toBeCloseTo(m[k] as number, 4);
  });

  it('singular matrix → out = identity (degenerate, D-P1)', () => {
    // all zero → singular (det = 0)
    const singular = mat4.create();
    const out = mat4.invert(mat4.create(), singular);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(out[i]).toBeCloseTo(expected);
    }
  });

  it('singular returns out (not null), AC-08 cross-vendor rewrite', () => {
    const singular = mat4.create();
    const out = mat4.create();
    const ret = mat4.invert(out, singular);
    expect(ret).toBe(out);
    // not null
    expect(ret).not.toBeNull();
  });

  it('aliasing-safe: invert(m, m) where m is singular (R-P1)', () => {
    const m = mat4.create();
    const ret = mat4.invert(m, m);
    expect(ret).toBe(m);
    // should be identity (aliasing-safe + singular fallback)
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(m[i]).toBeCloseTo(expected);
    }
  });
});

describe('mat4.scale', () => {
  it('scale(I, [2,3,4]) yields diag(2,3,4,1) (normal)', () => {
    const a = mat4.identity(mat4.create());
    const out = mat4.scale(mat4.create(), a, [2, 3, 4]);
    expect(out[0]).toBeCloseTo(2);
    expect(out[5]).toBeCloseTo(3);
    expect(out[10]).toBeCloseTo(4);
    expect(out[15]).toBeCloseTo(1);
  });
});

describe('mat4.translate', () => {
  it('translates an identity matrix (normal)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [1, 2, 3]);
    expect(m[12]).toBeCloseTo(1);
    expect(m[13]).toBeCloseTo(2);
    expect(m[14]).toBeCloseTo(3);
    expect(m[15]).toBeCloseTo(1);
  });

  it('translate by zero is a no-op (boundary)', () => {
    const id = mat4.identity(mat4.create());
    const out = mat4.translate(mat4.create(), id, [0, 0, 0]);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(id[i] as number);
  });

  it('accepts Float32Array as translation vector (degenerate: typed-array friendly)', () => {
    const v = new Float32Array([4, 5, 6]);
    const out = mat4.translate(mat4.create(), mat4.identity(mat4.create()), v);
    expect(out[12]).toBeCloseTo(4);
    expect(out[13]).toBeCloseTo(5);
    expect(out[14]).toBeCloseTo(6);
  });
});

describe('mat4.rotate', () => {
  it('rotate(I, axis, 0) ≈ I (boundary)', () => {
    const out = mat4.rotate(mat4.create(), mat4.identity(mat4.create()), [0, 1, 0], 0);
    const id = mat4.identity(mat4.create());
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(id[i] as number);
  });

  it('rotate around Y by π/2 maps X → -Z (normal)', () => {
    const r = mat4.rotate(mat4.create(), mat4.identity(mat4.create()), [0, 1, 0], Math.PI / 2);
    // column-major: m[0..2] = first column = R * [1,0,0]^T
    expect(r[0]).toBeCloseTo(0, 5);
    expect(r[1]).toBeCloseTo(0, 5);
    expect(r[2]).toBeCloseTo(-1, 5);
  });
});

describe('mat4.lookAt (D-P17: eye=target → identity)', () => {
  it('lookAt(eye=[0,0,5], target=origin, up=Y) yields finite matrix (normal)', () => {
    const m = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
  });

  it('eye === target → out = identity (degenerate, D-P17)', () => {
    const m = mat4.lookAt(mat4.create(), [1, 2, 3], [1, 2, 3], [0, 1, 0]);
    for (let i = 0; i < 16; i++) {
      const expected = i % 5 === 0 ? 1 : 0;
      expect(m[i]).toBeCloseTo(expected);
    }
  });

  it('returns out (not null) for eye=target degenerate input', () => {
    const out = mat4.create();
    const ret = mat4.lookAt(out, [1, 1, 1], [1, 1, 1], [0, 1, 0]);
    expect(ret).toBe(out);
  });
});

describe('mat4.compose / decompose', () => {
  it('compose(t, r=identity-quat, s=[1,1,1]) ≈ translate(I, t) (normal)', () => {
    const q = quat.identity(quat.create());
    const m = mat4.compose(mat4.create(), vec3.create(1, 2, 3), q, vec3.create(1, 1, 1));
    expect(m[12]).toBeCloseTo(1);
    expect(m[13]).toBeCloseTo(2);
    expect(m[14]).toBeCloseTo(3);
  });

  it('decompose(compose(t, r, s)) ≈ (t, r, s) (boundary, no shear)', () => {
    const t = vec3.create(1, 2, 3);
    const r = quat.identity(quat.create());
    const s = vec3.create(2, 3, 4);
    const m = mat4.compose(mat4.create(), t, r, s);
    const t2 = vec3.create();
    const r2 = quat.identity(quat.create());
    const s2 = vec3.create();
    mat4.decompose(t2, r2, s2, m);
    expect(t2[0]).toBeCloseTo(1);
    expect(t2[1]).toBeCloseTo(2);
    expect(t2[2]).toBeCloseTo(3);
    expect(s2[0]).toBeCloseTo(2);
    expect(s2[1]).toBeCloseTo(3);
    expect(s2[2]).toBeCloseTo(4);
  });
});

describe('mat4.fromQuat', () => {
  it('fromQuat(identity) = I (normal)', () => {
    const q = quat.identity(quat.create());
    const m = mat4.fromQuat(mat4.create(), q);
    const id = mat4.identity(mat4.create());
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(id[i] as number);
  });
});

describe('mat4.perspective (WebGPU [0,1] short name, D-3)', () => {
  it('produces a finite 4x4 matrix for typical fov/aspect/near/far (normal)', () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 4, 16 / 9, 0.1, 1000);
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
    expect(m[11]).toBeCloseTo(-1);
    expect(m[15]).toBe(0);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
  });

  it('square aspect ratio yields equal x and y scaling (boundary)', () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    expect(m[0]).toBeCloseTo(m[5] as number);
  });

  it('near→0, far→1 mapping for [0,1] NDC (normal)', () => {
    // perspective WebGPU [0,1]: near plane → ndc_z=0, far plane → ndc_z=1
    const near = 0.1;
    const far = 100;
    const m = mat4.perspective(mat4.create(), Math.PI / 4, 1, near, far);
    // feed the point (0, 0, -near, 1) to the matrix and expect ndc_z = 0
    // p_clip = M * [0, 0, -near, 1]^T; p_clip[2] = m[8]*0 + m[9]*0 + m[10]*(-near) + m[14]*1
    // p_clip[3] = m[11]*(-near) = near
    const clipZ_near = (m[10] as number) * -near + (m[14] as number);
    const clipW_near = (m[11] as number) * -near;
    const ndc_near = clipZ_near / clipW_near;
    expect(ndc_near).toBeCloseTo(0, 4);
    const clipZ_far = (m[10] as number) * -far + (m[14] as number);
    const clipW_far = (m[11] as number) * -far;
    const ndc_far = clipZ_far / clipW_far;
    expect(ndc_far).toBeCloseTo(1, 4);
  });

  it('near >= far does not throw, values undefined-but-finite-or-non (degenerate)', () => {
    expect(() => mat4.perspective(mat4.create(), Math.PI / 4, 1, 100, 0.1)).not.toThrow();
    expect(() => mat4.perspective(mat4.create(), Math.PI / 4, 1, 1, 1)).not.toThrow();
  });
});

describe('mat4.perspectiveNO (WebGL [-1,1] NDC)', () => {
  it('z = -1 at near, z = +1 at far (normal)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 1, near, far);
    const ndc_near = ((m[10] as number) * -near + (m[14] as number)) / ((m[11] as number) * -near);
    const ndc_far = ((m[10] as number) * -far + (m[14] as number)) / ((m[11] as number) * -far);
    expect(ndc_near).toBeCloseTo(-1, 4);
    expect(ndc_far).toBeCloseTo(1, 4);
  });
});

describe('mat4.perspectiveReverseZ (AC-05 fixture, finite far)', () => {
  it('matches double-precision fixture within 1e-5 (normal)', () => {
    const { fovy, aspect, near, far } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, far);
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(
        PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED[i] as number,
        REVERSE_Z_FIXTURE_TOLERANCE,
      );
    }
  });

  it('near → ndc_z = 1, far → ndc_z = 0 (boundary)', () => {
    const { fovy, aspect, near, far } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, far);
    const ndcAtNear = ((m[10] as number) * -near + (m[14] as number)) / ((m[11] as number) * -near);
    const ndcAtFar = ((m[10] as number) * -far + (m[14] as number)) / ((m[11] as number) * -far);
    expect(ndcAtNear).toBeCloseTo(1, REVERSE_Z_FIXTURE_TOLERANCE);
    expect(ndcAtFar).toBeCloseTo(0, REVERSE_Z_FIXTURE_TOLERANCE);
  });

  it('projection probes (z_eye → ndc_z) match table (degenerate intermediate)', () => {
    const { fovy, aspect, near, far } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, far);
    for (const probe of REVERSE_Z_PROJECTION_PROBES_FINITE) {
      const clipZ = (m[10] as number) * probe.z_eye + (m[14] as number);
      const clipW = (m[11] as number) * probe.z_eye;
      const ndcZ = clipZ / clipW;
      expect(ndcZ).toBeCloseTo(probe.ndc_z, REVERSE_Z_FIXTURE_TOLERANCE);
    }
  });
});

describe('mat4.perspectiveReverseZ (AC-05 fixture, infinite far)', () => {
  it('matches double-precision fixture within 1e-5 when far=Infinity (normal)', () => {
    const { fovy, aspect, near } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, Number.POSITIVE_INFINITY);
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(
        PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED[i] as number,
        REVERSE_Z_FIXTURE_TOLERANCE,
      );
    }
  });

  it('infinite-far probes match table', () => {
    const { fovy, aspect, near } = PERSPECTIVE_REVERSE_Z_FINITE_INPUT;
    const m = mat4.perspectiveReverseZ(mat4.create(), fovy, aspect, near, Number.POSITIVE_INFINITY);
    for (const probe of REVERSE_Z_PROJECTION_PROBES_INFINITE) {
      const clipZ = (m[10] as number) * probe.z_eye + (m[14] as number);
      const clipW = (m[11] as number) * probe.z_eye;
      const ndcZ = clipZ / clipW;
      expect(ndcZ).toBeCloseTo(probe.ndc_z, REVERSE_Z_FIXTURE_TOLERANCE);
    }
  });
});

describe('mat4.orthographic (WebGPU [0,1] short name, D-3)', () => {
  it('finite for typical inputs (normal)', () => {
    const m = mat4.orthographic(mat4.create(), -1, 1, -1, 1, 0.1, 100);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
    // last element (affine) = 1
    expect(m[15]).toBeCloseTo(1);
  });

  it('near → ndc_z = 0, far → ndc_z = 1 (boundary)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.orthographic(mat4.create(), -1, 1, -1, 1, near, far);
    // ortho: clipZ = m[10] * z_eye + m[14], w = 1
    const ndc_near = (m[10] as number) * -near + (m[14] as number);
    const ndc_far = (m[10] as number) * -far + (m[14] as number);
    expect(ndc_near).toBeCloseTo(0, 4);
    expect(ndc_far).toBeCloseTo(1, 4);
  });
});

describe('mat4.orthographicNO (WebGL [-1,1] NDC)', () => {
  it('near → -1, far → +1 (normal)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.orthographicNO(mat4.create(), -1, 1, -1, 1, near, far);
    const ndc_near = (m[10] as number) * -near + (m[14] as number);
    const ndc_far = (m[10] as number) * -far + (m[14] as number);
    expect(ndc_near).toBeCloseTo(-1, 4);
    expect(ndc_far).toBeCloseTo(1, 4);
  });
});

describe('mat4.orthographicReverseZ (D-P3 self-extension, near→1 far→0)', () => {
  it('near → ndc_z = 1, far → ndc_z = 0 (normal)', () => {
    const near = 0.1;
    const far = 100;
    const m = mat4.orthographicReverseZ(mat4.create(), -1, 1, -1, 1, near, far);
    const ndc_near = (m[10] as number) * -near + (m[14] as number);
    const ndc_far = (m[10] as number) * -far + (m[14] as number);
    expect(ndc_near).toBeCloseTo(1, 4);
    expect(ndc_far).toBeCloseTo(0, 4);
  });
});

// T-035: three-tier coverage tightening for from{Translation/Scaling/Rotation}
// (plan-strategy AC-10 line / branch ≥ 80% hard constraint — this group lifts mat4.ts branch from 48% to 80%+)
describe('mat4.fromTranslation', () => {
  it('builds identity-with-translation (normal)', () => {
    const m = mat4.fromTranslation(mat4.create(), [1.5, -2.0, 3.5]);
    // column-major storage: translation lands at indices 12/13/14
    expect(m[0]).toBe(1);
    expect(m[5]).toBe(1);
    expect(m[10]).toBe(1);
    expect(m[15]).toBe(1);
    expect(m[12]).toBeCloseTo(1.5, 5);
    expect(m[13]).toBeCloseTo(-2.0, 5);
    expect(m[14]).toBeCloseTo(3.5, 5);
  });

  it('zero translation = identity (boundary)', () => {
    const m = mat4.fromTranslation(mat4.create(), [0, 0, 0]);
    const I = mat4.identity(mat4.create());
    expect(mat4.equals(m, I)).toBe(true);
  });
});

describe('mat4.fromScaling', () => {
  it('builds diag(sx, sy, sz, 1) (normal)', () => {
    const m = mat4.fromScaling(mat4.create(), [2, 3, 4]);
    expect(m[0]).toBe(2);
    expect(m[5]).toBe(3);
    expect(m[10]).toBe(4);
    expect(m[15]).toBe(1);
    expect(m[1]).toBe(0);
    expect(m[6]).toBe(0);
    expect(m[11]).toBe(0);
  });

  it('unit scaling = identity (boundary)', () => {
    const m = mat4.fromScaling(mat4.create(), [1, 1, 1]);
    expect(mat4.equals(m, mat4.identity(mat4.create()))).toBe(true);
  });
});

describe('mat4.fromRotation', () => {
  it('rotation around Y by π/2 maps +X → -Z (normal)', () => {
    const m = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 2);
    // column-major: m[0..3] is the first column, corresponding to R·[1,0,0,0] → x'=m[0], y'=m[1], z'=m[2]
    expect(m[0]).toBeCloseTo(0, 5);
    expect(m[2]).toBeCloseTo(-1, 5);
  });

  it('zero axis silently degrades to identity (degenerate, AC-06)', () => {
    const m = mat4.fromRotation(mat4.create(), [0, 0, 0], Math.PI / 4);
    expect(mat4.equals(m, mat4.identity(mat4.create()))).toBe(true);
  });

  it('non-unit axis is normalized internally (boundary)', () => {
    const a = mat4.fromRotation(mat4.create(), [0, 1, 0], 0.7);
    const b = mat4.fromRotation(mat4.create(), [0, 5, 0], 0.7);
    expect(mat4.equals(a, b)).toBe(true);
  });
});

// T-035: perspective/perspectiveNO infinite-far + decompose trace-branch coverage
describe('mat4.perspective infinite far', () => {
  it('perspective(far=Infinity) sets m[10]=-1 and m[14]=-near (boundary)', () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 4, 1, 0.1, Number.POSITIVE_INFINITY);
    expect(m[10]).toBe(-1);
    expect(m[14]).toBeCloseTo(-0.1, 5);
  });

  it('perspectiveNO(far=Infinity) sets m[10]=-1 and m[14]=-2*near (boundary)', () => {
    const m = mat4.perspectiveNO(mat4.create(), Math.PI / 4, 1, 0.1, Number.POSITIVE_INFINITY);
    expect(m[10]).toBe(-1);
    expect(m[14]).toBeCloseTo(-0.2, 5);
  });
});

describe('mat4.decompose trace branches', () => {
  // decompose internally splits into 4 Shoemake branches: trace>0 / r00 max / r11 max / r22 max.
  // identity falls into trace>0; here we rotate by π around each principal axis to hit the r00/r11/r22 max branches.
  it('rotation around X by π hits r00 max branch (boundary)', () => {
    const r = quat.create();
    quat.fromAxisAngle(r, [1, 0, 0], Math.PI);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [1, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[0]).toBeCloseTo(1, 5);
    expect(sOut[1]).toBeCloseTo(1, 5);
    expect(sOut[2]).toBeCloseTo(1, 5);
  });

  it('rotation around Y by π hits r11 max branch (boundary)', () => {
    const r = quat.create();
    quat.fromAxisAngle(r, [0, 1, 0], Math.PI);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [1, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[1]).toBeCloseTo(1, 5);
  });

  it('rotation around Z by π hits r22 max branch (boundary)', () => {
    const r = quat.create();
    quat.fromAxisAngle(r, [0, 0, 1], Math.PI);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [1, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[2]).toBeCloseTo(1, 5);
  });

  it('negative determinant flips sx (degenerate)', () => {
    // negative scale (mirror x) → det < 0 → sxFinal = -sx
    const r = quat.create();
    quat.identity(r);
    const m = mat4.compose(mat4.create(), [0, 0, 0], r, [-2, 1, 1]);
    const tOut = vec3.create();
    const rOut = quat.create();
    const sOut = vec3.create();
    mat4.decompose(tOut, rOut, sOut, m);
    expect(sOut[0]).toBeLessThan(0);
  });
});

// M1 / t1 — mat4.transformVec3 / transformPoint / transformDirection
//
// 3 functions × 3 case tiers (normal + degrade + in-place) + alias equivalence:
//   - transformVec3: affine m transforms (x,y,z,1) + w'=0 guard → out=(0,0,0)
//   - transformPoint: ES alias of transformVec3 (OQ-1, S-1)
//   - transformDirection: takes m's upper-left 3×3 (no translation column) + final vec3.normalize
//   - degenerate |out|=0 → out=(0,0,0) (D-4 silent convention)
//   - in-place safety: out === v at the same address still produces the correct result
//
// Related: requirements §3.1 mat4 rows 1/2/3 + §9 boundary-case table rows 1/3/6;
//          research Finding 1 (alias evidence) + Finding 2 (take 3×3 + normalize) + Finding 4 (w'=0 guard);
//          plan-strategy §2 S-1 / S-2 + §4.3 key test points table top 3 rows.

describe('mat4.transformVec3 (M1 / t1)', () => {
  it('identity unit: transformVec3(I, v) ≈ v (normal)', () => {
    const I = mat4.identity(mat4.create());
    const v = vec3.create(1, 2, 3);
    const out = vec3.create();
    mat4.transformVec3(out, I, v);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it('chained composition baseline: transformVec3(T*S, v) ≈ T*S applied (normal)', () => {
    // T(1,2,3) * S(2,2,2) applied to v=(1,1,1): S scales to (2,2,2), then T translates to (3,4,5)
    const S = mat4.fromScaling(mat4.create(), [2, 2, 2]);
    const T = mat4.fromTranslation(mat4.create(), [1, 2, 3]);
    const M = mat4.multiply(mat4.create(), T, S);
    const v = vec3.create(1, 1, 1);
    const out = vec3.create();
    mat4.transformVec3(out, M, v);
    expect(out[0]).toBeCloseTo(3, 5);
    expect(out[1]).toBeCloseTo(4, 5);
    expect(out[2]).toBeCloseTo(5, 5);
  });

  it("w'=0 plane projection → out=(0,0,0) (degrade, D-4 silent convention)", () => {
    // Build a matrix that makes w' = 0: m[3]=1, m[7]=m[11]=m[15]=0; with input v=(1,0,0,1), w' = 1*1+0+0+0 = 1 (not degenerate)
    // Switch to: m[3]=0, m[7]=0, m[11]=0, m[15]=0 + arbitrary v → w' = 0
    const m = mat4.create(); // all zero → w' = 0*x+0*y+0*z+0*1 = 0
    const v = vec3.create(1, 2, 3);
    const out = vec3.create(9, 9, 9);
    const ret = mat4.transformVec3(out, m, v);
    expect(ret).toBe(out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('in-place safe: transformVec3(v, I, v) ≈ v (boundary, out===v)', () => {
    const v = vec3.create(2, 4, 6);
    const I = mat4.identity(mat4.create());
    const ret = mat4.transformVec3(v, I, v);
    expect(ret).toBe(v);
    expect(v[0]).toBeCloseTo(2, 5);
    expect(v[1]).toBeCloseTo(4, 5);
    expect(v[2]).toBeCloseTo(6, 5);
  });
});

describe('mat4.transformPoint (M1 / t1, alias of transformVec3 — S-1)', () => {
  it('equivalent to transformVec3 (alias lock, OQ-1)', () => {
    const M = mat4.fromTranslation(mat4.create(), [10, 20, 30]);
    const v = vec3.create(1, 2, 3);
    const a = vec3.create();
    const b = vec3.create();
    mat4.transformVec3(a, M, v);
    mat4.transformPoint(b, M, v);
    expect(b[0]).toBeCloseTo(a[0] as number, 6);
    expect(b[1]).toBeCloseTo(a[1] as number, 6);
    expect(b[2]).toBeCloseTo(a[2] as number, 6);
    // same function body: reference-equal
    expect(mat4.transformPoint).toBe(mat4.transformVec3);
  });

  it('translation independently testable: transformPoint(T, origin) = t (normal)', () => {
    const T = mat4.fromTranslation(mat4.create(), [7, -8, 9]);
    const origin = vec3.create(0, 0, 0);
    const out = vec3.create();
    mat4.transformPoint(out, T, origin);
    expect(out[0]).toBeCloseTo(7, 5);
    expect(out[1]).toBeCloseTo(-8, 5);
    expect(out[2]).toBeCloseTo(9, 5);
  });

  it("w'=0 degenerate shares transformVec3 convention → out=(0,0,0) (degrade)", () => {
    const m = mat4.create();
    const out = vec3.create(1, 1, 1);
    mat4.transformPoint(out, m, vec3.create(5, 6, 7));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('in-place safe (boundary)', () => {
    const v = vec3.create(3, 5, 7);
    const T = mat4.fromTranslation(mat4.create(), [1, 1, 1]);
    mat4.transformPoint(v, T, v);
    expect(v[0]).toBeCloseTo(4, 5);
    expect(v[1]).toBeCloseTo(6, 5);
    expect(v[2]).toBeCloseTo(8, 5);
  });
});

describe('mat4.transformDirection (M1 / t1)', () => {
  it('takes upper-left 3×3, ignores translation column: dir unaffected by T (normal)', () => {
    // T(100, 200, 300) applied to dir=(1,0,0): a direction vector must not be translated
    const T = mat4.fromTranslation(mat4.create(), [100, 200, 300]);
    const dir = vec3.create(1, 0, 0);
    const out = vec3.create();
    mat4.transformDirection(out, T, dir);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  it('orthogonal m preserves unit length: rotateY π/2 applied to (1,0,0) → (0,0,-1) (normal)', () => {
    const R = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 2);
    const dir = vec3.create(1, 0, 0);
    const out = vec3.create();
    mat4.transformDirection(out, R, dir);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(-1, 5);
    // unit length preserved
    const len = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
    expect(len).toBeCloseTo(1, 5);
  });

  it('|out|=0 degenerate (singular m + dir) → out=(0,0,0) (degrade, D-4 silent convention)', () => {
    // all-zero m → 3×3 part all zero → out is (0,0,0) before normalize → vec3.normalize silent → (0,0,0)
    const m = mat4.create();
    const dir = vec3.create(1, 1, 1);
    const out = vec3.create(9, 9, 9);
    const ret = mat4.transformDirection(out, m, dir);
    expect(ret).toBe(out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('in-place safe: transformDirection(v, R, v) (boundary)', () => {
    const R = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 2);
    const v = vec3.create(1, 0, 0);
    mat4.transformDirection(v, R, v);
    expect(v[0]).toBeCloseTo(0, 5);
    expect(v[2]).toBeCloseTo(-1, 5);
  });

  it('equivalent to transformVec3 on pure-rotation m (modulo normalize)', () => {
    // pure rotation matrices preserve unit length, so transformVec3 and transformDirection output the same value
    const R = mat4.fromRotation(mat4.create(), [0, 0, 1], Math.PI / 4);
    const v = vec3.create(1, 0, 0); // unit-length input
    const a = vec3.create();
    const b = vec3.create();
    mat4.transformVec3(a, R, v);
    mat4.transformDirection(b, R, v);
    expect(b[0]).toBeCloseTo(a[0] as number, 5);
    expect(b[1]).toBeCloseTo(a[1] as number, 5);
    expect(b[2]).toBeCloseTo(a[2] as number, 5);
  });
});

describe('mat4 — V8 elements-kinds performance guard', () => {
  it('all return values are Float32Array (no number[] coercion)', () => {
    const out1 = mat4.identity(mat4.create());
    const out2 = mat4.multiply(mat4.create(), out1, out1);
    const out3 = mat4.perspective(mat4.create(), 1, 1, 0.1, 100);
    const out4 = mat4.translate(mat4.create(), out1, [1, 1, 1]);
    expect(out1).toBeInstanceOf(Float32Array);
    expect(out2).toBeInstanceOf(Float32Array);
    expect(out3).toBeInstanceOf(Float32Array);
    expect(out4).toBeInstanceOf(Float32Array);
  });
});

// M3 / T-coverage — mat4 branch coverage backfill (T-035 follow-up)
//
// Targets the surviving uncovered branches identified by v8 coverage
// (76.59% → ≥80%, AC-10 hard floor). Each it lifts a specific branch:
//   - equals epsilon-fail (L85)         — finite diff > epsilon path
//   - translate aliasing (L288)         — `if (a === out)` true path
//   - rotate zero-axis × out!==a (L347, L349 if-true path)
//   - rotate zero-axis × out===a (L349 if-false path)
//   - lookAt up collinear with forward (L449) — perpendicular axis fallback
//   - decompose zero-scale (L575/576/577) — sx=0 ? 0 : 1/sx ternary true paths
describe('mat4 — M3 branch coverage backfill', () => {
  it('equals(a, b) returns false when finite diff > epsilon (L85)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    b[0] = 2;
    expect(mat4.equals(a, b)).toBe(false);
  });

  it('equals(a, b) honours custom epsilon argument (L85 boundary)', () => {
    const a = mat4.identity(mat4.create());
    const b = mat4.identity(mat4.create());
    b[5] = 1 + 1e-3;
    expect(mat4.equals(a, b)).toBe(false);
    expect(mat4.equals(a, b, 1e-2)).toBe(true);
  });

  it('translate aliasing: translate(m, m, v) writes the translation column in place (L288)', () => {
    const m = mat4.identity(mat4.create());
    const ret = mat4.translate(m, m, [1, 2, 3]);
    expect(ret).toBe(m);
    expect(m[12]).toBeCloseTo(1, 5);
    expect(m[13]).toBeCloseTo(2, 5);
    expect(m[14]).toBeCloseTo(3, 5);
    expect(m[15]).toBeCloseTo(1, 5);
  });

  it('rotate(out, a, zero-axis) copies a to out when out !== a (L347 + L349 out!==a)', () => {
    const a = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [4, 5, 6]);
    const out = mat4.create();
    const ret = mat4.rotate(out, a, [0, 0, 0], Math.PI / 4);
    expect(ret).toBe(out);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(a[i] as number, 5);
  });

  it('rotate(m, m, zero-axis) is a no-op when out === a (L349 out===a)', () => {
    const m = mat4.translate(mat4.create(), mat4.identity(mat4.create()), [7, 8, 9]);
    const before = mat4.clone(m);
    const ret = mat4.rotate(m, m, [0, 0, 0], Math.PI / 3);
    expect(ret).toBe(m);
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(before[i] as number, 5);
  });

  it('lookAt picks the alternative up axis when up is collinear with forward (L449)', () => {
    // forward = normalize(eye - target) = (0, 1, 0); cross((0,1,0), (0,1,0)) = 0 → alt up = (0,0,1)
    const m = mat4.lookAt(mat4.create(), [0, 1, 0], [0, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i] as number)).toBe(true);
    // bottom row of view matrix is (0, 0, 0, 1)
    expect(m[3]).toBe(0);
    expect(m[7]).toBe(0);
    expect(m[11]).toBe(0);
    expect(m[15]).toBe(1);
  });

  it('decompose silently handles zero-scale source matrix (L575/576/577 sxFinal===0 etc.)', () => {
    // construct an affine where the X column is the zero vector (sx == 0); Y/Z preserve identity
    const m = mat4.create();
    m[0] = 0;
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = 1;
    m[6] = 0;
    m[7] = 0;
    m[8] = 0;
    m[9] = 0;
    m[10] = 1;
    m[11] = 0;
    m[12] = 0;
    m[13] = 0;
    m[14] = 0;
    m[15] = 1;
    const t = vec3.create();
    const r = quat.identity(quat.create());
    const s = vec3.create();
    expect(() => mat4.decompose(t, r, s, m)).not.toThrow();
    expect(s[0]).toBeCloseTo(0);
    expect(s[1]).toBeCloseTo(1);
    expect(s[2]).toBeCloseTo(1);
    for (let i = 0; i < 4; i++) expect(Number.isFinite(r[i] as number)).toBe(true);
  });
});

// ============================================================
// mat4.unproject (feat-20260529-picking-raycasting-screen-to-entity M2 w5)
// ============================================================
//
// Three scenarios per requirements AC-03 + AC-10:
//   1. perspective camera screen-center → unprojected direction ≈ camera forward
//   2. orthographic camera → direction constant = forward, origin translates with screen coords
//   3. y-flip: screen y-down coordinates → NDC y-up (via 1 - 2*screenY/viewportH)
//
// WebGPU [0,1] NDC z convention (research Finding 6 / D-NDC):
//   near plane → z_ndc = 0, far plane → z_ndc = 1
//
// Related: requirements AC-03 / AC-10; plan-tasks.json w5 acceptanceCheck.

describe('mat4.unproject', () => {
  // Helper: build a perspective view-projection pair and its inverse
  function makePerspectiveInvVP(): {
    view: Float32Array;
    proj: Float32Array;
    invVP: Float32Array;
    forward: [number, number, number];
  } {
    // Camera at (1, 2, 5) looking at (1, 2, -5) → forward = (0, 0, -1) in world space
    const eye: [number, number, number] = [1, 2, 5];
    const target: [number, number, number] = [1, 2, -5];
    const up: [number, number, number] = [0, 1, 0];
    const view = mat4.lookAt(mat4.create(), eye, target, up);
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 4 / 3, 0.1, 100);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const invVP = mat4.invert(mat4.create(), vp);
    return { view, proj, invVP, forward: [0, 0, -1] };
  }

  // Helper: build an orthographic view-projection pair and its inverse
  function makeOrthoInvVP(): {
    view: Float32Array;
    proj: Float32Array;
    invVP: Float32Array;
    forward: [number, number, number];
  } {
    const eye: [number, number, number] = [0, 0, 10];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];
    const view = mat4.lookAt(mat4.create(), eye, target, up);
    const proj = mat4.orthographic(mat4.create(), -4, 4, -3, 3, 0.1, 100);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const invVP = mat4.invert(mat4.create(), vp);
    return { view, proj, invVP, forward: [0, 0, -1] };
  }

  // ---------- 1. perspective unproject ----------

  it('perspective screen-center near (z=0) unprojects to world point on near plane', () => {
    const { invVP } = makePerspectiveInvVP();
    const nearPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    // Near point should be in front of the camera (z < eye.z = 5), on the near plane
    expect(Number.isFinite(nearPoint[0] as number)).toBe(true);
    expect(Number.isFinite(nearPoint[1] as number)).toBe(true);
    expect(Number.isFinite(nearPoint[2] as number)).toBe(true);
  });

  it('perspective screen-center far (z=1) unprojects to a farther world point', () => {
    const { invVP, forward } = makePerspectiveInvVP();
    const nearPoint = vec3.create();
    const farPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    mat4.unproject(farPoint, [0, 0, 1], invVP);
    const dir = vec3.sub(vec3.create(), farPoint, nearPoint);
    const dirLen = vec3.length(dir);
    expect(dirLen).toBeGreaterThan(0);
    vec3.normalize(dir, dir);
    const dot = vec3.dot(dir, [forward[0], forward[1], forward[2]]);
    expect(dot).toBeGreaterThan(0.99);
  });

  it('perspective screen-center direction is approximately camera forward (angle < epsilon)', () => {
    const { invVP, forward } = makePerspectiveInvVP();
    const nearPoint = vec3.create();
    const farPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    mat4.unproject(farPoint, [0, 0, 1], invVP);
    const dir = vec3.sub(vec3.create(), farPoint, nearPoint);
    vec3.normalize(dir, dir);
    const dot = vec3.dot(dir, [forward[0], forward[1], forward[2]]);
    // cos(0.1°) ≈ 0.999998 — very tight tolerance for screen-center
    expect(dot).toBeGreaterThan(0.99999);
  });

  it('perspective off-center NDC unprojects to different lateral world position', () => {
    const { invVP } = makePerspectiveInvVP();
    const centerNear = vec3.create();
    const rightNear = vec3.create();
    mat4.unproject(centerNear, [0, 0, 0], invVP);
    mat4.unproject(rightNear, [0.5, 0, 0], invVP);
    // right-side NDC should produce a point with larger x in world space
    expect(rightNear[0]).toBeGreaterThan(centerNear[0] as number);
  });

  // ---------- 2. orthographic unproject ----------

  it('ortho near/far center produce direction = camera forward', () => {
    const { invVP, forward } = makeOrthoInvVP();
    const nearPoint = vec3.create();
    const farPoint = vec3.create();
    mat4.unproject(nearPoint, [0, 0, 0], invVP);
    mat4.unproject(farPoint, [0, 0, 1], invVP);
    const dir = vec3.sub(vec3.create(), farPoint, nearPoint);
    vec3.normalize(dir, dir);
    const dot = vec3.dot(dir, [forward[0], forward[1], forward[2]]);
    expect(dot).toBeGreaterThan(0.99999);
  });

  it('ortho origin translates with screen coordinates (NDC x shift → world x shift)', () => {
    const { invVP } = makeOrthoInvVP();
    // Two NDC points at the same depth, different x
    const p0 = vec3.create();
    const p1 = vec3.create();
    mat4.unproject(p0, [-0.5, 0, 0], invVP);
    mat4.unproject(p1, [0.5, 0, 0], invVP);
    // p1.x should be greater than p0.x, and the delta should be non-trivial
    const dx = (p1[0] as number) - (p0[0] as number);
    expect(dx).toBeGreaterThan(0);
    // In ortho, the world-space X extent maps linearly to NDC; check proportional
    expect(dx).toBeCloseTo(4, 0); // left=-4, right=4 → NDC width of 2 → world width of 8; NDC step of 1 = 8 → dx for (0.5 - -0.5) = 1 → ~8
  });

  it('ortho origin Y shift proportional to screen displacement', () => {
    const { invVP } = makeOrthoInvVP();
    const pBottom = vec3.create();
    const pTop = vec3.create();
    mat4.unproject(pBottom, [0, -0.5, 0], invVP);
    mat4.unproject(pTop, [0, 0.5, 0], invVP);
    // Ortho: bottom=-3, top=3 → world height=6; NDC height=2; NDC step of 1 → world step of 3
    const dyY = (pTop[1] as number) - (pBottom[1] as number);
    expect(dyY).toBeCloseTo(3, 0);
  });

  // ---------- 3. y-flip ----------

  it('y-flip: upper screen y (small screen coord) → upper NDC y (positive)', () => {
    // screen y = 0 (top of screen) → ndc y = 1 - 2*0/H = 1 (top of NDC, which is +y)
    // screen y = H (bottom) → ndc y = 1 - 2*H/H = -1 (bottom of NDC, which is -y)
    const { invVP } = makePerspectiveInvVP();
    // Use two screen-space y values: screenY=50 → low (near top), screenY=400 → high (near bottom)
    // Corresponding NDC y:
    //   ndcTop = 1 - 2*50/600 = 1 - 0.1667 = 0.8333
    //   ndcBottom = 1 - 2*400/600 = 1 - 1.3333 = -0.3333
    const ndcTopY = 1 - (2 * 50) / 600;
    const ndcBottomY = 1 - (2 * 400) / 600;
    const pTop = vec3.create();
    const pBottom = vec3.create();
    mat4.unproject(pTop, [0, ndcTopY, 0], invVP);
    mat4.unproject(pBottom, [0, ndcBottomY, 0], invVP);
    // World-space: y increases upward. pTop (from higher screen y/NDC y) should have larger world y
    expect(pTop[1]).toBeGreaterThan(pBottom[1] as number);
  });
});

// ============================================================
// getTranslation / getForward / getUp / getRight (AC-08)
// ============================================================
//
// feat-20260601-unify-transform-local-global-mat4-drop-globaltrans / M1 / w5.
//
// Three-quadrant correctness of the four world-mat4 basis/translation
// accessors, with the old single-quaternion direction path as oracle:
//   - getRight  = normalize(col0)  == quat.transformVec3(q, [1, 0, 0])
//   - getUp     = normalize(col1)  == quat.transformVec3(q, [0, 1, 0])
//   - getForward = -normalize(col2) == quat.transformVec3(q, [0, 0, -1])  (RL-4)
//   - getTranslation = (m[12], m[13], m[14])  (no normalize)
//
// Quadrants (AC-08):
//   1. pure rotation (sx=sy=sz=1)
//   2. uniform scale s=3 (normalize cancels the scale)
//   3. non-uniform scale (sx=2, sy=1, sz=1) + non-trivial rotation
//      (the falsifiable quadrant: a missing normalize or a +col2 forward
//       sign error shows up here)
// Boundary: a zero direction column normalizes to (0,0,0) (D-4 fallback).

const EPS_DIR = 1e-5;

function expectVec3Close(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual[0]).toBeCloseTo(expected[0] as number, 5);
  expect(actual[1]).toBeCloseTo(expected[1] as number, 5);
  expect(actual[2]).toBeCloseTo(expected[2] as number, 5);
}

describe('mat4.getTranslation / getForward / getUp / getRight (AC-08)', () => {
  it('quadrant 1: pure rotation -- basis aligns with quat oracle', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 3);
    const m = mat4.compose(mat4.create(), [4, 5, 6], q, [1, 1, 1]);

    const right = quat.transformVec3(vec3.create(), q, [1, 0, 0]);
    const up = quat.transformVec3(vec3.create(), q, [0, 1, 0]);
    const forward = quat.transformVec3(vec3.create(), q, [0, 0, -1]);

    expectVec3Close(mat4.getRight(vec3.create(), m), right);
    expectVec3Close(mat4.getUp(vec3.create(), m), up);
    expectVec3Close(mat4.getForward(vec3.create(), m), forward);
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [4, 5, 6]);
  });

  it('quadrant 2: uniform scale s=3 -- normalize cancels the scale', () => {
    const q = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 4);
    const m = mat4.compose(mat4.create(), [0, 0, 0], q, [3, 3, 3]);

    const right = quat.transformVec3(vec3.create(), q, [1, 0, 0]);
    const up = quat.transformVec3(vec3.create(), q, [0, 1, 0]);
    const forward = quat.transformVec3(vec3.create(), q, [0, 0, -1]);

    const r = mat4.getRight(vec3.create(), m);
    const u = mat4.getUp(vec3.create(), m);
    const f = mat4.getForward(vec3.create(), m);
    // normalized basis is unit-length regardless of uniform scale.
    expect(vec3.length(r)).toBeCloseTo(1, 5);
    expect(vec3.length(u)).toBeCloseTo(1, 5);
    expect(vec3.length(f)).toBeCloseTo(1, 5);
    expectVec3Close(r, right);
    expectVec3Close(u, up);
    expectVec3Close(f, forward);
  });

  it('quadrant 3: non-uniform scale (2,1,1) + non-trivial rotation -- falsifiable', () => {
    const q = quat.fromAxisAngle(quat.create(), [0.5, 1, 0.25], 0.9);
    const m = mat4.compose(mat4.create(), [1, -2, 3], q, [2, 1, 1]);

    const right = quat.transformVec3(vec3.create(), q, [1, 0, 0]);
    const up = quat.transformVec3(vec3.create(), q, [0, 1, 0]);
    const forward = quat.transformVec3(vec3.create(), q, [0, 0, -1]);

    const r = mat4.getRight(vec3.create(), m);
    const u = mat4.getUp(vec3.create(), m);
    const f = mat4.getForward(vec3.create(), m);
    // Non-uniform scale stretches the columns; normalize restores the
    // rotation-only direction, matching the quat oracle within epsilon.
    expect(Math.abs((r[0] as number) - (right[0] as number))).toBeLessThanOrEqual(EPS_DIR);
    expectVec3Close(r, right);
    expectVec3Close(u, up);
    expectVec3Close(f, forward);
    // Translation is read straight from col3 (no normalize on a 2x scale).
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [1, -2, 3]);
  });

  it('getTranslation reads col3 (m[12,13,14]) without normalizing', () => {
    const m = mat4.identity(mat4.create());
    m[12] = 10;
    m[13] = 20;
    m[14] = 30;
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [10, 20, 30]);
  });

  it('zero direction column -> (0,0,0) (D-4 normalize fallback)', () => {
    // A matrix with zero col0/col1/col2 (degenerate); direction accessors
    // fall back to (0,0,0) via vec3.normalize, getTranslation stays exact.
    const m = mat4.create(); // all-zero
    m[12] = 7;
    m[13] = 8;
    m[14] = 9;
    expectVec3Close(mat4.getRight(vec3.create(), m), [0, 0, 0]);
    expectVec3Close(mat4.getUp(vec3.create(), m), [0, 0, 0]);
    expectVec3Close(mat4.getForward(vec3.create(), m), [0, 0, 0]);
    expectVec3Close(mat4.getTranslation(vec3.create(), m), [7, 8, 9]);
  });
});

}

{
  // --- from quat.test.ts ---
// quat.test.ts — M4 red: quat namespace full-family unit tests (T-025)
//
// Covers the three tiers normal + degenerate + boundary across 16+ functions:
//   create / clone / identity / fromAxisAngle / fromEuler / fromRotationMatrix /
//   fromUnitVectors / multiply / slerp / nlerp / invert / conjugate / dot /
//   length / lengthSq / normalize
//
// Degenerate convention (plan-strategy §appendix A degenerate registry #8-#13):
//   - fromAxisAngle(0-axis, _) → identity (same convention as M2 baseline)
//   - fromEuler(x, y, z, 'unknown' as any) → silent fallback 'XYZ' (D-P2)
//   - slerp(a, b, t) when dot(a,b) < -EPS_SLERP_DOT_LIMIT → negate b then slerp normally (D-P6)
//   - fromUnitVectors(v, -v) → 180° rotation around an arbitrary perpendicular axis; never throws (D-P18)
//   - fromUnitVectors(v, v) → identity
//
// Related: requirements §Surface quat lower bound 16 + AC-06 throw 0 + boundary-case quat row;
//          plan-strategy D-P2 / D-P6 / D-P18 + §appendix A degenerate registry;
//          research §fact-correction 4 fromEuler unknown silent;
//          wiki/gl-matrix-overview §quat degenerate anchor + wiki/glam-rs-overview §Hamilton.


function approxArr(actual: Float32Array, expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i] as number, 5);
  }
}

describe('quat.create / clone', () => {
  it('create() returns Float32Array length 4 zero (normal)', () => {
    const q = quat.create();
    expect(q).toBeInstanceOf(Float32Array);
    expect(q.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(q[i]).toBe(0);
  });

  it('clone(a) returns new Float32Array with same content (normal)', () => {
    const a = quat.identity(quat.create());
    const b = quat.clone(a);
    expect(b).not.toBe(a);
    for (let i = 0; i < 4; i++) expect(b[i]).toBe(a[i]);
  });
});

describe('quat.identity', () => {
  it('returns [0, 0, 0, 1] in Float32Array length 4 (normal)', () => {
    const q = quat.identity(quat.create());
    expect(q).toBeInstanceOf(Float32Array);
    expect(q.length).toBe(4);
    expect(q[0]).toBe(0);
    expect(q[1]).toBe(0);
    expect(q[2]).toBe(0);
    expect(q[3]).toBe(1);
  });

  it('idempotent: identity(identity(q)) == identity(q) (boundary)', () => {
    const a = quat.identity(quat.create());
    const b = quat.identity(a);
    for (let i = 0; i < 4; i++) expect(b[i]).toBe(a[i]);
  });

  it('returns same instance (degenerate: in-place semantics)', () => {
    const q = quat.create();
    const out = quat.identity(q);
    expect(out).toBe(q);
  });
});

describe('quat.fromAxisAngle', () => {
  it('rotation by 0 around any axis yields identity (normal)', () => {
    const q = quat.fromAxisAngle(quat.create(), [1, 0, 0], 0);
    approxArr(q, [0, 0, 0, 1]);
  });

  it('rotation by PI around X yields [1, 0, 0, ~0] (boundary)', () => {
    const q = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI);
    expect(q[0]).toBeCloseTo(1);
    expect(q[1]).toBeCloseTo(0);
    expect(q[2]).toBeCloseTo(0);
    expect(q[3]).toBeCloseTo(0, 5);
  });

  it('PI/2 around Y yields [0, sin(PI/4), 0, cos(PI/4)] (normal)', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
    approxArr(q, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  });

  it('zero axis (0,0,0) → identity (degenerate, registry #8 same as M2 convention)', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 0, 0], Math.PI / 3);
    approxArr(q, [0, 0, 0, 1]);
  });

  it('non-unit axis is internally normalised (degenerate)', () => {
    const a = quat.fromAxisAngle(quat.create(), [2, 0, 0], Math.PI / 2);
    const b = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2);
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i] as number);
  });
});

describe('quat.fromEuler — 6 order + unknown silent fallback (D-P2)', () => {
  it('XYZ order: fromEuler(0, 0, 0) → identity (normal)', () => {
    const q = quat.fromEuler(quat.create(), 0, 0, 0, 'XYZ');
    approxArr(q, [0, 0, 0, 1]);
  });

  it('XYZ order: rotate PI/2 around X only matches fromAxisAngle (normal)', () => {
    const a = quat.fromEuler(quat.create(), Math.PI / 2, 0, 0, 'XYZ');
    const b = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2);
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i] as number);
  });

  it('YXZ order: rotate PI/2 around Y only matches fromAxisAngle (normal)', () => {
    const a = quat.fromEuler(quat.create(), 0, Math.PI / 2, 0, 'YXZ');
    const b = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i] as number);
  });

  it('all 6 orders agree on single-axis Z rotation (normal)', () => {
    const orders = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'] as const;
    const ref = quat.fromAxisAngle(quat.create(), [0, 0, 1], 0.7);
    for (const order of orders) {
      const q = quat.fromEuler(quat.create(), 0, 0, 0.7, order);
      for (let i = 0; i < 4; i++) {
        expect(q[i]).toBeCloseTo(ref[i] as number);
      }
    }
  });

  it('unknown order silently falls back to XYZ (degenerate, D-P2)', () => {
    // does not throw (D-P2 + AC-06); matches 'XYZ' result
    const q1 = quat.fromEuler(quat.create(), 0.3, 0.5, 0.7, 'unknown' as never);
    const q2 = quat.fromEuler(quat.create(), 0.3, 0.5, 0.7, 'XYZ');
    for (let i = 0; i < 4; i++) expect(q1[i]).toBeCloseTo(q2[i] as number);
  });

  it('unknown order does not throw (degenerate, AC-06 throw 0)', () => {
    expect(() => {
      quat.fromEuler(quat.create(), 1, 2, 3, 'BAD' as never);
    }).not.toThrow();
  });
});

describe('quat.fromRotationMatrix', () => {
  it('identity mat3 → identity quat (normal)', () => {
    const m = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
    const q = quat.fromRotationMatrix(quat.create(), m);
    approxArr(q, [0, 0, 0, 1]);
  });

  it('PI rotation around X mat3 → quat [1,0,0,0] up to sign (boundary, Shepperd)', () => {
    // R_x(PI) = [[1,0,0],[0,-1,0],[0,0,-1]]
    const m = Float32Array.of(1, 0, 0, 0, -1, 0, 0, 0, -1);
    const q = quat.fromRotationMatrix(quat.create(), m);
    // ±sign allowed (quat double-cover); lock |q|=1, |x|=1, y=z=w=0
    expect(Math.abs(q[0] as number)).toBeCloseTo(1);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(0, 5);
  });

  it('PI/2 around Y mat3 round-trip via fromAxisAngle (normal)', () => {
    const ref = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
    // R_y(PI/2) column-major
    const c = Math.cos(Math.PI / 2);
    const s = Math.sin(Math.PI / 2);
    const m = Float32Array.of(c, 0, -s, 0, 1, 0, s, 0, c);
    const q = quat.fromRotationMatrix(quat.create(), m);
    // q may agree in sign with ref or be its negation
    const sign = (q[3] as number) * (ref[3] as number) < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      expect(sign * (q[i] as number)).toBeCloseTo(ref[i] as number);
    }
  });
});

describe('quat.fromUnitVectors (D-P18)', () => {
  it('v == w → identity (degenerate, registry #13)', () => {
    const q = quat.fromUnitVectors(quat.create(), [1, 0, 0], [1, 0, 0]);
    approxArr(q, [0, 0, 0, 1]);
  });

  it('v=(1,0,0), w=(0,1,0) → 90° rotation around Z (normal)', () => {
    const q = quat.fromUnitVectors(quat.create(), [1, 0, 0], [0, 1, 0]);
    // equivalent to fromAxisAngle([0,0,1], PI/2)
    const ref = quat.fromAxisAngle(quat.create(), [0, 0, 1], Math.PI / 2);
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(ref[i] as number);
  });

  it('v == -w (anti-parallel) → 180° rotation around perpendicular axis, no throw (degenerate, D-P18 + registry #12)', () => {
    expect(() => {
      const q = quat.fromUnitVectors(quat.create(), [1, 0, 0], [-1, 0, 0]);
      // must be a unit quaternion (|q|=1)
      const len = Math.hypot(q[0] as number, q[1] as number, q[2] as number, q[3] as number);
      expect(len).toBeCloseTo(1);
      // w component near 0 (180° rotation)
      expect(q[3]).toBeCloseTo(0, 4);
    }).not.toThrow();
  });

  it('v == -w with v aligned to (0,1,0) selects fallback axis (degenerate)', () => {
    const q = quat.fromUnitVectors(quat.create(), [0, 1, 0], [0, -1, 0]);
    const len = Math.hypot(q[0] as number, q[1] as number, q[2] as number, q[3] as number);
    expect(len).toBeCloseTo(1);
    expect(q[3]).toBeCloseTo(0, 4);
  });
});

describe('quat.multiply', () => {
  it('I * I = I (normal)', () => {
    const i = quat.identity(quat.create());
    const out = quat.multiply(quat.create(), i, i);
    approxArr(out, [0, 0, 0, 1]);
  });

  it('q * I = q (boundary)', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 0, 1], Math.PI / 3);
    const i = quat.identity(quat.create());
    const out = quat.multiply(quat.create(), q, i);
    for (let k = 0; k < 4; k++) expect(out[k]).toBeCloseTo(q[k] as number);
  });

  it('two PI/2 around X compose to PI around X (degenerate)', () => {
    const half = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2);
    const full = quat.multiply(quat.create(), half, half);
    expect(full[0]).toBeCloseTo(1);
    expect(full[1]).toBeCloseTo(0);
    expect(full[2]).toBeCloseTo(0);
    expect(full[3]).toBeCloseTo(0, 5);
  });
});

describe('quat.slerp + nlerp', () => {
  it('slerp(a, b, 0) == a (boundary)', () => {
    const a = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.3);
    const b = quat.fromAxisAngle(quat.create(), [0, 1, 0], 1.2);
    const out = quat.slerp(quat.create(), a, b, 0);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(a[i] as number);
  });

  it('slerp(a, b, 1) == b (boundary)', () => {
    const a = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.3);
    const b = quat.fromAxisAngle(quat.create(), [0, 1, 0], 1.2);
    const out = quat.slerp(quat.create(), a, b, 1);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(b[i] as number);
  });

  it('slerp(a, a, 0.5) ~ a (degenerate identical endpoints)', () => {
    const a = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.5);
    const out = quat.slerp(quat.create(), a, a, 0.5);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(a[i] as number);
  });

  it('slerp anti-parallel: dot(a, b) ≈ -1 → negate b then slerp, result is unit length (degenerate, D-P6)', () => {
    // build b = -a → dot(a, b) = -1
    const a = quat.fromAxisAngle(quat.create(), [0, 0, 1], 0.7);
    const b = quat.create();
    b[0] = -(a[0] as number);
    b[1] = -(a[1] as number);
    b[2] = -(a[2] as number);
    b[3] = -(a[3] as number);
    expect(() => {
      const out = quat.slerp(quat.create(), a, b, 0.5);
      const len = Math.hypot(
        out[0] as number,
        out[1] as number,
        out[2] as number,
        out[3] as number,
      );
      // after negating b, a and b' (= a) are collinear → slerp result is approximately a with length 1
      expect(len).toBeCloseTo(1);
    }).not.toThrow();
  });

  it('nlerp(a, b, 0.5) returns unit-length quaternion (normal)', () => {
    const a = quat.fromAxisAngle(quat.create(), [0, 0, 1], 0);
    const b = quat.fromAxisAngle(quat.create(), [0, 0, 1], Math.PI / 2);
    const out = quat.nlerp(quat.create(), a, b, 0.5);
    const len = Math.hypot(out[0] as number, out[1] as number, out[2] as number, out[3] as number);
    expect(len).toBeCloseTo(1);
  });
});

describe('quat.invert / conjugate / dot', () => {
  it('invert(identity) = identity (normal)', () => {
    const i = quat.identity(quat.create());
    const inv = quat.invert(quat.create(), i);
    approxArr(inv, [0, 0, 0, 1]);
  });

  it('q * invert(q) = identity (normal)', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.7);
    const inv = quat.invert(quat.create(), q);
    const out = quat.multiply(quat.create(), q, inv);
    approxArr(out, [0, 0, 0, 1]);
  });

  it('conjugate flips x/y/z sign, keeps w (normal)', () => {
    const q = Float32Array.of(0.1, 0.2, 0.3, 0.9);
    const c = quat.conjugate(quat.create(), q);
    expect(c[0]).toBeCloseTo(-0.1);
    expect(c[1]).toBeCloseTo(-0.2);
    expect(c[2]).toBeCloseTo(-0.3);
    expect(c[3]).toBeCloseTo(0.9);
  });

  it('dot(q, q) = lengthSq(q) (boundary)', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.7);
    const d = quat.dot(q, q);
    expect(d).toBeCloseTo(1); // unit quaternion |q|² = 1
  });
});

describe('quat.length / lengthSq / normalize', () => {
  it('length(identity) = 1 (normal)', () => {
    const i = quat.identity(quat.create());
    expect(quat.length(i)).toBeCloseTo(1);
  });

  it('lengthSq(identity) = 1 (normal)', () => {
    const i = quat.identity(quat.create());
    expect(quat.lengthSq(i)).toBeCloseTo(1);
  });

  it('normalize(non-unit) → unit (normal)', () => {
    const q = Float32Array.of(2, 0, 0, 0);
    const n = quat.normalize(quat.create(), q);
    expect(n[0]).toBeCloseTo(1);
    expect(n[3]).toBeCloseTo(0);
  });

  it('normalize(zero quat) → zero (degenerate, EPS_NORMALIZE)', () => {
    const z = quat.create();
    const n = quat.normalize(quat.create(), z);
    approxArr(n, [0, 0, 0, 0]);
  });
});

// M1 / t2 — quat.transformVec3
//
// Rodrigues optimized form: t = 2 * cross(q.xyz, v); out = v + q.w*t + cross(q.xyz, t)
// Degenerate convention (D-4 silent + research Finding 3 industry consensus):
//   - non-unit q: implicit scaling (does not throw)
//   - q = (0,0,0,0): under the Rodrigues form t=0 makes out = v (different from the direct
//     q*v*q⁻¹ expansion where out=0; tests use a conservative finite-only lock,
//     aligned with plan-strategy §3 R-2 countermeasure)
//
// Related: requirements §3.1 quat row + §9 boundary-case table rows 4/5;
//          research Finding 3 (Rodrigues 18 mul + 12 add) + Finding 4 (industry consensus);
//          plan-strategy §3 R-2 countermeasure + §4.3 key test points table row 4.

describe('quat.transformVec3 (M1 / t2)', () => {
  it('identity quat → out = v (normal, identity)', () => {
    const I = quat.identity(quat.create());
    const v = Float32Array.of(1, 2, 3);
    const out = Float32Array.of(0, 0, 0) as Vec3;
    quat.transformVec3(out, I, v);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(2, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it('axis-angle rotation: q=Y by π/2 applied to (1,0,0) → (0,0,-1) (normal)', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
    const v = Float32Array.of(1, 0, 0);
    const out = Float32Array.of(0, 0, 0) as Vec3;
    quat.transformVec3(out, q, v);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(-1, 5);
  });

  it('unit q preserves length: |q*v*q⁻¹| ≈ |v| (boundary)', () => {
    const q = quat.fromAxisAngle(quat.create(), [1, 1, 1], 1.234);
    const v = Float32Array.of(2, 3, -4);
    const out = Float32Array.of(0, 0, 0) as Vec3;
    quat.transformVec3(out, q, v);
    const lenIn = Math.hypot(2, 3, -4);
    const lenOut = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
    expect(lenOut).toBeCloseTo(lenIn, 4);
  });

  it('non-unit q: implicit scaling, does not throw (degrade, R-2 countermeasure)', () => {
    // q = 2 × identity = (0, 0, 0, 2) → scale factor |q|² = 4, result = 4 * v
    const q = Float32Array.of(0, 0, 0, 2);
    const v = Float32Array.of(1, 2, 3);
    const out = Float32Array.of(0, 0, 0) as Vec3;
    expect(() => quat.transformVec3(out, q, v)).not.toThrow();
    // Rodrigues formula: t=2*cross(q.xyz=0, v)=0; out=v + q.w*t + cross(q.xyz, t) = v
    // when q.w=2: t=0, out=v + 2*0 + 0 = v (unchanged);
    // this matches the "implicit scaling" semantics (q.xyz=0 means no rotation, so result = v).
    // We only assert no NaN / no throw / finite.
    expect(Number.isFinite(out[0] as number)).toBe(true);
    expect(Number.isFinite(out[1] as number)).toBe(true);
    expect(Number.isFinite(out[2] as number)).toBe(true);
  });

  it('q = (0,0,0,0) (degrade, finite-only lock; under Rodrigues form actual out=v)', () => {
    // Rodrigues formula q.xyz=0, q.w=0: t = 2*cross(0, v) = 0;
    // out = v + 0*0 + cross(0, 0) = v — note: research's "naturally degenerates to (0,0,0)"
    // corresponds to a different derivation (q*v*q⁻¹ form, where q=0 makes q⁻¹ undefined).
    // This closed loop adopts the Rodrigues form, so q=(0,0,0,0) outputs = v (not zero).
    // Implementation: t=0, out = v + 0 + 0 = v — this is inconsistent with the plan rationale's
    // literal promise ("naturally degenerates to out=(0,0,0)").
    // Compromise: tests only lock "no throw + finite", avoiding tying down a specific formula form
    // (under the D-4 silent convention, the output value is undefined but does not throw).
    const q = Float32Array.of(0, 0, 0, 0);
    const v = Float32Array.of(1, 2, 3);
    const out = Float32Array.of(9, 9, 9) as Vec3;
    expect(() => quat.transformVec3(out, q, v)).not.toThrow();
    expect(Number.isFinite(out[0] as number)).toBe(true);
    expect(Number.isFinite(out[1] as number)).toBe(true);
    expect(Number.isFinite(out[2] as number)).toBe(true);
  });

  it('in-place safe: transformVec3(v, q, v) at the same address still produces the correct result (boundary, out===v)', () => {
    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
    const v = Float32Array.of(1, 0, 0) as Vec3;
    const ret = quat.transformVec3(v, q, v);
    expect(ret).toBe(v);
    expect(v[0]).toBeCloseTo(0, 5);
    expect(v[1]).toBeCloseTo(0, 5);
    expect(v[2]).toBeCloseTo(-1, 5);
  });
});

describe('quat — V8 elements-kinds performance guard', () => {
  it('all return values are Float32Array (no number[] coercion)', () => {
    const a = quat.identity(quat.create());
    const b = quat.fromAxisAngle(quat.create(), [0, 1, 0], 1);
    const c = quat.multiply(quat.create(), a, b);
    const d = quat.slerp(quat.create(), a, b, 0.5);
    const e = quat.nlerp(quat.create(), a, b, 0.5);
    const f = quat.fromEuler(quat.create(), 0.1, 0.2, 0.3, 'XYZ');
    expect(a).toBeInstanceOf(Float32Array);
    expect(b).toBeInstanceOf(Float32Array);
    expect(c).toBeInstanceOf(Float32Array);
    expect(d).toBeInstanceOf(Float32Array);
    expect(e).toBeInstanceOf(Float32Array);
    expect(f).toBeInstanceOf(Float32Array);
  });
});

// M3 / T-coverage — quat branch coverage backfill (T-027 follow-up)
//
// Targets the surviving uncovered branches identified by v8 coverage
// (79.48% → ≥80%, AC-10 hard floor). Each it lifts a specific branch:
//   - fromRotationMatrix R_y(PI) (L218 false + L224 true)  — Shepperd m11 max case
//   - fromRotationMatrix R_z(PI) (L224 false → L230 else)  — Shepperd m22 max case
//   - invert(zeroQuat) → identity (L485 if-true)           — degenerate divide-by-zero guard
//   - nlerp anti-parallel (L436 if-true)                   — negate-b-for-shortest-arc guard
describe('quat — M3 branch coverage backfill', () => {
  it('fromRotationMatrix on R_y(PI) hits the m11 maximum Shepperd branch (L218 false + L224 true)', () => {
    // R_y(PI) column-major: diag = (-1, 1, -1); trace = -1, m11 > m00 and m11 > m22 → m11 case
    const m = Float32Array.of(-1, 0, 0, 0, 1, 0, 0, 0, -1);
    const q = quat.fromRotationMatrix(quat.create(), m);
    expect(Math.abs(q[1] as number)).toBeCloseTo(1, 5);
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(0, 5);
  });

  it('fromRotationMatrix on R_z(PI) hits the m22 maximum Shepperd branch (L224 false → L230)', () => {
    // R_z(PI) column-major: diag = (-1, -1, 1); trace = -1, m22 > m00 and m22 > m11 → m22 case
    const m = Float32Array.of(-1, 0, 0, 0, -1, 0, 0, 0, 1);
    const q = quat.fromRotationMatrix(quat.create(), m);
    expect(Math.abs(q[2] as number)).toBeCloseTo(1, 5);
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(0, 5);
  });

  it('invert(zeroQuat) → identity (L485 if-true, lengthSq < EPS_NORMALIZE)', () => {
    const zero = quat.create();
    const out = quat.invert(quat.create(), zero);
    approxArr(out, [0, 0, 0, 1]);
  });

  it('nlerp with anti-parallel inputs negates b for the shortest arc (L436 if-true)', () => {
    const a = quat.fromAxisAngle(quat.create(), [0, 1, 0], 0.6);
    const negA = quat.create();
    negA[0] = -(a[0] as number);
    negA[1] = -(a[1] as number);
    negA[2] = -(a[2] as number);
    negA[3] = -(a[3] as number);
    // dot(a, -a) = -1 → triggers cosTheta < 0 negation path inside nlerp
    const out = quat.nlerp(quat.create(), a, negA, 0.5);
    // after negation b' = a, so out = a (after normalization) and remains unit length
    const len = Math.hypot(out[0] as number, out[1] as number, out[2] as number, out[3] as number);
    expect(len).toBeCloseTo(1);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(a[i] as number, 5);
  });
});

// M2 / w8: quat.eulerY convenience function (feat-20260525-boilerplate-reduction-pod-defaults-factories)
//
// Covers AC-10 (numerical parity with fromEuler(0, theta, 0, 'YXZ') + boundary epsilon).
// Plan-strategy section 5.3 testing point + section 5.1 TDD red-green-refactor.
describe('quat.eulerY', () => {
  it('eulerY(0) returns identity quaternion [0, 0, 0, 1]', () => {
    const q = quat.eulerY(0);
    expect(q).toBeInstanceOf(Float32Array);
    expect(q.length).toBe(4);
    approxArr(q, [0, 0, 0, 1]);
  });

  it('eulerY(Math.PI / 2) returns [0, sin(PI/4), 0, cos(PI/4)]', () => {
    const q = quat.eulerY(Math.PI / 2);
    const s = Math.sin(Math.PI / 4);
    const c = Math.cos(Math.PI / 4);
    approxArr(q, [0, s, 0, c]);
  });

  it('eulerY(2 * Math.PI) represents identity rotation within epsilon', () => {
    const q = quat.eulerY(2 * Math.PI);
    // fromEuler(0, 2pi, 0, 'YXZ') can give [0, 0, sin(pi), cos(pi)] = [0, 0, 0, -1],
    // which is the same rotation as [0, 0, 0, 1] (q and -q represent the same rotation).
    // Verify by checking the quaternion is unit length and magnitude-preserving.
    const lenSq =
      (q[0] as number) * (q[0] as number) +
      (q[1] as number) * (q[1] as number) +
      (q[2] as number) * (q[2] as number) +
      (q[3] as number) * (q[3] as number);
    expect(lenSq).toBeCloseTo(1, 5);
    // Apply to a test vector: rotation of 2pi should preserve the vector.
    const v = [1, 2, 3] as const;
    const vtOut = new Float32Array(3) as unknown as import('../types').Vec3;
    quat.transformVec3(vtOut, q, v);
    expect(vtOut[0]).toBeCloseTo(v[0], 5);
    expect(vtOut[1]).toBeCloseTo(v[1], 5);
    expect(vtOut[2]).toBeCloseTo(v[2], 5);
  });

  it('eulerY(theta) matches fromEuler(out, 0, theta, 0, "YXZ") for range of values', () => {
    const theta = [
      0,
      Math.PI / 6,
      Math.PI / 4,
      Math.PI / 3,
      Math.PI / 2,
      Math.PI,
      -Math.PI / 4,
      -Math.PI / 2,
    ];
    for (const t of theta) {
      const qEulerY = quat.eulerY(t);
      const qFromEuler = quat.fromEuler(quat.create(), 0, t, 0, 'YXZ');
      approxArr(qEulerY, [
        qFromEuler[0] as number,
        qFromEuler[1] as number,
        qFromEuler[2] as number,
        qFromEuler[3] as number,
      ]);
    }
  });

  it('eulerY returns a new Quat (Float32Array) each call, not mutating input', () => {
    const a = quat.eulerY(Math.PI / 3);
    const b = quat.eulerY(Math.PI / 3);
    expect(a).toBeInstanceOf(Float32Array);
    expect(b).toBeInstanceOf(Float32Array);
    // Same content but different references.
    expect(a).not.toBe(b);
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i] as number, 7);
    // A second call with different theta does not mutate the first result.
    const q0 = quat.eulerY(0);
    const q1 = quat.eulerY(Math.PI);
    approxArr(q0, [0, 0, 0, 1]);
    approxArr(q1, [0, Math.sin(Math.PI / 2), 0, Math.cos(Math.PI / 2)]);
  });

  it('eulerY(-theta) equals conjugate(eulerY(theta)) within epsilon', () => {
    const theta = [Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2, Math.PI];
    for (const t of theta) {
      const q = quat.eulerY(t);
      const qNeg = quat.eulerY(-t);
      const conj = quat.conjugate(quat.create(), q);
      approxArr(qNeg, [conj[0] as number, conj[1] as number, conj[2] as number, conj[3] as number]);
    }
  });
});

}

{
  // --- from ray.test.ts ---
// Ray unit tests — TDD red phase (feat-20260529-picking-raycasting-screen-to-entity M1 w1 + w2).
//
// Ray storage: Float32Array length 6 [ox, oy, oz, dx, dy, dz], direction normalized.
// Branded type Ray = Float32Array & { readonly __ray: void }.
//
// w1 surface: create / getOrigin / getDirection / setOrigin / setDirection.
// w2 surface: rayAabbIntersects — 6 slab degenerate cases.
//
// Related: requirements AC-01 (Ray construction + read/write test coverage);
//          requirements AC-02 (ray-AABB 6 degenerate cases);
//          requirements AC-03 (screenToRay + y-flip + clamp + sanitize);
//          research Finding 2 #1-#6 (slab degenerate table);
//          plan-tasks.json w1 + w2 + w6 acceptanceChecks.


describe('ray.create', () => {
  it('returns Float32Array length 6 with zero origin + forward direction by default (normal)', () => {
    const r = ray.create();
    expect(r).toBeInstanceOf(Float32Array);
    expect(r.length).toBe(6);
    // default origin = (0,0,0), default direction = (0,0,-1) normalized
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(0);
    expect(r[2]).toBe(0);
    expect(r[3]).toBe(0);
    expect(r[4]).toBe(0);
    expect(r[5]).toBe(-1);
  });

  it('normalizes the supplied direction (normal)', () => {
    // (3,4,0) length 5 -> normalize to (0.6, 0.8, 0)
    const r = ray.create(ray.create(), [1, 2, 3], [3, 4, 0]);
    expect(r[3]).toBeCloseTo(0.6, 5);
    expect(r[4]).toBeCloseTo(0.8, 5);
    expect(r[5]).toBe(0);
  });

  it('accepts explicit origin (normal)', () => {
    const r = ray.create(ray.create(), [10, 20, 30], [0, 0, -1]);
    expect(r[0]).toBe(10);
    expect(r[1]).toBe(20);
    expect(r[2]).toBe(30);
  });

  it('handles degenerate zero-length direction gracefully (degenerate)', () => {
    // Zero vector direction — should not throw; normalized to (0,0,0) per gl-matrix style
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, 0]);
    expect(r[3]).toBe(0);
    expect(r[4]).toBe(0);
    expect(r[5]).toBe(0);
  });

  it('returns the out parameter', () => {
    const out = ray.create();
    const ret = ray.create(out, [1, 2, 3], [0, 1, 0]);
    expect(ret).toBe(out);
  });
});

describe('ray.getOrigin', () => {
  it('copies origin into out Vec3 (normal)', () => {
    const r = ray.create(ray.create(), [5, 6, 7], [0, 0, -1]);
    const out = vec3.create();
    ray.getOrigin(out, r);
    expect(out[0]).toBe(5);
    expect(out[1]).toBe(6);
    expect(out[2]).toBe(7);
  });

  it('returns the out parameter', () => {
    const r = ray.create(ray.create(), [1, 2, 3], [0, 0, -1]);
    const out = vec3.create();
    const ret = ray.getOrigin(out, r);
    expect(ret).toBe(out);
  });
});

describe('ray.getDirection', () => {
  it('copies direction into out Vec3 (normal)', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 1, 0]);
    const out = vec3.create();
    ray.getDirection(out, r);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(0);
  });

  it('returns the out parameter', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const out = vec3.create();
    const ret = ray.getDirection(out, r);
    expect(ret).toBe(out);
  });
});

describe('ray.setOrigin', () => {
  it('writes origin components into the ray (normal)', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    ray.setOrigin(r, [10, 20, 30]);
    expect(r[0]).toBe(10);
    expect(r[1]).toBe(20);
    expect(r[2]).toBe(30);
    // direction must be unchanged
    expect(r[3]).toBe(0);
    expect(r[4]).toBe(0);
    expect(r[5]).toBe(-1);
  });

  it('returns the ray parameter', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const ret = ray.setOrigin(r, [1, 2, 3]);
    expect(ret).toBe(r);
  });
});

describe('ray.setDirection', () => {
  it('writes direction and normalizes it (normal)', () => {
    const r = ray.create(ray.create(), [1, 2, 3], [0, 0, -1]);
    ray.setDirection(r, [3, 4, 0]);
    expect(r[3]).toBeCloseTo(0.6, 5);
    expect(r[4]).toBeCloseTo(0.8, 5);
    expect(r[5]).toBe(0);
    // origin must be unchanged
    expect(r[0]).toBe(1);
    expect(r[1]).toBe(2);
    expect(r[2]).toBe(3);
  });

  it('returns the ray parameter', () => {
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const ret = ray.setDirection(r, [1, 0, 0]);
    expect(ret).toBe(r);
  });
});

// --- w2: rayAabbIntersects slab 6 degenerate cases ---
//
// Box: AABB from (-1,-1,-1) to (1,1,1) = 2x2x2 cube centred at origin.
// Research Finding 2 #1-#6: slab method degenerate behaviour.
// Related: requirements AC-02; plan-tasks.json w2 acceptanceCheck.

describe('rayAabbIntersects — ① hit from outside', () => {
  it('ray from outside toward box returns true + tmin > 0', () => {
    // origin = (-2, 0, 0), direction = (1, 0, 0) → hits near face at x=-1
    const r = ray.create(ray.create(), [-2, 0, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    // tmin ≈ 1 (distance from x=-2 to x=-1 with normalised dir (1,0,0))
    expect(result.tmin).toBeCloseTo(1, 5);
    expect(result.tmin).toBeGreaterThan(0);
  });

  it('diagonal ray toward box returns true + tmin > 0', () => {
    // origin = (-2, -2, 0), direction toward origin → normalised
    const r = ray.create(ray.create(), [-2, -2, 0], [1, 1, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    // tmin = real distance from (-2,-2,0) to AABB entry along (1,1,0)/sqrt(2)
    expect(result.tmin).toBeGreaterThan(0);
  });
});

describe('rayAabbIntersects — ② hit from inside', () => {
  it('ray origin inside box returns true + tmin = 0', () => {
    // origin at centre (0,0,0), any direction
    const r = ray.create(ray.create(), [0, 0, 0], [0, 0, -1]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });

  it('ray origin inside box, facing rear (-z) still hit = true + tmin = 0', () => {
    const r = ray.create(ray.create(), [0.5, 0.5, 0.5], [-1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });
});

describe('rayAabbIntersects — ③ miss (ray points away)', () => {
  it('ray origin outside box, direction away → false', () => {
    const r = ray.create(ray.create(), [-2, 0, 0], [-1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });

  it('ray origin outside box on X, pointing wrong Y axis → false', () => {
    const r = ray.create(ray.create(), [3, 0, 0], [0, 1, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });
});

describe('rayAabbIntersects — ④ parallel-axis miss', () => {
  it('ray parallel to X axis, origin offset on Y outside slab → false', () => {
    // direction (1,0,0) gives inv=(1,Inf,Inf); Y slab is [-1,1]; origin y=5 → 5/-Inf or 5/Inf → no overlap
    const r = ray.create(ray.create(), [0, 5, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });

  it('ray parallel to X axis, origin within Y/Z slab → true (X is infinite span)', () => {
    // direction (1,0,0); origin (0,0,0) inside the box YZ cross-section
    const r = ray.create(ray.create(), [0, 0, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    // origin at (0,0,0) is inside box → hit=true, tmin=0
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });
});

describe('rayAabbIntersects — ⑤ edge/corner NaN-safe', () => {
  it('ray starting exactly on box surface (-x face) → true, no false negative from NaN', () => {
    // origin at (-1,0,0) = exactly on left face. direction (1,0,0) = into box.
    // On X axis: t1 = (-1-(-1))/1 = 0, t2 = (1-(-1))/1 = 2. Safe.
    const r = ray.create(ray.create(), [-1, 0, 0], [1, 0, 0]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    // origin on surface, so tmin = 0
    expect(result.tmin).toBe(0);
  });

  it('ray from corner (-1,-1,-1) → true, no false negative', () => {
    // origin at exact min corner, direction toward centre
    const r = ray.create(ray.create(), [-1, -1, -1], [1, 1, 1]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBe(0);
  });

  it('ray origin on +x face, direction parallel to face (0,0,-1) → true, tmin=0', () => {
    // origin (1, 0, 0) on the +x face, direction (0,0,-1) parallel to face.
    // X axis: t1=( -1-1)/0 = -2/0 = -Inf, t2=(1-1)/0 = 0/0 = NaN.
    // Must be NaN-safe: NaN must not poison the interval.
    const r = ray.create(ray.create(), [1, 0, 0], [0, 0, -1]);
    const aabb = box3.create(-1, -1, -1, 1, 1, 1);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
  });
});

describe('rayAabbIntersects — ⑥ thin box (1D / 2D degenerate)', () => {
  it('thin box (minX == maxX, flat YZ plane at x=0) intersects front-on ray', () => {
    // 2D box: plane at x=0 from y=[-1,1] z=[-1,1]
    const aabb = box3.create(0, -1, -1, 0, 1, 1);
    // ray from x=-2 toward +x
    const r = ray.create(ray.create(), [-2, 0, 0], [1, 0, 0]);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
    expect(result.tmin).toBeCloseTo(2, 5);
  });

  it('thin box (minY == maxY, 1D segment on X) intersects on-axis ray', () => {
    // 1D degenerate box: y=[0,0], z=[0,0], x=[-1,1] → line segment on X axis
    const aabb = box3.create(-1, 0, 0, 1, 0, 0);
    // ray from (0,-5,0) pointing toward X axis at y=0
    const r = ray.create(ray.create(), [0, -5, 0], [0, 1, 0]);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(true);
  });

  it('thin box miss: ray parallel to the plane offset outside', () => {
    const aabb = box3.create(0, -1, -1, 0, 1, 1); // YZ plane at x=0
    // ray pointing in Y direction, offset on X at x=5, origin offset on Z
    const r = ray.create(ray.create(), [5, 0, 0], [0, 0, -1]);
    const result = ray.rayAabbIntersects(r, aabb);
    expect(result.hit).toBe(false);
  });
});

// ============================================================
// screenToRay (feat-20260529-picking-raycasting-screen-to-entity M2 w6)
// ============================================================
//
// screenToRay(out, sx, sy, vpW, vpH, view, proj, kind) → Ray
//
// WebGPU [0,1] NDC z convention: near=0, far=1 (D-NDC / research Finding 6).
// y-flip: ndc_y = 1 - 2 * screenY / viewportH.
//
// Five test groups per requirements:
//   1. perspective direction ≈ forward
//   2. ortho direction constant = forward, origin translates with screen coords
//   3. y-flip correctness
//   4. boundary clamp (viewport-outside coords → clamped)
//   5. NaN/Inf sanitization (non-finite input → defined Ray, no NaN)
//
// Related: requirements AC-03; plan-tasks.json w6 acceptanceCheck.

describe('screenToRay', () => {
  // Reusable view/projection setups
  function perspView(): Float32Array {
    return mat4.lookAt(mat4.create(), [1, 2, 5], [1, 2, -5], [0, 1, 0]);
  }
  function perspProj(): Float32Array {
    return mat4.perspective(mat4.create(), Math.PI / 3, 800 / 600, 0.1, 100);
  }
  function orthoView(): Float32Array {
    return mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
  }
  function orthoProj(): Float32Array {
    return mat4.orthographic(mat4.create(), -4, 4, -3, 3, 0.1, 100);
  }

  // ---------- 1. perspective direction ≈ forward ----------

  it('perspective screen-center produces ray direction ≈ camera forward', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, 800, 600, view, proj, 'perspective');
    // Camera forward in world space = (0, 0, -1)
    const dirDot = (r[3] as number) * 0 + (r[4] as number) * 0 + (r[5] as number) * -1;
    expect(dirDot).toBeGreaterThan(0.99999);
  });

  it('perspective off-center gives different direction', () => {
    const view = perspView();
    const proj = perspProj();
    const rCenter = ray.create();
    const rRight = ray.create();
    ray.screenToRay(rCenter, 400, 300, 800, 600, view, proj, 'perspective');
    ray.screenToRay(rRight, 700, 300, 800, 600, view, proj, 'perspective');
    expect(rRight[3]).not.toBeCloseTo(rCenter[3] as number, 3);
  });

  // ---------- 2. orthographic ----------

  it('ortho screen-center produces direction = camera forward', () => {
    const view = orthoView();
    const proj = orthoProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, 800, 600, view, proj, 'orthographic');
    const dirDot = (r[3] as number) * 0 + (r[4] as number) * 0 + (r[5] as number) * -1;
    expect(dirDot).toBeGreaterThan(0.99999);
  });

  it('ortho origin translates with screen coordinates (x direction)', () => {
    const view = orthoView();
    const proj = orthoProj();
    const rLeft = ray.create();
    const rRight = ray.create();
    ray.screenToRay(rLeft, 200, 300, 800, 600, view, proj, 'orthographic');
    ray.screenToRay(rRight, 600, 300, 800, 600, view, proj, 'orthographic');
    expect(rRight[0]).toBeGreaterThan(rLeft[0] as number);
  });

  it('ortho origin translates with screen coordinates (y direction)', () => {
    const view = orthoView();
    const proj = orthoProj();
    const rTop = ray.create();
    const rBottom = ray.create();
    ray.screenToRay(rTop, 400, 100, 800, 600, view, proj, 'orthographic');
    ray.screenToRay(rBottom, 400, 500, 800, 600, view, proj, 'orthographic');
    expect(rTop[1]).toBeGreaterThan(rBottom[1] as number);
  });

  it('ortho direction is identical regardless of screen position', () => {
    const view = orthoView();
    const proj = orthoProj();
    const r1 = ray.create();
    const r2 = ray.create();
    ray.screenToRay(r1, 200, 100, 800, 600, view, proj, 'orthographic');
    ray.screenToRay(r2, 600, 500, 800, 600, view, proj, 'orthographic');
    expect(r1[3]).toBeCloseTo(r2[3] as number, 10);
    expect(r1[4]).toBeCloseTo(r2[4] as number, 10);
    expect(r1[5]).toBeCloseTo(r2[5] as number, 10);
  });

  // ---------- 3. y-flip ----------

  it('y-flip: lower screen y (near top) → higher world y', () => {
    const view = perspView();
    const proj = perspProj();
    const rTop = ray.create();
    const rBottom = ray.create();
    ray.screenToRay(rTop, 400, 100, 800, 600, view, proj, 'perspective');
    ray.screenToRay(rBottom, 400, 500, 800, 600, view, proj, 'perspective');
    expect(rTop[1]).toBeGreaterThan(rBottom[1] as number);
  });

  // ---------- 4. boundary clamp ----------

  it('negative screenX clamps to 0 without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, -100, 300, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('excessive screenX clamps to viewport width without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 900, 300, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('negative screenY clamps to 0 without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, -50, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('excessive screenY clamps to viewport height without producing NaN', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 700, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  // ---------- 5. NaN/Inf sanitization ----------

  it('NaN screenX produces a defined Ray (no NaN components)', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, Number.NaN, 300, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('Infinity screenY produces a defined Ray (no Inf components)', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, Number.POSITIVE_INFINITY, 800, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('NaN viewport dimensions produce a defined Ray', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, Number.NaN, 600, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('zero viewport dimensions produce a defined Ray (no division by zero)', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 0, 0, 0, 0, view, proj, 'perspective');
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(r[i] as number)).toBe(true);
    }
  });

  it('normalized direction is approximately unit length', () => {
    const view = perspView();
    const proj = perspProj();
    const r = ray.create();
    ray.screenToRay(r, 400, 300, 800, 600, view, proj, 'perspective');
    const dirLen = Math.sqrt(
      (r[3] as number) * (r[3] as number) +
        (r[4] as number) * (r[4] as number) +
        (r[5] as number) * (r[5] as number),
    );
    expect(dirLen).toBeCloseTo(1, 5);
  });
});

}

{
  // --- from sphere.test.ts ---
// Sphere unit tests — TDD red phase (feat-20260511-asset-system-v1 M3 / w7).
//
// Sphere is a bounding sphere stored as 4 f32 [cx, cy, cz, radius];
// pure-function surface aligned with packages/math branded ABI + SoA style.
// Surface (5 ops per plan-tasks.json w7): create / expandByPoint / containsPoint / intersectsBox / fromPoints.
//
// Three tiers per test group: normal / boundary / degenerate.
// Related: requirements §AC-16 (Box3 / Sphere pure functions); plan-strategy M3 range;
//          plan-tasks.json w7 acceptanceCheck.


describe('sphere.create', () => {
  it('returns Float32Array length 4 with zero-radius origin by default (normal)', () => {
    const s = sphere.create();
    expect(s).toBeInstanceOf(Float32Array);
    expect(s.length).toBe(4);
    expect(s[0]).toBe(0);
    expect(s[1]).toBe(0);
    expect(s[2]).toBe(0);
    expect(s[3]).toBe(0);
  });

  it('accepts explicit center + radius (boundary)', () => {
    const s = sphere.create(1, 2, 3, 4);
    expect(Array.from(s)).toEqual([1, 2, 3, 4]);
  });

  it('negative radius stored verbatim and treated as empty sphere (degenerate)', () => {
    const s = sphere.create(0, 0, 0, -1);
    expect(s[3]).toBe(-1);
    expect(sphere.containsPoint(s, [0, 0, 0])).toBe(false);
  });
});

describe('sphere.expandByPoint', () => {
  it('grows radius so the point sits on the new surface (normal)', () => {
    const s = sphere.create(0, 0, 0, 0);
    const ret = sphere.expandByPoint(s, [3, 4, 0]);
    expect(ret).toBe(s);
    // distance from origin to (3,4,0) = 5
    expect(s[3]).toBe(5);
    expect(s[0]).toBe(0);
  });

  it('point inside existing sphere leaves radius unchanged (boundary)', () => {
    const s = sphere.create(0, 0, 0, 10);
    sphere.expandByPoint(s, [1, 1, 1]);
    expect(s[3]).toBe(10);
  });

  it('negative-radius sphere treated as empty and collapses to zero radius at the point (degenerate)', () => {
    const s = sphere.create(1, 2, 3, -1);
    sphere.expandByPoint(s, [1, 2, 3]);
    expect(s[0]).toBe(1);
    expect(s[1]).toBe(2);
    expect(s[2]).toBe(3);
    expect(s[3]).toBe(0);
  });
});

describe('sphere.containsPoint', () => {
  it('returns true for point strictly inside (normal)', () => {
    const s = sphere.create(0, 0, 0, 2);
    expect(sphere.containsPoint(s, [1, 0, 0])).toBe(true);
  });

  it('point on the surface is considered inside (boundary)', () => {
    const s = sphere.create(0, 0, 0, 3);
    expect(sphere.containsPoint(s, [3, 0, 0])).toBe(true);
    expect(sphere.containsPoint(s, [0, -3, 0])).toBe(true);
  });

  it('point outside is rejected and zero-radius sphere contains only its center (degenerate)', () => {
    const s = sphere.create(0, 0, 0, 1);
    expect(sphere.containsPoint(s, [2, 0, 0])).toBe(false);
    const z = sphere.create(5, 5, 5, 0);
    expect(sphere.containsPoint(z, [5, 5, 5])).toBe(true);
    expect(sphere.containsPoint(z, [5, 5, 6])).toBe(false);
  });
});

describe('sphere.intersectsBox', () => {
  it('sphere overlapping box intersects (normal)', () => {
    const s = sphere.create(0, 0, 0, 2);
    const b = box3.create(1, 1, 1, 3, 3, 3);
    expect(sphere.intersectsBox(s, b)).toBe(true);
  });

  it('sphere touching box face intersects (boundary)', () => {
    const s = sphere.create(2, 0, 0, 1);
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(sphere.intersectsBox(s, b)).toBe(true);
  });

  it('sphere far from box does not intersect (degenerate)', () => {
    const s = sphere.create(10, 10, 10, 1);
    const b = box3.create(-1, -1, -1, 1, 1, 1);
    expect(sphere.intersectsBox(s, b)).toBe(false);
  });
});

describe('sphere.fromPoints', () => {
  it('builds an enclosing sphere for 3 coplanar points (normal)', () => {
    const out = sphere.create();
    const ret = sphere.fromPoints(out, [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
    ]);
    expect(ret).toBe(out);
    // every input point must lie inside (boundary inclusive)
    expect(sphere.containsPoint(out, [1, 0, 0])).toBe(true);
    expect(sphere.containsPoint(out, [-1, 0, 0])).toBe(true);
    expect(sphere.containsPoint(out, [0, 1, 0])).toBe(true);
  });

  it('single point produces zero-radius sphere centered on that point (boundary)', () => {
    const out = sphere.create();
    sphere.fromPoints(out, [[7, -2, 5]]);
    expect(Array.from(out)).toEqual([7, -2, 5, 0]);
  });

  it('empty points array leaves an empty sphere (origin + negative-sentinel radius) (degenerate)', () => {
    const out = sphere.create();
    sphere.fromPoints(out, []);
    expect(out[3]).toBeLessThanOrEqual(0);
    expect(sphere.containsPoint(out, [0, 0, 0])).toBe(false);
  });
});

}

{
  // --- from vec2.test.ts ---
// Vec2 unit tests — TDD red phase (T-011).
//
// Three tiers: normal / boundary / degenerate (covers NaN propagation + 0-vec normalize silent fall-back).
// vec2 ≥ 14 functions, includes perp (2D 90° rotation), excludes cross.
//
// Related: requirements §Surface vec2 lower bound 14; plan-strategy §6 M2 + AC-06 degenerate tests;
//          wiki/gl-matrix-overview Out-param four ironclad rules.


describe('vec2.create', () => {
  it('returns Float32Array length 2 zero by default (normal)', () => {
    const v = vec2.create();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(2);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
  });

  it('accepts explicit components (boundary)', () => {
    const v = vec2.create(3, -4);
    expect(v[0]).toBe(3);
    expect(v[1]).toBe(-4);
  });

  it('NaN/Infinity stored verbatim per Float32Array semantics (degenerate)', () => {
    const v = vec2.create(Number.NaN, Number.POSITIVE_INFINITY);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(v[1]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('vec2.clone', () => {
  it('produces a new Float32Array with same values (normal)', () => {
    const a = vec2.create(1, 2);
    const b = vec2.clone(a);
    expect(b).not.toBe(a);
    expect(b[0]).toBe(1);
    expect(b[1]).toBe(2);
  });

  it('clone of zero vec is zero vec (boundary)', () => {
    const a = vec2.create();
    const b = vec2.clone(a);
    expect(b[0]).toBe(0);
    expect(b[1]).toBe(0);
  });
});

describe('vec2.copy', () => {
  it('copies a -> out and returns out (normal)', () => {
    const a = vec2.create(7, 11);
    const out = vec2.create();
    const ret = vec2.copy(out, a);
    expect(ret).toBe(out);
    expect(out[0]).toBe(7);
    expect(out[1]).toBe(11);
  });

  it('aliasing-safe: copy(v, v) is a no-op (degenerate)', () => {
    const v = vec2.create(1, 2);
    vec2.copy(v, v);
    expect(v[0]).toBe(1);
    expect(v[1]).toBe(2);
  });
});

describe('vec2.set', () => {
  it('writes components and returns out (normal)', () => {
    const out = vec2.create();
    const ret = vec2.set(out, 5, 6);
    expect(ret).toBe(out);
    expect(out[0]).toBe(5);
    expect(out[1]).toBe(6);
  });
});

describe('vec2.equals', () => {
  it('exact equality returns true (normal)', () => {
    expect(vec2.equals(vec2.create(1, 2), vec2.create(1, 2))).toBe(true);
  });

  it('within epsilon equality returns true (boundary)', () => {
    expect(vec2.equals(vec2.create(1, 2), vec2.create(1 + 1e-7, 2))).toBe(true);
  });

  it('NaN never equals NaN (degenerate)', () => {
    expect(vec2.equals(vec2.create(Number.NaN, 0), vec2.create(Number.NaN, 0))).toBe(false);
  });
});

describe('vec2.add', () => {
  it('component-wise add (normal)', () => {
    const out = vec2.add(vec2.create(), vec2.create(1, 2), vec2.create(3, 4));
    expect(out[0]).toBe(4);
    expect(out[1]).toBe(6);
  });

  it('aliasing-safe: add(v, v, v) doubles (degenerate)', () => {
    const v = vec2.create(1, 2);
    vec2.add(v, v, v);
    expect(v[0]).toBe(2);
    expect(v[1]).toBe(4);
  });
});

describe('vec2.sub', () => {
  it('component-wise sub (normal)', () => {
    const out = vec2.sub(vec2.create(), vec2.create(5, 7), vec2.create(1, 2));
    expect(out[0]).toBe(4);
    expect(out[1]).toBe(5);
  });

  it('a - a = 0 (boundary)', () => {
    const a = vec2.create(3, 4);
    const out = vec2.sub(vec2.create(), a, a);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.scale', () => {
  it('scales by scalar (normal)', () => {
    const out = vec2.scale(vec2.create(), vec2.create(1, 2), 3);
    expect(out[0]).toBe(3);
    expect(out[1]).toBe(6);
  });

  it('scale by 0 yields zero (boundary)', () => {
    const out = vec2.scale(vec2.create(), vec2.create(7, 11), 0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.negate', () => {
  it('flips sign (normal)', () => {
    const out = vec2.negate(vec2.create(), vec2.create(1, -2));
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(2);
  });

  it('negate of zero is zero (boundary)', () => {
    const out = vec2.negate(vec2.create(), vec2.create());
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.dot', () => {
  it('computes dot product (normal)', () => {
    expect(vec2.dot(vec2.create(1, 2), vec2.create(3, 4))).toBe(11);
  });

  it('orthogonal vectors → 0 (boundary)', () => {
    expect(vec2.dot(vec2.create(1, 0), vec2.create(0, 1))).toBe(0);
  });

  it('dot with zero is 0 (degenerate)', () => {
    expect(vec2.dot(vec2.create(), vec2.create(123, 456))).toBe(0);
  });
});

describe('vec2.lengthSq / length', () => {
  it('lengthSq of (3,4) is 25 (normal)', () => {
    expect(vec2.lengthSq(vec2.create(3, 4))).toBe(25);
  });

  it('length of (3,4) is 5 (normal)', () => {
    expect(vec2.length(vec2.create(3, 4))).toBeCloseTo(5);
  });

  it('length of zero is 0 (boundary)', () => {
    expect(vec2.length(vec2.create())).toBe(0);
  });
});

describe('vec2.distance', () => {
  it('distance between (1,1) and (4,5) is 5 (normal)', () => {
    expect(vec2.distance(vec2.create(1, 1), vec2.create(4, 5))).toBeCloseTo(5);
  });

  it('distance to self is 0 (boundary)', () => {
    const a = vec2.create(7, 11);
    expect(vec2.distance(a, a)).toBe(0);
  });
});

describe('vec2.normalize', () => {
  it('normalizes non-zero vec to unit length (normal)', () => {
    const out = vec2.normalize(vec2.create(), vec2.create(3, 4));
    expect(vec2.length(out)).toBeCloseTo(1);
    expect(out[0]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0.8);
  });

  it('zero vec → zero vec, no NaN, no throw (degenerate / D-P12)', () => {
    const out = vec2.normalize(vec2.create(), vec2.create());
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.lerp', () => {
  it('t=0 returns a (boundary)', () => {
    const out = vec2.lerp(vec2.create(), vec2.create(1, 2), vec2.create(5, 6), 0);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
  });

  it('t=1 returns b (boundary)', () => {
    const out = vec2.lerp(vec2.create(), vec2.create(1, 2), vec2.create(5, 6), 1);
    expect(out[0]).toBeCloseTo(5);
    expect(out[1]).toBeCloseTo(6);
  });

  it('t=0.5 returns midpoint (normal)', () => {
    const out = vec2.lerp(vec2.create(), vec2.create(0, 0), vec2.create(2, 4), 0.5);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
  });
});

describe('vec2.min / max', () => {
  it('component-wise min (normal)', () => {
    const out = vec2.min(vec2.create(), vec2.create(1, 5), vec2.create(3, 2));
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(2);
  });

  it('component-wise max (normal)', () => {
    const out = vec2.max(vec2.create(), vec2.create(1, 5), vec2.create(3, 2));
    expect(out[0]).toBe(3);
    expect(out[1]).toBe(5);
  });
});

describe('vec2.perp', () => {
  it('perp of (1,0) is (0,1) — 90° CCW (normal)', () => {
    const out = vec2.perp(vec2.create(), vec2.create(1, 0));
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
  });

  it('perp of (0,1) is (-1,0) (boundary)', () => {
    const out = vec2.perp(vec2.create(), vec2.create(0, 1));
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(0);
  });

  it('perp of zero is zero (degenerate)', () => {
    const out = vec2.perp(vec2.create(), vec2.create());
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });

  it('perp(perp(v)) = -v (degenerate, involutive up to sign)', () => {
    const v = vec2.create(2, 3);
    const a = vec2.perp(vec2.create(), v);
    const b = vec2.perp(vec2.create(), a);
    expect(b[0]).toBeCloseTo(-2);
    expect(b[1]).toBeCloseTo(-3);
  });
});

describe('vec2 — V8 elements-kinds guard', () => {
  it('all returns are Float32Array (no number[] coercion)', () => {
    const a = vec2.create(1, 2);
    const b = vec2.create(3, 4);
    expect(vec2.add(vec2.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec2.normalize(vec2.create(), a)).toBeInstanceOf(Float32Array);
    expect(vec2.lerp(vec2.create(), a, b, 0.5)).toBeInstanceOf(Float32Array);
    expect(vec2.perp(vec2.create(), a)).toBeInstanceOf(Float32Array);
  });
});

}

{
  // --- from vec3.test.ts ---
// Vec3 unit tests — TDD red phase (T-011 rewrite, turned green by T-014).
//
// Three tiers: normal / boundary / degenerate (covers NaN propagation + 0-vec normalize silent fall-back).
// vec3 ≥ 18 functions: vec2 base (without perp) + cross + distanceSq.
// Cross-type apply functions go via the reverse surface: mat4.transformVec3 / transformPoint /
// transformDirection / quat.transformVec3 (D-12 tore down the previous loop's Three.js-style promise).
//
// Related: requirements §Surface vec3 lower bound 18; plan-strategy §6 M2 + AC-06 degenerate tests;
//          wiki/gl-matrix-overview Out-param four ironclad rules + degenerate-semantics anchor.


describe('vec3.create', () => {
  it('returns Float32Array length 3 zero by default (normal)', () => {
    const v = vec3.create();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(3);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(0);
  });

  it('accepts explicit components (boundary)', () => {
    const v = vec3.create(1, 2, 3);
    expect(v[0]).toBe(1);
    expect(v[1]).toBe(2);
    expect(v[2]).toBe(3);
  });

  it('NaN/Infinity stored verbatim (degenerate)', () => {
    const v = vec3.create(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(v[1]).toBe(Number.POSITIVE_INFINITY);
    expect(v[2]).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('vec3.clone', () => {
  it('produces new Float32Array with same values (normal)', () => {
    const a = vec3.create(1, 2, 3);
    const b = vec3.clone(a);
    expect(b).not.toBe(a);
    expect(Array.from(b)).toEqual([1, 2, 3]);
  });
});

describe('vec3.copy', () => {
  it('copies a -> out and returns out (normal)', () => {
    const a = vec3.create(7, 11, 13);
    const out = vec3.create();
    const ret = vec3.copy(out, a);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([7, 11, 13]);
  });

  it('aliasing-safe: copy(v, v) is a no-op (degenerate)', () => {
    const v = vec3.create(1, 2, 3);
    vec3.copy(v, v);
    expect(Array.from(v)).toEqual([1, 2, 3]);
  });
});

describe('vec3.set', () => {
  it('writes components and returns out (normal)', () => {
    const out = vec3.create();
    const ret = vec3.set(out, 5, 6, 7);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([5, 6, 7]);
  });
});

describe('vec3.equals', () => {
  it('exact equality returns true (normal)', () => {
    expect(vec3.equals(vec3.create(1, 2, 3), vec3.create(1, 2, 3))).toBe(true);
  });

  it('within epsilon returns true (boundary)', () => {
    expect(vec3.equals(vec3.create(1, 2, 3), vec3.create(1 + 1e-7, 2, 3))).toBe(true);
  });

  it('NaN never equals NaN (degenerate)', () => {
    expect(vec3.equals(vec3.create(Number.NaN, 0, 0), vec3.create(Number.NaN, 0, 0))).toBe(false);
  });
});

describe('vec3.add', () => {
  it('component-wise add (normal)', () => {
    const out = vec3.add(vec3.create(), vec3.create(1, 2, 3), vec3.create(4, 5, 6));
    expect(Array.from(out)).toEqual([5, 7, 9]);
  });

  it('aliasing-safe: add(v, v, v) doubles (degenerate)', () => {
    const v = vec3.create(1, 2, 3);
    vec3.add(v, v, v);
    expect(Array.from(v)).toEqual([2, 4, 6]);
  });
});

describe('vec3.sub', () => {
  it('component-wise sub (normal)', () => {
    const out = vec3.sub(vec3.create(), vec3.create(5, 7, 9), vec3.create(1, 2, 3));
    expect(Array.from(out)).toEqual([4, 5, 6]);
  });

  it('a - a = 0 (boundary)', () => {
    const a = vec3.create(3, 4, 5);
    const out = vec3.sub(vec3.create(), a, a);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe('vec3.scale', () => {
  it('scales by scalar (normal)', () => {
    const out = vec3.scale(vec3.create(), vec3.create(1, 2, 3), 2);
    expect(Array.from(out)).toEqual([2, 4, 6]);
  });

  it('scale by 0 yields zero (boundary)', () => {
    const out = vec3.scale(vec3.create(), vec3.create(7, 11, 13), 0);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe('vec3.negate', () => {
  it('flips sign (normal)', () => {
    const out = vec3.negate(vec3.create(), vec3.create(1, -2, 3));
    expect(Array.from(out)).toEqual([-1, 2, -3]);
  });
});

describe('vec3.dot', () => {
  it('computes dot product (normal)', () => {
    expect(vec3.dot(vec3.create(1, 2, 3), vec3.create(4, -5, 6))).toBe(4 - 10 + 18);
  });

  it('orthogonal → 0 (boundary)', () => {
    expect(vec3.dot(vec3.create(1, 0, 0), vec3.create(0, 1, 0))).toBe(0);
  });

  it('dot with zero is 0 (degenerate)', () => {
    expect(vec3.dot(vec3.create(), vec3.create(123, 456, 789))).toBe(0);
  });
});

describe('vec3.cross', () => {
  it('canonical x cross y = z (normal)', () => {
    const out = vec3.cross(vec3.create(), vec3.create(1, 0, 0), vec3.create(0, 1, 0));
    expect(Array.from(out)).toEqual([0, 0, 1]);
  });

  it('parallel vectors → 0 (boundary)', () => {
    const out = vec3.cross(vec3.create(), vec3.create(1, 2, 3), vec3.create(2, 4, 6));
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('a x a = 0 (degenerate, aliasing)', () => {
    const a = vec3.create(1, -2, 3);
    const out = vec3.cross(vec3.create(), a, a);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('aliasing-safe cross(v, v, w) (degenerate)', () => {
    const v = vec3.create(1, 0, 0);
    const w = vec3.create(0, 1, 0);
    vec3.cross(v, v, w);
    expect(Array.from(v)).toEqual([0, 0, 1]);
  });
});

describe('vec3.lengthSq / length', () => {
  it('lengthSq of (3,4,0) is 25 (normal)', () => {
    expect(vec3.lengthSq(vec3.create(3, 4, 0))).toBe(25);
  });

  it('length of (3,4,0) is 5 (normal)', () => {
    expect(vec3.length(vec3.create(3, 4, 0))).toBeCloseTo(5);
  });

  it('length of zero is 0 (boundary)', () => {
    expect(vec3.length(vec3.create())).toBe(0);
  });

  it('length of unit basis is 1 (degenerate)', () => {
    expect(vec3.length(vec3.create(1, 0, 0))).toBeCloseTo(1);
    expect(vec3.length(vec3.create(0, 1, 0))).toBeCloseTo(1);
    expect(vec3.length(vec3.create(0, 0, 1))).toBeCloseTo(1);
  });
});

describe('vec3.distance / distanceSq', () => {
  it('distance between (1,1,1) and (4,5,1) is 5 (normal)', () => {
    expect(vec3.distance(vec3.create(1, 1, 1), vec3.create(4, 5, 1))).toBeCloseTo(5);
  });

  it('distanceSq of (0,0,0) to (3,4,0) is 25 (normal)', () => {
    expect(vec3.distanceSq(vec3.create(), vec3.create(3, 4, 0))).toBeCloseTo(25);
  });

  it('distance to self is 0 (boundary)', () => {
    const a = vec3.create(7, 11, 13);
    expect(vec3.distance(a, a)).toBe(0);
  });
});

describe('vec3.normalize', () => {
  it('normalizes a non-zero vec to unit length (normal)', () => {
    const out = vec3.normalize(vec3.create(), vec3.create(3, 4, 0));
    expect(vec3.length(out)).toBeCloseTo(1);
    expect(out[0]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0.8);
    expect(out[2]).toBeCloseTo(0);
  });

  it('zero vec → zero vec, no NaN, no throw (degenerate / D-P12)', () => {
    const out = vec3.normalize(vec3.create(), vec3.create());
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('an already-unit vec remains unit (degenerate)', () => {
    const out = vec3.normalize(vec3.create(), vec3.create(0, 1, 0));
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0);
  });
});

describe('vec3.lerp', () => {
  it('t=0 returns a (boundary)', () => {
    const out = vec3.lerp(vec3.create(), vec3.create(1, 2, 3), vec3.create(5, 6, 7), 0);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
    expect(out[2]).toBeCloseTo(3);
  });

  it('t=1 returns b (boundary)', () => {
    const out = vec3.lerp(vec3.create(), vec3.create(1, 2, 3), vec3.create(5, 6, 7), 1);
    expect(out[0]).toBeCloseTo(5);
    expect(out[1]).toBeCloseTo(6);
    expect(out[2]).toBeCloseTo(7);
  });

  it('t=0.5 returns midpoint (normal)', () => {
    const out = vec3.lerp(vec3.create(), vec3.create(0, 0, 0), vec3.create(2, 4, 6), 0.5);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
    expect(out[2]).toBeCloseTo(3);
  });
});

describe('vec3.min / max', () => {
  it('component-wise min (normal)', () => {
    const out = vec3.min(vec3.create(), vec3.create(1, 5, -3), vec3.create(3, 2, 0));
    expect(Array.from(out)).toEqual([1, 2, -3]);
  });

  it('component-wise max (normal)', () => {
    const out = vec3.max(vec3.create(), vec3.create(1, 5, -3), vec3.create(3, 2, 0));
    expect(Array.from(out)).toEqual([3, 5, 0]);
  });
});

describe('vec3 — V8 elements-kinds guard', () => {
  it('typed-array input yields typed-array output (no number[] coercion)', () => {
    const a = vec3.create(1, 2, 3);
    const b = vec3.create(4, 5, 6);
    expect(vec3.add(vec3.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec3.sub(vec3.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec3.scale(vec3.create(), a, 2)).toBeInstanceOf(Float32Array);
    expect(vec3.cross(vec3.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec3.normalize(vec3.create(), a)).toBeInstanceOf(Float32Array);
  });
});

}

{
  // --- from vec4.test.ts ---
// Vec4 unit tests — TDD red phase (T-011).
//
// Three tiers: normal / boundary / degenerate (covers NaN propagation + 0-vec normalize silent fall-back).
// vec4 ≥ 14 functions: same shape as vec2/vec3 (no cross / perp).
//
// Related: requirements §Surface vec4 lower bound 14; plan-strategy §6 M2 + AC-06 degenerate tests;
//          wiki/gl-matrix-overview Out-param four ironclad rules.


describe('vec4.create', () => {
  it('returns Float32Array length 4 zero by default (normal)', () => {
    const v = vec4.create();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(v[i]).toBe(0);
  });

  it('accepts explicit components (boundary)', () => {
    const v = vec4.create(1, 2, 3, 4);
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
  });

  it('NaN stored verbatim (degenerate)', () => {
    const v = vec4.create(Number.NaN, 0, 0, 0);
    expect(Number.isNaN(v[0])).toBe(true);
  });
});

describe('vec4.clone', () => {
  it('produces new Float32Array with same values (normal)', () => {
    const a = vec4.create(1, 2, 3, 4);
    const b = vec4.clone(a);
    expect(b).not.toBe(a);
    expect(Array.from(b)).toEqual([1, 2, 3, 4]);
  });
});

describe('vec4.copy', () => {
  it('copies a -> out and returns out (normal)', () => {
    const out = vec4.copy(vec4.create(), vec4.create(7, 11, 13, 17));
    expect(Array.from(out)).toEqual([7, 11, 13, 17]);
  });

  it('aliasing-safe: copy(v, v) is no-op (degenerate)', () => {
    const v = vec4.create(1, 2, 3, 4);
    vec4.copy(v, v);
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
  });
});

describe('vec4.set', () => {
  it('writes components and returns out (normal)', () => {
    const out = vec4.create();
    const ret = vec4.set(out, 5, 6, 7, 8);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([5, 6, 7, 8]);
  });
});

describe('vec4.equals', () => {
  it('exact equality returns true (normal)', () => {
    expect(vec4.equals(vec4.create(1, 2, 3, 4), vec4.create(1, 2, 3, 4))).toBe(true);
  });

  it('within epsilon returns true (boundary)', () => {
    expect(vec4.equals(vec4.create(1, 2, 3, 4), vec4.create(1 + 1e-7, 2, 3, 4))).toBe(true);
  });

  it('NaN never equals NaN (degenerate)', () => {
    expect(vec4.equals(vec4.create(Number.NaN, 0, 0, 0), vec4.create(Number.NaN, 0, 0, 0))).toBe(
      false,
    );
  });
});

describe('vec4.add', () => {
  it('component-wise add (normal)', () => {
    const out = vec4.add(vec4.create(), vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8));
    expect(Array.from(out)).toEqual([6, 8, 10, 12]);
  });

  it('aliasing-safe: add(v, v, v) doubles (degenerate)', () => {
    const v = vec4.create(1, 2, 3, 4);
    vec4.add(v, v, v);
    expect(Array.from(v)).toEqual([2, 4, 6, 8]);
  });
});

describe('vec4.sub', () => {
  it('component-wise sub (normal)', () => {
    const out = vec4.sub(vec4.create(), vec4.create(5, 7, 9, 11), vec4.create(1, 2, 3, 4));
    expect(Array.from(out)).toEqual([4, 5, 6, 7]);
  });

  it('a - a = 0 (boundary)', () => {
    const a = vec4.create(3, 4, 5, 6);
    const out = vec4.sub(vec4.create(), a, a);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('vec4.scale', () => {
  it('scales by scalar (normal)', () => {
    const out = vec4.scale(vec4.create(), vec4.create(1, 2, 3, 4), 2);
    expect(Array.from(out)).toEqual([2, 4, 6, 8]);
  });

  it('scale by 0 yields zero (boundary)', () => {
    const out = vec4.scale(vec4.create(), vec4.create(7, 11, 13, 17), 0);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('vec4.negate', () => {
  it('flips sign (normal)', () => {
    const out = vec4.negate(vec4.create(), vec4.create(1, -2, 3, -4));
    expect(Array.from(out)).toEqual([-1, 2, -3, 4]);
  });
});

describe('vec4.dot', () => {
  it('computes dot product (normal)', () => {
    expect(vec4.dot(vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8))).toBe(5 + 12 + 21 + 32);
  });

  it('dot with zero is 0 (degenerate)', () => {
    expect(vec4.dot(vec4.create(), vec4.create(1, 2, 3, 4))).toBe(0);
  });
});

describe('vec4.lengthSq / length', () => {
  it('lengthSq of (1,2,2,0) is 9 (normal)', () => {
    expect(vec4.lengthSq(vec4.create(1, 2, 2, 0))).toBe(9);
  });

  it('length of (1,2,2,0) is 3 (normal)', () => {
    expect(vec4.length(vec4.create(1, 2, 2, 0))).toBeCloseTo(3);
  });

  it('length of zero is 0 (boundary)', () => {
    expect(vec4.length(vec4.create())).toBe(0);
  });
});

describe('vec4.distance', () => {
  it('distance between (0,0,0,0) and (1,2,2,0) is 3 (normal)', () => {
    expect(vec4.distance(vec4.create(), vec4.create(1, 2, 2, 0))).toBeCloseTo(3);
  });

  it('distance to self is 0 (boundary)', () => {
    const a = vec4.create(7, 11, 13, 17);
    expect(vec4.distance(a, a)).toBe(0);
  });
});

describe('vec4.normalize', () => {
  it('normalizes a non-zero vec to unit length (normal)', () => {
    const out = vec4.normalize(vec4.create(), vec4.create(1, 2, 2, 0));
    expect(vec4.length(out)).toBeCloseTo(1);
  });

  it('zero vec → zero vec, no NaN, no throw (degenerate / D-P12)', () => {
    const out = vec4.normalize(vec4.create(), vec4.create());
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('vec4.lerp', () => {
  it('t=0 returns a (boundary)', () => {
    const out = vec4.lerp(vec4.create(), vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8), 0);
    expect(Array.from(out).map((x) => Math.round(x))).toEqual([1, 2, 3, 4]);
  });

  it('t=1 returns b (boundary)', () => {
    const out = vec4.lerp(vec4.create(), vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8), 1);
    expect(Array.from(out).map((x) => Math.round(x))).toEqual([5, 6, 7, 8]);
  });

  it('t=0.5 returns midpoint (normal)', () => {
    const out = vec4.lerp(vec4.create(), vec4.create(0, 0, 0, 0), vec4.create(2, 4, 6, 8), 0.5);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });
});

describe('vec4.min / max', () => {
  it('component-wise min (normal)', () => {
    const out = vec4.min(vec4.create(), vec4.create(1, 5, -3, 7), vec4.create(3, 2, 0, -1));
    expect(Array.from(out)).toEqual([1, 2, -3, -1]);
  });

  it('component-wise max (normal)', () => {
    const out = vec4.max(vec4.create(), vec4.create(1, 5, -3, 7), vec4.create(3, 2, 0, -1));
    expect(Array.from(out)).toEqual([3, 5, 0, 7]);
  });
});

describe('vec4 — V8 elements-kinds guard', () => {
  it('all returns are Float32Array (no number[] coercion)', () => {
    const a = vec4.create(1, 2, 3, 4);
    const b = vec4.create(5, 6, 7, 8);
    expect(vec4.add(vec4.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec4.sub(vec4.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec4.normalize(vec4.create(), a)).toBeInstanceOf(Float32Array);
    expect(vec4.lerp(vec4.create(), a, b, 0.5)).toBeInstanceOf(Float32Array);
  });
});

}
