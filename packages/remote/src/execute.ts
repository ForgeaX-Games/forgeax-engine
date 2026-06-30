// @forgeax/engine-remote/src/execute — async host-realm eval.
//
// D-1 route B (2026-06-29): vm.runInContext does not honor
// importModuleDynamically for Script execution. Host realm eval
// via new Function resolves await import naturally, as long as
// the import function from the calling module scope is injected.
//
// Pipeline:
//   1. Capture import from the module scope as _import.
//   2. Construct new Function('world','renderer','assets','debugAdapter','_import',
//      'return eval(' + JSON.stringify(script) + ')').
//   3. Script authors that need await import() use _import():
//        (async () => { const ecs = await _import('@forgeax/engine-ecs'); ... })()
//   4. try/catch maps errors:
//        SyntaxError (from Function constructor) -> 'script-syntax-error'
//        RemoteError (re-thrown)             -> verbatim
//        anything else                          -> 'script-runtime-error'
//
// The sandbox is dismantled — eval is full-access, no wrapReadOnly.
// Timeout is removed (route B has no interrupt mechanism; see R6).

import { RemoteError } from './errors';

export type ExecuteContext = {
  readonly world: unknown;
  readonly renderer: unknown;
  readonly assets: unknown;
  readonly debugAdapter?: unknown;
};

export type ExecuteResult = { ok: true; value: unknown } | { ok: false; error: RemoteError };

// Capture import at module load time. This is the host realm's dynamic
// import() — when injected into new Function, it resolves module
// specifiers relative to the module that called executeScript.
const _import = (specifier: string): Promise<unknown> => import(specifier);

/**
 * Evaluate a JavaScript expression / statement against the host engine
 * context.
 *
 * Route B (D-1): host realm eval via new Function with injected _import.
 *   - The script body is passed directly as the function body, plus
 *     `return eval(...)` wrapping to preserve last-expression semantics.
 *   - _import is available as a parameter for dynamic ESM imports.
 *   - debugAdapter is available as a 4th eval-scope root for rhi-debug
 *     CLI commands (captureFrame / inspectAt; plan-strategy D-4).
 *   - No sandbox — full access reads and writes.
 *   - No timeout — host realm eval cannot be interrupted (see R6).
 */
export async function executeScript(script: string, ctx: ExecuteContext): Promise<ExecuteResult> {
  // Build the function body: `return eval(<script>)` so statements work
  // and the last expression value is returned. JSON.stringify the script
  // to embed it as a safe string literal.
  const scriptLiteral = JSON.stringify(script);
  const body = `return eval(${scriptLiteral})`;

  try {
    const fn = new Function('world', 'renderer', 'assets', 'debugAdapter', '_import', body);
    const raw: unknown = fn(ctx.world, ctx.renderer, ctx.assets, ctx.debugAdapter, _import);

    // If the script returned a Promise (async IIFE pattern), await it.
    const value: unknown =
      raw != null && typeof (raw as { then?: unknown }).then === 'function' ? await raw : raw;

    return { ok: true, value };
  } catch (e) {
    // 1. RemoteError re-thrown from within eval surfaces verbatim.
    if (e instanceof RemoteError) {
      return { ok: false, error: e };
    }

    // 2. SyntaxError: Function constructor throws on parse failure.
    //    Also catches syntax errors from eval itself.
    if (e instanceof SyntaxError) {
      const msg = e.message;
      return {
        ok: false,
        error: new RemoteError({
          code: 'script-syntax-error',
          expected: 'script body is valid JavaScript',
          hint: `check syntax near: ${msg}; fix and resubmit`,
        }),
      };
    }

    // 3. Runtime error (throws during function execution).
    const rawMessage = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: new RemoteError({
        code: 'script-runtime-error',
        expected: 'script executes without throwing',
        hint: `inspect error; verify symbol availability; eval has full access to world/renderer/assets (errMessage: ${rawMessage})`,
      }),
    };
  }
}
