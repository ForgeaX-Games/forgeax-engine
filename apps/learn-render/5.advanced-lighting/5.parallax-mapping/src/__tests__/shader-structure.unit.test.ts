// Structural assertions on parallax.wgsl. The shading math needs a GPU to
// validate (covered by the dawn + browser smokes); this unit test guards the
// SOURCE STRUCTURE that the smokes assume: all three LO 5.5 algorithm paths are
// present and discriminable, the engine TBN helper is imported, and the
// @group(1) texture bindings follow the sampler-first order the engine derives.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SHADER_PATH = resolve(here, '..', 'parallax.wgsl');
const META_PATH = resolve(here, '..', 'parallax.wgsl.meta.json');
const src = readFileSync(SHADER_PATH, 'utf8');

describe('parallax.wgsl source structure (LO 5.5)', () => {
  it('declares the module import path + reuses the engine TBN helper', () => {
    expect(src).toContain('#define_import_path learn_render::5_5_parallax');
    expect(src).toContain('#import forgeax_pbr::tbn');
    expect(src).toContain('decodeTangentSpaceNormalRg');
  });

  it('carries all three LO 5.5 algorithm paths, each discriminable', () => {
    expect(src).toMatch(/fn\s+parallaxBasic\s*\(/);
    expect(src).toMatch(/fn\s+parallaxSteep\s*\(/);
    expect(src).toMatch(/fn\s+parallaxOcclusion\s*\(/);
  });

  it('dispatches the three paths by material.algoMode (f32 threshold)', () => {
    expect(src).toContain('material.algoMode');
    // basic must NOT divide by viewDir.z (LO offset-limiting fidelity, F-1);
    // steep/POM DO divide by viewDir.z. So the "/ viewDir.z" token appears in
    // steep + POM but the basic function body must not contain it.
    const basicBody = src.slice(
      src.indexOf('fn parallaxBasic'),
      src.indexOf('fn parallaxSteep'),
    );
    expect(basicBody).not.toContain('/ viewDir.z');
    expect(src).toContain('/ viewDir.z'); // present in steep/POM
  });

  it('declares @group(1) textures sampler-first (baseColor/normal/height)', () => {
    // The derived BGL emits, per texture, a sampler at the odd binding then the
    // texture at the next. Assert the exact ordering for all three textures.
    expect(src).toMatch(/@group\(1\)\s+@binding\(1\)\s+var\s+\w*[Ss]ampler\s*:\s*sampler/);
    expect(src).toMatch(/@group\(1\)\s+@binding\(2\)\s+var\s+baseColorTexture\s*:\s*texture_2d/);
    expect(src).toMatch(/@group\(1\)\s+@binding\(4\)\s+var\s+normalTexture\s*:\s*texture_2d/);
    expect(src).toMatch(/@group\(1\)\s+@binding\(6\)\s+var\s+heightTexture\s*:\s*texture_2d/);
    // No user binding above 6 (engine reserves 7.. for IBL + emissive/AO).
    expect(src).not.toMatch(/@group\(1\)\s+@binding\([7-9]\d*\)/);
  });
});

describe('parallax.wgsl.meta.json paramSchema', () => {
  const meta = JSON.parse(readFileSync(META_PATH, 'utf8')) as {
    importSettings: { materialShaderIdentifier: string };
    paramSchema: Array<{ name: string; type: string }>;
  };

  it('matches the registered shader identifier', () => {
    expect(meta.importSettings.materialShaderIdentifier).toBe('learn-render::5-5-parallax');
  });

  it('declares three texture fields incl. heightTexture (the per-shader BGL win)', () => {
    const textures = meta.paramSchema.filter((p) => p.type === 'texture2d').map((p) => p.name);
    expect(textures).toEqual(['baseColorTexture', 'normalTexture', 'heightTexture']);
  });

  it('orders heightScale + algoMode as the only two f32 fields (UBO overlay slots 4/5)', () => {
    const f32s = meta.paramSchema.filter((p) => p.type === 'f32').map((p) => p.name);
    expect(f32s).toEqual(['heightScale', 'algoMode']);
  });
});
