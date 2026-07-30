import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MATERIAL_MODULES,
  type BuiltinMaterialKind,
  createBuiltinMaterialAsset,
} from '../index.js';
import type { MaterialShaderArtifact } from '../material/artifact-types.js';

const kinds: readonly BuiltinMaterialKind[] = ['standard', 'unlit', 'sprite'];

describe('built-in MaterialAsset sources', () => {
  it.each(kinds)('uses one authored MaterialAsset contract for %s', (kind) => {
    const material = createBuiltinMaterialAsset(kind);
    const pass = material.passes?.[0];

    expect(material.kind).toBe('material');
    expect(pass?.program.module).toBe(BUILTIN_MATERIAL_MODULES[kind]);
    expect(pass).not.toHaveProperty('shader');
    expect(material.parameters?.length).toBeGreaterThan(0);
    expect(material.values).toBeDefined();
  });

  it('keeps cooked artifact identity separate from authored values', () => {
    const material = createBuiltinMaterialAsset('standard');
    const artifact: MaterialShaderArtifact = {
      material: 'builtin-standard',
      pass: material.passes?.[0]?.name ?? 'forward',
      wgsl: 'builtin-standard-wgsl',
      bindings: [],
      deps: [BUILTIN_MATERIAL_MODULES.standard],
      vertexInputs: [],
      specializationKey: 'builtin-standard-key',
    };

    expect(artifact.specializationKey).toBe('builtin-standard-key');
    expect(artifact.deps).toEqual([BUILTIN_MATERIAL_MODULES.standard]);
    expect(material.values?.baseColor).toEqual([1, 1, 1, 1]);
    expect(
      { ...material, values: { ...material.values, baseColor: [0.2, 0.3, 0.4, 1] } }.values,
    ).toMatchObject({ baseColor: [0.2, 0.3, 0.4, 1] });
  });
});
