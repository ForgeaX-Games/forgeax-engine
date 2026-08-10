import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(
  fileURLToPath(new URL('../default-standard-pbr.wgsl', import.meta.url)),
  'utf8',
);

describe('standard PBR MASK alpha contract', () => {
  it('multiplies factor alpha by sampled texture alpha before discard', () => {
    expect(shader).toContain('alphaTest(material.baseColor.a * baseSample.a)');
  });

  it('matches Three r184 alphaTest by discarding values equal to or below cutoff', () => {
    expect(shader).toContain('alpha <= material.alphaCutoff');
    expect(shader).not.toContain('alpha < material.alphaCutoff');
  });
});
