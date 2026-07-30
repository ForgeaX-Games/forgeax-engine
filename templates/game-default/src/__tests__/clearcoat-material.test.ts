import { describe, expect, it } from 'vitest';
import { CLEARCOAT_ROUGHNESS, CLEARCOAT_STRENGTH, withClearcoat } from '../clearcoat-material';

describe('withClearcoat', () => {
  it('preserves authored passes and adds normalized PBR coat parameters', () => {
    const source = {
      kind: 'material' as const,
      passes: [{ name: 'Forward', shader: 'forgeax::default-standard-pbr' }],
      paramValues: { baseColor: [0.8, 0.2, 0.1, 1], roughness: 0.4 },
    };
    const coated = withClearcoat(source);
    expect(coated?.passes).toBe(source.passes);
    expect(coated?.paramValues).toEqual({
      baseColor: source.paramValues.baseColor,
      roughness: 0.4,
      clearcoat: CLEARCOAT_STRENGTH,
      clearcoatRoughness: CLEARCOAT_ROUGHNESS,
    });
    expect(source.paramValues).not.toHaveProperty('clearcoat');
  });

  it('leaves non-PBR authored materials untouched', () => {
    expect(withClearcoat({ kind: 'material', passes: [{ name: 'Forward', shader: 'forgeax::default-unlit' }] })).toBeUndefined();
  });
});
