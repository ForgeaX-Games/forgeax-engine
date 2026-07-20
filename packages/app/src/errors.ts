// @forgeax/engine-app -- AppError + closed AppErrorCode union (6 members) +
// APP_ERROR_HINTS / APP_EXPECTED + discriminated AppErrorDetail per code.
//
// Shape:
//   - AppErrorCode = closed union 6 members (charter P4 closed-union
//     exhaustive switch needs no default fallback; tsc strict mode guards
//     completeness; AGENTS.md "Errors are structured" + AC-07).
//     Members:
//       - 'app-not-started'
//       - 'app-already-running'
//       - 'app-canvas-detached'
//       - 'app-paused-while-stop'
//       - 'app-system-update-failed'
//       - 'app-pointer-lock-failed'
//     Plan-strategy D-3 lock: device-lost stays on RhiErrorCode (18-member
//     union); the AppError surface does NOT add a seventh 'app-device-lost'
//     member. Host onError listener receives RhiError({code:'device-lost'})
//     verbatim through the fan-out.
//
//   - AppError class = 4-field surface (.code / .expected / .hint /
//     .detail) byte-for-byte parallel to RhiError (packages/rhi/src/errors.ts).
//     The class extends Error so debug surfaces (stack, name) work in host
//     environments; AI users walk .code / .detail by property access (charter
//     P3 explicit failure: never parse the message string).
//
//   - AppError is exposed as a discriminated union (variant per code) so AI
//     users get .detail narrowing for free after `if (err.code === '...')`:
//
//       if (err.code === 'app-canvas-detached') {
//         console.warn('reattach canvas', err.detail.canvasId);
//       }
//
//     Constructor accepts a generic args object and infers the variant from
//     the literal `code` argument; `detail` must satisfy the per-code
//     payload (`AppErrorDetailFor<C>`). Callers therefore cannot supply
//     non-canonical fields like `{ state: 'running' }` on the
//     'app-already-running' arm.
//
//   - APP_ERROR_HINTS / APP_EXPECTED are 6-key Records keyed by AppErrorCode;
//     bidirectional 6/6 assertion in __tests__/errors-pointer-lock-failed.test.ts
//     asserts that every code has a non-empty entry on each table (forward) and
//     that every key is one of the 6 members (reverse). Adding / dropping a
//     member without updating both tables fails the unit test (AC-07).
//
// Related: requirements AC-07 / AC-04 / AC-09; plan-strategy section 2 D-3
// (6-member lock) + D-4 ('app-system-update-failed' detail = { cause,
// systemName? }) + D-6 (dual-layer instanceof + switch consumption form);
// research section 2.7 (AppErrorCode lands in AGENTS.md Error model table
// alongside RhiErrorCode et al.); charter P3 (explicit failure) + P4
// (closed-union exhaustive switch).

import type { PluginError } from '@forgeax/engine-plugin';
import type { RhiError } from '@forgeax/engine-rhi/errors';

/**
 * Closed AppErrorCode union (6 members).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'app-not-started'` | `stop()` / `pause()` / `resume()` invoked while the rAF loop is in the terminal `'idle'` or `'stopped'` state (post-device-lost terminal sink). The handle has no live frame to interrupt; AI users either call `start()` first or accept that this handle is dead and rebuild via `createApp({...})`. |
 * | `'app-already-running'` | second `start()` invocation against an already-running handle; the call is a no-op state-machine-wise (state preserved). |
 * | `'app-canvas-detached'` | `createApp(canvas)` thin wrapper found `canvas.isConnected === false` at entry. Detail carries optional `canvasId` so the host can surface the offending canvas in a multi-canvas page (D-2 minor). |
 * | `'app-paused-while-stop'` | `stop()` invoked while the rAF loop is `'paused'`. AI users must `resume()` then `stop()` (matches the React component-unmount-then-stop pattern). |
 * | `'app-system-update-failed'` | `world.update(...)` or `world.removeSystem(...)` (input-attach cleanup path) threw or returned `Result.err`; the original failure value is forwarded on `detail.cause` so AI users can two-level narrow (`detail.cause instanceof EcsError` etc.). `detail.systemName` is optional and present when the call site can name the offending system (e.g. input-attach reports `FRAME_START_SCAN_SYSTEM_NAME`). |
 * | `'app-pointer-lock-failed'` | `attachInputAuto`'s `onLockError` callback received a lock failure from the input backend. `detail.path` carries `'w3c'` (W3C `requestPointerLock` rejection) or `'provider'` (host-injected `lockProvider.requestLock` throw/reject). `detail.cause` carries the original rejection value verbatim. The host recovers by remaining in unlocked state; the next trusted click will retry the lock request. |
 *
 * Plan-strategy D-4 locked the count at 6; device-lost rides RhiErrorCode.
 */
