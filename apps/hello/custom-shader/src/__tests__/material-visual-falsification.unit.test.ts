import { describe, expect, it } from 'vitest';

import {
  FALSIFICATION_VARIANTS,
  assertFalsificationFailed,
  falsificationEnvironment,
} from '../../scripts/smoke-falsify.mjs';

describe('custom-shader visual falsification contract', () => {
  it('defines parent-loss and UV0-transform-loss variants outside CI', () => {
    expect(Object.keys(FALSIFICATION_VARIANTS)).toEqual([
      'missing-derived-parent',
      'uv0-transform-loss',
    ]);
    expect(falsificationEnvironment('missing-derived-parent')).toEqual({
      FORGEAX_FALSIFY_MISSING_PARENT: '1',
    });
    expect(falsificationEnvironment('uv0-transform-loss')).toEqual({
      FORGEAX_FALSIFY_UV0_TRANSFORM: '1',
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
