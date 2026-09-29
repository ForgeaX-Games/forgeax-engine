import { describe, expect, it } from 'vitest';
import { ssrAdmissionRecoveryAction } from '../errors/recover';
import { createSsrAdmissionError, type SsrAdmissionErrorCode } from '../ssr/errors';

const codes = [
  'ssr-not-requested',
  'ssr-reflection-fallback-unavailable',
  'ssr-format-unavailable',
  'ssr-temporal-unavailable',
  'ssr-receipt-identity-mismatch',
  'ssr-receipt-stale',
] as const satisfies readonly SsrAdmissionErrorCode[];

describe('SSR admission recovery contract', () => {
  it('keeps every failure closed and maps only to owner actions', () => {
    const errors = [
      createSsrAdmissionError({ code: 'ssr-not-requested', owner: 'consumer', action: 'retry' }),
      createSsrAdmissionError({
        code: 'ssr-reflection-fallback-unavailable',
        owner: 'producer',
        action: 'use-LKG',
      }),
      createSsrAdmissionError({
        code: 'ssr-format-unavailable',
        owner: 'format',
        action: 'retry',
        stage: 'readback',
      }),
      createSsrAdmissionError({
        code: 'ssr-temporal-unavailable',
        owner: 'temporal',
        action: 'rebuild',
      }),
      createSsrAdmissionError({
        code: 'ssr-receipt-identity-mismatch',
        owner: 'format',
        action: 'rebuild',
        identityField: 'buildSha256',
      }),
      createSsrAdmissionError({
        code: 'ssr-receipt-stale',
        owner: 'consumer',
        action: 'retry',
        generation: 7,
      }),
    ];
    expect(errors.map((error) => error.code)).toEqual(codes);
    expect(errors.map(ssrAdmissionRecoveryAction)).toEqual([
      'retry',
      'use-LKG',
      'retry',
      'rebuild',
      'rebuild',
      'retry',
    ]);
    expect(errors.every((error) => !('handle' in error))).toBe(true);
  });
});
