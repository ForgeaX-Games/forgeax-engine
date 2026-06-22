// @forgeax/engine-console/src/execute - vm.runInContext + 5000ms timeout + 3
// error-path dispatch (plan-strategy D-P3 RD-2; research §4.2).
//
// Pipeline:
//   1. wrap world / engine / assets in read-only alpha-mode proxies
//      (mutation methods throw inspector-write-denied via the function
//      -level Proxy apply trap).
//   2. vm.createContext({ world, engine, assets }) builds a fresh ctx.
//   3. vm.runInContext(script, ctx, { timeout, displayErrors: true })
//      runs synchronously; throws on syntax / runtime / timeout.
//   4. try/catch maps the thrown value into a closed InspectorError:
//        SyntaxError                                 -> 'script-syntax-error'
//        Error('Script execution timed out')         -> 'script-timeout'
//        InspectorError (re-thrown from alpha trap)  -> verbatim
//        anything else                               -> 'script-runtime-error'
//
// We deliberately do NOT enable `microtaskMode: 'afterEvaluate'` here (plan
// D-P3 RD-2): P0 limits scripts to synchronous expressions; async escape
// from the timeout is at worst a stuck REPL slot, never a host-process
// deadlock. The trade is documented in plan §10.2 AI user notes (do not
// wrap inspector calls in try/catch — denials are silently swallowed by
// the script-side handler).
//
// charter: proposition 4 (closed Result<unknown, InspectorError> + closed
// error union — AI users `switch (err.code)` with no default branch) +
// proposition 5 (the same Result shape that server.ts emits over JSON-RPC).

import * as vm from 'node:vm';
import { InspectorError } from './errors';
import { type MutatingMethodLookup, wrapReadOnly } from './sandbox';

export type ExecuteContext = {
  readonly world: unknown;
  readonly engine: unknown;
  readonly assets: unknown;
  readonly scriptTimeoutMs: number;
  /**
   * Optional Registry whose `lookupMutatingMethods()` contributes domain-
   * supplied mutating method names (e.g. ECS `spawn` / `despawn`) to the
   * sandbox blacklist. Omitted: only the generic 9-name JS-container
   * blacklist is enforced (feat-20260517 D-2).
   */
  readonly registry?: MutatingMethodLookup;
};

export type ExecuteResult = { ok: true; value: unknown } | { ok: false; error: InspectorError };

function asObject(v: unknown): object {
  if (v !== null && typeof v === 'object') {
    return v;
  }
  // Primitive / undefined host roots are rare but supported: wrap in an
  // empty marker object so the Proxy can still attach.
  return {};
}

/**
 * Evaluate a JS expression / statement against the read-only inspector
 * context. The body is run as a script (not a module) so `world.inspect()`
 * works without an explicit `return` keyword.
 *
 * Recoverable failures funnel into the four `InspectorErrorCode` members
 * relevant to script evaluation:
 *   - 'script-syntax-error'    : the body fails to parse;
 *   - 'script-runtime-error'   : any thrown value that is not a timeout
 *                                or a re-thrown InspectorError;
 *   - 'script-timeout'         : the watchdog interrupted a sync loop;
 *   - 'inspector-write-denied' : the alpha-mode Proxy denied a mutation.
 */
export function executeScript(script: string, ctx: ExecuteContext): ExecuteResult {
  const sandbox = {
    world: wrapReadOnly(asObject(ctx.world), ctx.registry),
    engine: wrapReadOnly(asObject(ctx.engine), ctx.registry),
    assets: wrapReadOnly(asObject(ctx.assets), ctx.registry),
  };
  const vmCtx = vm.createContext(sandbox);
  const timeout = ctx.scriptTimeoutMs > 0 ? ctx.scriptTimeoutMs : 5000;

  try {
    const value = vm.runInContext(script, vmCtx, {
      timeout,
      displayErrors: true,
    }) as unknown;
    return { ok: true, value };
  } catch (e) {
    // 1. The alpha-mode Proxy throws InspectorError directly; surface verbatim.
    if (e instanceof InspectorError) {
      return { ok: false, error: e };
    }
    // 2. Syntax error: node:vm surfaces a SyntaxError-shaped object whose
    //    `instanceof SyntaxError` (and even `instanceof Error`) is FALSE
    //    because the context has its own Error / SyntaxError constructors
    //    (separate global object per vm.Context). Match by `.name ===
    //    'SyntaxError'` on a plain object check — the well-known cross-
    //    realm idiom. This is also how Node's own REPL distinguishes
    //    syntax from runtime errors.
    if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'SyntaxError') {
      const synMessage = (e as { message?: unknown }).message;
      const synMsgString = typeof synMessage === 'string' ? synMessage : String(synMessage);
      return {
        ok: false,
        error: new InspectorError({
          code: 'script-syntax-error',
          expected: 'script body is valid JavaScript',
          hint: `check syntax position in errMessage; fix and resubmit; use forgeax inspect sugar for closed-form queries (errMessage: ${synMsgString})`,
        }),
      };
    }
    // 3. Timeout: Node throws (in the host realm) a plain Error whose
    //    message starts with 'Script execution timed out'. We still read
    //    .message defensively in case future Node releases swap to a
    //    cross-realm form like the SyntaxError case above.
    const rawMessage =
      typeof e === 'object' &&
      e !== null &&
      typeof (e as { message?: unknown }).message === 'string'
        ? (e as { message: string }).message
        : String(e);
    if (rawMessage.includes('Script execution timed out')) {
      return {
        ok: false,
        error: new InspectorError({
          code: 'script-timeout',
          expected: `script completes within ${timeout}ms (default 5000ms; configurable via engine.startConsole({ port, scriptTimeoutMs }))`,
          hint: 'simplify query or split into smaller scripts; check for unbounded loops; raise timeout via engine.startConsole({ port, scriptTimeoutMs })',
        }),
      };
    }
    // 4. Anything else: runtime error.
    return {
      ok: false,
      error: new InspectorError({
        code: 'script-runtime-error',
        expected: 'script executes without throwing',
        hint: `inspect stack trace; verify symbol availability via forgeax introspect; remember world / engine / assets are read-only Proxy (errMessage: ${rawMessage})`,
      }),
    };
  }
}
