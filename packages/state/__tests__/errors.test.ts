import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  InvalidVariantDetail,
  StateAlreadyDefinedDetail,
  StateDefaultRequiredDetail,
  StateError,
  StateErrorCode,
  StateErrorDetail,
  StateNotRegisteredDetail,
} from '../src/errors';
import {
  invalidVariant,
  stateAlreadyDefined,
  stateDefaultRequired,
  stateNotRegistered,
  throwStateError,
} from '../src/errors';

describe('StateError code/detail correlation', () => {
  it('accepts every existing code with its matching detail', () => {
    if (false) {
      throwStateError('state-already-defined', '', '', {
        code: 'state-already-defined',
        name: 'GameState',
        firstDefinedAt: undefined,
      });
      throwStateError('state-not-registered', '', '', {
        code: 'state-not-registered',
        name: 'GameState',
      });
      throwStateError('invalid-variant', '', '', {
        code: 'invalid-variant',
        name: 'GameState',
        got: 'missing',
        valid: ['idle'],
      });
      throwStateError('state-default-required', '', '', {
        code: 'state-default-required',
        name: 'GameState',
      });
    }

    const details: StateErrorDetail[] = [
      {
        code: 'state-already-defined',
        name: 'GameState',
        firstDefinedAt: undefined,
      },
      { code: 'state-not-registered', name: 'GameState' },
      { code: 'invalid-variant', name: 'GameState', got: 'missing', valid: ['idle'] },
      { code: 'state-default-required', name: 'GameState' },
    ];
    expect(details).toHaveLength(4);
  });

  it('rejects mismatched code/detail pairs', () => {
    if (false) {
      throwStateError(
        'state-not-registered',
        '',
        '',
        // @ts-expect-error -- detail.code must match the top-level code.
        { code: 'state-default-required', name: 'GameState' },
      );
      throwStateError(
        'invalid-variant',
        '',
        '',
        // @ts-expect-error -- invalid-variant requires its own detail payload.
        { code: 'state-not-registered', name: 'GameState' },
      );
    }

    expect(true).toBe(true);
  });

  it('narrows detail from an exhaustive code switch', () => {
    function describeError(error: StateError): string {
      switch (error.code) {
        case 'state-already-defined':
          expectTypeOf(error.detail).toEqualTypeOf<StateAlreadyDefinedDetail>();
          return `${error.detail.name}:${error.detail.firstDefinedAt ?? ''}`;
        case 'state-not-registered':
          expectTypeOf(error.detail).toEqualTypeOf<StateNotRegisteredDetail>();
          return error.detail.name;
        case 'invalid-variant':
          expectTypeOf(error.detail).toEqualTypeOf<InvalidVariantDetail>();
          return `${error.detail.name}:${error.detail.got}/${error.detail.valid.join(',')}`;
        case 'state-default-required':
          expectTypeOf(error.detail).toEqualTypeOf<StateDefaultRequiredDetail>();
          return error.detail.name;
      }
    }

    expect(describeError(stateAlreadyDefined('GameState'))).toContain('GameState');
    expectTypeOf<StateErrorCode>().toEqualTypeOf<
      | 'state-already-defined'
      | 'state-not-registered'
      | 'invalid-variant'
      | 'state-default-required'
    >();
    expectTypeOf<StateErrorDetail>().toEqualTypeOf<
      | StateAlreadyDefinedDetail
      | StateNotRegisteredDetail
      | InvalidVariantDetail
      | StateDefaultRequiredDetail
    >();
  });

  it('preserves the runtime envelope and duplicated detail code', () => {
    const errors: StateError[] = [
      stateAlreadyDefined('GameState'),
      stateNotRegistered('GameState'),
      invalidVariant('GameState', 'missing', ['idle']),
      stateDefaultRequired('GameState'),
    ];

    for (const error of errors) {
      expect(error.detail.code).toBe(error.code);
      expect(error.expected).toBeTypeOf('string');
      expect(error.hint).toBeTypeOf('string');
      expect(Object.getOwnPropertyDescriptor(error, 'message')?.get).toBeTypeOf('function');
      expect(Reflect.get(error, 'message')).toBe(`[${error.code}] ${error.hint}`);
    }

    expect(errors[0]?.detail.code).toBe('state-already-defined');
    expect(errors[0]?.detail).toHaveProperty('firstDefinedAt', undefined);
  });
});
