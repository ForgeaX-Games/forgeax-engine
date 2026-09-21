import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import { resolveMaterialAsset } from '../../../types/src/material/resolve.js';
import { materialNormalScale } from '../material-normal-scale.js';
import { Materials } from '../materials.js';

describe('native material normal scale', () => {
  it('resolves the unmodified native Pack authoring pattern and preserves its scale', () => {
    const standard = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const material = {
      ...standard,
      values: {
        ...standard.values,
        normalScale: 0.7,
        normalTexture: { texture: AssetGuid.random() },
      },
    };
    const result = resolveMaterialAsset('counter', { counter: material });
    expect(result.ok).toBe(true);
    if (result.ok) expect(materialNormalScale(result.value.asset.values ?? {})).toBe(0.7);
  });
  it('supports explicit zero and does not override the legacy texture scale by default', () => {
    expect(
      materialNormalScale(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          normalScale: 0,
          normalTexture: { texture: 1, normalScale: 0.6 },
        }).values ?? {},
      ),
    ).toBe(0);
    expect(
      materialNormalScale(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          normalTexture: { texture: 1, normalScale: 0.6 },
        }).values ?? {},
      ),
    ).toBe(0.6);
    expect(materialNormalScale({})).toBe(1);
  });
  it('rejects nonfinite authoring values and still rejects unrelated unknown parameters', () => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], normalScale: NaN })).toThrow(
      'finite',
    );
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const result = resolveMaterialAsset('bad', {
      bad: { ...material, values: { ...material.values, unrelated: 1 } },
    });
    expect(result.ok).toBe(false);
  });
});
