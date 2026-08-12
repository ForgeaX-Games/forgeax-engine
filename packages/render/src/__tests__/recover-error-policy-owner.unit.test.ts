import { describe, expect, expectTypeOf, it } from 'vitest';
import { RecoverError, type RecoverErrorCode } from '../errors/recover';
import {
  RecoverError as PublicRecoverError,
  type RecoverErrorCode as PublicRecoverErrorCode,
} from '../index';
import {
  RecoverError as InternalRecoverError,
  type RecoverErrorCode as InternalRecoverErrorCode,
} from '../internal';

const expectedCodes = [
  'recover-not-needed',
  'recover-not-implemented',
  'recover-adapter-unavailable',
  'recover-device-unavailable',
] as const satisfies readonly RecoverErrorCode[];

const evidence = [
  {
    code: 'recover-not-needed',
    expected:
      'renderer is healthy; call health() first to confirm degraded state before calling recover()',
    hint: 'call health() first to confirm degraded state before calling recover()',
    message: 'recover-not-needed: renderer is not in a degraded state',
  },
  {
    code: 'recover-not-implemented',
    expected: 'recovery is not yet implemented; self-heal lands in S5',
    hint: 'self-heal recovery lands in S5; health().reason still reflects the degraded state',
    message: 'recover-not-implemented: self-heal recovery is not yet implemented',
  },
  {
    code: 'recover-adapter-unavailable',
    expected: 'requestAdapter returned null; driver/GPU may have been reset',
    hint: 'retry recover() after a host-chosen delay; adapter availability is transient',
    message: 'recover-adapter-unavailable: requestAdapter returned no adapter during rebuild',
  },
  {
    code: 'recover-device-unavailable',
    expected: 'requestDevice failed or threw',
    hint: 'retry recover() after a host-chosen delay; device creation is driver-dependent',
    message: 'recover-device-unavailable: requestDevice failed or threw during rebuild',
  },
] as const;

describe('RecoverError policy ownership', () => {
  it('preserves the exact four-code vocabulary, order, and public projections', () => {
    expect(expectedCodes).toHaveLength(4);
    expect(new Set(expectedCodes).size).toBe(4);
    expectTypeOf<RecoverErrorCode>().toEqualTypeOf<(typeof expectedCodes)[number]>();
    expectTypeOf<InternalRecoverErrorCode>().toEqualTypeOf<RecoverErrorCode>();
    expectTypeOf<PublicRecoverErrorCode>().toEqualTypeOf<RecoverErrorCode>();
    expect(InternalRecoverError).toBe(RecoverError);
    expect(PublicRecoverError).toBe(RecoverError);
  });

  it('preserves all twelve diagnostics byte-for-byte', () => {
    for (const { code, expected, hint, message } of evidence) {
      const error = new RecoverError(code);
      const projected = new PublicRecoverError(code);

      expect(error.code).toBe(code);
      expect(error.expected).toBe(expected);
      expect(error.hint).toBe(hint);
      expect(error.message).toBe(message);
      expect(projected.code).toBe(code);
      expect(projected.expected).toBe(expected);
      expect(projected.hint).toBe(hint);
      expect(projected.message).toBe(message);
    }
  });

  it('preserves Error identity, name, stack, own-key order, and descriptors', () => {
    const error = new RecoverError('recover-not-needed');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RecoverError);
    expect(error).toBeInstanceOf(InternalRecoverError);
    expect(error).toBeInstanceOf(PublicRecoverError);
    expect(error.name).toBe('RecoverError');
    expect(typeof error.stack).toBe('string');
    expect(error.stack).toContain(`RecoverError: ${error.message}`);
    expect(Object.keys(error)).toEqual(['code', 'expected', 'hint', 'name']);
    expect(Object.getOwnPropertyNames(error)).toEqual([
      'stack',
      'message',
      'code',
      'expected',
      'hint',
      'name',
    ]);

    const descriptors = Object.getOwnPropertyDescriptors(error);
    for (const field of ['code', 'expected', 'hint', 'name'] as const) {
      expect(descriptors[field]).toMatchObject({
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    expect(descriptors.message).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true,
    });
    expect(descriptors.stack).toMatchObject({
      configurable: true,
      enumerable: false,
    });
    expect(typeof descriptors.stack?.get).toBe('function');
    expect(typeof descriptors.stack?.set).toBe('function');
  });
});
