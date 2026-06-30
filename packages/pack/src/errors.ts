// errors.ts — PackError class (feat-20260513-guid-asset-package-system w15)
//
// Four-field surface: .code / .expected / .hint / .detail
// Structurally parallel to AssetError / RhiError / RemoteError
// (charter proposition 5 consistent abstraction).
//
// .detail is narrowed per .code via PackErrorDetail discriminated union
// (requirements §6.2 AC-07; plan-strategy §D-5).

import type { PackErrorCode, PackErrorDetail } from '@forgeax/engine-types';

/**
 * Structured error for the engine-pack disk scanner fail-fast chain.
 *
 * AI users consume via exhaustive switch on .code — no default case needed:
 * ```ts
 * switch (err.code) {
 *   case 'pack-guid-collision':
 *     console.error(err.detail.paths);
 *     break;
 *   case 'pack-cyclic-reference':
 *     console.error(err.detail.cycle);
 *     break;
 *   // ...all 8 cases
 * }
 * ```
 */
export class PackError extends Error {
  readonly code: PackErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PackErrorDetail;

  constructor(args: {
    code: PackErrorCode;
    expected: string;
    hint: string;
    detail: PackErrorDetail;
  }) {
    super(`[PackError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'PackError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}
