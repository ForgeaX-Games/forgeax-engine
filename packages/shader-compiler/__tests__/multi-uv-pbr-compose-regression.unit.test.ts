// multi-uv-pbr-compose-regression.unit.test.ts
// feat-20260629-multi-uv-set-support — implement-review round 1 F-3 + F-7.
// The built-in PBR reserves UV0-UV7 and uses each material slot's texCoord
// selector to sample the corresponding glTF texture coordinate set.
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
//   Built-in multi-UV: standard-PBR + skin reserve all eight supported sets.
//        Missing mesh sets remain byte-stable through clamp-to-last aliases. A
//        custom 2-UV-set fixture below still pins the opt-in reflection path.

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

  it('built-in PBR reflects all eight supported UV sets for per-slot texCoord', async () => {
    const r = await composePbr('default-standard-pbr.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The built-in PBR reserves every supported set so each texture slot can
    // select its glTF texCoord. Single-UV meshes stay byte-identical through
    // clamp-to-last aliases.
    expect(r.value.uvSetCount).toBe(8);
  });

  it('built-in PBR skin reflects all eight supported UV sets', async () => {
    const r = await composePbr('default-standard-pbr-skin.wgsl');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.uvSetCount).toBe(8);
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

  it('built-in PBR fragment resolves each texture through the material UV transform (feat-city-glb Bug 4 multi-UV)', async () => {
    // feat-city-glb Bug 4: the fragment now picks its UV set per-material via
    // `selectUv(in)` = select(in.uv, in.uv1, material.coordinatesSet >= 0.5). It samples
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
    // The authored material now carries one UV transform per texture slot;
    // the composed shader resolves each slot through that shared helper.
    expect(fragmentBody).toMatch(/transformedMaterialUv\s*\(\s*material\.baseColorCoordinates\s*,\s*in\s*\)/);
    expect(fragmentBody).toMatch(/transformedMaterialUv\s*\(\s*material\.normalCoordinates\s*,\s*in\s*\)/);
  });
});
