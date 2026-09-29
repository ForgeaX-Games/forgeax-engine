import { createMaterialError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { toMaterialRollupError } from '../wrap.js';

describe('material composition error projection', () => {
  it('keeps the closed material error code on the Rollup meta surface', () => {
    const error = toMaterialRollupError(
      createMaterialError('material-surface-slot-missing', {
        code: 'material-surface-slot-missing',
        material: 'forgeax::default-standard-pbr',
        pass: 'forward',
        source: '/engine/default-standard-pbr.wgsl',
        slot: 'surface',
        action: 'add-surface-slot',
      }),
    );

    expect(error.code).toBe('material-surface-slot-missing');
    expect(error.meta).toMatchObject({ code: 'material-surface-slot-missing' });
    expect(error.detail).toMatchObject({ slot: 'surface' });
  });
});
