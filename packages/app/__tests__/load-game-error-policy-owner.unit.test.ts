import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LOAD_GAME_ERROR_HINTS,
  LOAD_GAME_EXPECTED,
  LoadGameError,
  type LoadGameError as LoadGameErrorType,
  type LoadGameErrorCode,
  type LoadGameDetailInvalidFormat,
  type LoadGameDetailModuleNotFound,
} from '../src/load-game-errors';

const CODES_IN_POLICY_ORDER = [
  'module-not-found',
  'invalid-format',
  'import-failed',
] as const satisfies readonly LoadGameErrorCode[];

const EXPECTED_IN_POLICY_ORDER = [
  'resolver should return a module with a `bootstrap` export for the given slug',
  'resolved module must have a `bootstrap` export that is a function',
  'resolver should complete without throwing; import path, network, and build errors are forwarded here',
] as const;

const HINTS_IN_POLICY_ORDER = [
  'verify the game slug matches an existing template directory; check the resolver import path for typos',
  'the template must export a `bootstrap` function matching the BootstrapEntry signature; check for named-export vs default-export confusion',
  'inspect detail.cause for the original error (network failure, build error, dynamic import timeout, etc.)',
] as const;

describe('LoadGameError policy owner', () => {
  it('projects the exact three-code policy surface with stable own-key order', () => {
    expect(CODES_IN_POLICY_ORDER).toHaveLength(3);
    expect(new Set(CODES_IN_POLICY_ORDER).size).toBe(3);

    for (const policy of [LOAD_GAME_EXPECTED, LOAD_GAME_ERROR_HINTS]) {
      expect(Object.keys(policy)).toEqual(CODES_IN_POLICY_ORDER);
      expect(Object.getOwnPropertyNames(policy)).toEqual(CODES_IN_POLICY_ORDER);
      for (const code of CODES_IN_POLICY_ORDER) {
        expect(Object.prototype.propertyIsEnumerable.call(policy, code)).toBe(true);
      }
    }

    expect(Object.values(LOAD_GAME_EXPECTED)).toEqual(EXPECTED_IN_POLICY_ORDER);
    expect(Object.values(LOAD_GAME_ERROR_HINTS)).toEqual(HINTS_IN_POLICY_ORDER);
  });

  it('keeps every expected and hint string byte-identical', () => {
    for (const [index, code] of CODES_IN_POLICY_ORDER.entries()) {
      expect(LOAD_GAME_EXPECTED[code]).toBe(EXPECTED_IN_POLICY_ORDER[index]);
      expect(LOAD_GAME_ERROR_HINTS[code]).toBe(HINTS_IN_POLICY_ORDER[index]);
    }
  });

  it('preserves public record types and correlated LoadGameError construction', () => {
    expectTypeOf(LOAD_GAME_EXPECTED).toEqualTypeOf<
      Readonly<Record<LoadGameErrorCode, string>>
    >();
    expectTypeOf(LOAD_GAME_ERROR_HINTS).toEqualTypeOf<
      Readonly<Record<LoadGameErrorCode, string>>
    >();

    const moduleNotFound = new LoadGameError({
      code: 'module-not-found',
      expected: LOAD_GAME_EXPECTED['module-not-found'],
      hint: LOAD_GAME_ERROR_HINTS['module-not-found'],
      detail: { slug: 'starter' },
    });
    expectTypeOf(moduleNotFound).toEqualTypeOf<
      Extract<LoadGameErrorType, { readonly code: 'module-not-found' }>
    >();
    expectTypeOf(moduleNotFound.detail).toEqualTypeOf<LoadGameDetailModuleNotFound>();
    expect(moduleNotFound.detail.slug).toBe('starter');

    const invalidFormat = new LoadGameError({
      code: 'invalid-format',
      expected: LOAD_GAME_EXPECTED['invalid-format'],
      hint: LOAD_GAME_ERROR_HINTS['invalid-format'],
      detail: { exportKeys: ['default'] },
    });
    expectTypeOf(invalidFormat).toEqualTypeOf<
      Extract<LoadGameErrorType, { readonly code: 'invalid-format' }>
    >();
    expectTypeOf(invalidFormat.detail).toEqualTypeOf<LoadGameDetailInvalidFormat>();
    expect(invalidFormat.detail.exportKeys).toEqual(['default']);
  });
});
