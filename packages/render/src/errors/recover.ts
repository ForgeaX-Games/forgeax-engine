// @forgeax/engine-runtime -- recover cluster error class.
//
// feat-20260704-runtime-tier1-decomposition M2 / w8 (D-3): the recover()
// failure cluster. RecoverErrorCode (closed 4-member union) + RecoverError
// class migrated as-is (OOS-4). RecoverError is surfaced through
// `recover(): Promise<Result<void, RecoverError>>`, NOT the onError fanout
// channel (see renderer.ts RendererError composition).

// ── RecoverError (feat-20260621-renderer-health-recover-skeleton M1) ─────────

/**
 * Closed union of recover() error codes.
 *
 * Exactly 4 members (feat-20260622-s5 M3 / D-2 add-only minor; the S3
 * skeleton shipped the first two):
 *   - `'recover-not-needed'` — health state is `'alive'`, no recovery required
 *     (also returned after a successful recover: the renderer is alive again,
 *     so a second recover() is a no-op signal — A-AC-08 idempotency)
 *   - `'recover-not-implemented'` — **reserved**. The S3 skeleton returned this
 *     for any degraded state; M3 implements recover() so this code is no longer
 *     produced. Kept in the union (not deleted) so consumers' exhaustive
 *     switches stay valid — AGENTS.md Change stance: `*ErrorCode` unions evolve
 *     add-only minor, never remove a member
 *   - `'recover-adapter-unavailable'` — rebuild requested a new adapter but
 *     `requestAdapter` returned no adapter (driver / GPU may have been reset)
 *   - `'recover-device-unavailable'` — an adapter was obtained but
 *     `requestDevice` failed or threw (device creation is driver-dependent)
 *
 * On both failure codes the health state stays `'device-lost'` (recover() never
 * fakes the renderer back to `'alive'` on failure — A-AC-07). recover() is a
 * single idempotent attempt: no retry loop, no backoff, no timer (A-OOS-1).
 *
 * AI users exhaustively switch without default; TS guards completeness.
 */
// biome-ignore format: single-line union keeps the A-AC-09 grep gate (exactly 4 `recover-*` literals on the definition line) stable
export type RecoverErrorCode = 'recover-not-needed' | 'recover-not-implemented' | 'recover-adapter-unavailable' | 'recover-device-unavailable';

/**
 * Structured error for `Renderer.recover()` failures.
 *
 * Carries the standard 3-field surface per AGENTS.md error model:
 *   - `.code: RecoverErrorCode` — closed union discriminant
 *   - `.expected: string` — expected-state description
 *   - `.hint: string` — actionable recovery guidance
 *
 * No `.detail` field: each code has fixed semantics with no variable data.
 */
export class RecoverError extends Error {
  readonly code: RecoverErrorCode;
  readonly expected: string;
  readonly hint: string;

  constructor(code: RecoverErrorCode) {
    let message: string;
    let expected: string;
    let hint: string;
    switch (code) {
      case 'recover-not-needed':
        message = 'recover-not-needed: renderer is not in a degraded state';
        expected =
          'renderer is healthy; call health() first to confirm degraded state before calling recover()';
        hint = 'call health() first to confirm degraded state before calling recover()';
        break;
      case 'recover-not-implemented':
        message = 'recover-not-implemented: self-heal recovery is not yet implemented';
        expected = 'recovery is not yet implemented; self-heal lands in S5';
        hint = 'self-heal recovery lands in S5; health().reason still reflects the degraded state';
        break;
      case 'recover-adapter-unavailable':
        message = 'recover-adapter-unavailable: requestAdapter returned no adapter during rebuild';
        expected = 'requestAdapter returned null; driver/GPU may have been reset';
        hint = 'retry recover() after a host-chosen delay; adapter availability is transient';
        break;
      case 'recover-device-unavailable':
        message = 'recover-device-unavailable: requestDevice failed or threw during rebuild';
        expected = 'requestDevice failed or threw';
        hint = 'retry recover() after a host-chosen delay; device creation is driver-dependent';
        break;
    }
    super(message);
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.name = 'RecoverError';
  }
}
