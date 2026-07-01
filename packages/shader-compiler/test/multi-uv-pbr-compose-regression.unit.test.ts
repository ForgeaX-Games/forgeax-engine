// multi-uv-pbr-compose-regression.unit.test.ts
// feat-20260629-multi-uv-set-support — implement-review round 1 F-3 + F-7,
// updated for the user decision (built-in PBR reverts to single UV; multi-UV
// is consumed only by custom material shaders).
//
// Regression guard for two distinct concerns, running on the SAME composer the
// vite-plugin-shader build path wraps (compileShader -> naga_oil compose ->
// naga validate). The dawn e2e tests use test-local WGSL and so bypass the
// built-in PBR composer entirely; this test is the missing vite-compose-path
// probe the dawn smokes cannot provide.
//
// What it pins:
//   F-3: default-standard-pbr.wgsl + default-standard-pbr-skin.wgsl compose and
//        validate. The original M5 fragment multiplied albedo (vec3) by in.uv1
//        (vec2) -- a WGSL type error naga surfaced as the opaque "Entry point
//        fs_main at Fragment is invalid". If that (or any other validation-
//        breaking edit) returns, compileShader fails here.
//   F-7 (user decision): the built-in standard-PBR is single-UV. It must NOT
//        declare a second UV set (@location(6) uv1) in its VsIn, so naga
//        reflection derives uvSetCount=1. The engine still FEEDS extra UV sets
//        to a custom material shader that declares @location(6+), but the
//        built-in PBR opts out -- keeping every existing single-UV material
//        byte-identical (AC-11/AC-12 zero regression). A custom 2-UV-set
//        fixture below pins that the data-layer reflection still derives
//        uvSetCount=2 when a shader DOES declare the second set (the demo
//        shader's path), so the multi-UV pathway keeps its falsify value.

import { compileShader } from '@forgeax/engine-shader-compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadEngineImports(): Record<string, string> {
  const srcDir = join(import.meta.dirname, '..', '..', 'shader', 'src');
  const read = (name: string) => readFileSync(join(srcDir, name), 'utf8');
  return {
    'forgeax_view::common': read('common.wgsl'),
    'forgeax_pbr::brdf': read('brdf.wgsl'),
    'forgeax_pbr::ibl_shared': read('ibl-shared.wgsl'),
    'forgeax_pbr::ibl_sampling': read('ibl-sampling.wgsl'),
    'forgeax_pbr::tbn': read('tbn.wgsl'),
    'forgeax_pbr::lighting_directional': read('lighting-directional.wgsl'),
    'forgeax_pbr::lighting_punctual': read('lighting-punctual.wgsl'),
    'forgeax_pbr::shadow_pcf': read('shadow-pcf.wgsl'),
  };
}

const engineImports = loadEngineImports();

async function composePbr(file: string) {
  const srcPath = join(import.meta.dirname, '..', '..', 'shader', 'src', file);
  const source = readFileSync(srcPath, 'utf8').replace(/^\s*#pragma\s+.*$/gm, '');
  return compileShader(source, {
    id: srcPath,
    imports: engineImports,
    defines: {
      STORAGE_BUFFER_AVAILABLE: true,
      POINT_SHADOW_AVAILABLE: true,
      PER_INSTANCE_REGION: false,
    },
  });
}

// A minimal custom material shader that declares a SECOND UV set the way the
// hello-multi-uv demo shader does (@location(6) uv1). Pins that naga reflection
// still derives uvSetCount=2 for shaders that opt INTO multi-UV -- the data
// layer the demo relies on is untouched by the built-in PBR single-UV revert.
const CUSTOM_TWO_UV_WGSL = `
struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) tangent : vec4<f32>,
  @location(6) uv1 : vec2<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) uv1 : vec2<f32>,
};
@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  out.clip = vec4<f32>(in.pos, 1.0);
  out.uv = in.uv;
  out.uv1 = in.uv1;
  return out;
}
@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.uv1, 0.5, 1.0);
}
`;

describe('built-in standard-PBR single-UV + multi-UV pathway regression (F-3 + F-7)', () => {
  it('default-standard-pbr.wgsl composes + validates (F-3: no fs_main type error)', async () => {
    const r = await composePbr('default-standard-pbr.wgsl');
    expect(r.ok, r.ok ? '' : `compileShader failed: ${r.error.message}`).toBe(true);
  });

  it('default-standard-pbr-skin.wgsl composes + validates (F-3)', async () => {
    const r = await composePbr('default-standard-pbr-skin.wgsl');
    expect(r.ok, r.ok ? '' : `compileShader failed: ${r.error.message}`).toBe(true);
  });

  it('built-in PBR reflects uvSetCount=1: single-UV after the user-decision revert (F-7)', async () => {
    const r = await composePbr('default-standard-pbr.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Built-in PBR no longer declares @location(6) uv1 in its VsIn. If a future
    // edit re-adds a second UV set to the built-in shader, this flips to 2 and
    // fails -- re-surfacing the slot-6 VertexState validation cascade the user
    // decision removed.
    expect(r.value.uvSetCount).toBe(1);
  });

  it('built-in PBR skin reflects uvSetCount=1 (F-7)', async () => {
    const r = await composePbr('default-standard-pbr-skin.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.uvSetCount).toBe(1);
  });

  it('a custom shader declaring @location(6) uv1 still reflects uvSetCount=2 (multi-UV pathway preserved)', async () => {
    const r = await compileShader(CUSTOM_TWO_UV_WGSL, {
      id: 'test://custom-two-uv',
      imports: {},
      defines: {},
    });
    expect(r.ok, r.ok ? '' : `compileShader failed: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.uvSetCount).toBe(2);
  });

  it('built-in PBR fragment does NOT consume in.uv1 (single-UV zero regression)', async () => {
    const srcPath = join(
      import.meta.dirname,
      '..',
      '..',
      'shader',
      'src',
      'default-standard-pbr.wgsl',
    );
    const source = readFileSync(srcPath, 'utf8');
    const fragmentStart = source.indexOf('fn fs_main');
    const fragmentEnd = source.indexOf('fn fs_gbuffer');
    expect(fragmentStart).toBeGreaterThan(0);
    expect(fragmentEnd).toBeGreaterThan(fragmentStart);
    const fragmentBody = source.slice(fragmentStart, fragmentEnd);
    // Strip line comments first: the fragment header comment legitimately names
    // in.uv1 while EXPLAINING the single-UV decision. Only a real (non-comment)
    // in.uv1 reference is a regression.
    const fragmentCode = fragmentBody
      .split('\n')
      .map((line) => {
        const commentAt = line.indexOf('//');
        return commentAt >= 0 ? line.slice(0, commentAt) : line;
      })
      .join('\n');
    expect(fragmentCode).not.toMatch(/in\.uv1/);
  });
});
