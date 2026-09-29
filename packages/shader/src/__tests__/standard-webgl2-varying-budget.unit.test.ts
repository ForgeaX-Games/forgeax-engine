import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shaderFiles = ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl'] as const;

describe('Standard WebGL2 inter-stage varying budget', () => {
  it.each(shaderFiles)('%s packs Surface position and view depth into the last varying', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');

    expect(source).toContain('@location(7) positionOSAndViewZ : vec4<f32>');
    expect(source).not.toMatch(/@location\(15\)\s+positionOS\s*:/u);
    expect(source).toContain('out.positionOSAndViewZ = vec4<f32>(localPosition, sceneViewZ(');
    expect(source).toContain('in.positionOSAndViewZ.xyz');
    expect(source).toContain('in.positionOSAndViewZ.w');
  });
});
