// multi-uv-pbr-compose-regression.unit.test.ts
// feat-20260629-multi-uv-set-support — implement-review round 1 F-3 + F-7.
// UPDATED by feat-city-glb Bug 4 (multi-UV tiling): the feat-20260629 single-UV
// product decision was reversed on explicit user authorization — the built-in
// PBR now declares @location(6) uv1 + a per-material `uvSet` selector so it
// samples the glTF baseColorTexture.texCoord UV set.
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
//   Bug 4: the built-in standard-PBR + skin DECLARE a second UV set
//        (@location(6) uv1), so naga reflection derives uvSetCount=2. The
//        fragment resolves its UV set via `selectUv(in)` (select uv0/uv1 on
//        `material.uvSet`), keeping single-UV content byte-identical via
//        clamp-to-last (uv1 aliases uv0, selector defaults to 0). A custom
//        2-UV-set fixture below pins that a shader declaring @location(6+) also
//        reflects uvSetCount=2, so the multi-UV data pathway keeps its value.

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

  it('built-in PBR reflects uvSetCount=2: multi-UV after the feat-city-glb tiling fix (Bug 4)', async () => {
    const r = await composePbr('default-standard-pbr.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // feat-city-glb Bug 4 (multi-UV tiling) REVERSED the feat-20260629 single-UV
    // product decision (on explicit user authorization): the built-in PBR now
    // declares @location(6) uv1 and honors a per-material `uvSet` selector so it
    // can sample the glTF baseColorTexture.texCoord UV set (433/452 city_Sample
    // materials use set 1). Reflection therefore derives uvSetCount=2. Single-UV
    // meshes stay byte-identical via clamp-to-last (uv1 aliases uv0).
    expect(r.value.uvSetCount).toBe(2);
  });

  it('built-in PBR skin reflects uvSetCount=2 (Bug 4)', async () => {
    const r = await composePbr('default-standard-pbr-skin.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.uvSetCount).toBe(2);
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

  it('built-in PBR fragment selects the UV set via selectUv (feat-city-glb Bug 4 multi-UV)', async () => {
    // feat-city-glb Bug 4: the fragment now picks its UV set per-material via
    // `selectUv(in)` = select(in.uv, in.uv1, material.uvSet >= 0.5). It samples
    // `uv` (the selected set), not `in.uv` directly, so texCoord=1 materials get
    // UV set 1. Single-UV content is byte-identical (selector defaults to 0 and
    // clamp-to-last aliases uv1 onto uv0). This replaces the pre-revert
    // single-UV-only assertion.
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
    // The fragment resolves the UV set through the selector helper (which reads
    // both in.uv and in.uv1) rather than hardcoding in.uv at every sample site.
    expect(fragmentBody).toMatch(/selectUv\s*\(\s*in\s*\)/);
    // And the selectUv helper itself is the single place that references uv1.
    expect(source).toMatch(/fn selectUv[\s\S]*in\.uv1/);
  });
});
