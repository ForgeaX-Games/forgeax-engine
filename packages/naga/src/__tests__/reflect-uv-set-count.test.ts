// feat-20260629-multi-uv-set-support m4-w1: naga reflection uvSetCount unit test.
//
// Tests that naga emit_reflection returns uvSetCount derived from vertex
// @location declarations (D-4 convention: uv0 at location 2, uv1..7 at
// location 6..12, counting only vec2<f32> vertex input arguments).
//
// This test calls through the real @forgeax/engine-naga TS wrapper (parse
// -> validate -> emit_reflection), not mocked wasm. It starts RED because
// the current emit_reflection (pre m4-w2) does not include uvSetCount in
// the reflection JSON output. After m4-w2 (naga.rs modification) + m4-w4
// (wasm rebuild), this test should go GREEN.
//
// Wgsl snippets avoid trailing commas inside struct definitions (WGSL
// spec permits them but being conservative avoids naga parser edge cases).

import { describe, expect, it } from 'vitest';
import { emit_reflection, parse, validate } from '../index.js';

// --- wgsl test fixtures --------------------------------------------------

const WGSL_UV0_ONLY = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

const WGSL_UV0_UV1 = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(6) uv1: vec2<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

const WGSL_UV0_UV1_UV2 = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(6) uv1: vec2<f32>,
  @location(7) uv2: vec2<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

const WGSL_UV0_SKIP_UV7 = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(8) uv3: vec2<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

// Also test a skin-aware WGSL with 0 extra UV
const WGSL_SKIN_UV0_ONLY = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(4) skinIndex: vec4<u32>,
  @location(5) skinWeight: vec4<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

// --- test body -----------------------------------------------------------

describe('reflect-uv-set-count.test.ts', () => {
  interface ReflectionOutput {
    bindings: unknown;
    uvSetCount: number;
  }

  async function reflectWgsl(wgsl: string): Promise<ReflectionOutput> {
    const parsed = await parse(wgsl);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.message}`);
    const validated = await validate(parsed.value);
    if (!validated.ok) throw new Error(`validate failed: ${validated.error.message}`);
    const reflection = await emit_reflection(validated.value, '{}');
    if (!reflection.ok) throw new Error(`emit_reflection failed: ${reflection.error.message}`);
    const parsedObj = JSON.parse(reflection.value);
    // After m4-w2 the reflection JSON format is { bindings: [...], uvSetCount: N }.
    if (Array.isArray(parsedObj)) {
      throw new Error(
        'Reflection output is still the old array format; m4-w2 naga.rs changes not yet applied or wasm not rebuilt.',
      );
    }
    return parsedObj as ReflectionOutput;
  }

  describe('naga emit_reflection uvSetCount derivation (D-4: uv0@loc2, extra@loc6+)', () => {
    it('uv0 only -> uvSetCount=1', async () => {
      const r = await reflectWgsl(WGSL_UV0_ONLY);
      expect(r.uvSetCount).toBe(1);
      expect(Array.isArray(r.bindings)).toBe(true);
    });

    it('uv0 + uv1 (locations 2 and 6) -> uvSetCount=2', async () => {
      const r = await reflectWgsl(WGSL_UV0_UV1);
      expect(r.uvSetCount).toBe(2);
    });

    it('uv0 + uv1 + uv2 (locations 2, 6, 7) -> uvSetCount=3', async () => {
      const r = await reflectWgsl(WGSL_UV0_UV1_UV2);
      expect(r.uvSetCount).toBe(3);
    });

    it('uv0 + skip to uv3 at location 8 -> uvSetCount=4 (max(location>=6)-5=3 extra)', async () => {
      const r = await reflectWgsl(WGSL_UV0_SKIP_UV7);
      // Per D-4 jump convention: max(location>=6) = 8, so uvSetCount = 1 + (8-5) = 4.
      // The shader declares uv3 at @location(8) which implies uv1(loc6) and
      // uv2(loc7) also exist in the packing convention even if not physically
      // present in VsIn — clamp-to-last handles the gap.
      expect(r.uvSetCount).toBe(4);
    });

    it('skin shader with uv0 only -> uvSetCount=1 (skinIndex/skinWeight not counted as UV)', async () => {
      const r = await reflectWgsl(WGSL_SKIN_UV0_ONLY);
      expect(r.uvSetCount).toBe(1);
    });
  });
});
