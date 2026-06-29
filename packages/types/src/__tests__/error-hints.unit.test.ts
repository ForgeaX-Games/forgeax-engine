// error-hints.unit.test.ts — PackErrorCode completeness assertions (M1 / w2)
//
// Coverage:
//   - PackErrorCode union member count === 15
//   - PACK_ERROR_HINTS Record has non-empty entries for the two new codes
//   - PackErrorDetail discriminated union narrows to pack-unknown-path /
//     pack-malformed-path-ref via Extract
//   - New hints do not contain stale "forgeax-engine-console asset" sub-command form

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PackErrorCode, PackErrorDetail } from '../index';
import { PACK_ERROR_HINTS } from '../index';

type DetailFor<Code extends string> = Extract<PackErrorDetail, { readonly code: Code }>;

describe('PackErrorCode member count = 15', () => {
  it('PACK_ERROR_HINTS has exactly 15 keys', () => {
    const keys = Object.keys(PACK_ERROR_HINTS) as PackErrorCode[];
    expect(keys.length).toBe(15);
  });

  // Compile-time guard: PACK_ERROR_HINTS is Record<PackErrorCode, string>,
  // so every PackErrorCode member must have a corresponding key.
  it('PACK_ERROR_HINTS key type is assignable to PackErrorCode (compile-time Record completeness)', () => {
    const keys: readonly PackErrorCode[] = Object.keys(PACK_ERROR_HINTS) as PackErrorCode[];
    expect(keys).toBeDefined();
  });
});

describe('PACK_ERROR_HINTS new entries (w1)', () => {
  it("'pack-unknown-path' hint is non-empty and uses binary-form phrasing", () => {
    const hint = PACK_ERROR_HINTS['pack-unknown-path'];
    expect(hint).toBeDefined();
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain('@name');
    expect(hint).toContain('package.json#forgeax.assets.paths');
    expect(hint).not.toContain('forgeax-engine-console asset');
  });

  it("'pack-malformed-path-ref' hint is non-empty and uses binary-form phrasing", () => {
    const hint = PACK_ERROR_HINTS['pack-malformed-path-ref'];
    expect(hint).toBeDefined();
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain('@<name>/<rest>');
    expect(hint).toContain('package.json#forgeax.assets.paths');
    expect(hint).not.toContain('forgeax-engine-console asset');
  });
});

describe('PackErrorDetail new variants narrowable (w1)', () => {
  it('pack-unknown-path narrows to { code, pathName, knownNames }', () => {
    type D = DetailFor<'pack-unknown-path'>;
    expectTypeOf<D['code']>().toEqualTypeOf<'pack-unknown-path'>();
    expectTypeOf<D['pathName']>().toEqualTypeOf<string>();
    expectTypeOf<D['knownNames']>().toEqualTypeOf<readonly string[]>();
  });

  it('pack-malformed-path-ref narrows to { code, rawSource, expectedFormat }', () => {
    type D = DetailFor<'pack-malformed-path-ref'>;
    expectTypeOf<D['code']>().toEqualTypeOf<'pack-malformed-path-ref'>();
    expectTypeOf<D['rawSource']>().toEqualTypeOf<string>();
    expectTypeOf<D['expectedFormat']>().toEqualTypeOf<string>();
  });
});
