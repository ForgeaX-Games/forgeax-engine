// @forgeax/engine-remote/src/errors - RemoteError runtime class + re-export of
// the closed `RemoteErrorCode` union; 4 members (feat-20260629-inspector-two-layer-model D-5).
//
// SSOT split: the **type alias** `RemoteErrorCode`
// + **structural interface** `RemoteError` live in `@forgeax/engine-types`
// (parallel to the existing `ShaderErrorCode` placement). This file owns
// the **runtime class** (`extends Error` + `toJSON()`) only; the class
// `implements` the type-side interface so the two sides cannot drift
// (architecture-principles #1 SSOT).
//
// Shape (mirrors @forgeax/engine-rhi/src/errors.ts RhiError 4-field surface for
// charter proposition 5 consistent abstraction):
// - `RemoteErrorCode` = closed union 4 members (re-exported from types).
//   tsc strict-mode guards exhaustive switch completeness (charter
//   proposition 4); AI users consume via `switch (err.code) { case '...': ... }`
//   with NO default branch.
// - `RemoteError` class extends Error with three readonly fields .code /
//   .expected / .hint (AGENTS.md "Errors are structured"). The constructor
//   auto-composes a human-readable .message (`[RemoteError <code>]
//   expected: <expected>; hint: <hint>`). The class implements the
//   `RemoteError` interface from `@forgeax/engine-types` so callers may
//   alternately type against the structural shape.
// - `toJSON()` opts into JSON.stringify serialisation so the JSON-RPC 2.0
//   `error.data` payload carries .code / .expected / .hint / .message
//   verbatim through the WebSocket transport.

import type { RemoteErrorCode, RemoteError as RemoteErrorShape } from '@forgeax/engine-types';

// Re-export the type-side alias verbatim so existing
// `import { type RemoteErrorCode } from '@forgeax/engine-remote'` call sites
// keep working (charter proposition 1 progressive disclosure — single
// entry point for AI users).
export type { RemoteErrorCode };

/**
 * Structured remote error. Four-field surface mirroring `@forgeax/engine-rhi`
 * `RhiError` (charter proposition 5 consistent abstraction; AGENTS.md
 * "Errors are structured"). The class `implements RemoteErrorShape`
 * (the structural interface re-exported from `@forgeax/engine-types`) so the type
 * SSOT and the runtime class cannot drift.
 *
 * - `.code`      closed union member (L1 key signal; switch-able).
 * - `.expected`  expected-state description (L2 detail; ai-user-charter
 *                proposition 4 requires expected-state copy).
 * - `.hint`      actionable recovery guidance (L2 detail; charter
 *                proposition 3 machine-readable hint > prose).
 * - `.message`   auto-composed `[RemoteError <code>] expected: <expected>;
 *                hint: <hint>` so human stack traces still surface the
 *                triple. AI users prefer property access (charter
 *                proposition 4: no string parsing).
 *
 * Per-code `.expected` + `.hint` templates (requirements §10.2 SSOT):
 *
 * | code | `.expected` | `.hint` |
 * |:--|:--|:--|
 * | `'script-syntax-error'` | `'script body is valid JavaScript'` | `'check syntax position in errMessage; fix and resubmit'` |
 * | `'script-runtime-error'` | `'script executes without throwing'` | `'inspect error; verify symbol availability; eval has full access to world/renderer/assets'` |
 * | `'server-startup-failed'` | `'server starts successfully on requested port'` | `'check if port is already in use (default 5732); pass different port; or kill existing process holding the port'` |
 * | `'server-not-running'` | `'server is reachable at ws://localhost:<port>'` | `'start the demo first; verify app.remote is wired; pass --port to override default 5732'` |
 *
 * JSON-RPC 2.0 transport contract: `toJSON()` returns a 4-field plain
 * object so `JSON.stringify(err)` produces the verbatim payload carried
 * via `error.data` on the WebSocket envelope. The JSON-RPC server-error
 * `.code` numeric segment -32001 ~ -32004 maps 1:1 to the 4 members
 * at the dispatch layer.
 *
 * @example AI-user exhaustive switch on the 4 remote-domain alternatives (no default fallback)
 * ```ts
 * import { RemoteError, type RemoteErrorCode } from '@forgeax/engine-remote';
 *
 * function recover(code: RemoteErrorCode): string {
 *   switch (code) {
 *     case 'script-syntax-error':     return 'fix script body syntax and resubmit';
 *     case 'script-runtime-error':    return 'inspect stack trace; verify symbol availability';
 *     case 'server-startup-failed':   return 'pick a different port or free port 5732';
 *     case 'server-not-running':      return 'start demo dev or wire app.remote';
 *   }
 * }
 * ```
 */
export class RemoteError extends Error implements RemoteErrorShape {
  readonly code: RemoteErrorCode;
  readonly expected: string;
  readonly hint: string;

  constructor(args: {
    code: RemoteErrorCode;
    expected: string;
    hint: string;
  }) {
    super(`[RemoteError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'RemoteError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
  }

  toJSON(): {
    readonly code: RemoteErrorCode;
    readonly expected: string;
    readonly hint: string;
    readonly message: string;
  } {
    return {
      code: this.code,
      expected: this.expected,
      hint: this.hint,
      message: this.message,
    };
  }
}

/**
 * SSOT mapping `RemoteErrorCode` -> JSON-RPC `error.code` numeric segment
 * (feat-20260629-inspector-two-layer-model D-5). The 4 remote P0
 * members occupy the closed segment `-32001..-32004`.
 *
 * `server.ts` consumes this map at the JSON-RPC envelope edge so the wire
 * always carries the lock-in numeric and a future drift in either direction
 * raises a TypeScript completeness error (the `Record<RemoteErrorCode,
 * number>` type guard requires every closed-union member to have a
 * numeric).
 */
export const REMOTE_ERROR_CODE_TO_JSONRPC: Readonly<Record<RemoteErrorCode, number>> = {
  'script-syntax-error': -32001,
  'script-runtime-error': -32002,
  'server-startup-failed': -32003,
  'server-not-running': -32004,
};
