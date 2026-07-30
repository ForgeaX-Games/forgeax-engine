import type { AssetGuid } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createMaterialImportProduct,
  type MaterialImportProductInput,
  materialImportProductReady,
} from '../import-product.js';

const input: MaterialImportProductInput = {
  guid: 'mat-child',
  sourcePath: 'materials/child.material.json',
  material: {
    kind: 'material',
    parent: 'mat-parent' as unknown as AssetGuid,
    values: {
      baseColor: {
        texture: 'texture/albedo' as unknown as AssetGuid,
        sampler: 'sampler/linear' as unknown as AssetGuid,
      },
    },
  },
  refs: {
    parent: ['mat-parent'],
    textures: ['texture/albedo'],
    samplers: ['sampler/linear'],
    modules: ['module/pbr'],
  },
  sourceEvidence: { inputFingerprint: 'sha256:source', importerVersion: 'material/1' },
};

describe('material import product', () => {
  it('keeps authored material and source evidence without runtime handles', () => {
    const result = createMaterialImportProduct(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.asset.payload).toEqual(input.material);
    expect(result.value.asset.refs.map((ref) => ref.guid)).toEqual([
      'mat-parent',
      'texture/albedo',
      'sampler/linear',
      'module/pbr',
    ]);
    expect(result.value.sourceEvidence).toEqual(input.sourceEvidence);
    expect(result.value).not.toHaveProperty('compiler');
    expect(result.value).not.toHaveProperty('handle');
  });

  it('does not claim Ready when a declared dependency is absent', () => {
    const result = createMaterialImportProduct({ ...input, refs: { ...input.refs, parent: [] } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(materialImportProductReady(result.value, new Set(['texture/albedo']))).toBe(false);
  });
});
