import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderPath = join(dirname(fileURLToPath(import.meta.url)), '../lighting-punctual.wgsl');
const hdrpShaderPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../hdrp-cluster-forward.wgsl',
);

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
    const source = await readFile(hdrpShaderPath, 'utf8');

    expect(source).toContain('let spot_dir = light.direction.xyz;');
    expect(source).not.toContain('let spot_dir = normalize(light.direction.xyz);');
  });
});
