import type { AssetGuid } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { collectMaterialCookRefs } from '../evidence/material-cook.js';

describe('material cook dependency closure', () => {
  it('collects parent, texture, sampler, and module references', () => {
    expect(
      collectMaterialCookRefs({
        parent: 'mat-parent' as unknown as AssetGuid,
        passes: [{ name: 'forward', program: { module: 'module/pbr' } }],
        values: {
          baseColor: {
            texture: 'texture/albedo' as unknown as AssetGuid,
            sampler: 'sampler/linear' as unknown as AssetGuid,
          },
        },
      }),
    ).toEqual({
      parent: ['mat-parent'],
      textures: ['texture/albedo'],
      samplers: ['sampler/linear'],
      modules: ['module/pbr'],
    });
  });
});
