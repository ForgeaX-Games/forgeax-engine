// ErrorBanner.tsx — renders tape load errors with structured code/hint display.
//
// On parse-error state, shows a red banner with error.code and error.hint.
// Sets data-forgeax-load-status anchor via selectors.ts (AC-13).
// Discriminates TapeSourceError (pre-deserialization, has .kind) vs
// DebugError (post-deserialization, has .code) via structural narrowing.
//
// D-10: error code/hint exposed through structured property access (charter P3),
// AI reads .code/.hint not message parsing.
//
// Related: AC-10; plan-strategy D-10; charter P3.

import { loadStatusAnchor } from '../selectors';

export interface ErrorBannerProps {
  readonly error:
    | { kind: string; message: string }
    | { code: string; hint: string; message: string; expected: string };
}

/** Narrow to DebugError shape (has .code). */
function isDebugError(
  error: ErrorBannerProps['error'],
): error is { code: string; hint: string; message: string; expected: string } {
  return 'code' in error;
}

/** Narrow to TapeSourceError shape (has .kind). */
function isTapeSourceError(
  error: ErrorBannerProps['error'],
): error is { kind: string; message: string } {
  return 'kind' in error && !('code' in error);
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  let code: string;
  let hint: string;

  if (isDebugError(error)) {
    code = error.code;
    hint = error.hint;
  } else if (isTapeSourceError(error)) {
    code = error.kind;
    hint = error.message;
  } else {
    code = 'unknown';
    hint = 'An unknown error occurred';
  }

  return (
    <div
      {...{ [loadStatusAnchor()]: 'parse-error' }}
      className="bg-danger/10 border border-danger/30 rounded-lg p-4 space-y-1"
    >
      <p className="text-sm font-semibold text-danger">
        Error: <code className="bg-danger/15 px-1 rounded">{code}</code>
      </p>
      <p className="text-xs text-danger/90">{hint}</p>
    </div>
  );
}
