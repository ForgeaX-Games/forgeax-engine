/** Closed errors emitted by the runtime construction seam. */
export type AssemblyErrorCode = 'backend-load-failed' | 'construction-failed' | 'cleanup-failed';

export interface AssemblyErrorDetail {
  readonly code: AssemblyErrorCode;
  readonly phase: 'backend' | 'construction' | 'cleanup';
  readonly cause?: unknown;
}

export class AssemblyError extends Error {
  readonly code: AssemblyErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AssemblyErrorDetail;

  constructor(
    code: AssemblyErrorCode,
    expected: string,
    hint: string,
    detail: Omit<AssemblyErrorDetail, 'code'>,
  ) {
    super(`runtime assembly ${code}`);
    this.name = 'AssemblyError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = { ...detail, code };
  }
}

export function isAssemblyError(value: unknown): value is AssemblyError {
  return value instanceof AssemblyError;
}
