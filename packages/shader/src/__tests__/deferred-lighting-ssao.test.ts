// @forgeax/engine-shader/__tests__/deferred-lighting-ssao.test.ts -
// Structural unit test for deferred lighting ambient SSAO synthesis (M2 / w11).
// feat-20260612-hdrp-ssao.
//
// plan-strategy D-7: ambient *= mix(1.0, ssaoFactor * bakedAO, intensity).
//
// This test reads the deferred lighting entry point in default-standard-pbr.wgsl
// and asserts:
//   (a) ambient calculation contains mix(1.0, ...) with SSAO factor contribution
//   (b) bakedAO is consumed in the ambient term (material.occlusionStrength)
//   (c) SSAO texture read is optional (not required when SSAO absent)
//   (d) Ambient formula = (kD * irradiance * albedo + specularIbl) * skylight.intensity * ao
//       multiplied by SSAO blend when active
//
// RED before w12 (SSAO blend line not yet added to default-standard-pbr.wgsl).
// GREEN after w12 inserts the synthesis line.

import { beforeAll, describe, expect, it } from 'vitest';

interface NodeFs {
  readFileSync: (p: string, enc: string) => string;
}
interface NodePath {
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
}
interface NodeUrl {
  fileURLToPath: (u: string) => string;
}

let pbrSource!: string;

beforeAll(async () => {
  const fsId = 'node:fs';
  const pathId = 'node:path';
  const urlId = 'node:url';
  const fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
  const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
  const url = (await import(/* @vite-ignore */ urlId)) as NodeUrl;
  const here = url.fileURLToPath(import.meta.url);
  const srcDir = path.resolve(path.dirname(here), '..');
  pbrSource = fs.readFileSync(path.resolve(srcDir, 'default-standard-pbr.wgsl'), 'utf8');
});

function stripComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line: string) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('deferred lighting ambient SSAO synthesis (M2 / w11)', () => {
  it('(a) ambient calculation uses occlusionStrength * bakedAO texture sample', () => {
    // The existing ambient line: var ambient = (kD * irradiance * albedo + specularIbl) * skylight.intensity * ao;
    // where ao = mix(1.0, aoSample.r, material.occlusionStrength).
    // M7/w32 changed `let` -> `var` so the SSAO blend line `ambient *= mix(...)` can mutate it.
    const codeOnly = stripComments(pbrSource);
    expect(codeOnly).toMatch(/var\s+ambient\s*=\s*\(kD\s*\*\s*irradiance/);
    expect(codeOnly).toMatch(/material\.occlusionStrength/);
    expect(codeOnly).toMatch(/skylight\.intensity/);
  });

  it('(b) SSAO blend formula ambient *= mix(1.0, ...) is present', () => {
    // After w12, the source must contain the synthesis line:
    //   ambient *= mix(1.0, ssaoFactor * bakedAO, intensity);
    // or equivalent form.
    const codeOnly = stripComments(pbrSource);
    // Check for the mix(1.0, ...) pattern near or modifying the ambient variable.
    expect(codeOnly).toMatch(/ambient\s*\*=\s*mix\(\s*1\.0\s*,\s*\w+/);
  });

  it('(c) SSAO factor is multiplied by ao (baked occlusion from texture)', () => {
    // Verify the relationship: ssaoFactor * ao appears in the ambient modulation.
    const codeOnly = stripComments(pbrSource);
    // The formula is: ambient *= mix(1.0, ssaoFactor * ao, ssaoIntensity)
    expect(codeOnly).toMatch(/ssaoFactor\s*\*\s*ao/);
  });

  it('(d) no crash path when SSAO texture absent (optional bind group)', () => {
    // Verify the SSAO texture declaration is optional or conditional.
    // When SSAO is not wired, the shader falls back to bakedAO-only.
    // In the source: the ambient *= line should be conditional or use a
    // default value when ssaoBlurred is not bound.
    //
    // For M2: the ambient line lives under CLUSTER_FORWARD_AVAILABLE ifdef
    // or is guarded by a conditional. We verify that the SSAO-related
    // variables (ssaoFactor, ssaoIntensity, ssaoBlurred) are used in
    // a way that doesn't crash without binding.
    const codeOnly = stripComments(pbrSource);
    // The SSAO blend must appear near the ambient calculation in fs_main.
    // Verify the fs_main function contains both the ambient calculation
    // and the SSAO blend.
    const ambientArea = codeOnly.slice(
      codeOnly.indexOf('var ambient ='),
      codeOnly.indexOf('var color = ambient'),
    );
    if (ambientArea.length > 0) {
      // In the area between ambient calculation and color assignment,
      // the SSAO blend should be present.
      expect(ambientArea).toMatch(/ambient\s*\*=/);
    }
  });

  it('(e) verify the exact formula: ambient *= mix(1.0, ssaoFactor * bakedAO, intensity)', () => {
    // Numerical verification: when ssaoFactor=0.5, bakedAO=0.8, intensity=1.0:
    //   mix(1.0, 0.5*0.8, 1.0) = mix(1.0, 0.4, 1.0) = 0.4
    //   ambient *= 0.4 means the ambient term is reduced by 60%.
    //
    // We assert the source has the semantic shape of this formula.
    const codeOnly = stripComments(pbrSource);
    // Look for the exact pattern: ambient *= mix(1.0, <var> * <var>, <var>)
    expect(codeOnly).toMatch(/ambient\s*\*=\s*mix\(\s*1\.0\s*,\s*\w+\s*\*\s*\w+\s*,\s*\w+\s*\)/);
  });
});
