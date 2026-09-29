import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../${name}.wgsl`, import.meta.url), 'utf8');

describe('Standard ambient occlusion consumer contract', () => {
  it.each([
    'default-standard-pbr',
    'default-standard-pbr-skin',
    'standard-surface',
  ])('%s consumes the shared projected AO', (name) => {
    const code = source(name).replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('sampleStandardAmbientOcclusion(in.worldPos, view.worldViewProj,');
    expect(code).toContain('ssaoBlurredTexture, ssaoBlurredSampler');
    expect(code).not.toMatch(/ssaoFactor\s*\*\s*ao/);
  });
  it('defines zero strength independently of pow(0,0), and keeps strength non-negative', () => {
    const code = source('standard-cluster');
    expect(code).toContain('if (strength <= 0.0) { return 1.0; }');
    expect(code).toContain('return pow(clamp(textureSampleLevel(');
  });
});
