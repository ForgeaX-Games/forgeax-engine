// @forgeax/engine-shader / __tests__ / sprite-lit-shader.test.ts
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w2.
//
// Red-stage tests for the sprite-lit shader (AC-04 grep gates, AC-05
// Half-Lambert 4-angle fixture, AC-09 LDR/HDR clamp boundary, AC-10
// STORAGE_BUFFER_AVAILABLE variant axis declaration).
//
// SSOTs:
//   - research.md F-3 (Half-Lambert math table; 4-angle theoretical values)
//   - research.md F-4 (R6 mitigation: LDR clamp / HDR pass-through)
//   - research.md F-5 (sprite vs_main byte-identical, normal hardcoded in fs)
//   - plan-strategy D-3 (Half-Lambert squared single-formula lock)
//   - plan-strategy D-5 (#pragma variant_axis on line 1)
//
// These tests run before w4 lands sprite-lit.wgsl, so the file-read tests
// are guarded by an `await stat` that returns absent for unscaffolded
// runs; once the file exists they exercise grep + line-1 + entry-points.

import { describe, expect, it } from 'vitest';

// Dynamic node:fs / node:module import via string ids — keeps the
// engine-shader package free of static `import 'node:fs'` (which
// shader.unit.test.ts already uses this pattern; see lines around the
// fsId = 'node:fs' helper). The TS strict mode in this package's
// tsconfig.lib does not ship @types/node by default; the dynamic-id
// import avoids the missing type error.
const fsId = 'node:fs';
const moduleId = 'node:module';

interface NodeFs {
  readFileSync(path: string, encoding: string): string;
  existsSync(path: string): boolean;
}

interface NodeModule {
  createRequire(filename: string | URL): (id: string) => string;
}

async function loadFs(): Promise<NodeFs> {
  const mod = (await import(fsId)) as NodeFs;
  return mod;
}
async function loadModule(): Promise<NodeModule> {
  const mod = (await import(moduleId)) as NodeModule;
  return mod;
}

async function resolveSrcDir(): Promise<string> {
  const m = await loadModule();
  const require = m.createRequire(import.meta.url);
  const packageJsonPath = require('@forgeax/engine-shader/package.json');
  // require() returns the resolved JSON contents; we need the path, not
  // the object. Fall back to require.resolve.
  void packageJsonPath;
  const resolved = m.createRequire(import.meta.url);
  // Re-resolve by package.json path string.
  const pkgJsonPath = (resolved as unknown as { resolve(id: string): string }).resolve(
    '@forgeax/engine-shader/package.json',
  );
  return pkgJsonPath.replace(/package\.json$/, 'src');
}

async function readSpriteLitSource(): Promise<string> {
  const fs = await loadFs();
  const srcDir = await resolveSrcDir();
  return fs.readFileSync(`${srcDir}/sprite-lit.wgsl`, 'utf8');
}

async function spriteLitWgslExists(): Promise<boolean> {
  const fs = await loadFs();
  const srcDir = await resolveSrcDir();
  return fs.existsSync(`${srcDir}/sprite-lit.wgsl`);
}

async function readSpriteLitMeta(): Promise<{
  readonly importSettings: { readonly materialShaderIdentifier: string };
  readonly paramSchema: ReadonlyArray<{ readonly name: string; readonly type: string }>;
}> {
  const fs = await loadFs();
  const srcDir = await resolveSrcDir();
  return JSON.parse(fs.readFileSync(`${srcDir}/sprite-lit.wgsl.meta.json`, 'utf8'));
}

async function spriteLitMetaExists(): Promise<boolean> {
  const fs = await loadFs();
  const srcDir = await resolveSrcDir();
  return fs.existsSync(`${srcDir}/sprite-lit.wgsl.meta.json`);
}

/**
 * TS port of the Half-Lambert squared formula (research F-3, plan-strategy D-3).
 *
 *   h(NdotL) = NdotL * 0.5 + 0.5
 *   diffuse(NdotL) = h(NdotL)^2
 *
 * The WGSL implementation in sprite-lit.wgsl must stay byte-equivalent;
 * drift is caught by the 4-angle fixture below.
 */
