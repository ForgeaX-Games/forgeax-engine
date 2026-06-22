// @forgeax/engine-console/src/errors - InspectorError runtime class + re-export of
// the closed `InspectorErrorCode` union; first-version 6 members locked by
// feat-20260511-inspector-p0-spike plan-strategy 2 D-P3 RD-1.
//
// SSOT split (Round 2 F-1 fix-up): the **type alias** `InspectorErrorCode`
// + **structural interface** `InspectorError` live in `@forgeax/engine-types`
// (parallel to the existing `ShaderErrorCode` placement). This file owns
// the **runtime class** (`extends Error` + `toJSON()`) only; the class
// `implements` the type-side interface so the two sides cannot drift
// (architecture-principles #1 SSOT). `@forgeax/engine-runtime` consumes the type
// alias without statically importing this runtime class — Renderer
// surface returns `Result<ConsoleHandle, InspectorError>` typed against
// the @forgeax/engine-types interface, and engine-side fallback paths construct
// minimal Error-shaped objects that satisfy the same interface (AC-09 +
// AC-22 bundle-isolation grep gate stays clean).
//
// Shape (mirrors @forgeax/engine-rhi/src/errors.ts RhiError 4-field surface for
// charter proposition 5 consistent abstraction):
// - `InspectorErrorCode` = closed union 6 members (re-exported from types).
//   tsc strict-mode guards exhaustive switch completeness (charter
//   proposition 4); AI users consume via `switch (err.code) { case '...': ... }`
//   with NO default branch.
// - `InspectorError` class extends Error with three readonly fields .code /
//   .expected / .hint (AGENTS.md "Errors are structured"). The constructor
//   auto-composes a human-readable .message (`[InspectorError <code>]
//   expected: <expected>; hint: <hint>`). The class implements the
//   `InspectorError` interface from `@forgeax/engine-types` so callers may
//   alternately type against the structural shape.
// - `toJSON()` opts into JSON.stringify serialisation so the JSON-RPC 2.0
//   `error.data` payload carries .code / .expected / .hint / .message
//   verbatim through the WebSocket transport (research 3.2 evidence).
//   Plain Error -> `JSON.stringify(e)` returns `'{}'` because `name` +
//   `message` are non-enumerable; AI users have requested the structured
//   triple be reachable on the wire, so toJSON() promotes the field set.
//
// 18-member union independence: InspectorErrorCode is NOT merged into the
// (RhiError | ShaderError) 18-member union (charter proposition 5 +
// architecture-principles #1 SSOT). Engine-side errors stream is OOS-1
// (errors.subscribe v2 spinoff); P0 console callers only face these 6
// inspector-domain alternatives.
//
// Related: requirements AC AC-10 (errors.ts 6-member union + 4-field
// surface + JSON.stringify friendly) + AC-18 (charter proposition 3
// machine-readable union); plan-strategy 7.2 (kebab-case domain prefix +
// state/action suffix) + 7.3 (4-field three-section structure); 10.2 6
// hint templates locked (JSDoc per-member).

import type {
  InspectorErrorCode,
  InspectorError as InspectorErrorShape,
} from '@forgeax/engine-types';

// Re-export the type-side alias verbatim so existing
// `import { type InspectorErrorCode } from '@forgeax/engine-console'` call sites
// keep working (charter proposition 1 progressive disclosure — single
// entry point for AI users).
export type { InspectorErrorCode };

