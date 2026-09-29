import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { materialArtifactProgramIdentity } from '../assembly/material/artifact-program-identity';

function artifact(source: string): MaterialShaderArtifact {
  return { program: createMaterialShaderProgram(source) } as MaterialShaderArtifact;
}

describe('material artifact program identity', () => {
  it('shares immutable source identity across pass projections', () => {
    const published = artifact('fn fs_main() -> vec4f { return vec4f(1.0); }');
    const projected = { ...published, fragmentEntry: 'fs_gbuffer' };
    expect(projected.program).toBe(published.program);
    expect(materialArtifactProgramIdentity(projected)).toBe(published.program.identity);
  });

  it('publishes changed source and layout as one replacement', () => {
    const original = artifact('fn fs_main() -> vec4f { return vec4f(1.0); }');
    const edited = {
      ...original,
      program: createMaterialShaderProgram('@group(2) @binding(3) var<uniform> cluster: vec4f;'),
    };
    expect(materialArtifactProgramIdentity(edited)).not.toBe(
      materialArtifactProgramIdentity(original),
    );
    expect(edited.program.group2).toBe('cluster');
    expect(original.program.group2).toBe('mesh');
  });

  it('distinguishes specialization identities without rescanning source', () => {
    const original = artifact('source');
    const specialized = { ...original, specializationKey: 'scene-index-program' };
    expect(materialArtifactProgramIdentity(specialized)).toBe('specialization:scene-index-program');
    expect(specialized.program).toBe(original.program);
  });
});
