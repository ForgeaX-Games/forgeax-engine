import { expectTypeOf } from 'vitest';
import type { NetError, NetErrorCode } from '../src/replication/errors';

declare const error: NetError;

switch (error.code) {
  case 'handshake-profile-mismatch':
    expectTypeOf(error.detail.localFingerprint).toEqualTypeOf<string>();
    break;
  case 'decode-invalid-payload':
  case 'decode-limit-exceeded':
  case 'ordering-invalid-tick':
  case 'identity-invalid':
  case 'schema-invalid':
  case 'remap-unresolved-reference':
  case 'apply-invariant-failed':
    break;
}

expectTypeOf<NetErrorCode>().toEqualTypeOf<
  | 'handshake-profile-mismatch'
  | 'decode-invalid-payload'
  | 'decode-limit-exceeded'
  | 'ordering-invalid-tick'
  | 'identity-invalid'
  | 'schema-invalid'
  | 'remap-unresolved-reference'
  | 'apply-invariant-failed'
>();