/**
 * Structured inspector error. Four-field surface mirroring `@forgeax/engine-rhi`
 * `RhiError` (charter proposition 5 consistent abstraction; AGENTS.md
 * "Errors are structured"). The class `implements InspectorErrorShape`
 * (the structural interface re-exported from `@forgeax/engine-types`) so the type
 * SSOT and the runtime class cannot drift.
 *
 * - `.code`      closed union member (L1 key signal; switch-able).
 * - `.expected`  expected-state description (L2 detail; ai-user-charter
 *                proposition 4 requires expected-state copy).
 * - `.hint`      actionable recovery guidance (L2 detail; charter
 *                proposition 3 machine-readable hint > prose).
 * - `.message`   auto-composed `[InspectorError <code>] expected: <expected>;
 *                hint: <hint>` so human stack traces still surface the
 *                triple. AI users prefer property access (charter
 *                proposition 4: no string parsing).
 *
 * Per-code `.expected` + `.hint` templates (requirements §10.2 SSOT):
 *
 * | code | `.expected` | `.hint` |
 * |:--|:--|:--|
 * | `'script-syntax-error'` | `'script body is valid JavaScript'` | `'check syntax position in errMessage; fix and resubmit; use forgeax inspect sugar for closed-form queries'` |
 * | `'script-runtime-error'` | `'script executes without throwing'` | `'inspect stack trace in errMessage; verify symbol availability via forgeax introspect; remember world / engine / assets are read-only Proxy'` |
 * | `'script-timeout'` | `'script completes within 5000ms (default; configurable via engine.startConsole({ port, scriptTimeoutMs }))'` | `'simplify query or split into smaller scripts; check for unbounded loops; raise timeout via engine.startConsole({ port, scriptTimeoutMs })'` |
 * | `'inspector-write-denied'` | `'world / engine / assets context is read-only in P0'` | `'write API is deferred to asset-system-v1 loop (todo-079); use inspect / script / eval for read-only introspection only'` |
 * | `'console-startup-failed'` | `'console server starts successfully on requested port'` | `'check if port is already in use (default 5732, monitor uses 5731); pass different port via engine.startConsole({ port }); or kill existing process holding the port'` |
 * | `'console-not-running'` | `'console server is reachable at ws://localhost:<port>'` | `'start the demo first: pnpm --filter inspector-demo dev; verify engine.startConsole({port}) was called in your wiring; pass --port to override default 5732'` |
 *
 * JSON-RPC 2.0 transport contract: `toJSON()` returns a 4-field plain
 * object so `JSON.stringify(err)` produces the verbatim payload carried
 * via `error.data` on the WebSocket envelope (research 3.2 evidence:
 * client-side reconstruction reads .code/.expected/.hint via property
 * access; the JSON-RPC server-error `.code` numeric segment -32001 ~
 * -32006 maps 1:1 to the 6 members at the dispatch layer, T-08).
 *
 * @example AI-user exhaustive switch on the 6 inspector-domain alternatives (no default fallback)
 * ```ts
 * import { InspectorError, type InspectorErrorCode } from '@forgeax/engine-console';
 *
 * function recover(code: InspectorErrorCode): string {
 *   switch (code) {
 *     case 'script-syntax-error':     return 'fix script body syntax and resubmit';
 *     case 'script-runtime-error':    return 'inspect stack trace; verify symbol availability';
 *     case 'script-timeout':          return 'simplify query or raise scriptTimeoutMs';
 *     case 'inspector-write-denied':  return 'use inspect / script / eval (write API is OOS-4)';
 *     case 'console-startup-failed':  return 'pick a different port or free port 5732';
 *     case 'console-not-running':     return 'start inspector-demo dev or wire engine.startConsole()';
 *   }
 * }
 * ```
 */
export class InspectorError extends Error implements InspectorErrorShape {
  readonly code: InspectorErrorCode;
  readonly expected: string;
  readonly hint: string;

  constructor(args: {
    code: InspectorErrorCode;
    expected: string;
    hint: string;
  }) {
    super(`[InspectorError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'InspectorError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
  }

  /**
   * Promote the four readonly fields to enumerable JSON output. Without
   * this opt-in `JSON.stringify(err)` yields `'{}'` because `Error.name`
   * and `Error.message` are non-enumerable by spec. Used by the JSON-RPC
   * 2.0 transport (T-08 server-side dispatch + T-12 CLI client) to embed
   * the structured triple inside `error.data` verbatim.
   *
   * Returns a plain object (not `this`) so a single round-trip through
   * `JSON.parse(JSON.stringify(err))` yields an object equivalent in
   * shape to the second-pass `JSON.stringify(reparsed)` output (test
   * fixture roundtrip-stability assertion).
   */
  toJSON(): {
    readonly code: InspectorErrorCode;
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
 * SSOT mapping `InspectorErrorCode` -> JSON-RPC `error.code` numeric segment
 * (feat-20260511-inspector-p0-spike D-P3 RD-1 lock-in). The 6 inspector P0
 * members occupy the closed segment `-32001..-32006`.
 *
 * `server.ts` consumes this map at the JSON-RPC envelope edge so the wire
 * always carries the lock-in numeric and a future drift in either direction
 * raises a TypeScript completeness error (the `Record<InspectorErrorCode,
 * number>` type guard requires every closed-union member to have a
 * numeric).
 */
export const INSPECTOR_ERROR_CODE_TO_JSONRPC: Readonly<Record<InspectorErrorCode, number>> = {
  'script-syntax-error': -32001,
  'script-runtime-error': -32002,
  'script-timeout': -32003,
  'inspector-write-denied': -32004,
  'console-startup-failed': -32005,
  'console-not-running': -32006,
};
