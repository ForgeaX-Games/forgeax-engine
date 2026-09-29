import type { Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { materialTextureHandlesForResidency } from '../render-system';

type TextureHandle = Handle<'TextureAsset', 'shared'>;

describe('material texture residency handles', () => {
  it('drops the zero missing-reference sentinel before GPU resolution', () => {
    const missing = 0 as TextureHandle;
    const first = 7 as TextureHandle;
    const duplicate = 7 as TextureHandle;
    const second = 11 as TextureHandle;

    expect(
      materialTextureHandlesForResidency([undefined, missing, first, duplicate, second]),
    ).toEqual([first, second]);
  });
});