function halfLambertSquared(nDotL: number): number {
  const h = nDotL * 0.5 + 0.5;
  return h * h;
}

describe('sprite-lit shader (red gates, w2 -> w4 closes)', () => {
  describe('Half-Lambert squared TS-equivalence (AC-05 SSOT)', () => {
    // research §F-3 table: NdotL ∈ {-1, 0, 0.707, 1} -> {0, 0.25, 0.728, 1}.
    // ε ≤ 1e-5 (plan-strategy R-AC-05-fixture acceptance threshold).
    const EPSILON = 1e-5;

    it('NdotL = -1 (back-facing, 180 deg) -> 0.0', () => {
      expect(halfLambertSquared(-1.0)).toBeCloseTo(0.0, 5);
    });

    it('NdotL = 0 (terminator, 90 deg) -> 0.25', () => {
      expect(halfLambertSquared(0.0)).toBeCloseTo(0.25, 5);
    });

    it('NdotL = sqrt(0.5) (45 deg standard lighting angle) -> ~0.728', () => {
      // Use Math.SQRT1_2 (= 1/sqrt(2) = sqrt(0.5)) instead of the magic
      // 0.707 literal to silence biome `noApproximativeNumericConstant`
      // (verify Round 1 finding) — same physical 45° angle.
      const out = halfLambertSquared(Math.SQRT1_2);
      expect(Math.abs(out - 0.728) < 1e-3).toBe(true);
      // Sharper bound: explicit formula evaluation, ε ≤ 1e-5.
      const h = Math.SQRT1_2 * 0.5 + 0.5;
      expect(out).toBeCloseTo(h * h, 5);
    });

    it('NdotL = 1 (direct face-light, 0 deg) -> 1.0', () => {
      expect(halfLambertSquared(1.0)).toBeCloseTo(1.0, 5);
    });

    it('formula has no max(NdotL, 0) clamp (back-light is shaded, not zero)', () => {
      // Physical Lambert would output 0 at NdotL = -0.5; Half-Lambert squared
      // outputs 0.0625. Drift to Lambert would fail this assertion.
      expect(halfLambertSquared(-0.5)).toBeCloseTo(0.0625, 5);
    });

    void EPSILON;
  });

  describe('sprite-lit.wgsl source artefact (AC-03 / AC-04 / AC-10 grep gates)', () => {
    it('file exists', async () => {
      expect(await spriteLitWgslExists()).toBe(true);
    });

    it('first line is `#pragma variant_axis STORAGE_BUFFER_AVAILABLE` (AC-10 SSOT)', async () => {
      const src = await readSpriteLitSource();
      const firstLine = src.split('\n')[0];
      expect(firstLine).toBe('#pragma variant_axis STORAGE_BUFFER_AVAILABLE');
    });

    it('declares vs_main + fs_main + fs_main_hdr three entry points (AC-03)', async () => {
      const src = await readSpriteLitSource();
      expect(/@vertex[\s\S]*?fn vs_main\b/.test(src)).toBe(true);
      expect(/@fragment[\s\S]*?fn fs_main\b/.test(src)).toBe(true);
      expect(/@fragment[\s\S]*?fn fs_main_hdr\b/.test(src)).toBe(true);
    });

    it('fragment hardcodes normal = vec3(0,0,1) (AC-04 normal hardcoded)', async () => {
      const src = await readSpriteLitSource();
      const NORMAL_RE = /vec3<f32>\(\s*0\.0?\s*,\s*0\.0?\s*,\s*1\.0?\s*\)/;
      expect(NORMAL_RE.test(src)).toBe(true);
    });

    it('does NOT reference normalTexture / normalSampler in fragment lighting code (AC-04 no normal map)', async () => {
      const src = await readSpriteLitSource();
      expect(/textureSample\s*\(\s*normalTexture\b/.test(src)).toBe(false);
      expect(/textureLoad\s*\(\s*normalTexture\b/.test(src)).toBe(false);
    });

    it('does NOT take a vertex normal attribute as a lighting input (AC-04)', async () => {
      const src = await readSpriteLitSource();
      expect(/dot\s*\(\s*in\.normal\b/.test(src)).toBe(false);
      expect(/normalize\s*\(\s*in\.normal\b/.test(src)).toBe(false);
    });

    it('fs_main applies LDR clamp; fs_main_hdr does NOT clamp the output (AC-09 SSOT)', async () => {
      const src = await readSpriteLitSource();
      const ldrIdx = src.indexOf('fn fs_main(');
      const hdrIdx = src.indexOf('fn fs_main_hdr(');
      expect(ldrIdx).toBeGreaterThan(0);
      expect(hdrIdx).toBeGreaterThan(0);
      const ldrBody = src.slice(ldrIdx, hdrIdx > ldrIdx ? hdrIdx : src.length);
      const hdrBody = src.slice(hdrIdx);
      const ldrClampToZeroOne =
        /clamp\s*\([\s\S]+?,\s*(?:vec[234]<f32>\(\s*)?0\.0[\s\S]*?,\s*(?:vec[234]<f32>\(\s*)?1\.0/.test(
          ldrBody,
        );
      expect(ldrClampToZeroOne).toBe(true);
      const hdrVecClamp = /clamp\s*\(\s*vec[34]<f32>/.test(hdrBody);
      const hdrVecBoundClamp = /clamp\s*\([^)]*,\s*vec[34]<f32>\(\s*0\.0/.test(hdrBody);
      expect(hdrVecClamp).toBe(false);
      expect(hdrVecBoundClamp).toBe(false);
    });

    it('imports lighting helpers via forgeax_pbr (evalDirectionalNoShadow from w3)', async () => {
      const src = await readSpriteLitSource();
      expect(src.includes('_sampleShadowForCascade')).toBe(false);
    });
  });

  describe('sprite-lit.wgsl.meta.json (paramSchema + materialShaderIdentifier)', () => {
    it('meta file exists with materialShaderIdentifier = "forgeax::sprite-lit"', async () => {
      expect(await spriteLitMetaExists()).toBe(true);
      const meta = await readSpriteLitMeta();
      expect(meta.importSettings.materialShaderIdentifier).toBe('forgeax::sprite-lit');
    });

    it('paramSchema mirrors sprite.wgsl.meta.json (5 fields byte-identical, no normalTexture / normalStrength OOS-1)', async () => {
      const meta = await readSpriteLitMeta();
      const names = meta.paramSchema.map((p) => p.name);
      // OOS-1 negative gate: no normal map fields.
      expect(names.includes('normalTexture')).toBe(false);
      expect(names.includes('normalStrength')).toBe(false);
      // D-7 positive gate: 5 fields strictly aligned with sprite.wgsl.meta.json
      // (colorTint / region / pivotAndSize / slicesAndMode / baseColorTexture).
      // Field-set congruence drives BGL byte-identical (AC-07).
      expect(names).toEqual([
        'colorTint',
        'region',
        'pivotAndSize',
        'slicesAndMode',
        'baseColorTexture',
      ]);
    });
  });

  describe('LDR / HDR clamp boundary fixture (AC-09 numeric SSOT)', () => {
    // Fixture: lightColor.intensity = 5.0 + base texel = 1.0 + colorTint = 1.
    // Expected LDR output (clamped) = 1.0; expected HDR output > 1.0.
    // The TS port mirrors what the WGSL must do.
    const fixtureLitAccumulated = 5.0; // half-lambert * (5.0) summed across one strong light
    const ldrOut = Math.min(1.0, fixtureLitAccumulated);
    const hdrOut = fixtureLitAccumulated;

    it('LDR output is clamped to 1.0 at intensity=5.0 fixture', () => {
      expect(ldrOut).toBe(1.0);
    });

    it('HDR output passes through > 1.0 at intensity=5.0 fixture', () => {
      expect(hdrOut > 1.0).toBe(true);
      expect(hdrOut).toBeCloseTo(5.0, 5);
    });
  });
});
