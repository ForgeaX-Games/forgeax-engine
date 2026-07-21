export type NetErrorCode =
  | 'handshake-profile-mismatch'
  | 'decode-invalid-payload'
  | 'decode-limit-exceeded'
  | 'ordering-invalid-tick'
  | 'identity-invalid'
  | 'schema-invalid'
  | 'remap-unresolved-reference'
  | 'apply-invariant-failed';

export type NetErrorDetail =
  | { readonly localFingerprint: string; readonly remoteFingerprint: string }
  | { readonly reason: string }
  | { readonly limit: string; readonly actual: number; readonly maximum: number }
  | { readonly receivedTick: number; readonly lastTick: number }
  | { readonly id: number; readonly reason: string }
  | { readonly component: string; readonly reason: string }
  | { readonly id: number; readonly referencedId: number }
  | { readonly reason: string };

class NetErrorClass extends Error {
  readonly code: NetErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: NetErrorDetail;
  constructor(args: {
    code: NetErrorCode;
    expected: string;
    hint: string;
    detail: NetErrorDetail;
  }) {
    super(`[NetError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'NetError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

type Variant<C extends NetErrorCode, D extends NetErrorDetail> = NetErrorClass & {
  readonly code: C;
  readonly detail: D;
};

export type NetError =
  | Variant<
      'handshake-profile-mismatch',
      { readonly localFingerprint: string; readonly remoteFingerprint: string }
    >
  | Variant<'decode-invalid-payload', { readonly reason: string }>
  | Variant<
      'decode-limit-exceeded',
      { readonly limit: string; readonly actual: number; readonly maximum: number }
    >
  | Variant<'ordering-invalid-tick', { readonly receivedTick: number; readonly lastTick: number }>
  | Variant<'identity-invalid', { readonly id: number; readonly reason: string }>
  | Variant<'schema-invalid', { readonly component: string; readonly reason: string }>
  | Variant<'remap-unresolved-reference', { readonly id: number; readonly referencedId: number }>
  | Variant<'apply-invariant-failed', { readonly reason: string }>;

interface NetErrorConstructor {
  new <C extends NetErrorCode>(args: {
    code: C;
    expected: string;
    hint: string;
    detail: Extract<NetError, { code: C }>['detail'];
  }): Extract<NetError, { code: C }>;
  readonly prototype: NetErrorClass;
}
export const NetError: NetErrorConstructor = NetErrorClass as unknown as NetErrorConstructor;
