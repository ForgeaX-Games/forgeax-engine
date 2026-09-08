import {
  createBuiltinMaterialAsset,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';

describe('vertex color does not change the material contract', () => {
  it('keeps colored and plain materials on the same schema and resource identity', () => {
    const plain = createBuiltinMaterialAsset('standard');
    const colored = createBuiltinMaterialAsset('standard');
    expect(colored.parameters).toEqual(plain.parameters);
    expect(colored.passes).toEqual(plain.passes);
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name)).toContain('baseColor');
    expect(DEFAULT_UNLIT_PARAM_SCHEMA.some((entry) => entry.name === 'color')).toBe(false);
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.some((entry) => entry.name === 'color')).toBe(false);
  });

  it('keeps vertex color out of the authored material flags and bindings', () => {
    const material = createBuiltinMaterialAsset('unlit');
    expect(JSON.stringify(material)).not.toMatch(/hasColor|VERTEX_COLOR_AVAILABLE|colorBinding/i);
    expect(material.passes?.[0]?.program).not.toHaveProperty('color');
  });
});
