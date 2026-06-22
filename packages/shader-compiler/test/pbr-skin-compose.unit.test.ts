// pbr-skin-compose.unit.test.ts — feat-20260523-skin-skeleton-animation M3 / T-32.
//
// Tests that compileShader composes default-standard-pbr-skin.wgsl successfully
// through naga_oil (naga parse/validate passes). Verifies the composed output
// contains the skin-specific bindings and vertex inputs.
//
// Anchors:
//   - plan acceptanceCheck: compileShader not error
//   - plan acceptanceCheck: compose output contains palette: array<mat4x4<f32>>
//   - plan acceptanceCheck: compose output contains skinIndex/skinWeight @location
//   - AC-23 / AC-24 vertex input + palette binding verification
//   - plan-strategy D-3: independent WGSL template compose

import { compileShader } from '@forgeax/engine-shader-compiler';
import { beforeAll, describe, expect, it } from 'vitest';

// === Engine import map (mirrors vite-plugin-shader's loadEngineShaderEntries) =====
//
// Each #import directive in default-standard-pbr-skin.wgsl resolves to a
// sibling .wgsl file in packages/shader/src/. The import map keys are the
// #define_import_path values declared in the target files.
//
// Building the import map by reading files from the source directory avoids
// a hard resolve-path dependency on @forgeax/engine-shader/package.json;
// the test runs under vitest where the working directory is the shader
// package root, and the src/ files are accessible via relative paths.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    // feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-1:
    // lighting-directional.wgsl now imports forgeax_pbr::shadow_pcf (shared PCF core).
    'forgeax_pbr::shadow_pcf': read('shadow-pcf.wgsl'),
  };
}

const engineImports = loadEngineImports();

describe('T-32 — default-standard-pbr-skin.wgsl compose test', () => {
  let composedWgsl: string;

  beforeAll(async () => {
    const srcPath = join(import.meta.dirname, '..', '..', 'shader', 'src', 'default-standard-pbr-skin.wgsl');
    let source = readFileSync(srcPath, 'utf8');
    source = source.replace(/^\s*#pragma\s+.*$/gm, '');
    const r = await compileShader(source, {
      id: srcPath,
      imports: engineImports,
      defines: { STORAGE_BUFFER_AVAILABLE: true },
    });
    if (!r.ok) {
      throw new Error(`compileShader failed: ${r.error.message}\nhint: ${r.error.hint}`);
    }
    composedWgsl = r.value.manifestEntry.wgsl;
  });

  it('compileShader succeeds (naga parse/validate passes)', () => {
    // If beforeAll completed without throwing, compose succeeded.
    expect(composedWgsl.length).toBeGreaterThan(0);
  });

  it('composed output contains palette binding declaration', () => {
    // The composed WGSL should contain the palette storage binding at @group(2) @binding(1).
    // naga_oil may reorder or prefix member names; check for the palette
    // variable declaration and the binding annotations.
    expect(composedWgsl).toMatch(/palette/);
    expect(composedWgsl).toMatch(/binding\(1\)/);
    expect(composedWgsl).toMatch(/array<mat4x4<f32>>/);
  });

  it('composed output contains skinIndex vertex input @location(4)', () => {
    // skinIndex at @location(4) — may be renamed by naga_oil writeback
    expect(composedWgsl).toMatch(/skinIndex/);
    expect(composedWgsl).toMatch(/location\(4\)/);
  });

  it('composed output contains skinWeight vertex input @location(5)', () => {
    // skinWeight at @location(5) -- float32x4 per vertex-attribute-layout.ts
    expect(composedWgsl).toMatch(/@location\(5\)\s*\w*\s*skinWeight\s*:\s*vec4<f32>/);
  });

  it('composed output contains meshes binding (existing @group(2)@binding(0))', () => {
    // The meshes binding should be preserved from common.wgsl at @group(2)@binding(0)
    expect(composedWgsl).toMatch(/@group\(2\)\s*@binding\(0\)/);
  });

  it('composed output contains a vertex entry point vs_main', () => {
    expect(composedWgsl).toMatch(/fn\s+vs_main\s*\(/);
  });

  it('composed output contains a fragment entry point fs_main', () => {
    expect(composedWgsl).toMatch(/fn\s+fs_main\s*\(/);
  });
});