export type AppErrorCode =
  | 'app-not-started'
  | 'app-already-running'
  | 'app-canvas-detached'
  | 'app-paused-while-stop'
  | 'app-system-update-failed'
  | 'app-pointer-lock-failed';

/**
 * Detail variant for the `'app-canvas-detached'` arm.
 *
 * `canvasId` carries an optional identifier the host can surface to AI
 * users when multiple canvases live on the page (e.g. preview vs live
 * canvas). `undefined` when the host did not assign an id.
 */
export interface AppDetailCanvasDetached {
  readonly canvasId?: string | undefined;
}

/**
 * Detail variant for the `'app-system-update-failed'` arm (plan-strategy D-4).
 *
 * `cause` carries the original thrown value verbatim so AI users can
 * `cause instanceof EcsError` / `cause instanceof RhiError` narrow without
 * losing structure. `systemName` is populated when the call site can name
 * the offending system (input-attach cleanup path forwards
 * `FRAME_START_SCAN_SYSTEM_NAME`).
 */
export interface AppDetailSystemUpdateFailed {
  readonly cause: unknown;
  readonly systemName?: string | undefined;
}

/**
 * Detail variant for the `'app-pointer-lock-failed'` arm (plan-strategy D-4).
 *
 * `path` discriminates between W3C `requestPointerLock` rejections (`'w3c'`)
 * and host-injected `lockProvider.requestLock` throw/reject (`'provider'`).
 * `cause` carries the original rejection value verbatim so AI users can
 * narrow further (e.g. `cause instanceof DOMException` for W3C timeout
 * rejections).
 */
export interface AppDetailPointerLockFailed {
  readonly path: 'w3c' | 'provider';
  readonly cause: unknown;
}

/**
 * Empty-detail shape for the 3 codes that carry no payload
 * (`'app-not-started'`, `'app-already-running'`, `'app-paused-while-stop'`).
 *
 * Modelled as `Readonly<Record<string, never>>` so literal builders use
 * `{}` while still narrowing under tsc strict (no extra property allowed).
 */
export type AppDetailEmpty = Readonly<Record<string, never>>;

/**
 * Conditional resolver from `AppErrorCode` to its detail payload type.
 *
 * Used by the constructor signature so `new AppError({ code: 'X', ... })`
 * narrows the `detail` parameter to the variant payload at compile time.
 */
export type AppErrorDetailFor<C extends AppErrorCode> = C extends 'app-canvas-detached'
  ? AppDetailCanvasDetached
  : C extends 'app-system-update-failed'
    ? AppDetailSystemUpdateFailed
    : C extends 'app-pointer-lock-failed'
      ? AppDetailPointerLockFailed
      : AppDetailEmpty;

/**
 * Tagged union of `.detail` payloads carried by structured AppError.
 *
 * Each variant maps to its `AppErrorCode` arm via `AppErrorDetailFor<C>`;
 * the variants are unique by structural fields (`AppDetailCanvasDetached`
 * has `canvasId`, `AppDetailSystemUpdateFailed` has `cause`, the empty
 * shape has neither).
 */
export type AppErrorDetail =
  | AppDetailEmpty
  | AppDetailCanvasDetached
  | AppDetailSystemUpdateFailed
  | AppDetailPointerLockFailed;

/**
 * Render a one-line summary of `detail.cause` for embedding in
 * `AppError.message`. `cause` is structurally typed (`unknown`) because
 * upstream may throw any value; callers downstream still get the verbatim
 * value via `err.detail.cause` — this helper exists so tools that only see
 * `err.message` (`console.error(err)`, raw stringification) still surface
 * the root cause without consumers manually expanding `detail`.
 *
 * Closed precedence:
 *   1. Structured engine errors (RhiError / EcsError / RenderGraphError /
 *      AssetError / ShaderError / ...) carry `.code` + `.message`; render
 *      `<Name> <code>: <message>`.
 *   2. Plain `Error`: render `<name>: <message>`.
 *   3. Anything else: `String(cause)` (covers thrown strings, numbers, null).
 *
 * Newlines are replaced with `' / '` so the final AppError message stays a
 * single line (callers already split on `\n` in stack traces, so a multiline
 * message would corrupt their parsing).
 */
