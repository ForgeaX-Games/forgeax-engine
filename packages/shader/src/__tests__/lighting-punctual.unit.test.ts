import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderPath = join(dirname(fileURLToPath(import.meta.url)), '../lighting-punctual.wgsl');
const hdrpShaderPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../hdrp-cluster-forward.wgsl',
);
const pbrShaderPath = join(dirname(fileURLToPath(import.meta.url)), '../default-standard-pbr.wgsl');

describe('direct punctual lighting shader contract', () => {
  it('exposes independent point and spot paths with explicit range and cone inputs', async () => {
    const source = await readFile(shaderPath, 'utf8');

    expect(source).toContain('fn evalPoint(');
    expect(source).toContain('fn evalSpot(');
    expect(source).toContain('invRangeSquared');
    expect(source).toContain('cosInner');
    expect(source).toContain('cosOuter');
    expect(source).toContain('smoothstep(cosOuter, cosInner');
  });

  it('does not introduce a separate physical-light component or intensity profile', async () => {
    const source = await readFile(shaderPath, 'utf8');

    expect(source).not.toContain('PhysicalLight');
    expect(source).not.toMatch(/intensityMultiplier|magicMultiplier|profile/);
  });

  it('leaves spot direction normalization to extract instead of HDRP', async () => {
    const source = await readFile(shaderPath, 'utf8');

    expect(source).toContain('lightDir');
    expect(source).not.toContain('normalize(lightDir)');
  });

  it('keeps cluster punctual evaluation in the shared lighting owner', async () => {
    const source = await readFile(hdrpShaderPath, 'utf8');

    expect(source).toContain('kind_and_shadow');
    expect(source).toContain('evalPoint');
    expect(source).toContain('evalSpot');
    expect(source).toContain('evalSpotShadowed');
    expect(source).not.toContain('fn evaluate_point_light(');
    expect(source).not.toContain('fn evaluate_spot_light(');
    expect(source).not.toMatch(/kind\s*==\s*KIND_POINT[\s\S]{0,80}else\s*\{/);
  });

  it('decodes HDRP spot cone lanes in the shared evaluator order', async () => {
    const source = await readFile(hdrpShaderPath, 'utf8');

    expect(source).toContain('light.color.w, light.direction.w, light.position.w');
    expect(source).not.toContain('light.direction.w, light.color.w, light.position.w');
  });

  it('passes precomputed base and clearcoat roughness/F0 facts to cluster lights', async () => {
    const source = await readFile(pbrShaderPath, 'utf8');

    expect(source).toContain(
      'evaluate_cluster_lights(in.ndc, in.viewZ, in.worldPos, n, v, albedo, metallic, a, f0)',
    );
    expect(source).toContain('coatAlpha, vec3<f32>(0.04)');
  });
});
