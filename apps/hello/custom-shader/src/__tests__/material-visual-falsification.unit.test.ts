import { describe, expect, it } from 'vitest';

import {
  FALSIFICATION_VARIANTS,
  assertFalsificationFailed,
  falsificationEnvironment,
} from '../../scripts/smoke-falsify.mjs';

describe('custom-shader visual falsification contract', () => {
  it('defines material inheritance and per-slot resource variants outside CI', () => {
    expect(Object.keys(FALSIFICATION_VARIANTS)).toEqual([
      'missing-derived-parent',
      'uv0-transform-loss',
      'missing-normal-resource',
      'swapped-normal-binding',
      'normal-slot-swap',
    ]);
    expect(falsificationEnvironment('missing-derived-parent')).toEqual({
      FORGEAX_FALSIFY_MISSING_PARENT: '1',
    });
    expect(falsificationEnvironment('uv0-transform-loss')).toEqual({
      FORGEAX_FALSIFY_UV0_TRANSFORM: '1',
    });
    expect(falsificationEnvironment('missing-normal-resource')).toEqual({
      FORGEAX_FALSIFY_MISSING_NORMAL_RESOURCE: '1',
    });
    expect(falsificationEnvironment('swapped-normal-binding')).toEqual({
      FORGEAX_FALSIFY_SWAPPED_NORMAL_BINDING: '1',
    });
    expect(falsificationEnvironment('normal-slot-swap')).toEqual({
      FORGEAX_FALSIFY_NORMAL_SLOT_SWAP: '1',
    });
  });

  it('rejects a variant that passes the original smoke', () => {
    expect(() => assertFalsificationFailed({ variant: 'missing-derived-parent', exitCode: 0, output: '' })).toThrow(
      'passed the original smoke',
    );
    expect(() =>
      assertFalsificationFailed({
        variant: 'missing-derived-parent',
        exitCode: 1,
        output: 'FALSIFY_EXPECTED_FAILURE:missing-derived-parent',
      }),
    ).not.toThrow();
  });
});
