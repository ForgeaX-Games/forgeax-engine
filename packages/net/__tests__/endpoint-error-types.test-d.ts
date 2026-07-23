// Type-level exhaustiveness test for EndpointError (requirements AC-13).
// Verifies that EndpointErrorCode is a closed 5-member union and that
// EndpointErrorDetailFor<C> narrows the detail per code.

import type {
  EndpointError,
  EndpointErrorCode,
  EndpointErrorDetailFor,
  EndpointDetailPeerNotFound,
  EndpointDetailConnectionClosed,
  EndpointDetailSendFailed,
  EndpointDetailAlreadyClosed,
  EndpointDetailConnectionFailed,
} from '../src/endpoint/errors';
import { expectTypeOf, test } from 'vitest';

test('EndpointErrorCode is a 5-member closed union', () => {
  type ExpectedCodes = 'peer-not-found' | 'connection-closed' | 'send-failed' | 'already-closed' | 'connection-failed';
  expectTypeOf<EndpointErrorCode>().toEqualTypeOf<ExpectedCodes>();
  expectTypeOf<ExpectedCodes>().toEqualTypeOf<EndpointErrorCode>();
});

test('EndpointErrorDetailFor narrows detail per code', () => {
  expectTypeOf<EndpointErrorDetailFor<'peer-not-found'>>().toEqualTypeOf<EndpointDetailPeerNotFound>();
  expectTypeOf<EndpointErrorDetailFor<'connection-closed'>>().toEqualTypeOf<EndpointDetailConnectionClosed>();
  expectTypeOf<EndpointErrorDetailFor<'send-failed'>>().toEqualTypeOf<EndpointDetailSendFailed>();
  expectTypeOf<EndpointErrorDetailFor<'already-closed'>>().toEqualTypeOf<EndpointDetailAlreadyClosed>();
  expectTypeOf<EndpointErrorDetailFor<'connection-failed'>>().toEqualTypeOf<EndpointDetailConnectionFailed>();
});
