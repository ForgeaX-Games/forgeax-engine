import { describe, expect, it } from 'vitest';
import { materialTextureUvScale } from '../record/main-pass-material';

describe('material texture UV scale [w37]', () => {
  it('maps a non-aligned BC7 logical edge below padded physical storage', () => {
    const scale = materialTextureUvScale({ width: 2085, height: 1573, format: 'bc7-rgba-unorm' });
    expect(scale).toEqual([2085 / 2088, 1573 / 1576]);
    expect(scale[0]).toBeLessThan(1);
    expect(scale[1]).toBeLessThan(1);
  });

  it('uses identity scale for uncompressed and fallback texture bindings', () => {
    expect(materialTextureUvScale(undefined)).toEqual([1, 1]);
    expect(materialTextureUvScale({ width: 17, height: 9, format: 'rgba8unorm' })).toEqual([1, 1]);
  });
});
