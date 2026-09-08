import { expectTypeOf, test } from 'vitest';
import { NetError } from '../src/index';
import type { NetError as NetErrorType, NetErrorCode, NetErrorDetailFor } from '../src/index';

test('recovery errors preserve code-specific detail inference', () => {
  const unsupported = new NetError({
    code: 'protocol-unsupported-version',
    expected: 'protocol version 2',
    hint: 'upgrade the peer before sending replicated bytes',
    detail: { receivedVersion: 1, supportedVersion: 2 },
  });
  const transition = new NetError({
    code: 'session-illegal-transition',
    expected: 'a legal session transition',
    hint: 'wait for the current state before requesting recovery',
    detail: { from: 'active', to: 'connecting' },
  });
  expectTypeOf(unsupported.detail).toEqualTypeOf<NetErrorDetailFor<'protocol-unsupported-version'>>();
  expectTypeOf(transition.detail).toEqualTypeOf<NetErrorDetailFor<'session-illegal-transition'>>();
});

test('all public error codes and details remain exhaustively narrowable', () => {
  declare const error: NetErrorType;
  const describe = (current: NetErrorType): string => {
    switch (current.code) {
      case 'handshake-profile-mismatch':
        return current.detail.localFingerprint;
      case 'decode-invalid-payload':
        return current.detail.reason;
      case 'decode-limit-exceeded':
        return `${current.detail.limit}:${current.detail.actual}/${current.detail.maximum}`;
      case 'ordering-invalid-tick':
        return `${current.detail.receivedTick}:${current.detail.lastTick}`;
      case 'identity-invalid':
        return `${current.detail.id}:${current.detail.reason}`;
      case 'schema-invalid':
        return `${current.detail.component}:${current.detail.reason}`;
      case 'remap-unresolved-reference':
        return `${current.detail.id}:${current.detail.referencedId}`;
      case 'apply-invariant-failed':
        return current.detail.reason;
      case 'protocol-unsupported-version':
        return `${current.detail.receivedVersion}:${current.detail.supportedVersion}`;
      case 'session-illegal-transition':
        return `${current.detail.from}:${current.detail.to}`;
      case 'recovery-policy-invalid':
        return current.detail.field;
      case 'recovery-rejected':
        return current.detail.reason;
      case 'recovery-exhausted':
        return `${current.detail.attempts}/${current.detail.maxAttempts}`;
    }
  };

  expectTypeOf(error.code).toEqualTypeOf<NetErrorCode>();
  expectTypeOf(describe).returns.toEqualTypeOf<string>();
});