function summarizeCause(cause: unknown): string {
  if (cause === null || cause === undefined) return String(cause);
  if (typeof cause !== 'object') return String(cause);
  const r = cause as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof r.name === 'string' && r.name.length > 0 ? r.name : 'Error';
  const code = typeof r.code === 'string' && r.code.length > 0 ? r.code : '';
  const message = typeof r.message === 'string' ? r.message : '';
  const head = code !== '' ? `${name} ${code}` : name;
  const body = message !== '' ? `: ${message}` : '';
  return `${head}${body}`.replace(/\s*\n+\s*/g, ' / ');
}

class AppErrorClass extends Error {
  readonly code: AppErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AppErrorDetail;

  constructor(args: {
    code: AppErrorCode;
    expected: string;
    hint: string;
    detail: AppErrorDetail;
  }) {
    // Surface `detail.cause` directly inside `.message` for the
    // `'app-system-update-failed'` arm. Without this, a generic
    // `console.error(err)` shows only the wrapper expected/hint and
    // hides the actual EcsError / RhiError / host-system Error that
    // tripped the frame loop. The verbatim `cause` value remains on
    // `err.detail.cause` for two-level-narrow consumers (charter P3).
    let causeSuffix = '';
    if (args.code === 'app-system-update-failed') {
      const d = args.detail as AppDetailSystemUpdateFailed;
      const sys =
        typeof d.systemName === 'string' && d.systemName.length > 0
          ? ` (system=${d.systemName})`
          : '';
      causeSuffix = `; cause: ${summarizeCause(d.cause)}${sys}`;
    } else if (args.code === 'app-pointer-lock-failed') {
      const d = args.detail as AppDetailPointerLockFailed;
      causeSuffix = `; path: ${d.path}; cause: ${summarizeCause(d.cause)}`;
    }
    super(`[AppError ${args.code}] expected: ${args.expected}; hint: ${args.hint}${causeSuffix}`);
    this.name = 'AppError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Variant intersection: an `AppErrorClass` instance whose `code` literal
 * narrows to `C` and whose `detail` narrows to `AppErrorDetailFor<C>`. The
 * shape lets `if (err.code === 'X')` simultaneously narrow `err.detail` to
 * the per-code payload (charter P3 + AC-07 discriminated union).
 */
type AppErrorVariant<C extends AppErrorCode> = AppErrorClass & {
  readonly code: C;
  readonly detail: AppErrorDetailFor<C>;
};

/**
 * Public AppError type — discriminated union of the 6 variants.
 *
 * AI-user form (charter P3 explicit failure):
 *
 * ```ts
 * function recover(err: AppError): string {
 *   switch (err.code) {
 *     case 'app-not-started':         return 'call start() first';
 *     case 'app-already-running':     return 'state preserved; ignore';
 *     case 'app-canvas-detached':     return `reattach ${err.detail.canvasId ?? 'canvas'}`;
 *     case 'app-paused-while-stop':   return 'resume() then stop()';
 *     case 'app-system-update-failed':
 *       return err.detail.cause instanceof Error ? err.detail.cause.message : 'unknown';
 *     case 'app-pointer-lock-failed':
 *       return `lock failed (${err.detail.path}): ${err.detail.cause}`;
 *   }
 * }
 * ```
 */
export type AppError =
  | AppErrorVariant<'app-not-started'>
  | AppErrorVariant<'app-already-running'>
  | AppErrorVariant<'app-canvas-detached'>
  | AppErrorVariant<'app-paused-while-stop'>
  | AppErrorVariant<'app-system-update-failed'>
  | AppErrorVariant<'app-pointer-lock-failed'>;

interface AppErrorConstructor {
  new <C extends AppErrorCode>(args: {
    code: C;
    expected: string;
    hint: string;
    detail: AppErrorDetailFor<C>;
  }): AppErrorVariant<C>;
  readonly prototype: AppErrorClass;
}

/**
 * AppError constructor — `new AppError({ code, expected, hint, detail })`.
 *
 * The generic `C` is inferred from the literal `code` argument, which
 * narrows `detail` to the per-code payload (`AppErrorDetailFor<C>`) and
 * narrows the return type to the corresponding `AppErrorVariant<C>` so the
 * call site walks the discriminated union without manual cast.
 *
 * The constructor delegates to the `AppErrorClass` runtime; the typed-cast
 * here is the ergonomic affordance for AI users (TS class declarations
 * cannot directly express `<C> ... AppErrorVariant<C>` polymorphism).
 */
export const AppError: AppErrorConstructor = AppErrorClass as unknown as AppErrorConstructor;

/**
 * `expected` table — the engine-side invariant that was violated when each
 * code surfaces. AI users read this as the L2 detail (charter F2 priority
 * text); `.hint` carries the recovery action.
 *
 * 6 keys; bidirectional assertion in `__tests__/errors-pointer-lock-failed.test.ts`
 * locks the count and non-emptiness of every entry.
 */
export const APP_EXPECTED: Readonly<Record<AppErrorCode, string>> = {
  'app-not-started':
    'state must be "running" or "paused" to accept stop/pause/resume; "idle" / "stopped" terminal sinks reject',
  'app-already-running':
    'state must be "idle" or "paused" to start; "running" handles ignore subsequent start() calls',
  'app-canvas-detached': 'canvas.isConnected === true at createApp(canvas) entry',
  'app-paused-while-stop':
    'state must be "running" to stop; paused handles must resume() before stop()',
  'app-system-update-failed':
    'world.update(world) and renderer.draw(world) complete synchronously each frame; world.removeSystem(name) returns Result.ok during cleanup',
  'app-pointer-lock-failed':
    'pointer-lock request (W3C requestPointerLock or host lockProvider.requestLock) to succeed; failure signals the browser rejected the lock or the host provider threw',
};

/**
 * `hint` table — actionable recovery guidance per code (charter P3 +
 * proposition 3: machine-readable hint > prose; AGENTS.md "Errors are
 * structured").
 *
 * 6 keys; bidirectional assertion in `__tests__/errors-pointer-lock-failed.test.ts`
 * locks the count and non-emptiness of every entry.
 */
export const APP_ERROR_HINTS: Readonly<Record<AppErrorCode, string>> = {
  'app-not-started':
    'check getState() before calling stop/pause/resume; rebuild the handle via createApp({...}) when the previous one terminated on device-lost',
  'app-already-running':
    'call stop() first or audit start() call sites; the second start() is a no-op so state is preserved',
  'app-canvas-detached':
    'append the canvas to the document tree before calling createApp(canvas), or use the assemble entry createApp({ renderer, world }) when the host already manages canvas lifetime',
  'app-paused-while-stop':
    'call resume() then stop(), or treat stop-while-paused as a host bug and audit the lifecycle',
  'app-system-update-failed':
    'inspect detail.cause for the original thrown value (EcsError / RhiError / host system bug); detail.systemName names the offending system when the call site can supply it',
  'app-pointer-lock-failed':
    'remain in unlocked state; the next trusted click will automatically retry the lock request. inspect detail.path ("w3c" or "provider") and detail.cause to determine the root cause',
};

/**
 * Type guard for narrowing `CanvasAppError`-compatible mixed signals to AppError.
 *
 * The fan-out signature is `(err: CanvasAppError) => void`; AI users
 * who want to handle only the AppError leg call `if (isAppError(err)) ...`
 * before walking `.code`. Reverse-compatible with `instanceof AppError`
 * (the class is exposed); the function form is provided as the
 * canonical idiom in JSDoc / README so AI users do not need to reason
 * about cross-realm `instanceof` quirks.
 *
 * Accepts PluginError in the parameter union (feat-20260623-plugin-system-unify
 * M2 / D-7) so callers who pass the full CanvasAppError don't get TS2379.
 * The instanceof AppErrorClass gate still returns false for PluginErrors
 * (PluginErrorClass is a separate class hierarchy from AppErrorClass).
 */
export function isAppError(err: AppError | RhiError | PluginError): err is AppError {
  return err instanceof AppErrorClass;
}
